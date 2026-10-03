/**
 * The chart engine, in its own file so it is fetched only when a chart exists.
 *
 * This module is the *entire* reason the chart renderer needs the DSH chunk
 * machinery. ECharts is ~1.5 MB trimmed to `echarts/core`; inlined into the
 * entry it would be paid for by every user on every page load.
 *
 * ## Which ECharts is imported
 *
 * `echarts/core` plus explicit `use()` registrations, never the full `echarts`
 * entry. Measured with `scripts/measure-echarts.mjs`:
 *
 *     echarts (full)                 2,719,242 bytes
 *     echarts/core + registered set  1,466,508 bytes
 *
 * The saving is the point, but so is the shape: **adding a chart type is one
 * line in the `use()` array below**, and it costs a user nothing who never
 * writes that fence. That is the same "one line to grow" promise the renderer
 * layer makes, one level down.
 *
 * ## Trust boundary
 *
 * ECharts is bundled, trusted, and runs in the *host* page — not in a sandboxed
 * frame. That is deliberate: the alternative was letting the model emit
 * `<script src=…echarts>` inside previewed HTML, which would have required
 * `htmlAllowScripts` and reopened the question settled in
 * docs/01-architecture.md §8. With this split, `htmlAllowScripts` stays off and
 * a chart costs no extra authority at all.
 *
 * What that does *not* mean: the option object is model-authored data. ECharts
 * never evaluates it, but it will happily draw a `graphic` element whose
 * `style.image` is a remote URL, so rendering a chart can start a network
 * request. The renderer forces a non-HTML tooltip for the sharper edge and the
 * rest is documented rather than silently relied upon.
 *
 * @module chunks/echarts
 */

import { BarChart, LineChart, PieChart, ScatterChart } from 'echarts/charts'
import {
  DatasetComponent,
  DataZoomComponent,
  GridComponent,
  LegendComponent,
  TitleComponent,
  TooltipComponent,
} from 'echarts/components'
import * as echarts from 'echarts/core'
import { CanvasRenderer } from 'echarts/renderers'

// One line per capability. To support another chart type or component, add it
// here; nothing else in the package changes.
echarts.use([
  BarChart,
  LineChart,
  PieChart,
  ScatterChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  TitleComponent,
  DataZoomComponent,
  DatasetComponent,
  CanvasRenderer,
])

/**
 * Minimal shape the renderer depends on.
 *
 * @typedef {object} ChartEngine
 * @property {(element: Element, option: object) => { setOption: (option: object) => void, resize: () => void, dispose: () => void }} createChart
 */

/** @type {ChartEngine} */
export const engine = {
  createChart(element, option) {
    const chart = echarts.init(/** @type {HTMLElement} */ (element), null, { renderer: 'canvas' })
    chart.setOption(option)
    return chart
  },
}
