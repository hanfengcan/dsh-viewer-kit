/**
 * The one place that knows what DSH's rendered code block looks like.
 *
 * Everything here was read out of the shipped `@deepseek-ai/dsh@0.2.0-rc.2`
 * bundles; the citations are the contract to re-check when upgrading DSH.
 * No other module may hard-code a selector.
 *
 * @module dom-contract
 */

/**
 * DOM contract for the markdown code block, as produced by `CodeBlock` in
 * `@deepseek-ai/dsh-client-ui-primitives`.
 *
 * ```html
 * <div class="<block> md-code-block" data-code-wrap>
 *   <div class="<bannerWrap>">
 *     <div class="<header>" data-code-block-banner>
 *       <div class="<heading>"><span class="<language>">html</span></div>
 *       <div class="<actions>">…wrap, copy…</div>
 *     </div>
 *   </div>
 *   <div class="<content>" data-code-block-content>
 *     <div class="shiki"><pre class="shiki css-variables">…</pre></div>
 *   </div>
 * </div>
 * ```
 *
 * ## The content node generates no box
 *
 * Verified in the shipped shell stylesheet
 * (`dsh-web-frontend/dist/assets/index-BPHePDI_.css`):
 *
 * ```css
 * ._content_7gxqk_74 { display: contents }
 * ```
 *
 * `display: contents` means the content node has **no box at all** — its
 * children are laid out as children of `.block`. Three consequences this plugin
 * depends on, each of which would break silently if that rule ever changed:
 *
 * 1. The block's height is exactly the height of its visible child. There is no
 *    independent container height, so an empty band below a preview is always
 *    the preview's own doing, never the block reserving space.
 * 2. A `>` child selector written against the content node still matches its
 *    children, which is how the view switch hides one view and shows the other.
 * 3. DSH's own code view sets no height either — `._block :where(pre)` carries
 *    only `padding` and `overflow-x: auto` — so a preview that fixed its own
 *    height would disagree with the view it swaps with. That is the argument for
 *    measuring instead: it reproduces the sibling's "content decides" semantics.
 *
 * @typedef {object} CodeBlockDom
 */

/**
 * Selector for one rendered code block.
 *
 * `.md-code-block` is a literal class the shipped component always emits
 * alongside the hashed CSS-module class (`primitives/lib/index.js:10875`).
 * The banner attribute deliberately is *not* part of this selector: it lives
 * on the header inside the block, not on the block root. A surface that finds
 * no banner declines, which is the correct outcome for a block shape we do
 * not recognise.
 */
export const CODE_BLOCK_SELECTOR = '.md-code-block'

/** The banner; the only place the fence language is written down. */
export const BANNER_SELECTOR = '[data-code-block-banner]'

/**
 * The content viewport. The shipped CSS calls it out by name as the node
 * consumers may take over:
 * "Consumers may turn the stable content node into a viewport without
 *  changing the default CodeBlock layout."
 * — `primitives/lib/markdown/CodeBlock.module.css:73-76`
 */
export const CONTENT_SELECTOR = '[data-code-block-content]'

/** The `<pre>` holding the highlighted source. */
export const PRE_SELECTOR = 'pre'

/**
 * Attribute marking the row a chat node renders into. Used as the view-state
 * scope so two different messages do not share a selection.
 * (`dsh-client-ui-chat/lib/client.js` sets `data-chat-node-key` on flow rows.)
 */
export const NODE_SCOPE_ATTRIBUTE = 'data-chat-node-key'

/**
 * NOT a scope we use — recorded here because it looks like one.
 *
 * `data-chat-running` is rendered by `RunningStatus`, a small "deep diving"
 * indicator placed *after* the current Turn's content
 * (`dsh-client-ui-chat/lib/client.js:3918-3920`). It is a sibling of the flow
 * items, never an ancestor of a code block, so
 * `element.closest('[data-chat-running]')` never matches a block.
 *
 * An earlier version of the seam used it as a "a turn is live, don't touch
 * anything" guard. That guard was silently dead code — it never fired once —
 * and the streaming protection that actually works is the content node's
 * shape (see `settleState` in `dom-seam.js`). The name is kept here so nobody
 * re-adds the same mistake.
 */
