/**
 * Host surface for one code block.
 *
 * A surface owns exactly two things inside a block DSH rendered: a view
 * switch appended to the banner, and a root element appended to the content
 * viewport. It never mutates anything DSH created.
 *
 * The six invariants it promises (docs/01-architecture.md §6.4):
 *   1. only ever append nodes marked with `data-dvk-*`; never remove or
 *      reorder a node DSH created;
 *   2. show/hide by toggling *our* attribute on the content node, never by
 *      removing the native `<pre>`;
 *   3. the switch goes into the banner's trailing action group, whose child
 *      list React reconciles positionally and never extends past its own;
 *   4. the native source subtree is never touched, so switching back to code
 *      is byte-for-byte lossless;
 *   5. `dispose()` leaves the block exactly as it was found;
 *   6. the only write outside the block is the scroll offset correction for a
 *      height change this surface caused — see scroll-guard.js.
 *
 * @module code-block-surface
 */

import { BANNER_SELECTOR, CONTENT_SELECTOR, MODE_ATTRIBUTE, ROOT_ATTRIBUTE, SWITCH_ATTRIBUTE } from './dom-contract.js'
import { normalizeLang } from './contract.js'
import { keepingScrollPosition } from './scroll-guard.js'

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg'

/**
 * DSH's own fullscreen glyph, as plain DOM.
 *
 * Copied path-for-path from the shipped icon set —
 * `IconFullscreenOutlineArtwork` in
 * `@deepseek-ai/dsh-client-ui-primitives/lib/index.js` — so the control matches
 * the copy and branch icons DSH draws in the same banner instead of looking
 * imported from somewhere else.
 *
 * Copied rather than imported, deliberately: those icons are **React
 * components**, and this plugin is plain DOM by architecture. Pulling in React
 * and a primitives dependency to draw four glyphs would trade the plugin's
 * whole layer model for an SVG path. `currentColor` plus a 16x16 viewBox is the
 * entire contract between the artwork and the stylesheet.
 *
 * @param {Document} doc
 * @returns {Element}
 */
