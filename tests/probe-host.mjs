/**
 * Negative tests for `tools/probe-host.mjs`.
 *
 * The probe's whole job is to fail when DSH changes shape underneath us, so a
 * probe that cannot fail is worse than no probe: it reports six green checks
 * and teaches everyone to trust a result that is really a constant. Every check
 * therefore gets a doctored host that must turn it red.
 *
 * The doctored hosts are synthetic asar archives written to a temp directory,
 * built to the real format — 16-byte preamble, JSON directory tree, offsets
 * relative to the end of the header. That exercises the real reader, the real
 * CLI and the real exit code, rather than a mock of them.
 *
 * One case matters as much as the failures: the **faithful** archive, made only
 * of the declarations the checks look at, must pass. Without it, a probe that
 * fails on everything would satisfy every test below.
 *
 * @module tests/probe-host
 */

import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PROBE = join(ROOT, 'tools', 'probe-host.mjs')

let passed = 0
/** @type {string[]} */
const failures = []

/**
 * @param {string} name
 * @param {() => void} body
 */
function test(name, body) {
  try {
    body()
    passed++
    process.stdout.write(`  ok   ${name}\n`)
  } catch (error) {
    failures.push(name)
    process.stdout.write(`  FAIL ${name}\n       ${error instanceof Error ? error.message : String(error)}\n`)
  }
}

/**
 * @param {unknown} actual
 * @param {unknown} expected
 * @param {string} message
 */
