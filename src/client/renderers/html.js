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
const FRAME_PADDING = 72

/**
 * Slack applied to the estimate.
 *
 * An estimate that is too tall costs a little empty space; one that is too
 * short puts a scrollbar on content that nearly fits, which is the complaint
 * this was written to answer. Those are not equally annoying, so the number is
 * deliberately biased upward. It is a bias, not a measurement — see the note on
 * `estimateHeight` for why a real measurement is not available here.
 */
const SAFETY_FACTOR = 1.15

/**
 * The default body margin a previewed document brings with it.
 *
 * The frame deliberately does NOT reset the document's own styles — the author
 * wrote those, and rewriting them would mean the preview shows something other
 * than what the HTML says. But the browser's default 8px top and bottom margin
 * is real height, and leaving it out of the estimate is what makes a document
 * that fits produce a scrollbar anyway: the frame comes out 16px short.
 */
const BROWSER_BODY_MARGIN = 16
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

  const total = Math.round((body + headingTotal + FRAME_PADDING + BROWSER_BODY_MARGIN) * SAFETY_FACTOR)
  // The cap is the only bound: `FRAME_PADDING` already keeps an empty document
  // from collapsing to a sliver, so a separate floor would be dead code — and a
  // dead constant is worse than none, because it reads as a guarantee.
  return Math.min(cap, total)
}

/**
 * Encode a document for safe transport inside a `<script>` in another srcdoc.
 *
 * Base64 rather than a quoted JSON string: the model's HTML can contain
 * `</script>`, and the HTML parser ends the script element on that text even
 * when it sits inside a JavaScript string literal. Base64's alphabet
 * (`A-Za-z0-9+/=`) cannot terminate anything, so this needs no escaping rules
 * to be right — and "needs no escaping rules" is the only kind of injection
 * defence worth having here.
 *
 * @param {string} text
 * @returns {string}
 */
