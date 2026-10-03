/**
 * tsdown configuration — the standard DSH client-bundle build.
 *
 * DSH's client module system does not consume ESM. It serves each plugin's
 * `exports["./client"]` as a classic script whose top level is
 *
 *     window.__ModuleLoader__.load({ id: "<package name>", factory: (require) => { … } })
 *
 * where `require` resolves against the shell's frozen module table, so any
 * non-baseline import has to be an *external* that stays a `require` call in
 * the output rather than being inlined.
 *
 * Verified against two independent real bundles:
 *   - `@deepseek-ai/dsh-experimental-client-ui-voice-input` (shipped)
 *   - `dshmarket` v1.66.8 (community)
 *
 * This bundle has no externals at all: it is framework-free, uses no React and
 * no DSH package, so `require` is never called and the factory body is just
 * the CommonJS module.
 *
 * @module tsdown.config
 */

import { defineConfig } from 'tsdown'

const PACKAGE_ID = 'dsh-viewer-kit'

export default defineConfig({
  entry: { client: 'src/client/index.js' },
  outDir: 'client',
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  // Keep it readable: this file is served to a browser that a user may be
  // stepping through when diagnosing a render problem.
  minify: false,
  sourcemap: false,
  dts: false,
  // Never delete the output directory. pnpm *copies* a directory dependency
  // into the profile's node_modules, so a `clean` here only risks a window
  // where `client/client.js` does not exist at all.
  clean: false,
  // Nothing to externalise: no React, no DSH packages, zero runtime
  // dependencies, so the emitted factory never calls `require`.
  treeshake: true,
  outputOptions: {
    // DSH's convention is `client/client.js` regardless of the CJS format —
    // both shipped and community bundles ship that exact path. tsdown would
    // otherwise name a `cjs` output `client.cjs`.
    entryFileNames: '[name].js',
    // The module-system wrapper is the contract. The factory must build its
    // own `module` / `exports` pair, because rolldown's CommonJS interop
    // preamble (the `Symbol.toStringTag` line below) assumes both already
    // exist. This is why the real bundles open with these two declarations.
    banner: [
      `window.__ModuleLoader__.load({ id: ${JSON.stringify(PACKAGE_ID)}, factory: (require) => {`,
      '  var module = { exports: {} };',
      '  var exports = module.exports;',
    ].join('\n'),
    footer: ['  return module.exports;', '}', '});'].join('\n'),
  },
})
