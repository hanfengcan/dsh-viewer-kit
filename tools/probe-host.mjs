/**
 * Host-truth probe: check this plugin's assumptions against the DSH build that
 * is actually installed.
 *
 * ## Why this exists
 *
 * `scripts/probe-chunk.mjs` tests this plugin's own regex against this
 * plugin's own artifact. That proves self-consistency, not agreement with the
 * host — and the three facts the on-demand engine chunk depends on were, until
 * this file existed, asserted only in comments:
 *
 *   - the chunk filename rule the host's route accepts,
 *   - that `require.async` is the way a factory asks for one,
 *   - that a missing bundle has a named error.
 *
 * None of them are documented API, so a DSH upgrade can change any of them
 * silently. The failure mode is not a crash: the chart renderer simply stops
 * drawing, and the user sees a code block. This probe turns that into a red
 * `pnpm run check`.
 *
 * ## Where the truth comes from
 *
 * `resources/app.asar`, the Electron archive every DSH Desktop install carries.
 * It is a single file with a JSON header describing a directory tree, so a
 * ~60-line reader is enough and no dependency or network access is needed.
 * The facts are read out of `@deepseek-ai/dsh-client-modules`, the package
 * that owns the client module system on both sides of the wire.
 *
 * ## When there is no asar
 *
 * A machine without DSH Desktop has nothing to check against, so the probe
 * SKIPS and exits 0. It never soft-fails on a host it could read: every check
 * below is a disagreement, and a disagreement exits non-zero.
 *
 * ## Usage
 *
 *   node tools/probe-host.mjs
 *   DSH_VIEWER_KIT_ASAR=/path/to/app.asar node tools/probe-host.mjs
 *
 * @module tools/probe-host
 */