export const RUNNING_ATTRIBUTE = 'data-chat-running'

/** Our own marker on the nodes we add, used for cleanup and for self-check. */
export const ROOT_ATTRIBUTE = 'data-dvk-root'

/** Our own view mode on the content node; never managed by React. */
export const MODE_ATTRIBUTE = 'data-dvk-mode'

/** Our own marker on the view switch, so cleanup finds it again. */
export const SWITCH_ATTRIBUTE = 'data-dvk-switch'

/** Milliseconds of quiet required before re-checking a plain (unhighlighted) block. */
export const PLAIN_SETTLE_MS = 300

/**
 * Marks the conversation root while the host is pinning the reader to the tail.
 *
 * The distinction this buys is not cosmetic. A reader can sit near the end of a
 * conversation without the host pinning them there — a long code block can
 * occupy most of the document, so "close to the end" is just where the content
 * happens to be, and an arithmetic test for it is both unknowable here and
 * wrong: whether the reader looks pinned depends on the viewport height, which
 * changes with the window. Only this attribute says the offset is the HOST's
 * decision and will be re-derived by the host on every resize.
 *
 * Read it as a presence test on an ancestor of the code block, and treat a miss
 * as "the reader is not pinned": correcting a tail-following reader would leave
 * them adrift above the bottom mid-stream, and correcting an unpinned one is
 * what the reader wants. So a rename on a DSH upgrade costs a small regression
 * during streaming and nothing else — the safe direction to fail in.
 *
 * From `dsh-client-ui-chat/lib/client.js`: the `followingTail` state, the same
 * one that puts `overflow-anchor: none` on the scroller.
 */
export const FOLLOWING_TAIL_SELECTOR = '[data-chat-following-tail]'

/*
 * The conversation's scroll model, which decides whether a claim may move a reader.
 *
 * Three facts, all from the shipped
 * `@deepseek-ai/dsh-client-ui-chat/lib/client.js`, and all of them reasons the
 * plugin has to correct its own height change rather than assume something else
 * will:
 *
 * 1. **The flow is a virtual list.** `useVirtualizer({ overscan: 3 })` mounts
 *    turns above and below the visible range, so a code block is routinely
 *    claimed while it is still off screen. Claiming it changes its height by
 *    however much taller its source was than the view that replaces it.
 * 2. **The virtual list declines to correct a backward scroll.** On re-measure
 *    it applies the size delta to the scroll offset only when
 *    `scrollDirection !== "backward"` — during a backward scroll a correction
 *    would fight the reader's own motion. Reading a message upwards is exactly
 *    when a claim lands.
 * 3. **The browser stands down too.** Scroll anchoring is suppressed while a
 *    scroll gesture is in flight, and the seam claims blocks from a
 *    `MutationObserver` callback, which is mid-gesture by construction.
 *
 * (2) and (3) together are why a resize displaces the content the reader is
 * looking at by the full height delta, with nothing to put it back.
 * `scroll-guard.js` is what puts it back, and it is deliberately inert in the
 * two cases where nothing moved: a block whose bottom edge sits below the
 * reading line — the reader is on the block or above it, and neither of those
 * moves — and a list the host is pinning to its end, which it re-derives from
 * the total size itself.
 */

/**
 * How many quiet re-checks a single block gets before the seam stops waiting
 * for it and leaves it alone.
 *
 * The MutationObserver is what actually notices a fence closing; this timer
 * only backstops a mutation that arrived before the node had its final shape.
 * A block that never settles must not leave a timer polling for the life of
 * the page, so the retry is bounded at roughly 30 s of continued silence.
 */
export const MAX_QUIET_RETRIES = 100
