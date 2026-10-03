/**
 * The test suite.
 *
 * Two halves:
 *   1. the core (Kit, view state, contract) under plain Node with no DOM at
 *      all — proving L4 really is DOM-free;
 *   2. the seam and the surface driven by fixtures copied from DSH's real
 *      markup, through the shim in `dom-shim.mjs`;
 *   3. the BUILT bundle executed under a stub `__ModuleLoader__`, so what is
 *      tested is the artifact DSH actually serves, not just the sources.
 *
 * @module tests/run
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

import { ShimStorage, createEnvironment, parseHtml } from './dom-shim.mjs'
import { HTML_SAMPLE, PYTHON_SAMPLE, codeBlockFixture, conversationFixture } from './fixtures.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

let passed = 0
/** @type {string[]} */
const failures = []

/**
 * @param {string} name
 * @param {() => void | Promise<void>} body
 */
async function test(name, body) {
  try {
    await body()
    passed += 1
    process.stdout.write(`  ok   ${name}\n`)
  } catch (error) {
    failures.push(`${name}: ${error?.message ?? error}`)
    process.stdout.write(`  FAIL ${name}\n       ${error?.message ?? error}\n`)
  }
}

/** @param {unknown} condition @param {string} message */
function assert(condition, message) {
  if (!condition) throw new Error(message)
}

/**
 * Project a value into something `JSON.stringify` can survive. DOM nodes are
 * circular (element → ownerDocument → observation → element), so they are
 * summarised structurally instead — which is also a better failure message.
 *
 * @param {unknown} value
 * @returns {unknown}
 */
function plain(value) {
  if (value == null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(plain)
  if (value.nodeType === 1) {
    return {
      tag: value.tagName,
      class: value.className,
      attrs: Object.fromEntries([...value.attrs].map(([k, v]) => [k, v])),
      text: value.textContent,
      children: value.children.map(plain),
    }
  }
  if (value instanceof Map) return Object.fromEntries([...value].map(([k, v]) => [k, plain(v)]))
  return value
}

/** @param {unknown} actual @param {unknown} expected @param {string} message */
function eq(actual, expected, message) {
  const a = JSON.stringify(plain(actual))
  const b = JSON.stringify(plain(expected))
  if (a !== b) throw new Error(`${message}\n       expected ${b}\n       actual   ${a}`)
}

const tick = () => new Promise((done) => setTimeout(done, 0))
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

/**
 * Read the frame id out of a generated preview document.
 *
 * The id is what the measuring frame echoes back, and it is generated per
 * surface, so a test has to read it from the document rather than construct it.
 *
 * @param {string} srcdoc
 * @returns {string}
 */
function frameIdOf(srcdoc) {
  const match = /id:\s*"([^"]+)"/.exec(srcdoc)
  if (match === null) throw new Error('no frame id in the preview document')
  return match[1]
}

// ---------------------------------------------------------------------------
// core: no DOM anywhere in this section
// ---------------------------------------------------------------------------

const { createKit, DEFAULT_CONFIG, resolveConfig } = await import('../src/client/kit.js')
const { createViewState } = await import('../src/client/view-state.js')
const { createRequest, fingerprint, normalizeLang, rawLang } = await import('../src/client/contract.js')

/**
 * A minimal renderer used by the core tests.
 * @param {string} id @param {number} priority @param {(r: any) => boolean} match
 */
function fakeRenderer(id, priority, match) {
  return {
    id,
    priority,
    match,
    create() {
      return { views: [{ id: 'preview', label: 'Preview' }], enter() {}, dispose() {} }
    },
  }
}

process.stdout.write('\ncore (no DOM)\n')

await test('normalizeLang folds aliases and mirrors the host tokenizer', () => {
  eq(normalizeLang('HTML'), 'html', 'case folded')
  eq(normalizeLang(' html  title="x" '), 'html', 'info string stripped like the host does')
  eq(normalizeLang('htm'), 'html', 'alias')
  eq(normalizeLang('chart'), 'echarts', 'alias')
  eq(normalizeLang(undefined), '', 'absent')
  eq(normalizeLang('!!!'), '', 'unparseable')
  eq(rawLang('HTML title=x'), 'html', 'rawLang does not alias')
})

await test('fingerprint is stable and separates scope, language and content', () => {
  const a = fingerprint({ scope: 'n-1', lang: 'html', source: 'x' })
  eq(a, fingerprint({ scope: 'n-1', lang: 'html', source: 'x' }), 'deterministic')
  assert(a !== fingerprint({ scope: 'n-2', lang: 'html', source: 'x' }), 'scope separates')
  assert(a !== fingerprint({ scope: 'n-1', lang: 'svg', source: 'x' }), 'lang separates')
  assert(a !== fingerprint({ scope: 'n-1', lang: 'html', source: 'y' }), 'content separates')
})

await test('createRequest derives the id from scope + language + source', () => {
  const request = createRequest({ surface: 'code-block', scope: 'n-1', lang: 'html', source: 'hi' })
  eq(request.id, fingerprint({ scope: 'n-1', lang: 'html', source: 'hi' }), 'id matches the fingerprint')
  eq(request.surface, 'code-block', 'surface carried')
  eq(request.meta, undefined, 'no meta when there is no info string')
  eq(createRequest({ surface: 'code-block', lang: '', source: 'x', info: 'a' }).meta, { info: 'a' }, 'info kept')
})

await test('negotiation is priority-first, then deterministic by id', () => {
  const kit = createKit()
  kit.register(fakeRenderer('bbb', 0, () => true))
  kit.register(fakeRenderer('aaa', 0, () => true))
  kit.register(fakeRenderer('top', 10, () => true))
  const request = createRequest({ surface: 'code-block', lang: 'html', source: 'x' })
  eq(kit.negotiate(request).id, 'top', 'highest priority wins')
  eq(kit.renderers().map((r) => r.id), ['top', 'aaa', 'bbb'], 'sorted, not registration order')
})

await test('negotiation does not depend on registration order', () => {
  const forward = createKit()
  forward.register(fakeRenderer('aaa', 0, () => true))
  forward.register(fakeRenderer('bbb', 0, () => true))
  const reverse = createKit()
  reverse.register(fakeRenderer('bbb', 0, () => true))
  reverse.register(fakeRenderer('aaa', 0, () => true))
  const request = createRequest({ surface: 'code-block', lang: 'html', source: 'x' })
  eq(forward.negotiate(request).id, reverse.negotiate(request).id, 'same winner either way')
})

await test('a renderer that throws from match is skipped, not fatal', () => {
  const seen = []
  const kit = createKit({ onError: (error) => seen.push(error) })
  kit.register(fakeRenderer('broken', 100, () => { throw new Error('boom') }))
  kit.register(fakeRenderer('fine', 0, () => true))
  const request = createRequest({ surface: 'code-block', lang: 'html', source: 'x' })
  eq(kit.negotiate(request).id, 'fine', 'fell through to the next renderer')
  eq(seen.length, 1, 'the failure was reported once')
})

await test('duplicate renderer ids fail loudly', () => {
  const kit = createKit()
  kit.register(fakeRenderer('dup', 0, () => true))
  let threw = false
  try { kit.register(fakeRenderer('dup', 0, () => true)) } catch { threw = true }
  assert(threw, 'registering the same id twice must throw')
})

await test('disabling a renderer and the master switch both stop negotiation', () => {
  const request = createRequest({ surface: 'code-block', lang: 'html', source: 'x' })
  const off = createKit({ config: { enabled: false } })
  off.register(fakeRenderer('html', 0, () => true))
  eq(off.negotiate(request), null, 'master switch')

  const disabled = createKit({ config: { disabledRendererIds: ['html'] } })
  disabled.register(fakeRenderer('html', 0, () => true))
  eq(disabled.negotiate(request), null, 'per-renderer disable')
})

await test('oversized sources are rejected before any renderer sees them', () => {
  const kit = createKit({ config: { maxSourceBytes: 10 } })
  let called = false
  kit.register(fakeRenderer('html', 0, () => { called = true; return true }))
  const big = createRequest({ surface: 'code-block', lang: 'html', source: 'x'.repeat(11) })
  eq(kit.negotiate(big).id, 'html', 'still claimed')
  eq(kit.withinLimits(big), false, 'but refused')
  eq(called, true, 'match is allowed to look at it; mounting is not')
})

await test('resolveConfig drops unknown keys and wrong types', () => {
  const config = resolveConfig({ enabled: 'yes', maxPreviewHeight: 300, bogus: 1 })
  eq(config.enabled, DEFAULT_CONFIG.enabled, 'wrong type ignored')
  eq(config.maxPreviewHeight, 300, 'valid value kept')
  eq(config.bogus, undefined, 'unknown key dropped')
})

await test('view state round-trips through storage and notifies subscribers', () => {
  const storage = new ShimStorage()
  const state = createViewState({ storage })
  let notified = 0
  const off = state.subscribe(() => { notified += 1 })
  eq(state.get('abc'), undefined, 'empty to start')
  state.set('abc', 'preview')
  eq(state.get('abc'), 'preview', 'written')
  eq(notified, 1, 'one notification')
  state.set('abc', 'preview')
  eq(notified, 1, 'setting the same value is not a change')
  off()
  state.set('abc', 'code')
  eq(notified, 1, 'unsubscribed')
})

await test('view state survives a reload through the same storage', () => {
  const storage = new ShimStorage()
  createViewState({ storage }).set('abc', 'preview')
  eq(createViewState({ storage }).get('abc'), 'preview', 'persisted')
})

await test('view state degrades to memory when storage is unavailable', () => {
  const state = createViewState({ storage: null })
  state.set('abc', 'preview')
  eq(state.get('abc'), 'preview', 'still works in-session')
})

// ---------------------------------------------------------------------------
// seam + surface, through the shim
// ---------------------------------------------------------------------------

const { createDomSeam } = await import('../src/client/dom-seam.js')
const { PLAIN_SETTLE_MS } = await import('../src/client/dom-contract.js')
const { createHtmlRenderer, MEASURE_TIMEOUT_MS } = await import('../src/client/renderers/html.js')

