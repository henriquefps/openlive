// SPDX-License-Identifier: AGPL-3.0-only
// `pnpm run helper:publish -- --env production --from-release X.Y.Z [--android-from-release X.Y.Z]
// [--dry-run]`: points the Download page at the official files of the public GitHub releases by
// writing only the manifest to the instance's R2 bucket (helper-from-release.ts). Without them
// (`[--version X] [--mac-dmg P]`) it builds the Linux helper and uploads it, with the macOS disk
// image made on a Mac, to the same private bucket for the Worker to serve (helper-release.ts has the
// plan; packaging/RELEASING.md, packaging/linux/README.md, packaging/macos/README.md,
// docs/self-host.md).

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { parseInstance } from './instance.ts';
import { originOf } from './domain.ts';
import {
  buildManifest,
  CHECKSUMS_NAME,
  computePublishPlan,
  formatPublishPlan,
  type HashedFile,
  helperProtocol,
  parsePublishArgs,
  PUBLISH_USAGE,
  PublishArgsError,
  type PublishFacts,
  sha256sums,
  shellLine,
  stagingPath,
  uploadCommand,
  versionFromDescribe,
} from './helper-release.ts';
import { type InstanceFacts, publishFromRelease, ReleaseError } from './helper-from-release.ts';

class Stop extends Error {}

const repoRoot = resolve(import.meta.dirname, '../../..');
const apiDir = join(repoRoot, 'apps', 'api');
const win = process.platform === 'win32';
const wranglerBin = join(apiDir, 'node_modules', '.bin', win ? 'wrangler.cmd' : 'wrangler');

function run(command: string[], opts: { cwd?: string; env?: Record<string, string> } = {}): void {
  const [cmd, ...args] = command;
  if (!cmd) return;
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd ?? repoRoot,
    env: { ...process.env, ...opts.env },
    stdio: 'inherit',
    shell: win,
  });
  if (r.error) throw new Stop(`${cmd}: ${r.error.message}`);
  if (r.status !== 0)
    throw new Stop(`${shellLine({ command, ...opts })} failed (exit ${r.status})`);
}

function succeeds(cmd: string, args: string[]): boolean {
  const r = spawnSync(cmd, args, { stdio: 'ignore', shell: win });
  return !r.error && r.status === 0;
}

function sha256File(path: string): Promise<string> {
  return new Promise((done, fail) => {
    const hash = createHash('sha256');
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', fail)
      .on('end', () => done(hash.digest('hex')));
  });
}

function instanceFacts(env: string): InstanceFacts {
  const instancePath = join(apiDir, `.instance.${env}.json`);
  const generated = `apps/api/wrangler.${env}.generated.jsonc`;
  if (!existsSync(instancePath) || !existsSync(join(repoRoot, generated))) {
    throw new Stop(`no instance "${env}" here: run \`pnpm run setup -- --env ${env}\` first`);
  }
  const inst = parseInstance(readFileSync(instancePath, 'utf8'), `apps/api/.instance.${env}.json`);
  return {
    bucketName: inst.r2.bucketName,
    // Run from apps/api, where the pinned wrangler is.
    generatedConfig: generated,
    instanceUrl: originOf(inst.route, inst.workerName),
  };
}

