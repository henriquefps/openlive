// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable @typescript-eslint/no-require-imports -- the plugin files are CommonJS */
// Dynamic part of the Expo config; the rest is in app.json. The version has one source,
// package.json, and versionCode follows it (plugins/version.js).
const pkg = require('./package.json');
const { versionCode, buildNumber } = require('./plugins/version');

module.exports = ({ config }) => ({
  ...config,
  version: pkg.version,
  android: { ...config.android, versionCode: versionCode(pkg.version, buildNumber()) },
});
