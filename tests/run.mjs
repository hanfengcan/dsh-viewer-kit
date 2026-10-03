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

import { readFileSync } from 'node:fs'
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
const { createHtmlRenderer } = await import('../src/client/renderers/html.js')

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

await test('the preview mounts a sandboxed frame and hides the source', () => {
  const { env } = mount(conversationFixture([{ nodeKey: 'n-1', html: codeBlockFixture({ lang: 'html', code: HTML_SAMPLE }) }]))
  eq(content(env.document).getAttribute('data-dvk-mode'), 'preview', 'it opened in preview')
  const f = frame(env.document)
  assert(f !== null, 'a preview frame exists')
  eq(f.parentNode, ourRoot(env.document), 'mounted inside our own root')
  eq(f.getAttribute('sandbox'), '', 'sandboxed with no privileges by default')
  eq(f.getAttribute('referrerpolicy'), 'no-referrer', 'no referrer leakage')
  assert(f.srcdoc.includes('<h1>Hello from the preview</h1>'), 'the authored document is the frame content')
  assert(f.srcdoc.startsWith('<meta charset="utf-8">'), 'charset declared')
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
  eq(run.env.document.querySelector('iframe').getAttribute('sandbox'), '', 'sandboxed with no capabilities')

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
    eq(run.live().kit.config().maxPreviewHeight, 520, 'maxPreviewHeight fell back to 520')
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

process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`)
if (failures.length > 0) {
  for (const failure of failures) process.stderr.write(`  ✗ ${failure}\n`)
  process.exitCode = 1
}
