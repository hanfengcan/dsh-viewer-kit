/**
 * Verify that the Host actually serves this plugin's client bundle.
 *
 * The `/plugins` route addresses a resource by its artifact revision, which
 * `dsh-client-modules` derives from filesystem metadata without hashing the
 * contents:
 *
 *   rev = sha1("plugin-artifact" + "\0"
 *              + len(mtimeMs) + ":" + mtimeMs
 *              + len(ctimeMs)  + ":" + ctimeMs
 *              + len(size)     + ":" + size).hex.slice(0, 12)
 *
 * — `dsh-client-modules/lib/index.js:186-199`
 *
 * So the exact URL the browser will request is computable locally. Fetching it
 * is the only end-to-end proof that the Host both scanned `dsh.client` and can
 * read the built bundle.
 *
 * @module tools/verify-served
 */

import { createHash } from 'node:crypto'
import { statSync } from 'node:fs'
import { join } from 'node:path'

const PROFILE = 'C:/Users/HY00400676/.dsh/profiles/desktop'
const ID = 'dsh-viewer-kit'
const BASE = process.env.DSH_URL ?? 'http://127.0.0.1:19387'

/** sha1 metadata hash shortened to 12 hex chars, as the Host computes it. */
function framedHash(domain, parts) {
  const hash = createHash('sha1').update(domain).update('\0')
  for (const part of parts) hash.update(`${String(Buffer.byteLength(part))}:`).update(part)
  return hash.digest('hex').slice(0, 12)
}

const path = join(PROFILE, 'node_modules', ID, 'client', 'client.js')
const stat = statSync(path)
const rev = framedHash('plugin-artifact', [String(stat.mtimeMs), String(stat.ctimeMs), String(stat.size)])

process.stdout.write(`bundle : ${path}\n`)
process.stdout.write(`size   : ${stat.size}  mtimeMs=${stat.mtimeMs}  ctimeMs=${stat.ctimeMs}\n`)
process.stdout.write(`rev    : ${rev}\n\n`)

for (const id of [ID, 'dshmarket']) {
  const url = `${BASE}/plugins/${id}/client?rev=${rev}`
  try {
    const response = await fetch(url)
    const body = await response.text()
    const head = body.slice(0, 80).replaceAll('\n', '\\n')
    process.stdout.write(`${response.status} ${url}\n     ${body.length} bytes, starts: ${head}\n\n`)
  } catch (error) {
    process.stdout.write(`ERR ${url}\n     ${error.message}\n\n`)
  }
}