import { existsSync, openSync, readSync, closeSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Where the client module system's two halves live inside the archive. */
const CLIENT_MODULES = 'dsh/node_modules/@deepseek-ai/dsh-client-modules/lib'

/**
 * The host half bridges the patch row's config to the browser over one HTTP
 * route, so these three host contracts are as load-bearing as the chunk rule:
 * the web server's `register` shape, the exact-route table's duplicate check,
 * and the origin fence that an `exact` registration sits outside of.
 */
const HOST_WEB_SERVER = 'dsh/node_modules/@deepseek-ai/dsh-host-webserver/lib/index.js'

// ---------------------------------------------------------------------------
// Locating the archive
// ---------------------------------------------------------------------------

/**
 * Every install location worth looking at, most specific first.
 *
 * The override is first so a developer on an unusual layout — and this probe's
 * own negative test — can point it anywhere. After that, the standard install
 * path is tried on every fixed drive: DSH is a per-machine install and nothing
 * guarantees it shares a drive with the checkout, so hardcoding `C:\` would
 * make this silently skip on exactly the machines that should be checking.
 *
 * @returns {string[]} existing paths, in priority order
 */
function candidateAsars() {
  /** @type {string[]} */
  const roots = []
  const fromEnv = process.env.DSH_VIEWER_KIT_ASAR
  if (fromEnv !== undefined && fromEnv !== '') {
    // An explicit override that does not exist is an error, not a hint. Falling
    // back to auto-discovery here would validate a *different* build than the
    // one the caller named, and report it as a pass.
    if (!existsSync(fromEnv)) {
      process.stderr.write(`probe-host: DSH_VIEWER_KIT_ASAR points at ${fromEnv}, which does not exist\n`)
      process.exit(1)
    }
    return [fromEnv]
  }

  const drives = new Set()
  for (const value of [process.env.ProgramW6432, process.env.ProgramFiles, process.env.LOCALAPPDATA]) {
    if (value === undefined) continue
    const drive = String(value).slice(0, 2)
    if (/^[A-Za-z]:$/.test(drive)) drives.add(drive.toUpperCase())
  }
  // Always include C: and D:, so a machine whose env vars point somewhere else
  // still gets checked rather than skipped.
  drives.add('C:')
  drives.add('D:')

  for (const drive of drives) {
    roots.push(join(`${drive}\\`, 'Program Files', 'DeepSeek Harness', 'resources', 'app.asar'))
    roots.push(join(`${drive}\\`, 'Program Files (x86)', 'DeepSeek Harness', 'resources', 'app.asar'))
  }
  const localAppData = process.env.LOCALAPPDATA
  if (localAppData) {
    roots.push(join(localAppData, 'Programs', 'DeepSeek Harness', 'resources', 'app.asar'))
  }

  const seen = new Set()
  /** @type {string[]} */
  const existing = []
  for (const path of roots) {
    if (seen.has(path)) continue
    seen.add(path)
    if (existsSync(path)) existing.push(path)
  }
  return existing
}

// ---------------------------------------------------------------------------
// A minimal asar reader
// ---------------------------------------------------------------------------

/**
 * Open an asar and return a reader for its members.
 *
 * The format is a 16-byte preamble (`uint32 4`, then the header pickle size
 * three times over) followed by a JSON directory tree; each file entry's
 * `offset` is relative to the end of that header. `DATA_BASE` is
 * `8 + headerSize`, NOT `16 + headerSize` — the eight-byte difference shifts
 * every read and silently returns the tail of the *previous* file, which looks
 * like plausible text right up until a small file comes back truncated.
 *
 * The descriptor stays open until `close()`: the reader is used by every
 * check, so closing it when `openAsar` returns hands back a dead handle.
 *
 * @param {string} asarPath
 * @returns {{ read: (archivePath: string) => string, close: () => void }}
 */
function openAsar(asarPath) {
  const fd = openSync(asarPath, 'r')
  let tree
  let dataBase
  try {
    const preamble = Buffer.alloc(16)
    readSync(fd, preamble, 0, 16, 0)
    const jsonLength = preamble.readUInt32LE(12)
    const header = Buffer.alloc(jsonLength)
    readSync(fd, header, 0, jsonLength, 16)
    tree = JSON.parse(header.toString('utf8'))
    dataBase = 8 + preamble.readUInt32LE(4)
  } catch (error) {
    closeSync(fd)
    throw error
  }

  return {
    read(archivePath) {
      /** @type {any} */
      let node = tree
      for (const part of archivePath.split('/')) {
        node = node?.files?.[part]
        if (node === undefined) throw new Error(`${archivePath}: not found in ${asarPath}`)
      }
      if (node.files !== undefined) throw new Error(`${archivePath} is a directory`)
      if (node.unpacked === true) throw new Error(`${archivePath} is unpacked, not in the archive body`)
      const bytes = Buffer.alloc(node.size)
      readSync(fd, bytes, 0, node.size, dataBase + Number(node.offset))
      return bytes.toString('utf8')
    },
    close: () => closeSync(fd),
  }
}

// ---------------------------------------------------------------------------
// Finding a declaration in host source
// ---------------------------------------------------------------------------

/**
 * Locate a declaration and return its 1-based line number, or null.
 *
 * Reported so a mismatch points at a line a reader can open, instead of
 * "somewhere in a 41 KB bundle".
 *
 * @param {string} source
 * @param {RegExp} pattern
 * @returns {{ line: number, text: string } | null}
 */
function locate(source, pattern) {
  const lines = source.split('\n')
  for (let index = 0; index < lines.length; index++) {
    const match = pattern.exec(lines[index])
    if (match !== null) return { line: index + 1, text: match[0].trim() }
  }
  return null
}

// ---------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------

const checks = []

/**
 * @param {string} name
 * @param {(host: {
 *   modulesPath: string,
 *   modulesText: string,
 *   clientPath: string,
 *   clientText: string,
 *   webServerPath: string,
 *   webServerText: string,
 * }) => { ok: boolean, detail: string }} run
 */
function check(name, run) {
  checks.push({ name, run })
}

const CHUNK_NAME = 'client.echarts.js'

/** The host's chunk rule, or null if the declaration moved or changed shape. */
function hostChunkRule(host) {
  const found = locate(host.modulesText, /const CLIENT_CHUNK = (\/\^.*\$\/);/)
  if (found === null) return { error: 'CLIENT_CHUNK is gone from the host bundle route' }
  const literal = /const CLIENT_CHUNK = (\/\^.*\$\/);/.exec(found.text)?.[1]
  if (literal === undefined) return { error: `${host.modulesPath}:${found.line} is no longer a regex literal` }
  return { pattern: new RegExp(literal.slice(1, -2)), literal, line: found.line }
}

check('the host accepts our chunk filename', (host) => {
  const rule = hostChunkRule(host)
  if (rule.pattern === undefined) return { ok: false, detail: rule.error }
  if (!rule.pattern.test(CHUNK_NAME)) {
    return { ok: false, detail: `host rule ${rule.literal} rejects our ${CHUNK_NAME} (${host.modulesPath}:${rule.line})` }
  }
  return { ok: true, detail: `${host.modulesPath}:${rule.line} ${rule.literal} accepts ${CHUNK_NAME}` }
})

check('the host rule still rejects a name we must not emit', (host) => {
  // A guard that only ever says yes is not a guard. These are the shapes that
  // must keep failing, because emitting one would put a file in the package
  // that the route refuses to serve.
  const rule = hostChunkRule(host)
  if (rule.pattern === undefined) return { ok: false, detail: rule.error }
  for (const bad of ['echarts.js', 'client..js', 'client.echarts.ts', 'client.js', 'xclient.echarts.js']) {
    if (rule.pattern.test(bad)) return { ok: false, detail: `host rule ${rule.literal} now accepts ${bad}` }
  }
  return { ok: true, detail: `${host.modulesPath}:${rule.line} still rejects the five near-misses` }
})

check('require.async is how a factory asks for a chunk', (host) => {
  const found = locate(host.clientText, /require\.async = async/)
  if (found === null) {
    return { ok: false, detail: 'the browser module table no longer defines require.async' }
  }
  const routesRelative = /require\.async = async[\s\S]{0,400}?startsWith\("\.\/"\)/.test(host.clientText)
  if (!routesRelative) {
    return { ok: false, detail: `require.async (${host.clientPath}:${found.line}) no longer routes "./" to a chunk` }
  }
  return { ok: true, detail: `${host.clientPath}:${found.line} require.async, "./" goes to the chunk route` }
})

check('a missing bundle still has a named error', (host) => {
  const found = locate(host.modulesText, /MissingClientBundleError = class extends Error/)
  if (found === null) return { ok: false, detail: 'MissingClientBundleError is gone; our boot-audit diagnosis is stale' }
  return { ok: true, detail: `${host.modulesPath}:${found.line} MissingClientBundleError` }
})

check('our manifest still satisfies the host exports["./client"] reader', (host) => {
  const found = locate(host.modulesText, /function clientExportOf/)
  if (found === null) return { ok: false, detail: 'clientExportOf is gone; manifest resolution may have changed' }
  const acceptsString = /typeof client === "string"\) return client/.test(host.modulesText)
  const acceptsConditional = /typeof client === "object"[\s\S]{0,200}?client\.default/.test(host.modulesText)
  if (!acceptsString || !acceptsConditional) {
    return { ok: false, detail: `clientExportOf (${host.modulesPath}:${found.line}) no longer takes a string or {default}` }
  }
  const manifest = JSON.parse(readFileSyncUtf8(join(ROOT, 'package.json')))
  const ours = manifest.exports?.['./client']
  if (typeof ours !== 'string') {
    return { ok: false, detail: `our exports["./client"] is ${JSON.stringify(ours)}; the host wants a string` }
  }
  return { ok: true, detail: `${host.modulesPath}:${found.line} accepts our exports["./client"] = ${JSON.stringify(ours)}` }
})

