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

await test('disabling by renderer id re-offers the block; disabling by fence name does not', () => {
  // Two renderers both claim a `json` block. The two tiers of
  // `disabledRendererIds` must be distinguishable, and this is the case that
  // tells them apart: a fence name that is not any renderer's id.
  const block = createRequest({ surface: 'code-block', lang: 'json', source: '[{"a":1}]' })
  const build = (ids) => {
    const kit = createKit({ config: { disabledRendererIds: ids } })
    kit.register(fakeRenderer('table', 5, () => true))
    kit.register(fakeRenderer('echarts', 8, () => true))
    return kit
  }

  eq(build(['table']).negotiate(block).id, 'echarts', 'id tier drops one claimant, the rest still bid')
  eq(build(['echarts', 'table']).negotiate(block), null, 'both claimants gone: native code view, not a crash')
  eq(build(['json']).negotiate(block), null, 'fence tier: no renderer is asked at all')
  eq(build(['nothing-matches-this']).negotiate(block).id, 'echarts', 'an unrelated id disables nothing')
})

await test('resolveConfig refuses a chart height that would render nothing', () => {
  // A canvas in a zero-height box draws nothing, and `typeof` cannot tell 0
  // from 360 — so this key gets a value check. Each of these must be able to
  // fail: if the check were removed, 0 and -1 would pass the type test.
  eq(resolveConfig({ chartHeight: 500 }).chartHeight, 500, 'a real height is kept')
  eq(resolveConfig({ chartHeight: 0 }).chartHeight, DEFAULT_CONFIG.chartHeight, 'zero falls back')
  eq(resolveConfig({ chartHeight: -1 }).chartHeight, DEFAULT_CONFIG.chartHeight, 'negative falls back')
  eq(resolveConfig({ chartHeight: Number.NaN }).chartHeight, DEFAULT_CONFIG.chartHeight, 'NaN falls back')
  eq(resolveConfig({ chartHeight: Number.POSITIVE_INFINITY }).chartHeight, DEFAULT_CONFIG.chartHeight, 'infinite falls back')
  eq(resolveConfig({ chartHeight: 'tall' }).chartHeight, DEFAULT_CONFIG.chartHeight, 'wrong type falls back')
})

