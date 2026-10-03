/**
 * Build-only probe: what does a dynamic chunk actually look like here?
 *
 * The chart renderer has to load ECharts on demand, and the DSH client module
 * contract is narrow and unforgiving:
 *
 *   - a chunk file must be named `client.<name>.js`, next to `client.js`;
 *   - the entry must ask for it with `require.async('./client.<name>.js')`,
 *     NOT a dynamic `import()`;
 *   - the chunk must call `window.__ModuleLoader__.load({ id, factory })`
 *     itself, and its own id is `<package>/<fileName>` — so a content hash in
 *     the filename would be self-referential.
 *
 * Three things are therefore unverified and this probe settles them:
 *
 *   Q1  what does `await import('./x')` compile to under `format: 'cjs'`?
 *   Q2  does `chunkFileNames: 'client.[name].js'` land in outDir as wanted?
 *   Q3  can `banner` be a function that varies per emitted chunk?
 *
 * Run: node scripts/probe-chunk.mjs
 */

import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { build } from 'tsdown'

const dir = resolve('.probe-chunk')
await rm(dir, { recursive: true, force: true })
await mkdir(dir, { recursive: true })

// Q1: a dynamic import, and a use of the factory-scoped `require` alias.
await writeFile(
  resolve(dir, 'main.js'),
  `export const loadIt = () => import('./heavy.js')
export const viaRequire = (spec) => __dvkRequire(spec)
`,
  'utf8',
)
// Q3: a chunk that wants a DIFFERENT banner than the entry.
await writeFile(resolve(dir, 'heavy.js'), `export const heavy = { bytes: 1_500_000 }\nexport default heavy\n`, 'utf8')

await build({
  entry: { client: resolve(dir, 'main.js') },
  outDir: dir,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  dts: false,
  sourcemap: false,
  clean: false,
  treeshake: true,
  outputOptions: {
    entryFileNames: '[name].js',
    chunkFileNames: 'client.[name].js',
    // Q3: a function banner — is it even called, and does it get per-chunk info?
    banner: (chunk) => {
      const name = chunk && chunk.name ? String(chunk.name) : '(no name)'
      return `/* banner-for: ${name} */\nwindow.__ModuleLoader__ = window.__ModuleLoader__ || {}\n`
    },
  },
})

const files = await readdir(dir, { withFileTypes: true })
console.log('emitted files:')
for (const file of files) {
  if (!file.isFile()) continue
  const body = await readFile(resolve(dir, file.name), 'utf8')
  console.log(`  ${file.name.padEnd(24)} ${String(body.length).padStart(9)} bytes`)
}

const main = await readFile(resolve(dir, 'client.js'), 'utf8')
console.log('\nQ1 — what did the dynamic import become?')
for (const line of main.split('\n')) {
  if (line.includes('import(') || line.includes('heavy') || line.includes('__dvkRequire')) {
    console.log(`  ${line.trim().slice(0, 160)}`)
  }
}
console.log('\nQ3 — banner text seen in the entry:')
console.log(`  ${main.split('\n')[0]}`)

const heavyName = files.find((f) => f.isFile() && f.name !== 'client.js' && f.name.endsWith('.js'))
if (heavyName !== undefined) {
  const heavy = await readFile(resolve(dir, heavyName.name), 'utf8')
  console.log(`\nQ3 — banner text seen in ${heavyName.name}: ${heavy.split('\n')[0]}`)
  console.log(`     filename matches /^client\\.[A-Za-z0-9][A-Za-z0-9._-]*\\.js$/ : ` +
    `/^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$/.test(${JSON.stringify(heavyName.name)})`)
}

await rm(dir, { recursive: true, force: true })
