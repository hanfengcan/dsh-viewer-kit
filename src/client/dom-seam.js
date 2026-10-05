/**
 * Seam adapter: find code blocks, keep track of them, hand them to the host
 * surface, and clean up after the plugin is disabled.
 *
 * This module and `code-block-surface.js` are the only two that touch DSH's
 * DOM. Everything above them works in terms of `RenderRequest`.
 *
 * @module dom-seam
 */

import { BANNER_SELECTOR, CODE_BLOCK_SELECTOR, CONTENT_SELECTOR, MAX_QUIET_RETRIES, NODE_SCOPE_ATTRIBUTE, PLAIN_SETTLE_MS, PRE_SELECTOR, SWITCH_ATTRIBUTE } from './dom-contract.js'
import { createCodeBlockSurface } from './code-block-surface.js'
import { normalizeLang } from './contract.js'

/**
 * Banner labels DSH falls back to when it has no highlighter for the fence.
 *
 * Verified from the shipped `CodeToolbar` in
 * `@deepseek-ai/dsh-client-ui-primitives`: the label is
 * `supportsHighlighting(lang) ? lang : <fallback>`, and the fallback is
 * localized copy. A real DOM capture of an `echarts` fence in this harness
 * showed `<span class="_language_…">代码块</span>` — the language name is simply
 * not in the document for a fence DSH does not know.
 *
 * Kept as a set rather than a rule so an unseen locale degrades to "label
 * treated as a real language", which is the old behaviour, rather than to
 * "every unknown-language block gets sniffed".
 */
const GENERIC_LABELS = new Set([
  'code',
  'code block',
  'codeblock',
  'plain text',
  'plaintext',
  'text',
  'untitled',
  '代码块',
  '代码',
  '纯文本',
  '文本',
])

/**
 * Containers that only the CONVERSATION view renders.
 *
 * This seam used to root at `doc.body`, and the trajectory tab renders its own
 * `.md-code-block` elements — its bundle carries `markdownPreview`,
 * `assistantContent`, and a `.md-code-block` style rule — so a body-wide scan
 * enhanced blocks in a panel this plugin was never asked to touch.
 *
 * The boundary is empirical, not assumed: the chat bundle sets ~60 `data-chat-*`
 * attributes and the trajectory bundle sets **none** of them. So "has a
 * conversation container ancestor" separates the two views without knowing
 * anything about how the shell arranges its tabs.
 *
 * A union rather than one attribute, because the nesting is DSH's business:
 * `data-chat-flow` sits on the flow container and `data-chat-node-key` on each
 * message row, and a block may be under either. Picking one would silently drop
 * blocks the day that layout moves.
 */
const CONVERSATION_SELECTOR = '[data-chat-flow],[data-chat-node-key],[data-chat-turn],[data-chat-group-key]'

/**
 * Whether a block belongs to the conversation view.
 *
 * @param {Element} element
 * @returns {boolean}
 */
function inConversation(element) {
  return element.closest(CONVERSATION_SELECTOR) !== null
}

/**
 * Read the message scope used to key view state.
 *
 * @param {Element} element
 * @returns {string}
 */
function scopeOf(element) {
  const row = element.closest(`[${NODE_SCOPE_ATTRIBUTE}]`)
  return row?.getAttribute(NODE_SCOPE_ATTRIBUTE) ?? ''
}

/**
 * Whether a code block has stopped changing.
 *
 * The shipped renderer has two shapes and the difference is decisive:
 * while streaming, the content node's element child *is* the `<pre>`; once
 * settled and highlighted, the child is a `<div class="shiki">` wrapping it
 * (`primitives/lib/index.js:10823-10872`). That gives a signal with no timer
 * and no guessing. Blocks whose language has no highlighter take the plain
 * branch in both phases, so they fall back to a quiet-period check.
 *
 * @param {Element} content
 * @returns {{ settled: boolean, reason: string }}
 */
export function settleState(content) {
  const child = content.firstElementChild
  if (child === null) return { settled: false, reason: 'empty' }
  if (child.tagName === 'DIV') return { settled: true, reason: 'highlighted' }
  // A `<pre>` is ambiguous on its own: it is a live stream for a language DSH
  // can highlight, and the *settled* state for one it cannot. The caller
  // disambiguates with the banner label, so this reports the shape and lets
  // that decision be made in one place.
  return { settled: true, reason: 'plain' }
}

