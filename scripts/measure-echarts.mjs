/**
 * Build-only probe: how big is each ECharts import style?
 *
 * The renderer needs a decision between the full `echarts` entry (~1 MB) and
 * `echarts/core` with only the pieces we register. This answers that question
 * before the dependency shape is written down, because the answer decides
 * whether the chart renderer can ship in the client bundle at all.
 *
 * Dev-only; not part of the package.
 *
 * Run: node scripts/measure-echarts.mjs
 */

import { mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { build } from 'tsdown'

const SOURCES = {
  full: `import * as echarts from 'echarts'
export const mount = (el, option) => echarts.init(el).setOption(option)
`,
  coreSelective: `import * as echarts from 'echarts/core'
import { BarChart, LineChart, PieChart } from 'echarts/charts'
import {
  GridComponent,
  TooltipComponent,
  LegendComponent,
  TitleComponent,
  DataZoomComponent,
} from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'

echarts.use([
  BarChart,
  LineChart,
  PieChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  TitleComponent,
  DataZoomComponent,
  CanvasRenderer,
])

export const mount = (el, option) => echarts.init(el).setOption(option)
`,
}

for (const [name, contents] of Object.entries(SOURCES)) {
  const dir = resolve('.probe', name)
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })
  await writeFile(resolve(dir, 'entry.js'), contents, 'utf8')

  await build({
    entry: { index: resolve(dir, 'entry.js') },
    outDir: dir,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    dts: false,
    sourcemap: false,
    clean: false,
    treeshake: true,
  })

  const built = await stat(resolve(dir, 'index.js'))
  console.log(`${name.padEnd(14)} ${built.size.toLocaleString().padStart(10)} bytes`)
}

await rm(resolve('.probe'), { recursive: true, force: true })