process.stdout.write('\nseam (fixture DOM)\n')

/**
 * Stand up a shimmed page holding the given fixture HTML, with the kit
 * configured the way the client half configures it.
 *
 * @param {string} html
 * @param {{ config?: Record<string, unknown>, storage?: ShimStorage | null, renderers?: object[] }} [options]
 */
function mount(html, options = {}) {
  const env = createEnvironment()
  parseHtml(html, env.document.body)
  const kit = createKit({
    config: options.config,
    viewState: createViewState({ storage: options.storage === undefined ? new ShimStorage() : options.storage }),
    onError: () => {},
  })
  const factory = (_key, fallback) => fallback
  for (const renderer of [createHtmlRenderer(factory), ...(options.renderers ?? [])]) kit.register(renderer)
  const seam = createDomSeam({
    kit,
    document: env.document,
    root: env.document.body,
    MutationObserver: env.MutationObserver,
  })
  seam.scan()
  return { env, kit, seam }
}

/** @param {import('./dom-shim.mjs').ShimDocument} doc */
const block = (doc) => doc.querySelector('.md-code-block')
const content = (doc) => doc.querySelector('[data-code-block-content]')
const switcher = (doc) => doc.querySelector('[data-dvk-switch]')
const ourRoot = (doc) => doc.querySelector('[data-dvk-root]')
const frame = (doc) => doc.querySelector('iframe')
/** @param {import('./dom-shim.mjs').ShimElement} node */
const click = (node) => node.dispatch('click')

await test('an html fence gains a two-view switch and opens in preview', () => {
  const { env } = mount(conversationFixture([{ nodeKey: 'n-1', html: codeBlockFixture({ lang: 'html', code: HTML_SAMPLE }) }]))
  const sw = switcher(env.document)
  assert(sw !== null, 'a view switch was added')
  eq(sw.children.map((b) => b.getAttribute('data-dvk-view')), ['preview', 'code'], 'preview first, code last')
  eq(sw.children.find((b) => b.getAttribute('data-dvk-view') === 'preview').getAttribute('aria-pressed'), 'true', 'preview is active')
  eq(content(env.document).getAttribute('data-dvk-mode'), 'preview', 'mode attribute set')
  assert(frame(env.document) !== null, 'the preview is mounted on arrival, with no click')
})

await test('a code-first config still opens on code and mounts nothing', () => {
  const { env } = mount(
    conversationFixture([{ nodeKey: 'n-1', html: codeBlockFixture({ lang: 'html', code: HTML_SAMPLE }) }]),
    { config: { defaultToPreview: false } },
  )
  const sw = switcher(env.document)
  eq(sw.children.find((b) => b.getAttribute('data-dvk-view') === 'code').getAttribute('aria-pressed'), 'true', 'code is active')
  eq(content(env.document).getAttribute('data-dvk-mode'), 'code', 'mode attribute set')
  eq(ourRoot(env.document)?.children.length, 0, 'our root exists but is empty while showing code')
  eq(frame(env.document), null, 'no preview is built for a block nobody is going to look at')
})

await test('the native code subtree is never touched', () => {
  const { env } = mount(conversationFixture([{ nodeKey: 'n-1', html: codeBlockFixture({ lang: 'html', code: HTML_SAMPLE }) }]))
  const pre = content(env.document).querySelector('pre')
  eq(pre.textContent, HTML_SAMPLE, 'source is byte-identical')
  eq(content(env.document).children[0].tagName, 'DIV', 'the shipped shiki wrapper is still first')
  eq(content(env.document).children.length, 2, 'our root is appended after it, never merged into it')
})

await test('the preview mounts a frame and hides the source', () => {
  const { env } = mount(conversationFixture([{ nodeKey: 'n-1', html: codeBlockFixture({ lang: 'html', code: HTML_SAMPLE }) }]))
  eq(content(env.document).getAttribute('data-dvk-mode'), 'preview', 'it opened in preview')
  const f = frame(env.document)
  assert(f !== null, 'a preview frame exists')
  eq(f.parentNode, ourRoot(env.document), 'mounted inside our own root')
  eq(f.getAttribute('referrerpolicy'), 'no-referrer', 'no referrer leakage')

  // The default mode MEASURES, so the frame carries a script: the measuring
  // script is part of the document it measures, which is what makes the height
  // exact without any cross-origin read. The opaque origin bounds what the
  // model's markup could do, and the nonce policy stops its scripts running at
  // all. `previewHeightMode: 'fit'` keeps the single, capability-free frame.
  eq(f.getAttribute('sandbox'), 'allow-scripts', 'the measuring script needs to run')
  assert(!f.getAttribute('sandbox').includes('allow-same-origin'), 'but never the host origin')
})

await test('a no-script preview mode keeps the original capability-free frame', () => {
  const { env } = mount(
    conversationFixture([{ nodeKey: 'n-1', html: codeBlockFixture({ lang: 'html', code: HTML_SAMPLE }) }]),
    { config: { previewHeightMode: 'fit' } },
  )
  const f = frame(env.document)
  eq(f.getAttribute('sandbox'), '', 'sandboxed with no privileges at all')
  assert(f.srcdoc.startsWith('<meta charset="utf-8">'), 'charset declared')
  assert(f.srcdoc.includes('<h1>Hello from the preview</h1>'), 'the authored document is the frame content')
})

await test('the preview never grants allow-same-origin, even with scripts on', () => {
  const { env } = mount(conversationFixture([{ nodeKey: 'n-1', html: codeBlockFixture({ lang: 'html', code: HTML_SAMPLE }) }]), {
    config: { htmlAllowScripts: true },
  })
  const f = frame(env.document)
  eq(f.getAttribute('sandbox'), 'allow-scripts', 'scripts allowed')
  assert(!(f.getAttribute('sandbox') ?? '').includes('allow-same-origin'), 'origin stays opaque — this is the whole point')
})

await test('switching to code removes the frame and restores the source', () => {
  const { env } = mount(conversationFixture([{ nodeKey: 'n-1', html: codeBlockFixture({ lang: 'html', code: HTML_SAMPLE }) }]))
  click(switcher(env.document).children[1])
  eq(content(env.document).getAttribute('data-dvk-mode'), 'code', 'mode switched')
  eq(frame(env.document), null, 'the browsing context is dropped, not just hidden')
  eq(ourRoot(env.document).children.length, 0, 'our root is emptied')
  eq(content(env.document).querySelector('pre').textContent, HTML_SAMPLE, 'source still intact')
})

await test('switching back to preview re-mounts the frame', () => {
  const { env } = mount(conversationFixture([{ nodeKey: 'n-1', html: codeBlockFixture({ lang: 'html', code: HTML_SAMPLE }) }]))
  click(switcher(env.document).children[1])
  eq(frame(env.document), null, 'code view has no frame')
  click(switcher(env.document).children[0])
  eq(content(env.document).getAttribute('data-dvk-mode'), 'preview', 'back in preview')
  assert(frame(env.document) !== null, 'the frame came back')
})

await test('a language no renderer claims is left completely alone', () => {
  const { env } = mount(conversationFixture([{ nodeKey: 'n-1', html: codeBlockFixture({ lang: 'python', code: PYTHON_SAMPLE }) }]))
  eq(switcher(env.document), null, 'no switch')
  eq(ourRoot(env.document), null, 'no injected root')
  eq(content(env.document).getAttribute('data-dvk-mode'), null, 'no mode attribute')
})

await test('svg is claimed by the same renderer as html', () => {
  const { env } = mount(conversationFixture([{ nodeKey: 'n-1', html: codeBlockFixture({ lang: 'svg', code: '<svg/>' }) }]))
  assert(switcher(env.document) !== null, 'claimed')
})

await test('a streaming block is not taken over; it is once settled', async () => {
  const { env, seam } = mount(
    conversationFixture([{ nodeKey: 'n-1', html: codeBlockFixture({ lang: 'html', code: '<p>part', streaming: true }) }]),
  )
  eq(switcher(env.document), null, 'streaming blocks are left alone')

  // DSH swaps the content node's child from <pre> to <div class="shiki"> the
  // moment the fence settles; replay that and rescan.
  const c = content(env.document)
  c.replaceChildren()
  const shiki = env.document.createElement('div')
  shiki.className = 'shiki'
  const pre = env.document.createElement('pre')
  pre.className = 'shiki css-variables'
  pre.textContent = '<p>part</p>\n'
  shiki.appendChild(pre)
  c.appendChild(shiki)
  seam.scan()
  assert(switcher(env.document) !== null, 'taken over after settling')
})

await test('the view choice is remembered for the same content', () => {
  const storage = new ShimStorage()
  const first = mount(conversationFixture([{ nodeKey: 'n-1', html: codeBlockFixture({ lang: 'html', code: HTML_SAMPLE }) }]), { storage })
  // Deliberately switch AWAY from the default, so a pass means "remembered"
  // rather than "happened to match the default".
  click(switcher(first.env.document).children[1])
  first.seam.dispose()

  const second = mount(conversationFixture([{ nodeKey: 'n-1', html: codeBlockFixture({ lang: 'html', code: HTML_SAMPLE }) }]), { storage })
  eq(switcher(second.env.document).children[1].getAttribute('aria-pressed'), 'true', 'reopened on code, not on the default')
  eq(frame(second.env.document), null, 'and built no preview')
})

await test('different content does not inherit a remembered view', () => {
  const storage = new ShimStorage()
  const first = mount(conversationFixture([{ nodeKey: 'n-1', html: codeBlockFixture({ lang: 'html', code: HTML_SAMPLE }) }]), { storage })
  click(switcher(first.env.document).children[1])
  first.seam.dispose()

  const second = mount(conversationFixture([{ nodeKey: 'n-1', html: codeBlockFixture({ lang: 'html', code: '<p>other</p>' }) }]), { storage })
  eq(switcher(second.env.document).children[0].getAttribute('aria-pressed'), 'true', 'unrelated content falls back to the default')
})

