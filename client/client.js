window.__ModuleLoader__.load({ id: "dsh-viewer-kit", factory: (require) => {
  var __dvkRequire = require;
  var module = { exports: {} };
  var exports = module.exports;
Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
//#region src/client/dom-contract.js
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
const CODE_BLOCK_SELECTOR = ".md-code-block";
/** The banner; the only place the fence language is written down. */
const BANNER_SELECTOR = "[data-code-block-banner]";
/**
* The content viewport. The shipped CSS calls it out by name as the node
* consumers may take over:
* "Consumers may turn the stable content node into a viewport without
*  changing the default CodeBlock layout."
* — `primitives/lib/markdown/CodeBlock.module.css:73-76`
*/
const CONTENT_SELECTOR = "[data-code-block-content]";
/**
* Attribute marking the row a chat node renders into. Used as the view-state
* scope so two different messages do not share a selection.
* (`dsh-client-ui-chat/lib/client.js` sets `data-chat-node-key` on flow rows.)
*/
const NODE_SCOPE_ATTRIBUTE = "data-chat-node-key";
/** Our own marker on the nodes we add, used for cleanup and for self-check. */
const ROOT_ATTRIBUTE = "data-dvk-root";
/** Our own view mode on the content node; never managed by React. */
const MODE_ATTRIBUTE = "data-dvk-mode";
/** Our own marker on the view switch, so cleanup finds it again. */
const SWITCH_ATTRIBUTE = "data-dvk-switch";
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
const FOLLOWING_TAIL_SELECTOR = "[data-chat-following-tail]";

//#endregion
//#region src/client/contract.js
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
* @property {{ maxSourceBytes: number, maxPreviewHeight: number, maxTableHeight: number }} limits
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
* @property {Expandable} [expand] Optional. Present only when this view can be
*   shown without a cramped inner scrollbar, which is how the host knows to add
*   the expand button. Omit it and no button appears — a renderer with nothing
*   to offer stays silent rather than growing a dead control.
*/
/**
* The enlarge affordance, kept as its own shape because the host only ever needs
* four things from it: whether to draw a button, what pressing it does, whether
* it is currently pressed, and when that answer changed without the host asking.
*
* `isOn` exists so a toggle can report state. A table lifting its own cap and an
* HTML preview opening a dialog are different actions, but both answer the same
* question to the button that drives them.
*
* `subscribe` exists because a button click is not the only way the state
* changes. A modal dialog makes the page inert, so once the HTML preview is
* enlarged **the button cannot be clicked again** — the reader leaves with ESC
* or the close control, and without a notification the button's pressed styling
* would stay stuck on forever, describing a dialog that is no longer open.
*
* @typedef {object} Expandable
* @property {() => void} toggle
* @property {() => boolean} isOn
* @property {() => boolean} [available] Whether enlarging would show anything
*   the current view does not. Omit it and the host always offers the control.
*   Implement it when the action is invisible for some content — a table
*   shorter than its own height cap has nothing to reveal, so the button would
*   be a no-op the reader has to click to discover. A renderer whose action
*   always changes the presentation meaningfully should NOT implement this.
* @property {(listener: () => void) => (() => void)} [subscribe] Called after
*   the state changes by any route other than the host's own button.
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
* The keys, their defaults and their validation are owned by `src/schema.js`,
* which both halves share. The HOST half exports it as a `Config` schema, so a
* bad value fails the row loudly at load; the CLIENT half receives the validated
* result over `GET /dsh-viewer-kit/config` and re-resolves it leniently, so a
* missing route costs defaults rather than a failed web boot. This typedef is
* the shape both agree on, and it is what keeps a rename from being a silent
* behaviour change.
*
* @property {boolean} enabled Master switch.
* @property {readonly string[]} [disabledRendererIds] Renderers the user turned
*   off. Read-only because every consumer only ever asks `includes`.
* @property {number} [maxSourceBytes] Sources above this size keep the native
*   code block instead of being handed to a renderer.
* @property {number} [maxPreviewHeight] Pixel cap for an embedded preview, and
*   the exact height under `previewHeightMode: 'fixed'`.
* @property {'measure' | 'fit' | 'fixed'} [previewHeightMode] How an HTML
*   preview decides its height. `measure` sizes the frame to the document's
*   real, measured height (no empty band, and a scrollbar only when the content
*   genuinely exceeds the cap); `fit` estimates that height without a measuring
*   frame; `fixed` gives every document `maxPreviewHeight`. **`measure` by
*   default**, falling back to `fit` if no measurement arrives.
* @property {number} [maxTableHeight] Tallest a data table may grow before it
*   scrolls internally, in CSS pixels. The wrap carries a sticky header, so a
*   long result stays readable in place instead of stretching the conversation.
* @property {number} [chartHeight] Height of an embedded chart, in CSS pixels.
*   Charts need a definite height; a canvas in an auto-height box renders at
*   zero.
* @property {boolean} [htmlAllowScripts] Let previewed HTML run scripts inside
*   an opaque-origin sandbox. **Off by default**; see docs/01-architecture.md §8.
* @property {boolean} [defaultToPreview] Open a freshly seen item in its
*   enhanced view instead of the code view. **On by default.**
* @property {string} [prototypeStyle] Style specification injected for the one
*   response after the `apply_prototype_style` tool fires. **Host-only**: it is
*   no field of `RenderRequest`, so `createRequest` cannot hand it to a
*   renderer even by accident. `''` is a real value meaning "use the shipped
*   specification", not "unset"; see `src/schema.js`.
*/
/** The view every surface always offers, rendered by the host itself. */
const CODE_VIEW = Object.freeze({
	id: "code",
	label: "code"
});
/** Fence languages that mean the same thing. Keys are already normalized. */
const LANG_ALIASES = Object.freeze({
	htm: "html",
	xhtml: "html",
	chart: "echarts",
	tsv: "csv"
});
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
function normalizeLang(raw) {
	if (typeof raw !== "string") return "";
	const head = /^[\w-]+/.exec(raw.trim());
	if (head === null) return "";
	const lower = head[0].toLowerCase();
	return LANG_ALIASES[lower] ?? lower;
}
/**
* 32-bit FNV-1a over a string, with an explicit salt.
*
* @param {string} text
* @param {number} salt
* @returns {number} unsigned 32-bit
*/
function fnv1a(text, salt) {
	let hash = (2166136261 ^ salt) >>> 0;
	for (let index = 0; index < text.length; index += 1) {
		hash ^= text.charCodeAt(index);
		hash = Math.imul(hash, 16777619) >>> 0;
	}
	return hash >>> 0;
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
function fingerprint(parts) {
	const key = `${parts.scope ?? ""}\u0000${parts.lang}\u0000${parts.source}`;
	const a = fnv1a(key, 0);
	const b = fnv1a(key, 2654435769);
	return `${a.toString(36)}.${b.toString(36)}.${key.length.toString(36)}`;
}
/**
* Build a `RenderRequest`. One constructor so the id and the fields can never
* drift apart.
*
* @param {{ surface: SurfaceKind, scope?: string, lang?: string, source: string, info?: string }} input
* @returns {RenderRequest}
*/
function createRequest(input) {
	const lang = input.lang ?? "";
	const source = input.source;
	/** @type {RenderRequest} */
	const request = {
		id: fingerprint({
			scope: input.scope,
			lang,
			source
		}),
		surface: input.surface,
		lang,
		source
	};
	if (input.info !== void 0 && input.info !== "") request.meta = { info: input.info };
	return request;
}

//#endregion
//#region src/client/scroll-guard.js
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
	const measure = element.getBoundingClientRect;
	if (typeof measure !== "function") return null;
	const rect = measure.call(element);
	const top = Number(rect?.top);
	const height = Number(rect?.height);
	if (!Number.isFinite(top) || !Number.isFinite(height) || height <= 0) return null;
	return {
		top,
		height,
		bottom: top + height
	};
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
	let current = node.parentElement;
	while (current !== null) {
		if (current.clientHeight > 0 && current.scrollHeight > current.clientHeight) return current;
		current = current.parentElement;
	}
	return null;
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
function keepingScrollPosition(node, change) {
	const scroller = scrollerOf(node);
	if (scroller === null) return change();
	const before = bandOf(node);
	const viewport = bandOf(scroller);
	if (before === null || viewport === null) return change();
	if (before.bottom >= viewport.top + viewport.height / 2) return change();
	if (scroller.closest("[data-chat-following-tail]") !== null) return change();
	const offset = scroller.scrollTop;
	const result = change();
	const after = bandOf(node);
	if (after === null) return result;
	const delta = after.height - before.height;
	if (delta === 0) return result;
	const limit = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
	scroller.scrollTop = Math.min(limit, Math.max(0, offset + delta));
	return result;
}

//#endregion
//#region src/client/code-block-surface.js
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
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
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
	const svg = doc.createElementNS(SVG_NAMESPACE, "svg");
	svg.setAttribute("width", "16");
	svg.setAttribute("height", "16");
	svg.setAttribute("viewBox", "0 0 16 16");
	svg.setAttribute("fill", "none");
	svg.setAttribute("aria-hidden", "true");
	const filled = doc.createElementNS(SVG_NAMESPACE, "path");
	filled.setAttribute("d", "M2.33154 9.40576V13.1685C2.3318 13.4444 2.55556 13.6685 2.83154 13.6685H6.49463V14.6685H2.83154C2.00328 14.6685 1.3318 13.9967 1.33154 13.1685V9.40576H2.33154ZM13.1685 1.33154C13.9964 1.33199 14.6683 2.00352 14.6685 2.83154V6.40576H13.6685V2.83154C13.6683 2.5558 13.4441 2.33199 13.1685 2.33154H9.49463V1.33154H13.1685Z");
	filled.setAttribute("fill", "currentColor");
	svg.appendChild(filled);
	for (const d of ["M9.4292 6.57077L13.914 2.08594", "M6.57077 9.4292L2.08594 13.914"]) {
		const line = doc.createElementNS(SVG_NAMESPACE, "path");
		line.setAttribute("d", d);
		line.setAttribute("stroke", "currentColor");
		line.setAttribute("stroke-width", "1");
		svg.appendChild(line);
	}
	return svg;
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
function createCodeBlockSurface(options) {
	const { root, source, info, scope, kit, document: doc, t } = options;
	const report = options.onOutcome ?? (() => {});
	const content = root.querySelector(CONTENT_SELECTOR);
	const banner = root.querySelector(BANNER_SELECTOR);
	if (content === null || banner === null) return null;
	const request = kit.buildRequest({
		surface: "code-block",
		scope,
		lang: normalizeLang(options.lang),
		source,
		info
	});
	const renderer = kit.negotiate(request);
	if (renderer === null) {
		report(void 0);
		return null;
	}
	if (!kit.withinLimits(request)) {
		report(renderer.id);
		return null;
	}
	const viewRoot = doc.createElement("div");
	viewRoot.setAttribute(ROOT_ATTRIBUTE, "true");
	viewRoot.className = "dvk-view";
	const host = kit.hostFor(request, (error) => {
		console.error("[dsh-viewer-kit]", renderer.id, error);
	}, {
		document: doc,
		mount: (node) => {
			viewRoot.appendChild(node);
		},
		clearView: () => {
			viewRoot.replaceChildren();
		}
	});
	/** @type {import('./contract.js').RendererInstance | null} */
	let instance = null;
	try {
		instance = kit.instantiate(renderer, request, host);
	} catch {
		instance = null;
	}
	if (instance === null) {
		report(renderer.id);
		return null;
	}
	const views = kit.viewsOf(instance);
	if (views.length < 2) {
		try {
			instance.dispose();
		} catch {}
		report(renderer.id);
		return null;
	}
	for (const stale of root.querySelectorAll(`[${SWITCH_ATTRIBUTE}]`)) stale.remove();
	for (const stale of content.querySelectorAll(`[${ROOT_ATTRIBUTE}]`)) stale.remove();
	const switchHost = banner.lastElementChild;
	if (switchHost === null) {
		try {
			instance.dispose();
		} catch {}
		report(renderer.id);
		return null;
	}
	const switcher = doc.createElement("div");
	switcher.setAttribute(SWITCH_ATTRIBUTE, "true");
	switcher.className = "dvk-switch";
	switcher.setAttribute("role", "group");
	switcher.setAttribute("aria-label", t("switch.label", "View"));
	/** @type {HTMLButtonElement[]} */
	const buttons = [];
	for (const view of views) {
		const button = doc.createElement("button");
		button.type = "button";
		button.className = "dvk-switch__item";
		button.setAttribute("data-dvk-view", view.id);
		button.setAttribute("aria-pressed", "false");
		button.textContent = view.id === "code" ? t("view.code", "Code") : labelFor(view, t);
		button.addEventListener("click", () => enter(view.id, true));
		switcher.appendChild(button);
		buttons.push(button);
	}
	switchHost.appendChild(switcher);
	content.appendChild(viewRoot);
	/** @type {HTMLElement | null} */
	let expandControl = null;
	/** @type {(() => void) | null} */
	let unsubscribeExpand = null;
	/**
	* Whether the current view is worth offering enlargement for.
	*
	* Decided once per `enter` and not re-read on a toggle: after the reader
	* collapses a table it is capped again, so a live re-check would hide the one
	* control that could expand it a second time.
	*/
	let expandOffered = false;
	const syncExpandControl = (activeViewId) => {
		const expandable = activeViewId === "code" || !expandOffered ? void 0 : instance?.expand;
		if (expandable === void 0 || typeof expandable.toggle !== "function") {
			expandControl?.remove();
			expandControl = null;
			return;
		}
		if (expandControl === null) {
			const button = doc.createElement("button");
			button.type = "button";
			button.className = "dvk-expand";
			button.setAttribute("data-dvk-action", "expand");
			button.setAttribute("aria-label", t("expand.label", "Enlarge"));
			button.setAttribute("title", t("expand.label", "Enlarge"));
			button.setAttribute("aria-expanded", "false");
			button.appendChild(expandIcon(doc));
			button.addEventListener("click", () => {
				try {
					instance?.expand?.toggle();
				} catch (error) {
					host.fail(error);
				}
				syncExpandControl(current);
			});
			switchHost.appendChild(button);
			expandControl = button;
		}
		if (unsubscribeExpand === null && typeof expandable.subscribe === "function") unsubscribeExpand = expandable.subscribe(() => syncExpandControl(current));
		expandControl.setAttribute("aria-expanded", String(instance?.expand?.isOn?.() === true));
	};
	let disposed = false;
	let current = "";
	/**
	* @param {import('./contract.js').ViewDescriptor} view
	* @param {(key: string, fallback: string) => string} translate
	* @returns {string}
	*/
	function labelFor(view, translate) {
		return translate(`view.${view.id}`, view.label ?? view.id);
	}
	/**
	* The view to open in: a remembered choice when it is still one of this
	* block's views, otherwise the kit default.
	*
	* @returns {string}
	*/
	function pickInitialView() {
		const remembered = kit.getView(request.id);
		if (remembered !== void 0 && views.some((view) => view.id === remembered)) return remembered;
		const fallback = kit.defaultView();
		return views.some((view) => view.id === fallback) ? fallback : views[0].id;
	}
	/**
	* @param {string} viewId
	* @param {boolean} [byUser] True when a reader picked this view. Only a
	*   deliberate choice is worth remembering: the view a block OPENS on is
	*   derived from `defaultToPreview`, and persisting it would freeze that
	*   setting on first sight and make the option unchangeable afterwards.
	*/
	function enter(viewId, byUser = false) {
		if (disposed) return;
		if (!views.some((view) => view.id === viewId)) return;
		current = viewId;
		if (byUser) kit.setView(request.id, viewId);
		for (const button of buttons) button.setAttribute("aria-pressed", String(button.getAttribute("data-dvk-view") === viewId));
		keepingScrollPosition(root, () => {
			content.setAttribute(MODE_ATTRIBUTE, viewId === "code" ? "code" : "preview");
			viewRoot.replaceChildren();
			try {
				const result = instance?.enter(viewId);
				if (result != null && typeof result.then === "function")
 /** @type {Promise<void>} */ result.catch((error) => host.fail(error));
			} catch (error) {
				host.fail(error);
			}
			if (viewId === "code") expandOffered = false;
			else try {
				expandOffered = instance?.expand?.available?.() !== false;
			} catch (error) {
				host.fail(error);
				expandOffered = true;
			}
			syncExpandControl(viewId);
		});
	}
	current = pickInitialView();
	enter(current);
	report(renderer.id);
	return {
		rendererId: renderer.id,
		enter,
		dispose() {
			if (disposed) return;
			disposed = true;
			try {
				instance?.dispose();
			} catch {}
			viewRoot.remove();
			switcher.remove();
			expandControl?.remove();
			unsubscribeExpand?.();
			content.removeAttribute(MODE_ATTRIBUTE);
		}
	};
}

//#endregion
//#region src/client/dom-seam.js
/**
* Seam adapter: find code blocks, keep track of them, hand them to the host
* surface, and clean up after the plugin is disabled.
*
* This module and `code-block-surface.js` are the only two that touch DSH's
* DOM. Everything above them works in terms of `RenderRequest`.
*
* @module dom-seam
*/
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
const GENERIC_LABELS = /* @__PURE__ */ new Set([
	"code",
	"code block",
	"codeblock",
	"plain text",
	"plaintext",
	"text",
	"untitled",
	"代码块",
	"代码",
	"纯文本",
	"文本"
]);
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
const CONVERSATION_SELECTOR = "[data-chat-flow],[data-chat-node-key],[data-chat-turn],[data-chat-group-key]";
/**
* Whether a block belongs to the conversation view.
*
* @param {Element} element
* @returns {boolean}
*/
function inConversation(element) {
	return element.closest(CONVERSATION_SELECTOR) !== null;
}
/**
* Read the message scope used to key view state.
*
* @param {Element} element
* @returns {string}
*/
function scopeOf(element) {
	return element.closest(`[${"data-chat-node-key"}]`)?.getAttribute("data-chat-node-key") ?? "";
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
function settleState(content) {
	const child = content.firstElementChild;
	if (child === null) return {
		settled: false,
		reason: "empty"
	};
	if (child.tagName === "DIV") return {
		settled: true,
		reason: "highlighted"
	};
	return {
		settled: true,
		reason: "plain"
	};
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
function isGenericLabel(label) {
	return GENERIC_LABELS.has(label.trim().toLowerCase());
}
/**
* Extract the fence language. It exists only as text in the banner, because
* the shipped component does not put it in an attribute.
*
* @param {Element} root
* @returns {string} raw language text, `''` when absent
*/
function readLang(root) {
	const banner = root.querySelector("[data-code-block-banner]");
	if (banner === null) return "";
	const heading = banner.firstElementChild;
	if (heading === null) return "";
	return heading.firstElementChild?.textContent?.trim() ?? "";
}
/**
* Extract the fence info string (the part after the language on the fence
* line), when DSH's banner happens to carry it.
*
* @param {Element} root
* @returns {string}
*/
function readInfo(root) {
	const heading = root.querySelector("[data-code-block-banner]")?.firstElementChild;
	if (heading == null) return "";
	const children = heading.children;
	return children.length > 1 ? (children[1].textContent ?? "").trim() : "";
}
/**
* Extract the source text.
*
* @param {Element} content
* @returns {string}
*/
function readSource(content) {
	return content.querySelector("pre")?.textContent ?? "";
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
function createDomSeam(options) {
	const kit = options.kit;
	const doc = options.document ?? globalThis.document;
	const root = options.root ?? doc.body;
	const Observer = options.MutationObserver ?? globalThis.MutationObserver;
	const later = options.setTimeout ?? setTimeout;
	const cancel = options.clearTimeout ?? clearTimeout;
	const t = options.t ?? ((_key, fallback) => fallback);
	const onError = options.onError ?? ((error) => {
		console.error("[dsh-viewer-kit] seam", error);
	});
	if (typeof Observer !== "function") {
		onError(/* @__PURE__ */ new Error("MutationObserver is unavailable; dsh-viewer-kit stays inert"));
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
				outsideConversation: 0
			})
		};
	}
	/** @type {WeakMap<Element, { dispose: () => void, bytes: number }>} */
	const surfaces = /* @__PURE__ */ new WeakMap();
	/** @type {Map<Element, number>} */
	const quietTimers = /* @__PURE__ */ new Map();
	/** @type {Map<Element, number>} */
	const retryCounts = /* @__PURE__ */ new Map();
	/**
	* The last source length seen per block, and when it was first seen at that
	* length. This is the whole streaming test — see `hasSettled`.
	*
	* @type {Map<Element, { bytes: number, since: number }>}
	*/
	const arrivals = /* @__PURE__ */ new Map();
	let disposed = false;
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
	const SETTLE_QUIET_MS = 300 * 2;
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
		const bytes = source.length;
		const seen = arrivals.get(element);
		const now = Date.now();
		if (seen === void 0 || seen.bytes !== bytes) {
			arrivals.set(element, {
				bytes,
				since: now
			});
			retryCounts.delete(element);
			return false;
		}
		if (now - seen.since < SETTLE_QUIET_MS) return false;
		arrivals.delete(element);
		return true;
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
		return element.querySelector(`[${SWITCH_ATTRIBUTE}]`) !== null;
	}
	/**
	* Decide whether a block is ready, and either take it over or schedule a
	* re-check for a plain block that has gone quiet.
	*
	* @param {Element} element
	*/
	function evaluate(element) {
		if (disposed) return;
		if (surfaces.has(element)) {
			const content = element.querySelector(CONTENT_SELECTOR);
			const claimed = surfaces.get(element);
			if (ownsInjection(element) && content !== null && readSource(content).length === claimed.bytes) return;
			try {
				claimed?.dispose();
			} catch {}
			surfaces.delete(element);
		}
		if (!inConversation(element)) return;
		const content = element.querySelector(CONTENT_SELECTOR);
		if (content === null) {
			schedule(element);
			return;
		}
		const source = readSource(content);
		if (source.trim() === "") {
			schedule(element);
			return;
		}
		const label = readLang(element);
		const generic = isGenericLabel(label);
		if (!generic && settleState(content).reason !== "highlighted" && !hasSettled(element, source)) {
			schedule(element);
			return;
		}
		const lang = generic ? "" : label;
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
				onOutcome: (rendererId) => kit.noteSurface(rendererId)
			});
			if (surface === null) {
				schedule(element);
				return;
			}
			surfaces.set(element, {
				dispose: surface.dispose,
				bytes: source.length
			});
			const timer = quietTimers.get(element);
			if (timer !== void 0) cancel(timer);
			quietTimers.delete(element);
			retryCounts.delete(element);
			arrivals.delete(element);
		} catch (error) {
			onError(error);
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
		if (disposed || quietTimers.has(element)) return;
		const attempts = (retryCounts.get(element) ?? 0) + 1;
		if (attempts > 100) return;
		retryCounts.set(element, attempts);
		quietTimers.set(element, later(() => {
			quietTimers.delete(element);
			evaluate(element);
		}, 300));
	}
	function scan() {
		if (disposed) return;
		for (const element of root.querySelectorAll(CODE_BLOCK_SELECTOR)) evaluate(element);
	}
	const observer = new Observer((records) => {
		if (disposed) return;
		for (const record of records) {
			for (const node of record.addedNodes) {
				if (node.nodeType !== 1) continue;
				const element = node;
				if (element.matches(".md-code-block")) evaluate(element);
				for (const nested of element.querySelectorAll(CODE_BLOCK_SELECTOR)) evaluate(nested);
			}
			for (const node of record.removedNodes) {
				if (node.nodeType !== 1) continue;
				const element = node;
				surfaces.get(element)?.dispose();
				surfaces.delete(element);
				const timer = quietTimers.get(element);
				if (timer !== void 0) cancel(timer);
				quietTimers.delete(element);
				retryCounts.delete(element);
				arrivals.delete(element);
			}
			if (record.type === "childList" && record.target?.nodeType === 1) {
				const owner = record.target.closest(CODE_BLOCK_SELECTOR);
				if (owner !== null) evaluate(owner);
			}
		}
	});
	observer.observe(root, {
		childList: true,
		subtree: true,
		characterData: false
	});
	return {
		scan,
		size: () => {
			let count = 0;
			for (const element of root.querySelectorAll(CODE_BLOCK_SELECTOR)) if (surfaces.has(element)) count += 1;
			return count;
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
			const all = [...root.querySelectorAll(CODE_BLOCK_SELECTOR)];
			const blocks = all.filter((element) => inConversation(element));
			const report = {
				blocks: blocks.length,
				withBanner: 0,
				withContent: 0,
				settled: 0,
				enhanced: 0,
				pending: 0,
				languages: [],
				unclaimed: [],
				outsideConversation: all.length - blocks.length
			};
			/** @type {Set<string>} */
			const languages = /* @__PURE__ */ new Set();
			for (const element of blocks) {
				if (surfaces.has(element)) report.enhanced += 1;
				else report.pending += 1;
				if (element.querySelector("[data-code-block-banner]") !== null) report.withBanner += 1;
				const content = element.querySelector(CONTENT_SELECTOR);
				if (content === null) continue;
				report.withContent += 1;
				const label = readLang(element);
				const generic = isGenericLabel(label);
				if (settleState(content).reason === "highlighted" || generic) report.settled += 1;
				const lang = generic ? "" : normalizeLang(label);
				languages.add(lang === "" ? "(none)" : lang);
				if (!surfaces.has(element)) {
					const request = kit.buildRequest({
						surface: "code-block",
						scope: scopeOf(element),
						lang,
						source: readSource(content)
					});
					if (kit.negotiate(request) === null) report.unclaimed.push(lang === "" ? "(none)" : lang);
				}
			}
			report.languages = [...languages].sort();
			return report;
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			observer.disconnect();
			for (const timer of quietTimers.values()) cancel(timer);
			quietTimers.clear();
			retryCounts.clear();
			arrivals.clear();
			for (const element of root.querySelectorAll(CODE_BLOCK_SELECTOR)) surfaces.get(element)?.dispose();
		}
	};
}

//#endregion
//#region src/schema.js
/**
* The one place this plugin's configuration is defined.
*
* ## Why this file exists
*
* The kit has two halves that run in different processes, and until recently
* only one of them had any configuration at all:
*
*   - the **host half** (`lib/index.js`, Node) receives the patch row's
*     `config:` block as `apply(ctx, config)`, and owns validation;
*   - the **client half** (`client/client.js`, the browser) draws everything.
*
* A browser plugin cannot read `cordis.patch.yml`, and the boot wire carries no
* config at all — `graphRow()` emits `{id, url, rev, inject?, immediately?,
* external?}` and `parseBootManifest()` reads back exactly those fields. So the
* host half publishes the resolved config over an HTTP route and the client
* fetches it before its first scan. `tools/probe-host.mjs` fails the build if
* DSH ever adds config to the wire, because that is the day to delete this file
* and read the row directly.
*
* ## Why one field table
*
* Three things must never disagree: the default, the strict check the host
* runs, and the lenient fallback the client runs. Describing each field once
* and deriving all three removes the class of bug where `chartHeight` is
* validated in one place and defaulted in another — which is exactly how a
* dead `DEFAULT_CHART_HEIGHT` and an unreachable `|| 360` ended up in the
* echarts renderer.
*
* Zero dependencies, deliberately: this module is imported by the host half,
* which `scripts/build-host.mjs` copies verbatim with no bundler in the loop.
* A schema library would have to resolve at runtime from the profile.
*
* @module schema
*/
/**
* One configuration field.
*
* `kind` selects the check; `doc` is the user-facing explanation reused by the
* bundle patch, so the two cannot drift.
*
* @typedef {object} Field
* @property {string} key
* @property {'boolean' | 'natural' | 'positive' | 'enum' | 'stringList' | 'text'} kind
* @property {string | number | boolean | string[]} fallback
* @property {readonly string[]} [values] enum members, when `kind` is 'enum'
* @property {string} doc
*/
/**
* The shipped low-fidelity prototype style specification.
*
* This is the default **value** of the `prototypeStyle` option, not a second
* description of it, which is why it lives here beside the field table rather
* than with the tool that injects it (`tools/apply-prototype-style.js`).
*
* The option falls back to `''` rather than to this string. That keeps the
* resolved config — which is published verbatim over `CONFIG_ROUTE` and printed
* on one startup line — a single short scalar, and keeps `patchDocumentation`
* from emitting the whole specification as escaped lines into
* `cordis.patch.yml`. The cost is that
* "empty means shipped" is a rule the reader has to be told once; the field's
* `doc` and the README both say it.
*
* Prompt text, so it is written for a model rather than for a person reading a
* config file: imperative, and every rule is checkable against the markup.
*
* @type {string}
*/
const DEFAULT_PROTOTYPE_STYLE = [
	"# Low-fidelity HTML prototype style",
	"",
	"These rules apply to the HTML you emit in THIS response only. They expire",
	"immediately after it; ordinary conversation is unaffected.",
	"",
	"## Colour",
	"Greyscale only: #333 body text, #666 secondary text, #999 placeholder or",
	"disabled text, #ccc borders and dividers, #eee background fills.",
	"No colour of any kind, no gradient, no shadow.",
	"",
	"## Type",
	"font-family: system-ui, -apple-system, sans-serif",
	"",
	"## Controls",
	"Buttons and inputs: border 1px solid #ccc; border-radius 4px; box-shadow none.",
	"Cards: border 1px solid #ddd; border-radius 4px; box-shadow none.",
	"",
	"## Forbidden",
	"- External CSS frameworks (Tailwind, Bootstrap, Ant Design, and the like).",
	"- Gradients, box-shadows, animations, transitions.",
	"- Icon libraries and icon fonts. Use plain text or a minimal CSS shape.",
	"",
	"## Structure",
	"Every style lives in ONE <style> block. No inline style attributes.",
	"",
	"This is a wireframe, not a visual design: get hierarchy and layout right,",
	"and do not spend effort on polish."
].join("\n");
/** @type {readonly Field[]} */
const FIELDS = [
	{
		key: "enabled",
		kind: "boolean",
		fallback: true,
		doc: "Master switch. false leaves every code block to the host."
	},
	{
		key: "disabledRendererIds",
		kind: "stringList",
		fallback: [],
		doc: [
			"Turn renderers off without uninstalling. One list, two tiers:",
			"  by RENDERER ID ('table', 'html', 'echarts') — that renderer stops",
			"    matching, and the block is re-offered to the rest;",
			"  by FENCE NAME ('csv', 'json', 'markdown') — no renderer sees such a",
			"    block at all, whether or not a renderer exists for it.",
			"They overlap for a language a renderer is named after: ['csv'] and",
			"['table'] both switch off CSV tables, for different reasons."
		].join("\n")
	},
	{
		key: "maxSourceBytes",
		kind: "natural",
		fallback: 262144,
		doc: "Sources above this many bytes keep the native code block."
	},
	{
		key: "previewHeightMode",
		kind: "enum",
		values: [
			"measure",
			"fit",
			"fixed"
		],
		fallback: "measure",
		doc: [
			"How an embedded HTML preview decides its height:",
			"  'measure' — size the frame to the document's real height, capped.",
			"              Short content shows fully with no empty band; long",
			"              content scrolls. Falls back to fit if the measurement",
			"              never arrives.",
			"  'fit'     — estimate the rendered height. Same intent, without the",
			"              measuring frame, so a short estimate can scroll.",
			"  'fixed'   — always exactly maxPreviewHeight. Fully predictable, and",
			"              short content leaves empty space below itself."
		].join("\n")
	},
	{
		key: "maxPreviewHeight",
		kind: "positive",
		fallback: 320,
		doc: [
			"Tallest an embedded preview may grow, in CSS pixels — and, under",
			"previewHeightMode 'fixed', the exact height.",
			"320 rather than a taller figure because a preview is a glance, not a",
			"page view: at 520 a short document left a band of empty frame in the",
			"middle of the conversation, which reads as broken rather than",
			"generous. Anything taller scrolls inside the frame, which is the",
			"honest signal that there is more to see."
		].join("\n")
	},
	{
		key: "maxTableHeight",
		kind: "positive",
		fallback: 480,
		doc: [
			"Tallest a data table may grow, in CSS pixels, before it scrolls",
			"internally. The table keeps a sticky header, so a long result is",
			"readable in place instead of stretching the conversation. Expand a",
			"table from its view switch to lift the cap; a chart or an HTML",
			"preview is unaffected."
		].join("\n")
	},
	{
		key: "chartHeight",
		kind: "positive",
		fallback: 360,
		doc: [
			"Height of an embedded chart, in CSS pixels.",
			"Charts need an explicit height: a canvas inside an auto-height box",
			"renders at zero. Must be positive — a zero-height chart is invisible,",
			"which is worse than falling back to the default."
		].join("\n")
	},
	{
		key: "htmlAllowScripts",
		kind: "boolean",
		fallback: false,
		doc: [
			"Let previewed HTML run scripts, for charts and interactive reports.",
			"The frame is ALWAYS an opaque origin: allow-scripts is granted on its",
			"own and never paired with allow-same-origin, so the document cannot",
			"reach the host DOM, cookies, or storage. What changes is that merely",
			"rendering a block can start that block's network requests."
		].join("\n")
	},
	{
		key: "defaultToPreview",
		kind: "boolean",
		fallback: true,
		doc: [
			"Open a claimed block in its rendered view instead of its source.",
			"Preview is the default because the whole point of the kit is to show",
			"what the content *is*: a chart, a table, a page. Reading the markup is",
			"the exception, so it costs a click."
		].join("\n")
	},
	{
		key: "prototypeStyle",
		kind: "text",
		fallback: "",
		doc: [
			"Replaces the built-in low-fidelity style specification injected by the",
			"apply_prototype_style tool, for the one response that follows the call.",
			"",
			"Empty (the default) means the SHIPPED specification is used. The shipped",
			"text is a greyscale wireframe house style: #333/#666/#999/#ccc/#eee only,",
			"system-ui type, 1px #ccc or #ddd borders, 4px radii, no shadows, no",
			"gradients, no animation, no icon libraries, and one central <style> block",
			"rather than inline styles.",
			"",
			"Set it to any non-empty string to inject that text instead — useful when",
			"your own house style, or a different wireframe convention, has to be the",
			"one the model is held to. It is a one-shot injection: the next",
			"assembled request consumes it and the text stops appearing, whether or",
			"not the model acknowledges it."
		].join("\n")
	}
];
/**
* Is `value` acceptable for one field?
*
* @param {Field} field
* @param {unknown} value
* @returns {boolean}
*/
function accepts(field, value) {
	switch (field.kind) {
		case "boolean": return typeof value === "boolean";
		case "natural": return typeof value === "number" && Number.isInteger(value) && value > 0;
		case "positive": return typeof value === "number" && Number.isFinite(value) && value > 0;
		case "enum": return typeof value === "string" && (field.values ?? []).includes(value);
		case "stringList": return Array.isArray(value) && value.every((entry) => typeof entry === "string");
		case "text": return typeof value === "string";
		default: return false;
	}
}
/**
* @returns {Required<import('./client/contract.js').ViewerKitConfig>}
*/
function buildDefaults() {
	/** @type {Record<string, string | number | boolean | readonly string[]>} */
	const out = {};
	for (const field of FIELDS) out[field.key] = field.fallback;
	return out;
}
/**
* The shipped defaults, derived from {@link FIELDS}.
*
* @type {Readonly<Required<import('./client/contract.js').ViewerKitConfig>>}
*/
const DEFAULT_CONFIG = Object.freeze(buildDefaults());
/** @type {Readonly<Record<string, Field>>} */
const BY_KEY = Object.freeze(Object.fromEntries(FIELDS.map((field) => [field.key, field])));
/**
* Build a config from a partial patch, dropping anything unacceptable.
*
* This is the client's path, and it is deliberately lenient. The host has
* already validated the same values strictly before publishing them, so by the
* time anything reaches here a rejection means the route is serving something
* this build does not understand — an older host, a hand-edited response, a
* half-written file. Defaults are a better answer than a failed web boot.
*
* @param {Record<string, unknown> | null | undefined} patch
* @returns {Required<import('./client/contract.js').ViewerKitConfig>} every key
*   present, every value one the table accepts
*/
function resolveConfig(patch) {
	/** @type {any} */
	const out = { ...DEFAULT_CONFIG };
	if (patch == null || typeof patch !== "object") return out;
	for (const field of FIELDS) {
		const value = patch[field.key];
		if (value === void 0) continue;
		if (accepts(field, value)) out[field.key] = value;
	}
	return out;
}

//#endregion
//#region src/client/host-config.js
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
/** The path the host half registers. Mirrors `CONFIG_ROUTE` in `src/index.js`. */
const CONFIG_PATH = "/dsh-viewer-kit/config";
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
const CONFIG_TIMEOUT_MS = 1200;
/**
* Resolve the config route against the page, not the domain root.
*
* @param {string} [path]
* @returns {string}
*/
function configUrl(path = CONFIG_PATH) {
	const relative = path.replace(/^\/+/, "");
	if (typeof document === "undefined" || document.baseURI === void 0) return `/${relative}`;
	return new URL(relative, document.baseURI).pathname;
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
async function loadHostConfig(options = {}) {
	const doFetch = options.fetch ?? globalThis.fetch;
	const url = options.url ?? configUrl();
	if (typeof doFetch !== "function") return {
		config: resolveConfig(void 0),
		source: "defaults",
		reason: "no fetch in this runtime"
	};
	const controller = typeof AbortController === "function" ? new AbortController() : null;
	const schedule = options.setTimeout ?? setTimeout;
	const cancel = options.clearTimeout ?? clearTimeout;
	/** @type {any} */
	let timer = null;
	const timeout = new Promise((done) => {
		timer = schedule(() => {
			controller?.abort();
			done({ timedOut: true });
		}, options.timeoutMs ?? 1200);
	});
	try {
		const answer = await Promise.race([doFetch(url, controller === null ? {} : {
			signal: controller.signal,
			cache: "no-store"
		}).then((response) => ({
			timedOut: false,
			response
		}), (error) => ({
			timedOut: false,
			error
		})), timeout]);
		if (answer.timedOut === true) return {
			config: resolveConfig(void 0),
			source: "defaults",
			reason: `no answer within ${options.timeoutMs ?? 1200}ms`
		};
		const settled = answer;
		if (settled.error !== void 0) return {
			config: resolveConfig(void 0),
			source: "defaults",
			reason: `request failed: ${String(settled.error)}`
		};
		if (settled.response?.ok !== true) return {
			config: resolveConfig(void 0),
			source: "defaults",
			reason: `host answered ${settled.response?.status ?? "nothing"}`
		};
		const body = await settled.response.json();
		if (body === null || typeof body !== "object" || Array.isArray(body)) return {
			config: resolveConfig(void 0),
			source: "defaults",
			reason: "host sent something that is not a config object"
		};
		return {
			config: resolveConfig(body),
			source: "host"
		};
	} catch (error) {
		return {
			config: resolveConfig(void 0),
			source: "defaults",
			reason: `unexpected: ${String(error)}`
		};
	} finally {
		if (timer !== null) cancel(timer);
	}
}

//#endregion
//#region src/client/chunk-loader.js
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
const ECHARTS_CHUNK = "./client.echarts.js";
/**
* The transport, replaced wholesale by tests. Defaults to the real one, and
* the test seam exists for the same reason `kit._reset()` does: a stub that
* does not fail cannot prove anything, but neither can a real 1.5 MB canvas
* engine in a Node test.
*
* @type {(spec: string) => Promise<any>}
*/
let transport = async (spec) => {
	if (typeof __dvkRequire === "undefined" || typeof __dvkRequire.async !== "function") throw new Error(`dsh-viewer-kit: this build cannot load client chunks (require.async unavailable) for ${spec}`);
	return await __dvkRequire.async(spec);
};
/**
* Fetch one on-demand chunk. Memoised by the module table itself, so a second
* chart re-uses the first fetch.
*
* @param {string} spec
* @returns {Promise<any>}
*/
function loadChunk(spec) {
	return transport(spec);
}

//#endregion
//#region src/client/renderers/echarts.js
/**
* Chart renderer — an ECharts option object, nothing else.
*
* The whole point of this renderer is that the model writes **data**, not a
* document:
*
*     ```echarts
*     { "xAxis": { "type": "category", "data": ["Mon","Tue"] },
*       "series": [{ "type": "bar", "data": [12, 32] }] }
*     ```
*
* No HTML wrapper, no `<script src>`, no CDN. That is not a convenience: a
* chart written as HTML would need `htmlAllowScripts`, which reopens the
* question docs/01-architecture.md §8 answers. Rendered this way the engine is
* bundled, trusted code running in the host page, and the model contributes a
* JSON object that ECharts draws — it never executes anything.
*
* ## Where the 1.5 MB lives
*
* Not here. The engine is `chunks/echarts.js`, fetched on demand through the
* DSH chunk route, so a user who never writes a chart never downloads it. See
* `chunk-loader.js` for the four rules that contract imposes.
*
* ## Failure is content, not an exception
*
* A model will eventually write invalid JSON, or a valid object that is not an
* ECharts option. Both are shown *as the preview* with the parser's own
* message, because the alternative — a renderer that throws, or one that
* silently declines and leaves the user staring at raw JSON with no switch —
* is strictly worse. The code view is always one click away.
*
* @module renderers/echarts
*/
/** Fence languages this renderer claims. */
const LANGUAGES = /* @__PURE__ */ new Set(["echarts", "chart"]);
/** Ceiling on option size, so one pathological block cannot stall the tab. */
const MAX_OPTION_CHARS = 524288;
/**
* Parse the fence body as JSON.
*
* JSON.parse is strict on purpose: accepting a relaxed form here would mean
* ECharts receives a different value than the model wrote, and the resulting
* chart would be wrong in a way nobody could debug.
*
* @param {string} source
* @returns {{ option: object } | { error: string }}
*/
function parseOption(source) {
	const text = source.trim();
	if (text === "") return { error: "the block is empty" };
	if (text.length > MAX_OPTION_CHARS) return { error: `the option is ${Math.round(text.length / 1024)} KB; the limit is ${MAX_OPTION_CHARS / 1024} KB` };
	let value;
	try {
		value = JSON.parse(text);
	} catch (error) {
		return { error: `not valid JSON — ${error instanceof Error ? error.message : String(error)}` };
	}
	if (value === null || typeof value !== "object" || Array.isArray(value)) return { error: "expected a JSON object, got " + (Array.isArray(value) ? "an array" : typeof value) };
	if (!Array.isArray(
		/** @type {any} */
		value.series
	) || value.series.length === 0) return { error: "no \"series\" array — an ECharts option needs at least one series" };
	return { option: value };
}
/**
* Force a non-HTML tooltip and drop nothing else.
*
* ECharts' default tooltip renders `formatter` output as HTML, which would turn
* a model-authored string into markup in the host page. `richText` draws the
* same content onto the canvas as text. Only the tooltip is touched: the rest
* of the option is the model's, and quietly pruning fields it did not
* recognise would make the renderer lie about what it rendered.
*
* @param {object} option
* @returns {object}
*/
function harden(option) {
	/** @type {any} */
	const copy = { ...option };
	if (copy.tooltip === void 0) return copy;
	if (copy.tooltip === true || copy.tooltip === false) {
		copy.tooltip = copy.tooltip === true ? { renderMode: "richText" } : copy.tooltip;
		return copy;
	}
	if (typeof copy.tooltip === "object" && copy.tooltip !== null) copy.tooltip = {
		...copy.tooltip,
		renderMode: "richText"
	};
	return copy;
}
/**
* @param {(key: string, fallback: string) => string} t
* @returns {import('../contract.js').Renderer}
*/
function createEChartsRenderer(t) {
	return {
		id: "echarts",
		label: "Chart",
		priority: 8,
		match(request) {
			if (LANGUAGES.has(request.lang)) return true;
			return !("error" in parseOption(request.source));
		},
		create(host) {
			const { request, document: doc, mount, config } = host;
			const parsed = parseOption(request.source);
			const height = config().chartHeight;
			/** @type {null | { setOption: (o: object) => void, resize: () => void, dispose: () => void }} */
			let chart = null;
			/** @type {null | { disconnect: () => void }} */
			let observer = null;
			/** @type {null | HTMLElement} */
			let root = null;
			/** @param {string} message */
			function showProblem(message) {
				if (root === null) return;
				root.replaceChildren();
				const note = doc.createElement("p");
				note.className = "dvk-chart-note";
				note.textContent = message;
				root.appendChild(note);
			}
			return {
				views: [{
					id: "chart",
					label: t("view.chart", "Chart")
				}],
				async enter(viewId) {
					if (viewId === "code") return;
					if (root !== null) {
						root.remove();
						root = null;
					}
					root = doc.createElement("div");
					root.className = "dvk-chart";
					root.style.height = `${height}px`;
					mount(root);
					if ("error" in parsed) {
						showProblem(t("chart.invalid", "Cannot draw this chart: {reason}").replace("{reason}", parsed.error));
						return;
					}
					const pending = doc.createElement("p");
					pending.className = "dvk-chart-note";
					pending.textContent = t("chart.loading", "Loading the chart engine…");
					root.appendChild(pending);
					let mod;
					try {
						mod = await loadChunk(ECHARTS_CHUNK);
					} catch (error) {
						showProblem(t("chart.loadFailed", "The chart engine could not be loaded: {reason}").replace("{reason}", error instanceof Error ? error.message : String(error)));
						return;
					}
					if (root === null) return;
					const engine = mod?.engine ?? mod;
					if (engine == null || typeof engine.createChart !== "function") {
						showProblem(t("chart.loadFailed", "The chart engine could not be loaded: {reason}").replace("{reason}", `the chunk exported ${Object.keys(mod ?? {}).join(", ") || "nothing"}`));
						return;
					}
					try {
						root.replaceChildren();
						chart = engine.createChart(root, harden(parsed.option));
					} catch (error) {
						chart = null;
						showProblem(t("chart.renderFailed", "ECharts rejected this option: {reason}").replace("{reason}", error instanceof Error ? error.message : String(error)));
						return;
					}
					const ResizeObserverCtor = globalThis.ResizeObserver;
					if (typeof ResizeObserverCtor === "function") {
						const active = new ResizeObserverCtor(() => {
							try {
								chart?.resize();
							} catch {}
						});
						observer = active;
						active.observe(root);
					}
				},
				dispose() {
					observer?.disconnect();
					observer = null;
					try {
						chart?.dispose();
					} catch {}
					chart = null;
					root = null;
				}
			};
		}
	};
}

//#endregion
//#region src/client/renderers/html.js
/**
* HTML / SVG preview.
*
* The reference implementation of the renderer contract, and the smallest
* useful one: it claims two fence languages and adds exactly one view.
*
* Security notes live in docs/01-architecture.md §8. The short version: the
* preview is always an `<iframe>` with a `sandbox` attribute, and the two
* attributes that would matter — `allow-scripts` and `allow-same-origin` —
* are never granted together, so the document is always on an opaque origin
* and cannot reach this page, its storage, or its cookies.
*
* @module renderers/html
*/
/** @type {Readonly<Record<string, string>>} */
const LANGS = Object.freeze({
	html: "HTML",
	svg: "SVG"
});
/**
* How much of the viewport height an enlarged preview may occupy.
*
* 0.86 leaves room for the dialog's own title bar plus a strip of the page
* behind it, so the reader can still see they are inside a conversation. It is
* a share of the viewport rather than a pixel count because a fixed number is
* wrong on every screen but the one it was chosen on.
*/
const DIALOG_VIEWPORT_FRACTION = .86;
/** A `<meta charset>` is prepended unless the document declares one. */
function withCharset(source) {
	if (/<meta[^>]+charset\s*=/i.test(source)) return source;
	return `<meta charset="utf-8">\n${source}`;
}
/** Vertical padding a rendered document has around its content. */
const FRAME_PADDING = 72;
/**
* Slack applied to the estimate.
*
* An estimate that is too tall costs a little empty space; one that is too
* short puts a scrollbar on content that nearly fits. Those are not equally
* annoying, so the number is deliberately biased upward. It is a bias, not a
* measurement — see the note on `estimateHeight` for why a real measurement is
* not available here.
*/
const SAFETY_FACTOR = 1.15;
/**
* The default body margin a previewed document brings with it.
*
* The frame deliberately does NOT reset the document's own styles — the author
* wrote those, and rewriting them would mean the preview shows something other
* than what the HTML says. But the browser's default 8px top and bottom margin
* is real height, and leaving it out of the estimate is what makes a document
* that fits produce a scrollbar anyway: the frame comes out 16px short.
*/
const BROWSER_BODY_MARGIN = 16;
/** Block-level tags: each one starts a new visual line. */
const BLOCK_TAG = /<\/?(?:p|div|section|article|header|footer|main|aside|nav|ul|ol|li|dl|dt|dd|table|thead|tbody|tfoot|tr|td|th|blockquote|pre|figure|figcaption|form|fieldset|h[1-6]|address)\b[^>]*>/gi;
/** Hard line breaks and rules. */
const BREAK_TAG = /<(?:br|hr)\s*\/?>/gi;
/** Headings render taller than a body line; index 0 is unused. */
/** @type {number[]} */
const HEADING_HEIGHT = [
	0,
	52,
	44,
	38,
	34,
	32,
	30
];
/**
* Estimate the RENDERED height of a document from its source.
*
* A sandboxed frame cannot be measured — `sandbox=""` puts its document in an
* opaque origin, so `contentDocument` is null and a `load` handler learns
* nothing. Measuring it properly would mean injecting a script into the frame
* and reading `scrollHeight`, which needs `allow-scripts` and would hand the
* model's own scripts the same permission. So this stays a computation.
*
* The previous version counted SOURCE lines, which is systematically too tall:
* `<style>`, `<head>`, comments and doctype are markup the reader never sees,
* and a one-line minified document renders short while a five-line one with a
* long paragraph renders tall. Counting what actually paints — block elements,
* hard breaks, and the text between them — tracks the real height closely
* enough that the gap a user notices is gone.
*
* @param {string} source
* @param {number} cap
* @returns {number}
*/
function estimateHeight(source, cap) {
	const headingTotal = (source.match(/<h[1-6]\b[^>]*>/gi) ?? []).reduce((sum, tag) => sum + (HEADING_HEIGHT[Number(tag[2])] ?? 32), 0);
	const text = source.replace(/<!--[\s\S]*?-->/g, "").replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<head[\s\S]*?<\/head>/gi, "").replace(/<!doctype[^>]*>/gi, "").replace(/<title[\s\S]*?<\/title>/gi, "").replace(BREAK_TAG, "\n").replace(BLOCK_TAG, "\n").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").trim();
	const lines = text === "" ? [] : text.split("\n");
	let body = 0;
	for (const line of lines) {
		const content = line.trim();
		if (content === "") continue;
		body += 24 * Math.max(1, Math.ceil(content.length / 72));
	}
	const total = Math.round((body + headingTotal + FRAME_PADDING + BROWSER_BODY_MARGIN) * SAFETY_FACTOR);
	return Math.min(cap, total);
}
/**
* Height the frame keeps until a measurement arrives.
*
* Exported so `tests/run.mjs` can wait exactly this long and assert the
* fallback rather than guessing at a duration.
*/
const MEASURE_TIMEOUT_MS = 600;
/**
* Build the document that reports its own rendered height.
*
* ## Why the measuring script lives INSIDE the document
*
* An `<iframe>` is a replaced element: its height never derives from the
* document inside it, so `max-height` alone only ever limits the 150px default
* and "short content shows fully, long content scrolls" cannot be expressed in
* CSS at all. The height has to be measured.
*
* The first attempt at this used two nested frames — an outer one to run the
* measuring script and an inner one holding the model's document, with
* `allow-same-origin` on the inner so the outer could read it. **That cannot
* work, and the reason is a spec rule rather than a bug:** sandbox flags are
* inherited by nested browsing contexts and UNIONED with the frame's own. An
* outer frame without `allow-same-origin` therefore forces the sandboxed-origin
* flag onto every descendant, and an opaque origin is never same-origin with
* anything — not even with the frame that created it. The inner document got
* its own fresh opaque origin, `contentDocument` was `null`, the measuring
* script returned at its first guard, and the inner frame stayed at the
* `height: 0` the stylesheet gave it. The content was in the DOM and invisible.
*
* Measuring in-place removes the cross-origin problem entirely: the script
* measures the document it is part of.
*
* ## What keeps the model's scripts out
*
* The frame still has `sandbox="allow-scripts"` and NOT `allow-same-origin`, so
* the origin is opaque: no host DOM, no host storage, no credentialed requests,
* whatever runs inside. On top of that, a Content-Security-Policy meta with a
* per-render nonce blocks every inline script and event handler that does not
* carry it, so the model's own scripts do not run at all. The model cannot relax
* this: a later policy can only tighten an earlier one, and the meta is parsed
* before any of the model's markup.
*
* The two layers are deliberately independent. If the policy were ever ignored,
* the opaque origin still bounds the damage; if the origin were ever weakened,
* the policy still stops the scripts.
*
* @param {string} source the model's document
* @param {string} frameId echoed back so a surface can ignore other frames
* @param {string} nonce authorises the measuring script and nothing else
* @param {boolean} allowScripts when true, omit the policy and let the model's
*   own scripts run — still inside the opaque origin
* @returns {string}
*/
function buildMeasuredDocument(source, frameId, nonce, allowScripts) {
	return `<!doctype html><meta charset="utf-8">${allowScripts ? "" : `<meta http-equiv="Content-Security-Policy" content="script-src 'nonce-${nonce}'">`}
${source}
<script nonce="${nonce}">
(function () {
  var last = -1;
  function measure() {
    var body = document.body;
    // The BODY's own box, not documentElement.scrollHeight. scrollHeight on the
    // root element is max(content, viewport), so a frame that is currently
    // taller than its content — which is exactly the state before the first
    // measurement — would report its own height back and never shrink. The
    // body's rect is the content's height regardless of the viewport.
    var h = 0;
    if (body) {
      var rect = body.getBoundingClientRect();
      var style = getComputedStyle(body);
      h = Math.ceil(rect.bottom + (parseFloat(style.marginBottom) || 0) + window.scrollY);
    }
    if (!h) h = document.documentElement.scrollHeight;
    if (!h || h === last) return;
    last = h;
    try { parent.postMessage({ __dvk: 'height', id: ${JSON.stringify(frameId)}, height: h }, '*') } catch (e) {}
  }
  measure();
  // Images and webfonts land after the load event and change the height; a
  // couple of follow-ups catch them without polling forever.
  addEventListener('load', function () { measure(); setTimeout(measure, 60); setTimeout(measure, 300) });
  try { new ResizeObserver(measure).observe(document.body || document.documentElement) } catch (e) {}
})();
<\/script>`;
}
/**
* @param {(key: string, fallback: string) => string} t
* @returns {import('../contract.js').Renderer}
*/
function createHtmlRenderer(t) {
	return {
		id: "html",
		label: "HTML",
		priority: 10,
		match(request) {
			return request.lang === "html" || request.lang === "svg";
		},
		create(host) {
			const { request, limits, document: doc, mount } = host;
			const config = host.config();
			const view = doc.defaultView ?? globalThis;
			/** @type {HTMLIFrameElement | null} */
			let frame = null;
			/** Identifies this frame's measurement messages; only ever compared. */
			const frameId = `dvk-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
			/**
			* Authorises the measuring script and nothing else.
			*
			* The model's markup is fixed before this is generated, so it cannot know
			* the value; a CSP nonce only has to be unguessable, not secret from the
			* browser. `crypto.randomUUID` needs a secure context, which `dsh-app://`
			* is registered as, hence the fallback.
			*/
			const nonce = globalThis.crypto?.randomUUID?.() ?? `${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
			/**
			* The frame's current height, so a late measurement can be ignored once
			* the surface is gone and so the fallback can be told from a real result.
			*/
			let measured = false;
			/** @param {MessageEvent} event */
			const onMessage = (event) => {
				if (frame === null) return;
				if (event.source !== frame.contentWindow) return;
				const data = event.data;
				if (data == null || data.__dvk !== "height" || data.id !== frameId) return;
				const height = Number(data.height);
				if (!Number.isFinite(height) || height <= 0) return;
				measured = true;
				const next = `${Math.min(limits.maxPreviewHeight, Math.ceil(height))}px`;
				if (frame.style.height !== next) frame.style.height = next;
			};
			const destroyFrame = () => {
				frame?.remove();
				frame = null;
				view.removeEventListener?.("message", onMessage);
			};
			const mountFrame = () => {
				if (frame !== null) return;
				const mode = config.previewHeightMode;
				frame = doc.createElement("iframe");
				frame.className = "dvk-frame";
				frame.title = t("html.frameTitle", "HTML preview");
				frame.setAttribute("referrerpolicy", "no-referrer");
				const estimated = estimateHeight(request.source, limits.maxPreviewHeight);
				const initial = mode === "fixed" ? limits.maxPreviewHeight : estimated;
				if (mode === "measure") {
					frame.setAttribute("sandbox", "allow-scripts");
					frame.style.height = `${initial}px`;
					frame.srcdoc = buildMeasuredDocument(request.source, frameId, nonce, config.htmlAllowScripts);
					view.addEventListener?.("message", onMessage);
				} else {
					frame.setAttribute("sandbox", config.htmlAllowScripts ? "allow-scripts" : "");
					frame.style.height = `${initial}px`;
					frame.srcdoc = withCharset(request.source);
				}
				mount(frame);
				if (mode === "measure") setTimeout(() => {
					if (!measured && frame !== null) frame.style.height = `${estimated}px`;
				}, 600);
			};
			/**
			* The enlarged view, or null when it is closed.
			*
			* @type {HTMLDialogElement | null}
			*/
			let dialog = null;
			/** @type {HTMLIFrameElement | null} */
			let dialogFrame = null;
			/** @type {(() => void) | null} */
			let releaseDialogListener = null;
			/**
			* Told when the enlarged view opens or closes by a route other than the
			* surface's own button.
			*
			* A modal dialog makes the page inert, so while it is open the enlarge
			* button **cannot be pressed again** — the reader leaves with ESC or the
			* close control. Without this the button's pressed styling would stay on
			* forever, describing a dialog that is no longer there.
			*
			* @type {Set<() => void>}
			*/
			const expandListeners = /* @__PURE__ */ new Set();
			const notifyExpand = () => {
				for (const listener of [...expandListeners]) try {
					listener();
				} catch {}
			};
			/**
			* The cap an enlarged frame is measured against.
			*
			* Derived from the viewport rather than from `maxPreviewHeight`, because
			* the whole point of the enlarged view is to stop the content being
			* squeezed into 320px. 86% leaves room for the title bar and the page
			* behind it, so the dialog reads as an overlay rather than as a takeover.
			*
			* @returns {number}
			*/
			const dialogCap = () => {
				const viewport = view.innerHeight;
				const pixels = Number(viewport);
				if (!Number.isFinite(pixels) || pixels <= 0) return 1600;
				return Math.round(pixels * DIALOG_VIEWPORT_FRACTION);
			};
			const closeDialog = () => {
				releaseDialogListener?.();
				releaseDialogListener = null;
				dialogFrame = null;
				const open = dialog;
				dialog = null;
				if (open === null) return;
				try {
					open.close?.();
				} catch {}
				try {
					open.remove();
				} catch {}
				notifyExpand();
			};
			const openDialog = () => {
				if (dialog !== null) return;
				dialog = doc.createElement("dialog");
				dialog.className = "dvk-modal";
				dialog.setAttribute("data-dvk-modal", "true");
				dialog.setAttribute("aria-label", t("html.modalTitle", "HTML preview"));
				const bar = doc.createElement("div");
				bar.className = "dvk-modal__bar";
				const title = doc.createElement("span");
				title.className = "dvk-modal__title";
				title.textContent = t("html.modalTitle", "HTML preview");
				bar.appendChild(title);
				const close = doc.createElement("button");
				close.type = "button";
				close.className = "dvk-modal__close";
				close.setAttribute("data-dvk-modal-close", "true");
				close.setAttribute("aria-label", t("html.modalClose", "Close"));
				close.textContent = "✕";
				close.addEventListener("click", closeDialog);
				bar.appendChild(close);
				dialogFrame = doc.createElement("iframe");
				dialogFrame.className = "dvk-modal__frame";
				dialogFrame.title = t("html.frameTitle", "HTML preview");
				dialogFrame.setAttribute("referrerpolicy", "no-referrer");
				dialogFrame.setAttribute("sandbox", config.previewHeightMode === "measure" ? "allow-scripts" : config.htmlAllowScripts ? "allow-scripts" : "");
				const cap = dialogCap();
				dialogFrame.style.height = `${Math.min(cap, estimateHeight(request.source, cap))}px`;
				dialogFrame.srcdoc = config.previewHeightMode === "measure" ? buildMeasuredDocument(request.source, frameId, nonce, config.htmlAllowScripts) : withCharset(request.source);
				dialog.appendChild(bar);
				dialog.appendChild(dialogFrame);
				doc.body.appendChild(dialog);
				const onModalMessage = (event) => {
					if (dialogFrame === null) return;
					if (event.source !== dialogFrame.contentWindow) return;
					const data = event.data;
					if (data == null || data.__dvk !== "height" || data.id !== frameId) return;
					const height = Number(data.height);
					if (!Number.isFinite(height) || height <= 0) return;
					const next = `${Math.min(cap, Math.ceil(height))}px`;
					if (dialogFrame.style.height !== next) dialogFrame.style.height = next;
				};
				view.addEventListener?.("message", onModalMessage);
				releaseDialogListener = () => view.removeEventListener?.("message", onModalMessage);
				dialog.addEventListener("close", closeDialog);
				if (typeof dialog.showModal === "function") dialog.showModal();
				notifyExpand();
			};
			return {
				views: [{
					id: "preview",
					label: LANGS[request.lang] ?? "Preview"
				}],
				expand: {
					toggle: () => {
						if (dialog === null) openDialog();
						else closeDialog();
					},
					isOn: () => dialog !== null,
					subscribe: (listener) => {
						expandListeners.add(listener);
						return () => expandListeners.delete(listener);
					}
				},
				enter(viewId) {
					if (viewId === "code") {
						closeDialog();
						destroyFrame();
						return;
					}
					mountFrame();
				},
				dispose() {
					closeDialog();
					expandListeners.clear();
					destroyFrame();
				}
			};
		}
	};
}

//#endregion
//#region src/client/view-state.js
/**
* Per-content view selection.
*
* Keyed by the content fingerprint rather than by DOM node: React rebuilds
* these nodes freely, so an element-keyed store would lose the selection on
* every re-render. Keyed by content, the selection survives scroll-back and
* survives React, and a genuine content change starts a fresh default.
*
* Persistence is `sessionStorage` on purpose — a view choice is a UI
* convenience, not data worth writing to disk, and it must not outlive a
* renderer upgrade that may have dropped a view id.
*
* @module view-state
*/
const STORAGE_KEY = "dsh-viewer-kit:views:v1";
/**
* The real `sessionStorage` when it is usable, otherwise `null`.
*
* Availability is not the same as accessibility: private windows and embedded
* webviews expose the object and still throw on write, so this probes it.
*
* @returns {Storage | null}
*/
function safeStorage() {
	try {
		const probe = "__dvk_probe__";
		globalThis.sessionStorage?.setItem(probe, "1");
		globalThis.sessionStorage?.removeItem(probe);
		return globalThis.sessionStorage ?? null;
	} catch {
		return null;
	}
}
/**
* @param {{ storage?: Storage | null }} [options]
* @returns {{
*   get: (id: string) => string | undefined,
*   set: (id: string, viewId: string) => void,
*   clear: () => void,
*   subscribe: (listener: () => void) => () => void,
*   size: () => number,
* }}
*/
function createViewState(options = {}) {
	const storage = options.storage === void 0 ? safeStorage() : options.storage;
	/**
	* In-memory mirror, authoritative for reads. `sessionStorage` is only
	* touched on write and on first read: a conversation with dozens of
	* remembered blocks would otherwise re-parse the same JSON on every switch.
	*
	* @type {Map<string, string> | null}
	*/
	let cache = null;
	/** @type {Set<() => void>} */
	const listeners = /* @__PURE__ */ new Set();
	/** @returns {Map<string, string>} */
	function all() {
		if (cache !== null) return cache;
		/** @type {Map<string, string>} */
		const loaded = /* @__PURE__ */ new Map();
		if (storage !== null) try {
			const raw = storage.getItem(STORAGE_KEY);
			if (raw !== null) {
				const parsed = JSON.parse(raw);
				if (typeof parsed === "object" && parsed !== null) {
					for (const [key, value] of Object.entries(parsed)) if (typeof value === "string") loaded.set(key, value);
				}
			}
		} catch {}
		cache = loaded;
		return cache;
	}
	function persist() {
		if (storage === null) return;
		try {
			storage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(all())));
		} catch {}
	}
	function emit() {
		for (const listener of listeners) listener();
	}
	return {
		get(id) {
			return all().get(id);
		},
		set(id, viewId) {
			if (all().get(id) === viewId) return;
			all().set(id, viewId);
			persist();
			emit();
		},
		clear() {
			cache = /* @__PURE__ */ new Map();
			if (storage !== null) try {
				storage.removeItem(STORAGE_KEY);
			} catch {}
			emit();
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		size() {
			return all().size;
		}
	};
}

//#endregion
//#region src/client/kit.js
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
/**
* @param {{
*   config?: Partial<import('./contract.js').ViewerKitConfig> | null,
*   viewState?: ReturnType<typeof createViewState>,
*   onError?: (error: unknown, context: { rendererId: string, requestId: string }) => void,
* }} [options]
*/
function createKit(options = {}) {
	const onError = options.onError ?? ((error) => {
		console.error("[dsh-viewer-kit]", error);
	});
	let config = resolveConfig(options.config);
	const viewState = options.viewState ?? createViewState();
	/** @type {Map<string, import('./contract.js').Renderer>} */
	const registry = /* @__PURE__ */ new Map();
	/** @type {Set<() => void>} */
	const listeners = /* @__PURE__ */ new Set();
	/** @type {Map<string, string | null>} */
	const negotiationCache = /* @__PURE__ */ new Map();
	/** @type {{ surfaces: number, claimed: number, byRenderer: Record<string, number> }} */
	const stats = {
		surfaces: 0,
		claimed: 0,
		byRenderer: {}
	};
	function sorted() {
		return [...registry.values()].sort((left, right) => (right.priority ?? 0) - (left.priority ?? 0) || (left.id < right.id ? -1 : 1));
	}
	function invalidate() {
		negotiationCache.clear();
		for (const listener of listeners) listener();
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
		return request.source.length <= config.maxSourceBytes;
	}
	return {
		/**
		* @param {import('./contract.js').Renderer} renderer
		* @returns {() => void} disposer
		*/
		register(renderer) {
			if (renderer == null || typeof renderer.id !== "string" || renderer.id === "") throw new TypeError("[dsh-viewer-kit] a renderer needs a non-empty string id");
			if (typeof renderer.match !== "function" || typeof renderer.create !== "function") throw new TypeError(`[dsh-viewer-kit] renderer "${renderer.id}" needs match() and create()`);
			if (registry.has(renderer.id)) throw new Error(`[dsh-viewer-kit] renderer "${renderer.id}" is already registered`);
			registry.set(renderer.id, renderer);
			invalidate();
			return () => {
				if (registry.delete(renderer.id)) invalidate();
			};
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
			if (!config.enabled) return null;
			if (config.disabledRendererIds.includes(request.lang)) return null;
			const cached = negotiationCache.get(request.id);
			if (cached !== void 0) return cached === null ? null : registry.get(cached) ?? null;
			let winner = null;
			for (const renderer of sorted()) {
				if (config.disabledRendererIds.includes(renderer.id)) continue;
				let claimed = false;
				try {
					claimed = renderer.match(request) === true;
				} catch (error) {
					onError(error, {
						rendererId: renderer.id,
						requestId: request.id
					});
					continue;
				}
				if (claimed) {
					winner = renderer;
					break;
				}
			}
			negotiationCache.set(request.id, winner?.id ?? null);
			return winner;
		},
		/**
		* The view list a surface should offer: the renderer's own views plus the
		* host's built-in `code` view, which always comes last.
		*
		* @param {import('./contract.js').RendererInstance} instance
		* @returns {import('./contract.js').ViewDescriptor[]}
		*/
		viewsOf(instance) {
			const filtered = (Array.isArray(instance.views) ? instance.views : []).filter((view) => view != null && typeof view.id === "string" && view.id !== CODE_VIEW.id);
			return [...filtered, {
				...CODE_VIEW,
				label: filtered.length > 0 ? "code" : "source"
			}];
		},
		getView: (id) => viewState.get(id),
		setView: (id, viewId) => viewState.set(id, viewId),
		/** The view a never-before-seen item should open in. */
		defaultView() {
			return config.defaultToPreview ? "preview" : CODE_VIEW.id;
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
			if (surface === void 0) throw new Error("[dsh-viewer-kit] createKit() needs a host binding to mount renderers");
			return {
				request,
				document: surface.document,
				mount: surface.mount,
				clearView: surface.clearView,
				limits: {
					maxSourceBytes: config.maxSourceBytes,
					maxPreviewHeight: config.maxPreviewHeight,
					maxTableHeight: config.maxTableHeight
				},
				fail,
				config: () => config
			};
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
			if (!withinLimits(request)) return null;
			try {
				return renderer.create(host);
			} catch (error) {
				onError(error, {
					rendererId: renderer.id,
					requestId: request.id
				});
				return null;
			}
		},
		/**
		* Record one examined block. `rendererId` is absent when nothing claimed
		* it, which is the common and completely healthy case.
		*
		* @param {string} [rendererId]
		*/
		noteSurface(rendererId) {
			stats.surfaces += 1;
			if (rendererId === void 0) return;
			stats.claimed += 1;
			stats.byRenderer[rendererId] = (stats.byRenderer[rendererId] ?? 0) + 1;
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		config: () => Object.freeze({
			...config,
			disabledRendererIds: Object.freeze([...config.disabledRendererIds])
		}),
		/**
		* Replace the configuration and drop cached negotiation results, so a
		* settings change takes effect without a reload.
		*
		* @param {Partial<import('./contract.js').ViewerKitConfig> | null | undefined} patch
		*/
		setConfig(patch) {
			config = resolveConfig(patch);
			invalidate();
		},
		stats: () => ({
			surfaces: stats.surfaces,
			claimed: stats.claimed,
			byRenderer: { ...stats.byRenderer }
		}),
		/** Test seam: drop all renderers and cached state. */
		_reset() {
			registry.clear();
			negotiationCache.clear();
			stats.surfaces = 0;
			stats.claimed = 0;
			stats.byRenderer = {};
		}
	};
}

//#endregion
//#region src/client/renderers/table.js
/**
* Data table renderer.
*
* This is the proof that the architecture's central claim holds: a second
* renderer was added by writing one file in this directory and one line in
* `index.js`. Nothing in `kit.js`, `dom-seam.js`, `code-block-surface.js` or
* `contract.js` changed, and no new test fixture or DOM hook was needed.
*
* It claims three shapes, in this order of preference:
*   1. a `csv` / `tsv` fence, parsed with a real RFC 4180 reader;
*   2. a `json` fence that is an array of flat objects;
*   3. a `markdown` fence that starts with a GitHub-style pipe table, since
*      that is how people paste a table back out of a document.
*
* No dependency: the table is built from DOM calls, and the preview is a
* plain table inside our own view root — nothing is sandboxed because nothing
* here interprets markup.
*
* @module renderers/table
*/
/** Rows past this are truncated with a visible note rather than silently cut. */
const MAX_ROWS = 500;
/** Column ceilings, so one pathological cell cannot blow out the layout. */
const MAX_COLUMNS = 40;
const MAX_CELL_CHARS = 400;
/**
* RFC 4180 CSV/TSV reader: quoted fields, escaped quotes, embedded newlines,
* and CRLF tolerance.
*
* @param {string} text
* @param {string} delimiter
* @returns {string[][]}
*/
function parseDelimited(text, delimiter) {
	/** @type {string[][]} */
	const rows = [];
	/** @type {string[]} */
	let row = [];
	let field = "";
	let quoted = false;
	let index = 0;
	const endField = () => {
		row.push(field);
		field = "";
	};
	const endRow = () => {
		endField();
		rows.push(row);
		row = [];
	};
	while (index < text.length) {
		const char = text[index];
		if (quoted) {
			if (char === "\"") {
				if (text[index + 1] === "\"") {
					field += "\"";
					index += 2;
					continue;
				}
				quoted = false;
				index += 1;
				continue;
			}
			field += char;
			index += 1;
			continue;
		}
		if (char === "\"" && field === "") {
			quoted = true;
			index += 1;
			continue;
		}
		if (char === delimiter) {
			endField();
			index += 1;
			continue;
		}
		if (char === "\r" && text[index + 1] === "\n") {
			endRow();
			index += 2;
			continue;
		}
		if (char === "\n") {
			endRow();
			index += 1;
			continue;
		}
		field += char;
		index += 1;
	}
	if (field !== "" || row.length > 0) endRow();
	return rows.filter((entry) => entry.length > 1 || entry[0] !== "");
}
/**
* @param {string} text
* @returns {{ header: string[], rows: string[][] } | null}
*/
function fromDelimited(text) {
	const rows = parseDelimited(text, text.includes("	") && !text.includes(",") ? "	" : ",");
	const header = rows.shift();
	if (header === void 0 || rows.length === 0) return null;
	return {
		header,
		rows
	};
}
/**
* @param {string} text
* @returns {{ header: string[], rows: string[][] } | null}
*/
function fromJson(text) {
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		return null;
	}
	if (!Array.isArray(parsed) || parsed.length === 0) return null;
	if (!parsed.every((entry) => entry !== null && typeof entry === "object" && !Array.isArray(entry))) return null;
	const header = [];
	for (const entry of parsed) for (const key of Object.keys(entry)) if (!header.includes(key)) header.push(key);
	return {
		header,
		rows: parsed.map((entry) => header.map((key) => stringify(entry[key])))
	};
}
/** @param {unknown} value */
function stringify(value) {
	if (value === null || value === void 0) return "";
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	try {
		return JSON.stringify(value) ?? "";
	} catch {
		return String(value);
	}
}
/**
* Split one pipe-table line into cells, honouring GFM's `\|` escape.
*
* A naive `split('|')` turns `| x\|y | 2 |` into three cells, so the row no
* longer matches the header's arity and the whole table is rejected. GitHub
* renders `\|` as a literal pipe, and so does this.
*
* @param {string} line
* @returns {string[]}
*/
function splitRow(line) {
	let body = line.startsWith("|") ? line.slice(1) : line;
	if (body.endsWith("|") && !body.endsWith("\\|")) body = body.slice(0, -1);
	const cells = [];
	let cell = "";
	for (let index = 0; index < body.length; index += 1) {
		const char = body[index];
		if (char === "\\" && body[index + 1] === "|") {
			cell += "|";
			index += 1;
			continue;
		}
		if (char === "|") {
			cells.push(cell);
			cell = "";
			continue;
		}
		cell += char;
	}
	cells.push(cell);
	return cells.map((value) => value.trim());
}
/**
* Read a GitHub pipe table, but ONLY if the fence is nothing but that table.
*
* The strictness is the whole point. A looser reader takes the first line as a
* header, the second as the separator, and treats *everything after it* as data
* — so a document that opens with a table and then continues ("## Notes", a
* second table, a paragraph) renders as invented rows, and the user cannot
* tell which cells they invented. Silent wrong data is worse than no preview,
* so anything that is not a table row ends the claim and the block stays the
* native code block the model wrote.
*
* @param {string} text
* @returns {{ header: string[], rows: string[][] } | null}
*/
function fromPipeTable(text) {
	const lines = text.split("\n").map((line) => line.trim()).filter((line) => line !== "");
	if (lines.length < 2) return null;
	const isRow = (line) => /^\|.*\|$/.test(line) && !/^\|[\s|]*\|$/.test(line);
	const header = splitRow(lines[0]);
	if (!isRow(lines[0]) || !isRow(lines[1])) return null;
	if (!/^:?-{2,}:?$/.test(splitRow(lines[1])[0] ?? "")) return null;
	const rows = [];
	for (const line of lines.slice(2)) {
		if (isRow(line) && /^:?-{2,}:?$/.test(splitRow(line)[0] ?? "")) return null;
		if (!isRow(line)) return null;
		rows.push(splitRow(line));
	}
	if (rows.some((row) => row.length !== header.length)) return null;
	return {
		header,
		rows
	};
}
/**
* Sniff the table, without committing to it. Kept separate from `match` so a
* renderer can answer "do I recognise this?" cheaply and "is it worth
* showing?" more carefully.
*
* @param {string} lang
* @param {string} source
* @returns {{ header: string[], rows: string[][] } | null}
*/
function readTable(lang, source) {
	if (lang === "csv") return fromDelimited(source);
	if (lang === "json") return fromJson(source);
	if (lang === "markdown" || lang === "") return fromPipeTable(source);
	return null;
}
/**
* @param {(key: string, fallback: string) => string} t
* @returns {import('../contract.js').Renderer}
*/
function createTableRenderer(t) {
	return {
		id: "table",
		label: "Table",
		priority: 5,
		match(request) {
			if (readTable("json", request.source) !== null) return true;
			if (request.lang === "csv" || request.lang === "markdown" || request.lang === "") return readTable(request.lang, request.source) !== null;
			return false;
		},
		create(host) {
			const { request, limits, document: doc, mount } = host;
			const table = readTable(request.lang, request.source);
			if (table === null) return null;
			const columns = table.header.slice(0, MAX_COLUMNS);
			const rows = table.rows.slice(0, MAX_ROWS);
			const hiddenColumns = table.header.length - columns.length;
			const hiddenRows = table.rows.length - rows.length;
			/**
			* Whether the height cap is currently lifted.
			*
			* Own state rather than something read back off the DOM: `enter()` clears
			* the view root on every view switch, so a flag living only in the
			* markup would be lost the moment the user toggled to code and back.
			*/
			let expanded = false;
			/**
			* Told when the cap is lifted or dropped.
			*
			* A table is only ever toggled by its own button, so nothing else drives
			* this today — but the surface renders `aria-pressed` from `isOn()` and
			* the HTML preview already needed this because a modal dialog closes
			* itself. Publishing the same hook keeps the two renderers interchangeable
			* and means a future way out of this control does not silently strand the
			* button again.
			*
			* @type {Set<() => void>}
			*/
			const expandListeners = /* @__PURE__ */ new Set();
			const notifyExpand = () => {
				for (const listener of [...expandListeners]) try {
					listener();
				} catch {}
			};
			/**
			* This instance's own wrap, so `expand` restyles the right one.
			*
			* A `document.querySelector` here would find whichever table came first
			* in the document — including another conversation block's — so pressing
			* expand in one block could restyle a different block's table.
			*/
			/** @type {HTMLElement | null} */
			let wrap = null;
			/** Apply or lift the cap on our wrap. */
			const applyCap = () => {
				if (wrap === null) return;
				if (expanded) wrap.style.maxHeight = "";
				else wrap.style.maxHeight = `${limits.maxTableHeight}px`;
			};
			return {
				views: [{
					id: "table",
					label: t("view.table", "Table")
				}],
				expand: {
					/**
					* Whether lifting the cap would reveal anything.
					*
					* This is the answer to a control that appeared to do nothing: a table
					* shorter than `maxTableHeight` is never clipped, so removing a cap it
					* never reached changes no pixel. With two or three rows the button is
					* a no-op the reader has to click to discover.
					*
					* Answered from layout rather than from the row count, because the same
					* number of rows is a different height in a different font and a cell
					* can wrap. `scrollHeight > clientHeight` is the standard overflow test
					* and it is exactly what "is this clipped" means.
					*
					* @returns {boolean}
					*/
					available() {
						if (wrap === null) return false;
						const content = Number(wrap.scrollHeight);
						const box = Number(wrap.clientHeight);
						if (!Number.isFinite(content) || !Number.isFinite(box) || content === 0 && box === 0) return true;
						return content > box + 1;
					},
					toggle() {
						expanded = !expanded;
						applyCap();
						notifyExpand();
					},
					isOn: () => expanded,
					subscribe: (listener) => {
						expandListeners.add(listener);
						return () => expandListeners.delete(listener);
					}
				},
				enter(viewId) {
					if (viewId === "code") {
						wrap = null;
						return;
					}
					const root = doc.createElement("div");
					root.className = "dvk-table-wrap";
					wrap = root;
					applyCap();
					const summary = doc.createElement("p");
					summary.className = "dvk-table-summary";
					summary.textContent = t("table.summary", "{rows} rows × {columns} columns").replace("{rows}", String(rows.length)).replace("{columns}", String(columns.length));
					root.appendChild(summary);
					const element = doc.createElement("table");
					element.className = "dvk-table";
					const thead = doc.createElement("thead");
					const headRow = doc.createElement("tr");
					for (const name of columns) {
						const th = doc.createElement("th");
						th.textContent = name.slice(0, MAX_CELL_CHARS);
						headRow.appendChild(th);
					}
					thead.appendChild(headRow);
					element.appendChild(thead);
					const tbody = doc.createElement("tbody");
					for (const row of rows) {
						const tr = doc.createElement("tr");
						for (let index = 0; index < columns.length; index += 1) {
							const td = doc.createElement("td");
							const value = row[index] ?? "";
							td.textContent = value.length > MAX_CELL_CHARS ? `${value.slice(0, MAX_CELL_CHARS)}…` : value;
							tr.appendChild(td);
						}
						tbody.appendChild(tr);
					}
					element.appendChild(tbody);
					root.appendChild(element);
					if (hiddenRows > 0 || hiddenColumns > 0) {
						const note = doc.createElement("p");
						note.className = "dvk-table-summary";
						note.textContent = t("table.truncated", "Showing the first {rows} rows and {columns} columns").replace("{rows}", String(rows.length)).replace("{columns}", String(columns.length));
						root.appendChild(note);
					}
					mount(root);
				},
				dispose() {
					wrap = null;
					expandListeners.clear();
				}
			};
		}
	};
}

//#endregion
//#region src/client/locale.js
/**
* Copy for the kit.
*
* Registers with DSH's locale service when the host has one, and otherwise
* falls back to a dictionary chosen from the document language. The kit must
* keep working on a host that predates the locale service, so nothing here
* throws.
*
* @module locale
*/
const NAMESPACE$1 = "dsh-viewer-kit";
/**
* Copy for the kit, keyed by language.
*
* Exported so a test can ask it directly. A missing key does not fail loudly at
* runtime — `t` falls back to the English literal — so "the button says
* 'Enlarge' inside a Chinese interface" is only catchable by comparing the two
* dictionaries, which is what that test does.
*
* @type {Record<string, Record<string, string>>}
*/
const DICTIONARIES = {
	en: {
		"switch.label": "Content view",
		"view.code": "Code",
		"view.preview": "Preview",
		"view.table": "Table",
		"view.chart": "Chart",
		"html.frameTitle": "HTML preview",
		"expand.label": "Enlarge",
		"html.modalTitle": "HTML preview",
		"html.modalClose": "Close",
		"table.summary": "{rows} rows × {columns} columns",
		"table.truncated": "Showing the first {rows} rows and {columns} columns",
		"chart.loading": "Loading the chart engine…",
		"chart.invalid": "Cannot draw this chart: {reason}",
		"chart.loadFailed": "The chart engine could not be loaded: {reason}",
		"chart.renderFailed": "ECharts rejected this option: {reason}"
	},
	zh: {
		"switch.label": "内容视图",
		"view.code": "代码",
		"view.preview": "预览",
		"view.table": "表格",
		"view.chart": "图表",
		"html.frameTitle": "HTML 预览",
		"expand.label": "放大",
		"html.modalTitle": "HTML 预览",
		"html.modalClose": "关闭",
		"table.summary": "{rows} 行 × {columns} 列",
		"table.truncated": "仅显示前 {rows} 行、前 {columns} 列",
		"chart.loading": "正在加载图表引擎…",
		"chart.invalid": "无法绘制这张图：{reason}",
		"chart.loadFailed": "图表引擎加载失败：{reason}",
		"chart.renderFailed": "ECharts 拒绝了这个配置：{reason}"
	}
};
/**
* Build the translator, and hand back its own disposer.
*
* The dictionary registration is owned HERE rather than parked on `ctx.effect`.
* Two reasons, both learned the hard way:
*
*   - `ctx.effect`'s disposer belongs to the fiber, so a re-activation that
*     retires the previous instance (HMR, re-enable) would leave the
*     registration behind, and the next `register` would throw
*     "namespace … already has locale …" — which fails the whole entry and
*     takes the boot audit, and therefore DSH, down with it.
*   - ownership is clearer: what this function registers, it unregisters.
*
* @param {{ get: (name: string) => unknown }} ctx
* @returns {{ t: (key: string, fallback: string) => string, dispose: () => void }}
*/
function createTranslator(ctx) {
	/**
	* `locale.bind(ns)` returns the translate FUNCTION itself, not an object
	* carrying one — `const t = locale.bind(NS); t('key')`. Calling
	* `bound.t(key)` threw inside the seam, where the per-block try/catch turned
	* it into a silent "no renderer claimed this".
	*
	* @type {((key: string) => string) | null}
	*/
	let bound = null;
	/** @type {(() => void) | null} */
	let unregister = null;
	/** @type {any} */
	const locale = ctx.get("locale");
	if (locale != null && typeof locale.register === "function" && typeof locale.bind === "function") {
		try {
			unregister = locale.register(NAMESPACE$1, DICTIONARIES);
		} catch {}
		const translate = locale.bind(NAMESPACE$1);
		if (typeof translate === "function") bound = translate;
	}
	/**
	* @param {string} lang
	* @returns {Record<string, string>}
	*/
	function dictionaryFor(lang) {
		const primary = String(lang ?? "").toLowerCase().split(/[-_]/)[0];
		return DICTIONARIES[primary] ?? DICTIONARIES.en;
	}
	return {
		t(key, fallback) {
			if (bound !== null) {
				const value = bound(key);
				if (typeof value === "string" && value !== "" && value !== key) return value;
			}
			return dictionaryFor(globalThis.document?.documentElement?.lang ?? "en")[key] ?? fallback;
		},
		dispose() {
			try {
				unregister?.();
			} catch {}
			unregister = null;
			bound = null;
		}
	};
}

//#endregion
//#region src/client/styles.js
/**
* The kit's stylesheet.
*
* Every colour and radius is a `--dsw-*` design token so the plugin follows the
* host's light/dark theme without knowing anything about it. The two rules
* that implement the view switch are the whole mechanism:
*
*   - `data-dvk-mode="code"`   → our view root is display:none, native shows
*   - `data-dvk-mode="preview"`→ the native child is display:none, ours shows
*
* Hiding rather than removing is what keeps switching back to code lossless
* (docs/01-architecture.md §6.4, invariant 2 and 4).
*
* @module styles
*/
/** Marks our own `<style>` element, for re-apply and cleanup. */
const STYLE_MARKER = "dsh-viewer-kit";
/**
* Install the stylesheet into a document and return its remover.
*
* This injects the element itself rather than reaching for a host `styles`
* helper. The client module contract is `factory(require) → exports`, so the
* only things a plugin may rely on are `require`, the browser globals, and the
* `ctx` accessors documented for `apply`. Injecting a `<style>` is exactly what
* the shipped UI packages do, and it keeps the cleanup guarantee ours.
*
* @param {Document} doc
* @returns {() => void} remover
*/
function installStyles(doc) {
	for (const stale of doc.querySelectorAll(`style[data-plugin="${STYLE_MARKER}"]`)) stale.remove();
	const tag = doc.createElement("style");
	tag.setAttribute("data-plugin", STYLE_MARKER);
	tag.setAttribute("data-plugin-css", `${STYLE_MARKER}/styles`);
	tag.textContent = STYLES;
	doc.head.appendChild(tag);
	return () => {
		tag.remove();
	};
}
/** @type {string} */
const STYLES = `
.dvk-switch {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  margin-right: 6px;
  padding: 2px;
  border-radius: var(--dsw-radius-sm, 6px);
  background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.12));
}
.dvk-switch__item {
  appearance: none;
  border: 0;
  margin: 0;
  padding: 0 8px;
  height: 20px;
  border-radius: calc(var(--dsw-radius-sm, 6px) - 2px);
  font: 11px/18px var(--dsw-font-family, system-ui, sans-serif);
  color: var(--dsw-alias-label-tertiary, #888);
  background: transparent;
  cursor: pointer;
  white-space: nowrap;
}
.dvk-switch__item:hover {
  color: var(--dsw-alias-label-secondary, #666);
}
.dvk-switch__item[aria-pressed="true"] {
  color: var(--dsw-alias-label-primary, #111);
  background: var(--dsw-alias-bg-base, #fff);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.12);
}
.dvk-switch__item:focus-visible {
  outline: 1px solid var(--dsw-alias-state-business-primary, #4a7dff);
  outline-offset: 1px;
}

.dvk-view {
  padding: 6px 22px 20px;
}
.dvk-frame {
  display: block;
  width: 100%;
  max-width: 100%;
  border: 0;
  border-radius: var(--dsw-radius-sm, 6px);
  background: var(--dsw-alias-bg-base, #fff);
}

[data-dvk-mode="code"] > .dvk-view {
  display: none;
}
[data-dvk-mode="preview"] > *:not(.dvk-view) {
  display: none;
}
[data-dvk-mode="preview"] > .dvk-view {
  display: block;
}
/* Last, so it wins the tie with the rule above: a view root with nothing in
   it must not reserve a line of layout. */
.dvk-view:empty {
  display: none;
}

/* Data table view. Rendered from DOM calls, so it inherits the host font and
   needs no sandbox.

   The height cap is written inline by renderers/table.js from the
   maxTableHeight config, deliberately NOT here: a constant in this file
   would be a second copy of the default, and a second copy is how this rule
   used to read 'max-height: inherit' and cap nothing at all. 'inherit' took
   the parent '.dvk-view', which sets only padding, so it computed to 'none'
   and the wrap never scrolled — which also meant the sticky header below had
   no bounded scrollport to stick to, and did nothing either. */
.dvk-table-summary {
  margin: 0 0 8px;
  color: var(--dsw-alias-label-tertiary, #888);
  font: 11px/18px var(--dsw-font-family, system-ui, sans-serif);
}
.dvk-table-wrap {
  overflow: auto;
}
.dvk-table {
  border-collapse: collapse;
  width: 100%;
  font: var(--dsw-font-markdown-code-block-small, 12px/18px var(--dsw-font-family, monospace));
  font-variant-numeric: tabular-nums;
}
.dvk-table th,
.dvk-table td {
  border: 1px solid var(--dsw-alias-border-l1, rgba(127, 127, 127, 0.24));
  padding: 4px 10px;
  text-align: start;
  white-space: nowrap;
  max-width: 32ch;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dvk-table th {
  position: sticky;
  top: 0;
  background: var(--dsw-alias-bg-layer-1, #f5f5f5);
  font-weight: 600;
  color: var(--dsw-alias-label-primary, #111);
}
.dvk-table tbody tr:nth-child(even) {
  background: color-mix(in srgb, var(--dsw-alias-interactive-bg-hover, #8881) 40%, transparent);
}

/* Chart view. The height is set inline from the chartHeight config — a canvas
   in an auto-height box renders at zero — so the rule here is deliberately only
   the width and the box, never the height. */
.dvk-chart {
  width: 100%;
  min-height: 120px;
  contain: content;
}
.dvk-chart-note {
  margin: 0;
  padding: 12px 2px;
  color: var(--dsw-alias-label-tertiary, #888);
  font: 11px/18px var(--dsw-font-family, system-ui, sans-serif);
}

/* The enlarge control.

   An ICON button, matching the copy and branch controls DSH already draws in
   this banner. The look is taken from the shipped CodeBlock module
   (@deepseek-ai/dsh-client-ui-primitives/lib/markdown/CodeBlock.module.css,
   its .copyButton rule): fully transparent, no border, no padding, and the
   glyph is a 16x16 SVG filled with currentColor so it follows the banner's
   text colour.

   There is deliberately NO rule keyed on the button's own state, for two
   independent reasons:

     - The control must not change appearance when used, and a state rule is the
       only thing that could make it do so.
     - A state rule and :hover have EQUAL specificity (a class plus one qualifier
       each), so source order decides. A rule for [aria-pressed='true'] placed
       after :hover therefore wins, and the hover tint becomes unreachable.

   The hover tint and the focus ring are the entire affordance: enough to read
   as pressable without impersonating one of the view pills. */
.dvk-expand {
  appearance: none;
  border: none;
  margin: 0 0 0 2px;
  padding: 2px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: calc(var(--dsw-radius-sm, 6px) - 2px);
  color: var(--dsw-alias-label-tertiary, #888);
  background-color: rgb(255 255 255 / 0);
  cursor: pointer;
  font: inherit;
}
.dvk-expand:hover {
  color: var(--dsw-alias-label-primary, #111);
  background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.12));
}
.dvk-expand:focus-visible {
  outline: 1px solid var(--dsw-alias-state-business-primary, #4a7dff);
  outline-offset: 1px;
}
/* Block, so the button's box is exactly the glyph plus its padding. An inline
   SVG sits on a text baseline and adds descender space below it. */
.dvk-expand > svg {
  display: block;
}

/* Enlarged preview.

   A <dialog> shown with showModal() is in the browser's top layer, which is
   the whole reason this is not a hand-built 'position: fixed' overlay: a fixed
   element is positioned against its nearest ancestor that creates a containing
   block, and '.dvk-chart { contain: content }' above already does exactly
   that. The top layer escapes ancestor stacking and containing blocks by
   specification, and brings the backdrop, ESC and a focus trap with it.

   Sizing is a viewport share, set by renderers/html.js, not a pixel constant
   here — the same reasoning as maxTableHeight. */
.dvk-modal {
  padding: 0;
  border: 0;
  border-radius: var(--dsw-radius-md, 10px);
  background: var(--dsw-alias-bg-base, #fff);
  color: var(--dsw-alias-text-primary, #111);
  /* 86% of the viewport: room for the title bar and a strip of the page behind,
     so it reads as an overlay rather than a takeover. */
  width: min(1180px, 94vw);
  max-width: 94vw;
  max-height: 86vh;
  overflow: hidden;
}
.dvk-modal::backdrop {
  background: rgb(0 0 0 / 45%);
}
.dvk-modal__bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 10px 8px 14px;
  border-bottom: 1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.2));
  font: 12px/20px var(--dsw-font-family, system-ui, sans-serif);
}
.dvk-modal__title {
  color: var(--dsw-alias-label-secondary, #555);
  font-weight: 600;
}
.dvk-modal__close {
  appearance: none;
  border: 0;
  border-radius: var(--dsw-radius-sm, 6px);
  padding: 2px 8px;
  font: 12px/20px var(--dsw-font-family, system-ui, sans-serif);
  color: var(--dsw-alias-label-secondary, #555);
  background: transparent;
  cursor: pointer;
}
.dvk-modal__close:hover {
  color: var(--dsw-alias-label-primary, #111);
  background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.12));
}
.dvk-modal__close:focus-visible {
  outline: 1px solid var(--dsw-alias-state-business-primary, #4a7dff);
  outline-offset: 1px;
}
.dvk-modal__frame {
  display: block;
  width: 100%;
  border: 0;
  /* The height is set inline from the measurement; this only keeps a frame
     that has not been measured yet from collapsing to zero. */
  min-height: 120px;
  background: var(--dsw-alias-bg-base, #fff);
}
`;

//#endregion
//#region src/client/index.js
/**
* dsh-viewer-kit — client half.
*
* Activation order, and why it is this order:
*   1. the Kit, so the seam can negotiate against a populated registry;
*   2. renderers, registered before the seam ever runs;
*   3. styles, so a block discovered in the very first scan is never unstyled;
*   4. the seam, which scans immediately and then observes.
*
* ## What this module is allowed to touch
*
* The client module contract is `factory(require) → exports`
* (`dsh-client-modules/lib/client.js`), so a plugin may rely on exactly three
* things: `require`, the browser globals, and the `ctx` members documented for
* `apply`. That list is short on purpose:
*
*   - `ctx.get(name)`  — the sanctioned accessor; **`ctx.anythingElse` throws**
*   - `ctx.effect(fn)` — `fn` performs setup and **returns** the disposer
*
* Both mistakes have already cost this plugin a renderer-side boot crash: an
* undocumented `ctx.MutationObserver` read threw, and passing a finished
* disposer to `ctx.effect` tore the plugin down the instant it activated.
* `tests/repro-activation.mjs` runs the built bundle against a strict context
* that reproduces both, and `pnpm test` runs it.
*
* @module client
*/
const NAMESPACE = "dsh-viewer-kit";
const VERSION = "0.9.0";
/**
* Handle to the live activation, so a second `apply` can retire the first.
* See the guard inside `apply`.
*/
const LIVE_HANDLE = "__DSH_VIEWER_KIT_DISPOSE__";
/**
* Handle to the self-check hook, kept in a named constant so disposal can
* check it is deleting its own object and not a newer activation's.
*/
const DIAGNOSTIC_HANDLE = "__DSH_VIEWER_KIT__";
/**
* Every renderer the kit ships with, in one place.
*
* Adding a renderer is exactly this: a new factory in `renderers/`, and one
* more line here. Nothing else in the package changes — that is the whole
* point of the layering in docs/01-architecture.md §4.
*
* `echarts` is also the one renderer that is not self-contained: it needs the
* engine in `chunks/`, which costs a build-config entry and a chunk request
* rather than nothing. That is still one file plus one line, and it is the
* honest cost of not making every user download a chart engine.
*/
const RENDERER_FACTORIES = [
	createEChartsRenderer,
	createHtmlRenderer,
	createTableRenderer
];
/**
* Hard dependencies. The kit needs none of the host services: it is pure DOM
* plus the two `ctx` members above. `locale` is used opportunistically when
* the host has one.
*/
const inject = [];
/**
* Set at bundle-evaluation time, before anything can call `apply`.
*
* DSH's client module system is lazy: evaluating this file registers a factory,
* and `apply` may never be invoked. Without this marker two very different
* failures look identical from the console — `__DSH_VIEWER_KIT__` undefined
* either way.
*
*   marker absent,  hook absent  → the bundle never reached the web boot graph
*   marker present, hook absent  → the bundle ran but `apply` threw (this is
*                                  what makes the boot audit fail and crash DSH)
*   both present                 → live; `diagnose()` says why nothing rendered
*/
globalThis.__DSH_VIEWER_KIT_BOOTED__ = VERSION;
/**
* @param {{
*   get: (name: string) => unknown,
*   effect: (callback: () => unknown, label?: string) => unknown,
* }} ctx
* @param {Record<string, unknown>} [rowConfig]
*   Unused, and deliberately so. The boot wire carries no config: `graphRow()`
*   in `dsh-client-modules` emits `{id, url, rev, inject?, immediately?,
*   external?}` and `parseBootManifest()` reads back exactly those fields, so
*   this parameter is always `undefined`. Configuration arrives from the host
*   half over `GET /dsh-viewer-kit/config` instead — see `host-config.js`. The
*   parameter is kept because it is the documented hook signature.
*
* @returns {() => void} disposer
*/
function apply(ctx, rowConfig) {
	const doc = globalThis.document;
	const log = globalThis.console;
	if (doc?.body == null) return () => {};
	const previous = globalThis[LIVE_HANDLE];
	if (typeof previous === "function") {
		log.log(`[${NAMESPACE}] retiring the previous activation first`);
		try {
			previous();
		} catch (error) {
			log.error(`[${NAMESPACE}] the previous activation did not retire cleanly`, error);
		}
	}
	const translator = createTranslator(ctx);
	const t = translator.t;
	/** @type {(() => void)[]} */
	const teardown = [];
	let disposed = false;
	const kit = createKit({ onError: (error, context) => {
		log.error(`[${NAMESPACE}] ${context.rendererId} failed on ${context.requestId}`, error);
	} });
	teardown.push(...RENDERER_FACTORIES.map((factory) => kit.register(factory(t))));
	log.log(`[${NAMESPACE}] renderers: ${kit.renderers().map((renderer) => renderer.id).join(", ")}`);
	teardown.push(installStyles(doc));
	teardown.push(translator.dispose);
	const report = (settings, source) => {
		log.log(`[${NAMESPACE}] config: default view=${settings.defaultToPreview ? "preview" : "code"}, html scripts=${settings.htmlAllowScripts ? "on" : "off"}, max preview height=${settings.maxPreviewHeight}px, chart height=${settings.chartHeight}px` + (settings.disabledRendererIds.length > 0 ? `, disabled renderers=${settings.disabledRendererIds.join(",")}` : "") + ` (from ${source})`);
	};
	/**
	* Build the seam and scan, once the settings are known.
	*
	* Nothing is observed before this runs — `createDomSeam` attaches its
	* MutationObserver at construction, so constructing it early would let a
	* block be negotiated with default settings and then disagree with the
	* settings that arrive a moment later. Deferring the whole seam is what
	* makes the first render the final one.
	*
	* @param {{ config: Record<string, any>, source: string, reason?: string }} loaded
	*/
	const start = (loaded) => {
		if (disposed) return;
		kit.setConfig(loaded.config);
		const settings = kit.config();
		report(settings, loaded.source === "host" ? "host" : `defaults, ${loaded.reason ?? "no host config"}`);
		const seam = createDomSeam({
			kit,
			t,
			document: doc,
			root: doc.body,
			MutationObserver: globalThis.MutationObserver
		});
		seam.scan();
		teardown.push(() => seam.dispose());
		globalThis[DIAGNOSTIC_HANDLE] = {
			version: VERSION,
			kit,
			seam,
			configSource: loaded.source,
			stats: () => ({
				...kit.stats(),
				live: seam.size()
			}),
			diagnose: () => ({
				version: VERSION,
				renderers: kit.renderers().map((r) => r.id),
				configSource: loaded.source,
				...seam.diagnose()
			})
		};
		teardown.push(() => {
			if (globalThis[DIAGNOSTIC_HANDLE]?.version === VERSION) delete globalThis[DIAGNOSTIC_HANDLE];
		});
		log.log(`[${NAMESPACE}] v${VERSION} active — ${seam.size()} code block(s) enhanced`);
	};
	if (rowConfig != null && typeof rowConfig === "object") start({
		config: resolveConfig(rowConfig),
		source: "row"
	});
	else {
		log.log(`[${NAMESPACE}] waiting for the host config route`);
		loadHostConfig().then(start, (error) => {
			log.error(`[${NAMESPACE}] config loading failed`, error);
			start({
				config: resolveConfig(void 0),
				source: "defaults",
				reason: "loader threw"
			});
		});
	}
	const dispose = () => {
		if (disposed) return;
		disposed = true;
		for (const step of teardown.reverse()) try {
			step();
		} catch (error) {
			log.error(`[${NAMESPACE}] cleanup step failed`, error);
		}
		if (globalThis[LIVE_HANDLE] === dispose) delete globalThis[LIVE_HANDLE];
	};
	globalThis[LIVE_HANDLE] = dispose;
	ctx.effect(() => dispose, `${NAMESPACE}: dispose`);
	return dispose;
}

//#endregion
exports.apply = apply;
exports.inject = inject;
  return module.exports;
}
});