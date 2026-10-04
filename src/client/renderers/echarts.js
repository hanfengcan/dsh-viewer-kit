/**
 * Chart renderer — an ECharts option object, nothing else.
 *
 * The whole point of this renderer is that the model writes **data**, not a
 * document:
 *
 *     ```echarts
 *     { "xAxis": { "type": "category", "data": ["Mon","Tue"] },
 *       "series": [{ "type": "bar", "data": [12, 32] }] }
 *     ```
 *
 * No HTML wrapper, no `<script src>`, no CDN. That is not a convenience: a
 * chart written as HTML would need `htmlAllowScripts`, which reopens the
 * question docs/01-architecture.md §8 answers. Rendered this way the engine is
 * bundled, trusted code running in the host page, and the model contributes a
 * JSON object that ECharts draws — it never executes anything.
 *
 * ## Where the 1.5 MB lives
 *
 * Not here. The engine is `chunks/echarts.js`, fetched on demand through the
 * DSH chunk route, so a user who never writes a chart never downloads it. See
 * `chunk-loader.js` for the four rules that contract imposes.
 *
 * ## Failure is content, not an exception
 *
 * A model will eventually write invalid JSON, or a valid object that is not an
 * ECharts option. Both are shown *as the preview* with the parser's own
 * message, because the alternative — a renderer that throws, or one that
 * silently declines and leaves the user staring at raw JSON with no switch —
 * is strictly worse. The code view is always one click away.
 *
 * @module renderers/echarts
 */

import { ECHARTS_CHUNK, loadChunk } from '../chunk-loader.js'

/** Fence languages this renderer claims. */
const LANGUAGES = new Set(['echarts', 'chart'])

/** Ceiling on option size, so one pathological block cannot stall the tab. */
const MAX_OPTION_CHARS = 512 * 1024

/**
 * Parse the fence body as JSON.
 *
 * JSON.parse is strict on purpose: accepting a relaxed form here would mean
 * ECharts receives a different value than the model wrote, and the resulting
 * chart would be wrong in a way nobody could debug.
 *
 * @param {string} source
 * @returns {{ option: object } | { error: string }}
 */
export function parseOption(source) {
  const text = source.trim()
  if (text === '') return { error: 'the block is empty' }
  if (text.length > MAX_OPTION_CHARS) {
    return { error: `the option is ${Math.round(text.length / 1024)} KB; the limit is ${MAX_OPTION_CHARS / 1024} KB` }
  }
  let value
  try {
    value = JSON.parse(text)
  } catch (error) {
    return { error: `not valid JSON — ${error instanceof Error ? error.message : String(error)}` }
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { error: 'expected a JSON object, got ' + (Array.isArray(value) ? 'an array' : typeof value) }
  }
  // ECharts refuses anything with no series, but its own error names nothing
  // useful, so the check happens here where the message can be specific.
  if (!Array.isArray(/** @type {any} */ (value).series) || /** @type {any} */ (value).series.length === 0) {
    return { error: 'no "series" array — an ECharts option needs at least one series' }
  }
  return { option: /** @type {object} */ (value) }
}

/**
 * Force a non-HTML tooltip and drop nothing else.
 *
 * ECharts' default tooltip renders `formatter` output as HTML, which would turn
 * a model-authored string into markup in the host page. `richText` draws the
 * same content onto the canvas as text. Only the tooltip is touched: the rest
 * of the option is the model's, and quietly pruning fields it did not
 * recognise would make the renderer lie about what it rendered.
 *
 * @param {object} option
 * @returns {object}
 */
function harden(option) {
  /** @type {any} */
  const copy = { ...option }
  if (copy.tooltip === undefined) return copy
  if (copy.tooltip === true || copy.tooltip === false) {
    copy.tooltip = copy.tooltip === true ? { renderMode: 'richText' } : copy.tooltip
    return copy
  }
  if (typeof copy.tooltip === 'object' && copy.tooltip !== null) {
    copy.tooltip = { ...copy.tooltip, renderMode: 'richText' }
  }
  return copy
}

/**
 * @param {(key: string, fallback: string) => string} t
 * @returns {import('../contract.js').Renderer}
 */
