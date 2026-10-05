/**
 * The one place this plugin's configuration is defined.
 *
 * ## Why this file exists
 *
 * The kit has two halves that run in different processes, and until recently
 * only one of them had any configuration at all:
 *
 *   - the **host half** (`lib/index.js`, Node) receives the patch row's
 *     `config:` block as `apply(ctx, config)`, and owns validation;
 *   - the **client half** (`client/client.js`, the browser) draws everything.
 *
 * A browser plugin cannot read `cordis.patch.yml`, and the boot wire carries no
 * config at all — `graphRow()` emits `{id, url, rev, inject?, immediately?,
 * external?}` and `parseBootManifest()` reads back exactly those fields. So the
 * host half publishes the resolved config over an HTTP route and the client
 * fetches it before its first scan. `tools/probe-host.mjs` fails the build if
 * DSH ever adds config to the wire, because that is the day to delete this file
 * and read the row directly.
 *
 * ## Why one field table
 *
 * Three things must never disagree: the default, the strict check the host
 * runs, and the lenient fallback the client runs. Describing each field once
 * and deriving all three removes the class of bug where `chartHeight` is
 * validated in one place and defaulted in another — which is exactly how a
 * dead `DEFAULT_CHART_HEIGHT` and an unreachable `|| 360` ended up in the
 * echarts renderer.
 *
 * Zero dependencies, deliberately: this module is imported by the host half,
 * which `scripts/build-host.mjs` copies verbatim with no bundler in the loop.
 * A schema library would have to resolve at runtime from the profile.
 *
 * @module schema
 */

/**
 * One configuration field.
 *
 * `kind` selects the check; `doc` is the user-facing explanation reused by the
 * bundle patch, so the two cannot drift.
 *
 * @typedef {object} Field
 * @property {string} key
 * @property {'boolean' | 'natural' | 'positive' | 'enum' | 'stringList' | 'text'} kind
 * @property {string | number | boolean | string[]} fallback
 * @property {readonly string[]} [values] enum members, when `kind` is 'enum'
 * @property {string} doc
 */

/**
 * The shipped low-fidelity prototype style specification.
 *
 * This is the default **value** of the `prototypeStyle` option, not a second
 * description of it, which is why it lives here beside the field table rather
 * than with the tool that injects it (`tools/apply-prototype-style.js`).
 *
 * The option falls back to `''` rather than to this string. That keeps the
 * resolved config — which is published verbatim over `CONFIG_ROUTE` and printed
 * on one startup line — a single short scalar, and keeps `patchDocumentation`
 * from emitting the whole specification as escaped lines into
 * `cordis.patch.yml`. The cost is that
 * "empty means shipped" is a rule the reader has to be told once; the field's
 * `doc` and the README both say it.
 *
 * Prompt text, so it is written for a model rather than for a person reading a
 * config file: imperative, and every rule is checkable against the markup.
 *
 * @type {string}
 */
export const DEFAULT_PROTOTYPE_STYLE = [
  '# Low-fidelity HTML prototype style',
  '',
  'These rules apply to the HTML you emit in THIS response only. They expire',
  'immediately after it; ordinary conversation is unaffected.',
  '',
  '## Colour',
  'Greyscale only: #333 body text, #666 secondary text, #999 placeholder or',
  'disabled text, #ccc borders and dividers, #eee background fills.',
  'No colour of any kind, no gradient, no shadow.',
  '',
  '## Type',
  'font-family: system-ui, -apple-system, sans-serif',
  '',
  '## Controls',
  'Buttons and inputs: border 1px solid #ccc; border-radius 4px; box-shadow none.',
  'Cards: border 1px solid #ddd; border-radius 4px; box-shadow none.',
  '',
  '## Forbidden',
  '- External CSS frameworks (Tailwind, Bootstrap, Ant Design, and the like).',
  '- Gradients, box-shadows, animations, transitions.',
  '- Icon libraries and icon fonts. Use plain text or a minimal CSS shape.',
  '',
  '## Structure',
  'Every style lives in ONE <style> block. No inline style attributes.',
  '',
  'This is a wireframe, not a visual design: get hierarchy and layout right,',
  'and do not spend effort on polish.',
].join('\n')