await test('the same content in a different message gets its own view state', () => {
  const storage = new ShimStorage()
  const first = mount(conversationFixture([{ nodeKey: 'n-1', html: codeBlockFixture({ lang: 'html', code: HTML_SAMPLE }) }]), { storage })
  click(switcher(first.env.document).children[1])
  first.seam.dispose()

  const second = mount(
    conversationFixture([{ nodeKey: 'n-2', html: codeBlockFixture({ lang: 'html', code: HTML_SAMPLE }) }]),
    { storage },
  )
  eq(switcher(second.env.document).children[0].getAttribute('aria-pressed'), 'true', 'scope separates messages')
})

await test('an oversized html block is not enhanced', () => {
  const html = conversationFixture([
    { nodeKey: 'n-1', html: codeBlockFixture({ lang: 'html', code: 'x'.repeat(5000) }) },
  ])
  const { env } = mount(html, { config: { maxSourceBytes: 100 } })
  eq(switcher(env.document), null, 'no switch offered for something we will not render')
})

await test('disposing the seam leaves the block exactly as it was found', () => {
  const html = conversationFixture([
    { nodeKey: 'n-1', html: codeBlockFixture({ lang: 'html', code: HTML_SAMPLE }) },
  ])
  const { env, seam } = mount(html)
  const banner = env.document.querySelector('[data-code-block-banner]')
  click(switcher(env.document).children[0])
  const c = content(env.document)
  const childrenBefore = c.children.length

  seam.dispose()

  eq(switcher(env.document), null, 'our switch is gone')
  eq(ourRoot(env.document), null, 'our root is gone')
  eq(c.getAttribute('data-dvk-mode'), null, 'our attribute is gone')
  eq(frame(env.document), null, 'the frame is gone')
  eq(c.children.length, childrenBefore - 1, 'the shipped child is back to being the only one')
  eq(c.querySelector('pre').textContent, HTML_SAMPLE, 'source untouched')
  eq(banner.querySelectorAll('button').length, 2, "only DSH's own wrap/copy buttons remain")
  eq(banner.querySelector('button').getAttribute('class'), 'Kp2Wc_action', "DSH's buttons are the originals")
})

await test('a block that already has our switch is not enhanced twice', () => {
  const { env, seam } = mount(conversationFixture([{ nodeKey: 'n-1', html: codeBlockFixture({ lang: 'html', code: HTML_SAMPLE }) }]))
  seam.scan()
  seam.scan()
  eq(env.document.querySelectorAll('[data-dvk-switch]').length, 1, 'still exactly one switch')
})

await test('a block removed from the conversation is cleaned up', async () => {
  const { env } = mount(conversationFixture([{ nodeKey: 'n-1', html: codeBlockFixture({ lang: 'html', code: HTML_SAMPLE }) }]))
  const node = block(env.document)
  click(switcher(env.document).children[0])
  node.remove()
  await tick()
  eq(env.document.querySelectorAll('[data-dvk-switch]').length, 0, 'removed with the block')
})

await test('two blocks in one conversation are tracked independently', () => {
  const { env } = mount(
    conversationFixture([
      { nodeKey: 'n-1', html: codeBlockFixture({ lang: 'html', code: HTML_SAMPLE }) },
      { nodeKey: 'n-2', html: codeBlockFixture({ lang: 'python', code: PYTHON_SAMPLE }) },
    ]),
  )
  eq(env.document.querySelectorAll('[data-dvk-switch]').length, 1, 'only the claimed one got a switch')
})

await test('stats count every examined block, and say which renderer claimed it', () => {
  const { kit } = mount(
    conversationFixture([
      { nodeKey: 'n-1', html: codeBlockFixture({ lang: 'html', code: HTML_SAMPLE }) },
      { nodeKey: 'n-2', html: codeBlockFixture({ lang: 'python', code: PYTHON_SAMPLE }) },
    ]),
  )
  eq(kit.stats(), { surfaces: 2, claimed: 1, byRenderer: { html: 1 } }, 'examined vs claimed')
})

await test('diagnose() separates "not claimed" from "not settled"', () => {
  const { seam } = mount(
    conversationFixture([
      { nodeKey: 'n-1', html: codeBlockFixture({ lang: 'html', code: HTML_SAMPLE }) },
      { nodeKey: 'n-2', html: codeBlockFixture({ lang: 'python', code: PYTHON_SAMPLE }) },
    ]),
  )
  eq(seam.diagnose(), {
    blocks: 2,
    withBanner: 2,
    withContent: 2,
    settled: 2,
    enhanced: 1,
    pending: 1,
    languages: ['html', 'python'],
    unclaimed: ['python'],
    outsideConversation: 0,
  }, 'reports both kinds of miss')
})

await test('diagnose() shows a streaming block as unsettled rather than unclaimed', () => {
  const { seam } = mount(
    conversationFixture([
      { nodeKey: 'n-1', html: codeBlockFixture({ lang: 'html', code: '<p>part', streaming: true }) },
    ]),
  )
  const report = seam.diagnose()
  eq(report.settled, 0, 'not settled yet')
  eq(report.pending, 1, 'still waiting')
  eq(report.enhanced, 0, 'nothing taken over')
})

await test('a streaming block is taken over when it settles, with no rescan needed', async () => {
  const { env, seam } = mount(
    conversationFixture([
      { nodeKey: 'n-1', html: codeBlockFixture({ lang: 'html', code: '<p>part', streaming: true }) },
    ]),
  )
  eq(seam.size(), 0, 'streaming: untouched')
  await sleep(PLAIN_SETTLE_MS + 80)
  eq(seam.size(), 0, 'the quiet retry alone must not settle a live stream')

  // Now swap the child the way DSH does when the fence closes: the content
  // node's element child becomes a wrapping <div class="shiki">.
  const c = content(env.document)
  c.replaceChildren()
  const shiki = env.document.createElement('div')
  shiki.className = 'shiki'
  const pre = env.document.createElement('pre')
  pre.textContent = HTML_SAMPLE
  shiki.appendChild(pre)
  c.appendChild(shiki)
  await tick()
  eq(seam.size(), 1, 'the observer picked it up on its own')
})

// ---------------------------------------------------------------------------
// a second renderer, added without touching the core
// ---------------------------------------------------------------------------

const { createTableRenderer, parseDelimited, readTable } = await import('../src/client/renderers/table.js')

process.stdout.write('\nsecond renderer (table) — proof that L5 is the only layer it touches\n')

await test('the CSV reader handles quotes, escaped quotes, embedded newlines and CRLF', () => {
  eq(parseDelimited('a,b\n"x,1","he said ""hi"""\n"two\nlines",z', ','), [
    ['a', 'b'],
    ['x,1', 'he said "hi"'],
    ['two\nlines', 'z'],
  ], 'RFC 4180 basics')
  eq(parseDelimited('a,b\r\n1,2\r\n', ','), [['a', 'b'], ['1', '2']], 'CRLF')
  eq(parseDelimited('a\tb\n1\t2', '\t'), [['a', 'b'], ['1', '2']], 'tab delimited')
  eq(parseDelimited('a,,b', ','), [['a', '', 'b']], 'empty field')
})

await test('table sniffing recognises csv, json arrays and pipe tables only', () => {
  assert(readTable('csv', 'name,age\nada,36') !== null, 'csv')
  assert(readTable('json', '[{"a":1},{"a":2}]') !== null, 'json array of objects')
  assert(readTable('markdown', '| a | b |\n| --- | --- |\n| 1 | 2 |') !== null, 'pipe table')
  eq(readTable('json', '[1,2,3]'), null, 'a flat number array is not a table')
  eq(readTable('json', '{"a":1}'), null, 'an object is not a table')
  eq(readTable('json', 'not json'), null, 'garbage is not a table')
  eq(readTable('csv', 'a,b'), null, 'a header with no rows is not worth a switch')
})

await test('a markdown fence is claimed ONLY when it is nothing but one table', () => {
  // Found by asking what happens to a *complex* markdown document, and the
  // answer was bad: a loose reader took the first line as a header and turned
  // every following line into an invented data row. The user saw `## Notes`
  // and a whole second table inside the preview with no way to tell which
  // cells were fabricated. Silent wrong data is worse than no preview.
  eq(readTable('markdown', '| name | age |\n| --- | --- |\n| ada | 36 |') !== null, true, 'a bare table is claimed')

  eq(readTable('markdown', '## Report\n\nProse.\n\n| a | b |\n| --- | --- |\n| 1 | 2 |'), null,
    'prose before the table -> left alone')
  eq(readTable('markdown', '| name | age |\n| --- | --- |\n| ada | 36 |\n\n## Notes\n\nMore prose.'), null,
    'prose after the table -> left alone, not invented as rows')
  eq(readTable('markdown', '| a | b |\n| --- | --- |\n| 1 | 2 |\n| only-one-cell |'), null,
    'a row of the wrong arity -> left alone rather than padded or truncated')
  // A second table would be silently dropped if only the first were rendered.
  eq(readTable('markdown', '| a | b |\n| --- | --- |\n| 1 | 2 |\n\n| c | d |\n| --- | --- |\n| 3 | 4 |'), null,
    'two tables in one fence -> left alone')
})

await test('the strict pipe reader still accepts the shapes people actually write', () => {
  const table = (text) => readTable('markdown', text)
  eq(table('| a | b |\n| :--- | ---: |\n| 1 | 2 |'), { header: ['a', 'b'], rows: [['1', '2']] }, 'alignment markers')
  eq(table('| a | b |\n| --- | --- |\n| 1 | 2 |\n'), { header: ['a', 'b'], rows: [['1', '2']] }, 'trailing newline')
  eq(table('| a | b |\n| --- | --- |'), { header: ['a', 'b'], rows: [] }, 'a header with no rows is still a table')
  eq(table('| a | b |\n| --- | --- |\n| x\\|y | 2 |'), { header: ['a', 'b'], rows: [['x|y', '2']] },
    'an escaped pipe is cell content, unescaped the way GFM renders it')
  // A row whose cells are all empty is a layout artefact, not data.
  eq(table('| a | b |\n| --- | --- |\n| 1 | 2 |\n| | |'), null, 'an empty row means this is not a plain table')
})

