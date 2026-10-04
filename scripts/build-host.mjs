/**
 * Copy the Host half into `lib/`.
 *
 * The client half is a bundle (tsdown, see tsdown.config.ts). The Host half is
 * plain modules with nothing to resolve, so they are copied verbatim rather
 * than given a build step they do not need — that keeps `main` pointing at a
 * real file with no bundler in the loop.
 *
 * Two files, not one. `index.js` imports `./schema.js`, and that import is
 * resolved by the host's ESM loader at activation time from the installed
 * package directory — so a missing `lib/schema.js` is not a build warning, it
 * is `ERR_MODULE_NOT_FOUND` on the entry DSH loads. `tools/preflight.mjs`
 * checks the extracted tarball for exactly this.
 *
 * @module scripts/build-host
 */

import { copyFile, mkdir, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Host-side modules, copied one-for-one into `lib/`. */
const SOURCES = ['index.js', 'schema.js']

const TARGET_DIR = join(ROOT, 'lib')

// Remove first so a deleted or renamed source cannot leave a stale module
// behind in `lib/` — and, because `lib/` ships in the tarball, a stale file
// there is a file installed on someone else's machine that no source explains.
await rm(TARGET_DIR, { recursive: true, force: true })
await mkdir(TARGET_DIR, { recursive: true })

for (const name of SOURCES) {
  await copyFile(join(ROOT, 'src', name), join(TARGET_DIR, name))
  process.stdout.write(`built host half: src/${name} -> lib/${name}\n`)
}
