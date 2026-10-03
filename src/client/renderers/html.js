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
const LANGS = Object.freeze({ html: 'HTML', svg: 'SVG' })

/** A `<meta charset>` is prepended unless the document declares one. */
function withCharset(source) {
  if (/<meta[^>]+charset\s*=/i.test(source)) return source
  return `<meta charset="utf-8">\n${source}`
}

/**
 * Pick a frame height from the source instead of measuring the document,
 * which a sandboxed frame will not let us observe. Tall sources grow to the
 * cap; short ones get a usable minimum. The document scrolls internally.
 *
 * @param {string} source
 * @param {number} cap
 * @returns {number}
 */
function estimateHeight(source, cap) {
  const lines = source.split('\n').length
  return Math.max(160, Math.min(cap, 140 + lines * 20))
}

/**
 * @param {(key: string, fallback: string) => string} t
 * @returns {import('../contract.js').Renderer}
 */
export function createHtmlRenderer(t) {
  return {
    id: 'html',
    label: 'HTML',
    priority: 10,

    match(request) {
      return request.lang === 'html' || request.lang === 'svg'
    },

    create(host) {
      const { request, limits, document: doc, mount } = host
      const config = host.config()

      /** @type {HTMLIFrameElement | null} */
      let frame = null

      const destroyFrame = () => {
        // Dropping the node also drops the browsing context, which is what
        // actually stops any timer or animation the preview started.
        frame?.remove()
        frame = null
      }

      const mountFrame = () => {
        if (frame !== null) return
        frame = doc.createElement('iframe')
        frame.className = 'dvk-frame'
        frame.title = t('html.frameTitle', 'HTML preview')
        // Set as an attribute rather than only as a property: the attribute is
        // what the sandbox and any DOM audit actually reads.
        frame.setAttribute('referrerpolicy', 'no-referrer')
        // `allow-same-origin` is deliberately absent in every configuration.
        frame.setAttribute('sandbox', config.htmlAllowScripts ? 'allow-scripts' : '')
        frame.style.height = `${estimateHeight(request.source, limits.maxPreviewHeight)}px`
        frame.srcdoc = withCharset(request.source)
        mount(frame)
      }

      return {
        views: [{ id: 'preview', label: LANGS[request.lang] ?? 'Preview' }],

        enter(viewId) {
          if (viewId === 'code') {
            destroyFrame()
            return
          }
          mountFrame()
        },

        dispose() {
          destroyFrame()
        },
      }
    },
  }
}
