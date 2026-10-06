import { Result, Schema } from "effect"
import { claudeStart, codexStart, decodeClaude, decodeCodex, type Entry, type ExternalTranscriptError } from "@smthrs/harness/ExternalTranscript"
import { EXTERNAL_SESSIONS_PATH } from "@smthrs/rpc/AgentApiRoutes"
import type { LiveChannel } from "../../runtime/LiveChannel"

/**
 * A Codex or Claude Code session run on the host's machine, shown read-only in the conversation (mvp.md M-38,
 * T-AGT-03). Every host serves the session's raw JSONL at GET /api/external/sessions from a byte offset; this seam
 * keeps the decoder state per session and decodes each appended chunk with @smthrs/harness/ExternalTranscript, so
 * one decoder reads every host. Reads run only while the conversation subscribes: at once, whenever the live topic
 * `external:<agent>:<session>` says the file grew, and every `pollMs` while that topic serves nothing (a host
 * without the live channel). A read missing its agent, session, owner or offsets, and a transcript the decoder
 * refuses, stop the import with a visible error: nothing undecoded reaches the conversation.
 */
export type ExternalAgent = "codex" | "claude-code"
export const externalAgentName = (agent: ExternalAgent): string => agent === "codex" ? "Codex" : "Claude Code"

export interface ExternalSessionSnapshot {
  readonly agent: ExternalAgent
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
  /** The install's live channel; a growing session is read when its topic changes. */
  readonly live?: Pick<LiveChannel, "subscribe" | "getSnapshot">
  readonly pollMs?: number
}

/** What a decode keeps between chunks: the shared decoder's own state carries at least these. */
interface LineState { readonly pending: string; readonly line: number }
/** One session's decode: each pushed chunk's entries, and the error that stopped it. */
interface Tail {
  readonly push: (text: string) => { readonly entries: ReadonlyArray<Entry>; readonly error?: string }
  readonly cwd: () => string | undefined
}
const tail = <S extends LineState>(
  start: S,
  decode: (state: S, chunk: string) => Result.Result<{ readonly state: S; readonly entries: ReadonlyArray<Entry> }, ExternalTranscriptError>,
  cwd: (state: S) => string | undefined
) => (): Tail => {
  let state = start
  return {
    push: text => {
      const decoded = decode(state, text)
      if (Result.isSuccess(decoded)) { state = decoded.success.state; return { entries: decoded.success.entries } }
      // Keep every entry before the line that stopped the import; the error says where it stopped.
      const good = (state.pending + text).split("\n").slice(0, Math.max(0, decoded.failure.line - state.line - 1))
      const before = decode({ ...state, pending: "" }, good.map(line => `${line}\n`).join(""))
      if (Result.isSuccess(before)) state = before.success.state
      return { entries: Result.isSuccess(before) ? before.success.entries : [], error: decoded.failure.message }
    },
    cwd: () => cwd(state)
  }
}
/** Each agent's decode. A Claude Code transcript names its directory on every record, not in its decoded state. */
const tails: Record<ExternalAgent, () => Tail> = {
  codex: tail(codexStart, decodeCodex, state => state.session?.cwd),
  "claude-code": tail(claudeStart, decodeClaude, () => undefined)
}

const SESSION_ID = /^[0-9a-f-]{4,36}$/
const Read = Schema.Struct({
  agent: Schema.Literals(["codex", "claude-code"]),
  session_id: Schema.String,
  owner: Schema.Struct({ login: Schema.String, name: Schema.String }),
  offset: Schema.Number,
  next: Schema.Number,
  text: Schema.String,
  eof: Schema.Boolean
})
const decodeRead = Schema.decodeUnknownExit(Read)
const Refusal = Schema.Struct({ message: Schema.String })
const decodeRefusal = Schema.decodeUnknownExit(Refusal)

