/**
 * A DOM shim sized to what the seam actually touches.
 *
 * This is not a browser and does not try to be one. It implements exactly the
 * surface `dom-seam.js` and `code-block-surface.js` use — element creation,
 * attributes, a real (small) CSS selector engine, `MutationObserver`, and
 * `sessionStorage` — so the seam can be exercised under plain Node against
 * fixtures copied from DSH's shipped markup.
 *
 * The selector engine supports tag, `.class`, `[attr]`, `[attr="value"]`,
 * `:first-child`, the descendant and child combinators, and selector lists.
 * That is the whole grammar the kit's selectors use.
 *
 * @module tests/dom-shim
 */

const VOID_TAGS = new Set(['meta', 'br', 'hr', 'img', 'input', 'link', 'source'])

/** @param {string} name */
function escapeAttrName(name) {
  return name.toLowerCase()
}

class ShimText {
  /**
   * @param {string} data
   */
  constructor(data) {
    this.nodeType = 3
    this.data = data
    this.parentNode = null
  }

  get textContent() {
    return this.data
  }
}

class ShimElement {
  /**
   * @param {string} tagName
   * @param {Document} ownerDocument
   */
  constructor(tagName, ownerDocument) {
    this.nodeType = 1
    this.tagName = tagName.toUpperCase()
    this.ownerDocument = ownerDocument
    this.parentNode = null
    /** @type {ShimText | ShimElement[]} */
    this.childNodes = []
    /** @type {Map<string, string>} */
    this.attrs = new Map()
    this.style = {}
    /** @type {Map<string, Array<(event: { type: string }) => void>>} */
    this.listeners = new Map()
    // Layout numbers a real browser computes, taken from the document's default
    // so a test can describe the layout BEFORE the plugin mounts and asks.
    // Zero is the honest default for a shim with no layout engine, and the
    // plugin reads 0/0 as "nobody measured this" rather than as "it fits" — see
    // `available()` in renderers/table.js.
    this.scrollHeight = ownerDocument?.layout?.scrollHeight ?? 0
    this.clientHeight = ownerDocument?.layout?.clientHeight ?? 0
  }

  // --- attributes ---------------------------------------------------------
  setAttribute(name, value) {
    this.attrs.set(escapeAttrName(name), String(value))
  }

  getAttribute(name) {
    const value = this.attrs.get(escapeAttrName(name))
    return value === undefined ? null : value
  }

  hasAttribute(name) {
    return this.attrs.has(escapeAttrName(name))
  }

  removeAttribute(name) {
    this.attrs.delete(escapeAttrName(name))
  }

  get className() {
    return this.getAttribute('class') ?? ''
  }

  set className(value) {
    this.setAttribute('class', value)
  }

  get classList() {
    const self = this
    return {
      contains: (name) => self.className.split(/\s+/).includes(name),
      add: (name) => {
        const parts = self.className.split(/\s+/).filter((p) => p !== '')
        if (!parts.includes(name)) parts.push(name)
        self.className = parts.join(' ')
      },
    }
  }

  // --- tree ----------------------------------------------------------------
  get children() {
    return /** @type {ShimElement[]} */ (this.childNodes.filter((node) => node.nodeType === 1))
  }

  get firstElementChild() {
    return this.children[0] ?? null
  }

  get lastElementChild() {
    const kids = this.children
    return kids[kids.length - 1] ?? null
  }

  get isConnected() {
    let node = this
    while (node.parentNode !== null) node = node.parentNode
    return node === this.ownerDocument.documentElement || node === this.ownerDocument
  }

  /**
   * @param {ShimText | ShimElement} node
   * @returns {ShimText | ShimElement}
   */
  appendChild(node) {
    if (node.parentNode !== null) node.parentNode.removeChild(node)
    node.parentNode = this
    this.childNodes.push(node)
    this.ownerDocument?.record({ type: 'childList', target: this, addedNodes: [node], removedNodes: [] })
    return node
  }

