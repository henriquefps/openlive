// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable @typescript-eslint/no-require-imports -- an Expo config plugin is CommonJS */
// Expo config plugin: the release build is signed with our own upload key, never the template's
// public debug.keystore.
//
// The keystore path, alias and passwords come from Gradle properties (-P or ~/.gradle/gradle.properties)
// or environment variables, so nothing secret is in the repository:
//   OPENLIVE_UPLOAD_STORE_FILE, OPENLIVE_UPLOAD_KEY_ALIAS,
//   OPENLIVE_UPLOAD_STORE_PASSWORD, OPENLIVE_UPLOAD_KEY_PASSWORD
// When any is missing, a release build fails with a clear message (it never falls back to the
// debug key); debug builds do not need them.
const { withAppBuildGradle } = require('expo/config-plugins');

const MARK = '// openlive-signing';

const SIGNING_CONFIG = `        release {
            ${MARK}
            storeFile openliveSigning('OPENLIVE_UPLOAD_STORE_FILE') ? file(openliveSigning('OPENLIVE_UPLOAD_STORE_FILE')) : null
            keyAlias openliveSigning('OPENLIVE_UPLOAD_KEY_ALIAS')
            storePassword openliveSigning('OPENLIVE_UPLOAD_STORE_PASSWORD')
            keyPassword openliveSigning('OPENLIVE_UPLOAD_KEY_PASSWORD')
        }
`;

const HELPERS = `${MARK}
def openliveSigning(String name) {
    return findProperty(name) ?: System.getenv(name)
}
def openliveSigningMissing = ['OPENLIVE_UPLOAD_STORE_FILE', 'OPENLIVE_UPLOAD_KEY_ALIAS',
    'OPENLIVE_UPLOAD_STORE_PASSWORD', 'OPENLIVE_UPLOAD_KEY_PASSWORD'].findAll { !openliveSigning(it) }
gradle.taskGraph.whenReady { graph ->
    def releaseRequested = graph.allTasks.any { it.project == project && it.name.toLowerCase().contains('release') }
    if (releaseRequested && !openliveSigningMissing.isEmpty()) {
        throw new GradleException("Release signing is not configured: set " + openliveSigningMissing.join(', ') +
            " (Gradle properties or environment). The release APK is never signed with the debug key; see apps/mobile/README.md.")
    }
}
`;

function patch(src) {
  if (src.includes(MARK)) return src;
  let out = src.replace(
    /(\n\s*signingConfigs \{\n(?:[\s\S]*?\n)?)(\s*\}\n\s*buildTypes \{)/,
    (_m, a, b) => {
      return `${a}${SIGNING_CONFIG}${b}`;
    },
  );
  if (out === src)
    throw new Error('with-openlive-signing: no signingConfigs block in app/build.gradle');
  const before = out;
  out = out.replace(
    /(buildTypes \{[\s\S]*?\n\s*release \{\n(?:\s*\/\/.*\n)*\s*)signingConfig signingConfigs\.debug/,
    '$1signingConfig signingConfigs.release',
  );
  if (out === before) throw new Error('with-openlive-signing: release buildType not found');
  out = out.replace(/\nandroid \{\n/, `\n${HELPERS}\nandroid {\n`);
  if (!out.includes('openliveSigningMissing'))
    throw new Error('with-openlive-signing: no android block');
  return out;
}

function withOpenliveSigning(config) {
  return withAppBuildGradle(config, (cfg) => {
    cfg.modResults.contents = patch(cfg.modResults.contents);
    return cfg;
  });
}

module.exports = withOpenliveSigning;
module.exports.patch = patch;
