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

/** Vertical padding a rendered document has around its content. */
const FRAME_PADDING = 48

/** Tallest and shortest frame worth showing, before the user's cap applies. */
const MIN_FRAME = 96
const MAX_FRAME_FLOOR = 1600

/** Block-level tags: each one starts a new visual line. */
const BLOCK_TAG = /<\/?(?:p|div|section|article|header|footer|main|aside|nav|ul|ol|li|dl|dt|dd|table|thead|tbody|tfoot|tr|td|th|blockquote|pre|figure|figcaption|form|fieldset|h[1-6]|address)\b[^>]*>/gi
/** Hard line breaks and rules. */
const BREAK_TAG = /<(?:br|hr)\s*\/?>/gi
/** Headings render taller than a body line; index 0 is unused. */
/** @type {number[]} */
const HEADING_HEIGHT = [0, 52, 44, 38, 34, 32, 30]

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
export function estimateHeight(source, cap) {
  /** @type {string[]} */
  const headings = source.match(/<h[1-6]\b[^>]*>/gi) ?? []
  const headingTotal = headings.reduce((sum, tag) => sum + (HEADING_HEIGHT[Number(tag[2])] ?? 32), 0)

  const visible = source
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<head[\s\S]*?<\/head>/gi, '')
    .replace(/<!doctype[^>]*>/gi, '')
    .replace(/<title[\s\S]*?<\/title>/gi, '')
    .replace(BREAK_TAG, '\n')
    .replace(BLOCK_TAG, '\n')
    .replace(/<[^>]+>/g, '')

  // A body line is ~24px at the 16px the samples use; long paragraphs wrap, so
  // the width of the text matters more than the number of source lines.
  const text = visible.replace(/&nbsp;/g, ' ').trim()
  const lines = text === '' ? [] : text.split('\n')
  let body = 0
  for (const line of lines) {
    const content = line.trim()
    if (content === '') continue
    // ~72 characters per line at a 16px base in a ~600px column.
    body += 24 * Math.max(1, Math.ceil(content.length / 72))
  }

  const total = body + headingTotal + FRAME_PADDING
  // The user's cap is honoured even when it is below the floor: someone who
  // sets `maxPreviewHeight: 40` is asking for a 40px frame, and quietly giving
  // them 96px would make the setting a lie.
  if (cap < MIN_FRAME) return cap
  return Math.min(cap, Math.max(MIN_FRAME, total))
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
