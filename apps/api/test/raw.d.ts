// SPDX-License-Identifier: AGPL-3.0-only
// Vite's ?raw imports: the file's text (test/security-headers.test.ts reads apps/web/public/_headers).
declare module '*?raw' {
  const text: string;
  export default text;
}
