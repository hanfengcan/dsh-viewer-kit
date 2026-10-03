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
 * ── On-demand chunks ────────────────────────────────────────────────────────
 *
 * The chart renderer needs ECharts, which is ~1.5 MB even when trimmed to
 * `echarts/core` plus registered pieces. Inlining that would make every user
 * pay for charts they never write, so it ships as a separate file. DSH serves
 * it, and the contract it must satisfy is narrow — all four points below were
 * read out of `@deepseek-ai/dsh-client-modules` and the host route, and
 * verified by `scripts/probe-chunk.mjs`:
 *
 *   1. FILE NAME. The host only serves a sibling of `client.js` whose name
 *      matches `/^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$/`
 *      (`chunkRequest` in the host, and the same pattern client-side). Hence
 *      `chunkFileNames: 'client.[name].js'`.
 *
 *   2. NO HASH. The chunk's own id is `<package>/<fileName>`, and the chunk has
 *      to register that id itself — a content hash in the filename would make
 *      the id self-referential. It is also unnecessary: the request URL carries
 *      `?rev=<hash of client.js's mtime/ctime/size>`, so a rebuild always
 *      produces a new URL and therefore a cache miss.
 *
 *   3. THE ENTRY MUST NOT USE `import()`. Under `format: 'cjs'` a dynamic
 *      `import()` compiles to a plain `require('./client.echarts.js')`, which
 *      throws "missed the module table". The chunk is requested with
 *      `require.async('./client.echarts.js')` instead — see `chunk-loader.js`.
 *
 *   4. PER-CHUNK BANNER. Each emitted file has to open with its own
 *      `__ModuleLoader__.load({ id, … })`, and the ids differ. `banner`
 *      therefore has to be a function, so it can key off the chunk name.
 *
 * @module tsdown.config
 */

import { defineConfig } from 'tsdown'

/**
 * The entry's module id, which is the package name.
 *
 * Deliberately a literal rather than a `readFileSync('package.json')`: the
 * project's `tsconfig.json` sets `types: []` so that the browser sources are
 * checked without ambient Node types, which means a `node:fs` import here is a
 * type error. A duplicate literal is a smaller risk than a build config that
 * does not type-check — and `tests/run.mjs` asserts the built bundle's
 * registration id is `dsh-viewer-kit`, so renaming the package without
 * updating this fails the suite instead of shipping a bundle nobody can load.
 */
const PACKAGE_ID = 'dsh-viewer-kit'

/**
 * The engine chunk's *file name*, and therefore the last segment of its module
 * id. `chunk-loader.js` requests it by the same literal.
 */
const ECHARTS_CHUNK_NAME = 'client.echarts'

/** Wraps one emitted file as a client-module registration. */
function moduleSystemWrapper(id: string): string[] {
  return [
    `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {`,
    // Aliased so inlined modules can reach the module table's async side. A
    // bare `require` cannot fetch a chunk; only `require.async` can.
    '  var __dvkRequire = require;',
    '  var module = { exports: {} };',
    '  var exports = module.exports;',
  ]
}

export default defineConfig({
  // The engine is declared as its own ENTRY rather than as a code-split chunk.
  // It has to be, because the request is `require.async('./client.echarts.js')`
  // — a string with no import expression behind it — and a bundler cannot split
  // a file it cannot see referenced. Declaring it as an entry emits the file
  // deterministically under the name the host route requires, with the same
  // wrapper shape as the main bundle and no dependency on splitting heuristics.
  entry: { client: 'src/client/index.js', 'client.echarts': 'src/client/chunks/echarts.js' },
  outDir: 'client',
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  // Keep it readable: this file is served to a browser that a user may be
  // stepping through when diagnosing a render problem. The chart chunk is left
  // unminified too, so a chart bug can be debugged the same way.
  minify: false,
  sourcemap: false,
  dts: false,
  // Never delete the output directory. pnpm *copies* a directory dependency
  // into the profile's node_modules, so a `clean` here only risks a window
  // where `client/client.js` does not exist at all.
  clean: false,
  // Nothing to externalise: no React, no DSH packages, zero runtime
  // dependencies, so the emitted factory never calls `require` except for the
  // chunk request, which goes through `require.async`.
  treeshake: true,
  // ECharts and zrender are published as libraries that must also run under
  // Node, so they branch on `process.env.NODE_ENV` — 236 real references in the
  // emitted chunk. A browser has no `process`, so evaluating the chunk throws
  // `process is not defined` and every chart fails. Replacing it at build time
  // is the standard fix and is also *correct* rather than merely defensive:
  // the shipped bundle has no dev-only ECharts path worth keeping.
  //
  // The value is JSON-quoted because `define` substitutes raw text — a bare
  // `production` would be a syntax error — and the substitution also lets the
  // bundler fold all 236 comparisons away.
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
  outputOptions: {
    // DSH's convention is `client/client.js` regardless of the CJS format —
    // both shipped and community bundles ship that exact path. tsdown would
    // otherwise name a `cjs` output `client.cjs`.
    entryFileNames: '[name].js',
    // Safety net: if rolldown ever splits anything shared, the host only
    // accepts siblings matching this pattern, so a default name would produce
    // a file the route refuses to serve.
    chunkFileNames: 'client.[name].js',
    // Point 4: per-file, because the entry id and a chunk id differ.
    banner: (chunk) => {
      const name = String(chunk?.name ?? '')
      return moduleSystemWrapper(
        name === ECHARTS_CHUNK_NAME ? `${PACKAGE_ID}/${ECHARTS_CHUNK_NAME}.js` : PACKAGE_ID,
      ).join('\n')
    },
    footer: ['  return module.exports;', '}', '});'].join('\n'),
  },
})