function eq(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}\n       expected: ${String(expected)}\n       actual:   ${String(actual)}`)
  }
}

// ---------------------------------------------------------------------------
// A minimal asar writer
// ---------------------------------------------------------------------------

/**
 * Write an archive in the real asar format.
 *
 * The preamble is the part worth spelling out, because the probe's reader is
 * where an eight-byte mistake hides: `4`, then `8 + jsonSize` twice over
 * (once as the header pickle size, once with four added), then `jsonSize`. File
 * offsets are relative to `16 + jsonSize`, not to the end of the JSON.
 *
 * @param {string} dir where to create the archive
 * @param {Record<string, string>} files archive path -> contents
 * @returns {string} the archive path
 */
function writeAsar(dir, files) {
  /** @type {any} */
  const tree = { files: {} }
  const parts = []
  let bodyLength = 0
  for (const [archivePath, contents] of Object.entries(files)) {
    const segments = archivePath.split('/')
    let node = tree
    for (const segment of segments.slice(0, -1)) {
      node.files[segment] ??= { files: {} }
      node = node.files[segment]
    }
    const bytes = Buffer.from(contents, 'utf8')
    node.files[segments[segments.length - 1]] = { size: bytes.length, offset: String(bodyLength) }
    parts.push(bytes)
    bodyLength += bytes.length
  }

  const json = Buffer.from(JSON.stringify(tree), 'utf8')
  const jsonSize = json.length
  const preamble = Buffer.alloc(16)
  preamble.writeUInt32LE(4, 0)
  preamble.writeUInt32LE(8 + jsonSize, 4)
  preamble.writeUInt32LE(jsonSize + 4, 8)
  preamble.writeUInt32LE(jsonSize, 12)

  const archivePath = join(dir, 'app.asar')
  writeFileSync(archivePath, Buffer.concat([preamble, json, ...parts]))
  return archivePath
}

// ---------------------------------------------------------------------------
// Host source, reduced to what the checks read
// ---------------------------------------------------------------------------

const GOOD_CHUNK_RULE = 'const CLIENT_CHUNK = /^client\\.[A-Za-z0-9][A-Za-z0-9._-]*\\.js$/;'

/**
 * A faithful reduction of `@deepseek-ai/dsh-client-modules/lib/index.js`.
 *
 * @param {{ chunkRule?: string, withMissingError?: boolean, withClientExport?: boolean, graphRowExtra?: string }} [overrides]
 * @returns {string}
 */
function hostIndex(overrides = {}) {
  return [
    'import { readFileSync } from "node:fs";',
    overrides.withMissingError === false ? '' : 'var MissingClientBundleError = class extends Error { constructor(pkg, path, cause) { super("missing"); } };',
    '',
    overrides.chunkRule ?? GOOD_CHUNK_RULE,
    '/** Resolve `exports["./client"]`. */',
    overrides.withClientExport === false
      ? 'function clientExportOf(pkgName, exportsField) { return void 0; }'
      : [
          'function clientExportOf(pkgName, exportsField) {',
          '\tif (typeof exportsField !== "object" || exportsField === null) return void 0;',
          '\tconst client = exportsField["./client"];',
          '\tif (typeof client === "string") return client;',
          '\tif (typeof client === "object" && client !== null) {',
          '\t\tconst fallback = client.default;',
          '\t\tif (typeof fallback === "string") return fallback;',
          '\t}',
          '\tthrow new Error("bad export");',
          '}',
        ].join('\n'),
    '',
    '/** Graph row for one bundle rev. */',
    'function graphRow(id, rev, fields) {',
    '\treturn {',
    '\t\tid,',
    '\t\turl: comboReference([id], rev),',
    '\t\trev,',
    (overrides.graphRowExtra ?? '\t\t...fields.inject !== void 0 ? { inject: fields.inject } : {},'),
    '\t\t...fields.external.length > 0 ? { external: fields.external } : {}',
    '\t};',
    '}',
  ]
    .filter((line) => line !== '')
    .join('\n')
}

/**
 * A faithful reduction of `lib/client.js`.
 *
 * @param {{ withRequireAsync?: boolean, parseExtra?: string }} [overrides]
 * @returns {string}
 */
function hostClient(overrides = {}) {
  return [
    '/** Parse `window.__DSH_BOOT__`. */',
    'function parseBootManifest(wire) {',
    '\tconst moduleFields = [];',
    '\tconst plugins = [];',
    overrides.parseExtra ?? '\tmoduleFields.push({ id: row.id, url: row.url, rev: row.rev });',
    '\treturn { modules: moduleFields, plugins, batches: [] };',
    '}',
    '',
    'makeRequire(ownerId, edges) {',
    '\tconst require = (spec) => spec;',
    overrides.withRequireAsync === false
      ? '\treturn require;'
      : [
          '\trequire.async = async (spec) => {',
          '\t\tedges.add(spec);',
          '\t\tif (!spec.startsWith("./")) return await this.import(spec);',
          '\t\tconst fileName = spec.slice(2);',
          '\t\treturn await this.importChunk(ownerId, fileName);',
          '\t};',
          '\treturn require;',
        ].join('\n'),
    '}',
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Run the probe against a synthetic host
// ---------------------------------------------------------------------------

const workdir = mkdtempSync(join(tmpdir(), 'dvk-probe-'))
let caseIndex = 0

/**
 * Build an archive and run the real CLI against it.
 *
 * @param {{ index?: string, client?: string }} [host]
 * @returns {{ status: number, output: string, failed: string[] }}
 */
function runProbe(host = {}) {
  const dir = join(workdir, `case-${caseIndex++}`)
  mkdirSync(dir, { recursive: true })
  const archive = writeAsar(dir, {
    'dsh/node_modules/@deepseek-ai/dsh-client-modules/lib/index.js': host.index ?? hostIndex(),
    'dsh/node_modules/@deepseek-ai/dsh-client-modules/lib/client.js': host.client ?? hostClient(),
  })
  const result = spawnSync(process.execPath, [PROBE], {
    encoding: 'utf8',
    env: { ...process.env, DSH_VIEWER_KIT_ASAR: archive },
  })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  return {
    status: result.status ?? -1,
    output,
    failed: [...output.matchAll(/^ {2}FAIL (.+)$/gm)].map((match) => match[1].trim()),
  }
}

process.stdout.write('probe-host (negative tests: the probe must be able to fail)\n')

test('a faithful host passes every check', () => {
  const result = runProbe()
  eq(result.status, 0, `expected exit 0, got ${result.status}\n${result.output}`)
  eq(result.output.includes('6/6 host assumptions confirmed'), true, `expected 6/6\n${result.output}`)
})

test('a host that stops accepting our chunk filename is caught', () => {
  const result = runProbe({ index: hostIndex({ chunkRule: 'const CLIENT_CHUNK = /^client\\.js$/;' }) })
  eq(result.status, 1, 'must exit non-zero')
  eq(result.failed.includes('the host accepts our chunk filename'), true, `expected that check to fail\n${result.output}`)
})

test('a host rule that starts accepting a bad name is caught', () => {
  // The inverse direction: a rule that grew too loose would let us ship a file
  // the route then refuses to serve. Only the second check can see this.
  const result = runProbe({ index: hostIndex({ chunkRule: 'const CLIENT_CHUNK = /^(client\\.)?.*\\.js$/;' }) })
  eq(result.status, 1, 'must exit non-zero')
  eq(result.failed.includes('the host rule still rejects a name we must not emit'), true, `expected that check to fail\n${result.output}`)
})

test('a host without require.async is caught', () => {
  const result = runProbe({ client: hostClient({ withRequireAsync: false }) })
  eq(result.status, 1, 'must exit non-zero')
  eq(result.failed.includes('require.async is how a factory asks for a chunk'), true, `expected that check to fail\n${result.output}`)
})

test('a host without a named missing-bundle error is caught', () => {
  const result = runProbe({ index: hostIndex({ withMissingError: false }) })
  eq(result.status, 1, 'must exit non-zero')
  eq(result.failed.includes('a missing bundle still has a named error'), true, `expected that check to fail\n${result.output}`)
})

test('a host that stops reading exports["./client"] as a string is caught', () => {
  const result = runProbe({ index: hostIndex({ withClientExport: false }) })
  eq(result.status, 1, 'must exit non-zero')
  eq(result.failed.includes('our manifest still satisfies the host exports["./client"] reader'), true, `expected that check to fail\n${result.output}`)
})

test('a host that starts shipping config on the wire is caught', () => {
  // The tripwire. DSH adding config to a graph row is the good news P0 has
  // been waiting for, and this must go red the day it lands.
  const result = runProbe({ index: hostIndex({ graphRowExtra: '\t\t...fields.config,' }) })
  eq(result.status, 1, 'must exit non-zero')
  eq(result.failed.includes('the boot wire still carries no config, so P0 is still open'), true, `expected that check to fail\n${result.output}`)
})

test('a named archive that is not there is an error, never a silent fallback', () => {
  // The bug this caught: a bad override used to fall through to auto-discovery
  // and check whatever DSH happened to be installed — a green run against a
  // build the caller never named.
  const missing = join(workdir, 'nope.asar')
  const result = spawnSync(process.execPath, [PROBE], {
    encoding: 'utf8',
    env: { ...process.env, DSH_VIEWER_KIT_ASAR: missing },
  })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  eq(result.status, 1, `must exit non-zero\n${output}`)
  eq(output.includes(missing), true, `must name the path it could not read\n${output}`)
  eq(output.includes('assumptions confirmed'), false, `must not report a pass\n${output}`)
})

test('a truncated archive fails loudly rather than reading garbage', () => {
  // The eight-byte offset trap: reading a shifted archive returns the tail of
  // whichever file precedes it, which looks like plausible source. Every check
  // would then "pass" for the wrong reason, so a broken archive must be an
  // error, not a green run.
  const dir = join(workdir, 'truncated')
  mkdirSync(dir, { recursive: true })
  const archive = writeAsar(dir, {
    'dsh/node_modules/@deepseek-ai/dsh-client-modules/lib/index.js': hostIndex(),
    'dsh/node_modules/@deepseek-ai/dsh-client-modules/lib/client.js': hostClient(),
  })
  writeFileSync(archive, Buffer.from('not an asar at all'))
  const result = spawnSync(process.execPath, [PROBE], {
    encoding: 'utf8',
    env: { ...process.env, DSH_VIEWER_KIT_ASAR: archive },
  })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  eq(result.status, 1, `must exit non-zero\n${output}`)
  eq(output.includes('assumptions confirmed'), false, `must not report a pass\n${output}`)
})

rmSync(workdir, { recursive: true, force: true })

process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`)
if (failures.length > 0) {
  for (const name of failures) process.stdout.write(`  ✗ ${name}\n`)
  process.exit(1)
}
