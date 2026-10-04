/**
 * Host surface for one code block.
 *
 * A surface owns exactly two things inside a block DSH rendered: a view
 * switch appended to the banner, and a root element appended to the content
 * viewport. It never mutates anything DSH created.
 *
 * The five invariants it promises (docs/01-architecture.md §6.4):
 *   1. only ever append nodes marked with `data-dvk-*`; never remove or
 *      reorder a node DSH created;
 *   2. show/hide by toggling *our* attribute on the content node, never by
 *      removing the native `<pre>`;
 *   3. the switch goes into the banner's trailing action group, whose child
 *      list React reconciles positionally and never extends past its own;
 *   4. the native source subtree is never touched, so switching back to code
 *      is byte-for-byte lossless;
 *   5. `dispose()` leaves the block exactly as it was found.
 *
 * @module code-block-surface
 */

import { BANNER_SELECTOR, CONTENT_SELECTOR, MODE_ATTRIBUTE, ROOT_ATTRIBUTE, SWITCH_ATTRIBUTE } from './dom-contract.js'
import { normalizeLang } from './contract.js'

/**
 * @param {{
 *   root: Element,
 *   source: string,
 *   lang: string,
 *   info: string,
 *   scope: string,
 *   kit: any,
 *   document: Document,
 *   t: (key: string, fallback: string) => string,
 *   onOutcome?: (rendererId: string | undefined) => void,
 * }} options
 * @returns {{ dispose: () => void, rendererId: string, enter: (viewId: string) => void } | null}
 */
