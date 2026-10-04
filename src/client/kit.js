/**
 * The Kit: registry, negotiation, view state and stats.
 *
 * This is the only surface a renderer, the seam, or a future host surface
 * talks to. It holds no DOM reference at all, which is what lets the
 * interesting logic — priority resolution, disabled renderers, size limits,
 * degradation — be tested under plain Node with no browser shim.
 *
 * @module kit
 */

import { CODE_VIEW, createRequest } from './contract.js'
import { DEFAULT_CONFIG, resolveConfig } from '../schema.js'
import { createViewState } from './view-state.js'

/**
 * The shipped defaults and the lenient resolver, owned by `src/schema.js`.
 *
 * They live there rather than here because the host half validates the same
 * field table strictly and publishes the same defaults over the config route.
 * A second copy is how this file ended up with a duplicated
 * `DEFAULT_CHART_HEIGHT` whose `||` fallback `resolveConfig` had already made
 * unreachable. Re-exported so existing importers keep working.
 */
export { DEFAULT_CONFIG, resolveConfig }

/**
 * @param {{
 *   config?: Partial<import('./contract.js').ViewerKitConfig> | null,
 *   viewState?: ReturnType<typeof createViewState>,
 *   onError?: (error: unknown, context: { rendererId: string, requestId: string }) => void,
 * }} [options]
 */