export function createExternalSessionSeam(options: ExternalSessionSeamOptions) {
  const sources = new Map<string, ExternalSessionSource & { readonly dispose: () => void }>()
  const source = (agent: ExternalAgent, session: string): ExternalSessionSource & { readonly dispose: () => void } => {
    const name = externalAgentName(agent)
    const decoder = tails[agent]()
    const topic = `external:${agent}:${session}`
    let snapshot: ExternalSessionSnapshot = { agent, session, entries: [] }
    let offset = 0
    let found: string | undefined
    let disposed = false
    let reading = false
    let again = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let stopLive: (() => void) | undefined
    const listeners = new Set<() => void>()
    const publish = (change: Partial<ExternalSessionSnapshot>) => { snapshot = { ...snapshot, ...change }; for (const listener of listeners) listener() }
    const unshown = () => publish({ error: `The ${name} session arrived without its source metadata, so it is not shown.` })
    /** One chunk: false when the import stopped or the host has nothing more. */
    const chunk = async (): Promise<boolean> => {
      const response = await options.http(`${EXTERNAL_SESSIONS_PATH}?agent=${agent}&session=${encodeURIComponent(session)}&offset=${offset}`, { credentials: "same-origin" })
      const body: unknown = await response.json().catch(() => undefined)
      if (disposed) return false
      if (!response.ok) {
        const refusal = decodeRefusal(body)
        publish({ error: refusal._tag === "Success" ? refusal.value.message : `This host does not serve ${name} sessions (${response.status}).` })
        return false
      }
      const read = decodeRead(body)
      if (read._tag === "Failure") { unshown(); return false }
      const { session_id, owner, text, next, eof } = read.value
      if (read.value.agent !== agent || !session_id.startsWith(session) || (found !== undefined && session_id !== found) ||
        read.value.offset !== offset || next < offset || (next === offset) !== (text === "")) { unshown(); return false }
      found = session_id
      offset = next
      const decoded = decoder.push(text)
      publish({ owner, cwd: decoder.cwd(), entries: [...snapshot.entries, ...decoded.entries], ...(decoded.error === undefined ? {} : { error: decoded.error }) })
      return decoded.error === undefined && !eof
    }
    /** Reads until the host has nothing more; a read asked for while one runs runs once after it. */
    const read = async () => {
      if (reading) { again = true; return }
      reading = true
      try {
        do {
          again = false
          while (!disposed && snapshot.error === undefined && await chunk());
        } while (again && !disposed && snapshot.error === undefined)
      } catch { /* unreachable host: keep what arrived and read again on the next tick */ } finally { reading = false }
    }
    const live = () => options.live?.getSnapshot(topic)?.data !== undefined
    const poll = () => {
      timer = setTimeout(() => {
        timer = undefined
        if (disposed || !listeners.size) return
        void (live() ? Promise.resolve() : read()).finally(() => { if (!disposed && listeners.size && timer === undefined) poll() })
      }, options.pollMs ?? 5_000)
    }
    const stop = () => {
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
      stopLive?.()
      stopLive = undefined
    }
    return {
      get: () => snapshot,
      subscribe: listener => {
        listeners.add(listener)
        if (listeners.size === 1 && !disposed && snapshot.error === undefined) {
          if (SESSION_ID.test(session)) stopLive = options.live?.subscribe(topic, () => { void read() })
          void read()
          poll()
        }
        return () => {
          listeners.delete(listener)
          if (!listeners.size) stop()
        }
      },
      dispose: () => { disposed = true; stop() }
    }
  }
  return {
    /** One source per agent session for the controller's lifetime. */
    session: (agent: ExternalAgent, id: string): ExternalSessionSource => {
      const key = `${agent}:${id}`
      const existing = sources.get(key)
      if (existing) return existing
      const created = source(agent, id)
      sources.set(key, created)
      return created
    },
    dispose: () => { for (const each of sources.values()) each.dispose(); sources.clear() }
  }
}
export type ExternalSessionSeam = ReturnType<typeof createExternalSessionSeam>