export function createCodeBlockSurface(options) {
  const { root, source, info, scope, kit, document: doc, t } = options
  const report = options.onOutcome ?? (() => {})

  const content = root.querySelector(CONTENT_SELECTOR)
  const banner = root.querySelector(BANNER_SELECTOR)
  if (content === null || banner === null) {
    // Not a shape we recognise: leave it alone and do not count it.
    return null
  }

  const request = kit.buildRequest({
    surface: 'code-block',
    scope,
    lang: normalizeLang(options.lang),
    source,
    info,
  })

  const renderer = kit.negotiate(request)
  if (renderer === null) {
    report(undefined)
    return null
  }
  if (!kit.withinLimits(request)) {
    report(renderer.id)
    return null
  }

  // The view root the renderer mounts into. It is ours, so emptying it is
  // always safe and never disturbs anything DSH created.
  const viewRoot = doc.createElement('div')
  viewRoot.setAttribute(ROOT_ATTRIBUTE, 'true')
  viewRoot.className = 'dvk-view'

  const host = kit.hostFor(request, (error) => {
    console.error('[dsh-viewer-kit]', renderer.id, error)
  }, {
    document: doc,
    mount: (node) => {
      viewRoot.appendChild(node)
    },
    clearView: () => {
      viewRoot.replaceChildren()
    },
  })

  /** @type {import('./contract.js').RendererInstance | null} */
  let instance = null
  try {
    instance = kit.instantiate(renderer, request, host)
  } catch {
    instance = null
  }
  if (instance === null) {
    report(renderer.id)
    return null
  }

  const views = kit.viewsOf(instance)
  if (views.length < 2) {
    // Only the built-in code view survived; a switch would be a no-op.
    try {
      instance.dispose()
    } catch {
      /* ignore */
    }
    report(renderer.id)
    return null
  }

  // --- our nodes ------------------------------------------------------------
  //
  // Clear anything we left in this block first. Injecting must be idempotent:
  // a second activation (an HMR re-enable, or a node React recreated while
  // keeping our child) would otherwise stack a second switch next to the
  // first, and the user sees a row of identical buttons.
  for (const stale of root.querySelectorAll(`[${SWITCH_ATTRIBUTE}]`)) stale.remove()
  for (const stale of content.querySelectorAll(`[${ROOT_ATTRIBUTE}]`)) stale.remove()

  const switchHost = banner.lastElementChild
  if (switchHost === null) {
    try {
      instance.dispose()
    } catch {
      /* ignore */
    }
    report(renderer.id)
    return null
  }
  const switcher = doc.createElement('div')
  switcher.setAttribute(SWITCH_ATTRIBUTE, 'true')
  switcher.className = 'dvk-switch'
  switcher.setAttribute('role', 'group')
  switcher.setAttribute('aria-label', t('switch.label', 'View'))

  /** @type {HTMLButtonElement[]} */
  const buttons = []
  for (const view of views) {
    const button = /** @type {HTMLButtonElement} */ (doc.createElement('button'))
    button.type = 'button'
    button.className = 'dvk-switch__item'
    button.setAttribute('data-dvk-view', view.id)
    button.setAttribute('aria-pressed', 'false')
    button.textContent = view.id === 'code' ? t('view.code', 'Code') : labelFor(view, t)
    button.addEventListener('click', () => enter(view.id))
    switcher.appendChild(button)
    buttons.push(button)
  }
  switchHost.appendChild(switcher)
  content.appendChild(viewRoot)

  // --- the expand button ----------------------------------------------------
  //
  // A sibling of the switcher with its OWN class, not a third child borrowing
  // `.dvk-switch__item`. That class is designed to sit inside the switch's
  // container and reads as "one of the views"; reusing it made the action look
  // like a selected view rather than a button.
  //
  // It appears and disappears with `enter`, because whether enlarging makes
  // sense depends on what is on screen: lifting a table's height cap is
  // meaningless while its source is showing, and offering a button that does
  // nothing is worse than not offering one.
  /** @type {HTMLElement | null} */
  let expandControl = null
  /** @type {(() => void) | null} */
  let unsubscribeExpand = null

  const syncExpandControl = (activeViewId) => {
    // The built-in code view mounts nothing, so there is nothing to enlarge.
    const expandable = activeViewId === 'code' ? undefined : instance?.expand
    if (expandable === undefined || typeof expandable.toggle !== 'function') {
      expandControl?.remove()
      expandControl = null
      return
    }
    if (expandControl === null) {
      const button = /** @type {HTMLButtonElement} */ (doc.createElement('button'))
      button.type = 'button'
      button.className = 'dvk-expand'
      button.setAttribute('data-dvk-action', 'expand')
      button.setAttribute('aria-pressed', 'false')
      button.addEventListener('click', () => {
        try {
          instance?.expand?.toggle()
        } catch (error) {
          host.fail(error)
        }
        syncExpandControl(current)
      })
      switchHost.appendChild(button)
      expandControl = button
    }
    // Subscribed once rather than per `enter`, because a modal dialog closes
    // itself — and while it is open it makes the page **inert**, so this button
    // cannot be pressed again to correct its own state. Without the
    // subscription the pressed styling sticks on forever after ESC or a
    // backdrop click, describing a dialog that is already gone.
    if (unsubscribeExpand === null && typeof expandable.subscribe === 'function') {
      unsubscribeExpand = expandable.subscribe(() => syncExpandControl(current))
    }
    expandControl.setAttribute('aria-pressed', String(instance?.expand?.isOn?.() === true))
    expandControl.textContent = t('expand.label', 'Enlarge')
  }

  // --- state ----------------------------------------------------------------
  let disposed = false
  let current = ''

  /**
   * @param {import('./contract.js').ViewDescriptor} view
   * @param {(key: string, fallback: string) => string} translate
   * @returns {string}
   */
  function labelFor(view, translate) {
    const key = `view.${view.id}`
    const fallback = view.label ?? view.id
    return translate(key, fallback)
  }

  /**
   * The view to open in: a remembered choice when it is still one of this
   * block's views, otherwise the kit default.
   *
   * @returns {string}
   */
  function pickInitialView() {
    const remembered = kit.getView(request.id)
    if (remembered !== undefined && views.some((view) => view.id === remembered)) return remembered
    const fallback = kit.defaultView()
    return views.some((view) => view.id === fallback) ? fallback : views[0].id
  }

  /**
   * @param {string} viewId
   */
  function enter(viewId) {
    if (disposed) return
    if (!views.some((view) => view.id === viewId)) return
    current = viewId
    kit.setView(request.id, viewId)
    for (const button of buttons) {
      button.setAttribute('aria-pressed', String(button.getAttribute('data-dvk-view') === viewId))
    }
    content.setAttribute(MODE_ATTRIBUTE, viewId === 'code' ? 'code' : 'preview')
    // Every view switch starts from an empty root; the renderer re-mounts what
    // it needs. This is what keeps `code` free: it mounts nothing at all.
    viewRoot.replaceChildren()
    try {
      const result = instance?.enter(viewId)
      if (result != null && typeof (/** @type {any} */ (result).then) === 'function') {
        /** @type {Promise<void>} */ (result).catch((error) => host.fail(error))
      }
    } catch (error) {
      host.fail(error)
    }
    // After `enter`, so `instance.expand` reflects the view that just mounted.
    syncExpandControl(viewId)
  }

  // Enter once so a block that opens in preview is already live.
  current = pickInitialView()
  enter(current)
  report(renderer.id)

  return {
    rendererId: renderer.id,
    enter,
    dispose() {
      if (disposed) return
      disposed = true
      try {
        instance?.dispose()
      } catch {
        /* ignore */
      }
      // Invariant 5: remove exactly what we added, and nothing else.
      viewRoot.remove()
      switcher.remove()
      // The expand button is a sibling of the switcher in the banner, not a
      // child of the switcher, so removing the switcher does not take it.
      expandControl?.remove()
      unsubscribeExpand?.()
      content.removeAttribute(MODE_ATTRIBUTE)
    },
  }
}