export function createEChartsRenderer(t) {
  return {
    id: 'echarts',
    label: 'Chart',
    // Above `table` (5) and below `html` (10). It matters now: both this
    // renderer and the table renderer claim content they recognise regardless
    // of the fence name, and only the two are mutually exclusive anyway — a
    // series array and an array of flat objects cannot both be true. Stated so
    // the tie-break is deliberate rather than accidental.
    priority: 8,

    match(request) {
      // Content is the authority, not the fence name. DSH's banner shows the
      // language only when it has a highlighter for it, so an `echarts` fence
      // arrives labelled with generic copy and the real name is not in the DOM
      // at all. A source that parses as an ECharts option is unambiguous.
      if (LANGUAGES.has(request.lang)) return true
      return !('error' in parseOption(request.source))
    },

    create(host) {
      const { request, document: doc, mount, config } = host
      const parsed = parseOption(request.source)
      // `resolveConfig` is the only producer of a resolved chart height and it
      // guarantees a usable one, so there is deliberately no fallback here: a
      // second copy of the default is a second thing to forget to update.
      const height = config().chartHeight

      // Survives every re-entry, so a toggle back to preview reuses the chart
      // rather than rebuilding it from a re-parsed option.
      /** @type {null | { setOption: (o: object) => void, resize: () => void, dispose: () => void }} */
      let chart = null
      /** @type {null | { disconnect: () => void }} */
      let observer = null
      /** @type {null | HTMLElement} */
      let root = null

      /** @param {string} message */
      function showProblem(message) {
        if (root === null) return
        root.replaceChildren()
        const note = doc.createElement('p')
        note.className = 'dvk-chart-note'
        note.textContent = message
        root.appendChild(note)
      }

      return {
        views: [{ id: 'chart', label: t('view.chart', 'Chart') }],

        async enter(viewId) {
          if (viewId === 'code') return
          // Switching to code and back re-enters with a fresh root; the old
          // chart's canvas and observer are released by `dispose`.
          if (root !== null) {
            root.remove()
            root = null
          }

          root = doc.createElement('div')
          root.className = 'dvk-chart'
          root.style.height = `${height}px`
          mount(root)

          if ('error' in parsed) {
            showProblem(t('chart.invalid', 'Cannot draw this chart: {reason}').replace('{reason}', parsed.error))
            return
          }

          // Placeholder for the fetch. Replaced by the canvas on success.
          const pending = doc.createElement('p')
          pending.className = 'dvk-chart-note'
          pending.textContent = t('chart.loading', 'Loading the chart engine…')
          root.appendChild(pending)

          let mod
          try {
            mod = await loadChunk(ECHARTS_CHUNK)
          } catch (error) {
            showProblem(
              t('chart.loadFailed', 'The chart engine could not be loaded: {reason}').replace(
                '{reason}',
                error instanceof Error ? error.message : String(error),
              ),
            )
            return
          }
          if (root === null) return // disposed while the chunk was in flight
          // The chunk is a CommonJS module whose named export is `engine`, so
          // `require.async` hands back `{ engine: { createChart } }`. Reading
          // `createChart` off the top level reported "unexpected chunk shape"
          // against a chunk that had in fact loaded and evaluated perfectly —
          // which is the most expensive kind of bug, because everything up to
          // it was working. Both shapes are accepted so a future export rename
          // degrades to a working chart instead of a blank box.
          const engine = mod?.engine ?? mod
          if (engine == null || typeof engine.createChart !== 'function') {
            showProblem(
              t('chart.loadFailed', 'The chart engine could not be loaded: {reason}').replace(
                '{reason}',
                `the chunk exported ${Object.keys(mod ?? {}).join(', ') || 'nothing'}`,
              ),
            )
            return
          }

          try {
            root.replaceChildren()
            chart = engine.createChart(root, harden(parsed.option))
          } catch (error) {
            chart = null
            showProblem(
              t('chart.renderFailed', 'ECharts rejected this option: {reason}').replace(
                '{reason}',
                error instanceof Error ? error.message : String(error),
              ),
            )
            return
          }

          // A chart sized from a hidden element comes out 0×0, and a block
          // scrolled into view changes its width. Both are real, so the
          // observer watches the element rather than being done once.
          const ResizeObserverCtor = /** @type {any} */ (globalThis).ResizeObserver
          if (typeof ResizeObserverCtor === 'function') {
            const active = new ResizeObserverCtor(() => {
              try {
                chart?.resize()
              } catch {
                /* disposed between the callback firing and running */
              }
            })
            observer = active
            active.observe(root)
          }
        },

        dispose() {
          observer?.disconnect()
          observer = null
          try {
            chart?.dispose()
          } catch {
            /* already gone */
          }
          chart = null
          root = null
        },
      }
    },
  }
}