/** @type {readonly Field[]} */
const FIELDS = [
  {
    key: 'enabled',
    kind: 'boolean',
    fallback: true,
    doc: 'Master switch. false leaves every code block to the host.',
  },
  {
    key: 'disabledRendererIds',
    kind: 'stringList',
    fallback: [],
    doc: [
      'Turn renderers off without uninstalling. One list, two tiers:',
      "  by RENDERER ID ('table', 'html', 'echarts') — that renderer stops",
      '    matching, and the block is re-offered to the rest;',
      "  by FENCE NAME ('csv', 'json', 'markdown') — no renderer sees such a",
      '    block at all, whether or not a renderer exists for it.',
      "They overlap for a language a renderer is named after: ['csv'] and",
      "['table'] both switch off CSV tables, for different reasons.",
    ].join('\n'),
  },
  {
    key: 'maxSourceBytes',
    kind: 'natural',
    fallback: 256 * 1024,
    doc: 'Sources above this many bytes keep the native code block.',
  },
  {
    key: 'previewHeightMode',
    kind: 'enum',
    values: ['measure', 'fit', 'fixed'],
    fallback: 'measure',
    doc: [
      'How an embedded HTML preview decides its height:',
      "  'measure' — size the frame to the document's real height, capped.",
      '              Short content shows fully with no empty band; long',
      '              content scrolls. Falls back to fit if the measurement',
      '              never arrives.',
      "  'fit'     — estimate the rendered height. Same intent, without the",
      '              measuring frame, so a short estimate can scroll.',
      "  'fixed'   — always exactly maxPreviewHeight. Fully predictable, and",
      '              short content leaves empty space below itself.',
    ].join('\n'),
  },
  {
    key: 'maxPreviewHeight',
    kind: 'positive',
    fallback: 320,
    doc: [
      'Tallest an embedded preview may grow, in CSS pixels — and, under',
      "previewHeightMode 'fixed', the exact height.",
      '320 rather than a taller figure because a preview is a glance, not a',
      'page view: at 520 a short document left a band of empty frame in the',
      'middle of the conversation, which reads as broken rather than',
      'generous. Anything taller scrolls inside the frame, which is the',
      'honest signal that there is more to see.',
    ].join('\n'),
  },
  {
    key: 'maxTableHeight',
    kind: 'positive',
    fallback: 480,
    doc: [
      'Tallest a data table may grow, in CSS pixels, before it scrolls',
      'internally. The table keeps a sticky header, so a long result is',
      'readable in place instead of stretching the conversation. Expand a',
      'table from its view switch to lift the cap; a chart or an HTML',
      'preview is unaffected.',
    ].join('\n'),
  },
  {
    key: 'chartHeight',
    kind: 'positive',
    fallback: 360,
    doc: [
      'Height of an embedded chart, in CSS pixels.',
      'Charts need an explicit height: a canvas inside an auto-height box',
      'renders at zero. Must be positive — a zero-height chart is invisible,',
      'which is worse than falling back to the default.',
    ].join('\n'),
  },
  {
    key: 'htmlAllowScripts',
    kind: 'boolean',
    fallback: false,
    doc: [
      'Let previewed HTML run scripts, for charts and interactive reports.',
      'The frame is ALWAYS an opaque origin: allow-scripts is granted on its',
      'own and never paired with allow-same-origin, so the document cannot',
      'reach the host DOM, cookies, or storage. What changes is that merely',
      "rendering a block can start that block's network requests.",
    ].join('\n'),
  },
  {
    key: 'defaultToPreview',
    kind: 'boolean',
    fallback: true,
    doc: [
      'Open a claimed block in its rendered view instead of its source.',
      'Preview is the default because the whole point of the kit is to show',
      'what the content *is*: a chart, a table, a page. Reading the markup is',
      'the exception, so it costs a click.',
    ].join('\n'),
  },
  {
    key: 'prototypeStyle',
    kind: 'text',
    fallback: '',
    doc: [
      'Replaces the built-in low-fidelity style specification injected by the',
      'apply_prototype_style tool, for the one response that follows the call.',
      '',
      'Empty (the default) means the SHIPPED specification is used. The shipped',
      'text is a greyscale wireframe house style: #333/#666/#999/#ccc/#eee only,',
      'system-ui type, 1px #ccc or #ddd borders, 4px radii, no shadows, no',
      'gradients, no animation, no icon libraries, and one central <style> block',
      'rather than inline styles.',
      '',
      'Set it to any non-empty string to inject that text instead — useful when',
      'your own house style, or a different wireframe convention, has to be the',
      'one the model is held to. It is a one-shot injection: the next',
      'assembled request consumes it and the text stops appearing, whether or',
      'not the model acknowledges it.',
    ].join('\n'),
  },
]