check('the boot wire still carries no config, so P0 is still open', (host) => {
  // Not a "should pass" check — a tripwire. `graphRow()` builds every wire row
  // and `parseBootManifest()` reads them; neither mentioning `config` is the
  // evidence that a patch row's config cannot reach a browser plugin. The day
  // DSH adds it, this fails on purpose, because that is the day to redo P0
  // through the supported channel instead of the workaround.
  const row = locate(host.modulesText, /function graphRow\(/)
  const parse = locate(host.clientText, /function parseBootManifest\(/)
  if (row === null || parse === null) {
    return { ok: false, detail: 'graphRow or parseBootManifest moved; re-derive the P0 finding before trusting this' }
  }
  const from = (text, marker, span) => {
    const start = text.indexOf(marker)
    return start < 0 ? '' : text.slice(start, start + span)
  }
  const rowBody = from(host.modulesText, 'function graphRow(', 700)
  const parseBody = from(host.clientText, 'function parseBootManifest(', 2500)
  if (/\bconfig\b/.test(rowBody)) {
    return { ok: false, detail: `graphRow (${host.modulesPath}:${row.line}) now carries config — redo P0 the supported way` }
  }
  if (/\bconfig\b/.test(parseBody)) {
    return { ok: false, detail: `parseBootManifest (${host.clientPath}:${parse.line}) now reads config — redo P0 the supported way` }
  }
  return {
    ok: true,
    detail: `wire rows still have no config (${host.modulesPath}:${row.line}, ${host.clientPath}:${parse.line})`,
  }
})

check('our host half can still register the config route', (host) => {
  // The host half does `ctx.webServer.register({kind:'exact', path, handler})`
  // and returns the disposer. If `register` changes shape the route silently
  // stops existing, the client's fetch 404s, and every block renders at the
  // defaults — which looks exactly like "my config is being ignored".
  const register = locate(host.webServerText, /register\(route\) \{/)
  if (register === null) return { ok: false, detail: 'webServer.register is gone or renamed' }
  if (!/route\.kind === "exact"/.test(host.webServerText)) {
    return { ok: false, detail: `register (${host.webServerPath}:${register.line}) no longer keys on kind` }
  }
  if (!/table\.has\(route\.path\)\) throw new Error/.test(host.webServerText)) {
    return {
      ok: false,
      detail: `register (${host.webServerPath}:${register.line}) no longer throws on a duplicate path — our effect disposer is the only thing keeping re-activation safe`,
    }
  }
  return { ok: true, detail: `${host.webServerPath}:${register.line} register({kind, path, handler}) returns a disposer` }
})

check('an exact route still outranks the /api origin fence', (host) => {
  // Recorded because it is a decision, not an accident. The config route
  // carries no secrets, so it needs no fence; but that is only true while the
  // route stays a single GET of non-sensitive values. If DSH ever changes
  // precedence so exact routes fall *inside* the fence, the values become
  // unreadable from a page reached by name — dshmarket hit the opposite
  // problem (#729) and wrote `useTrustedHosts` to work around it.
  const register = locate(host.webServerText, /register\(route\) \{/)
  if (register === null) return { ok: false, detail: 'webServer.register is gone; re-derive the fence decision' }
  if (!/^\s*exact = /m.test(host.webServerText) || !/^\s*prefixes = /m.test(host.webServerText)) {
    return { ok: false, detail: `the exact/prefix tables (${host.webServerPath}) are gone; precedence is unknown` }
  }
  return {
    ok: true,
    detail: `exact and prefix tables still separate (${host.webServerPath}:${register.line}); the config route stays outside the /api fence by design`,
  }
})

/** @param {string} path */
function readFileSyncUtf8(path) {
  return readFileSync(path, 'utf8')
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const found = candidateAsars()
if (found.length === 0) {
  process.stdout.write('probe-host: SKIP — no DSH app.asar found, nothing to check against\n')
  process.stdout.write('            set DSH_VIEWER_KIT_ASAR to check against a specific build\n')
  process.exit(0)
}

const asar = found[0]
process.stdout.write(`probe-host: reading ${asar}\n`)

/** @type {string[]} */
const failures = []
try {
  const archive = openAsar(asar)
  const host = {
    modulesPath: `${CLIENT_MODULES}/index.js`,
    modulesText: archive.read(`${CLIENT_MODULES}/index.js`),
    clientPath: `${CLIENT_MODULES}/client.js`,
    clientText: archive.read(`${CLIENT_MODULES}/client.js`),
    webServerPath: `${HOST_WEB_SERVER}`,
    webServerText: archive.read(HOST_WEB_SERVER),
  }
  for (const { name, run } of checks) {
    try {
      const result = run(host)
      process.stdout.write(`  ${result.ok ? 'ok  ' : 'FAIL'} ${name}\n         ${result.detail}\n`)
      if (!result.ok) failures.push(name)
    } catch (error) {
      process.stdout.write(`  FAIL ${name}\n         ${String(error)}\n`)
      failures.push(name)
    }
  }
  archive.close()
} catch (error) {
  process.stdout.write(`  FAIL reading the archive\n         ${String(error)}\n`)
  process.exit(1)
}

if (failures.length > 0) {
  process.stdout.write(
    `\nprobe-host: ${failures.length} of ${checks.length} assumptions no longer hold against this DSH build.\n` +
      '            The affected feature fails silently at runtime, not loudly. Re-read the host source\n' +
      '            before changing anything here — the fix belongs in this plugin, not in the archive.\n',
  )
  process.exit(1)
}

process.stdout.write(`\nprobe-host: ${checks.length}/${checks.length} host assumptions confirmed\n`)
