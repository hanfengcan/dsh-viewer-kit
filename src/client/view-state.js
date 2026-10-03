/**
 * Per-content view selection.
 *
 * Keyed by the content fingerprint rather than by DOM node: React rebuilds
 * these nodes freely, so an element-keyed store would lose the selection on
 * every re-render. Keyed by content, the selection survives scroll-back and
 * survives React, and a genuine content change starts a fresh default.
 *
 * Persistence is `sessionStorage` on purpose — a view choice is a UI
 * convenience, not data worth writing to disk, and it must not outlive a
 * renderer upgrade that may have dropped a view id.
 *
 * @module view-state
 */

const STORAGE_KEY = 'dsh-viewer-kit:views:v1'

/**
 * The real `sessionStorage` when it is usable, otherwise `null`.
 *
 * Availability is not the same as accessibility: private windows and embedded
 * webviews expose the object and still throw on write, so this probes it.
 *
 * @returns {Storage | null}
 */
function safeStorage() {
  try {
    const probe = '__dvk_probe__'
    globalThis.sessionStorage?.setItem(probe, '1')
    globalThis.sessionStorage?.removeItem(probe)
    return globalThis.sessionStorage ?? null
  } catch {
    return null
  }
}

/**
 * @param {{ storage?: Storage | null }} [options]
 * @returns {{
 *   get: (id: string) => string | undefined,
 *   set: (id: string, viewId: string) => void,
 *   clear: () => void,
 *   subscribe: (listener: () => void) => () => void,
 *   size: () => number,
 * }}
 */
export function createViewState(options = {}) {
  const storage = options.storage === undefined ? safeStorage() : options.storage
  /**
   * In-memory mirror, authoritative for reads. `sessionStorage` is only
   * touched on write and on first read: a conversation with dozens of
   * remembered blocks would otherwise re-parse the same JSON on every switch.
   *
   * @type {Map<string, string> | null}
   */
  let cache = null
  /** @type {Set<() => void>} */
  const listeners = new Set()

  /** @returns {Map<string, string>} */
  function all() {
    if (cache !== null) return cache
    /** @type {Map<string, string>} */
    const loaded = new Map()
    if (storage !== null) {
      try {
        const raw = storage.getItem(STORAGE_KEY)
        if (raw !== null) {
          const parsed = JSON.parse(raw)
          if (typeof parsed === 'object' && parsed !== null) {
            for (const [key, value] of Object.entries(parsed)) {
              if (typeof value === 'string') loaded.set(key, value)
            }
          }
        }
      } catch {
        // A corrupt or unreadable store starts empty rather than breaking the UI.
      }
    }
    cache = loaded
    return cache
  }

  function persist() {
    if (storage === null) return
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(all())))
    } catch {
      // A full or blocked store must never break rendering; the selection
      // simply stops surviving a reload.
    }
  }

  function emit() {
    for (const listener of listeners) listener()
  }

  return {
    get(id) {
      return all().get(id)
    },
    set(id, viewId) {
      if (all().get(id) === viewId) return
      all().set(id, viewId)
      persist()
      emit()
    },
    clear() {
      cache = new Map()
      if (storage !== null) {
        try {
          storage.removeItem(STORAGE_KEY)
        } catch {
          /* ignore */
        }
      }
      emit()
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    size() {
      return all().size
    },
  }
}