/**
 * Is `value` acceptable for one field?
 *
 * @param {Field} field
 * @param {unknown} value
 * @returns {boolean}
 */
function accepts(field, value) {
  switch (field.kind) {
    case 'boolean':
      return typeof value === 'boolean'
    case 'natural':
      // An integer count of bytes. `Number.isInteger` rather than a positivity
      // test, because 10.5 bytes is a typo, not a request.
      return typeof value === 'number' && Number.isInteger(value) && value > 0
    case 'positive':
      // `typeof` cannot tell 0 from 360, and a canvas in a zero-height box
      // draws nothing, so this one is a value check rather than a type check.
      return typeof value === 'number' && Number.isFinite(value) && value > 0
    case 'enum':
      return typeof value === 'string' && (field.values ?? []).includes(value)
    case 'stringList':
      return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
    case 'text':
      // Any string, including the empty one that means "use the shipped
      // specification". Rejecting `''` would make the field table unable to
      // express its own default, so emptiness is a value here, not a miss.
      return typeof value === 'string'
    default:
      return false
  }
}

/**
 * @returns {Required<import('./client/contract.js').ViewerKitConfig>}
 */
function buildDefaults() {
  /** @type {Record<string, string | number | boolean | readonly string[]>} */
  const out = {}
  for (const field of FIELDS) out[field.key] = field.fallback
  // The table is data, so the cast is where the two representations meet. The
  // test that follows it in `tests/run.mjs` asserts the table and the typedef
  // agree on every key, so a field added to one and not the other is a failure
  // rather than a lie in a type annotation.
  return /** @type {Required<import('./client/contract.js').ViewerKitConfig>} */ (out)
}

/**
 * The shipped defaults, derived from {@link FIELDS}.
 *
 * @type {Readonly<Required<import('./client/contract.js').ViewerKitConfig>>}
 */
export const DEFAULT_CONFIG = Object.freeze(buildDefaults())

/** @type {Readonly<Record<string, Field>>} */
const BY_KEY = Object.freeze(Object.fromEntries(FIELDS.map((field) => [field.key, field])))

/**
 * Build a config from a partial patch, dropping anything unacceptable.
 *
 * This is the client's path, and it is deliberately lenient. The host has
 * already validated the same values strictly before publishing them, so by the
 * time anything reaches here a rejection means the route is serving something
 * this build does not understand — an older host, a hand-edited response, a
 * half-written file. Defaults are a better answer than a failed web boot.
 *
 * @param {Record<string, unknown> | null | undefined} patch
 * @returns {Required<import('./client/contract.js').ViewerKitConfig>} every key
 *   present, every value one the table accepts
 */
export function resolveConfig(patch) {
  /** @type {any} */
  const out = { ...DEFAULT_CONFIG }
  if (patch == null || typeof patch !== 'object') return out
  for (const field of FIELDS) {
    const value = /** @type {Record<string, unknown>} */ (patch)[field.key]
    // `undefined` means "not configured", which is not the same as invalid:
    // the default stands, silently, because that is what the user asked for.
    if (value === undefined) continue
    if (accepts(field, value)) out[field.key] = value
  }
  return /** @type {Required<import('./client/contract.js').ViewerKitConfig>} */ (out)
}

/**
 * The specification text to inject when prototype mode fires.
 *
 * Split out from {@link resolveConfig} because "a valid config" and "the text
 * to hand a model" are different questions: the config carries `''` as the
 * standing default, and only the consumer knows that empty means shipped.
 *
 * @param {Pick<import('./client/contract.js').ViewerKitConfig, 'prototypeStyle'>} config
 * @returns {string} never empty
 */
export function prototypeStyleSpec(config) {
  return config.prototypeStyle === '' ? DEFAULT_PROTOTYPE_STYLE : config.prototypeStyle
}

