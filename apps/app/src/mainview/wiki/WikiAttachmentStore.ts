import type { UserFailure } from "@smthrs/rpc/UserFailure"
import type { FetchLike } from "@smthrs/rpc/NativeAgent"

export interface WikiAttachmentSnapshot {
  readonly url?: string
  readonly error?: UserFailure
}

export interface WikiAttachmentStore {
  readonly get: (path: string) => WikiAttachmentSnapshot | undefined
  readonly subscribe: (path: string, listener: () => void) => () => void
  readonly clear: () => void
  readonly dispose: () => void
}

export const ATTACHMENT_UNAVAILABLE: WikiAttachmentSnapshot = { error: {
  tag: "WikiAttachmentUnavailable", fault: "dependency", sentence: "Attachment unavailable.", actions: [], detail: ""
} }

/** Ephemeral browser resource handles, never persisted attachment bytes or credentials. */
export const createWikiAttachmentStore = ({ http, baseUrl }: { readonly http: FetchLike; readonly baseUrl: string }): WikiAttachmentStore => {
  type Entry = { snapshot: WikiAttachmentSnapshot | undefined; abort: AbortController; listeners: Set<() => void> }
  const entries = new Map<string, Entry>()
  let disposed = false
  const release = (entry: Entry) => {
    entry.abort.abort()
    if (entry.snapshot?.url !== undefined) URL.revokeObjectURL(entry.snapshot.url)
    entry.snapshot = undefined
  }
  const clear = () => {
    for (const entry of [...entries.values()]) {
      release(entry)
      entry.snapshot = ATTACHMENT_UNAVAILABLE
      for (const listener of entry.listeners) listener()
    }
  }
  return {
    get: (path) => disposed ? ATTACHMENT_UNAVAILABLE : entries.get(path)?.snapshot,
    subscribe: (path, listener) => {
      if (disposed) return () => {}
      let entry = entries.get(path)
      const load = entry === undefined || entry.abort.signal.aborted
      if (entry === undefined) {
        entry = { snapshot: undefined, abort: new AbortController(), listeners: new Set() }
        entries.set(path, entry)
      }
      entry.listeners.add(listener)
      if (load) {
        entry.abort = new AbortController()
        entry.snapshot = undefined
        const current = entry
        const request = current.abort
        for (const notify of current.listeners) notify()
        void (async () => {
          let status: number | undefined
          try {
            // Only locally constructed immutable Wiki content routes may spend this identity.
            if (!/^\/api\/repos\/[^/?#]+\/[^/?#]+\/wiki\/history\/[0-9]+\/[0-9]+\/content\?visibility=(public|private)$/.test(path)) throw new Error("Invalid attachment route")
            const response = await http(`${baseUrl}${path}`, { signal: AbortSignal.any([request.signal, AbortSignal.timeout(30_000)]), redirect: "error" })
            status = response.status
            if (!response.ok) {
              void response.body?.cancel().catch(() => {})
              throw new Error(`Attachment HTTP ${response.status}`)
            }
            const blob = await response.blob()
            if (request.signal.aborted) return
            current.snapshot = { url: URL.createObjectURL(blob) }
          } catch {
            if (request.signal.aborted) return
            current.snapshot = { error: {
              tag: "WikiAttachmentReadFailed", fault: status === 401 || status === 403 ? "user" : status === 404 ? "dependency" : "infra",
              sentence: "Attachment unavailable.", actions: [], detail: ""
            } }
          }
          for (const notify of current.listeners) notify()
        })()
      }
      const current = entry
      return () => {
        current.listeners.delete(listener)
        if (current.listeners.size === 0) {
          release(current)
          if (entries.get(path) === current) entries.delete(path)
        }
      }
    },
    clear,
    dispose: () => { disposed = true; clear(); entries.clear() }
  }
}
