/**
 * Data table renderer.
 *
 * This is the proof that the architecture's central claim holds: a second
 * renderer was added by writing one file in this directory and one line in
 * `index.js`. Nothing in `kit.js`, `dom-seam.js`, `code-block-surface.js` or
 * `contract.js` changed, and no new test fixture or DOM hook was needed.
 *
 * It claims three shapes, in this order of preference:
 *   1. a `csv` / `tsv` fence, parsed with a real RFC 4180 reader;
 *   2. a `json` fence that is an array of flat objects;
 *   3. a `markdown` fence that starts with a GitHub-style pipe table, since
 *      that is how people paste a table back out of a document.
 *
 * No dependency: the table is built from DOM calls, and the preview is a
 * plain table inside our own view root — nothing is sandboxed because nothing
 * here interprets markup.
 *
 * @module renderers/table
 */

/** Rows past this are truncated with a visible note rather than silently cut. */
const MAX_ROWS = 500

/** Column ceilings, so one pathological cell cannot blow out the layout. */
const MAX_COLUMNS = 40
const MAX_CELL_CHARS = 400

/**
 * RFC 4180 CSV/TSV reader: quoted fields, escaped quotes, embedded newlines,
 * and CRLF tolerance.
 *
 * @param {string} text
 * @param {string} delimiter
 * @returns {string[][]}
 */
export function parseDelimited(text, delimiter) {
  /** @type {string[][]} */
  const rows = []
  /** @type {string[]} */
  let row = []
  let field = ''
  let quoted = false
  let index = 0

  const endField = () => {
    row.push(field)
    field = ''
  }
  const endRow = () => {
    endField()
    rows.push(row)
    row = []
  }

  while (index < text.length) {
    const char = text[index]
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"'
          index += 2
          continue
        }
        quoted = false
        index += 1
        continue
      }
      field += char
      index += 1
      continue
    }
    if (char === '"' && field === '') {
      quoted = true
      index += 1
      continue
    }
    if (char === delimiter) {
      endField()
      index += 1
      continue
    }
    if (char === '\r' && text[index + 1] === '\n') {
      endRow()
      index += 2
      continue
    }
    if (char === '\n') {
      endRow()
      index += 1
      continue
    }
    field += char
    index += 1
  }
  if (field !== '' || row.length > 0) endRow()

  return rows.filter((entry) => entry.length > 1 || entry[0] !== '')
}

/**
 * @param {string} text
 * @returns {{ header: string[], rows: string[][] } | null}
 */
function fromDelimited(text) {
  const delimiter = text.includes('\t') && !text.includes(',') ? '\t' : ','
  const rows = parseDelimited(text, delimiter)
  const header = rows.shift()
  if (header === undefined || rows.length === 0) return null
  return { header, rows }
}

/**
 * @param {string} text
 * @returns {{ header: string[], rows: string[][] } | null}
 */
function fromJson(text) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null
  if (!parsed.every((entry) => entry !== null && typeof entry === 'object' && !Array.isArray(entry))) return null
  const header = []
  for (const entry of parsed) {
    for (const key of Object.keys(entry)) if (!header.includes(key)) header.push(key)
  }
  const rows = parsed.map((entry) => header.map((key) => stringify(entry[key])))
  return { header, rows }
}

/** @param {unknown} value */
function stringify(value) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return String(value)
  }
}

/**
 * Split one pipe-table line into cells, honouring GFM's `\|` escape.
 *
 * A naive `split('|')` turns `| x\|y | 2 |` into three cells, so the row no
 * longer matches the header's arity and the whole table is rejected. GitHub
 * renders `\|` as a literal pipe, and so does this.
 *
 * @param {string} line
 * @returns {string[]}
 */