/**
 * Standard Schema over the same table, for the host half.
 *
 * Cordis reads `Plugin.Runtime.Config['~standard']` and calls `validate` on
 * every fiber start (`resolveConfig` in `@deepseek-ai/cordis`), so exporting
 * this is what makes an invalid patch row fail loudly at load instead of
 * silently degrading.
 *
 * Failing loudly is safe here and only here: this runs on the **host** fiber,
 * which contributes no behaviour, and the web-boot activation audit
 * (`client.js:418-434`) only fails entries whose *client* fiber did not reach
 * ACTIVE. A rejected host half takes nothing else down with it.
 *
 * @type {{ '~standard': { version: 1, vendor: string, validate: (value: unknown) => { value: object } | { issues: { message: string, path?: (string | number)[] }[] } } }}
 */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'dsh-viewer-kit',
    /**
     * @param {unknown} value
     * @returns {{ value: object } | { issues: { message: string, path?: (string | number)[] }[] }}
     */
    validate(value) {
      // A row with no `config:` block arrives as undefined, and that is the
      // overwhelmingly common case: every key is optional and defaults.
      if (value === undefined || value === null) return { value: { ...DEFAULT_CONFIG } }
      if (typeof value !== 'object' || Array.isArray(value)) {
        return { issues: [{ message: `config must be a mapping, got ${Array.isArray(value) ? 'an array' : typeof value}` }] }
      }
      const input = /** @type {Record<string, unknown>} */ (value)
      /** @type {{ message: string, path?: (string | number)[] }[]} */
      const issues = []
      for (const [key, raw] of Object.entries(input)) {
        const field = BY_KEY[key]
        if (field === undefined) {
          // Reported rather than dropped. A typo'd key is a configuration bug
          // the user needs to see; silently ignoring it is how "I set it and
          // nothing happened" happens.
          issues.push({ message: `unknown option "${key}"`, path: [key] })
          continue
        }
        if (raw === undefined) continue
        if (!accepts(field, raw)) {
          issues.push({ message: `${describeExpectation(field)} (got ${JSON.stringify(raw)})`, path: [key] })
        }
      }
      if (issues.length > 0) return { issues }
      return { value: resolveConfig(input) }
    },
  },
}

/**
 * @param {Field} field
 * @returns {string}
 */
function describeExpectation(field) {
  switch (field.kind) {
    case 'boolean':
      return 'expected true or false'
    case 'natural':
      return 'expected a positive whole number'
    case 'positive':
      return 'expected a number greater than 0'
    case 'enum':
      return `expected one of ${(field.values ?? []).map((v) => JSON.stringify(v)).join(', ')}`
    case 'stringList':
      return 'expected an array of strings'
    case 'text':
      return 'expected a string'
    default:
      return 'unrecognised option'
  }
}

/**
 * The documentation block embedded in the shipped `cordis.patch.yml`.
 *
 * Generated rather than hand-written so the patch file cannot describe an
 * option that no longer exists or omit one that does. `tests/run.mjs` asserts
 * the two stay identical.
 *
 * The indent is a parameter because the block lives inside a mapping nested
 * under a list item (`- id:` → `config:` → options), so it is two levels deep,
 * not one. Generating at a fixed width and re-indenting in the test would hide
 * that structure from the generator.
 *
 * @param {string} [indent] leading whitespace for each option line
 * @returns {string}
 */
export function patchDocumentation(indent = '    ') {
  const lines = []
  for (const field of FIELDS) {
    // An empty doc line becomes a bare `#`, never `# `. Trailing whitespace is
    // something half the editors that open this file will happily delete, and
    // the test that compares this output against the shipped patch would then
    // fail on a formatting change that altered nothing.
    const comment = field.doc
      .split('\n')
      .map((line) => (line === '' ? `${indent}#` : `${indent}# ${line}`))
      .join('\n')
    lines.push(comment)
    lines.push(`${indent}#`)
    lines.push(`${indent}# default: ${JSON.stringify(field.fallback)}`)
    lines.push(`${indent}${field.key}: ${JSON.stringify(field.fallback)}`)
    lines.push('')
  }
  return lines.join('\n').trimEnd()
}