await test('a csv fence gains a table/code switch', () => {
  const table = createTableRenderer((_key, fallback) => fallback)
  const { env } = mount(conversationFixture([
    { nodeKey: 'n-1', html: codeBlockFixture({ lang: 'csv', code: 'name,age\nada,36\ngrace,45' }) },
  ]), { renderers: [table] })
  const sw = switcher(env.document)
  assert(sw !== null, 'a view switch was added')
  eq(sw.children.map((b) => b.getAttribute('data-dvk-view')), ['table', 'code'], 'table then code')
  click(sw.children[0])
  eq(env.document.querySelectorAll('.dvk-table tbody tr').length, 2, 'both rows rendered')
  eq(env.document.querySelectorAll('.dvk-table thead th').length, 2, 'both headers rendered')
})

await test('the table view is built from DOM calls, so no markup is ever interpreted', () => {
  const table = createTableRenderer((_key, fallback) => fallback)
  const payload = '<img src=x onerror=alert(1)>'
  const { env } = mount(conversationFixture([
    { nodeKey: 'n-1', html: codeBlockFixture({ lang: 'csv', code: `name\n${payload}` }) },
  ]), { renderers: [table] })
  click(switcher(env.document).children[0])
  eq(env.document.querySelectorAll('img').length, 0, 'no element was created from the cell text')
  eq(env.document.querySelector('.dvk-table td').textContent, payload, 'the text is shown literally')
})

await test('the table renderer does not steal html fences from the html renderer', () => {
  const table = createTableRenderer((_key, fallback) => fallback)
  const { env } = mount(conversationFixture([
    { nodeKey: 'n-1', html: codeBlockFixture({ lang: 'html', code: HTML_SAMPLE }) },
  ]), { renderers: [table] })
  eq(switcher(env.document).children[0].getAttribute('data-dvk-view'), 'preview', 'html still wins its own language')
})

// ---------------------------------------------------------------------------
// the built bundle, activated against a STRICT client context
//
// This section exists because of a shipped crash. A permissive `ctx` stub let
// the first version of this plugin pass every test here and still fail the
// renderer's boot audit with `dsh-viewer-kit: failed`, which DSH treats as a
// fatal startup error. Three separate bugs hid behind that stub:
//
//   1. `ctx.MutationObserver` — an undocumented member; a real Context proxy
//      THROWS on it, so `apply` threw and the entry's fiber went to `failed`.
//   2. `ctx.effect(dispose, …)` — `effect` runs the callback now and takes its
//      RETURN value as the disposer, so this tore the plugin down instantly.
//   3. `locale.bind(ns).t(key)` — `bind` returns the translate function
//      itself, so this threw inside the seam and every block was skipped.
//
// `pnpm run repro` prints the same findings with a stack trace.
// ---------------------------------------------------------------------------

process.stdout.write('\nbundle (built artifact, strict client context)\n')

const { activateBundle, createLocaleService } = await import('./ctx-harness.mjs')

const BUNDLE = await readFile(join(ROOT, 'client', 'client.js'), 'utf8')
const ACTIVATION_FIXTURE = conversationFixture([
  { nodeKey: 'n-1', html: codeBlockFixture({ lang: 'html', code: HTML_SAMPLE }) },
])

await test('the bundle registers itself and marks evaluation before apply', () => {
  const run = activateBundle(BUNDLE, { fixtureHtml: ACTIVATION_FIXTURE })
  eq(run.bootMarker, 'string', 'evaluation marker set by the bundle top level')
  assert(run.loaded !== undefined, 'the bundle called __ModuleLoader__.load')
  assert(typeof run.loaded.apply === 'function', 'it exports apply(ctx)')
  eq(run.loaded.inject, [], 'it declares no hard host dependencies')
})

await test('apply() survives a strict ctx that throws on undocumented members', () => {
  const run = activateBundle(BUNDLE, { fixtureHtml: ACTIVATION_FIXTURE })
  if (!run.applied.ok) throw new Error(`apply() threw: ${run.applied.error?.message}`)
  eq(run.violations, [], 'it never read a ctx member outside get/effect/on/provide')
})

await test('apply() actually enhances a block — no silent per-block failure', () => {
  const run = activateBundle(BUNDLE, { fixtureHtml: ACTIVATION_FIXTURE })
  assert(run.applied.ok, 'apply() did not throw')
  // A thrown translator used to be swallowed by the seam's per-block try/catch,
  // which looked exactly like "no renderer claimed this".
  eq(run.log.filter((line) => line.startsWith('ERROR')), [], 'nothing was logged as an error')
  eq(run.switches, 1, 'the fixture block got its view switch')
  eq(run.hook, 'object', '__DSH_VIEWER_KIT__ installed')
})

await test('the locale registration is ours to release', () => {
  const run = activateBundle(BUNDLE, { fixtureHtml: ACTIVATION_FIXTURE })
  // Exactly one effect: the top-level disposer. The dictionary registration is
  // owned by our own teardown rather than parked on `ctx.effect`, which is what
  // lets a re-activation retire cleanly instead of failing the entry with
  // "namespace … already has locale …".
  eq(run.effects.map((effect) => effect.label), ['dsh-viewer-kit: dispose'], 'one top-level disposer')
  eq(run.violations, [], 'no undocumented ctx reads')

  run.unload()
  // Unloading released the namespace, so a fresh registration succeeds.
  const unregister = run.services.get('locale').register('dsh-viewer-kit', { en: {}, zh: {} })
  assert(typeof unregister === 'function', 'the namespace was released on unload')
})

await test('a host that already carries our namespace does not fail the entry', () => {
  const locale = createLocaleService()
  locale.register('dsh-viewer-kit', { en: { 'view.code': 'Code' }, zh: { 'view.code': '代码' } })
  const run = activateBundle(BUNDLE, { fixtureHtml: ACTIVATION_FIXTURE, services: { locale } })
  assert(run.applied.ok, `apply() threw: ${run.applied.error?.message}`)
  eq(run.switches, 1, 'still enhances with a pre-registered namespace')
})

await test('a claimed block opens in preview without any click', () => {
  const run = activateBundle(BUNDLE, { fixtureHtml: ACTIVATION_FIXTURE })
  eq(run.applied.ok, true, 'apply() did not throw')
  eq(run.mode(), 'preview', 'the block is in preview mode on arrival')
  assert(run.env.document.querySelector('iframe') !== null, 'the preview is already mounted')
  // The default mode measures, so the outer frame carries a script. The model's
  // document is in the inner frame, which has no `allow-scripts` — see the
  // sandbox assertions in the "sandboxed frame" test for the full reasoning.
  eq(run.env.document.querySelector('iframe').getAttribute('sandbox'), 'allow-scripts', 'the measuring frame')

  // The switch still reads correctly: preview pressed, code not.
  const sw = run.env.document.querySelector('[data-dvk-switch]')
  assert(sw !== null, 'view switch present')
  eq(sw.children[0].getAttribute('data-dvk-view'), 'preview', 'preview is the first view')
  eq(sw.children[0].getAttribute('aria-pressed'), 'true', 'preview is the pressed one')
  eq(sw.children[1].getAttribute('data-dvk-view'), 'code', 'code is the second view')
  eq(sw.children[1].getAttribute('aria-pressed'), 'false', 'code is not pressed')
})

await test('switching to code drops the preview and leaves the source intact', () => {
  const run = activateBundle(BUNDLE, { fixtureHtml: ACTIVATION_FIXTURE })
  const sw = run.env.document.querySelector('[data-dvk-switch]')
  sw.children[1].dispatch('click')

  eq(run.mode(), 'code', 'now in code mode')
  eq(run.env.document.querySelector('iframe'), null, 'the preview was torn down')
  eq(run.env.document.querySelector('[data-code-block-content] pre').textContent, HTML_SAMPLE, 'source untouched')

  // And back.
  sw.children[0].dispatch('click')
  eq(run.mode(), 'preview', 'back in preview')
  assert(run.env.document.querySelector('iframe') !== null, 'preview remounted')
})

await test('the row config reaches apply and can restore the code-first default', () => {
  const run = activateBundle(BUNDLE, {
    fixtureHtml: ACTIVATION_FIXTURE,
    rowConfig: { defaultToPreview: false },
  })
  eq(run.applied.ok, true, 'apply() did not throw')
  eq(run.mode(), 'code', 'the row config won over the shipped default')
  eq(run.env.document.querySelector('iframe'), null, 'nothing is previewed')
  eq(run.live().kit.config().defaultToPreview, false, 'the kit reports the resolved config')
})

await test('the row config can turn on scripts for the html preview', () => {
  const run = activateBundle(BUNDLE, {
    fixtureHtml: ACTIVATION_FIXTURE,
    rowConfig: { htmlAllowScripts: true },
  })
  const iframe = run.env.document.querySelector('iframe')
  assert(iframe !== null, 'preview mounted')
  eq(iframe.getAttribute('sandbox'), 'allow-scripts', 'scripts allowed, same-origin still withheld')
  eq(run.mode(), 'preview', 'still preview-first')
  eq(run.live().kit.config().htmlAllowScripts, true, 'the kit reports the resolved config')
})

await test('a malformed row config degrades to defaults instead of failing the entry', () => {
  // The client half exports no `Config` schema, so cordis forwards the row
  // config unvalidated. A bad one must never fail the entry — a failed entry
  // is a failed web boot.
  const cases = [
    null,
    'not-an-object',
    42,
    { defaultToPreview: 'yes', maxPreviewHeight: 'tall', disabledRendererIds: 'html' },
    JSON.parse('{"__proto__":{"polluted":true},"unknownKey":true}'),
  ]
  for (const rowConfig of cases) {
    const run = activateBundle(BUNDLE, { fixtureHtml: ACTIVATION_FIXTURE, rowConfig })
    eq(run.applied.ok, true, `apply() survived rowConfig=${JSON.stringify(rowConfig)}`)
    eq(run.switches, 1, 'still enhances')
    // Wrong-typed fields fall back to the shipped default rather than breaking.
    eq(run.live().kit.config().defaultToPreview, true, 'defaultToPreview fell back to true')
    eq(run.live().kit.config().maxPreviewHeight, 320, 'maxPreviewHeight fell back to 320')
  }
  eq({}.polluted, undefined, 'no prototype pollution leaked out')
})

