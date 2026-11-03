// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable @typescript-eslint/no-require-imports -- an Expo config plugin is CommonJS */
// Version of the app: versionName comes from package.json, versionCode is derived from it.
//
// versionCode = (major * 10000 + minor * 100 + patch) * 10000 + build
//
// `build` is the number of commits in the repository at the commit being built (the build script
// passes it as OPENLIVE_BUILD_NUMBER; a git checkout falls back to `git rev-list --count HEAD`).
// Bumping the version always raises the code; two builds of the same version are ordered by build.
// 0.1.4 build 150 is 1040150; the Play limit (2100000000) allows up to 21.0.0.
const { execFileSync } = require('node:child_process');

const MAX_VERSION_CODE = 2_100_000_000;

function parseVersion(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!m) throw new Error(`version "${version}" is not major.minor.patch`);
  const [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (minor > 99 || patch > 99)
    throw new Error(`version "${version}": minor and patch must be < 100`);
  return major * 10000 + minor * 100 + patch;
}

function versionCode(version, build) {
  if (!Number.isInteger(build) || build < 0 || build > 9999) {
    throw new Error(`build number "${build}" must be an integer from 0 to 9999`);
  }
  const code = parseVersion(version) * 10000 + build;
  if (code > MAX_VERSION_CODE) throw new Error(`versionCode ${code} is above ${MAX_VERSION_CODE}`);
  return code;
}

function buildNumber(env = process.env, cwd = __dirname) {
  if (env.OPENLIVE_BUILD_NUMBER !== undefined && env.OPENLIVE_BUILD_NUMBER !== '') {
    return Number(env.OPENLIVE_BUILD_NUMBER);
  }
  try {
    const out = execFileSync('git', ['rev-list', '--count', 'HEAD'], {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return Number(String(out).trim());
  } catch {
    return 0; // no git and no OPENLIVE_BUILD_NUMBER: a development build
  }
}

module.exports = { parseVersion, versionCode, buildNumber };
