// SPDX-License-Identifier: AGPL-3.0-only
// The plan of `pnpm run helper:publish` (helper-publish.ts): build the Linux helper with the
// packaging scripts in the Flatpak SDK, add the macOS disk image built and notarized on a Mac
// (packaging/macos/build-app.sh, --mac-dmg), hash them, and upload them to the instance's private R2
// bucket, where the Worker serves it to signed-in people (apps/api/src/helper/release.ts holds the
// layout and the manifest checks). Pure: the runner gathers the facts and executes the steps.

import { isAbsolute } from 'node:path';
import { parseArgs } from 'node:util';

export interface PublishArgs {
  env: string;
  /** The version to stamp and publish; the runner falls back to the latest helper-v* tag, then the project version. */
  version: string | undefined;
  dryRun: boolean;
  /** Publish what is already in dist/ instead of building it again. */
  skipBuild: boolean;
  /** Leave the Flatpak out even when flatpak-builder is available. */
  noFlatpak: boolean;
  releaseNotesUrl: string | undefined;
  /**
   * The notarized disk image packaging/macos/build-app.sh made on a Mac (repository-relative or
   * absolute); without it the release has no macOS file.
   */
  macDmg: string | undefined;
  help: boolean;
}

const VERSION_SOURCE_LABEL = {
  flag: '--version',
  tag: 'latest helper-v* tag',
  project: 'project version in package.json',
} as const;

export const PUBLISH_USAGE = `Usage: pnpm run helper:publish -- [--env <name>] [--version <x.y.z>] [--dry-run]
                                [--skip-build] [--no-flatpak] [--mac-dmg <path>] [--notes-url <url>]

Builds the Linux helper (the tarball, and the Flatpak bundle when flatpak-builder is installed)
in the Flatpak SDK, adds the macOS disk image given with --mac-dmg, computes the SHA-256 of each
file and uploads them to the instance's private R2 bucket with wrangler, using the config the
setup generated. helper/latest.json goes last, so the Download page never offers a file that is
not there yet. See packaging/linux/README.md and packaging/macos/README.md.

  --env <name>        the instance (default: production), as set up by \`pnpm run setup\`
  --version <x.y.z>   the version to build and publish (default: the latest helper-v* tag, else the project version)
  --dry-run           print the plan, then stop; builds nothing, uploads nothing
  --skip-build        publish the files already in dist/ for this version
  --no-flatpak        publish the tarball only
  --mac-dmg <path>    also publish this notarized openlive-helper-<version>-macos.dmg, made on a Mac
                      by packaging/macos/build-app.sh (copy it here first; it is not built here)
  --notes-url <url>   a release notes link for the Download page`;

export class PublishArgsError extends Error {}

/** Same pattern as the protocol's HelperVersion and apps/api/src/helper/release.ts. */
export const HELPER_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$/;
const ENV_NAME = /^[a-z][a-z0-9-]{0,31}$/;

