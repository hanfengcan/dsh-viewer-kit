/**
 * Fetch the host's resolved configuration before the first scan.
 *
 * ## Why this is asynchronous, and why that is not a problem
 *
 * The config lives in the host process and the rendering lives in the browser,
 * so getting it across means one HTTP round trip. The obvious worry is that
 * blocks would render at the wrong size and then jump once the answer arrived.
 * They do not, because nothing is scanned until this resolves: the seam is not
 * even constructed until then, so there is no already-negotiated surface to
 * re-negotiate.
 *
 * ## Why the URL is document-relative
 *
 * `new URL(path, document.baseURI).pathname`, not `path` directly. dshmarket
 * shipped root-absolute fetches first and had to fix them: a request for
 * `/dsh-market/status` issued from a page served under a path prefix goes to
 * the domain root instead of the mount point, and every call 404s. DSH's own
 * client module system does the same thing for the same reason —
 * `comboReference()` in `dsh-client-modules/lib/index.js` strips the leading
 * slash at the boundary between the two halves.
 *
 * @module client/host-config
 */

import { resolveConfig } from '../schema.js'

/** The path the host half registers. Mirrors `CONFIG_ROUTE` in `src/index.js`. */
export const CONFIG_PATH = '/dsh-viewer-kit/config'

/**
 * How long to wait before giving up and rendering with defaults.
 *
 * Deliberately short. A missing host half answers 404 in milliseconds, so the
 * timeout only ever governs a request that is *hanging* — a wedged web server
 * or a proxy that accepts the connection and never replies. Blocking the first
 * render for a long time to save a fetch would be the worse trade: the user
 * would be looking at unenhanced code blocks, which is exactly what this
 * plugin exists to prevent.
 */
export const CONFIG_TIMEOUT_MS = 1200

/**
 * Resolve the config route against the page, not the domain root.
 *
 * @param {string} [path]
 * @returns {string}
 */
export function configUrl(path = CONFIG_PATH) {
  const relative = path.replace(/^\/+/, '')
  if (typeof document === 'undefined' || document.baseURI === undefined) return `/${relative}`
  return new URL(relative, document.baseURI).pathname
}

/**
 * Read the host's config, always resolving.
 *
 * Never rejects. A failure here means "render with the shipped defaults", which
 * is the behaviour of every build before the host half existed, so the caller
 * does not need a rejection path at all.
 *
 * @param {{ fetch?: typeof globalThis.fetch, timeoutMs?: number, url?: string, now?: () => number, setTimeout?: typeof setTimeout, clearTimeout?: typeof clearTimeout }} [options]
 *   Injection points, so the tests drive this without a network or a clock.
 * @returns {Promise<{ config: Record<string, any>, source: 'host' | 'defaults', reason?: string }>}
 */
export async function loadHostConfig(options = {}) {
  const doFetch = options.fetch ?? globalThis.fetch
  const url = options.url ?? configUrl()
  if (typeof doFetch !== 'function') {
    return { config: resolveConfig(undefined), source: 'defaults', reason: 'no fetch in this runtime' }
  }

  const controller = typeof AbortController === 'function' ? new AbortController() : null
  const schedule = options.setTimeout ?? setTimeout
  const cancel = options.clearTimeout ?? clearTimeout
  /** @type {any} */
  let timer = null
  const timeout = new Promise((done) => {
    timer = schedule(() => {
      controller?.abort()
      done({ timedOut: true })
    }, options.timeoutMs ?? CONFIG_TIMEOUT_MS)
  })

  try {
    const answer = await Promise.race([
      doFetch(url, controller === null ? {} : { signal: controller.signal, cache: 'no-store' }).then(
        (response) => ({ timedOut: false, response }),
        (error) => ({ timedOut: false, error }),
      ),
      timeout,
    ])

    if (/** @type {any} */ (answer).timedOut === true) {
      return { config: resolveConfig(undefined), source: 'defaults', reason: `no answer within ${options.timeoutMs ?? CONFIG_TIMEOUT_MS}ms` }
    }

    const settled = /** @type {any} */ (answer)
    if (settled.error !== undefined) {
      // A 404 is the ordinary case when the host half is not installed — the
      // bundle can be loaded on its own. It is not worth an error, so the
      // reason is returned rather than logged here.
      return { config: resolveConfig(undefined), source: 'defaults', reason: `request failed: ${String(settled.error)}` }
    }
    if (settled.response?.ok !== true) {
      return { config: resolveConfig(undefined), source: 'defaults', reason: `host answered ${settled.response?.status ?? 'nothing'}` }
    }

    const body = await settled.response.json()
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      return { config: resolveConfig(undefined), source: 'defaults', reason: 'host sent something that is not a config object' }
    }
    // Lenient on purpose. The host already validated these values strictly, so
    // a rejection here means this build and that host disagree — and the
    // defaults are a working answer to that, where throwing would be a failed
    // web boot.
    return { config: resolveConfig(body), source: 'host' }
  } catch (error) {
    return { config: resolveConfig(undefined), source: 'defaults', reason: `unexpected: ${String(error)}` }
  } finally {
    if (timer !== null) cancel(timer)
  }
}