await test('preview mounts from the shipped bundle and unload restores the page', () => {
  const run = activateBundle(BUNDLE, { fixtureHtml: ACTIVATION_FIXTURE })
  const sw = run.env.document.querySelector('[data-dvk-switch]')
  assert(sw !== null, 'view switch present')
  assert(run.env.document.querySelector('iframe') !== null, 'preview mounts')

  run.unload()
  eq(run.env.document.querySelector('[data-dvk-switch]'), null, 'our switch is gone')
  eq(run.env.document.querySelector('style[data-plugin="dsh-viewer-kit"]'), null, 'our stylesheet is gone')
})

await test('unload leaves the native code block byte-identical', () => {
  const run = activateBundle(BUNDLE, { fixtureHtml: ACTIVATION_FIXTURE })
  run.unload()
  const pre = run.env.document.querySelector('[data-code-block-content] pre')
  eq(pre.textContent, HTML_SAMPLE, 'source untouched')
  eq(run.env.document.querySelector('[data-code-block-content]').getAttribute('data-dvk-mode'), null, 'our attribute removed')
})

await test('re-activating retires the previous activation instead of stacking switches', () => {
  // DSH re-materialises a client bundle on HMR and on re-enable. Two live
  // activations each build their own seam with their own element bookkeeping,
  // so both would append a switch to every block — which is exactly the row of
  // duplicate buttons this guards against.
  const run = activateBundle(BUNDLE, { fixtureHtml: ACTIVATION_FIXTURE })
  eq(run.switches, 1, 'first activation: one switch')

  run.loaded.apply(run.ctx)
  eq(run.switches, 1, 'second activation must not add a second switch')
  eq(run.env.document.querySelectorAll('style[data-plugin="dsh-viewer-kit"]').length, 1, 'exactly one stylesheet')

  run.loaded.apply(run.ctx)
  run.loaded.apply(run.ctx)
  eq(run.switches, 1, 'still exactly one switch after four activations')
  eq(run.env.document.querySelectorAll('style[data-plugin="dsh-viewer-kit"]').length, 1, 'still one stylesheet')
})

await test('a stray switch left in a banner is cleared before ours is added', () => {
  const run = activateBundle(BUNDLE, { fixtureHtml: ACTIVATION_FIXTURE })
  const content = run.env.document.querySelector('[data-code-block-content]')
  const banner = run.env.document.querySelector('[data-code-block-banner]')

  // Simulate the aftermath of a crashed activation: our markers still in the
  // DOM, but no live surface tracking them. Tagged so we can prove which node
  // survived.
  const straySwitch = run.env.document.createElement('div')
  straySwitch.setAttribute('data-dvk-switch', 'true')
  straySwitch.setAttribute('data-stray', 'switch')
  banner.lastElementChild.appendChild(straySwitch)
  const strayRoot = run.env.document.createElement('div')
  strayRoot.setAttribute('data-dvk-root', 'true')
  strayRoot.setAttribute('data-stray', 'root')
  content.appendChild(strayRoot)

  eq(run.env.document.querySelectorAll('[data-dvk-switch]').length, 2, 'ours + the stray')
  eq(run.env.document.querySelectorAll('[data-dvk-root]').length, 2, 'ours + the stray')

  // Re-activation retires the old seam, then a fresh scan re-claims the block.
  run.loaded.apply(run.ctx)

  eq(run.env.document.querySelectorAll('[data-dvk-switch]').length, 1, 'back to exactly one switch')
  eq(run.env.document.querySelectorAll('[data-dvk-root]').length, 1, 'back to exactly one view root')
  eq(run.env.document.querySelector('[data-stray="switch"]'), null, 'the stray switch was the one removed')
  eq(run.env.document.querySelector('[data-stray="root"]'), null, 'the stray root was the one removed')
})

await test('a host without a locale service still activates', () => {
  const run = activateBundle(BUNDLE, { fixtureHtml: ACTIVATION_FIXTURE, withLocale: false })
  assert(run.applied.ok, 'apply() did not throw without a locale service')
  eq(run.switches, 1, 'still enhances')
  eq(run.effects.map((effect) => effect.label), ['dsh-viewer-kit: dispose'], 'only our own disposer')
})

await test('the built bundle is syntactically loadable as a classic script', () => {
  const bundle = readFileSync(join(ROOT, 'client', 'client.js'), 'utf8')
  assert(bundle.startsWith('window.__ModuleLoader__.load('), 'uses the module loader format')
  assert(bundle.includes('exports.apply'), 'exports apply')
  assert(!/\nimport\s/.test(bundle), 'no ESM import statements leaked into the output')
  assert(!/\nexport\s/.test(bundle), 'no ESM export statements leaked into the output')
})

// ---------------------------------------------------------------------------
// third renderer (chart) — the one that needs a build contract, not just a file
//
// Adding a renderer is "one file + one line" only while the renderer is
// self-contained. The chart engine is 1.5 MB, so it ships as a sibling file the
// DSH client module system fetches on demand, and that adds requirements the
// bundler can only satisfy if the build is configured for them. A regression
// there is invisible until a chart fails to draw in the browser, so these
// tests read the EMITTED files.
// ---------------------------------------------------------------------------

const { createEChartsRenderer, parseOption } = await import('../src/client/renderers/echarts.js')
const { __setChunkTransport, ECHARTS_CHUNK } = await import('../src/client/chunk-loader.js')

process.stdout.write('\nthird renderer (chart) — a renderer that needs the chunk contract\n')

/** A stand-in for the real engine: no canvas, so it only records what it was asked to do. */
function fakeEngine(log) {
  return {
    createChart(element, option) {
      log.options.push(option)
      const canvas = element.ownerDocument.createElement('div')
      canvas.className = 'fake-canvas'
      element.replaceChildren(canvas)
      return {
        setOption: (next) => log.options.push(next),
        resize: () => log.resizes.push(true),
        dispose: () => log.disposes.push(true),
      }
    },
  }
}

const OPTION_SAMPLE = JSON.stringify({
  xAxis: { type: 'category', data: ['Mon', 'Tue', 'Wed'] },
  series: [{ type: 'bar', data: [12, 32, 24] }],
})

await test('option parsing is strict and explains itself', () => {
  eq(parseOption(OPTION_SAMPLE).option !== undefined, true, 'valid option accepted')
  assert(/no "series" array/.test(parseOption('{"xAxis":{}}').error), 'missing series is named')
  assert(/not valid JSON/.test(parseOption('{oops}').error), 'bad JSON is named')
  assert(/expected a JSON object/.test(parseOption('[1,2]').error), 'an array is rejected')
  assert(/expected a JSON object/.test(parseOption('"a"').error), 'a bare string is rejected')
  assert(/empty/.test(parseOption('   ').error), 'empty is rejected')
  assert(/limit/.test(parseOption(`{"series":[],"pad":"${'x'.repeat(600_000)}"}`).error), 'oversized is rejected')
  // Strictness is the point: a relaxed parse would hand ECharts a different
  // value than the model wrote, and the chart would be wrong invisibly.
  assert(parseOption("{a:1}").error !== undefined, 'unquoted keys are not accepted')
})

await test('the tooltip is forced to rich text so a formatter cannot inject markup', () => {
  const hostile = JSON.stringify({ tooltip: { trigger: 'axis', formatter: '<img src=x>' }, series: [{ type: 'bar', data: [1] }] })
  const { env } = mount(
    conversationFixture([{ nodeKey: 'n-1', html: codeBlockFixture({ lang: 'echarts', code: hostile }) }]),
    { renderers: [createEChartsRenderer((_k, f) => f)] },
  )
  assert(switcher(env.document) !== null, 'claimed')
  eq(env.document.querySelectorAll('img').length, 0, 'nothing was interpreted as markup')
})

await test('an echarts fence gains a chart/code switch and draws through the engine', async () => {
  const log = { options: [], resizes: [], disposes: [] }
  __setChunkTransport(async () => fakeEngine(log))
  const { env } = mount(
    conversationFixture([{ nodeKey: 'n-1', html: codeBlockFixture({ lang: 'echarts', code: OPTION_SAMPLE }) }]),
    { renderers: [createEChartsRenderer((_k, f) => f)] },
  )
  const sw = switcher(env.document)
  assert(sw !== null, 'a view switch was added')
  eq(sw.children.map((b) => b.getAttribute('data-dvk-view')), ['chart', 'code'], 'chart then code')
  await tick()
  eq(env.document.querySelectorAll('.fake-canvas').length, 1, 'the engine drew into our root')
  eq(log.options[0].series[0].type, 'bar', 'the model option reached the engine unchanged')
})

