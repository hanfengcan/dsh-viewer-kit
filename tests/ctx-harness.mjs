/**
 * A faithful client-plugin activation harness.
 *
 * The point of this file is to be **strict where the real runtime is strict**,
 * because a permissive stub is exactly how the first version of this plugin
 * passed its own tests and still crashed the product:
 *
 *   - `ctx` is a proxy. Only the documented members resolve; reading anything
 *     else throws, which is what a real cordis Context does and what the
 *     client builtin list means by "prefer `ctx.get(name)` with an undefined
 *     check".
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

/** The documented `ctx` surface. Anything else must go through `get`. */
const CTX_MEMBERS = new Set(['get', 'effect', 'on', 'provide', 'set', 'start', 'stop'])

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
    console: {
      log: (...values) => harness.log.push(values.join(' ')),
      error: (...values) => harness.log.push(`ERROR ${values.join(' ')}`),
    },
  })

  vm.runInContext(bundleSource, sandbox, { filename: 'client/client.js' })

  /** @type {{ ok: boolean, error?: Error }} */
  const applied = { ok: false }
  try {
    loaded?.apply(harness.ctx)
    applied.ok = true
  } catch (error) {
    applied.error = /** @type {Error} */ (error)
  }

  return {
    ...harness,
    loaded,
    applied,
    sandbox,
    switches: env.document.querySelectorAll('[data-dvk-switch]').length,
    hook: vm.runInContext('typeof globalThis.__DSH_VIEWER_KIT__', sandbox),
    bootMarker: vm.runInContext('typeof globalThis.__DSH_VIEWER_KIT_BOOTED__', sandbox),
    /** Run every registered effect disposer, newest first — what unload does. */
    unload() {
      for (const effect of [...harness.effects].reverse()) effect.dispose()
    },
  }
}