await test('a renderer never re-declares a config default', () => {
  // Two copies of one default is the defect: change one and the other goes
  // stale silently. `kit.js` is the single place a resolved config is
  // produced, so a renderer that needs a default must read it from there.
  // These two identifiers were exactly that bug — a dead `MAX_FRAME_FLOOR`
  // and a `DEFAULT_CHART_HEIGHT` whose `||` fallback resolveConfig made
  // unreachable.
  const rendererDir = join(ROOT, 'src', 'client', 'renderers')
  for (const file of readdirSync(rendererDir)) {
    const source = readFileSync(join(rendererDir, file), 'utf8')
    for (const name of ['MAX_FRAME_FLOOR', 'DEFAULT_CHART_HEIGHT']) {
      eq(source.includes(name), false, `${file} must not declare ${name}`)
    }
  }
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
 * @param {{ config?: Record<string, unknown>, storage?: ShimStorage | null, renderers?: object[], layout?: { scrollHeight: number, clientHeight: number }, layoutOf?: (env: any) => void }} [options]
 */
function mount(html, options = {}) {
  const env = createEnvironment()
  // Before anything is scanned, so a renderer that inspects layout at mount time
  // (the table's `available()`) sees the numbers the test intended. Setting them
  // afterwards is too late — the surface has already asked.
  if (options.layout !== undefined) env.document.layout = options.layout
  parseHtml(html, env.document.body)
  // A hook for tests that must state a layout BEFORE anything is claimed: the
  // seam reads geometry while it mounts, so anything set afterwards is too
  // late, and a guard that quietly found no layout would still pass.
  options.layoutOf?.(env)
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

await test('a block that was only ever opened on the default remembers nothing', () => {
  // The view a block OPENS on is read from `defaultToPreview`. Recording it as
  // though the reader had chosen it freezes the setting on first sight, which
  // is what made `defaultToPreview` unchangeable for every block already seen.
  const storage = new ShimStorage()
  const first = mount(conversationFixture([{ nodeKey: 'n-1', html: codeBlockFixture({ lang: 'html', code: HTML_SAMPLE }) }]), { storage })
  eq(switcher(first.env.document).children[0].getAttribute('aria-pressed'), 'true', 'opened on preview, the shipped default')
  first.seam.dispose()
  eq(storage.getItem('dsh-viewer-kit:views:v1'), null, 'and left no record behind')

  // Same storage, opposite setting: the block follows the new default.
  const second = mount(
    conversationFixture([{ nodeKey: 'n-1', html: codeBlockFixture({ lang: 'html', code: HTML_SAMPLE }) }]),
    { storage, config: { defaultToPreview: false } },
  )
  eq(switcher(second.env.document).children[1].getAttribute('aria-pressed'), 'true', 'reopened on code, because the default changed')
})

await test('a view the reader did pick still survives a reload', () => {
  // The half of the behaviour worth keeping: memory records CHOICES. Written
  // against the same storage twice, so a pass means the entry is real rather
  // than a coincidence of the default.
  const storage = new ShimStorage()
  const html = conversationFixture([{ nodeKey: 'n-1', html: codeBlockFixture({ lang: 'html', code: HTML_SAMPLE }) }])
  const first = mount(html, { storage })
  click(switcher(first.env.document).children[1])
  first.seam.dispose()

  const second = mount(html, { storage })
  eq(switcher(second.env.document).children[1].getAttribute('aria-pressed'), 'true', 'the click was remembered')
  eq(frame(second.env.document), null, 'and the block reopened on code')
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

await test('a fence the host leaves plain is still taken over, because its content went quiet', async () => {
  // The shape says `plain` forever: DSH gives an `html` fence a real language
  // name but never wraps its body in the highlighter's `<div class="shiki">`, so
  // a seam that waits for that wrapper waits forever, spends its whole retry
  // budget, and abandons a block that has been finished for minutes. The source
  // stopped changing, which is the fact that matters.
  const { env, seam } = mount(
    conversationFixture([{ nodeKey: 'n-1', html: codeBlockFixture({ lang: 'html', code: HTML_SAMPLE, streaming: true }) }]),
  )
  eq(seam.size(), 0, 'not claimed on arrival: no observation yet')
  await sleep(PLAIN_SETTLE_MS * 2 + 120)
  eq(seam.size(), 1, 'claimed once the source has held still for two quiet periods')
  assert(switcher(env.document) !== null, 'and the switch is on the page')
})

await test('a claim is released when the source it was made from changes', async () => {
  // The other side of the same coin: content-stability can claim a fence a
  // moment before the stream resumes, and a preview of a truncated document is
  // wrong in the same silent way a missing switch is. Releasing it hands the
  // block back to the host, which shows the source again, and the next quiet
  // period re-claims it.
  const { env, seam } = mount(
    conversationFixture([{ nodeKey: 'n-1', html: codeBlockFixture({ lang: 'html', code: HTML_SAMPLE, streaming: true }) }]),
  )
  await sleep(PLAIN_SETTLE_MS * 2 + 120)
  eq(seam.size(), 1, 'claimed on the quiet source')
  const first = ourRoot(env.document)

  // The stream resumes: the source grows under the block we already took over.
  const c = content(env.document)
  c.querySelector('pre').textContent = `${HTML_SAMPLE}\n<!-- more to come -->`
  await tick()
  eq(seam.size(), 0, 'released the moment the source moved again')
  assert(first.parentNode === null, 'our nodes are gone, so the block is the host\'s again')
  eq(c.getAttribute('data-dvk-mode'), null, 'and the mode attribute with them')

  await sleep(PLAIN_SETTLE_MS * 2 + 120)
  eq(seam.size(), 1, 're-claimed once the new source goes quiet')
})

// ---------------------------------------------------------------------------
// scroll stability
//
// Claiming a block swaps a `<pre>` as tall as its source for a view capped at
// `maxPreviewHeight`. The content node generates no box, so that difference IS
// the block's height — and the conversation is a virtual list with an overscan
// window, so a block is routinely claimed several turns above the reader.
// Neither mechanism puts the reader's content back at that moment: the browser
// suppresses scroll anchoring during a scroll gesture, and the virtual list
// declines to correct the offset while the reader scrolls backward.
//
// The first tests drive the guard directly, so each of its decisions is checked
// on its own. The last two go through the seam, because a guard nothing calls
// would pass every one of the first kind.
// ---------------------------------------------------------------------------

const { keepingScrollPosition } = await import('../src/client/scroll-guard.js')

process.stdout.write('\nscroll stability\n')

/**
 * The smallest thing the guard can be pointed at: one scrolling container, its
 * viewport, and a block whose height the test moves.
 *
 * The block's band is STATED rather than derived from `scrollTop`, because what
 * each case turns on is where the block sits relative to the viewport, and a
 * test that had to compute that would be re-deriving the arithmetic the guard
 * is supposed to get right. `resizeTo` is the height change, applied inside the
 * call the guard wraps — the only moment the correction may observe it.
 *
 * `scrollHeight` TRACKS the block, because in a real conversation it does: the
 * block is a large share of the document, so when it collapses the document
 * collapses with it. That is the whole reason a correction has to be clamped,
 * and a fixture with a frozen scroll range cannot express it.
 *
 * @param {{ offset?: number, scrollHeight?: number, clientHeight?: number, top: number, height: number, followingTail?: boolean }} shape
 */
function scrollFixture(shape) {
  const env = createEnvironment()
  parseHtml('<div class="scroller"><div class="turn"><div class="block"></div></div></div>', env.document.body)
  const doc = env.document
  const scroller = doc.querySelector('.scroller')
  const block = doc.querySelector('.block')
  if (shape.followingTail === true) scroller.setAttribute('data-chat-following-tail', '')
  scroller.clientHeight = shape.clientHeight ?? 600
  scroller.scrollTop = shape.offset ?? 0
  const rest = shape.scrollHeight ?? 20000
  let height = shape.height
  // A getter, not a value: the document is re-measured on every read, so a
  // test that resizes the block also shortens the document, exactly as the
  // browser will.
  Object.defineProperty(scroller, 'scrollHeight', { get: () => rest + height, configurable: true })
  doc.layoutOf = (element) => {
    if (element === scroller) return { top: 0, height: scroller.clientHeight }
    if (element === block) return { top: shape.top, height }
    return null
  }
  return { doc, scroller, block, resizeTo: (next) => { height = next } }
}

/** How tall a block is once it is showing a capped preview. */
const PREVIEW_HEIGHT = 346
/** How tall the same block is showing a prototype document's source. */
const SOURCE_HEIGHT = 4000

await test('a block above the reading line that shrinks is undone, so the reader does not slide', () => {
  const { scroller, block, resizeTo } = scrollFixture({ offset: 10000, top: -4200, height: SOURCE_HEIGHT })
  keepingScrollPosition(block, () => resizeTo(PREVIEW_HEIGHT))
  eq(scroller.scrollTop, 10000 - (SOURCE_HEIGHT - PREVIEW_HEIGHT),
    'the offset moved by exactly the height the block lost')
})

await test('a block that only clips the top of the viewport is still corrected', () => {
  // The shape that actually reaches the reader: a long source arrives with a
  // sliver of its bottom edge showing and everything else already scrolled
  // past. Its bottom edge (220) is above the reading line (300), so what the
  // reader is looking at is content below it — and all of that just moved by
  // the block's whole height. Treating "some of it is visible" as "they are
  // watching it" is what let the offset go past the end of the document.
  const { scroller, block, resizeTo } = scrollFixture({ offset: 10000, top: -3780, height: SOURCE_HEIGHT })
  keepingScrollPosition(block, () => resizeTo(PREVIEW_HEIGHT))
  eq(scroller.scrollTop, 10000 - (SOURCE_HEIGHT - PREVIEW_HEIGHT),
    'clipped at the top is still "above the reading line", so the reader keeps their place')
})

await test('a block below the viewport never moves the reader', () => {
  // Growing a block below the viewport pushes down only what is BELOW it, which
  // the reader cannot see. Correcting here would move the page for nothing.
  const { scroller, block, resizeTo } = scrollFixture({ offset: 1000, top: 3000, height: 200 })
  keepingScrollPosition(block, () => resizeTo(800))
  eq(scroller.scrollTop, 1000, 'untouched: nothing the reader can see moved')
})

await test('a block the reader is looking at is left alone', () => {
  // Its bottom edge is far below the reading line, so the reader is inside the
  // block. The swap is the feature working; moving the page would be the
  // larger surprise.
  const { scroller, block, resizeTo } = scrollFixture({ offset: 1000, top: -100, height: SOURCE_HEIGHT })
  keepingScrollPosition(block, () => resizeTo(PREVIEW_HEIGHT))
  eq(scroller.scrollTop, 1000, 'the swap is visible to the reader, so the page is not moved under them')
})

await test('a list the host is pinning to its tail is left alone', () => {
  // The host re-derives an end-anchored offset from the total size, so it has
  // already absorbed this resize. Correcting on top of its own would move the
  // reader twice for one change. This is the host's state to read, not a
  // distance: the reader in the next test sits just as close to the end and is
  // not pinned, and only the host knows the difference.
  const { scroller, block, resizeTo } = scrollFixture({
    offset: 28405, top: -11581, height: SOURCE_HEIGHT, scrollHeight: 16576, followingTail: true,
  })
  keepingScrollPosition(block, () => resizeTo(PREVIEW_HEIGHT))
  eq(scroller.scrollTop, 28405, 'following the tail: the host owns that offset')
})

await test('a reader near the end who is NOT following the tail is still corrected', () => {
  // The captured failure, verbatim: offset 15,938 of a floor of 16,964, and a
  // block 15,724px tall whose bottom edge clips 121px into the viewport. A
  // "near the end?" test run after the resize compares this offset against the
  // NEW scrollHeight, finds it past the end, and concludes the reader is
  // pinned — skipping the one correction that keeps their position valid, and
  // leaving the browser to clamp them to the new end.
  const TALL = 15724
  const { scroller, block, resizeTo } = scrollFixture({ offset: 15938, scrollHeight: 1840, top: -15603, height: TALL })
  keepingScrollPosition(block, () => resizeTo(PREVIEW_HEIGHT))
  eq(scroller.scrollTop, 15938 - (TALL - PREVIEW_HEIGHT),
    'corrected, not mistaken for pinned: the offset is legal in the shorter document')
  assert(scroller.scrollTop < scroller.scrollHeight - scroller.clientHeight,
    'and it is not sitting on the new end, which is where an uncorrected reader lands')
})

await test('the correction is clamped at the top of the document', () => {
  // Reachable, and only with a small block near the top: the content below it
  // moves up by more than the distance from the document's start to the
  // reader, so the step overshoots 0.
  const { scroller, block, resizeTo } = scrollFixture({ offset: 100, top: -100, height: 380 })
  keepingScrollPosition(block, () => resizeTo(100))
  eq(scroller.scrollTop, 0, 'a step past the start stops at 0 rather than going negative')
})

await test('the change still runs when there is no scroller and no layout to correct against', () => {
  const env = createEnvironment()
  const lone = env.document.createElement('div')
  env.document.body.appendChild(lone)
  eq(keepingScrollPosition(lone, () => 'ran'), 'ran', 'nothing to correct, so the change is not skipped')
  assert(lone.getBoundingClientRect().height === 0, 'an element with no described layout reports no box')
})

await test('claiming a block above the reader leaves their scroll offset alone', () => {
  const { env } = mount(
    `<div class="scroller">${conversationFixture([{ nodeKey: 'n-1', html: codeBlockFixture({ lang: 'html', code: HTML_SAMPLE }) }])}</div>`,
    {
      layoutOf: (/** @type {any} */ e) => {
        const doc = e.document
        const scroller = doc.querySelector('.scroller')
        const blk = doc.querySelector('.md-code-block')
        scroller.clientHeight = 600
        scroller.scrollHeight = 20000
        scroller.scrollTop = 10000
        // Keyed off the block's own mode, because that is the attribute the
        // stylesheet keys the hide/show off — so the height really does change
        // when the claim swaps the source out for a preview. NOT off `.dvk-view`
        // existing: the view root is appended before the switch runs, and an
        // empty one is `display: none`, so it changes nothing on its own.
        doc.layoutOf = (node) => {
          if (node === scroller) return { top: 0, height: 600 }
          if (node === blk) {
            const preview = content(doc).getAttribute('data-dvk-mode') === 'preview'
            return { top: -4200, height: preview ? PREVIEW_HEIGHT : SOURCE_HEIGHT }
          }
          return null
        }
      },
    },
  )
  const scroller = env.document.querySelector('.scroller')
  eq(content(env.document).getAttribute('data-dvk-mode'), 'preview', 'the block was claimed and opened in preview')
  eq(scroller.scrollTop, 10000 - (SOURCE_HEIGHT - PREVIEW_HEIGHT),
    'the reader is exactly where they were before the block above them collapsed')
})

await test('claiming a block the reader is looking at does not move them', () => {
  const { env } = mount(
    `<div class="scroller">${conversationFixture([{ nodeKey: 'n-1', html: codeBlockFixture({ lang: 'html', code: HTML_SAMPLE }) }])}</div>`,
    {
      layoutOf: (/** @type {any} */ e) => {
        const doc = e.document
        const scroller = doc.querySelector('.scroller')
        const blk = doc.querySelector('.md-code-block')
        scroller.clientHeight = 600
        scroller.scrollHeight = 20000
        scroller.scrollTop = 1000
        doc.layoutOf = (node) => {
          if (node === scroller) return { top: 0, height: 600 }
          if (node === blk) {
            const preview = content(doc).getAttribute('data-dvk-mode') === 'preview'
            return { top: -200, height: preview ? PREVIEW_HEIGHT : SOURCE_HEIGHT }
          }
          return null
        }
      },
    },
  )
  eq(env.document.querySelector('.scroller').scrollTop, 1000, 'the page stays put for a visible swap')
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
// height caps and the enlarge affordance
//
// Two separate defects, one shared cause. The table view's stylesheet used to
// read `max-height: inherit`, which took the parent `.dvk-view` — a box that
// sets only padding — and therefore computed to `none`. The cap was not applied
// and, because the wrap then never scrolled, the sticky header had no bounded
// scrollport to stick to either: two declarations that looked like they were
// doing the work and did nothing. A 500-row table grew the conversation to
// roughly 13,000px.
//
// The cap and the enlarge control are a pair on purpose. Capping alone would
// take away the only way to see every row at once, which is what capping was
// supposed to improve.
// ---------------------------------------------------------------------------

process.stdout.write('\nheight caps and enlarge\n')

/** A CSV with `count` data rows, so the table is taller than any cap. */
const tallCsv = (count) => {
  const rows = ['name,value']
  for (let index = 0; index < count; index += 1) rows.push(`row-${index},${index}`)
  return rows.join('\n')
}

/** @param {import('./dom-shim.mjs').ShimDocument} doc */
const expandButton = (doc) => doc.querySelector('[data-dvk-action="expand"]')

await test('a table is capped, and the cap comes from config rather than a stylesheet constant', () => {
  const table = createTableRenderer((_key, fallback) => fallback)
  const long = tallCsv(400)
  const { env } = mount(conversationFixture([
    { nodeKey: 'n-1', html: codeBlockFixture({ lang: 'csv', code: long }) },
  ]), { renderers: [table], config: { maxTableHeight: 300 } })

  const wrap = env.document.querySelector('.dvk-table-wrap')
  assert(wrap !== null, 'the table wrap exists')
  eq(wrap.style.maxHeight, '300px', 'the configured cap is applied inline')

  // And the default, so a config that never mentions it is still capped rather
  // than silently uncapped.
  const plain = mount(conversationFixture([
    { nodeKey: 'n-1', html: codeBlockFixture({ lang: 'csv', code: long }) },
  ]), { renderers: [table] })
  eq(plain.env.document.querySelector('.dvk-table-wrap').style.maxHeight, '480px', 'default cap')
})

await test('a cap of zero or a negative number is refused rather than blanking the table', () => {
  // The same reasoning as chartHeight: a value the reader cannot see is worse
  // than the default. A `max-height: 0` table would render as a sliver.
  eq(resolveConfig({ maxTableHeight: 0 }).maxTableHeight, 480, 'zero falls back')
  eq(resolveConfig({ maxTableHeight: -10 }).maxTableHeight, 480, 'negative falls back')
  eq(resolveConfig({ maxTableHeight: 'tall' }).maxTableHeight, 480, 'wrong type falls back')
  eq(resolveConfig({ maxTableHeight: 900 }).maxTableHeight, 900, 'a real value is kept')
})

await test('enlarging a table lifts the cap in place, and only for that table', () => {
  const table = createTableRenderer((_key, fallback) => fallback)
  const { env } = mount(conversationFixture([
    { nodeKey: 'n-1', html: codeBlockFixture({ lang: 'csv', code: tallCsv(400) }) },
    { nodeKey: 'n-2', html: codeBlockFixture({ lang: 'csv', code: tallCsv(5) }) },
  ]), { renderers: [table] })

  const wraps = env.document.querySelectorAll('.dvk-table-wrap')
  eq(wraps.length, 2, 'both blocks rendered a table')
  const buttons = env.document.querySelectorAll('[data-dvk-action="expand"]')
  // The shim has no layout engine, so it reports 0/0 and the table's
  // `available()` treats that as "not measured" and offers the control. The
  // genuinely-short-table case is covered by its own test below.
  eq(buttons.length, 2, 'both blocks offer enlarge')

  click(buttons[0])
  eq(wraps[0].style.maxHeight, '', 'the first table is no longer capped')
  eq(wraps[1].style.maxHeight, '480px', 'the second table is untouched')
  eq(buttons[0].getAttribute('aria-expanded'), 'true', 'the button reports the state')

  click(buttons[0])
  eq(wraps[0].style.maxHeight, '480px', 'pressing again puts the cap back')
  eq(buttons[0].getAttribute('aria-expanded'), 'false', 'and the button follows')
})

await test('a table that is not clipped offers no enlarge control', () => {
  // A table shorter than its cap is never clipped, so removing the cap repaints
  // no pixel and the control would be a no-op. `layout` describes what a browser
  // would compute, and it has to be set BEFORE mounting because the renderer is
  // asked at mount time.
  const table = createTableRenderer((_key, fallback) => fallback)
  const rows = conversationFixture([
    { nodeKey: 'n-1', html: codeBlockFixture({ lang: 'csv', code: 'a,b\n1,2' }) },
  ])

  const fits = mount(rows, { renderers: [table], layout: { scrollHeight: 180, clientHeight: 180 } })
  eq(expandButton(fits.env.document), null, 'a control that would do nothing is not drawn')

  const clipped = mount(rows, { renderers: [table], layout: { scrollHeight: 900, clientHeight: 480 } })
  assert(expandButton(clipped.env.document) !== null, 'an overflowing table gets the control')

  // And a shim that reports nothing measured keeps offering it: guessing "yes"
  // costs an unhelpful button, guessing "no" would hide the only way to see a
  // clipped table.
  const unmeasured = mount(rows, { renderers: [table] })
  assert(expandButton(unmeasured.env.document) !== null, '0/0 reads as "not measured", not as "it fits"')
})

await test('the enlarge control is an icon from DSH own set, not a text button', () => {
  // Matches the copy and branch buttons DSH draws in the same banner. The glyph
  // is DSH's `IconFullscreenOutline` artwork, inlined rather than imported
  // because the shipped icons are React components and this plugin is plain DOM.
  const table = createTableRenderer((_key, fallback) => fallback)
  const { env } = mount(conversationFixture([
    { nodeKey: 'n-1', html: codeBlockFixture({ lang: 'csv', code: tallCsv(400) }) },
  ]), { renderers: [table] })

  const button = expandButton(env.document)
  const svg = button.querySelector('svg')
  assert(svg !== null, 'the button draws an svg')
  eq(svg.namespaceURI, 'http://www.w3.org/2000/svg', 'built in the SVG namespace, not as an inert HTML element')
  eq(svg.getAttribute('viewBox'), '0 0 16 16', "DSH's icon grid")
  eq(svg.getAttribute('aria-hidden'), 'true', 'decorative: the button already carries the name')
  eq(button.textContent, '', 'no text label')
  // An icon-only control must still be nameable.
  eq(button.getAttribute('aria-label'), 'Enlarge', 'the accessible name')
  eq(button.getAttribute('title'), 'Enlarge', 'and a hover title, the pair DSH sets')
})

await test('the enlarge control has no styling of its own for its state', async () => {
  // A state rule and `:hover` have equal specificity, so whichever comes later
  // wins. A rule keyed on the state, placed after the hover rule, makes the
  // hover tint unreachable — silently, because both rules are individually
  // valid. Owning no state styling at all is what makes that impossible.
  const { STYLES } = await import('../src/client/styles.js')
  const expandBlock = STYLES.slice(STYLES.indexOf('.dvk-expand {'))
  const rules = expandBlock.slice(0, expandBlock.indexOf('/* Enlarged preview'))
  eq(/\.dvk-expand:hover/.test(rules), true, 'there is a hover rule')
  eq(/\.dvk-expand\[aria-(pressed|expanded)/.test(rules), false, 'and no rule keyed on the state')
})

await test('a table remembers its enlarged state across a view switch', () => {
  // `enter` empties the view root, so a flag that lived only in the DOM would
  // silently reset the moment the user looked at the source and came back.
  const table = createTableRenderer((_key, fallback) => fallback)
  const { env } = mount(conversationFixture([
    { nodeKey: 'n-1', html: codeBlockFixture({ lang: 'csv', code: tallCsv(400) }) },
  ]), { renderers: [table] })

  const sw = switcher(env.document)
  click(expandButton(env.document))
  click(sw.children[1])
  eq(env.document.querySelector('.dvk-table-wrap'), null, 'the code view mounts nothing')
  click(sw.children[0])
  eq(env.document.querySelector('.dvk-table-wrap').style.maxHeight, '', 'the enlarged state survived the round trip')
})

await test('the code view offers no enlarge control, because there is nothing to enlarge', () => {
  const table = createTableRenderer((_key, fallback) => fallback)
  const { env } = mount(conversationFixture([
    { nodeKey: 'n-1', html: codeBlockFixture({ lang: 'csv', code: tallCsv(400) }) },
  ]), { renderers: [table] })
  click(switcher(env.document).children[1])
  eq(expandButton(env.document), null, 'no button while the source is showing')
  click(switcher(env.document).children[0])
  assert(expandButton(env.document) !== null, 'it comes back with the table')
})

await test('an html preview enlarges into a dialog that shows the whole document', async () => {
  const { env } = mount(conversationFixture([
    { nodeKey: 'n-1', html: codeBlockFixture({ lang: 'html', code: HTML_SAMPLE }) },
  ]))
  eq(env.document.querySelector('dialog'), null, 'no dialog until asked')

  click(expandButton(env.document))
  const dialog = env.document.querySelector('dialog')
  assert(dialog !== null, 'a dialog was opened')
  eq(dialog.open, true, 'it is a modal, which is what lifts it into the top layer')
  // `parentNode`, not `parentElement`: the shim has no `parentElement`, and a
  // test that quietly reads `undefined.tagName` fails on the wrong thing.
  eq(dialog.parentNode?.tagName, 'BODY', 'it lives on the body, not inside the recycled block')

  const big = dialog.querySelector('iframe')
  assert(big !== null, 'the enlarged frame is there')
  // A short document is shown at its own height, not stretched to fill the
  // dialog: the dialog has a max-height but no height, so it shrinks to its
  // content and there is no empty band anywhere.
  const shortHeight = Number(big.style.height.replace('px', ''))
  assert(shortHeight > 0 && shortHeight < 400, `a short document keeps its own height, got ${big.style.height}`)
  eq(dialog.querySelector('[data-dvk-modal-close]') !== null, true, 'there is a close control')
  await tick()
})

await test('the enlarged dialog is capped by the viewport, not by maxPreviewHeight', () => {
  // The whole reason the dialog exists: a long report must not be squeezed into
  // the 320px the inline view uses. The cap is 86% of the viewport, so on the
  // shim's 900px window it is 774px — comfortably more than 320, and derived
  // from the window rather than hard-coded.
  const long = `<body>${'<p>line of report text</p>'.repeat(400)}</body>`
  const { env } = mount(conversationFixture([
    { nodeKey: 'n-1', html: codeBlockFixture({ lang: 'html', code: long }) },
  ]))

  click(expandButton(env.document))
  const big = env.document.querySelector('dialog iframe')
  const height = Number(big.style.height.replace('px', ''))
  eq(height, Math.round(900 * 0.86), 'the frame took the viewport share')
  assert(height > 320, 'which is much more room than the inline preview gets')

  // And a different window gives a different answer, which is the property a
  // pixel constant would fail.
  env.document.defaultView.innerHeight = 1600
  click(expandButton(env.document))
  eq(env.document.querySelector('dialog'), null, 'toggling closed the first dialog')
  click(expandButton(env.document))
  eq(
    Number(env.document.querySelector('dialog iframe').style.height.replace('px', '')),
    Math.round(1600 * 0.86),
    'a taller window enlarges further',
  )
})

await test('the enlarged dialog never grants more than the inline frame does', () => {
  // Both are opaque-origin sandboxes. The enlarged one still needs
  // `allow-scripts` for the measuring script under the default mode, and the
  // same nonce policy refuses the model's own scripts — the two layers are
  // independent there too, so widening the dialog cannot widen the preview.
  const { env } = mount(conversationFixture([
    { nodeKey: 'n-1', html: codeBlockFixture({ lang: 'html', code: HTML_SAMPLE }) },
  ]))
  click(expandButton(env.document))
  const big = env.document.querySelector('dialog iframe')
  eq(big.getAttribute('sandbox'), 'allow-scripts', 'scripts only, same-origin still withheld')
  assert(big.srcdoc.includes('Content-Security-Policy'), 'the nonce policy is there too')
  assert(!big.srcdoc.includes('allow-same-origin'), 'and same-origin is nowhere in it')
})

await test('closing the enlarged dialog leaves the conversation exactly as it was', async () => {
  const { env, seam } = mount(conversationFixture([
    { nodeKey: 'n-1', html: codeBlockFixture({ lang: 'html', code: HTML_SAMPLE }) },
  ]))
  click(expandButton(env.document))
  eq(env.document.querySelector('dialog') !== null, true, 'open')
  click(env.document.querySelector('[data-dvk-modal-close]'))
  eq(env.document.querySelector('dialog'), null, 'the node is gone')
  eq(env.document.openDialogs, 0, 'and the top layer was released, so the page is interactive again')
  // The inline preview is untouched by the dialog's whole lifecycle.
  assert(env.document.querySelector('iframe') !== null, 'the inline frame is still mounted')
  eq(env.document.querySelectorAll('iframe').length, 1, 'and no second frame was left behind')

  // And disposing the block closes an open dialog rather than orphaning it over
  // the whole app — the virtualised conversation removes nodes without warning.
  click(expandButton(env.document))
  eq(env.document.querySelector('dialog') !== null, true, 'open again')
  block(env.document).remove()
  // Removal is discovered by the seam's MutationObserver, so it is not
  // synchronous; without this tick the assertion below would be testing the
  // wrong moment and would pass for the wrong reason if the code regressed.
  await tick()
  eq(env.document.querySelector('dialog'), null, 'a removed block does not leave a dialog behind')
  eq(env.document.openDialogs, 0, 'nor leave the page inert')
})

await test('the enlarge control is a sibling of the view switch, not one of its views', () => {
  // The switcher's children are the views and existing assertions index them by
  // position. An action masquerading as a third view would change what
  // `children[2]` means to all of them — and, borrowing the switch item class,
  // would also make it LOOK like a selected view rather than a button.
  const table = createTableRenderer((_key, fallback) => fallback)
  const { env } = mount(conversationFixture([
    { nodeKey: 'n-1', html: codeBlockFixture({ lang: 'csv', code: tallCsv(400) }) },
  ]), { renderers: [table] })
  const sw = switcher(env.document)
  eq(sw.children.map((b) => b.getAttribute('data-dvk-view')), ['table', 'code'], 'the switch still holds exactly the views')
  eq(sw.querySelector('[data-dvk-action="expand"]'), null, 'the control is not inside the switch')
  const button = expandButton(env.document)
  assert(button !== null, 'it is next to it in the banner')
  eq(button.className, 'dvk-expand', 'and it carries its own class, not the switch item class')
})

await test('closing the enlarged dialog with ESC clears the enlarge button', () => {
  // A modal dialog makes the page inert, so while it is open the button cannot
  // be pressed a second time. The reader leaves with ESC or a backdrop click,
  // and the surface only learns about it from the dialog's own `close` event.
  const { env } = mount(conversationFixture([
    { nodeKey: 'n-1', html: codeBlockFixture({ lang: 'html', code: HTML_SAMPLE }) },
  ]))
  const button = expandButton(env.document)
  click(button)
  eq(button.getAttribute('aria-expanded'), 'true', 'reported as expanded while the dialog is open')

  // The shim's `close()` is what the browser does on ESC and on a backdrop
  // click, and it fires the same `close` event the dialog listens for.
  const dialog = env.document.querySelector('dialog')
  assert(dialog !== null, 'a dialog is open')
  dialog.close()
  eq(env.document.querySelector('dialog'), null, 'the dialog cleaned itself up')
  eq(env.document.openDialogs, 0, 'and the page is interactive again')
  eq(button.getAttribute('aria-expanded'), 'false', 'and the button stopped claiming to be expanded')
})

await test('every enlarge string exists in both dictionaries', async () => {
  // A missing key does not fail loudly: `t` falls back to the English literal,
  // so the UI silently shows the wrong language. Asking the dictionary directly
  // is the only way this can fail.
  const { DICTIONARIES } = await import('../src/client/locale.js')
  for (const key of ['expand.label', 'html.modalTitle', 'html.modalClose']) {
    eq(typeof DICTIONARIES.en[key], 'string', `en is missing ${key}`)
    eq(typeof DICTIONARIES.zh[key], 'string', `zh is missing ${key}`)
  }
  eq(DICTIONARIES.zh['expand.label'], '放大', 'and it is actually translated')
  // Every key present in one language must be present in the other, or a
  // language silently falls back for whatever was added last.
  eq(
    Object.keys(DICTIONARIES.en).sort().join(),
    Object.keys(DICTIONARIES.zh).sort().join(),
    'the two dictionaries cover the same keys',
  )
})

await test('a renderer with nothing to enlarge grows no control at all', () => {
  // A button that does nothing is worse than no button. The built-in `code`
  // view mounts nothing, so it has nothing to enlarge and must not offer.
  const { env } = mount(conversationFixture([
    { nodeKey: 'n-1', html: codeBlockFixture({ lang: 'html', code: HTML_SAMPLE }) },
  ]))
  assert(expandButton(env.document) !== null, 'offered on the preview view')

  click(switcher(env.document).children[1])
  eq(expandButton(env.document), null, 'no control while the source is showing')

  click(switcher(env.document).children[0])
  assert(expandButton(env.document) !== null, 'and it comes back with the preview')
  eq(expandButton(env.document).getAttribute('aria-expanded'), 'false', 'reporting a closed state, not a stale one')
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

await test('apply() actually enhances a block — no silent per-block failure', async () => {
  const run = activateBundle(BUNDLE, { fixtureHtml: ACTIVATION_FIXTURE })
  assert(run.applied.ok, 'apply() did not throw')
  assert(await run.whenReady(), 'activation never reached the point of building a seam')
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

await test('a host that already carries our namespace does not fail the entry', async () => {
  const locale = createLocaleService()
  locale.register('dsh-viewer-kit', { en: { 'view.code': 'Code' }, zh: { 'view.code': '代码' } })
  const run = activateBundle(BUNDLE, { fixtureHtml: ACTIVATION_FIXTURE, services: { locale } })
  assert(run.applied.ok, `apply() threw: ${run.applied.error?.message}`)
  assert(await run.whenReady(), 'activation never reached the point of building a seam')
  eq(run.switches, 1, 'still enhances with a pre-registered namespace')
})

await test('a claimed block opens in preview without any click', async () => {
  const run = activateBundle(BUNDLE, { fixtureHtml: ACTIVATION_FIXTURE })
  eq(run.applied.ok, true, 'apply() did not throw')
  assert(await run.whenReady(), 'activation never reached the point of building a seam')
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

await test('switching to code drops the preview and leaves the source intact', async () => {
  const run = activateBundle(BUNDLE, { fixtureHtml: ACTIVATION_FIXTURE })
  assert(await run.whenReady(), 'activation never reached the point of building a seam')
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

/**
 * Stand in for the host half's `GET /dsh-viewer-kit/config`.
 *
 * Returns a `fetch` that answers one JSON object, so a test can drive the real
 * bridge rather than the shortcut below it.
 *
 * @param {Record<string, unknown> | null} body
 * @returns {(url: string, init?: object) => Promise<{ ok: boolean, status: number, json: () => Promise<unknown> }>}
 */
function hostSays(body) {
  return (url, init) => {
    hostConfigRequests.push(url)
    if (body === null) return Promise.resolve({ ok: false, status: 404 })
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) })
  }
}

/** @type {string[]} */
const hostConfigRequests = []

await test('the host config route governs the first scan, not just later ones', async () => {
  // The whole point of the bridge. Before it, a patch row's `config:` block
  // stopped at the host fiber and every block rendered at the defaults.
  const run = activateBundle(BUNDLE, {
    fixtureHtml: ACTIVATION_FIXTURE,
    fetch: hostSays({ defaultToPreview: false, htmlAllowScripts: true }),
  })
  assert(await run.whenReady(), 'activation never reached the point of building a seam')

  eq(hostConfigRequests.length > 0, true, 'the client asked the host for its config')
  eq(run.mode(), 'code', "the host's setting decided the very first view")
  eq(run.env.document.querySelector('iframe'), null, 'nothing is previewed')
  eq(run.live().configSource, 'host', 'the kit records where the config came from')
  eq(run.live().kit.config().defaultToPreview, false, 'the kit reports the resolved config')
})

await test('a height the host sends is applied to the first render, with no jump', async () => {
  // The reason the seam is built only after the config lands. If it were built
  // first, this block would mount at 320 and then have to be re-negotiated.
  const run = activateBundle(BUNDLE, {
    fixtureHtml: ACTIVATION_FIXTURE,
    fetch: hostSays({ maxPreviewHeight: 520 }),
  })
  assert(await run.whenReady(), 'activation never reached the point of building a seam')
  eq(run.live().kit.config().maxPreviewHeight, 520, "the host's number survived the round trip")
})

await test('a config URL is resolved against the page, not the domain root', async () => {
  // dshmarket shipped root-absolute fetches and had to fix them: under a path
  // prefix, `/dsh-market/status` leaves the mount point entirely.
  hostConfigRequests.length = 0
  const run = activateBundle(BUNDLE, { fixtureHtml: ACTIVATION_FIXTURE, fetch: hostSays({}) })
  assert(await run.whenReady(), 'activation never reached the point of building a seam')
  const asked = hostConfigRequests[0] ?? ''
  eq(asked.startsWith('/dsh-viewer-kit/config'), true, `asked for ${JSON.stringify(asked)}`)
})

await test('an absent host half renders with defaults rather than failing', async () => {
  // The bundle has to keep working on its own: a 404 is what a host without
  // this plugin's host half answers, and it must be indistinguishable from
  // "everything is at its default".
  const run = activateBundle(BUNDLE, { fixtureHtml: ACTIVATION_FIXTURE, fetch: hostSays(null) })
  assert(await run.whenReady(), 'a 404 must still reach the scan')
  eq(run.switches, 1, 'still enhances')
  eq(run.mode(), 'preview', 'default view is preview')
  eq(run.live().configSource, 'defaults', 'the kit says where the config came from')
  assert(run.log.some((line) => line.includes('from defaults')), 'the log names the fallback')
})

await test('a row config, if one ever arrives, is used without a round trip', () => {
  // A shortcut, not the production path: the boot wire carries no config, so
  // this argument is always `undefined` in a browser today. It exists so a
  // future DSH that starts sending one is picked up for free — and so
  // `tools/probe-host.mjs` has somewhere to land when it does.
  const run = activateBundle(BUNDLE, {
    fixtureHtml: ACTIVATION_FIXTURE,
    rowConfig: { defaultToPreview: false },
  })
  eq(run.applied.ok, true, 'apply() did not throw')
  eq(run.mode(), 'code', 'the row config won over the shipped default')
  eq(run.env.document.querySelector('iframe'), null, 'nothing is previewed')
  eq(run.live().kit.config().defaultToPreview, false, 'the kit reports the resolved config')
})

await test('a row config can turn on scripts for the html preview', () => {
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

await test('a config the client half cannot use degrades to defaults', async () => {
  // The two halves are strict/lenient on purpose. The host rejects a bad value
  // loudly, so a value the client cannot accept means the two disagree — and
  // defaults are a working answer where throwing would be a failed web boot.
  // Each case names the key it is about, so a regression points at one field.
  const cases = [
    { body: { maxPreviewHeight: 'tall' }, key: 'maxPreviewHeight', expected: 320 },
    { body: { maxPreviewHeight: 0 }, key: 'maxPreviewHeight', expected: 320 },
    { body: { maxPreviewHeight: -5 }, key: 'maxPreviewHeight', expected: 320 },
    { body: { chartHeight: 0 }, key: 'chartHeight', expected: 360 },
    { body: { chartHeight: 'big' }, key: 'chartHeight', expected: 360 },
    { body: { previewHeightMode: 'stretch' }, key: 'previewHeightMode', expected: 'measure' },
    { body: { defaultToPreview: 'yes' }, key: 'defaultToPreview', expected: true },
    { body: { enabled: 1 }, key: 'enabled', expected: true },
    { body: { maxSourceBytes: 10.5 }, key: 'maxSourceBytes', expected: 262144 },
    { body: { disabledRendererIds: 'html' }, key: 'disabledRendererIds', expected: 0 },
  ]
  for (const { body, key, expected } of cases) {
    const run = activateBundle(BUNDLE, { fixtureHtml: ACTIVATION_FIXTURE, fetch: hostSays(body) })
    assert(await run.whenReady(), `activation stalled for ${JSON.stringify(body)}`)
    const actual = key === 'disabledRendererIds' ? run.live().kit.config()[key].length : run.live().kit.config()[key]
    eq(actual, expected, `${key} from ${JSON.stringify(body)}`)
  }
  // A good value in the same object must survive alongside a bad one, or the
  // lenient path would be "ignore the whole config" in disguise.
  const mixed = activateBundle(BUNDLE, {
    fixtureHtml: ACTIVATION_FIXTURE,
    fetch: hostSays({ maxPreviewHeight: 'tall', defaultToPreview: false }),
  })
  assert(await mixed.whenReady(), 'activation stalled')
  eq(mixed.live().kit.config().maxPreviewHeight, 320, 'the bad key fell back')
  eq(mixed.live().kit.config().defaultToPreview, false, 'the good key was kept')
})

await test('a malformed row config degrades to defaults instead of failing the entry', async () => {
  // Whichever path a bad value arrives by, the entry must survive — a failed
  // entry is a failed web boot.
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
    assert(await run.whenReady(), `activation stalled for rowConfig=${JSON.stringify(rowConfig)}`)
    eq(run.switches, 1, 'still enhances')
    // Wrong-typed fields fall back to the shipped default rather than breaking.
    eq(run.live().kit.config().defaultToPreview, true, 'defaultToPreview fell back to true')
    eq(run.live().kit.config().maxPreviewHeight, 320, 'maxPreviewHeight fell back to 320')
  }
  eq({}.polluted, undefined, 'no prototype pollution leaked out')
})

await test('preview mounts from the shipped bundle and unload restores the page', async () => {
  const run = activateBundle(BUNDLE, { fixtureHtml: ACTIVATION_FIXTURE })
  assert(await run.whenReady(), 'activation never built a seam')
  const sw = run.env.document.querySelector('[data-dvk-switch]')
  assert(sw !== null, 'view switch present')
  assert(run.env.document.querySelector('iframe') !== null, 'preview mounts')

  run.unload()
  eq(run.env.document.querySelector('[data-dvk-switch]'), null, 'our switch is gone')
  eq(run.env.document.querySelector('style[data-plugin="dsh-viewer-kit"]'), null, 'our stylesheet is gone')
})

await test('unloading while the config is still in flight does not resurrect the plugin', async () => {
  // A race the async bridge introduced. DSH can unload an entry while the
  // config request is outstanding; the answer then arrives into an activation
  // that no longer exists. Without the `disposed` guard in `start`, that
  // answer would build a seam, append a switch, and never be cleaned up — a
  // plugin that survives its own disposal.
  let release
  const run = activateBundle(BUNDLE, {
    fixtureHtml: ACTIVATION_FIXTURE,
    fetch: () =>
      new Promise((done) => {
        release = () => done({ ok: true, status: 200, json: () => Promise.resolve({ maxPreviewHeight: 400 }) })
      }),
  })

  eq(run.switches, 0, 'nothing is enhanced while the config is outstanding')
  run.unload()
  release()
  for (let attempt = 0; attempt < 30; attempt++) await new Promise((done) => setTimeout(done, 0))

  eq(run.switches, 0, 'the late answer did not build a seam')
  eq(run.env.document.querySelector('iframe'), null, 'and mounted no preview')
  eq(run.hook, 'undefined', 'the diagnostic hook stayed gone')
  eq(run.log.filter((line) => line.startsWith('ERROR')), [], 'and logged nothing alarming')
})

await test('unload leaves the native code block byte-identical', async () => {
  const run = activateBundle(BUNDLE, { fixtureHtml: ACTIVATION_FIXTURE })
  assert(await run.whenReady(), 'activation never built a seam')
  run.unload()
  const pre = run.env.document.querySelector('[data-code-block-content] pre')
  eq(pre.textContent, HTML_SAMPLE, 'source untouched')
  eq(run.env.document.querySelector('[data-code-block-content]').getAttribute('data-dvk-mode'), null, 'our attribute removed')
})

await test('re-activating retires the previous activation instead of stacking switches', async () => {
  // DSH re-materialises a client bundle on HMR and on re-enable. Two live
  // activations each build their own seam with their own element bookkeeping,
  // so both would append a switch to every block — which is exactly the row of
  // duplicate buttons this guards against. The re-activation is also async now,
  // so the assertion has to wait for the second seam to exist before counting.
  const run = activateBundle(BUNDLE, { fixtureHtml: ACTIVATION_FIXTURE })
  assert(await run.whenReady(), 'first activation never built a seam')
  eq(run.switches, 1, 'first activation: one switch')

  run.loaded.apply(run.ctx)
  assert(await run.whenReady(), 'second activation never built a seam')
  eq(run.switches, 1, 'second activation must not add a second switch')
  eq(run.env.document.querySelectorAll('style[data-plugin="dsh-viewer-kit"]').length, 1, 'exactly one stylesheet')

  run.loaded.apply(run.ctx)
  run.loaded.apply(run.ctx)
  assert(await run.whenReady(), 'fourth activation never built a seam')
  eq(run.switches, 1, 'still exactly one switch after four activations')
  eq(run.env.document.querySelectorAll('style[data-plugin="dsh-viewer-kit"]').length, 1, 'still one stylesheet')
})

await test('a stray switch left in a banner is cleared before ours is added', async () => {
  const run = activateBundle(BUNDLE, { fixtureHtml: ACTIVATION_FIXTURE })
  assert(await run.whenReady(), 'first activation never built a seam')
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
  assert(await run.whenReady(), 'the re-activation never rebuilt the seam')

  eq(run.env.document.querySelectorAll('[data-dvk-switch]').length, 1, 'back to exactly one switch')
  eq(run.env.document.querySelectorAll('[data-dvk-root]').length, 1, 'back to exactly one view root')
  eq(run.env.document.querySelector('[data-stray="switch"]'), null, 'the stray switch was the one removed')
  eq(run.env.document.querySelector('[data-stray="root"]'), null, 'the stray root was the one removed')
})

await test('a host without a locale service still activates', async () => {
  const run = activateBundle(BUNDLE, { fixtureHtml: ACTIVATION_FIXTURE, withLocale: false })
  assert(run.applied.ok, 'apply() did not throw without a locale service')
  assert(await run.whenReady(), 'activation never built a seam')
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
// the host -> client config bridge
//
// The configuration a user writes in `cordis.patch.yml` lands on the HOST
// fiber; rendering happens in the browser; the boot wire carries no config. So
// the host publishes it over one HTTP route and the client fetches it before
// its first scan. `loadHostConfig` is tested here as a plain function, with its
// clock and network injected, because the interesting failures — a hanging
// request, a body that is not a config — are exactly the ones a fake timer can
// reproduce deterministically and a live activation cannot.
// ---------------------------------------------------------------------------

const { loadHostConfig, configUrl, CONFIG_PATH, CONFIG_TIMEOUT_MS } = await import(
  '../src/client/host-config.js'
)
const {
  patchDocumentation,
  Config: require$schema,
  DEFAULT_CONFIG: SCHEMA_DEFAULTS,
  DEFAULT_PROTOTYPE_STYLE,
} = await import('../src/schema.js')

/**
 * A `setTimeout` that never fires, so the success paths are not raced by the
 * timeout branch. A real 1200ms wait is not the point of those tests, and a
 * timer that fires on the next microtask would beat a fetch that needs two
 * turns — the timeout would win and every good answer would read as a failure.
 */
const neverTimer = () => 0

/** A `setTimeout` that runs its callback on the next microtask. */
const instantTimer = (callback) => {
  Promise.resolve().then(callback)
  return 1
}

await test('a good answer is used, and says it came from the host', async () => {
  const result = await loadHostConfig({
    fetch: () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ chartHeight: 500 }) }),
    setTimeout: neverTimer,
    clearTimeout: () => {},
  })
  eq(result.source, 'host', 'source')
  eq(result.config.chartHeight, 500, 'the value survived')
  eq(result.config.maxPreviewHeight, 320, 'absent keys still get defaults')
})

await test('a hanging request gives up rather than blocking the first render', async () => {
  // The whole reason there is a timeout. A wedged web server must not leave the
  // user looking at unenhanced code blocks, which is the thing this plugin
  // exists to prevent.
  let aborted = false
  const result = await loadHostConfig({
    fetch: (url, init) =>
      new Promise(() => {
        init?.signal?.addEventListener?.('abort', () => {
          aborted = true
        })
      }),
    setTimeout: instantTimer,
    clearTimeout: () => {},
    timeoutMs: 25,
  })
  eq(result.source, 'defaults', 'fell back')
  eq(result.config.maxPreviewHeight, 320, 'with the shipped defaults')
  assert(String(result.reason).includes('no answer'), `reason names the timeout, got ${result.reason}`)
  eq(aborted, true, 'the in-flight request was aborted rather than left running')
})

await test('every failure mode resolves to defaults instead of rejecting', async () => {
  // `apply` awaits this, and a rejection that escaped would leave the plugin
  // dead with no seam at all. Each case is a way the real route can go wrong.
  const cases = [
    ['404 from a host with no host half', () => Promise.resolve({ ok: false, status: 404 }), 'host answered 404'],
    ['500 from a crashing handler', () => Promise.resolve({ ok: false, status: 500 }), 'host answered 500'],
    ['a network failure', () => Promise.reject(new Error('ECONNREFUSED')), 'request failed'],
    ['a body that is not JSON', () => Promise.resolve({ ok: true, status: 200, json: () => Promise.reject(new Error('bad json')) }), 'unexpected'],
    ['a JSON array', () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([1, 2]) }), 'not a config object'],
    ['a JSON null', () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(null) }), 'not a config object'],
  ]
  for (const [name, fetch, expectedReason] of cases) {
    const result = await loadHostConfig({ fetch, setTimeout: neverTimer, clearTimeout: () => {} })
    eq(result.source, 'defaults', `${name}: source`)
    eq(result.config.maxPreviewHeight, 320, `${name}: kept the default`)
    assert(String(result.reason).includes(expectedReason), `${name}: reason was ${result.reason}`)
  }
})

await test('a runtime with no fetch still renders', async () => {
  // `options.fetch ?? globalThis.fetch` means passing `undefined` here would
  // silently fall back to Node's own fetch and test nothing. The runtime is
  // made fetch-less the way a browser without it would be.
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'fetch')
  Object.defineProperty(globalThis, 'fetch', { value: undefined, configurable: true, writable: true })
  try {
    const result = await loadHostConfig({ setTimeout: neverTimer })
    eq(result.source, 'defaults', 'source')
    assert(String(result.reason).includes('no fetch'), `reason was ${result.reason}`)
  } finally {
    if (saved === undefined) delete globalThis.fetch
    else Object.defineProperty(globalThis, 'fetch', saved)
  }
})

await test('the config URL is document-relative, never root-absolute', () => {
  // The bug dshmarket shipped and fixed: a root-absolute request leaves the
  // mount point as soon as the app is served under a prefix. `configUrl`
  // strips the leading slash and resolves against `document.baseURI`.
  const saved = globalThis.document
  try {
    globalThis.document = { baseURI: 'https://host:19387/dsh/ui/' }
    eq(configUrl(), '/dsh/ui/dsh-viewer-kit/config', 'resolved under the mount point')
    eq(configUrl(), configUrl(), 'stable')
    globalThis.document = { baseURI: 'https://host:19387/' }
    eq(configUrl(), '/dsh-viewer-kit/config', 'a root deployment is unchanged')
    globalThis.document = { baseURI: undefined }
    eq(configUrl(), '/dsh-viewer-kit/config', 'no baseURI falls back to root')
  } finally {
    if (saved === undefined) delete globalThis.document
    else globalThis.document = saved
  }
  assert(CONFIG_PATH.startsWith('/'), 'the host-registered path stays root-absolute on purpose')
  assert(CONFIG_TIMEOUT_MS > 0 && CONFIG_TIMEOUT_MS < 5000, `a bounded wait, got ${CONFIG_TIMEOUT_MS}`)
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

await test('an unchanged measurement does not write the height again', () => {
  // The measuring document reports on load, twice more on timers, and on every
  // ResizeObserver tick, so the settled height arrives repeatedly. Assigning it
  // again dirties layout for no visual result, and layout is what moves a
  // reader's scroll position when the resized block is the one they are on.
  const html = conversationFixture([{ nodeKey: 'n-1', html: codeBlockFixture({ lang: 'html', code: '<p>hi</p>' }) }])
  const { env } = mount(html, { config: { maxPreviewHeight: 320 } })
  const frame = env.document.querySelector('iframe')
  const view = env.document.defaultView

  let writes = 0
  let current = frame.style.height
  Object.defineProperty(frame.style, 'height', {
    get: () => current,
    set: (value) => {
      writes += 1
      current = value
    },
  })

  const report = (height) => view.postMessage({ source: frame.contentWindow, data: { __dvk: 'height', id: frameIdOf(frame.srcdoc), height } })

  report(212)
  eq(writes, 1, 'the first measurement writes')
  eq(current, '212px', 'and it lands')

  report(212)
  report(212)
  report(212)
  eq(writes, 1, 'three more identical reports write nothing')
  eq(current, '212px', 'the height is unchanged')

  // A real correction still goes through — this is a dedupe, not a latch.
  report(260)
  eq(writes, 2, 'a genuinely different height writes again')
  eq(current, '260px', 'and it lands')

  // Two different heights that cap to the same value are the same write.
  report(9000)
  eq(writes, 3, 'the uncapped report over the cap writes once')
  eq(current, '320px', 'and lands on the cap')
  report(9001)
  eq(writes, 3, 'a taller one that caps to the very same value is a no-op')
  eq(current, '320px', 'still on the cap')
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
// documentation guards, and the comment-hygiene guard
//
// A README is a projection of the product, and it goes stale silently: nothing
// fails when it quotes a console line the bundle stopped printing, a renderer
// order that changed, or a test count from three releases ago. Every one of
// those is something a reader checks *first*, and a wrong one reads as a broken
// install rather than as a stale document. So each quoted fact is asserted
// against the artifact that produces it.
//
// The comment-hygiene guard below is the same idea applied to source comments:
// see AGENTS.md §4.1 for the rule it enforces.
// ---------------------------------------------------------------------------

process.stdout.write('\ndocs (README quotes must still be true)\n')

await test('the README quotes the console lines the bundle actually emits', async () => {
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8')
  const run = activateBundle(BUNDLE, { fixtureHtml: ACTIVATION_FIXTURE })
  assert(await run.whenReady(), 'activation never finished, so the log is incomplete')
  const emitted = run.log.filter((line) => line.startsWith('[dsh-viewer-kit]'))
  assert(emitted.length >= 4, `expected the four startup lines, saw ${emitted.length}`)

  for (const line of emitted) {
    // The count is live, so the README writes it as a placeholder.
    const quoted = line.replace(/— \d+ code block/, '— N code block')
    assert(readme.includes(quoted), `the README no longer quotes:\n         ${quoted}`)
  }
})

await test('the shipped patch documents every option, generated from the schema', () => {
  // `cordis.patch.yml` is where a user looks to find out what can be set, and
  // it is generated from the same field table the validators walk — so an option
  // cannot be documented without existing, or exist without being explained.
  const patch = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8')
  // Two levels deep: the options live under `config:`, which is under `- id:`.
  const generated = patchDocumentation('        ')
  assert(patch.includes(generated), 'the generated option block is missing or stale in cordis.patch.yml')

  // And the reverse direction, which a substring check cannot give: every
  // shipped option appears in the generated block with its own default.
  for (const [key, value] of Object.entries(SCHEMA_DEFAULTS)) {
    assert(patch.includes(`        ${key}: ${JSON.stringify(value)}`), `cordis.patch.yml is missing "${key}"`)
  }
  eq(Object.keys(SCHEMA_DEFAULTS).length, 10, 'ten options, and the patch documents exactly those')
  eq(require$schema['~standard'].validate({}).issues, undefined, 'an empty config is valid')
  const bad = require$schema['~standard'].validate({ maxPreviewHeight: 'tall' })
  assert(Array.isArray(bad.issues) && bad.issues.length > 0, 'a bad value is an issue, not a value')
  eq(bad.issues[0].path, ['maxPreviewHeight'], 'the issue names the key')
})

/**
 * Is every uncommented line in this patch file correctly indented?
 *
 * DSH refuses to load a plugin whose patch file will not parse, and the failure
 * names a line number in a file the reader did not write. This file's real
 * content is a tiny, fixed subset of YAML — block mappings and block
 * sequences, no anchors, no flow collections, no multi-line scalars — so the
 * one rule that matters is checked directly instead of pulling in a parser:
 *
 *   a line may sit deeper than the line above it only if that line OPENS a
 *   block, meaning it ends with `:` (a mapping with no inline value) or is a
 *   bare `-`.
 *
 * That is precisely the invariant a commented-out `config:` breaks. With the
 * key commented, the first option line is a mapping entry indented under
 * `name:`, which is a scalar, and the host rejects the whole overlay.
 *
 * A sequence item is compared by the column its own content starts at, not by
 * the dash, so `- id: x` is correctly read as opening a mapping for the lines
 * that follow rather than as a closed value.
 *
 * @param {string} yaml
 * @returns {string[]} one message per violation; empty means sound
 */
function indentationFaults(yaml) {
  /** @type {{ indent: number, text: string } | null} */
  let previous = null
  const faults = []
  for (const [index, raw] of yaml.split('\n').entries()) {
    const line = raw.replace(/\s+$/, '')
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue
    if (/^\s*\t/.test(line)) faults.push(`line ${index + 1}: a tab in indentation`)
    const indent = line.length - line.trimStart().length
    const text = line.trim()
    if (previous !== null && indent > previous.indent) {
      const opens = /:\s*$/.test(previous.text.replace(/^-\s+/, ''))
      if (!opens) {
        faults.push(`line ${index + 1}: "${text}" is indented under "${previous.text}", which is already a complete value`)
      }
    }
    // A `- ` item's mapping continues at the column after the dash, so that is
    // the column a following line has to match, not the dash's own.
    previous = { indent: indent + (text === '-' ? 0 : text.startsWith('- ') ? 2 : 0), text }
  }
  return faults
}

await test('the shipped patch is validly indented, so the host can parse it', () => {
  // The guard above proves the option table is present and current. It cannot
  // prove the file PARSES: it compares generated text against the file as a
  // substring, and a file can hold a perfectly current copy of the table while
  // the mapping it sits in is malformed. That is not hypothetical — the table
  // shipped under a commented-out `config:` for several releases, every test
  // stayed green, and the host refused to load the plugin at all.
  const patch = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8')
  const faults = indentationFaults(patch)
  assert(faults.length === 0, `cordis.patch.yml would not parse:\n         ${faults.join('\n         ')}`)

  // The specific shape that failed: the options must hang off a real `config:`
  // key, not off whatever real key happens to precede them.
  assert(/^\s{6}config:\s*$/m.test(patch), 'the config key is present and NOT commented out')
})

await test('the indentation check rejects a mapping left under a closed value', () => {
  // A check that cannot go red is worse than no check. This is the exact file
  // shape that shipped broken, reduced to the few lines that break it.
  const broken = ['- insert:', '    - id: k', "      name: 'k'", '      # config:', '        enabled: true'].join('\n')
  const faults = indentationFaults(broken)
  eq(faults.length, 1, `exactly one fault in the broken shape: ${JSON.stringify(faults)}`)
  assert(faults[0].includes('enabled: true'), `the fault names the offending line: ${faults[0]}`)

  // And the same file with the key live is sound, so the rule is not simply
  // rejecting everything it is shown.
  const fixed = ['- insert:', '    - id: k', "      name: 'k'", '      config:', '        enabled: true'].join('\n')
  eq(indentationFaults(fixed), [], 'uncommenting the key makes the same file sound')
})

await test('a block whose switch React wiped gets its switch back', () => {
  const { env, seam } = mount(
    conversationFixture([{ nodeKey: 'n-1', html: codeBlockFixture({ lang: 'html', code: HTML_SAMPLE }) }]),
  )
  const doc = env.document
  assert(switcher(doc) !== null, 'claimed on the first scan')

  // What a React re-render does: it rebuilds the banner's trailing action group
  // from its own state. It has no record of the nodes we appended there, so they
  // go. The block element itself is untouched, and so is the preview below it.
  const banner = doc.querySelector('[data-code-block-banner]')
  const actionGroup = banner.lastElementChild
  actionGroup.replaceChildren()

  // Still claimed — the WeakMap has never heard of this.
  eq(seam.size(), 1, 'the seam still counts the block as enhanced')

  // The mutation React's own teardown produces must be enough to trigger
  // recovery. Before the fix this re-entered `evaluate` and returned on the
  // claim, so the block rendered with no way back to its source.
  seam.scan()
  const back = switcher(doc)
  assert(back !== null, 'the switch came back')
  eq(back.children.map((b) => b.getAttribute('data-dvk-view')), ['preview', 'code'], 'and it is a real two-view switch')
  assert(content(doc).getAttribute('data-dvk-mode') === 'preview', 'the block is still showing its preview')
})

await test('a block that keeps its switch is not rebuilt on every scan', () => {
  const { env, seam } = mount(
    conversationFixture([{ nodeKey: 'n-1', html: codeBlockFixture({ lang: 'html', code: HTML_SAMPLE }) }]),
  )
  const doc = env.document
  const first = switcher(doc)

  seam.scan()
  seam.scan()

  // Idempotence matters twice over: rebuilding on every scan would tear down
  // and re-mount the preview frame under the reader, and would flash the block
  // back to source each time it was re-evaluated.
  assert(switcher(doc) === first, 'the very same switch node is still in place')
  eq(seam.size(), 1, 'and the block is still claimed exactly once')
})

await test('the README quotes the current version and tarball name', () => {  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8')
  assert(readme.includes(`v${manifest.version} active`), `the README does not quote v${manifest.version}`)
  assert(
    readme.includes(`dsh-viewer-kit-${manifest.version}.tgz`),
    `the README's tarball name is not ${manifest.version} — npm pack produces dsh-viewer-kit-${manifest.version}.tgz`,
  )
})

// ---------------------------------------------------------------------------
// Prototype mode — the one-shot style injection.
//
// This is the only part of the kit that runs inside the model's own turn loop,
// so it is tested against a fake host that behaves like the real one in the ways
// that matter: `tools.register` and `systemPrompt.section` both return their
// disposer, and a section's `text` may be a function the assembler calls on
// every request. The assembly loop is modelled explicitly — `assemble()` is this
// file's stand-in for "the host rebuilt the system prompt" — because the whole
// feature is a statement about what one assembly does to the next.
// ---------------------------------------------------------------------------

const { registerPrototypeStyle, PROTOTYPE_TOOL, PROTOTYPE_SECTION } = await import(
  '../src/tools/apply-prototype-style.js'
)
const host = await import('../src/index.js')

/**
 * A host half wired to recording stubs.
 *
 * `assemble()` runs every registered section's `text`, which is exactly what the
 * real service does before a model step. Sections whose `text` is a plain string
 * — none here — would be returned verbatim; running them is harmless and keeps
 * the stub from having to model that distinction.
 */
function hostHarness(overrides = {}) {
  const sections = new Map()
  const tools = new Map()
  const routes = []
  const ctx = {
    effect: (callback) => callback(),
    tools: {
      register(definition) {
        if (tools.has(definition.name)) throw new Error(`duplicate tool ${definition.name}`)
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    systemPrompt: {
      section(section) {
        if (sections.has(section.name)) throw new Error(`duplicate section ${section.name}`)
        sections.set(section.name, section)
        return () => sections.delete(section.name)
      },
    },
    webServer: {
      register(route) {
        routes.push(route)
        return () => {
          const at = routes.indexOf(route)
          if (at >= 0) routes.splice(at, 1)
        }
      },
    },
  }
  return {
    ctx,
    tools,
    sections,
    routes,
    assemble: () => [...sections.values()].map((s) => (typeof s.text === 'function' ? s.text({}) : s.text)),
  }
}

await test('prototype mode is inert until the model asks for it', () => {
  const h = hostHarness()
  h.ctx.effect(() => {})
  registerPrototypeStyle(h.ctx, { prototypeStyle: '' })
  const section = h.sections.get(PROTOTYPE_SECTION)
  assert(section !== undefined, 'the section is registered at apply time, not on demand')
  // The whole cost of the feature while idle: an empty string the assembler drops.
  eq(h.assemble().filter((text) => text !== '').length, 0, 'an unarmed section contributes nothing')
  eq(h.assemble(), [''], 'and it keeps costing nothing on later assemblies')
})

await test('the injected specification appears once, then expires on its own', async () => {
  const h = hostHarness()
  registerPrototypeStyle(h.ctx, { prototypeStyle: '' })
  const tool = h.tools.get(PROTOTYPE_TOOL)
  assert(tool !== undefined, `${PROTOTYPE_TOOL} is registered`)

  eq(await tool.execute({}, {}), { armed: true }, 'the tool reports that it armed')

  const first = h.assemble()
  eq(first.length, 1, 'exactly one section carries text after the call')
  assert(first[0].includes('#333'), 'the shipped specification reached the prompt')
  assert(first[0].includes('system-ui'), 'and it is the shipped one, not an override')

  // The load-bearing assertion. A model that never acknowledges the injection
  // must still find it gone, because the section cleared itself on the way out.
  eq(h.assemble(), [''], 'the next assembly is empty again')
  eq(h.assemble(), [''], 'and every assembly after that')
})

await test('the model cannot leave the mode on, because it has no way to', async () => {
  const h = hostHarness()
  registerPrototypeStyle(h.ctx, { prototypeStyle: '' })
  const tool = h.tools.get(PROTOTYPE_TOOL)

  await tool.execute({}, {})
  h.assemble()

  // Every tool the model can see, and none of them turns the mode off. If a
  // future edit adds one, this stops holding — which is the point: the guarantee
  // is that expiry does not depend on the model choosing to act.
  const names = [...h.tools.keys()]
  eq(names, [PROTOTYPE_TOOL], 'the mode registers exactly one tool, and it only opens')
  const declaration = tool.description.toLowerCase()
  assert(declaration.includes('expires'), 'the tool tells the model nothing is needed to switch it off')
  assert(
    tool.parameters.type === 'object' && Object.keys(tool.parameters.properties ?? {}).length === 0,
    'it takes no arguments, so there is no argument with which to forget',
  )
})

await test('two calls arm two injections, not one held-open mode', async () => {
  const h = hostHarness()
  registerPrototypeStyle(h.ctx, { prototypeStyle: '' })
  const tool = h.tools.get(PROTOTYPE_TOOL)

  await tool.execute({}, {})
  await tool.execute({}, {})
  h.assemble()
  eq(h.assemble(), [''], 'both calls collapse into one injection and it is spent')
})

await test('a configured prototypeStyle replaces the shipped specification', async () => {
  const h = hostHarness()
  registerPrototypeStyle(h.ctx, { prototypeStyle: 'Use the house palette: #101010 on #fafafa.' })
  const tool = h.tools.get(PROTOTYPE_TOOL)

  eq(h.assemble(), [''], 'still inert before the call')
  await tool.execute({}, {})
  const [text] = h.assemble()
  assert(text.includes('#101010'), 'the override is what gets injected')
  assert(!text.includes('system-ui'), 'and the shipped text is not appended to it')
})

await test('an empty prototypeStyle means the shipped specification, not no specification', async () => {
  const h = hostHarness()
  registerPrototypeStyle(h.ctx, resolveConfig({ prototypeStyle: '' }))
  await h.tools.get(PROTOTYPE_TOOL).execute({}, {})
  const [text] = h.assemble()
  assert(text.length > 0, 'the empty default resolves to real prompt text')
  assert(text === DEFAULT_PROTOTYPE_STYLE, 'and to the shipped specification exactly')
})

await test('a bad prototypeStyle falls back rather than failing the row', () => {
  eq(resolveConfig({ prototypeStyle: 42 }).prototypeStyle, '', 'a number is not a specification')
  eq(resolveConfig({ prototypeStyle: '' }).prototypeStyle, '', 'empty is accepted as the default')
  eq(resolveConfig({ prototypeStyle: 'x' }).prototypeStyle, 'x', 'any string is accepted')
  const bad = require$schema['~standard'].validate({ prototypeStyle: 42 })
  assert(Array.isArray(bad.issues) && bad.issues.length > 0, 'and the host half rejects it loudly')
  eq(bad.issues[0].path, ['prototypeStyle'], 'the issue names the key')
})

await test('unloading the plugin takes the tool and the section with it', () => {
  const h = hostHarness()
  const dispose = registerPrototypeStyle(h.ctx, { prototypeStyle: '' })
  eq(h.tools.size, 1, 'the tool is live')
  eq(h.sections.size, 1, 'the section is live')

  dispose()
  eq(h.tools.size, 0, 'no tool survives the disposer')
  eq(h.sections.size, 0, 'and no section does')
  eq(h.assemble(), [], 'so a later assembly has nothing of ours to contribute')
})

await test('apply() returns a disposer that releases prototype mode', () => {
  const h = hostHarness()
  const dispose = host.apply(h.ctx, {})
  assert(typeof dispose === 'function', 'apply returns the prototype-style disposer')
  assert(h.tools.has(PROTOTYPE_TOOL), 'and the tool is registered when it returns')
  dispose()
  eq(h.tools.size, 0, 'calling it unregisters the tool')
})

await test('the host half declares the services it registers into', () => {
  assert(host.inject.includes('systemPrompt'), 'systemPrompt is a hard dependency')
  assert(host.inject.includes('tools'), 'tools is a hard dependency')
})

await test('the section sits after the persona and before tool guidance', () => {
  const h = hostHarness()
  registerPrototypeStyle(h.ctx, { prototypeStyle: '' })
  const order = h.sections.get(PROTOTYPE_SECTION).order
  assert(Number.isFinite(order), 'the order is a finite number, as the service requires')
  // The host's named placements this has to sit between. Read from the source
  // of truth rather than restated, so a host upgrade that moves one of them
  // turns this red instead of quietly burying the section under tool guidance.
  assert(order > 0, 'after DEPLOYMENT_PERSONA_PREFIX (0)')
  assert(order < 500, 'before PLAN_POLICY (500) and the tool sections (1000+)')
})

await test('the prototype tool declares the output the tools pipeline requires', () => {
  const h = hostHarness()
  registerPrototypeStyle(h.ctx, { prototypeStyle: '' })
  const tool = h.tools.get(PROTOTYPE_TOOL)
  // `output` is not optional on a ToolDefinition; a tool without it renders no
  // content block at all, which the model sees as an empty reply.
  assert(tool.output !== undefined, 'output is declared')
  eq(typeof tool.output.render, 'function', 'with a render function')
  const blocks = tool.output.render({}, { armed: true })
  assert(Array.isArray(blocks) && blocks.length > 0, 'which produces content')
  eq(blocks[0].type, 'text', 'of the content-block kind the pipeline renders')
  // Absent `isConcurrencySafe`, the tools pipeline classifies a call as
  // EXCLUSIVE. That is required here: the call flips state that the very next
  // prompt assembly reads, so two of them must never interleave.
  //
  // Tested with `in`, not `eq(x, undefined)`: `eq` compares through
  // `JSON.stringify`, and a function stringifies to `undefined`, so an `eq`
  // assertion here would pass whether the key was absent or set to a function.
  assert(!('isConcurrencySafe' in tool), 'the call stays exclusive by default')
})

await test('the README states the exact number of tests this file declares', () => {
  // Counted statically rather than from `passed`, because the number cannot be
  // known until the run completes and this check runs part-way through it — a
  // live count would make the assertion depend on where in the file it sits.
  //
  // Exact, not "at least": an understated number is just as wrong as an
  // overstated one to a reader deciding whether the project is tested. The cost
  // is one edit whenever the suite grows, which is the point.
  //
  // AGENTS.md is checked by the same loop. It quotes the count in two places,
  // and a contributor document that misstates the suite is the same defect as a
  // README that does — with the added irony that AGENTS.md is where the rule
  // against stale duplication is written down.
  const source = readFileSync(new URL(import.meta.url), 'utf8')
  const declared = (source.match(/^await test\(/gm) ?? []).length
  let checked = 0
  for (const name of ['README.md', 'AGENTS.md']) {
    const text = readFileSync(join(ROOT, name), 'utf8')
    const claims = [...text.matchAll(/(\d+) 项测试/g)]
    for (const claim of claims) {
      eq(Number(claim[1]), declared, `${name} says ${claim[1]} tests; this file declares ${declared}`)
      checked += 1
    }
  }
  assert(checked > 0, 'neither README.md nor AGENTS.md states a test count')
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
// comment hygiene (AGENTS.md §4.1)
//
// A comment is read by someone who does not know the conversation that produced
// it. Names for that conversation — who reported what, "the bug this fixes",
// which review asked for it — turn a comment into an artefact of a moment that
// has passed, and they crowd out the invariant that would still be true.
//
// The rule is a judgement call, so this guard only catches the unambiguous
// phrasings. That is deliberate: a guard that tried to judge prose would be
// either noisy or wrong, and both train people to ignore it.
// ---------------------------------------------------------------------------

/** Phrases that only make sense with the conversation as context. */
const COMMENT_RESIDUE = /the bug this fixes|reported from the real app|the complaint this|user feedback|用户反馈|用户报告|上次踩|审查报告|as (?:we|I) discussed/i

await test('source comments do not reference the conversation that produced them', () => {
  // The guard has to be able to fail, or it is decoration. This asserts the
  // detector works before trusting a clean scan — the same reason
  // tests/probe-host.mjs carries a "faithful host" case.
  eq(COMMENT_RESIDUE.test('// the bug this fixes: hover vanished'), true, 'the detector catches a known offender')
  eq(COMMENT_RESIDUE.test('// A modal dialog makes the page inert'), false, 'and ignores an ordinary comment')

  /** @type {string[]} */
  const offenders = []
  const roots = [join(ROOT, 'src'), join(ROOT, 'tools'), join(ROOT, 'scripts')]
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (/\.m?js$/.test(entry.name)) {
        const source = readFileSync(full, 'utf8')
        source.split('\n').forEach((line, index) => {
          if (COMMENT_RESIDUE.test(line)) {
            const short = full.slice(ROOT.length + 1)
            offenders.push(`${short}:${index + 1}  ${line.trim()}`)
          }
        })
      }
    }
  }
  for (const root of roots) walk(root)
  eq(offenders, [], `comments that only make sense with the conversation as context:\n       ${offenders.join('\n       ')}`)
})

// ---------------------------------------------------------------------------
// documentation cross-references
//
// A design document that points at a file, a heading or a section which has
// moved is worse than one that points nowhere: it looks authoritative and
// sends the reader somewhere empty. Every link is resolved here rather than
// trusted, because these documents cross-link to each other and to both
// top-level files, and renames happen.
// ---------------------------------------------------------------------------

process.stdout.write('\ndocs (cross-references must resolve)\n')

await test('every link between the documents resolves', () => {
  /** @type {string[]} */
  const broken = []
  const docs = ['README.md', 'AGENTS.md', 'docs/01-architecture.md', 'docs/02-renderer-authoring.md']
  for (const name of docs) {
    const text = readFileSync(join(ROOT, name), 'utf8')
    const dir = dirname(join(ROOT, name))
    // `](../path)` and `](path)` — a fragment is checked separately below.
    for (const match of text.matchAll(/\]\(([^)\s]+?)(#[^)\s]*)?\)/g)) {
      const target = match[1]
      if (/^[a-z]+:/i.test(target)) continue // an external URL
      const resolved = resolve(dir, target)
      if (!existsSync(resolved)) broken.push(`${name} → ${target}`)
    }
  }
  eq(broken, [], `links that point at a file which does not exist:\n       ${broken.join('\n       ')}`)
})

await test('every section a document refers to still exists', () => {
  // A `§5.6` that no longer resolves is the same rot as a broken file link, and
  // harder to notice: the number still looks plausible.
  //
  // Resolved against the union of all four documents' headings, because these
  // files cross-reference each other freely (a checklist in 02 pointing at
  // AGENTS.md §4.1, a README pointing at architecture §5.6). That is
  // deliberately permissive: it will not catch a reference that resolves to a
  // same-numbered section in the *wrong* document, and it is a fair trade for
  // not having to model which document each reference means. The failure this
  // exists to catch is a number that resolves nowhere.
  const headings = new Set()
  for (const name of ['README.md', 'AGENTS.md', 'docs/01-architecture.md', 'docs/02-renderer-authoring.md']) {
    for (const match of readFileSync(join(ROOT, name), 'utf8').matchAll(/^#{2,3} (\d+(?:\.\d+)*)\.?\s/gm)) {
      headings.add(match[1])
    }
  }
  /** @type {string[]} */
  const broken = []
  for (const name of ['README.md', 'AGENTS.md', 'docs/01-architecture.md', 'docs/02-renderer-authoring.md']) {
    const text = readFileSync(join(ROOT, name), 'utf8')
    for (const match of text.matchAll(/§(\d+(?:\.\d+)*)/g)) {
      if (!headings.has(match[1])) broken.push(`${name} → §${match[1]}`)
    }
  }
  eq(broken, [], `section references that no longer exist:\n       ${broken.join('\n       ')}`)
})

// ---------------------------------------------------------------------------

process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`)
if (failures.length > 0) {
  for (const failure of failures) process.stderr.write(`  ✗ ${failure}\n`)
  process.exitCode = 1
}
