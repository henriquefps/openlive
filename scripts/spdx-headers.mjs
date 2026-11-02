// SPDX-License-Identifier: AGPL-3.0-only
// Every source file starts with an SPDX license line (CONTRIBUTING.md). CI runs the
// check; the fix adds the line where it is missing, after a shebang if there is one.
//
//   node scripts/spdx-headers.mjs          # check, exit 1 listing the files without it
//   node scripts/spdx-headers.mjs --fix    # add it
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const ID = 'SPDX-License-Identifier: AGPL-3.0-only';

const COMMENT = {
  ts: `// ${ID}`,
  tsx: `// ${ID}`,
  js: `// ${ID}`,
  mjs: `// ${ID}`,
  cjs: `// ${ID}`,
  go: `// ${ID}`,
  swift: `// ${ID}`,
  sh: `# ${ID}`,
  css: `/* ${ID} */`,
};

// Generated, vendored or not ours: no header.
const SKIP = [
  /^experiments\//,
  /^\.claude\//,
  /^docs\/architecture\//,
  /^packages\/protocol\/src\/generated\//,
  /^packages\/protocol\/go\/protocol_gen\.go$/,
  /(^|\/)worker-configuration\.d\.ts$/,
];

const files = execFileSync(
  'git',
  ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
  {
    encoding: 'utf8',
  },
)
  .split('\0')
  .filter((f) => f && COMMENT[f.split('.').pop()] && !SKIP.some((re) => re.test(f)));

const fix = process.argv.includes('--fix');
const missing = [];
for (const file of files) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    continue; // deleted in the working tree
  }
  // The line must be among the first few, so a shebang or a comment block may precede it.
  if (text.split('\n', 5).some((line) => line.includes(ID))) continue;
  missing.push(file);
  if (!fix) continue;
  const ext = file.split('.').pop();
  // In Go a comment right above `package` is the package doc, so a blank line keeps them apart.
  const header = ext === 'go' ? `${COMMENT[ext]}\n` : COMMENT[ext];
  const shebang = text.startsWith('#!') ? text.slice(0, text.indexOf('\n') + 1) : '';
  writeFileSync(file, `${shebang}${header}\n${text.slice(shebang.length)}`);
}

if (missing.length === 0) {
  console.log(`spdx: ${files.length} source files carry "${ID}".`);
} else if (fix) {
  console.log(`spdx: added the header to ${missing.length} files.`);
} else {
  console.error(`spdx: ${missing.length} source files lack "${ID}" in their first lines:`);
  for (const file of missing) console.error(`  ${file}`);
  console.error('Run: pnpm spdx:fix');
  process.exit(1);
}
