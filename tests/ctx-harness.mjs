/**
 * A faithful client-plugin activation harness.
 *
 * The point of this file is to be **strict where the real runtime is strict**,
 * because a permissive stub is exactly how the first version of this plugin
 * passed its own tests and still crashed the product:
 *
 *   - `ctx` is a proxy, and reading an absent member throws — which is what a
 *     real cordis Context does. The harness is deliberately **narrower** than
 *     the real client context, which mixes in 16 members (cordis
 *     `reflect.ts:219-222`: get/set/provide/accessor/mixin, runtime/effect,
 *     inject/plugin, and seven event verbs). It exposes only the four this
 *     plugin is allowed to use, so anything else fails here rather than in the
 *     product. Widening it to match cordis would delete the guard that caught
 *     the `ctx.MutationObserver` crash; the cost is that the harness is a
 *     floor, not a mirror, and a plugin that legitimately needs a fifth member
 *     has to add it deliberately.
 *   - `ctx.effect(callback, label)` runs the callback **immediately** and takes
 *     its **return value** as the disposer — the pattern every shipped and
 *     community client plugin uses.
 *   - `ctx.get('locale')` returns a registry with the real `register`
 *     semantics, including its two throws.
 *   - `document`, `MutationObserver` and `console` come from the sandbox
 *     globals, because `factory(require) → exports` is the whole module
 *     contract and nothing else is handed to a plugin.
 *
 * @module tests/ctx-harness
 */

import vm from 'node:vm'

import { createEnvironment, parseHtml } from './dom-shim.mjs'

/** BCP 47-ish tag check, lifted from the shipped locale registry. */
const LOCALE_ID_PATTERN = /^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-[A-Z]{2}|-\d{3})?$/

/**
 * The shipped locale registry, reduced to what a plugin touches.
 * Both throws are real.
 */
export function createLocaleService() {
  /** @type {Map<string, Map<string, object>>} */
  const dicts = new Map()

  return {
    register(ns, localeOrDicts, dict) {
      const pairs = typeof localeOrDicts === 'string' ? [[localeOrDicts, dict]] : Object.entries(localeOrDicts)
      for (const [locale] of pairs) {
        if (!LOCALE_ID_PATTERN.test(locale)) throw new Error(`locale id "${locale}" is not a BCP 47-style tag`)
      }
      let locales = dicts.get(ns)
      if (locales === undefined) {
        locales = new Map()
        dicts.set(ns, locales)
      }
      for (const [locale] of pairs) {
        if (locales.has(locale)) throw new Error(`locale namespace "${ns}" already has locale "${locale}"`)
      }
      for (const [locale, entries] of pairs) locales.set(locale, entries)
      return () => {
        const owner = dicts.get(ns)
        if (owner === undefined) return
        for (const [locale] of pairs) owner.delete(locale)
      }
    },
    bind: (ns) => (key) => {
      for (const entries of dicts.get(ns)?.values() ?? []) {
        if (entries[key] !== undefined) return entries[key]
      }
      return key
    },
    getSnapshot: () => ({ active: 'zh' }),
    subscribe: () => () => {},
  }
}

/**
 * @param {{
 *   fixtureHtml?: string,
 *   withLocale?: boolean,
 *   services?: Record<string, unknown>,
 * }} [options]
 */
export function createClientContext(options = {}) {
  const env = createEnvironment()
  if (options.fixtureHtml !== undefined) parseHtml(options.fixtureHtml, env.document.body)

  /** @type {Map<string, unknown>} */
  const services = new Map()
  if (options.withLocale !== false) services.set('locale', createLocaleService())
  for (const [name, service] of Object.entries(options.services ?? {})) services.set(name, service)

  /** @type {Array<{ label: string, dispose: () => void }>} */
  const effects = []
  /** @type {string[]} */
  const log = []
  /** @type {string[]} */
  const violations = []

  const base = {
    get: (name) => services.get(name),
    effect(callback, label = 'effect') {
      const disposer = callback()
      if (disposer === undefined) return () => {}
      if (typeof disposer !== 'function') {
        throw new TypeError(`effect(${label}): callback must return a disposer or nothing, got ${typeof disposer}`)
      }
      effects.push({ label, dispose: disposer })
      return disposer
    },
    on: () => () => {},
    provide: () => () => {},
  }

  const ctx = new Proxy(base, {
    get(target, property) {
      if (typeof property === 'symbol') return Reflect.get(target, property)
      if (property in target) return target[property]
      const message = `ctx.${String(property)} is not a service or builtin — use ctx.get("${String(property)}") with an undefined check`
      violations.push(message)
      throw new Error(message)
    },
  })

  return { ctx, env, effects, log, violations, services }
}