export function createKit(options = {}) {
  const onError =
    options.onError ??
    ((error) => {
      // eslint-disable-next-line no-console
      console.error('[dsh-viewer-kit]', error)
    })

  let config = resolveConfig(options.config)
  const viewState = options.viewState ?? createViewState()
  /** @type {Map<string, import('./contract.js').Renderer>} */
  const registry = new Map()
  /** @type {Set<() => void>} */
  const listeners = new Set()
  /** @type {Map<string, string | null>} */
  const negotiationCache = new Map()
  /** @type {{ surfaces: number, claimed: number, byRenderer: Record<string, number> }} */
  const stats = { surfaces: 0, claimed: 0, byRenderer: {} }

  function sorted() {
    return [...registry.values()].sort(
      (left, right) => (right.priority ?? 0) - (left.priority ?? 0) || (left.id < right.id ? -1 : 1),
    )
  }

  function invalidate() {
    negotiationCache.clear()
    for (const listener of listeners) listener()
  }

  /**
   * Content larger than the cap is not handed to a renderer at all. Declared
   * as a closure rather than a method so `instantiate` works even when a
   * caller destructures it off the Kit.
   *
   * @param {import('./contract.js').RenderRequest} request
   * @returns {boolean}
   */
  function withinLimits(request) {
    return request.source.length <= config.maxSourceBytes
  }

  return {
    /**
     * @param {import('./contract.js').Renderer} renderer
     * @returns {() => void} disposer
     */
    register(renderer) {
      if (renderer == null || typeof renderer.id !== 'string' || renderer.id === '') {
        throw new TypeError('[dsh-viewer-kit] a renderer needs a non-empty string id')
      }
      if (typeof renderer.match !== 'function' || typeof renderer.create !== 'function') {
        throw new TypeError(`[dsh-viewer-kit] renderer "${renderer.id}" needs match() and create()`)
      }
      if (registry.has(renderer.id)) {
        // Silently replacing would make load order decide behaviour.
        throw new Error(`[dsh-viewer-kit] renderer "${renderer.id}" is already registered`)
      }
      registry.set(renderer.id, renderer)
      invalidate()
      return () => {
        if (registry.delete(renderer.id)) invalidate()
      }
    },

    renderers: () => Object.freeze([...sorted()]),

    /**
     * Pick the renderer that claims this request.
     *
     * The winner is the highest `priority`, then the lowest `id`. Sorting by
     * id rather than by registration order keeps the outcome independent of
     * the order DSH happens to load plugins in.
     *
     * @param {import('./contract.js').RenderRequest} request
     * @returns {import('./contract.js').Renderer | null}
     */
    negotiate(request) {
      if (!config.enabled) return null
      // Fence-name tier: a whole-request veto, so it runs before the cache and
      // before any renderer's `match`. Correctness across a settings change
      // comes from `setConfig` calling `invalidate()`, not from this position —
      // which is here because refusing the block outright is the cheaper and
      // clearer reading of the two tiers.
      if (config.disabledRendererIds.includes(request.lang)) return null
      const cached = negotiationCache.get(request.id)
      if (cached !== undefined) return cached === null ? null : (registry.get(cached) ?? null)
      let winner = null
      for (const renderer of sorted()) {
        // Renderer-id tier: this renderer stops matching, and the block is
        // re-offered to the rest. Falling off the end of the loop is the
        // intended outcome, not a gap — the seam then leaves the native code
        // view in place.
        if (config.disabledRendererIds.includes(renderer.id)) continue
        let claimed = false
        try {
          claimed = renderer.match(request) === true
        } catch (error) {
          // A broken predicate must not take the whole seam down with it.
          onError(error, { rendererId: renderer.id, requestId: request.id })
          continue
        }
        if (claimed) {
          winner = renderer
          break
        }
      }
      negotiationCache.set(request.id, winner?.id ?? null)
      return winner
    },

    /**
     * The view list a surface should offer: the renderer's own views plus the
     * host's built-in `code` view, which always comes last.
     *
     * @param {import('./contract.js').RendererInstance} instance
     * @returns {import('./contract.js').ViewDescriptor[]}
     */
    viewsOf(instance) {
      const own = Array.isArray(instance.views) ? instance.views : []
      const filtered = own.filter(
        (view) => view != null && typeof view.id === 'string' && view.id !== CODE_VIEW.id,
      )
      return [...filtered, { ...CODE_VIEW, label: filtered.length > 0 ? 'code' : 'source' }]
    },

    getView: (id) => viewState.get(id),
    setView: (id, viewId) => viewState.set(id, viewId),

    /** The view a never-before-seen item should open in. */
    defaultView() {
      return config.defaultToPreview ? 'preview' : CODE_VIEW.id
    },

    /**
     * Reject content too large to preview, before any renderer sees it.
     *
     * @param {import('./contract.js').RenderRequest} request
     * @returns {boolean}
     */
    withinLimits,

    buildRequest: (input) => createRequest(input),

    /**
     * The `RenderHost` a renderer receives.
     *
     * `surface` binds the host to one concrete mounting point; without it
     * (a headless test) the host is inert and any renderer that tries to
     * mount will fail loudly rather than silently no-op.
     *
     * @param {import('./contract.js').RenderRequest} request
     * @param {(error: unknown) => void} fail
     * @param {{ document: Document, mount: (node: Node) => void, clearView: () => void }} [surface]
     * @returns {import('./contract.js').RenderHost}
     */
    hostFor(request, fail, surface) {
      if (surface === undefined) {
        throw new Error('[dsh-viewer-kit] createKit() needs a host binding to mount renderers')
      }
      return {
        request,
        document: surface.document,
        mount: surface.mount,
        clearView: surface.clearView,
        limits: { maxSourceBytes: config.maxSourceBytes, maxPreviewHeight: config.maxPreviewHeight },
        fail,
        config: () => config,
      }
    },

    /**
     * Build an instance, converting any failure into `null` so the caller can
     * fall back to the untouched native code block.
     *
     * @param {import('./contract.js').Renderer} renderer
     * @param {import('./contract.js').RenderRequest} request
     * @param {import('./contract.js').RenderHost} host
     * @returns {import('./contract.js').RendererInstance | null}
     */
    instantiate(renderer, request, host) {
      if (!withinLimits(request)) return null
      try {
        return renderer.create(host)
      } catch (error) {
        onError(error, { rendererId: renderer.id, requestId: request.id })
        return null
      }
    },

    /**
     * Record one examined block. `rendererId` is absent when nothing claimed
     * it, which is the common and completely healthy case.
     *
     * @param {string} [rendererId]
     */
    noteSurface(rendererId) {
      stats.surfaces += 1
      if (rendererId === undefined) return
      stats.claimed += 1
      stats.byRenderer[rendererId] = (stats.byRenderer[rendererId] ?? 0) + 1
    },

    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    config: () => Object.freeze({ ...config, disabledRendererIds: Object.freeze([...config.disabledRendererIds]) }),

    /**
     * Replace the configuration and drop cached negotiation results, so a
     * settings change takes effect without a reload.
     *
     * @param {Partial<import('./contract.js').ViewerKitConfig> | null | undefined} patch
     */
    setConfig(patch) {
      config = resolveConfig(patch)
      invalidate()
    },

    stats: () => ({
      surfaces: stats.surfaces,
      claimed: stats.claimed,
      byRenderer: { ...stats.byRenderer },
    }),

    /** Test seam: drop all renderers and cached state. */
    _reset() {
      registry.clear()
      negotiationCache.clear()
      stats.surfaces = 0
      stats.claimed = 0
      stats.byRenderer = {}
    },
  }
}