/**
 * The language labels DSH shows when it has no highlighter for the fence.
 *
 * `CodeToolbar` renders `supportsHighlighting(lang) ? lang : <fallback>`, and
 * the fallback is localized copy — so the original language name is not in the
 * DOM at all for an unknown fence. Comparing against these tells the seam
 * "this banner is telling me nothing", which is different from "this block is
 * javascript".
 *
 * @param {string} label
 * @returns {boolean}
 */
export function isGenericLabel(label) {
  return GENERIC_LABELS.has(label.trim().toLowerCase())
}

/**
 * Extract the fence language. It exists only as text in the banner, because
 * the shipped component does not put it in an attribute.
 *
 * @param {Element} root
 * @returns {string} raw language text, `''` when absent
 */
export function readLang(root) {
  const banner = root.querySelector('[data-code-block-banner]')
  if (banner === null) return ''
  const heading = banner.firstElementChild
  if (heading === null) return ''
  const label = heading.firstElementChild
  return label?.textContent?.trim() ?? ''
}

/**
 * Extract the fence info string (the part after the language on the fence
 * line), when DSH's banner happens to carry it.
 *
 * @param {Element} root
 * @returns {string}
 */
function readInfo(root) {
  const banner = root.querySelector('[data-code-block-banner]')
  const heading = banner?.firstElementChild
  if (heading == null) return ''
  const children = heading.children
  // A second child is the `title` span; DSH only sets it for card-style
  // blocks, so its presence is the closest thing to an info string.
  return children.length > 1 ? (children[1].textContent ?? '').trim() : ''
}

/**
 * Extract the source text.
 *
 * @param {Element} content
 * @returns {string}
 */
export function readSource(content) {
  return content.querySelector(PRE_SELECTOR)?.textContent ?? ''
}

/**
 * @param {{
 *   kit: any,
 *   t?: (key: string, fallback: string) => string,
 *   root?: ParentNode,
 *   document?: Document,
 *   MutationObserver?: { new (callback: (records: object[]) => void): { observe: (target: unknown, options: object) => void, disconnect: () => void } },
 *   setTimeout?: typeof setTimeout,
 *   clearTimeout?: typeof clearTimeout,
 *   onError?: (error: unknown) => void,
 * }} options
 * @returns {{ scan: () => void, dispose: () => void, size: () => number, diagnose: () => object }}
 */
