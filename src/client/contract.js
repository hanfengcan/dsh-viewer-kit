/**
 * Shared vocabulary for the whole kit.
 *
 * Nothing in this file touches the DOM: the seam, the Kit and every renderer
 * agree on the shapes declared here, which is what lets the core be unit
 * tested under plain Node and lets a renderer be written without importing
 * anything from the seam.
 *
 * @module contract
 */

/**
 * Where a piece of renderable content was found. `code-block` is the only
 * source in v0; the other two exist so a future tool-call or document source
 * can reuse the identical pipeline instead of growing a parallel one.
 *
 * @typedef {'code-block' | 'tool-call' | 'document'} SurfaceKind
 */

/**
 * One normalized unit of renderable content.
 *
 * @typedef {object} RenderRequest
 * @property {string} id Stable identity for view-state. Content-derived, so
 *   the same code keeps its view selection across React re-renders and
 *   scroll-back, while genuinely different content starts fresh.
 * @property {SurfaceKind} surface Which host surface produced it.
 * @property {string} lang Normalized language id, `''` when the fence has none.
 * @property {string} source Raw, unmodified text.
 * @property {{ info?: string }} [meta] Extra fence information, if any.
 */

/**
 * Host services handed to a renderer instance. Deliberately narrow: a renderer
 * can build DOM, mount it, and report failures, but it cannot reach into the
 * seam or address the host page.
 *
 * @typedef {object} RenderHost
 * @property {RenderRequest} request
 * @property {Document} document Document to create nodes in.
 * @property {(node: Node) => void} mount Append a node to the surface's own
 *   view root. The root is empty on every `enter` that needs a fresh view, so
 *   a renderer never has to think about tearing down its own container.
 * @property {() => void} clearView Empty the surface's view root.
 * @property {{ maxSourceBytes: number, maxPreviewHeight: number }} limits
 * @property {(error: unknown) => void} fail Report a fatal render error; the
 *   host degrades to the native code block.
 * @property {() => Readonly<ViewerKitConfig>} config
 */

/**
 * One selectable view of a rendered item, e.g. preview vs code.
 *
 * @typedef {object} ViewDescriptor
 * @property {string} id
 * @property {string} label
 */

/**
 * A live renderer attached to one surface.
 *
 * @typedef {object} RendererInstance
 * @property {ViewDescriptor[]} views At least one. The host always appends its
 *   own built-in `code` view, so a renderer only has to implement its
 *   enhanced view.
 * @property {(viewId: string) => void | Promise<void>} enter
 * @property {() => void} dispose
 */

/**
 * The contract every renderer implements. Adding a renderer means adding a
 * file that satisfies this and one `kit.register` call — nothing else.
 *
 * @typedef {object} Renderer
 * @property {string} id Unique; also the deterministic tie-break key.
 * @property {string} [label] Human name for diagnostics.
 * @property {number} [priority] Higher wins. Default 0.
 * @property {(request: RenderRequest) => boolean} match Claim test. Must be
 *   cheap and side-effect free — the host may call it repeatedly.
 * @property {(host: RenderHost) => RendererInstance | null} create Build an
 *   instance, or return null to decline (too large, unsupported shape, …).
 */

/**
 * @typedef {object} ViewerKitConfig
 *
 * Every field is settable from the plugin's loader row — either the shipped
 * `cordis.patch.yml` or the user's own profile patch, which overrides by `id`:
 *
 * ```yaml
 * - id: dsh-viewer-kit
 *   config:
 *     htmlAllowScripts: true
 * ```
 *
 * The client half exports no `Config` schema on purpose (see `client/index.js`),
 * so values arrive unvalidated and `resolveConfig` drops unknown keys and
 * type-checks the rest against the defaults.
 *
 * @property {boolean} enabled Master switch.
 * @property {readonly string[]} [disabledRendererIds] Renderers the user turned
 *   off. Read-only because every consumer only ever asks `includes`.
 * @property {number} [maxSourceBytes] Sources above this size keep the native
 *   code block instead of being handed to a renderer.
 * @property {number} [maxPreviewHeight] Pixel cap for an embedded preview.
 * @property {boolean} [htmlAllowScripts] Let previewed HTML run scripts inside
 *   an opaque-origin sandbox. **Off by default**; see docs/01-architecture.md §8.
 * @property {boolean} [defaultToPreview] Open a freshly seen item in its
 *   enhanced view instead of the code view. **On by default.**
 */

/** The view every surface always offers, rendered by the host itself. */
export const CODE_VIEW = Object.freeze({ id: 'code', label: 'code' })

/** Fence languages that mean the same thing. Keys are already normalized. */
export const LANG_ALIASES = Object.freeze({
  htm: 'html',
  xhtml: 'html',
  chart: 'echarts',
  tsv: 'csv',
})

/**
 * Normalize a fence language to the same form the host renderer computes.
 *
 * DSH reads the language as `/^[\w-]+/` off the front of the fence info string
 * (`dsh-client-ui-primitives/lib/index.js:11355`), so we must agree with it
 * or a fence like `html title="x"` would claim a language of `html title="x"`
 * and match nothing.
 *
 * @param {string | null | undefined} raw
 * @returns {string} lowercased id, `''` when there is none
 */
export function normalizeLang(raw) {
  if (typeof raw !== 'string') return ''
  const head = /^[\w-]+/.exec(raw.trim())
  if (head === null) return ''
  const lower = head[0].toLowerCase()
  return LANG_ALIASES[lower] ?? lower
}

/**
 * Canonical language id for a normalized value, without alias folding.
 * Renderers that only want the literal fence language use this.
 *
 * @param {string | null | undefined} raw
 * @returns {string}
 */
export function rawLang(raw) {
  if (typeof raw !== 'string') return ''
  const head = /^[\w-]+/.exec(raw.trim())
  return head === null ? '' : head[0].toLowerCase()
}

/**
 * 32-bit FNV-1a over a string, with an explicit salt.
 *
 * @param {string} text
 * @param {number} salt
 * @returns {number} unsigned 32-bit
 */
function fnv1a(text, salt) {
  let hash = (0x811c9dc5 ^ salt) >>> 0
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

/**
 * Content fingerprint used as the view-state key.
 *
 * Two independent FNV passes plus the length: a collision would only ever
 * mean two different code blocks share a view *selection*, never that content
 * is rendered wrongly, but two passes make that effectively unreachable.
 *
 * @param {{ scope?: string, lang: string, source: string }} parts
 * @returns {string}
 */
export function fingerprint(parts) {
  const key = `${parts.scope ?? ''}\u0000${parts.lang}\u0000${parts.source}`
  const a = fnv1a(key, 0)
  const b = fnv1a(key, 0x9e3779b9)
  return `${a.toString(36)}.${b.toString(36)}.${key.length.toString(36)}`
}

/**
 * Build a `RenderRequest`. One constructor so the id and the fields can never
 * drift apart.
 *
 * @param {{ surface: SurfaceKind, scope?: string, lang?: string, source: string, info?: string }} input
 * @returns {RenderRequest}
 */
export function createRequest(input) {
  const lang = input.lang ?? ''
  const source = input.source
  /** @type {RenderRequest} */
  const request = {
    id: fingerprint({ scope: input.scope, lang, source }),
    surface: input.surface,
    lang,
    source,
  }
  if (input.info !== undefined && input.info !== '') request.meta = { info: input.info }
  return request
}
