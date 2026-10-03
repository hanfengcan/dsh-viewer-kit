/**
 * Seam adapter: find code blocks, keep track of them, hand them to the host
 * surface, and clean up after the plugin is disabled.
 *
 * This module and `code-block-surface.js` are the only two that touch DSH's
 * DOM. Everything above them works in terms of `RenderRequest`.
 *
 * @module dom-seam
 */

import { BANNER_SELECTOR, CODE_BLOCK_SELECTOR, CONTENT_SELECTOR, MAX_QUIET_RETRIES, NODE_SCOPE_ATTRIBUTE, PLAIN_SETTLE_MS, PRE_SELECTOR } from './dom-contract.js'
import { createCodeBlockSurface } from './code-block-surface.js'
import { normalizeLang } from './contract.js'

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
  return { settled: false, reason: 'streaming-or-plain' }
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
 *   onError?: (error: unknown) => void,
 * }} options
 * @returns {{ scan: () => void, dispose: () => void, size: () => number, diagnose: () => object }}
 */
export function createDomSeam(options) {
  const kit = options.kit
  const doc = options.document ?? globalThis.document
  const root = options.root ?? doc.body
  const Observer = options.MutationObserver ?? globalThis.MutationObserver
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
      }),
    }
  }

  /** @type {WeakMap<Element, { dispose: () => void }>} */
  const surfaces = new WeakMap()
  /** @type {Map<Element, number>} */
  const quietTimers = new Map()
  /** @type {Map<Element, number>} */
  const retryCounts = new Map()
  let disposed = false

  /**
   * Decide whether a block is ready, and either take it over or schedule a
   * re-check for a plain block that has gone quiet.
   *
   * @param {Element} element
   */
  function evaluate(element) {
    if (disposed || surfaces.has(element)) return
    const content = element.querySelector(CONTENT_SELECTOR)
    if (content === null) {
      // No viewport node: not a block shape we know. Retry briefly in case it
      // is mid-render, then stop rather than polling forever.
      schedule(element)
      return
    }
    const { settled } = settleState(content)
    if (!settled) {
      // The block is still streaming, or its language has no highlighter and
      // so renders through the `plain` branch in both phases. Either way the
      // observer will call us again on the settling mutation; the quiet timer
      // is the backstop for the case where that mutation is missed.
      schedule(element)
      return
    }
    const source = readSource(content)
    if (source.trim() === '') {
      schedule(element)
      return
    }
    try {
      const surface = createCodeBlockSurface({
        root: element,
        source,
        lang: readLang(element),
        info: readInfo(element),
        scope: scopeOf(element),
        kit,
        document: doc,
        t,
        onOutcome: (rendererId) => kit.noteSurface(rendererId),
      })
      if (surface === null) return
      surfaces.set(element, surface)
      const timer = quietTimers.get(element)
      if (timer !== undefined) clearTimeout(/** @type {any} */ (timer))
      quietTimers.delete(element)
      retryCounts.delete(element)
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
        setTimeout(() => {
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
        const surface = surfaces.get(element)
        if (surface !== undefined) {
          surface.dispose()
          surfaces.delete(element)
        }
      }
      // A React swap replaces the subtree without an add/remove we can key
      // on; re-evaluate anything the record touched. `nodeType` rather than
      // `instanceof Element` so the check holds across realms too.
      if (record.type === 'childList' && record.target?.nodeType === 1) {
        evaluate(record.target.closest(CODE_BLOCK_SELECTOR) ?? record.target)
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
     * }}
     */
    diagnose() {
      const blocks = [...root.querySelectorAll(CODE_BLOCK_SELECTOR)]
      const report = {
        blocks: blocks.length,
        withBanner: 0,
        withContent: 0,
        settled: 0,
        enhanced: 0,
        pending: 0,
        languages: [],
        unclaimed: [],
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
        if (settleState(content).settled) report.settled += 1
        const lang = normalizeLang(readLang(/** @type {Element} */ (element)))
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
      for (const timer of quietTimers.values()) clearTimeout(/** @type {any} */ (timer))
      quietTimers.clear()
      retryCounts.clear()
      for (const element of root.querySelectorAll(CODE_BLOCK_SELECTOR)) {
        surfaces.get(/** @type {Element} */ (element))?.dispose()
      }
    },
  }
}