export function parsePublishArgs(argv: string[]): PublishArgs {
  const args = argv[0] === '--' ? argv.slice(1) : argv;
  let values;
  try {
    ({ values } = parseArgs({
      args,
      options: {
        env: { type: 'string', default: 'production' },
        version: { type: 'string' },
        'dry-run': { type: 'boolean', default: false },
        'skip-build': { type: 'boolean', default: false },
        'no-flatpak': { type: 'boolean', default: false },
        'notes-url': { type: 'string' },
        'mac-dmg': { type: 'string' },
        help: { type: 'boolean', short: 'h', default: false },
      },
      strict: true,
    }));
  } catch (err) {
    throw new PublishArgsError((err as Error).message);
  }
  const parsed: PublishArgs = {
    env: values.env,
    version: values.version?.trim().replace(/^v/, ''),
    dryRun: values['dry-run'],
    skipBuild: values['skip-build'],
    noFlatpak: values['no-flatpak'],
    releaseNotesUrl: values['notes-url']?.trim(),
    macDmg: values['mac-dmg']?.trim() || undefined,
    help: values.help,
  };
  if (parsed.help) return parsed;
  if (!ENV_NAME.test(parsed.env)) {
    throw new PublishArgsError('--env must be lowercase letters, digits and dashes (up to 32)');
  }
  if (parsed.env === 'dev') throw new PublishArgsError('dev is local only; pick a deployed --env');
  if (parsed.version !== undefined && !validVersion(parsed.version)) {
    throw new PublishArgsError(`--version ${parsed.version} is not a version like 0.2.0`);
  }
  if (parsed.releaseNotesUrl !== undefined && !/^https:\/\/\S+$/.test(parsed.releaseNotesUrl)) {
    throw new PublishArgsError('--notes-url must be an https:// link');
  }
  if (parsed.macDmg !== undefined && !parsed.macDmg.endsWith('-macos.dmg')) {
    throw new PublishArgsError('--mac-dmg must be an openlive-helper-<version>-macos.dmg');
  }
  return parsed;
}

export const validVersion = (v: string): boolean => HELPER_VERSION.test(v) && v.length <= 64;

/** `helper-v0.2.0-3-gabc123` (git describe) → 0.2.0-3-gabc123; null without a tag. */
export function versionFromDescribe(describe: string): string | null {
  const v = describe.trim().replace(/^helper-v/, '');
  return v !== describe.trim() && validVersion(v) ? v : null;
}

/** The protocol version the helper speaks, from helper/internal/api/room.go. */
export function helperProtocol(goSource: string): { major: number; minor: number } | null {
  const m =
    /ProtocolVersion\s*=\s*protocol\.ProtocolVersion\{Major:\s*(\d+),\s*Minor:\s*(\d+)\}/.exec(
      goSource,
    );
  return m ? { major: Number(m[1]), minor: Number(m[2]) } : null;
}

// The layout in the bucket. Keep it in step with apps/api/src/helper/release.ts (the tests of
// this package parse the manifest with the Worker's own checks).
export const HELPER_PREFIX = 'helper/';
export const LATEST_KEY = `${HELPER_PREFIX}latest.json`;
export const tarballName = (v: string) => `openlive-helper-${v}-linux-amd64.tar.gz`;
export const flatpakName = (v: string) => `openlive-helper-${v}.flatpak`;
export const dmgName = (v: string) => `openlive-helper-${v}-macos.dmg`;
export const CHECKSUMS_NAME = 'SHA256SUMS';
export const objectKey = (v: string, name: string) => `${HELPER_PREFIX}${v}/${name}`;

export interface PublishFacts {
  version: string;
  /** Where the version came from, for the plan. */
  versionSource: 'flag' | 'tag' | 'project';
  bucketName: string;
  /** Repository-relative, for the plan. */
  generatedConfig: string;
  instanceUrl: string;
  /** Whether `flatpak` with org.flatpak.Builder (or a flatpak-builder binary) is installed. */
  flatpakBuilder: 'flatpak-app' | 'binary' | null;
  /** The runtime version the Flatpak manifest uses (26.08). */
  runtimeVersion: string;
}

export interface Step {
  title: string;
  /** argv; the runner runs it from the repository root. */
  command: string[];
  /** Extra environment for the command. */
  env?: Record<string, string>;
}

export type FileKind = 'tarball' | 'flatpak' | 'dmg';

export interface PublishFile {
  name: string;
  kind: FileKind;
  /** Repository-relative path (dist/ for what is built here), or the absolute --mac-dmg. */
  path: string;
}

export interface PublishPlan {
  version: string;
  files: PublishFile[];
  build: Step[];
  /** Why the Flatpak is left out, when it is. */
  flatpakSkipped: string | null;
  uploads: { key: string; path: string; contentType: string }[];
}