function splitRow(line) {
  let body = line.startsWith('|') ? line.slice(1) : line
  // Only an UNESCAPED trailing pipe is the closing delimiter; `x\|` ends with a
  // pipe that belongs to the cell.
  if (body.endsWith('|') && !body.endsWith('\\|')) body = body.slice(0, -1)

  const cells = []
  let cell = ''
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index]
    if (char === '\\' && body[index + 1] === '|') {
      cell += '|'
      index += 1
      continue
    }
    if (char === '|') {
      cells.push(cell)
      cell = ''
      continue
    }
    cell += char
  }
  cells.push(cell)
  return cells.map((value) => value.trim())
}

/**
 * Read a GitHub pipe table, but ONLY if the fence is nothing but that table.
 *
 * The strictness is the whole point. A looser reader takes the first line as a
 * header, the second as the separator, and treats *everything after it* as data
 * — so a document that opens with a table and then continues ("## Notes", a
 * second table, a paragraph) renders as invented rows, and the user cannot
 * tell which cells they invented. Silent wrong data is worse than no preview,
 * so anything that is not a table row ends the claim and the block stays the
 * native code block the model wrote.
 *
 * @param {string} text
 * @returns {{ header: string[], rows: string[][] } | null}
 */
function fromPipeTable(text) {
  const lines = text.split('\n').map((line) => line.trim()).filter((line) => line !== '')
  if (lines.length < 2) return null
  // A table row is a line that both starts and ends with a pipe. Escaped pipes
  // (`\|`) are cell content, not delimiters, and must not count here.
  // The second pattern rejects a row of empty cells — a layout artefact, not
  // data. It deliberately excludes `-`, or the `| --- | --- |` separator would
  // match it and every real table would be rejected.
  const isRow = (line) => /^\|.*\|$/.test(line) && !/^\|[\s|]*\|$/.test(line)
  const header = splitRow(lines[0])
  if (!isRow(lines[0]) || !isRow(lines[1])) return null
  if (!/^:?-{2,}:?$/.test(splitRow(lines[1])[0] ?? '')) return null

  const rows = []
  for (const line of lines.slice(2)) {
    // A second header+separator pair means this fence holds more than one
    // table. Rendering only the first would silently drop the rest, so the
    // whole block is left alone.
    if (isRow(line) && /^:?-{2,}:?$/.test(splitRow(line)[0] ?? '')) return null
    if (!isRow(line)) return null
    rows.push(splitRow(line))
  }
  // Every row must have the header's arity, or the table was not a table.
  if (rows.some((row) => row.length !== header.length)) return null
  return { header, rows }
}

/**
 * Sniff the table, without committing to it. Kept separate from `match` so a
 * renderer can answer "do I recognise this?" cheaply and "is it worth
 * showing?" more carefully.
 *
 * @param {string} lang
 * @param {string} source
 * @returns {{ header: string[], rows: string[][] } | null}
 */
export function readTable(lang, source) {
  if (lang === 'csv') return fromDelimited(source)
  if (lang === 'json') return fromJson(source)
  if (lang === 'markdown' || lang === '') return fromPipeTable(source)
  return null
}

/**
 * @param {(key: string, fallback: string) => string} t
 * @returns {import('../contract.js').Renderer}
 */