  /**
   * @param {ShimText | ShimElement} node
   * @returns {ShimText | ShimElement}
   */
  removeChild(node) {
    const index = this.childNodes.indexOf(node)
    if (index < 0) return node
    this.childNodes.splice(index, 1)
    node.parentNode = null
    this.ownerDocument?.record({ type: 'childList', target: this, addedNodes: [], removedNodes: [node] })
    return node
  }

  remove() {
    this.parentNode?.removeChild(this)
  }

  replaceChildren(...nodes) {
    for (const child of [...this.childNodes]) this.removeChild(child)
    for (const node of nodes) this.appendChild(node)
  }

  get textContent() {
    if (this.nodeType === 3) return /** @type {ShimText} */ (this).data
    return this.childNodes.map((child) => child.textContent).join('')
  }

  set textContent(value) {
    this.replaceChildren(new ShimText(String(value)))
  }

  // --- selectors -----------------------------------------------------------
  matches(selector) {
    return parseSelectorList(selector).some((complex) => matchComplex(this, complex))
  }

  closest(selector) {
    let node = this
    while (node !== null && node.nodeType === 1) {
      if (node.matches(selector)) return node
      node = node.parentNode
    }
    return null
  }

  /**
   * @param {string} selector
   * @returns {ShimElement[]}
   */
  querySelectorAll(selector) {
    const out = []
    const walk = (node) => {
      for (const child of node.children) {
        if (child.matches(selector)) out.push(child)
        walk(child)
      }
    }
    walk(this)
    return out
  }

  /**
   * @param {string} selector
   * @returns {ShimElement | null}
   */
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null
  }

  // --- events --------------------------------------------------------------
  addEventListener(type, handler) {
    const list = this.listeners.get(type) ?? []
    list.push(handler)
    this.listeners.set(type, list)
  }

  /**
   * @param {string} type
   */
  dispatch(type) {
    for (const handler of this.listeners.get(type) ?? []) handler({ type })
  }
}

// ---------------------------------------------------------------------------
// selector engine
// ---------------------------------------------------------------------------

/** @typedef {{ tag: string | null, classes: string[], attrs: Array<[string, string | null]>, firstChild: boolean }} Compound */

