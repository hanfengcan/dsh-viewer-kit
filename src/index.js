/**
 * dsh-viewer-kit — host half.
 *
 * The kit is entirely a browser concern, so this half contributes no Host
 * behaviour. It exists for one reason: a Loader row has to resolve to a module
 * that exports `apply`, and the row is what makes DSH scan the package's
 * `dsh.client` declaration and serve `client/client.js` to the browser.
 *
 * That indirection is also the extension point: when a future version adds a
 * `viewer_render` tool (docs/01-architecture.md §7.2), it is added here without
 * the client half noticing.
 *
 * @module host
 */

/**
 * @param {object} _ctx Cordis host context. Unused in v0.
 * @returns {void}
 */
export function apply(_ctx) {
  // No Host-side behaviour. See the module comment.
}
