/**
 * Copy for the kit.
 *
 * Registers with DSH's locale service when the host has one, and otherwise
 * falls back to a dictionary chosen from the document language. The kit must
 * keep working on a host that predates the locale service, so nothing here
 * throws.
 *
 * @module locale
 */

const NAMESPACE = 'dsh-viewer-kit'

/**
 * Copy for the kit, keyed by language.
 *
 * Exported so a test can ask it directly. A missing key does not fail loudly at
 * runtime — `t` falls back to the English literal — so "the button says
 * 'Enlarge' inside a Chinese interface" is only catchable by comparing the two
 * dictionaries, which is what that test does.
 *
 * @type {Record<string, Record<string, string>>}
 */
export const DICTIONARIES = {
  en: {
    'switch.label': 'Content view',
    'view.code': 'Code',
    'view.preview': 'Preview',
    'view.table': 'Table',
    'view.chart': 'Chart',
    'html.frameTitle': 'HTML preview',
    'expand.label': 'Enlarge',
    'html.modalTitle': 'HTML preview',
    'html.modalClose': 'Close',
    'table.summary': '{rows} rows × {columns} columns',
    'table.truncated': 'Showing the first {rows} rows and {columns} columns',
    'chart.loading': 'Loading the chart engine…',
    'chart.invalid': 'Cannot draw this chart: {reason}',
    'chart.loadFailed': 'The chart engine could not be loaded: {reason}',
    'chart.renderFailed': 'ECharts rejected this option: {reason}',
  },
  zh: {
    'switch.label': '内容视图',
    'view.code': '代码',
    'view.preview': '预览',
    'view.table': '表格',
    'view.chart': '图表',
    'html.frameTitle': 'HTML 预览',
    'expand.label': '放大',
    'html.modalTitle': 'HTML 预览',
    'html.modalClose': '关闭',
    'table.summary': '{rows} 行 × {columns} 列',
    'table.truncated': '仅显示前 {rows} 行、前 {columns} 列',
    'chart.loading': '正在加载图表引擎…',
    'chart.invalid': '无法绘制这张图：{reason}',
    'chart.loadFailed': '图表引擎加载失败：{reason}',
    'chart.renderFailed': 'ECharts 拒绝了这个配置：{reason}',
  },
}

/**
 * Build the translator, and hand back its own disposer.
 *
 * The dictionary registration is owned HERE rather than parked on `ctx.effect`.
 * Two reasons, both learned the hard way:
 *
 *   - `ctx.effect`'s disposer belongs to the fiber, so a re-activation that
 *     retires the previous instance (HMR, re-enable) would leave the
 *     registration behind, and the next `register` would throw
 *     "namespace … already has locale …" — which fails the whole entry and
 *     takes the boot audit, and therefore DSH, down with it.
 *   - ownership is clearer: what this function registers, it unregisters.
 *
 * @param {{ get: (name: string) => unknown }} ctx
 * @returns {{ t: (key: string, fallback: string) => string, dispose: () => void }}
 */
export function createTranslator(ctx) {
  /**
   * `locale.bind(ns)` returns the translate FUNCTION itself, not an object
   * carrying one — `const t = locale.bind(NS); t('key')`. Calling
   * `bound.t(key)` threw inside the seam, where the per-block try/catch turned
   * it into a silent "no renderer claimed this".
   *
   * @type {((key: string) => string) | null}
   */
  let bound = null
  /** @type {(() => void) | null} */
  let unregister = null
  /** @type {any} */
  const locale = ctx.get('locale')

  if (locale != null && typeof locale.register === 'function' && typeof locale.bind === 'function') {
    try {
      unregister = locale.register(NAMESPACE, DICTIONARIES)
    } catch {
      // Something in this page already registered these dictionaries — another
      // activation that has not been retired, or a host that keeps them. The
      // content is identical, so binding still resolves our copy; throwing
      // here would fail the entry for no reason.
    }
    const translate = locale.bind(NAMESPACE)
    if (typeof translate === 'function') bound = translate
  }

  /**
   * @param {string} lang
   * @returns {Record<string, string>}
   */
  function dictionaryFor(lang) {
    const primary = String(lang ?? '').toLowerCase().split(/[-_]/)[0]
    return DICTIONARIES[primary] ?? DICTIONARIES.en
  }

  return {
    t(key, fallback) {
      if (bound !== null) {
        const value = bound(key)
        if (typeof value === 'string' && value !== '' && value !== key) return value
      }
      const doc = globalThis.document
      const lang = doc?.documentElement?.lang ?? 'en'
      return dictionaryFor(lang)[key] ?? fallback
    },
    dispose() {
      try {
        unregister?.()
      } catch {
        /* the locale service may already be gone with its fiber */
      }
      unregister = null
      bound = null
    },
  }
}