function toBase64(text) {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

/**
 * Height the frame keeps until a measurement arrives.
 *
 * Exported so `tests/run.mjs` can wait exactly this long and assert the
 * fallback rather than guessing at a duration.
 */
export const MEASURE_TIMEOUT_MS = 600

/**
 * Build the two-frame document that measures its own content.
 *
 * ## Why two frames
 *
 * An `<iframe>` is a replaced element: its height never derives from the
 * document inside it, so `max-height` alone only ever limits the 150px default
 * and a "short content shows fully, long content scrolls" frame cannot be
 * expressed in CSS at all. The height has to be measured, and measuring needs
 * script access to the inner document.
 *
 * The two sandbox attributes are what make that safe, and they only work
 * together:
 *
 *   - the OUTER frame has `allow-scripts` and NOT `allow-same-origin`, so its
 *     origin is opaque — it runs our measuring code but can reach nothing of
 *     the host's;
 *   - the INNER frame has `allow-same-origin` and NOT `allow-scripts`, so it
 *     inherits the outer's opaque origin (making it readable by the measuring
 *     script) while the MODEL'S OWN SCRIPTS STAY BLOCKED BY THE SANDBOX — not
 *     by a policy that could be argued with.
 *
 * The net isolation is the same as the single `sandbox=""` frame it replaces:
 * no host DOM, no host storage, no credentialed requests. What it adds is a
 * number.
 *
 * @param {string} source
 * @param {string} frameId
 * @param {number} initialHeight
 * @returns {string}
 */
function buildMeasuringDocument(source, frameId, initialHeight) {
  const payload = toBase64(source)
  return `<!doctype html><meta charset="utf-8">
<style>
  html,body{margin:0;padding:0;overflow:hidden;background:transparent}
  iframe{display:block;width:100%;border:0;height:0}
</style>
<iframe id="dvk-inner" sandbox="allow-same-origin"></iframe>
<script>
(function () {
  var inner = document.getElementById('dvk-inner');
  var last = -1;
  function measure() {
    var doc;
    try { doc = inner.contentDocument } catch (e) { return }
    if (!doc || !doc.documentElement) return;
    // scrollHeight is the CONTENT's height and does not depend on the frame's
    // own viewport, which is what lets the frame be sized from it without a
    // feedback loop. The inner stays at height 0 until a number is known.
    var h = Math.max(doc.documentElement.scrollHeight, doc.body ? doc.body.scrollHeight : 0);
    if (!h || h === last) return;
    last = h;
    inner.style.height = h + 'px';
    try { parent.postMessage({ __dvk: 'height', id: ${JSON.stringify(frameId)}, height: h }, '*') } catch (e) {}
  }
  inner.addEventListener('load', function () {
    measure();
    // Images and webfonts land after the load event and change the height; a
    // couple of follow-ups catch them without polling forever.
    setTimeout(measure, 60);
    setTimeout(measure, 300);
    try { new ResizeObserver(measure).observe(inner.contentDocument.documentElement) } catch (e) {}
  });
  var bytes = atob(${JSON.stringify(payload)});
  var buf = new Uint8Array(bytes.length);
  for (var i = 0; i < bytes.length; i++) buf[i] = bytes.charCodeAt(i);
  inner.srcdoc = new TextDecoder().decode(buf);
  document.documentElement.style.height = ${JSON.stringify(String(initialHeight))} + 'px';
})();
</` + `script>`
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
      // The measuring frame reports by `postMessage`, so the listener belongs to
      // the window. Taken from the document rather than `globalThis` so this is
      // driveable under a plain DOM shim in Node, where no global event target
      // exists — the seam tests run the source directly, not in a browser.
      const view = /** @type {any} */ (doc).defaultView ?? globalThis

      /** @type {HTMLIFrameElement | null} */
      let frame = null
      /** Identifies this frame's measurement messages; only ever compared. */
      const frameId = `dvk-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`
      /**
       * The frame's current height, so a late measurement can be ignored once
       * the surface is gone and so the fallback can be told from a real result.
       */
      let measured = false

      /** @param {MessageEvent} event */
      const onMessage = (event) => {
        if (frame === null) return
        // Validate by SOURCE, not origin: the sender is an opaque-origin frame,
        // so `event.origin` is the string "null" and says nothing. Comparing
        // the window identifies exactly the frame this surface created.
        if (event.source !== frame.contentWindow) return
        const data = /** @type {any} */ (event.data)
        if (data == null || data.__dvk !== 'height' || data.id !== frameId) return
        const height = Number(data.height)
        if (!Number.isFinite(height) || height <= 0) return
        measured = true
        frame.style.height = `${Math.min(limits.maxPreviewHeight, Math.ceil(height))}px`
      }

      const destroyFrame = () => {
        // Dropping the node also drops the browsing context, which is what
        // actually stops any timer or animation the preview started.
        frame?.remove()
        frame = null
        view.removeEventListener?.('message', onMessage)
      }

      const mountFrame = () => {
        if (frame !== null) return
        const mode = config.previewHeightMode
        frame = doc.createElement('iframe')
        frame.className = 'dvk-frame'
        frame.title = t('html.frameTitle', 'HTML preview')
        // Set as an attribute rather than only as a property: the attribute is
        // what the sandbox and any DOM audit actually reads.
        frame.setAttribute('referrerpolicy', 'no-referrer')

        const estimated = estimateHeight(request.source, limits.maxPreviewHeight)
        const initial = mode === 'fixed' ? limits.maxPreviewHeight : estimated

        if (mode === 'measure') {
          // `allow-scripts` here is for the MEASURING script only; the model's
          // document lives in an inner frame that has no `allow-scripts`, so its
          // own scripts stay blocked by the sandbox. `allow-same-origin` is
          // deliberately absent from this frame — that is what keeps the inner
          // document's origin opaque and therefore unable to reach the host.
          frame.setAttribute('sandbox', 'allow-scripts')
          // Start at the estimate so the frame is never a zero-height sliver
          // while the measurement is in flight.
          frame.style.height = `${initial}px`
          frame.srcdoc = buildMeasuringDocument(request.source, frameId, initial)
          view.addEventListener?.('message', onMessage)
        } else {
          // No measuring frame, so no script permission is needed at all: the
          // single frame keeps the same `sandbox=""` it always had, and
          // `htmlAllowScripts` is the only thing that can widen it for the
          // model's own scripts.
          frame.setAttribute('sandbox', config.htmlAllowScripts ? 'allow-scripts' : '')
          frame.style.height = `${initial}px`
          frame.srcdoc = withCharset(request.source)
        }

        mount(frame)

        if (mode === 'measure') {
          // The estimate is a fallback, not the answer. This exists so a
          // measurement that never arrives leaves the frame at the computed
          // height rather than a blank strip — the failure mode of a silent
          // measurement is "slightly wrong height", never "no preview".
          setTimeout(() => {
            if (!measured && frame !== null) frame.style.height = `${estimated}px`
          }, MEASURE_TIMEOUT_MS)
        }
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
