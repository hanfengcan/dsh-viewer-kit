/**
 * Reaching a package-local client chunk.
 *
 * The factory's `require` is the only door to the module table, and it is not
 * in scope for modules this file imports — the build banner aliases it to
 * `__dvkRequire` (see `tsdown.config.ts`), which is what this module reads.
 *
 * ## Why not `import()`
 *
 * Under `format: 'cjs'` a dynamic `import()` compiles to a bare
 * `require("./client.echarts.js")`. That goes to the module table's *sync*
 * `require`, which only knows seed words, already-materialized modules and
 * registered package factories — a package-local chunk is none of those, so it
 * throws "missed the module table". `require.async` is the documented path and
 * is what the loader actually implements (`importChunk`).
 *
 * The spec is a plain string and deliberately NOT derived from the built file
 * name at author time: the emitted name must satisfy the host's
 * `/^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$/` pattern, and the chunk's own id
 * is derived from that name. Keeping the name in one constant here, and in
 * `chunkFileNames` in the build config, is the whole binding. `tests/run.mjs`
 * asserts the two agree against the real emitted file, because a mismatch
 * fails at *chart render time* rather than at build time.
 *
 * @module chunk-loader
 */

/** Must equal the chunk's `chunkFileNames` entry in `tsdown.config.ts`. */
export const ECHARTS_CHUNK = './client.echarts.js'

/**
 * The transport, replaced wholesale by tests. Defaults to the real one, and
 * the test seam exists for the same reason `kit._reset()` does: a stub that
 * does not fail cannot prove anything, but neither can a real 1.5 MB canvas
 * engine in a Node test.
 *
 * @type {(spec: string) => Promise<any>}
 */
let transport = async (spec) => {
  if (typeof __dvkRequire === 'undefined' || typeof __dvkRequire.async !== 'function') {
    throw new Error(`dsh-viewer-kit: this build cannot load client chunks (require.async unavailable) for ${spec}`)
  }
  return await __dvkRequire.async(spec)
}

/**
 * Fetch one on-demand chunk. Memoised by the module table itself, so a second
 * chart re-uses the first fetch.
 *
 * @param {string} spec
 * @returns {Promise<any>}
 */
export function loadChunk(spec) {
  return transport(spec)
}

/** Test seam: replace the chunk transport. */
export function __setChunkTransport(next) {
  transport = next
}
