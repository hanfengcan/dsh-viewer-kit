/**
 * Reproduce / verify the client-entry activation against a strict context.
 *
 * Run: `pnpm run repro`
 *
 * Kept as a standalone script as well as a `pnpm test` case, because when the
 * renderer's boot audit fails it only ever reports `<name>: failed` and the
 * real stack goes to a console nobody is looking at. This prints the stack.
 *
 * @module tests/repro-activation
 */

import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { activateBundle } from './ctx-harness.mjs'
import { codeBlockFixture, conversationFixture, HTML_SAMPLE } from './fixtures.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const FIXTURE = conversationFixture([
  { nodeKey: 'n-1', html: codeBlockFixture({ lang: 'html', code: HTML_SAMPLE }) },
])

const bundle = await readFile(join(ROOT, 'client', 'client.js'), 'utf8')
const run = activateBundle(bundle, { fixtureHtml: FIXTURE })

process.stdout.write(`boot marker      : ${run.bootMarker}\n`)

if (!run.applied.ok) {
  process.stdout.write(`apply()          : THREW\n`)
  process.stdout.write(`  ${run.applied.error?.message}\n`)
  process.stdout.write(`  ${String(run.applied.error?.stack).split('\n').slice(1, 4).join('\n  ')}\n`)
  process.exitCode = 1
} else {
  process.stdout.write(`apply()          : ok\n`)
  process.stdout.write(`enhanced blocks  : ${run.switches}\n`)
  process.stdout.write(`__DSH_VIEWER_KIT__: ${run.hook}\n`)
  process.stdout.write(`effects registered: ${run.effects.map((effect) => effect.label).join(', ') || '(none)'}\n`)
  if (run.log.length > 0) process.stdout.write(`log              : ${run.log.join(' | ')}\n`)

  run.unload()
  const afterUnload = run.env.document.querySelectorAll('[data-dvk-switch]').length
  const stylesAfter = run.env.document.querySelectorAll('style[data-plugin="dsh-viewer-kit"]').length
  process.stdout.write(`after unload     : ${afterUnload} switch(es), ${stylesAfter} style tag(s)\n`)

  const problems = []
  if (run.switches === 0) problems.push('apply() did not enhance the fixture block')
  if (run.hook !== 'object') problems.push('__DSH_VIEWER_KIT__ was not installed')
  if (run.effects.length === 0) problems.push('no disposer was registered with ctx.effect')
  if (afterUnload !== 0) problems.push('unload left our nodes behind')
  if (stylesAfter !== 0) problems.push('unload left our stylesheet behind')
  if (problems.length > 0) {
    process.stdout.write(`\nFAILED:\n${problems.map((problem) => `  - ${problem}`).join('\n')}\n`)
    process.exitCode = 1
  } else {
    process.stdout.write('\nOK\n')
  }
}