export const CONTENT_TYPES = {
  tarball: 'application/gzip',
  flatpak: 'application/vnd.flatpak',
  dmg: 'application/x-apple-diskimage',
  checksums: 'text/plain; charset=utf-8',
  manifest: 'application/json',
} as const;

const MANIFEST = 'packaging/linux/dev.hfps.OpenliveHelper.yml';
const APP_ID = 'dev.hfps.OpenliveHelper';
const FLATHUB = 'https://dl.flathub.org/repo/flathub.flatpakrepo';
/** Where the runner writes SHA256SUMS and latest.json before uploading them. */
export const stagingPath = (v: string, name: string) => `build/helper-publish/${v}/${name}`;

export function computePublishPlan(args: PublishArgs, facts: PublishFacts): PublishPlan {
  const v = facts.version;
  const files: PublishFile[] = [
    { name: tarballName(v), kind: 'tarball', path: `dist/${tarballName(v)}` },
  ];
  const build: Step[] = [
    {
      title: 'Build the tarball in the Flatpak SDK',
      command: ['packaging/linux/build-tarball-in-sdk.sh'],
      env: { VERSION: v },
    },
  ];
  let flatpakSkipped: string | null = null;
  if (args.noFlatpak) flatpakSkipped = '--no-flatpak';
  else if (!facts.flatpakBuilder && !args.skipBuild) {
    flatpakSkipped = 'flatpak-builder is not installed (packaging/linux/README.md)';
  }
  if (!flatpakSkipped) {
    files.push({ name: flatpakName(v), kind: 'flatpak', path: `dist/${flatpakName(v)}` });
    const builder =
      facts.flatpakBuilder === 'binary'
        ? ['flatpak-builder']
        : ['flatpak', 'run', 'org.flatpak.Builder'];
    build.push(
      {
        title: 'Stamp the version into the Flatpak build',
        command: ['sh', '-c', 'printf "%s\\n" "$VERSION" > packaging/linux/.version'],
        env: { VERSION: v },
      },
      {
        title: `Build the Flatpak (runtime ${facts.runtimeVersion})`,
        command: [
          ...builder,
          '--user',
          '--force-clean',
          '--state-dir=build/.flatpak-builder',
          '--repo=build/flatpak-repo',
          'build/flatpak',
          MANIFEST,
        ],
      },
      {
        title: 'Bundle the Flatpak',
        command: [
          'flatpak',
          'build-bundle',
          `--runtime-repo=${FLATHUB}`,
          'build/flatpak-repo',
          `dist/${flatpakName(v)}`,
          APP_ID,
        ],
      },
    );
  }
  if (args.macDmg !== undefined) {
    // The name carries the version: a disk image of another build must not slip in.
    const base = args.macDmg.split(/[\\/]/).at(-1);
    if (base !== dmgName(v)) {
      throw new PublishArgsError(`--mac-dmg is ${base}, but this release is ${dmgName(v)}`);
    }
    files.push({ name: dmgName(v), kind: 'dmg', path: args.macDmg });
  }
  const uploads = [
    ...files.map((f) => ({
      key: objectKey(v, f.name),
      path: f.path,
      contentType: CONTENT_TYPES[f.kind],
    })),
    {
      key: objectKey(v, CHECKSUMS_NAME),
      path: stagingPath(v, CHECKSUMS_NAME),
      contentType: CONTENT_TYPES.checksums,
    },
    // Last: until it is replaced, the page keeps offering the previous version, whole.
    { key: LATEST_KEY, path: stagingPath(v, 'latest.json'), contentType: CONTENT_TYPES.manifest },
  ];
  return { version: v, files, build: args.skipBuild ? [] : build, flatpakSkipped, uploads };
}

/**
 * The wrangler call for one upload, run from apps/api (where the pinned wrangler and the
 * generated config are), so the file path goes back to the repository root.
 */
