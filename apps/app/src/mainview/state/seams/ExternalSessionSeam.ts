import { Schema } from "effect"
import { Entry } from "@smthrs/harness/ExternalTranscript"
import { EXTERNAL_CODEX_PATH } from "@smthrs/rpc/AgentApiRoutes"

/**
 * A Codex session run on this machine, shown read-only in the conversation (mvp.md M-38, T-AGT-03). The host
 * serves it at GET /api/external/codex; reads run only while the conversation subscribes, every `pollMs`, and ask
 * only for entries after the last one received. An entry missing its origin, version, session or read-only mark
 * stops the import with a visible error: nothing undecoded reaches the conversation.
 */
export interface ExternalSessionSnapshot {
  readonly session: string
  readonly owner?: { readonly login: string; readonly name: string }
  /** The directory the agent ran in; edited paths read relative to it. */
  readonly cwd?: string
  readonly entries: ReadonlyArray<Entry>
  /** Why the import stopped, in words the conversation shows. */
  readonly error?: string
}
export interface ExternalSessionSource {
  readonly get: () => ExternalSessionSnapshot
  readonly subscribe: (listener: () => void) => () => void
}
export interface ExternalSessionSeamOptions {
  /** Same-origin fetch of a host API path. */
  readonly http: (path: string, init?: RequestInit) => Promise<Response>
  readonly pollMs?: number
}

const Owner = Schema.Struct({ login: Schema.String, name: Schema.String })
const Read = Schema.Struct({
  entries: Schema.Array(Entry),
  next: Schema.Number,
  cwd: Schema.String,
  owner: Owner,
  error: Schema.optional(Schema.Struct({ code: Schema.String, message: Schema.String }))
})
const decodeRead = Schema.decodeUnknownExit(Read)
const Refusal = Schema.Struct({ error: Schema.Struct({ message: Schema.String }) })
const decodeRefusal = Schema.decodeUnknownExit(Refusal)

export function createExternalSessionSeam(options: ExternalSessionSeamOptions) {
  const sources = new Map<string, ExternalSessionSource & { readonly dispose: () => void }>()
  const source = (session: string): ExternalSessionSource & { readonly dispose: () => void } => {
    let snapshot: ExternalSessionSnapshot = { session, entries: [] }
    let next = 0
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const listeners = new Set<() => void>()
    const publish = (change: Partial<ExternalSessionSnapshot>) => { snapshot = { ...snapshot, ...change }; for (const listener of listeners) listener() }
    const read = async () => {
      if (disposed || snapshot.error !== undefined) return
      try {
        const response = await options.http(`${EXTERNAL_CODEX_PATH}?session=${encodeURIComponent(session)}&since=${next}`, { credentials: "same-origin" })
        const body: unknown = await response.json().catch(() => undefined)
        if (disposed) return
        if (!response.ok) {
          const refusal = decodeRefusal(body)
          return publish({ error: refusal._tag === "Success" ? refusal.value.error.message : `This host does not serve Codex sessions (${response.status}).` })
        }
        const decoded = decodeRead(body)
        if (decoded._tag === "Failure") return publish({ error: "The Codex session arrived without its source metadata, so it is not shown." })
        next = decoded.value.next
        publish({ owner: decoded.value.owner, cwd: decoded.value.cwd, entries: [...snapshot.entries, ...decoded.value.entries],
          ...(decoded.value.error === undefined ? {} : { error: decoded.value.error.message }) })
      } catch { /* unreachable: keep what arrived and read again on the next tick */ }
    }
    const poll = () => {
      timer = setTimeout(() => {
        timer = undefined
        if (!disposed && listeners.size) void read().finally(() => { if (!disposed && listeners.size && timer === undefined) poll() })
      }, options.pollMs ?? 5_000)
    }
    return {
      get: () => snapshot,
      subscribe: listener => {
        listeners.add(listener)
        if (listeners.size === 1 && !disposed) { void read(); poll() }
        return () => {
          listeners.delete(listener)
          if (!listeners.size && timer !== undefined) { clearTimeout(timer); timer = undefined }
        }
      },
      dispose: () => { disposed = true; if (timer !== undefined) clearTimeout(timer) }
    }
  }
  return {
    /** One source per session for the controller's lifetime. */
    session: (id: string): ExternalSessionSource => {
      const existing = sources.get(id)
      if (existing) return existing
      const created = source(id)
      sources.set(id, created)
      return created
    },
    dispose: () => { for (const each of sources.values()) each.dispose(); sources.clear() }
  }
}
export type ExternalSessionSeam = ReturnType<typeof createExternalSessionSeam>
