// SPDX-License-Identifier: AGPL-3.0-only
// Metro for the app in the pnpm workspace. The workspace packages are TypeScript sources that
// import their siblings with the ".js" extension Node's ESM wants (packages/usage); Metro does
// not map ".js" to ".ts" by itself, so a relative ".js" import that has a ".ts" file is resolved
// to it.
// Metro loads this file as CommonJS.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
const upstream = config.resolver.resolveRequest;

config.resolver.resolveRequest = (context, moduleName, platform) => {
  const resolve = upstream ?? context.resolveRequest;
  if (moduleName.startsWith('.') && moduleName.endsWith('.js')) {
    try {
      return resolve(context, `${moduleName.slice(0, -3)}.ts`, platform);
    } catch {
      // Not a TypeScript source: resolve the ".js" file as written.
    }
  }
  return resolve(context, moduleName, platform);
};

module.exports = config;