await test('the chart request names the chunk the build actually emits', () => {
  // The binding that cannot be checked by a bundler: a string in source, a file
  // name in the build config, and the host's on-demand route. All three must
  // agree or the chart 404s at render time.
  const chunkFile = ECHARTS_CHUNK.replace(/^\.\//, '')
  assert(/^\.\//.test(ECHARTS_CHUNK), 'the loader wants a relative spec starting with ./')

  let emitted
  try {
    emitted = readFileSync(join(ROOT, 'client', chunkFile), 'utf8')
  } catch {
    throw new Error(`client/${chunkFile} was not emitted — is it still an entry in tsdown.config.ts?`)
  }

  assert(
    /^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$/.test(chunkFile),
    `the host only serves /^client\\.[A-Za-z0-9][A-Za-z0-9._-]*\\.js$/, got ${chunkFile}`,
  )
  const expectedId = `"dsh-viewer-kit/${chunkFile}"`
  assert(
    emitted.startsWith(`window.__ModuleLoader__.load({ id: ${expectedId},`),
    `the chunk must register itself as ${expectedId}; a mismatch means importChunk throws ` +
      '"loaded without registering" at chart time',
  )
})

await test('the engine chunk carries no Node-only globals', () => {
  // ECharts and zrender branch on `process.env.NODE_ENV` because they must also
  // run under Node. A browser has no `process`, so evaluating the chunk threw
  // `process is not defined` and every chart failed to load — while every
  // fixture test passed, because they stub the engine and never evaluate it.
  const chunk = readFileSync(join(ROOT, 'client', ECHARTS_CHUNK.replace(/^\.\//, '')), 'utf8')
  // Comments are stripped first: prose that merely mentions `process` is not a
  // live reference. This cannot hide a real one — a real one is in code.
  const code = chunk.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const live = code.match(/\bprocess\b/g)
  assert(live === null, `the chunk still reads \`process\` (${live?.length ?? 0}×); the build lost its process.env.NODE_ENV define`)
  assert(!/\brequire\s*\(\s*['"]node:/.test(code), 'the chunk must not require a node: built-in')
})

await test('the main bundle stays small and the engine is not inlined into it', () => {
  const bundle = readFileSync(join(ROOT, 'client', 'client.js'), 'utf8')
  const chunk = readFileSync(join(ROOT, 'client', ECHARTS_CHUNK.replace(/^\.\//, '')), 'utf8')
  // The whole reason the engine is a separate file. If this ever inlines, the
  // cost silently returns to every user on every page load.
  assert(bundle.length < 200_000, `client.js is ${bundle.length} bytes; the engine is inlined`)
  assert(chunk.length > 500_000, `client.echarts.js is only ${chunk.length} bytes; is echarts actually bundled?`)
  assert(!bundle.includes('echarts.init'), 'the engine API must not appear in the entry')
  assert(bundle.includes("require.async") || bundle.includes('__dvkRequire.async'), 'the entry reaches the chunk through require.async')
  assert(!/Promise\.resolve\(\)\.then\(\(\) => require\("\.\/client\.echarts/.test(bundle),
    'a bare dynamic import of the chunk would throw "missed the module table"')
})

await test('the built ids match the package name on both sides', () => {
  // `tsdown.config.ts` carries the package name as a literal, because the
  // project's tsconfig excludes Node types and a `readFileSync` there would not
  // type-check. A rename that missed the literal would produce a bundle the
  // loader indexes under a name that does not exist, and the entry would never
  // be started — a silent, total failure. So it is checked here.
  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const bundle = readFileSync(join(ROOT, 'client', 'client.js'), 'utf8')
  assert(
    bundle.startsWith(`window.__ModuleLoader__.load({ id: ${JSON.stringify(manifest.name)},`),
    `client.js registers under a different id than the package name "${manifest.name}"`,
  )
})

await test('a failed engine load is shown as content, not thrown', async () => {
  __setChunkTransport(async () => {
    throw new Error('HTTP 404')
  })
  const { env } = mount(
    conversationFixture([{ nodeKey: 'n-1', html: codeBlockFixture({ lang: 'echarts', code: OPTION_SAMPLE }) }]),
    { renderers: [createEChartsRenderer((_k, f) => f)] },
  )
  await tick()
  const note = env.document.querySelector('.dvk-chart-note')
  assert(note !== null, 'a note is shown')
  assert(/404/.test(note.textContent), `the reason survives: ${note.textContent}`)
  // The code view is still reachable, which is the point of not throwing.
  assert(switcher(env.document) !== null, 'the switch is still there')
})

await test('invalid JSON is reported in the preview and never reaches the engine', async () => {
  const log = { options: [], resizes: [], disposes: [] }
  __setChunkTransport(async () => fakeEngine(log))
  const { env } = mount(
    conversationFixture([{ nodeKey: 'n-1', html: codeBlockFixture({ lang: 'echarts', code: '{ broken' }) }]),
    { renderers: [createEChartsRenderer((_k, f) => f)] },
  )
  await tick()
  const note = env.document.querySelector('.dvk-chart-note')
  assert(note !== null, 'a note is shown instead of a blank box')
  assert(/not valid JSON/.test(note.textContent), note.textContent)
  eq(log.options, [], 'the engine was never called')
})

await test('the chart renderer does not steal json from the table renderer', () => {
  const { env } = mount(
    conversationFixture([{ nodeKey: 'n-1', html: codeBlockFixture({ lang: 'json', code: '[{"a":1},{"a":2}]' }) }]),
    { renderers: [createTableRenderer((_k, f) => f), createEChartsRenderer((_k, f) => f)] },
  )
  eq(switcher(env.document).children[0].getAttribute('data-dvk-view'), 'table', 'json arrays stay tables')
})

await test('an echarts chart is disposed when the block goes away', async () => {
  const log = { options: [], resizes: [], disposes: [] }
  __setChunkTransport(async () => fakeEngine(log))
  const { env, seam } = mount(
    conversationFixture([{ nodeKey: 'n-1', html: codeBlockFixture({ lang: 'echarts', code: OPTION_SAMPLE }) }]),
    { renderers: [createEChartsRenderer((_k, f) => f)] },
  )
  await tick()
  seam.dispose()
  eq(log.disposes, [true], 'the ECharts instance was disposed, canvas and observers with it')
})

// ---------------------------------------------------------------------------
// a fence language DSH has no highlighter for
//
// Captured from the product: an `echarts` fence came out with
// `<span class="_language_…">代码块</span>` and a `<pre class="_plain_…">` body.
// `CodeToolbar` renders `supportsHighlighting(lang) ? lang : <fallback>`, and
// DSH's grammar table has no `echarts` — so the fence name is not in the DOM at
// all, and the body never becomes a highlighted `<div>`.
//
// Both of this kit's earlier recognition paths depend on exactly those two
// facts, so every previously-green fixture missed it.
// ---------------------------------------------------------------------------

process.stdout.write('\nunknown fence language (no highlighter, generic banner)\n')

const OPTION_UNKNOWN_FENCE = JSON.stringify({
  tooltip: {},
  series: [{ type: 'pie', radius: ['42%', '68%'], data: [{ name: 'a', value: 46 }] }],
})

await test('a fence DSH cannot highlight is recognised from its content', async () => {
  const log = { options: [], resizes: [], disposes: [] }
  __setChunkTransport(async () => fakeEngine(log))
  const { env, seam } = mount(
    conversationFixture([
      { nodeKey: 'n-1', html: codeBlockFixture({ lang: 'echarts', code: OPTION_UNKNOWN_FENCE, highlighted: false }) },
    ]),
    { renderers: [createEChartsRenderer((_k, f) => f)] },
  )
  assert(switcher(env.document) !== null, 'a switch appeared despite the generic banner')
  eq(switcher(env.document).children.map((b) => b.getAttribute('data-dvk-view')), ['chart', 'code'], 'chart then code')
  eq(seam.size(), 1, 'the block was claimed')
  await tick()
  eq(env.document.querySelectorAll('.fake-canvas').length, 1, 'and the engine drew')
})

await test('a code block outside the conversation view is never touched', () => {
  // The trajectory tab renders its own `.md-code-block` elements — its bundle
  // carries `markdownPreview`, `assistantContent` and a `.md-code-block` style
  // rule — and the seam used to root at `doc.body`, so it enhanced a panel this
  // plugin was never asked to touch. The boundary is empirical: the chat bundle
  // sets ~60 `data-chat-*` attributes and the trajectory bundle sets none.
  const trajBlock = codeBlockFixture({ lang: 'html', code: HTML_SAMPLE })
  const { env, seam } = mount(
    // No `data-chat-*` ancestor anywhere around this one.
    `<div class="trajectory-panel">${trajBlock}</div>` +
      conversationFixture([{ nodeKey: 'n-1', html: codeBlockFixture({ lang: 'html', code: HTML_SAMPLE }) }]),
  )
  eq(env.document.querySelectorAll('[data-dvk-switch]').length, 1, 'only the conversation block was enhanced')
  eq(seam.size(), 1, 'one surface')
  eq(seam.diagnose().blocks, 1, 'the other panel is not even counted as a block')
  eq(seam.diagnose().outsideConversation, 1, 'and it is reported separately, not as an unclaimed language')
  eq(seam.diagnose().unclaimed, [], 'a block we deliberately skip is not a renderer miss')
})

await test('the conversation boundary accepts any of the chat containers', () => {
  // `data-chat-flow` is on the flow container and `data-chat-node-key` on each
  // message row. Requiring only one would silently drop blocks the day that
  // nesting moves, so either must work.
  for (const attr of ['data-chat-flow', 'data-chat-node-key', 'data-chat-turn', 'data-chat-group-key']) {
    const { env } = mount(
      `<div ${attr}="x">${codeBlockFixture({ lang: 'html', code: HTML_SAMPLE })}</div>`,
    )
    eq(env.document.querySelectorAll('[data-dvk-switch]').length, 1, `claimed under ${attr}`)
  }
})

await test('the measured height wins over the estimate, and is capped', () => {
  // The whole point of measuring: the frame follows the document's real height
  // instead of a guess, so short content shows fully and only genuinely long
  // content scrolls.
  const html = conversationFixture([{ nodeKey: 'n-1', html: codeBlockFixture({ lang: 'html', code: '<p>hi</p>' }) }])
  const { env } = mount(html, { config: { maxPreviewHeight: 320 } })
  const frame = env.document.querySelector('iframe')
  const view = env.document.defaultView

  eq(frame.getAttribute('sandbox'), 'allow-scripts', 'the measuring script IS the document, so it needs to run')
  assert(!frame.getAttribute('sandbox').includes('allow-same-origin'), 'but the origin stays opaque')

  // It starts at the estimate so it is never a zero-height sliver.
  assert(frame.style.height !== '0px' && frame.style.height.endsWith('px'), `starts sized, got ${frame.style.height}`)

  // A message from the frame's own window replaces the guess.
  view.postMessage({ source: frame.contentWindow, data: { __dvk: 'height', id: frameIdOf(frame.srcdoc), height: 212 } })
  eq(frame.style.height, '212px', 'the measured height replaced the estimate')

  // Capped, because a preview is a glance rather than a page view.
  view.postMessage({ source: frame.contentWindow, data: { __dvk: 'height', id: frameIdOf(frame.srcdoc), height: 9000 } })
  eq(frame.style.height, '320px', 'a very tall document stops at the cap')
})

await test('the model document is the frame document, not a nested one', () => {
  // The first implementation nested the model's document in a second frame and
  // tried to read it from the outer one. That cannot work: sandbox flags are
  // inherited and unioned, so an outer frame without `allow-same-origin` forces
  // an opaque origin onto every descendant, and opaque origins are never
  // same-origin with anything — not even their own parent. `contentDocument`
  // was null, the inner frame stayed at `height: 0`, and the preview was blank.
  //
  // Measuring in place is what removes the cross-origin problem: the script
  // measures the document it is part of. This test pins that shape, because
  // reintroducing a nested frame would blank the preview again.
  const html = conversationFixture([{ nodeKey: 'n-1', html: codeBlockFixture({ lang: 'html', code: '<p id="marker">hi</p>' }) }])
  const frame = mount(html, { config: { maxPreviewHeight: 320 } }).env.document.querySelector('iframe')

  assert(frame.srcdoc.includes('id="marker"'), 'the model\'s markup is IN this document')
  eq(/<iframe/.test(frame.srcdoc), false, 'and there is no nested frame to read across')
  assert(!frame.srcdoc.includes('contentDocument'), 'nothing reaches across a browsing context')
})

await test('a nonce policy blocks the model scripts while letting the measurer run', () => {
  const html = conversationFixture([{ nodeKey: 'n-1', html: codeBlockFixture({ lang: 'html', code: '<p>hi</p>' }) }])
  const frame = mount(html, { config: { maxPreviewHeight: 320 } }).env.document.querySelector('iframe')
  const srcdoc = frame.srcdoc

  const policy = /<meta http-equiv="Content-Security-Policy" content="script-src 'nonce-([^']+)'">/.exec(srcdoc)
  assert(policy !== null, 'a nonce policy is present')
  const nonce = policy[1]
  // Every script in the document must carry that nonce; anything without it —
  // which is every script the model could write — is refused, along with inline
  // event handlers and `javascript:` URLs, since 'unsafe-inline' is absent.
  const tags = [...srcdoc.matchAll(/<script([^>]*)>/g)].map((m) => m[1])
  eq(tags.length, 1, 'exactly one script, the measurer')
  assert(tags[0].includes(`nonce="${nonce}"`), 'and it carries the nonce')
  assert(!srcdoc.includes('unsafe-inline'), 'nothing re-enables inline script')

  // The policy must be parsed BEFORE the model's markup, or a script earlier in
  // the document would run before it applied.
  assert(
    srcdoc.indexOf('Content-Security-Policy') < srcdoc.indexOf('<p>hi</p>'),
    'the policy precedes the model content',
  )
})

await test('turning on htmlAllowScripts drops the policy but keeps the opaque origin', () => {
  const html = conversationFixture([{ nodeKey: 'n-1', html: codeBlockFixture({ lang: 'html', code: '<p>hi</p>' }) }])
  const frame = mount(html, { config: { maxPreviewHeight: 320, htmlAllowScripts: true } }).env.document.querySelector('iframe')
  eq(frame.srcdoc.includes('Content-Security-Policy'), false, 'the model may run its own scripts')
  assert(!frame.getAttribute('sandbox').includes('allow-same-origin'), 'but still cannot reach the host')
})

await test('a model script is present but unauthorised, so the policy refuses it', () => {
  // The content is inline now, so the model's `<script>` genuinely IS in the
  // document — that is expected, and the policy is what stops it. The assertion
  // that matters is about nonces, not presence: exactly one script may run, and
  // it is ours.
  const hostile = '<p>a</p><script>parent.document.body.innerHTML="pwned"</script>'
  const html = conversationFixture([{ nodeKey: 'n-1', html: codeBlockFixture({ lang: 'html', code: hostile }) }])
  const { env } = mount(html, { config: { maxPreviewHeight: 320 } })
  const frame = env.document.querySelector('iframe')

  const nonce = /nonce-([^']+)'/.exec(frame.srcdoc)[1]
  const tags = [...frame.srcdoc.matchAll(/<script([^>]*)>/g)].map((match) => match[1])
  const authorised = tags.filter((attrs) => attrs.includes(`nonce="${nonce}"`))
  const refused = tags.filter((attrs) => !attrs.includes(`nonce="${nonce}"`))

  eq(authorised.length, 1, 'exactly one script may run: the measurer')
  eq(refused.length, 1, "the model's script is in the document")
  eq(refused[0].includes('nonce'), false, 'and carries no nonce, so script-src refuses it')
  eq(env.document.querySelectorAll('script').length, 0, 'nothing script-shaped reached the host document')
})

await test('a message from another window, or of another shape, is ignored', () => {
  const html = conversationFixture([{ nodeKey: 'n-1', html: codeBlockFixture({ lang: 'html', code: '<p>hi</p>' }) }])
  const { env } = mount(html, { config: { maxPreviewHeight: 320 } })
  const frame = env.document.querySelector('iframe')
  const view = env.document.defaultView
  const before = frame.style.height

  // Identity is checked by SOURCE, not origin: the sender is an opaque-origin
  // frame, so `event.origin` is the string "null" and carries no information.
  view.postMessage({ source: { some: 'other window' }, data: { __dvk: 'height', id: frameIdOf(frame.srcdoc), height: 5 } })
  eq(frame.style.height, before, 'a message from a different window is ignored')
  view.postMessage({ source: frame.contentWindow, data: { nope: true } })
  eq(frame.style.height, before, 'an unrelated message is ignored')
  view.postMessage({ source: frame.contentWindow, data: { __dvk: 'height', id: 'someone-elses-frame', height: 5 } })
  eq(frame.style.height, before, 'another frame id is ignored')
  view.postMessage({ source: frame.contentWindow, data: { __dvk: 'height', id: frameIdOf(frame.srcdoc), height: 'tall' } })
  eq(frame.style.height, before, 'a non-numeric height is ignored')
  view.postMessage({ source: frame.contentWindow, data: { __dvk: 'height', id: frameIdOf(frame.srcdoc), height: 0 } })
  eq(frame.style.height, before, 'a zero height is ignored rather than collapsing the frame')
})

await test('disposing a preview removes its message listener', () => {
  // A leaked listener per preview would accumulate for the life of the page and
  // keep removed frames alive.
  const html = conversationFixture([{ nodeKey: 'n-1', html: codeBlockFixture({ lang: 'html', code: '<p>hi</p>' }) }])
  const { env, seam } = mount(html, { config: { maxPreviewHeight: 320 } })
  eq(env.document.defaultView.listenerCount(), 1, 'one listener while the preview is mounted')
  seam.dispose()
  eq(env.document.defaultView.listenerCount(), 0, 'and none after dispose')
})

await test('a measurement that never arrives leaves the estimate in place', async () => {
  // The fallback is what makes the measuring frame safe to ship: its failure
  // mode is "slightly wrong height", never "no preview".
  const html = conversationFixture([{ nodeKey: 'n-1', html: codeBlockFixture({ lang: 'html', code: '<p>hi</p>' }) }])
  const { env } = mount(html, { config: { maxPreviewHeight: 320 } })
  const frame = env.document.querySelector('iframe')
  const initial = frame.style.height
  await sleep(MEASURE_TIMEOUT_MS + 80)
  eq(frame.style.height, initial, 'still a sane height, not collapsed')
  assert(frame.style.height !== '0px', 'and never zero')
})

await test('previewHeightMode picks between measured, fitted and fixed frames', async () => {
  const { estimateHeight: estimate } = await import('../src/client/renderers/html.js')
  const html = conversationFixture([{ nodeKey: 'n-1', html: codeBlockFixture({ lang: 'html', code: '<p>hi</p>' }) }])
  const frameOf = (config) => mount(html, { config }).env.document.querySelector('iframe')
  const fitted = estimate('<p>hi</p>', 320)

  const measured = frameOf({ maxPreviewHeight: 320 })
  eq(measured.style.height, `${fitted}px`, 'measure starts at the estimate while it measures')
  assert(measured.getAttribute('sandbox') === 'allow-scripts', 'and uses the measuring frame')

  const fit = frameOf({ previewHeightMode: 'fit', maxPreviewHeight: 320 })
  eq(fit.style.height, `${fitted}px`, 'fit uses the estimate')
  eq(fit.getAttribute('sandbox'), '', 'fit needs no script permission at all')
  eq(fit.srcdoc.includes('Content-Security-Policy'), false, 'and no measuring policy')

  eq(frameOf({ previewHeightMode: 'fixed', maxPreviewHeight: 320 }).style.height, '320px', 'fixed is the cap, always')
  eq(frameOf({ previewHeightMode: 'fixed', maxPreviewHeight: 180 }).style.height, '180px', 'fixed follows the configured height')
})

await test('an unknown previewHeightMode falls back to measure rather than breaking', async () => {
  // A string enum cannot be validated by `typeof`, which would accept any
  // string and leave the renderer comparing against a mode that does not exist.
  const html = conversationFixture([{ nodeKey: 'n-1', html: codeBlockFixture({ lang: 'html', code: '<p>hi</p>' }) }])
  for (const mode of ['nonsense', '', 42, null]) {
    const { kit, env } = mount(html, { config: { previewHeightMode: mode } })
    eq(kit.config().previewHeightMode, 'measure', `mode ${JSON.stringify(mode)} fell back to measure`)
    assert(env.document.querySelector('iframe') !== null, 'and the preview still mounted')
  }
})

await test('the preview frame is sized from what paints, not from source lines', async () => {
  // A sandboxed frame cannot be measured — `sandbox=""` means an opaque origin
  // and a null contentDocument — so the height is computed. Counting source
  // lines was systematically too tall: `<style>`, `<head>`, comments and the
  // doctype are markup nobody sees, and the report was a frame with a band of
  // empty space under a two-heading document.
  const { estimateHeight: estimate } = await import('../src/client/renderers/html.js')
  const cap = 320

  // A designed document — a card with its own padding — is the shape that
  // exposed this: the estimate has to clear its real height or the frame shows
  // a scrollbar over content that nearly fits.
  const card = estimate(
    '<style>body{margin:24px;font:16px sans-serif}</style><div style="padding:28px">' +
      '<div>SANDBOXED PREVIEW</div><h1>你好，预览</h1><p>我在一个 sandbox 的 iframe 里。</p>' +
      '<div><span>零第三方依赖</span><span>不抢宿主的渲染</span></div></div>',
    cap,
  )
  assert(card > 240, `a padded card got ${card}px; its own padding was not accounted for`)

  const tall = estimate('<p>' + 'word '.repeat(3000) + '</p>', cap)
  eq(tall, cap, 'a very long document stops at the user cap')

  // Markup nobody sees must not inflate the estimate — that was the original
  // bug, and it is why the old version reported a band of empty frame.
  eq(
    estimate('<style>' + 'a{color:red}'.repeat(500) + '</style><h1>x</h1>', cap),
    estimate('<h1>x</h1>', cap),
    'a large <style> block costs nothing',
  )

  eq(estimate('<html><body></body></html>', cap), 101,
    'an empty document still gets a clickable strip, not a sliver')
  eq(estimate('<h1>x</h1>', cap), 189, 'a heading is priced as a heading, not as a body line')
  eq(estimate('<p>hi</p>', 40), 40, 'a cap below the natural minimum wins, so a user can force a small frame')
  assert(
    estimate('<h1>a</h1><h2>b</h2><h1>c</h1>', cap) > estimate('<p>a</p><p>b</p><p>c</p>', cap),
    'headings are not priced as body lines',
  )
})

await test('the engine chunk is read through its named export', async () => {
  // The chunk is CJS with a named `engine` export, so `require.async` returns
  // `{ engine: { createChart } }`. Reading `createChart` off the top level
  // reported "unexpected chunk shape" against a chunk that had downloaded and
  // evaluated perfectly.
  const log = { options: [], resizes: [], disposes: [] }
  __setChunkTransport(async () => ({ engine: fakeEngine(log) }))
  const { env } = mount(
    conversationFixture([{ nodeKey: 'n-1', html: codeBlockFixture({ lang: 'echarts', code: OPTION_SAMPLE }) }]),
    { renderers: [createEChartsRenderer((_k, f) => f)] },
  )
  await tick()
  eq(env.document.querySelectorAll('.fake-canvas').length, 1, 'the engine behind the named export drew')
})

await test('a chunk that exports nothing usable says what it did export', async () => {
  // A bare "unexpected chunk shape" sent the debugging in the wrong direction
  // for a full round, so the message names the keys it actually found.
  __setChunkTransport(async () => ({ nope: 1 }))
  const { env } = mount(
    conversationFixture([{ nodeKey: 'n-1', html: codeBlockFixture({ lang: 'echarts', code: OPTION_SAMPLE }) }]),
    { renderers: [createEChartsRenderer((_k, f) => f)] },
  )
  await tick()
  const note = env.document.querySelector('.dvk-chart-note')
  assert(note !== null, 'a note is shown')
  assert(/nope/.test(note.textContent), `the message names what the chunk exported: ${note.textContent}`)
})

await test('a bare pipe table in an unlabelled fence is still a table', () => {
  const { env, seam } = mount(
    conversationFixture([
      { nodeKey: 'n-1', html: codeBlockFixture({ lang: 'whatever', code: '| a | b |\n| --- | --- |\n| 1 | 2 |', highlighted: false }) },
    ]),
    { renderers: [createTableRenderer((_k, f) => f), createEChartsRenderer((_k, f) => f)] },
  )
  eq(switcher(env.document).children[0].getAttribute('data-dvk-view'), 'table', 'claimed as a table, not a chart')
  eq(seam.size(), 1, 'claimed')
})

await test('an unlabelled fence holding neither a chart nor a table is left alone', () => {
  const { env, seam } = mount(
    conversationFixture([
      { nodeKey: 'n-1', html: codeBlockFixture({ lang: 'whatever', code: 'def f():\n    pass', highlighted: false }) },
    ]),
    { renderers: [createTableRenderer((_k, f) => f), createEChartsRenderer((_k, f) => f)] },
  )
  eq(switcher(env.document), null, 'no switch: content sniffing declined')
  eq(env.document.querySelector('[data-code-block-content]').getAttribute('data-dvk-mode'), null, 'native block untouched')
  // Bounded retries must actually stop, not spin for the life of the page.
  eq(seam.diagnose().unclaimed, ['(none)'], 'reported as unclaimed with no language')
})

await test('a half-streamed chart is not claimed, and is picked up once complete', async () => {
  const log = { options: [], resizes: [], disposes: [] }
  __setChunkTransport(async () => fakeEngine(log))
  const { env, seam } = mount(
    conversationFixture([
      // Mid-stream: the JSON is not parseable yet.
      { nodeKey: 'n-1', html: codeBlockFixture({ lang: 'echarts', code: '{"series": [{"type":', streaming: true, highlighted: false }) },
    ]),
    { renderers: [createEChartsRenderer((_k, f) => f)] },
  )
  eq(seam.size(), 0, 'incomplete JSON is not a chart')
  eq(switcher(env.document), null, 'no switch while it streams')

  // The fence closes with the full option, the way DSH swaps the body.
  const contentNode = env.document.querySelector('[data-code-block-content]')
  const pre = env.document.createElement('pre')
  pre.className = '_plain_x'
  pre.textContent = OPTION_UNKNOWN_FENCE
  contentNode.replaceChildren(pre)
  await tick()

  eq(seam.size(), 1, 'claimed once the content was complete — no timer guessing')
  assert(switcher(env.document) !== null, 'switch appeared on the settling mutation')
})

await test('the generic label is reported as "no language", not as a language called 代码块', () => {
  const { seam } = mount(
    conversationFixture([
      { nodeKey: 'n-1', html: codeBlockFixture({ lang: 'echarts', code: 'not a chart', highlighted: false }) },
    ]),
    { renderers: [createEChartsRenderer((_k, f) => f)] },
  )
  const report = seam.diagnose()
  eq(report.languages, ['(none)'], 'the banner is reported as carrying no language')
})

// ---------------------------------------------------------------------------
// the README quotes the product, so the product must still say those things
//
// This exists because the README drifted: it advertised `renderers: echarts,
// html, table` when the bundle had long since logged `html, echarts, table`
// (priority order, not registration order), listed the console lines in the
// wrong sequence, and quoted test counts and a version that were several
// releases stale. Every one of those is something a reader checks *first*, and
// every one was wrong in a direction that looks like a broken install.
//
// A guard rather than a one-time fix: the failure mode is silent by nature.
// ---------------------------------------------------------------------------

process.stdout.write('\ndocs (README quotes must still be true)\n')

await test('the README quotes the console lines the bundle actually emits', () => {
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8')
  const run = activateBundle(BUNDLE, { fixtureHtml: ACTIVATION_FIXTURE })
  const emitted = run.log.filter((line) => line.startsWith('[dsh-viewer-kit]'))
  assert(emitted.length >= 3, `expected the three startup lines, saw ${emitted.length}`)

  for (const line of emitted) {
    // The count is live, so the README writes it as a placeholder.
    const quoted = line.replace(/— \d+ code block/, '— N code block')
    assert(readme.includes(quoted), `the README no longer quotes:\n         ${quoted}`)
  }
})

await test('the README quotes the current version and tarball name', () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8')
  assert(readme.includes(`v${manifest.version} active`), `the README does not quote v${manifest.version}`)
  assert(
    readme.includes(`dsh-viewer-kit-${manifest.version}.tgz`),
    `the README's tarball name is not ${manifest.version} — npm pack produces dsh-viewer-kit-${manifest.version}.tgz`,
  )
})

await test('the README states the exact number of tests this file declares', () => {
  // Counted statically rather than from `passed`, because the number cannot be
  // known until the run completes and this check runs part-way through it — a
  // live count would make the assertion depend on where in the file it sits.
  //
  // Exact, not "at least": the README drifted to 40 and 49 against a suite of
  // 90, and an understated number is just as wrong as an overstated one to a
  // reader deciding whether the project is tested. The cost is one README edit
  // whenever the suite grows, which is the point.
  const source = readFileSync(new URL(import.meta.url), 'utf8')
  const declared = (source.match(/^await test\(/gm) ?? []).length
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8')
  const claims = [...readme.matchAll(/(\d+) 项测试/g)]
  assert(claims.length > 0, 'the README states no test count')
  for (const claim of claims) {
    eq(Number(claim[1]), declared, `the README says ${claim[1]} tests; this file declares ${declared}`)
  }
})

await test('every screenshot the README shows exists, and every screenshot is shown', () => {
  // A renamed screenshot renders as five broken images on GitHub, and nothing in
  // the build notices. Both directions are checked, because an orphan file is
  // the other half of the same rot: it looks like documentation that exists.
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8')
  const referenced = [...readme.matchAll(/!\[[^\]]*\]\((docs\/imgs\/[^)]+)\)/g)].map((match) => match[1])
  assert(referenced.length > 0, 'the README shows no screenshots')

  for (const relative of referenced) {
    assert(existsSync(join(ROOT, relative)), `the README references a missing image: ${relative}`)
  }

  const shown = new Set(referenced)
  const onDisk = readdirSync(join(ROOT, 'docs', 'imgs')).map((name) => `docs/imgs/${name}`)
  const orphans = onDisk.filter((path) => !shown.has(path))
  eq(orphans, [], `screenshots sitting in docs/imgs that the README never shows: ${orphans.join(', ')}`)
})

// ---------------------------------------------------------------------------

process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`)
if (failures.length > 0) {
  for (const failure of failures) process.stderr.write(`  ✗ ${failure}\n`)
  process.exitCode = 1
}