export function createDomSeam(options) {
  const kit = options.kit
  const doc = options.document ?? globalThis.document
  const root = options.root ?? doc.body
  const Observer = options.MutationObserver ?? globalThis.MutationObserver
  // The retry timer is the seam's only clock, so it is injected for the same
  // reason `MutationObserver` is: what it does when nobody advances time is the
  // part a test has to be able to see. `host-config.js` takes the same pair.
  const later = options.setTimeout ?? setTimeout
  const cancel = options.clearTimeout ?? clearTimeout
  const t = options.t ?? ((_key, fallback) => fallback)
  const onError =
    options.onError ??
    ((error) => {
      // eslint-disable-next-line no-console
      console.error('[dsh-viewer-kit] seam', error)
    })

  if (typeof Observer !== 'function') {
    // No observer means no discovery of new blocks. Rather than pretend, say
    // so once and stay inert: the conversation still renders normally.
    onError(new Error('MutationObserver is unavailable; dsh-viewer-kit stays inert'))
    return {
      scan: () => {},
      dispose: () => {},
      size: () => 0,
      diagnose: () => ({
        blocks: 0,
        withBanner: 0,
        withContent: 0,
        settled: 0,
        enhanced: 0,
        pending: 0,
        languages: [],
        unclaimed: [],
        outsideConversation: 0,
      }),
    }
  }

  /** @type {WeakMap<Element, { dispose: () => void, bytes: number }>} */
  const surfaces = new WeakMap()
  /** @type {Map<Element, number>} */
  const quietTimers = new Map()
  /** @type {Map<Element, number>} */
  const retryCounts = new Map()
  /**
   * The last source length seen per block, and when it was first seen at that
   * length. This is the whole streaming test — see `hasSettled`.
   *
   * @type {Map<Element, { bytes: number, since: number }>}
   */
  const arrivals = new Map()
  let disposed = false

  /**
   * How long a block's source must hold still before it counts as finished.
   *
   * TWO quiet periods, not one. One observation cannot tell a finished fence
   * from a model that has paused to think, and guessing "finished" there mounts
   * a preview of a half-written document. Two consecutive unchanged checks are
   * what turn the absence of change into a decision rather than a coincidence —
   * and the number is derived from the existing quiet period rather than
   * invented, so the delay stays a small multiple of the retry cadence instead
   * of a new constant that only means something here.
   */
  const SETTLE_QUIET_MS = PLAIN_SETTLE_MS * 2

  /**
   * Has this block stopped changing?
   *
   * A `<pre>` body is only a PROXY for "the fence has closed", and a proxy that
   * is wrong in both directions: a live stream and a finished fence can share
   * the shape, so waiting for the highlighter's `<div class="shiki">` wrapper
   * waits forever for a fence the host never re-renders, and the block is
   * abandoned once the retry budget runs out.
   *
   * Content cannot lie in the same way. A fence that is still arriving grows on
   * every token, so its length changes; a fence that is done stops changing. So
   * "unchanged for two quiet periods" IS the condition, and it is checked here
   * rather than inferred from a shape the host may never change.
   *
   * @param {Element} element
   * @param {string} source
   * @returns {boolean}
   */
  function hasSettled(element, source) {
    const bytes = source.length
    const seen = arrivals.get(element)
    const now = Date.now()
    if (seen === undefined || seen.bytes !== bytes) {
      // Progress, or the first look: either way the block is still arriving,
      // and a block that keeps arriving must not exhaust its retry budget.
      arrivals.set(element, { bytes, since: now })
      retryCounts.delete(element)
      return false
    }
    if (now - seen.since < SETTLE_QUIET_MS) return false
    arrivals.delete(element)
    return true
  }

  /**
   * Are the nodes this plugin injected into a block still on the page?
   *
   * The switch is the witness because it is the one node a block cannot be
   * useful without: the block renders perfectly well with the switch gone, which
   * is what makes the loss silent. The expand button is deliberately not
   * consulted — it is optional (a renderer may offer no `expand`), so its absence
   * says nothing about ownership.
   *
   * @param {Element} element
   * @returns {boolean}
   */
  function ownsInjection(element) {
    return element.querySelector(`[${SWITCH_ATTRIBUTE}]`) !== null
  }

  /**
   * Decide whether a block is ready, and either take it over or schedule a
   * re-check for a plain block that has gone quiet.
   *
   * @param {Element} element
   */
  function evaluate(element) {
    if (disposed) return
    if (surfaces.has(element)) {
      // A React re-render can replace a block's banner subtree — the trailing
      // action group our switch was appended into — while leaving the block
      // element itself in place. Our nodes go with the subtree, the mutation
      // that did it calls straight back in here, and a bare `surfaces.has` guard
      // would send that recovery straight back out again. The block would keep
      // rendering with no switch and nothing would ever put it back, which is
      // the same failure as a block that was never claimed.
      //
      // So a claim is honoured only while the nodes it made are still there
      // AND the source is still the one we claimed. The second half matters
      // because a claim can be made a moment before a stream resumes — see
      // `hasSettled` — and a preview of a truncated document is wrong in the
      // same silent way a missing switch is.
      const content = element.querySelector(CONTENT_SELECTOR)
      const claimed = surfaces.get(element)
      if (ownsInjection(element) && content !== null && readSource(content).length === claimed.bytes) return
      try {
        claimed?.dispose()
      } catch {
        /* ignore */
      }
      surfaces.delete(element)
    }
    // Not our surface to touch. Deliberately no `schedule`: a block in another
    // panel will never become a conversation block, so retrying it would only
    // burn the retry budget and log noise.
    if (!inConversation(element)) {
      return
    }
    const content = element.querySelector(CONTENT_SELECTOR)
    if (content === null) {
      // No viewport node: not a block shape we know. Retry briefly in case it
      // is mid-render, then stop rather than polling forever.
      schedule(element)
      return
    }
    const source = readSource(content)
    if (source.trim() === '') {
      schedule(element)
      return
    }

    const label = readLang(element)
    // A generic label means DSH has no highlighter for this fence and the real
    // language name is not in the DOM. A plain body has the same cause.
    //
    // Neither is a reason to skip the block: `plain` is also what a finished
    // fence looks like when the host never wraps it, so the request is built
    // with an EMPTY language and the renderers decide from the source. Whether
    // the fence is still arriving is decided by `hasSettled`, below, which
    // watches the content rather than the markup.
    const generic = isGenericLabel(label)
    // Two ways out, and both have to be here.
    //
    // A GENERIC label is DSH saying it has no highlighter for this fence, so no
    // `<div class="shiki">` wrapper is ever coming and waiting for one would
    // wait forever. There is nothing to distinguish "finished" from "arriving"
    // in the markup, so those blocks are decided on content alone — which is
    // what the old shape test could not do, and why they are claimed on sight.
    //
    // A REAL label under a plain body is the case that used to hang: the host
    // names a language it will not highlight, so the shape never changes and a
    // shape test waits until the retry budget is gone. Those wait for the
    // CONTENT to hold still, which is the one signal that cannot be wrong.
    if (!generic && settleState(content).reason !== 'highlighted' && !hasSettled(element, source)) {
      schedule(element)
      return
    }
    const lang = generic ? '' : label
    try {
      const surface = createCodeBlockSurface({
        root: element,
        source,
        lang,
        info: readInfo(element),
        scope: scopeOf(element),
        kit,
        document: doc,
        t,
        onOutcome: (rendererId) => kit.noteSurface(rendererId),
      })
      if (surface === null) {
        schedule(element)
        return
      }
      surfaces.set(element, { dispose: surface.dispose, bytes: source.length })
      const timer = quietTimers.get(element)
      if (timer !== undefined) cancel(/** @type {any} */ (timer))
      quietTimers.delete(element)
      retryCounts.delete(element)
      arrivals.delete(element)
    } catch (error) {
      onError(error)
    }
  }

  /**
   * Re-check a block after a quiet period.
   *
   * The MutationObserver is the real signal: DSH swaps the content node's
   * child when the fence closes, and that is a `childList` mutation we already
   * see. This timer is only the backstop for a mutation that arrived before
   * the node had its final shape, so it is bounded — a fence that never
   * settles (a tool still streaming, a block the host renders some other way)
   * must not leave a timer polling for the life of the page.
   *
   * @param {Element} element
   */
  function schedule(element) {
    if (disposed || quietTimers.has(element)) return
    const attempts = (retryCounts.get(element) ?? 0) + 1
    if (attempts > MAX_QUIET_RETRIES) return
    retryCounts.set(element, attempts)
    quietTimers.set(
      element,
      /** @type {any} */ (
        later(() => {
          quietTimers.delete(element)
          evaluate(element)
        }, PLAIN_SETTLE_MS)
      ),
    )
  }

  function scan() {
    if (disposed) return
    for (const element of root.querySelectorAll(CODE_BLOCK_SELECTOR)) evaluate(/** @type {Element} */ (element))
  }

  const observer = new Observer((records) => {
    if (disposed) return
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node.nodeType !== 1) continue
        const element = /** @type {Element} */ (node)
        if (element.matches(CODE_BLOCK_SELECTOR)) evaluate(element)
        for (const nested of element.querySelectorAll(CODE_BLOCK_SELECTOR)) evaluate(nested)
      }
      for (const node of record.removedNodes) {
        if (node.nodeType !== 1) continue
        const element = /** @type {Element} */ (node)
        surfaces.get(element)?.dispose()
        surfaces.delete(element)
        // Every kind of bookkeeping goes with the block, claimed or not. The
        // three maps are keyed by `Element` and hold strong references, so a
        // pending block that leaves the conversation without being claimed would
        // otherwise keep its whole subtree — source text included — reachable
        // for the rest of the session, plus a retry timer still aimed at a node
        // the reader cannot see. A recycled row brings its own node and must
        // start from a clean budget.
        const timer = quietTimers.get(element)
        if (timer !== undefined) cancel(timer)
        quietTimers.delete(element)
        retryCounts.delete(element)
        arrivals.delete(element)
      }
      // A React swap replaces the subtree without an add/remove we can key
      // on; re-evaluate the block the record touched. `nodeType` rather than
      // `instanceof Element` so the check holds across realms too.
      //
      // The enclosing BLOCK, never the raw target. A record whose target sits
      // outside every block describes a mutation with nothing to claim, and
      // `evaluate` has exactly one answer for an element it cannot read — it
      // schedules a retry — which would park a message wrapper in three maps and
      // re-check it a hundred times over half a minute, for nothing. A block
      // that shows up in that container arrives as an `addedNodes` record of its
      // own, which is the path that can actually claim it.
      if (record.type === 'childList' && record.target?.nodeType === 1) {
        const owner = record.target.closest(CODE_BLOCK_SELECTOR)
        if (owner !== null) evaluate(owner)
      }
    }
  })

  observer.observe(root, { childList: true, subtree: true, characterData: false })

  return {
    scan,
    size: () => {
      let count = 0
      for (const element of root.querySelectorAll(CODE_BLOCK_SELECTOR)) {
        if (surfaces.has(/** @type {Element} */ (element))) count += 1
      }
      return count
    },
    /**
     * A picture of what the seam actually sees, for diagnosing "it isn't
     * rendering anything". Every number here is something a fix would target,
     * so one call in the console is enough to tell an install problem apart
     * from a contract mismatch apart from a fence we do not claim.
     *
     * @returns {{
     *   blocks: number,
     *   withBanner: number,
     *   withContent: number,
     *   settled: number,
     *   enhanced: number,
     *   pending: number,
     *   languages: string[],
     *   unclaimed: string[],
     *   outsideConversation: number,
     * }}
     */
    diagnose() {
      const all = [...root.querySelectorAll(CODE_BLOCK_SELECTOR)]
      // Blocks outside the conversation view are not misses and must not be
      // reported as if a renderer declined them — the trajectory panel renders
      // its own `.md-code-block`s, and counting those here would send anyone
      // reading this output chasing a bug in the renderers.
      const blocks = all.filter((element) => inConversation(/** @type {Element} */ (element)))
      const report = {
        blocks: blocks.length,
        withBanner: 0,
        withContent: 0,
        settled: 0,
        enhanced: 0,
        pending: 0,
        languages: [],
        unclaimed: [],
        outsideConversation: all.length - blocks.length,
      }
      /** @type {Set<string>} */
      const languages = new Set()
      for (const element of blocks) {
        if (surfaces.has(/** @type {Element} */ (element))) report.enhanced += 1
        else report.pending += 1
        if (element.querySelector(BANNER_SELECTOR) !== null) report.withBanner += 1
        const content = element.querySelector(CONTENT_SELECTOR)
        if (content === null) continue
        report.withContent += 1
        const label = readLang(/** @type {Element} */ (element))
        // A generic label is DSH saying "no highlighter for this fence", not a
        // language called "代码块". Reporting it as `(none)` is what makes the
        // difference visible when a block is not being claimed.
        const generic = isGenericLabel(label)
        // `settled` counts blocks the seam was willing to look at. A plain body
        // under a real language is a live stream and is NOT one of them, which
        // is what separates "still arriving" from "we do not claim this".
        if (settleState(content).reason === 'highlighted' || generic) report.settled += 1
        const lang = generic ? '' : normalizeLang(label)
        languages.add(lang === '' ? '(none)' : lang)
        if (!surfaces.has(/** @type {Element} */ (element))) {
          const request = kit.buildRequest({ surface: 'code-block', scope: scopeOf(element), lang, source: readSource(content) })
          if (kit.negotiate(request) === null) report.unclaimed.push(lang === '' ? '(none)' : lang)
        }
      }
      report.languages = [...languages].sort()
      return report
    },
    dispose() {
      if (disposed) return
      disposed = true
      observer.disconnect()
      for (const timer of quietTimers.values()) cancel(/** @type {any} */ (timer))
      quietTimers.clear()
      retryCounts.clear()
      arrivals.clear()
      for (const element of root.querySelectorAll(CODE_BLOCK_SELECTOR)) {
        surfaces.get(/** @type {Element} */ (element))?.dispose()
      }
    },
  }
}
