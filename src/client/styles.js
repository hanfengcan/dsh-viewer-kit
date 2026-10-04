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
const STYLE_MARKER = 'dsh-viewer-kit'

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
export function installStyles(doc) {
  // A previous activation (HMR re-enable) may have left one behind.
  for (const stale of doc.querySelectorAll(`style[data-plugin="${STYLE_MARKER}"]`)) stale.remove()
  const tag = doc.createElement('style')
  tag.setAttribute('data-plugin', STYLE_MARKER)
  tag.setAttribute('data-plugin-css', `${STYLE_MARKER}/styles`)
  tag.textContent = STYLES
  doc.head.appendChild(tag)
  return () => {
    tag.remove()
  }
}

/** @type {string} */
export const STYLES = `
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
`