const COMPOUND_RE = /^(\*|[a-zA-Z][\w-]*)?((?:[.#][\w-]+|\[[^\]]+\]|:first-child)*)$/

/**
 * @param {string} selector
 * @returns {Compound[]}
 */
function parseCompound(text) {
  const match = COMPOUND_RE.exec(text)
  if (match === null) throw new Error(`dom-shim: unsupported selector fragment "${text}"`)
  const classes = []
  const attrs = []
  let firstChild = false
  const rest = match[2] ?? ''
  const tokenRe = /[.#][\w-]+|\[[^\]]+\]|:first-child/g
  let token
  while ((token = tokenRe.exec(rest)) !== null) {
    // `token` is an exec array; the text is always its element 0.
    const text = token[0]
    if (text.startsWith('.')) classes.push(text.slice(1))
    else if (text.startsWith('#')) throw new Error('dom-shim: #id selectors are not supported')
    else if (text.startsWith(':')) firstChild = true
    else {
      const inner = text.slice(1, -1)
      const eq = inner.indexOf('=')
      if (eq < 0) attrs.push([inner.toLowerCase(), null])
      else {
        const name = inner.slice(0, eq).trim().toLowerCase()
        attrs.push([name, inner.slice(eq + 1).trim().replace(/^["']|["']$/g, '')])
      }
    }
  }
  return [{ tag: match[1] === undefined || match[1] === '*' ? null : match[1].toUpperCase(), classes, attrs, firstChild }]
}

/**
 * @param {string} selector
 * @returns {Compound[][]}
 */
function parseSelectorList(selector) {
  return selector.split(',').map((part) => parseComplex(part.trim()))
}

/**
 * @param {string} text
 * @returns {Compound[]}
 */
function parseComplex(text) {
  /** @type {Compound[]} */
  const compounds = []
  /** @type {string[]} */
  const combinators = []
  let buffer = ''
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (ch === '>') {
      if (buffer !== '') {
        compounds.push(...parseCompound(buffer))
        buffer = ''
      }
      combinators.push('>')
      i += 1
      continue
    }
    if (ch === ' ') {
      if (buffer !== '') {
        compounds.push(...parseCompound(buffer))
        buffer = ''
        combinators.push(' ')
      }
      i += 1
      continue
    }
    if (ch === '[') {
      const end = text.indexOf(']', i)
      buffer += text.slice(i, end + 1)
      i = end + 1
      continue
    }
    buffer += ch
    i += 1
  }
  if (buffer !== '') compounds.push(...parseCompound(buffer))
  compounds.combinators = combinators
  return compounds
}

/**
 * @param {ShimElement} element
 * @param {Compound} compound
 * @returns {boolean}
 */
function matchCompound(element, compound) {
  if (compound.tag !== null && element.tagName !== compound.tag) return false
  for (const cls of compound.classes) if (!element.classList.contains(cls)) return false
  for (const [name, value] of compound.attrs) {
    if (!element.hasAttribute(name)) return false
    if (value !== null && element.getAttribute(name) !== value) return false
  }
  if (compound.firstChild) {
    const parent = element.parentNode
    if (parent === null || parent.nodeType !== 1) return false
    if (parent.children[0] !== element) return false
  }
  return true
}

/**
 * Right-to-left matching, which is how the browser does it.
 *
 * A descendant step walks the ancestor chain; a child step takes exactly one
 * hop. `combinators` has one entry per gap between compounds, so it is
 * indexed in step with the compounds.
 *
 * @param {ShimElement} element
 * @param {Compound[]} complex
 * @returns {boolean}
 */
function matchComplex(element, complex) {
  /** @type {any} */
  const combinators = complex.combinators ?? []
  if (complex.length === 0) return false
  if (!matchCompound(element, complex[complex.length - 1])) return false

  let combinatorIndex = combinators.length - 1
  for (let index = complex.length - 2; index >= 0; index -= 1) {
    if (combinators[combinatorIndex] === '>') {
      const parent = element.parentNode
      if (parent === null || parent.nodeType !== 1) return false
      if (!matchCompound(parent, complex[index])) return false
      element = parent
    } else {
      let ancestor = element.parentNode
      let found = null
      while (ancestor !== null && ancestor.nodeType === 1) {
        if (matchCompound(ancestor, complex[index])) {
          found = ancestor
          break
        }
        ancestor = ancestor.parentNode
      }
      if (found === null) return false
      element = found
    }
    combinatorIndex -= 1
  }
  return true
}

// ---------------------------------------------------------------------------
// document
// ---------------------------------------------------------------------------

/**
 * The minimal window a document exposes as `defaultView`.
 *
 * Only `postMessage` plumbing exists, because that is the one browser facility
 * the plugin reaches for through the DOM rather than through a global: the HTML
 * preview's measuring frame reports its height with `parent.postMessage`, and
 * the renderer subscribes via `document.defaultView`. A shim that omitted it
 * would make that whole path untestable outside a browser.
 */
class ShimWindow {
  /** @param {ShimDocument} document */
  constructor(document) {
    this.document = document
    /** @type {Map<string, Set<(event: object) => void>>} */
    this.listeners = new Map()
    // The enlarged preview sizes its cap as a share of the viewport. Without a
    // number here every such test would take the renderer's fallback branch and
    // pass without exercising the thing it claims to check.
    this.innerHeight = 900
    this.innerWidth = 1440
  }

  /** @param {string} type @param {(event: object) => void} listener */
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type)?.add(listener)
  }

  /** @param {string} type @param {(event: object) => void} listener */
  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener)
  }

  /**
   * Deliver a message the way a frame's `parent.postMessage` would.
   *
   * @param {{ source?: unknown, origin?: string, data?: unknown }} event
   */
  postMessage(event) {
    for (const listener of [...(this.listeners.get('message') ?? [])]) {
      listener({ origin: 'null', ...event })
    }
  }

  /** How many listeners are attached, so a test can prove cleanup. */
  listenerCount(type = 'message') {
    return this.listeners.get(type)?.size ?? 0
  }
}

/**
 * Give a `<dialog>` the three members the plugin uses.
 *
 * `showModal` is what puts the element in the browser's top layer, which is the
 * reason the enlarged preview is a dialog rather than a `position: fixed`
 * overlay — a fixed element is positioned against its nearest ancestor that
 * creates a containing block. The shim records the open state so a test can
 * assert that closing really released it, which is the part a plain DOM shim
 * would otherwise let pass silently.
 *
 * @param {ShimElement} element
 * @param {ShimDocument} doc
 */
function attachDialog(element, doc) {
  element.open = false
  element.showModal = function showModal() {
    if (element.open === true) return
    element.open = true
    // A real modal dialog makes the rest of the document inert. Recording it
    // lets a test notice if the plugin ever tried to keep the page interactive
    // behind its own dialog, which it must not.
    doc.openDialogs = (doc.openDialogs ?? 0) + 1
  }
  element.close = function close() {
    if (element.open !== true) return
    element.open = false
    doc.openDialogs = Math.max(0, (doc.openDialogs ?? 1) - 1)
    // A real <dialog> fires `close` when it closes itself, and that event is
    // exactly how ESC and a backdrop click reach a listener. A shim that only
    // flipped the flag would leave the plugin's cleanup path untested while the
    // suite still looked like it covered the case.
    element.dispatch('close')
  }
}

class ShimDocument {
  constructor() {
    // Set before any element exists, because every element reads it.
    // `mount()` overwrites it to describe a layout the plugin can react to.
    this.layout = { scrollHeight: 0, clientHeight: 0 }
    // Initialised before any child is attached: `appendChild` records, and the
    // constructor itself appends.
    /** @type {Array<{ target: ShimElement, observer: ShimMutationObserver }>} */
    this.observations = []
    /** @type {object[]} */
    this.pending = []
    this.documentElement = new ShimElement('html', this)
    this.head = new ShimElement('head', this)
    this.body = new ShimElement('body', this)
    this.documentElement.appendChild(this.head)
    this.documentElement.appendChild(this.body)
    // A real document has one, and the HTML renderer takes its message listener
    // from here rather than from `globalThis` so it does not depend on a browser
    // global. Without it the measuring path cannot be exercised in Node at all.
    this.defaultView = new ShimWindow(this)
  }

  createElement(tagName) {
    const element = new ShimElement(tagName, this)
    const tag = String(tagName).toLowerCase()
    // A real iframe has a browsing context, and the HTML renderer identifies the
    // sender of a measurement by comparing `event.source` against it. Without
    // one here, the postMessage path could not be driven in Node at all.
    if (tag === 'iframe') element.contentWindow = { frame: element }
    if (tag === 'dialog') attachDialog(element, this)
    return element
  }

  createTextNode(data) {
    return new ShimText(data)
  }

  /**
   * Same element type, plus the namespace the caller asked for.
   *
   * The enlarge control draws DSH's own SVG glyph, and `createElementNS` is the
   * only way to build one — `createElement('svg')` yields an HTML element that
   * no browser renders as a graphic. The shim does not model namespaces, so
   * recording the argument is enough to assert the plugin asked for the SVG one
   * rather than silently getting an inert element.
   *
   * @param {string | null} namespace
   * @param {string} qualifiedName
   */
  createElementNS(namespace, qualifiedName) {
    const element = new ShimElement(qualifiedName, this)
    element.namespaceURI = namespace
    return element
  }

  /**
   * @param {{ target: ShimElement, addedNodes: ShimElement[], removedNodes: ShimElement[], type: string }} record
   */
  record(record) {
    if (this.observations.length === 0) return
    this.pending.push(record)
    queueMicrotask(() => this.flush())
  }

  flush() {
    const records = this.pending
    this.pending = []
    if (records.length === 0) return
    for (const observer of [...this.observations]) {
      const relevant = records.filter(
        (record) => record.target === observer.target || isDescendant(record.target, observer.target),
      )
      if (relevant.length > 0) observer.callback(relevant, observer)
    }
  }

  /**
   * @param {string} selector
   * @returns {ShimElement[]}
   */
  querySelectorAll(selector) {
    return this.documentElement.querySelectorAll(selector)
  }

  /**
   * @param {string} selector
   * @returns {ShimElement | null}
   */
  querySelector(selector) {
    return this.documentElement.querySelector(selector)
  }
}

/**
 * @param {ShimElement} node
 * @param {ShimElement} ancestor
 * @returns {boolean}
 */
function isDescendant(node, ancestor) {
  let current = node
  while (current !== null) {
    if (current === ancestor) return true
    current = current.parentNode
  }
  return false
}

class ShimMutationObserver {
  /** @param {(records: object[], observer: ShimMutationObserver) => void} callback */
  constructor(callback) {
    this.callback = callback
  }

  observe(target, options) {
    this.target = target
    this.options = options
    this.target.ownerDocument.observations.push(this)
  }
  disconnect() {
    const doc = this.target?.ownerDocument
    if (doc === undefined) return
    doc.observations = doc.observations.filter((entry) => entry.observer !== this)
  }
}

// ---------------------------------------------------------------------------
// fixture parsing
// ---------------------------------------------------------------------------

/**
 * Parse a small, well-formed HTML fixture into the shim tree.
 *
 * Only what a fixture needs: tags, attributes, self-closing tags, void tags,
 * text, and comments. It is not a spec-compliant parser and does not need to
 * be — its job is to turn a copy-pasted DSH fragment into a tree the seam can
 * interrogate.
 *
 * @param {string} html
 * @param {ShimElement | ShimDocument} host element or document to parse into
 * @returns {ShimElement}
 */
export function parseHtml(html, host) {
  const doc = /** @type {ShimDocument} */ (host.ownerDocument ?? host)
  const root = doc.createElement('div')
  const stack = [root]
  const tagRe = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][\w-]*)((?:\s+[\w:-]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>|([^<]+)/g
  let match
  while ((match = tagRe.exec(html)) !== null) {
    const [full, closing, tagName, rawAttrs, selfClosing, text] = match
    if (full.startsWith('<!--')) continue
    if (text !== undefined) {
      const value = decodeEntities(text)
      if (value.trim() !== '') stack[stack.length - 1].appendChild(doc.createTextNode(value))
      continue
    }
    if (closing === '/') {
      if (stack.length > 1) stack.pop()
      continue
    }
    const element = doc.createElement(tagName)
    const attrRe = /([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g
    let attr
    while ((attr = attrRe.exec(rawAttrs ?? '')) !== null) {
      const value = attr[2] ?? attr[3] ?? attr[4] ?? ''
      element.setAttribute(attr[1], decodeEntities(value))
    }
    stack[stack.length - 1].appendChild(element)
    if (selfClosing !== '/' && !VOID_TAGS.has(tagName.toLowerCase())) stack.push(element)
  }
  // Graft the parsed top level onto the host so the fixture lives in the same
  // tree the seam observes.
  for (const child of [...root.childNodes]) host.appendChild(child)
  return root
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: '\u00a0' }

/** @param {string} text */
function decodeEntities(text) {
  return text.replace(/&(#?\w+);/g, (whole, name) => ENTITIES[name] ?? whole)
}

// ---------------------------------------------------------------------------
// storage
// ---------------------------------------------------------------------------

/** A `Storage`-shaped object backed by a Map. */
export class ShimStorage {
  constructor() {
    /** @type {Map<string, string>} */
    this.map = new Map()
  }

  getItem(key) {
    return this.map.has(key) ? this.map.get(key) : null
  }

  setItem(key, value) {
    this.map.set(key, String(value))
  }

  removeItem(key) {
    this.map.delete(key)
  }

  clear() {
    this.map.clear()
  }
}

/**
 * Build a complete shimmed browser environment.
 *
 * @returns {{ document: ShimDocument, window: object, sessionStorage: ShimStorage, flush: () => void }}
 */
export function createEnvironment() {
  const document = new ShimDocument()
  const sessionStorage = new ShimStorage()
  const window = { __ModuleLoader__: { load: (descriptor) => { window.__loaded = descriptor } } }
  return {
    document,
    window,
    sessionStorage,
    MutationObserver: ShimMutationObserver,
    flush: () => document.flush(),
  }
}

export { ShimDocument, ShimElement, ShimMutationObserver, ShimText, ShimWindow }
