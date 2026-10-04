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

/**
 * How much of the viewport height an enlarged preview may occupy.
 *
 * 0.86 leaves room for the dialog's own title bar plus a strip of the page
 * behind it, so the reader can still see they are inside a conversation. It is
 * a share of the viewport rather than a pixel count because a fixed number is
 * wrong on every screen but the one it was chosen on.
 */
const DIALOG_VIEWPORT_FRACTION = 0.86

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
 * short puts a scrollbar on content that nearly fits. Those are not equally
 * annoying, so the number is deliberately biased upward. It is a bias, not a
 * measurement — see the note on `estimateHeight` for why a real measurement is
 * not available here.
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
 * Height the frame keeps until a measurement arrives.
 *
 * Exported so `tests/run.mjs` can wait exactly this long and assert the
 * fallback rather than guessing at a duration.
 */
export const MEASURE_TIMEOUT_MS = 600

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
export function buildMeasuredDocument(source, frameId, nonce, allowScripts) {
  const policy = allowScripts
    ? ''
    : `<meta http-equiv="Content-Security-Policy" content="script-src 'nonce-${nonce}'">`
  return `<!doctype html><meta charset="utf-8">${policy}
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
       * Authorises the measuring script and nothing else.
       *
       * The model's markup is fixed before this is generated, so it cannot know
       * the value; a CSP nonce only has to be unguessable, not secret from the
       * browser. `crypto.randomUUID` needs a secure context, which `dsh-app://`
       * is registered as, hence the fallback.
       */
      const nonce = globalThis.crypto?.randomUUID?.() ?? `${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`
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
          // `allow-scripts` is needed because the measuring script IS the
          // document — it reports its own content height, which is what removes
          // the cross-origin problem the two-frame version could not solve.
          // `allow-same-origin` is deliberately absent: the opaque origin is
          // what bounds anything the model's markup could do, and the nonce
          // policy below is what stops its scripts from running at all.
          frame.setAttribute('sandbox', 'allow-scripts')
          // Start at the estimate so the frame is never a zero-height sliver
          // while the measurement is in flight, and so a measurement that never
          // arrives leaves a sane height rather than a blank strip.
          frame.style.height = `${initial}px`
          frame.srcdoc = buildMeasuredDocument(request.source, frameId, nonce, config.htmlAllowScripts)
          view.addEventListener?.('message', onMessage)
        } else {
          // No measuring script, so no script permission is needed at all: the
          // frame keeps the same `sandbox=""` it always had, and
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

      /**
       * The enlarged view, or null when it is closed.
       *
       * @type {HTMLDialogElement | null}
       */
      let dialog = null
      /** @type {HTMLIFrameElement | null} */
      let dialogFrame = null
      /** @type {(() => void) | null} */
      let releaseDialogListener = null

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
      const expandListeners = new Set()

      const notifyExpand = () => {
        for (const listener of [...expandListeners]) {
          try {
            listener()
          } catch {
            /* a listener that throws must not strand the dialog */
          }
        }
      }

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
        const viewport = /** @type {any} */ (view).innerHeight
        const pixels = Number(viewport)
        // `innerHeight` is 0 in a headless shim and absent on odd hosts; fall
        // back to a tall-but-finite number rather than dividing the document
        // by zero or producing a zero-height frame.
        if (!Number.isFinite(pixels) || pixels <= 0) return 1600
        return Math.round(pixels * DIALOG_VIEWPORT_FRACTION)
      }

      const closeDialog = () => {
        releaseDialogListener?.()
        releaseDialogListener = null
        dialogFrame = null
        const open = dialog
        // Cleared first so a re-entrant call is a no-op rather than a double
        // remove — and it IS re-entrant: `open.close()` below fires the same
        // `close` event this function is registered for. The early return is
        // therefore also the "was anything actually open" test; reading the
        // element's own `open` flag instead would be wrong, because on the ESC
        // path the browser has already cleared it before firing the event.
        dialog = null
        if (open === null) return
        try {
          // Release the top layer first. Removing a still-open <dialog> node
          // leaves it registered as a modal in some hosts, and the page behind
          // stays inert — which looks like the app froze.
          open.close?.()
        } catch {
          /* ignore */
        }
        try {
          // Dropping the node drops the browsing context, which is what actually
          // stops any timer or animation the enlarged document started.
          open.remove()
        } catch {
          /* ignore */
        }
        notifyExpand()
      }

      const openDialog = () => {
        if (dialog !== null) return
        dialog = doc.createElement('dialog')
        dialog.className = 'dvk-modal'
        dialog.setAttribute('data-dvk-modal', 'true')
        // No `aria-modal` on a <dialog>: the element already has the role, and
        // adding it by hand is how a dialog ends up announced twice.
        dialog.setAttribute('aria-label', t('html.modalTitle', 'HTML preview'))

        const bar = doc.createElement('div')
        bar.className = 'dvk-modal__bar'

        const title = doc.createElement('span')
        title.className = 'dvk-modal__title'
        title.textContent = t('html.modalTitle', 'HTML preview')
        bar.appendChild(title)

        const close = doc.createElement('button')
        close.type = 'button'
        close.className = 'dvk-modal__close'
        close.setAttribute('data-dvk-modal-close', 'true')
        close.setAttribute('aria-label', t('html.modalClose', 'Close'))
        close.textContent = '✕'
        close.addEventListener('click', closeDialog)
        bar.appendChild(close)

        dialogFrame = doc.createElement('iframe')
        dialogFrame.className = 'dvk-modal__frame'
        dialogFrame.title = t('html.frameTitle', 'HTML preview')
        dialogFrame.setAttribute('referrerpolicy', 'no-referrer')
        // The same two layers as the inline frame, in the same order: opaque
        // origin always, and — because the enlarged frame is measured — a
        // policy that authorises the measuring script and nothing else. The
        // model's own scripts are refused here exactly as they are inline.
        dialogFrame.setAttribute('sandbox', config.previewHeightMode === 'measure' ? 'allow-scripts' : config.htmlAllowScripts ? 'allow-scripts' : '')
        const cap = dialogCap()
        dialogFrame.style.height = `${Math.min(cap, estimateHeight(request.source, cap))}px`
        dialogFrame.srcdoc =
          config.previewHeightMode === 'measure'
            ? buildMeasuredDocument(request.source, frameId, nonce, config.htmlAllowScripts)
            : withCharset(request.source)

        dialog.appendChild(bar)
        dialog.appendChild(dialogFrame)

        // `document.body`, NOT the block's view root. Two reasons, both
        // load-bearing: the view root is emptied on every view switch, and the
        // conversation is virtualised, so a node inside a message can be
        // removed while the reader is still looking at the enlarged document.
        doc.body.appendChild(dialog)

        // Measuring reports through the same channel the inline frame uses, so
        // the handler is the same function with a different target.
        const onModalMessage = (event) => {
          if (dialogFrame === null) return
          if (event.source !== dialogFrame.contentWindow) return
          const data = /** @type {any} */ (event.data)
          if (data == null || data.__dvk !== 'height' || data.id !== frameId) return
          const height = Number(data.height)
          if (!Number.isFinite(height) || height <= 0) return
          dialogFrame.style.height = `${Math.min(cap, Math.ceil(height))}px`
        }
        view.addEventListener?.('message', onModalMessage)
        releaseDialogListener = () => view.removeEventListener?.('message', onModalMessage)

        // The reader can dismiss this three ways — the ✕ button, ESC, or a
        // backdrop click — and only the first one calls `closeDialog`. Without
        // this, ESC and the backdrop would leave the node in the document with
        // `open === false` and, worse, leave the enlarge button stuck in its
        // pressed styling describing a dialog that is already gone.
        dialog.addEventListener('close', closeDialog)

        // `showModal()` puts the element in the browser's **top layer**, which
        // is the only reason a hand-built overlay was not needed: a
        // `position: fixed` element is positioned against its nearest ancestor
        // that creates a containing block, and this plugin's own
        // `.dvk-chart { contain: content }` already does that. The top layer
        // escapes ancestor stacking and containing blocks by specification.
        // It also brings the backdrop, the ESC key and a focus trap for free.
        if (typeof dialog.showModal === 'function') dialog.showModal()
        notifyExpand()
      }

      return {
        views: [{ id: 'preview', label: LANGS[request.lang] ?? 'Preview' }],

        expand: {
          // Deliberately NO `available()`. The table implements one because a
          // table shorter than its cap is not clipped, so lifting the cap paints
          // no different pixel. Here the action always changes the presentation:
          // a 320px frame becomes a dialog sized to the viewport, which is a
          // different surface even for a document that already fitted. Gating on
          // an estimated height would hide the control for exactly the short
          // reports a reader most wants to see whole.
          toggle: () => {
            if (dialog === null) openDialog()
            else closeDialog()
          },
          isOn: () => dialog !== null,
          subscribe: (listener) => {
            expandListeners.add(listener)
            return () => expandListeners.delete(listener)
          },
        },

        enter(viewId) {
          if (viewId === 'code') {
            destroyFrame()
            return
          }
          mountFrame()
        },

        dispose() {
          // The dialog is not a child of the view root — it cannot be, because
          // the view root is emptied on every view switch — so this is the only
          // thing standing between a scrolled-away block and a dialog left
          // covering the whole app.
          closeDialog()
          expandListeners.clear()
          destroyFrame()
        },
      }
    },
  }
}