function gatherFacts(env: string, version: string | undefined): PublishFacts {
  const instance = instanceFacts(env);

  let versionSource: PublishFacts['versionSource'] = 'flag';
  if (version === undefined) {
    const r = spawnSync('git', ['describe', '--tags', '--match', 'helper-v*'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    const fromTag = r.status === 0 ? versionFromDescribe(r.stdout) : null;
    if (fromTag) {
      version = fromTag;
      versionSource = 'tag';
    } else {
      // No helper-v* tag: the helper ships with the project version (package.json).
      const root = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
        version?: string;
      };
      if (!root.version)
        throw new Stop('no helper-v* tag and no package.json version: pass --version');
      version = root.version;
      versionSource = 'project';
    }
  }

  const manifest = readFileSync(
    join(repoRoot, 'packaging/linux/dev.hfps.OpenliveHelper.yml'),
    'utf8',
  );
  const runtimeVersion = /^runtime-version: '(.*)'$/m.exec(manifest)?.[1] ?? '?';
  const flatpakBuilder = succeeds('flatpak', ['info', '--user', 'org.flatpak.Builder'])
    ? 'flatpak-app'
    : succeeds('flatpak-builder', ['--version'])
      ? 'binary'
      : null;
  return {
    version,
    versionSource,
    ...instance,
    flatpakBuilder,
    runtimeVersion,
  };
}

async function main(): Promise<void> {
  const args = parsePublishArgs(process.argv.slice(2));
  if (args.help) {
    console.log(PUBLISH_USAGE);
    return;
  }
  if (args.macDmg !== undefined) {
    // pnpm runs this from the repository root; the path was typed where pnpm was started.
    const abs = resolve(process.env.INIT_CWD ?? process.cwd(), args.macDmg);
    const rel = relative(repoRoot, abs);
    args.macDmg = rel.startsWith('..') || isAbsolute(rel) ? abs : rel;
  }
  if (args.fromRelease !== undefined || args.androidFromRelease !== undefined) {
    await publishFromRelease(args, instanceFacts(args.env), {
      fetch: globalThis.fetch,
      upload: ([, ...wranglerArgs]) => run([wranglerBin, ...wranglerArgs], { cwd: apiDir }),
      log: (line) => console.log(line),
      root: repoRoot,
    });
    return;
  }
  const facts = gatherFacts(args.env, args.version);
  const plan = computePublishPlan(args, facts);
  console.log(formatPublishPlan(args, facts, plan));
  if (args.dryRun) {
    const dmg = plan.files.find((f) => f.kind === 'dmg');
    if (dmg && !existsSync(resolve(repoRoot, dmg.path))) {
      console.log(`\nNote: ${dmg.path} is not there yet.`);
    }
    console.log('\nDry run: nothing was built or uploaded.');
    return;
  }

  const protocol = helperProtocol(
    readFileSync(join(repoRoot, 'helper/internal/api/room.go'), 'utf8'),
  );
  if (!protocol) throw new Stop('could not read the helper protocol version from room.go');

  for (const step of plan.build) {
    console.log(`\n→ ${step.title}`);
    run(step.command, step.env ? { env: step.env } : {});
  }

  const hashed: HashedFile[] = [];
  for (const f of plan.files) {
    const path = resolve(repoRoot, f.path);
    if (!existsSync(path)) {
      const hint =
        f.kind === 'flatpak'
          ? 'build it or pass --no-flatpak'
          : f.kind === 'dmg'
            ? 'build it on a Mac with packaging/macos/build-app.sh and copy it here'
            : 'build it';
      throw new Stop(`${f.path} is missing: ${hint}`);
    }
    hashed.push({
      name: f.name,
      kind: f.kind,
      size: statSync(path).size,
      sha256: await sha256File(path),
    });
  }
  const write = (name: string, text: string) => {
    const path = join(repoRoot, stagingPath(plan.version, name));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  };
  write(CHECKSUMS_NAME, sha256sums(hashed));
  const manifest = buildManifest({
    version: plan.version,
    publishedAt: new Date(),
    protocol,
    releaseNotesUrl: args.releaseNotesUrl ?? null,
    files: hashed,
  });
  write('latest.json', `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`\n${sha256sums(hashed)}`);

  for (const upload of plan.uploads) {
    console.log(`→ ${upload.key}`);
    const [, ...wranglerArgs] = uploadCommand(facts.bucketName, args.env, upload);
    run([wranglerBin, ...wranglerArgs], { cwd: apiDir });
  }
  console.log(
    `\nPublished openlive-helper ${plan.version}: ${facts.instanceUrl}/download shows it to members.`,
  );
}

main().catch((err: unknown) => {
  if (err instanceof Stop || err instanceof PublishArgsError || err instanceof ReleaseError) {
    console.error(err.message);
    if (err instanceof PublishArgsError) console.error(`\n${PUBLISH_USAGE}`);
  } else console.error(err);
  process.exitCode = 1;
});
