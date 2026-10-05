/**
 * Keep the reader where they were when a code block changes height.
 *
 * ## Why a block's height is a layout event
 *
 * The content node generates no box (`dom-contract.js`, "The content node
 * generates no box"), so a block's height IS the height of whichever of its two
 * children is visible. Claiming a block swaps the native `<pre>` — as tall as
 * the source, which for a prototype document is thousands of pixels — for a
 * view capped at `maxPreviewHeight`. Nothing absorbs that difference: it lands on
 * every sibling below it, in the block's own scroll container, in one frame.
 *
 * ## Why the container does not put it back
 *
 * It would not, for the three reasons recorded in `dom-contract.js` under "The
 * conversation's scroll model": the flow is a virtual list, that list declines
 * to correct the offset while the reader scrolls backward, and the browser
 * suppresses scroll anchoring during a scroll gesture — which is when the seam
 * claims, because it reacts to a `MutationObserver` callback.
 *
 * So the content under the reader's eyes slides away by an amount proportional
 * to the height of a block they never saw change. This module is the half of
 * that contract none of the three provides.
 *
 * ## The failure that matters is a position that stops existing
 *
 * Moving the offset back is the easy half. The severe half is what a long source
 * does to the reader's COORDINATE: a block whose source is 15,000px tall
 * collapses to a 320px preview, so the document is 15,000px shorter a frame
 * later. A reader standing 15,937px down is then past the new end of the
 * document, and the browser answers by clamping them to the bottom — which is
 * not a nudge, it is the end of the conversation. No amount of scroll anchoring
 * helps, because there is nothing at that offset left to anchor to.
 *
 * ## What it deliberately does NOT do
 *
 * Changing a block's height only ever moves the content BELOW it. So the only
 * question worth asking is whether the reader is looking at that content, and
 * the reading line — the middle of the visible area — answers it without a
 * tolerance to tune:
 *
 *   - **Block's bottom edge above the line → correct.** The reader's view is
 *     dominated by content below the block, and that content just moved.
 *   - **Block's bottom edge below the line → leave it.** The reader is looking
 *     at the block, or at content above it, and neither of those moves. This
 *     also covers a block entirely below the viewport: growing it pushes down
 *     only what is below IT, which the reader cannot see.
 *
 * A block that merely CLIPS the top of the viewport is in the first case, and
 * that is the common one: a long source usually arrives with a sliver of its
 * bottom edge showing and 99% of it already scrolled past. Treating "some part
 * of it is visible" as "the reader is watching it" is what let the clamp
 * through.
 *
 * **Nothing while the host is following the tail.** The host re-derives that
 * offset from the total size, so it has already absorbed a resize above the
 * viewport. Correcting it here would move the reader twice for one resize, and
 * the second correction is the one they feel. That state is the host's to
 * report — see `FOLLOWING_TAIL_SELECTOR` — and it is read BEFORE the change,
 * because a resize shortens the document and any "is the reader near the end"
 * arithmetic run afterwards calls everybody past the end.
 *
 * @module scroll-guard
 */

import { FOLLOWING_TAIL_SELECTOR } from './dom-contract.js'

/**
 * The vertical band an element occupies, in viewport coordinates.
 *
 * `bottom` is derived rather than read so the overlap test cannot compare two
 * numbers that came from different places — a host that omits `DOMRect.bottom`
 * would otherwise make "is it on screen" disagree with "is it tall".
 *
 * @typedef {{ top: number, height: number, bottom: number }} Band
 */

/**
 * @param {Element} element
 * @returns {Band | null} null when the element has no layout to report
 */
function bandOf(element) {
  const measure = /** @type {any} */ (element).getBoundingClientRect
  if (typeof measure !== 'function') return null
  const rect = measure.call(element)
  const top = Number(rect?.top)
  const height = Number(rect?.height)
  if (!Number.isFinite(top) || !Number.isFinite(height) || height <= 0) return null
  return { top, height, bottom: top + height }
}

/**
 * The nearest ancestor whose scroll offset moves the page.
 *
 * Decided geometrically rather than from computed style, because that is the
 * property the correction actually depends on: an ancestor that cannot scroll
 * ignores `scrollTop` whatever its `overflow` says. `clientHeight > 0` is what
 * rejects an unlaid-out or detached ancestor, where both numbers are 0 and the
 * overflow comparison would otherwise pass on every element in a document that
 * has not been painted yet.
 *
 * @param {Element} node
 * @returns {Element | null}
 */
function scrollerOf(node) {
  let current = node.parentElement
  while (current !== null) {
    if (current.clientHeight > 0 && current.scrollHeight > current.clientHeight) return current
    current = current.parentElement
  }
  return null
}

/**
 * Run `change`, then undo the scroll damage it did — if it did any.
 *
 * The correction is applied synchronously, before the browser gets a frame to
 * paint the new layout, because a correction that lands a frame later is a jump
 * the reader sees. Reading layout twice costs a forced reflow, which is why this
 * wraps a whole view switch rather than every individual DOM write inside one.
 *
 * @template T
 * @param {Element} node the element whose height `change` may alter
 * @param {() => T} change
 * @returns {T} whatever `change` returned
 */
export function keepingScrollPosition(node, change) {
  // No scroller means no offset to keep. The page then scrolls on the document
  // element, and nothing a block does can move that from here.
  const scroller = scrollerOf(node)
  if (scroller === null) return change()
  const before = bandOf(node)
  const viewport = bandOf(scroller)
  // No layout means no numbers to compare, and a guard that cannot measure must
  // not invent a correction.
  if (before === null || viewport === null) return change()
  // The reading line. Above it the block cannot reach what the reader is
  // looking at; below it, the block — or the untouched content above it — is.
  if (before.bottom >= viewport.top + viewport.height / 2) return change()
  // Asked BEFORE the change, and asked of the host rather than of arithmetic.
  // A height change shortens the document, so a test that compares the old
  // offset against the new `scrollHeight` afterwards reports EVERY reader as
  // past the end — precisely the case that must be corrected. See
  // FOLLOWING_TAIL_SELECTOR in dom-contract.js for why this is the host's state
  // to read and not a distance from the end.
  if (scroller.closest(FOLLOWING_TAIL_SELECTOR) !== null) return change()

  const offset = scroller.scrollTop
  const result = change()
  const after = bandOf(node)
  if (after === null) return result

  // The block's bottom edge stopped above the reading line, so everything the
  // reader is looking at sits below it and just moved by the full height
  // change. Stepping the offset by the same delta puts that content back under
  // their eyes, and it is the same sign in both directions: content below a
  // block lands `delta` further along the document whether the block grew or
  // shrank, and `offset + delta` is that step.
  const delta = after.height - before.height
  if (delta === 0) return result

  // Clamped against the document as it is NOW, after the resize — which is the
  // whole point. The block's own height is a large share of this document's,
  // so an unclamped step is the mechanism this module exists to stop.
  const limit = Math.max(0, scroller.scrollHeight - scroller.clientHeight)
  scroller.scrollTop = Math.min(limit, Math.max(0, offset + delta))
  return result
}