export function createTableRenderer(t) {
  return {
    id: 'table',
    label: 'Table',
    priority: 5,

    match(request) {
      // `json` is tried first and unconditionally, even for a fence DSH did
      // not label: an array of flat objects is a table whether the banner said
      // "json", said nothing, or said "代码块". A JSON *object* — which is what
      // an ECharts option is — is not a table, so this cannot collide with the
      // chart renderer.
      if (readTable('json', request.source) !== null) return true
      if (request.lang === 'csv' || request.lang === 'markdown' || request.lang === '') {
        return readTable(request.lang, request.source) !== null
      }
      return false
    },

    create(host) {
      const { request, limits, document: doc, mount } = host
      const table = readTable(request.lang, request.source)
      if (table === null) return null

      const columns = table.header.slice(0, MAX_COLUMNS)
      const rows = table.rows.slice(0, MAX_ROWS)
      const hiddenColumns = table.header.length - columns.length
      const hiddenRows = table.rows.length - rows.length

      /**
       * Whether the height cap is currently lifted.
       *
       * Own state rather than something read back off the DOM: `enter()` clears
       * the view root on every view switch, so a flag living only in the
       * markup would be lost the moment the user toggled to code and back.
       */
      let expanded = false

      /**
       * Told when the cap is lifted or dropped.
       *
       * A table is only ever toggled by its own button, so nothing else drives
       * this today — but the surface renders `aria-pressed` from `isOn()` and
       * the HTML preview already needed this because a modal dialog closes
       * itself. Publishing the same hook keeps the two renderers interchangeable
       * and means a future way out of this control does not silently strand the
       * button again.
       *
       * @type {Set<() => void>}
       */
      const expandListeners = new Set()

      const notifyExpand = () => {
        for (const listener of [...expandListeners]) {
          try {
            listener()
          } catch {
            /* a listener that throws must not strand the table */
          }
        }
      }

      /**
       * This instance's own wrap, so `expand` restyles the right one.
       *
       * A `document.querySelector` here would find whichever table came first
       * in the document — including another conversation block's — so pressing
       * expand in one block could restyle a different block's table.
       */
      /** @type {HTMLElement | null} */
      let wrap = null

      /** Apply or lift the cap on our wrap. */
      const applyCap = () => {
        if (wrap === null) return
        // Inline rather than a stylesheet rule, because the cap is user
        // configuration: a constant in CSS is a second copy of the default, and
        // a second copy is how the previous `max-height: inherit` ended up
        // silently inert.
        if (expanded) wrap.style.maxHeight = ''
        else wrap.style.maxHeight = `${limits.maxTableHeight}px`
      }

      return {
        views: [{ id: 'table', label: t('view.table', 'Table') }],

        expand: {
          toggle() {
            expanded = !expanded
            // The wrap is cleared on every `enter`, so a toggle pressed while
            // the code view is showing has nothing to restyle; the next
            // `enter` reads the new state.
            applyCap()
            notifyExpand()
          },
          isOn: () => expanded,
          subscribe: (listener) => {
            expandListeners.add(listener)
            return () => expandListeners.delete(listener)
          },
        },

        enter(viewId) {
          if (viewId === 'code') {
            wrap = null
            return
          }

          const root = doc.createElement('div')
          root.className = 'dvk-table-wrap'
          wrap = root
          // Before the children exist, so the first paint is already capped
          // and a long table never reflows from 13,000px down to the cap.
          applyCap()

          const summary = doc.createElement('p')
          summary.className = 'dvk-table-summary'
          summary.textContent = t('table.summary', '{rows} rows × {columns} columns')
            .replace('{rows}', String(rows.length))
            .replace('{columns}', String(columns.length))
          root.appendChild(summary)

          const element = doc.createElement('table')
          element.className = 'dvk-table'

          const thead = doc.createElement('thead')
          const headRow = doc.createElement('tr')
          for (const name of columns) {
            const th = doc.createElement('th')
            th.textContent = name.slice(0, MAX_CELL_CHARS)
            headRow.appendChild(th)
          }
          thead.appendChild(headRow)
          element.appendChild(thead)

          const tbody = doc.createElement('tbody')
          for (const row of rows) {
            const tr = doc.createElement('tr')
            for (let index = 0; index < columns.length; index += 1) {
              const td = doc.createElement('td')
              const value = row[index] ?? ''
              td.textContent = value.length > MAX_CELL_CHARS ? `${value.slice(0, MAX_CELL_CHARS)}…` : value
              tr.appendChild(td)
            }
            tbody.appendChild(tr)
          }
          element.appendChild(tbody)
          root.appendChild(element)

          if (hiddenRows > 0 || hiddenColumns > 0) {
            const note = doc.createElement('p')
            note.className = 'dvk-table-summary'
            note.textContent = t('table.truncated', 'Showing the first {rows} rows and {columns} columns')
              .replace('{rows}', String(rows.length))
              .replace('{columns}', String(columns.length))
            root.appendChild(note)
          }

          mount(root)
        },

        dispose() {
          wrap = null
          expandListeners.clear()
        },
      }
    },
  }
}
