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

import { createDomSeam } from './dom-seam.js'
import { createEChartsRenderer } from './renderers/echarts.js'
import { createHtmlRenderer } from './renderers/html.js'
import { createKit } from './kit.js'
import { createTableRenderer } from './renderers/table.js'
import { createTranslator } from './locale.js'
import { installStyles } from './styles.js'

const NAMESPACE = 'dsh-viewer-kit'
const VERSION = '0.7.0'

/**
 * Handle to the live activation, so a second `apply` can retire the first.
 * See the guard inside `apply`.
 */
const LIVE_HANDLE = '__DSH_VIEWER_KIT_DISPOSE__'

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
const RENDERER_FACTORIES = [createEChartsRenderer, createHtmlRenderer, createTableRenderer]

/**
 * Hard dependencies. The kit needs none of the host services: it is pure DOM
 * plus the two `ctx` members above. `locale` is used opportunistically when
 * the host has one.
 */
export const inject = []

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
globalThis.__DSH_VIEWER_KIT_BOOTED__ = VERSION

/**
 * @param {{
 *   get: (name: string) => unknown,
 *   effect: (callback: () => unknown, label?: string) => unknown,
 * }} ctx
 * @param {Partial<import('./contract.js').ViewerKitConfig>} [rowConfig]
 *   The loader row's `config` block, verbatim.
 *
 *   Cordis only validates against a `Config` schema when the plugin exports
 *   one (`resolveConfig` in `@deepseek-ai/cordis`: `if (!runtime.Config) return
 *   config`), and this half deliberately exports none — importing schemastery
 *   into a client bundle would have to resolve through the module seed table.
 *   So the row config arrives unvalidated and goes through `resolveConfig`,
 *   which drops unknown keys and type-checks every value against the defaults.
 *   A malformed config therefore degrades to defaults instead of failing the
 *   entry, which matters: a failed entry is a failed web boot.
 *
 * @returns {() => void} disposer
 */
export function apply(ctx, rowConfig) {
  const doc = globalThis.document
  const log = globalThis.console
  if (doc?.body == null) {
    // The shell has not mounted yet; there is nothing to enhance.
    return () => {}
  }

  const previous = globalThis[LIVE_HANDLE]
  if (typeof previous === 'function') {
    // DSH re-materialises a client bundle on HMR and on re-enable, and a
    // rebuild during development is enough to trigger it. Two live activations
    // each build their own seam with their own element bookkeeping, so both
    // would append a view switch to every code block — the row of duplicate
    // buttons this guards against.
    log.log(`[${NAMESPACE}] retiring the previous activation first`)
    try {
      previous()
    } catch (error) {
      log.error(`[${NAMESPACE}] the previous activation did not retire cleanly`, error)
    }
  }

  const translator = createTranslator(ctx)
  const t = translator.t

  /** @type {(() => void)[]} */
  const teardown = []
  let disposed = false

  const kit = createKit({
    onError: (error, context) => {
      log.error(`[${NAMESPACE}] ${context.rendererId} failed on ${context.requestId}`, error)
    },
  })

  // Before anything is registered or negotiated, so the row config governs the
  // very first scan. `resolveConfig` fills every absent key from the defaults.
  kit.setConfig(rowConfig)
  const settings = kit.config()
  log.log(
    `[${NAMESPACE}] config: default view=${settings.defaultToPreview ? 'preview' : 'code'}` +
      `, html scripts=${settings.htmlAllowScripts ? 'on' : 'off'}` +
      `, max preview height=${settings.maxPreviewHeight}px` +
      `, chart height=${settings.chartHeight}px` +
      (settings.disabledRendererIds.length > 0 ? `, disabled renderers=${settings.disabledRendererIds.join(',')}` : ''),
  )

  teardown.push(...RENDERER_FACTORIES.map((factory) => kit.register(factory(t))))
  log.log(`[${NAMESPACE}] renderers: ${kit.renderers().map((renderer) => renderer.id).join(', ')}`)

  teardown.push(installStyles(doc))
  // We own the dictionary registration, so we unregister it ourselves — see
  // the note in locale.js for why parking it on `ctx.effect` crashed DSH.
  teardown.push(translator.dispose)

  const seam = createDomSeam({
    kit,
    t,
    document: doc,
    root: doc.body,
    MutationObserver: globalThis.MutationObserver,
  })
  seam.scan()
  teardown.push(() => seam.dispose())

  // Self-check hook. `diagnose()` is the one command that separates the three
  // ways this can be "installed but not rendering": the client half never
  // loaded, the seam found no code blocks, or it found blocks no renderer
  // claims. `__DSH_VIEWER_KIT__` being undefined means `apply` never finished.
  globalThis.__DSH_VIEWER_KIT__ = {
    version: VERSION,
    kit,
    seam,
    stats: () => ({ ...kit.stats(), live: seam.size() }),
    diagnose: () => ({ version: VERSION, renderers: kit.renderers().map((r) => r.id), ...seam.diagnose() }),
  }
  teardown.push(() => {
    delete globalThis.__DSH_VIEWER_KIT__
  })

  log.log(`[${NAMESPACE}] v${VERSION} active — ${seam.size()} code block(s) enhanced`)

  const dispose = () => {
    if (disposed) return
    disposed = true
    for (const step of teardown.reverse()) {
      try {
        step()
      } catch (error) {
        log.error(`[${NAMESPACE}] cleanup step failed`, error)
      }
    }
    // Only clear the handle if it is still ours — a newer activation may have
    // already replaced it, and clobbering that would strand its seam.
    if (globalThis[LIVE_HANDLE] === dispose) delete globalThis[LIVE_HANDLE]
  }

  globalThis[LIVE_HANDLE] = dispose

  // `ctx.effect` calls this callback NOW and treats its RETURN value as the
  // disposer. Handing it `dispose` directly would run the teardown immediately.
  ctx.effect(() => dispose, `${NAMESPACE}: dispose`)
  return dispose
}
