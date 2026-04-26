// js/vendor/lz-string.js — ESM wrapper around the vendored UMD library.
//
// Load order: index.html (and tests/index.html) include
// js/vendor/lz-string-1.4.4.min.js as a classic <script> tag *before* any
// <script type="module">. That file declares `var LZString = ...` at top
// level, which the UMD detect block (`typeof define`/`module.exports`)
// leaves on the global because neither AMD nor CommonJS is present in the
// browser. This wrapper picks up the global and re-exports it so app
// modules can `import { LZString } from './vendor/lz-string.js'`.
//
// The vendored file is read-only per ADR-013. SHA-256 of the file at
// vendor time:
//   9d1a0ef07a2ea5faa8cd4afb60a0518075e6771e341e5ff4e0e481cefedeecbf

export const LZString = /** @type {any} */ (globalThis.LZString);

if (!LZString || typeof LZString.compressToEncodedURIComponent !== 'function') {
  throw new Error('lz-string not loaded — verify <script src="js/vendor/lz-string-1.4.4.min.js"> precedes the module graph');
}