function expandIcon(doc) {
  const svg = doc.createElementNS(SVG_NAMESPACE, 'svg')
  svg.setAttribute('width', '16')
  svg.setAttribute('height', '16')
  svg.setAttribute('viewBox', '0 0 16 16')
  svg.setAttribute('fill', 'none')
  // The button already carries the accessible name; a second one inside it
  // would be read out twice.
  svg.setAttribute('aria-hidden', 'true')

  const filled = doc.createElementNS(SVG_NAMESPACE, 'path')
  filled.setAttribute(
    'd',
    'M2.33154 9.40576V13.1685C2.3318 13.4444 2.55556 13.6685 2.83154 13.6685H6.49463V14.6685H2.83154C2.00328 14.6685 1.3318 13.9967 1.33154 13.1685V9.40576H2.33154ZM13.1685 1.33154C13.9964 1.33199 14.6683 2.00352 14.6685 2.83154V6.40576H13.6685V2.83154C13.6683 2.5558 13.4441 2.33199 13.1685 2.33154H9.49463V1.33154H13.1685Z',
  )
  filled.setAttribute('fill', 'currentColor')
  svg.appendChild(filled)

  for (const d of ['M9.4292 6.57077L13.914 2.08594', 'M6.57077 9.4292L2.08594 13.914']) {
    const line = doc.createElementNS(SVG_NAMESPACE, 'path')
    line.setAttribute('d', d)
    line.setAttribute('stroke', 'currentColor')
    // The shipped artwork strokes at 1px for the "Regular" size.
    line.setAttribute('stroke-width', '1')
    svg.appendChild(line)
  }
  return svg
}

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
    button.addEventListener('click', () => enter(view.id, true))
    switcher.appendChild(button)
    buttons.push(button)
  }
  switchHost.appendChild(switcher)
  content.appendChild(viewRoot)

  // --- the expand button ----------------------------------------------------
  //
  // An icon button beside the view switch, matching the copy and branch controls
  // DSH draws in the same banner. Its own class, never the switch's item class:
  // that one is designed to sit inside the switch's container and reads as "one
  // of the views".
  //
  // It appears and disappears with `enter` for two reasons: whether enlarging
  // makes sense depends on what is on screen, and a renderer may report that it
  // has nothing to enlarge — a table shorter than its own cap gains nothing from
  // lifting it, and a button that does nothing is worse than no button.
  /** @type {HTMLElement | null} */
  let expandControl = null
  /** @type {(() => void) | null} */
  let unsubscribeExpand = null
  /**
   * Whether the current view is worth offering enlargement for.
   *
   * Decided once per `enter` and not re-read on a toggle: after the reader
   * collapses a table it is capped again, so a live re-check would hide the one
   * control that could expand it a second time.
   */
  let expandOffered = false

  const syncExpandControl = (activeViewId) => {
    // The built-in code view mounts nothing, so there is nothing to enlarge.
    const expandable = activeViewId === 'code' || !expandOffered ? undefined : instance?.expand
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
      // An icon-only control carries no text, so the accessible name has to come
      // from here — and `title` shows a sighted reader the same word on hover.
      // DSH's own copy button sets exactly this pair.
      button.setAttribute('aria-label', t('expand.label', 'Enlarge'))
      button.setAttribute('title', t('expand.label', 'Enlarge'))
      // `aria-expanded`, not `aria-pressed`: this is a disclosure that reveals an
      // enlarged surface, not an on/off switch. It is reported to assistive tech
      // and deliberately NOT styled — see the note in styles.js for why a state
      // rule would silently kill the hover tint.
      button.setAttribute('aria-expanded', 'false')
      button.appendChild(expandIcon(doc))
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
    // cannot be pressed again to correct its own state. Without the subscription
    // the reported state would be wrong forever after an ESC or backdrop click.
    if (unsubscribeExpand === null && typeof expandable.subscribe === 'function') {
      unsubscribeExpand = expandable.subscribe(() => syncExpandControl(current))
    }
    expandControl.setAttribute('aria-expanded', String(instance?.expand?.isOn?.() === true))
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
   * @param {boolean} [byUser] True when a reader picked this view. Only a
   *   deliberate choice is worth remembering: the view a block OPENS on is
   *   derived from `defaultToPreview`, and persisting it would freeze that
   *   setting on first sight and make the option unchangeable afterwards.
   */
  function enter(viewId, byUser = false) {
    if (disposed) return
    if (!views.some((view) => view.id === viewId)) return
    current = viewId
    if (byUser) kit.setView(request.id, viewId)
    for (const button of buttons) {
      button.setAttribute('aria-pressed', String(button.getAttribute('data-dvk-view') === viewId))
    }
    // Everything below can change how tall the block is: the swap hides one view
    // and shows the other, the expand control appears in the banner, and the
    // renderer mounts what the new view needs. A block is claimed wherever the
    // seam happens to find it, and the conversation is a virtual list — so this
    // routinely runs on a block several turns above the reader, whose content
    // then slides out from under them. The guard puts it back, and is a no-op
    // for a block they are actually looking at.
    keepingScrollPosition(root, () => {
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
      // After `enter`, so `instance.expand` reflects the view that just mounted and
      // so a renderer can inspect what it actually laid out. `available` is
      // optional and an absent one means "always offer it".
      if (viewId === 'code') expandOffered = false
      else {
        try {
          expandOffered = instance?.expand?.available?.() !== false
        } catch (error) {
          // A renderer that cannot answer must not lose the control: offering a
          // button that turns out to be unhelpful is a smaller failure than
          // hiding the only way to enlarge.
          host.fail(error)
          expandOffered = true
        }
      }
      syncExpandControl(viewId)
    })
  }

  // Enter once so a block that opens in preview is already live. No `byUser`:
  // nothing was chosen yet, so this opening is a result, not a preference.
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
