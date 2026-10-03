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
   needs no sandbox; the caps that keep a pathological payload from stretching
   the conversation live in renderers/table.js, not here. */
.dvk-table-summary {
  margin: 0 0 8px;
  color: var(--dsw-alias-label-tertiary, #888);
  font: 11px/18px var(--dsw-font-family, system-ui, sans-serif);
}
.dvk-table-wrap {
  max-height: inherit;
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
`

