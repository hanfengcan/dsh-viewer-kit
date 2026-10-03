/**
 * Copy the Host half into `lib/`.
 *
 * The client half is a bundle (tsdown, see tsdown.config.ts). The Host half is
 * one plain module with nothing to resolve, so it is copied verbatim rather
 * than given a build step it does not need — that keeps `main` pointing at a
 * real file with no bundler in the loop.
 *
 * @module scripts/build-host
 */

import { copyFile, mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE = join(ROOT, 'src', 'index.js')
const TARGET = join(ROOT, 'lib', 'index.js')

await mkdir(dirname(TARGET), { recursive: true })
await copyFile(SOURCE, TARGET)
process.stdout.write(`built host half: src/index.js -> lib/index.js\n`)
