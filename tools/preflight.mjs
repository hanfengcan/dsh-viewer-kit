/**
 * Preflight a packed tarball the way `dsh plugin add <tarball>` will consume it.
 *
 * `pnpm pack` proves the archive has the right files; it does not prove the
 * package is *self-consistent* once installed somewhere else. The three things
 * DSH checks at activation all resolve by path, so they are worth testing
 * against the extracted copy rather than the working tree:
 *
 *   1. `package.json` declares `dsh.bundle.patch` and `dsh.client.platform: web`
 *      — without the first, `dsh plugin` installs it as a plain dependency and
 *      warns that it activates no layer;
 *   2. `exports["./client"]` points at a file that exists, because the host
 *      `readFileSync`s it and throws `MissingClientBundleError` otherwise, and
 *      the renderer's boot audit turns that into a failed startup;
 *   3. the host half imports and exports `apply`.
 *
 * Then it runs the extracted client bundle through the strict activation
 * harness, so the artifact being shipped is the artifact that was tested.
 *
 * Usage:
 *   node tools/preflight.mjs            # pack, extract to a temp dir, check, clean up
 *   node tools/preflight.mjs <dir>      # check an already-extracted package
 *
 * @module tools/preflight
 */

import { execFileSync, execSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { activateBundle } from '../tests/ctx-harness.mjs'
import { codeBlockFixture, conversationFixture, HTML_SAMPLE } from '../tests/fixtures.mjs'

/** @param {string} message */
function fail(message) {
  process.stdout.write(`  FAIL  ${message}\n`)
  process.exitCode = 1
}

/** @param {string} message */
function ok(message) {
  process.stdout.write(`  ok    ${message}\n`)
}

/**
 * Pack the repo and unpack it somewhere else, so the checks below run against
 * the bytes a user would actually receive rather than the working tree.
 *
 * @returns {string} path to the extracted `package/` directory
 */
function packAndExtract() {
  const scratch = mkdtempSync(join(tmpdir(), 'dvk-preflight-'))
  process.stdout.write(`packing into ${scratch}\n`)

  // `shell: true` is required, not cosmetic: Node ≥ 18.20 refuses to spawn a
  // `.cmd` shim (npm is one on Windows) without a shell, and fails with EINVAL.
  // The command is passed as ONE string rather than argv + shell, because argv
  // is only concatenated in that mode — no escaping — which Node deprecates.
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  try {
    execSync(`${npm} pack --pack-destination "${scratch}" --silent`, {
      cwd: process.cwd(),
      stdio: ['ignore', 'ignore', 'inherit'],
    })
  } catch (error) {
    throw new Error(
      `npm pack failed (${error.message}). Run \`npm pack\` yourself, extract it, and pass the directory: node tools/preflight.mjs <dir>`,
    )
  }

  const tarball = readdirSync(scratch).find((name) => name.endsWith('.tgz'))
  if (tarball === undefined) throw new Error('npm pack produced no tarball')
  process.stdout.write(`tarball: ${tarball}\n`)

  execFileSync('tar', ['-xzf', join(scratch, tarball), '-C', scratch], { stdio: 'inherit' })
  return join(scratch, 'package')
}

const given = process.argv[2]
let PKG_DIR
let scratchRoot = null
try {
  if (given === undefined) {
    PKG_DIR = packAndExtract()
    scratchRoot = resolve(PKG_DIR, '..')
  } else {
    PKG_DIR = resolve(given)
  }
} catch (error) {
  process.stderr.write(`${error.message}\n`)
  process.exit(2)
}

const problems = []

process.stdout.write(`preflight: ${PKG_DIR}\n`)

// --- 1. manifest ------------------------------------------------------------
const manifestPath = join(PKG_DIR, 'package.json')
if (!existsSync(manifestPath)) {
  fail('package.json is missing from the archive')
  process.exit(1)
}
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
ok(`package.json: ${manifest.name}@${manifest.version}`)

if (manifest.name !== 'dsh-viewer-kit') problems.push(`unexpected package name ${manifest.name}`)
if (manifest.type !== 'module') problems.push('type must be "module"')

const patchDeclaration = manifest.dsh?.bundle?.patch
if (patchDeclaration === undefined) {
  problems.push('dsh.bundle.patch is missing — dsh would install this as a plain dependency and activate no layer')
} else {
  const patchPath = join(PKG_DIR, patchDeclaration)
  if (!existsSync(patchPath)) {
    problems.push(`dsh.bundle.patch points at a missing file: ${patchDeclaration}`)
  } else {
    const patch = readFileSync(patchPath, 'utf8')
    if (!/^\s*-\s*insert:/m.test(patch)) {
      problems.push(`${patchDeclaration} declares no "insert" row`)
    } else {
      const rowName = /name:\s*['"]?([^'"\n]+)['"]?/.exec(patch)?.[1]?.trim()
      if (rowName !== manifest.name) {
        problems.push(`${patchDeclaration} inserts "${rowName}" but the package is "${manifest.name}" — the row must name the package so Node can resolve it`)
      } else {
        ok(`dsh.bundle.patch -> ${patchDeclaration} (inserts ${rowName})`)
      }
    }
  }
}

if (manifest.dsh?.client?.platform !== 'web') {
  problems.push('dsh.client.platform must be "web" or the web boot graph skips this bundle')
} else {
  ok('dsh.client.platform: web')
}

// --- 2. the entry points DSH resolves by path -------------------------------
const mainRel = manifest.main
if (typeof mainRel !== 'string' || !existsSync(join(PKG_DIR, mainRel))) {
  problems.push(`main (${String(mainRel)}) does not resolve inside the archive`)
} else {
  ok(`main -> ${mainRel}`)
}

const clientRel = typeof manifest.exports?.['./client'] === 'string'
  ? manifest.exports['./client']
  : manifest.exports?.['./client']?.default
if (typeof clientRel !== 'string') {
  problems.push('exports["./client"] is missing — the host could not locate the client bundle')
} else {
  const clientPath = join(PKG_DIR, clientRel)
  if (!existsSync(clientPath)) {
    problems.push(`exports["./client"] points at a missing file: ${clientRel} (this is the MissingClientBundleError path)`)
  } else {
    const size = statSync(clientPath).size
    ok(`exports["./client"] -> ${clientRel} (${size} bytes)`)
  }
}

// --- 3. the host half actually loads ----------------------------------------
if (typeof mainRel === 'string' && existsSync(join(PKG_DIR, mainRel))) {
  try {
    const host = await import(pathToFileURL(join(PKG_DIR, mainRel)).href)
    if (typeof host.apply !== 'function') problems.push(`${mainRel} does not export apply()`)
    else ok(`${mainRel} exports apply()`)
  } catch (error) {
    problems.push(`${mainRel} failed to import: ${error.message}`)
  }
}

// --- 4. the shipped client bundle activates ---------------------------------
if (typeof clientRel === 'string' && existsSync(join(PKG_DIR, clientRel))) {
  const bundle = readFileSync(join(PKG_DIR, clientRel), 'utf8')
  const run = activateBundle(bundle, {
    fixtureHtml: conversationFixture([
      { nodeKey: 'n-1', html: codeBlockFixture({ lang: 'html', code: HTML_SAMPLE }) },
    ]),
  })
  if (!run.applied.ok) {
    problems.push(`the shipped bundle threw during apply(): ${run.applied.error?.message}`)
  } else if (run.switches !== 1) {
    problems.push(`the shipped bundle enhanced ${run.switches} blocks, expected 1`)
  } else if (run.violations.length > 0) {
    problems.push(`the shipped bundle read an undocumented ctx member: ${run.violations[0]}`)
  } else {
    ok('the shipped client bundle activates under a strict ctx and enhances a fixture block')
  }
}

// --- 5. the on-demand chunk, if the entry asks for one ---------------------
//
// The chart engine is a sibling file the host serves on demand, and the request
// is a plain string inside the entry bundle. Nothing at install time would notice
// a mismatch — a wrong file name 404s when the first chart appears, and a chunk
// registered under the wrong id throws "loaded without registering" there. So
// the archive is checked for the pairing the build config promises.
if (typeof clientRel === 'string' && existsSync(join(PKG_DIR, clientRel))) {
  const entry = readFileSync(join(PKG_DIR, clientRel), 'utf8')
  const requested = /\.\/(client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js)/.exec(entry)?.[1]
  if (requested === undefined) {
    ok('the entry requests no on-demand chunk')
  } else {
    const chunkPath = join(PKG_DIR, dirname(clientRel), requested)
    if (!existsSync(chunkPath)) {
      problems.push(
        `the entry requests "./${requested}" but the archive has no such file — every chart would 404`,
      )
    } else {
      const chunk = readFileSync(chunkPath, 'utf8')
      const expectedId = `${manifest.name}/${requested}`
      if (!chunk.startsWith(`window.__ModuleLoader__.load({ id: ${JSON.stringify(expectedId)},`)) {
        problems.push(
          `client/${requested} must register itself as ${JSON.stringify(expectedId)}; ` +
            'a different id makes every chart throw "loaded without registering"',
        )
      } else if (statSync(chunkPath).size < 500_000) {
        problems.push(
          `client/${requested} is only ${statSync(chunkPath).size} bytes — the chart engine looks absent`,
        )
      } else {
        ok(`on-demand chunk -> client/${requested} (${statSync(chunkPath).size.toLocaleString()} bytes, id ${expectedId})`)
      }
    }
  }
}

// --- 6. nothing unintended shipped ------------------------------------------
const entries = readdirSync(PKG_DIR, { recursive: true })
const unwanted = entries.filter((entry) => {
  const value = String(entry)
  return value.includes('node_modules') || value.startsWith('tests') || value.endsWith('.tgz')
})
if (unwanted.length > 0) problems.push(`archive contains files it should not: ${unwanted.slice(0, 3).join(', ')}`)
else ok('no node_modules / tests / nested tarballs in the archive')

// --- verdict ----------------------------------------------------------------
if (scratchRoot !== null) {
  // The extract — and the prepack build that produced it — is throwaway.
  try {
    rmSync(scratchRoot, { recursive: true, force: true })
    process.stdout.write(`\ncleaned up ${scratchRoot}\n`)
  } catch (error) {
    process.stdout.write(`\nnote: could not remove ${scratchRoot} (${error.message})\n`)
  }
}

if (problems.length > 0) {
  process.stdout.write(`\npreflight FAILED (${problems.length} problem${problems.length === 1 ? '' : 's'}):\n`)
  for (const problem of problems) process.stdout.write(`  - ${problem}\n`)
  process.exitCode = 1
} else {
  process.stdout.write('\npreflight OK — the archive is installable as a dsh bundle\n')
}