/**
 * Evaluate a built bundle, call its `apply`, and report what happened.
 *
 * @param {string} bundleSource
 * @param {{ fixtureHtml?: string, withLocale?: boolean, services?: Record<string, unknown> }} [options]
 */
export function activateBundle(bundleSource, options = {}) {
  const harness = createClientContext(options)
  const { env } = harness

  /** @type {any} */
  let loaded
  const loader = {
    load: (descriptor) => {
      loaded = descriptor.factory(() => ({}))
    },
  }

  const sandbox = vm.createContext({
    window: { __ModuleLoader__: loader },
    document: env.document,
    MutationObserver: env.MutationObserver,
    sessionStorage: env.sessionStorage,
    queueMicrotask,
    setTimeout,
    clearTimeout,
    // Standard web globals the renderer legitimately uses. A `vm` context is
    // bare, so omitting one shows up as a ReferenceError inside `apply` — which
    // reads exactly like a product bug. `TextEncoder` is here because the HTML
    // preview base64-encodes the model's document.
    TextEncoder,
    TextDecoder,
    atob,
    btoa,
    // The client half now asks the host half for its configuration before it
    // scans, so activation is asynchronous. The default is a 404: that is the
    // real behaviour when the host half is not installed, and it exercises the
    // "fall back to defaults" path that most tests want anyway. A test that
    // cares about a specific config passes `hostConfig`.
    fetch: options.fetch ?? (() => Promise.resolve({ ok: false, status: 404 })),
    console: {
      log: (...values) => harness.log.push(values.join(' ')),
      error: (...values) => harness.log.push(`ERROR ${values.join(' ')}`),
    },
  })

  vm.runInContext(bundleSource, sandbox, { filename: 'client/client.js' })

  /** @type {{ ok: boolean, error?: Error }} */
  const applied = { ok: false }
  try {
    // The second argument is the loader row's `config` block. It is always
    // `undefined` in a real browser — the boot wire carries no config — and
    // `hostConfig` is how a test stands in for the host half's HTTP route.
    loaded?.apply(harness.ctx, options.rowConfig)
    applied.ok = true
  } catch (error) {
    applied.error = /** @type {Error} */ (error)
  }

  return {
    ...harness,
    loaded,
    applied,
    sandbox,
    // Getters, not values. Activation is now asynchronous — the seam is built
    // after the config request settles — so a snapshot taken at return time is
    // always the pre-scan state and every assertion on it fails. Read through
    // these and they answer "what is true now", which is what a test means.
    get switches() {
      return env.document.querySelectorAll('[data-dvk-switch]').length
    },
    get hook() {
      return vm.runInContext('typeof globalThis.__DSH_VIEWER_KIT__', sandbox)
    },
    bootMarker: vm.runInContext('typeof globalThis.__DSH_VIEWER_KIT_BOOTED__', sandbox),
    /** The live hook object, for asserting on config-driven behaviour. */
    live: () => vm.runInContext('globalThis.__DSH_VIEWER_KIT__ ?? null', sandbox),
    /** Which view the fixture block is currently showing. */
    mode: () => env.document.querySelector('[data-code-block-content]')?.getAttribute('data-dvk-mode') ?? null,
    /**
     * Wait for activation to finish.
     *
     * `apply` returns as soon as it has registered its renderers; the seam is
     * built only after the config request settles, so anything that asserts on
     * a switch, a mounted preview, or the diagnostic hook has to await this
     * first. Bounded so a bug that never starts the seam fails the assertion
     * rather than hanging the suite.
     */
    async whenReady(ticks = 50) {
      for (let attempt = 0; attempt < ticks; attempt++) {
        if (vm.runInContext('globalThis.__DSH_VIEWER_KIT__ != null', sandbox) === true) return true
        await new Promise((done) => setTimeout(done, 0))
      }
      return false
    },
    /** Run every registered effect disposer, newest first — what unload does. */
    unload() {
      for (const effect of [...harness.effects].reverse()) effect.dispose()
    },
  }
}