export function uploadCommand(
  bucketName: string,
  env: string,
  upload: { key: string; path: string; contentType: string },
): string[] {
  return [
    'wrangler',
    'r2',
    'object',
    'put',
    `${bucketName}/${upload.key}`,
    '--file',
    isAbsolute(upload.path) ? upload.path : `../../${upload.path}`,
    '--content-type',
    upload.contentType,
    '--remote',
    '--config',
    `wrangler.${env}.generated.jsonc`,
    '--env',
    env,
  ];
}

const shellWord = (w: string) => (/^[\w@%+=:,./-]+$/.test(w) ? w : `'${w.replace(/'/g, `'\\''`)}'`);
export const shellLine = (step: Pick<Step, 'command' | 'env'>): string =>
  [
    ...Object.entries(step.env ?? {}).map(([k, v]) => `${k}=${shellWord(v)}`),
    ...step.command.map(shellWord),
  ].join(' ');

export function formatPublishPlan(
  args: PublishArgs,
  facts: PublishFacts,
  plan: PublishPlan,
): string {
  const lines = [
    `Publish openlive-helper ${plan.version} (${VERSION_SOURCE_LABEL[facts.versionSource]}) ` +
      `to ${facts.instanceUrl}`,
    `Bucket ${facts.bucketName} (private), config ${facts.generatedConfig}, env ${args.env}`,
    '',
    'Build:',
    ...(plan.build.length
      ? plan.build.map((s, i) => `  ${i + 1}. ${s.title}\n     ${shellLine(s)}`)
      : ['  (skipped: --skip-build, using dist/)']),
    ...(plan.flatpakSkipped ? [`  The Flatpak is left out: ${plan.flatpakSkipped}.`] : []),
    '',
    ...macLines(plan),
    '',
    'Then: SHA-256 of each file into SHA256SUMS and latest.json',
    `  (${stagingPath(plan.version, '')})`,
    '',
    'Upload, from apps/api (the pinned wrangler, the account in the generated config):',
    ...plan.uploads.map(
      (u, i) =>
        `  ${i + 1}. ${u.key}\n     ${shellLine({ command: uploadCommand(facts.bucketName, args.env, u) })}`,
    ),
  ];
  return lines.join('\n');
}

function macLines(plan: PublishPlan): string[] {
  const dmg = plan.files.find((f) => f.kind === 'dmg');
  return dmg
    ? [
        `macOS: ${dmg.path}, as built, signed, notarized and stapled on a Mac by`,
        '  packaging/macos/build-app.sh (not built here)',
      ]
    : ['macOS: none (--mac-dmg <path> adds the disk image made by packaging/macos/build-app.sh)'];
}

export interface HashedFile {
  name: string;
  kind: FileKind;
  size: number;
  sha256: string;
}

/** Each kind's platform; apps/api/src/helper/release.ts checks the same pairs. */
const PLATFORMS = {
  tarball: { os: 'linux', arch: 'amd64' },
  flatpak: { os: 'linux', arch: 'amd64' },
  dmg: { os: 'macos', arch: 'universal' },
} as const;

/** The same format as `sha256sum` (two spaces), which `sha256sum -c SHA256SUMS` checks. */
export const sha256sums = (files: HashedFile[]): string =>
  files.map((f) => `${f.sha256}  ${f.name}\n`).join('');

/**
 * helper/latest.json (format 1; apps/api/src/helper/release.ts). `signature` stays null: it is
 * where the signed auto-update will put a signature over this file.
 */
export function buildManifest(input: {
  version: string;
  publishedAt: Date;
  protocol: { major: number; minor: number };
  releaseNotesUrl: string | null;
  files: HashedFile[];
}) {
  return {
    schema: 1,
    version: input.version,
    publishedAt: input.publishedAt.toISOString(),
    protocol: input.protocol,
    releaseNotesUrl: input.releaseNotesUrl,
    files: input.files.map((f) => ({
      name: f.name,
      kind: f.kind,
      ...PLATFORMS[f.kind],
      size: f.size,
      sha256: f.sha256,
    })),
    signature: null,
  };
}
