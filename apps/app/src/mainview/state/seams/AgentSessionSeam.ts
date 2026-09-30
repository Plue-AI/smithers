import { refuseCloudSignIn, SIGN_OUT_REFUSAL } from "./CloudSignIn"
/*
 * The cloud agent sessions seam (UI-COVERAGE-GAPS.md "agents · Cloud agent
 * sessions"): a signed-in user runs a Codex/Claude/Smithers agent on a
 * repository, executed by Smithers Cloud inside a sandbox, from the web app —
 * the replacement for running codex/claude in a local terminal. plue's routes
 * (internal/routes/agent_sessions.go, internal/routes/agent_session_stream.go,
 * internal/services/agent.go):
 *
 *   POST   /api/repos/{o}/{r}/agent/sessions                  { title } → 201 AgentSessionResponse
 *   GET    /api/repos/{o}/{r}/agent/sessions                  → 200 [AgentSessionResponse] (paginated)
 *   GET    /api/repos/{o}/{r}/agent/sessions/{id}             → 200 AgentSessionResponse
 *   DELETE /api/repos/{o}/{r}/agent/sessions/{id}             → 204 (an active run is cancelled and
 *                                                                 finalized before the row is tombstoned)
 *   POST   /api/repos/{o}/{r}/agent/sessions/{id}/messages    { role: "user", text, agent_provider,
 *                                                               agent_transport? } → 201 AgentMessageResponse;
 *                                                               a user message dispatches the sandbox run
 *                                                               (409 while one is already active)
 *   GET    /api/repos/{o}/{r}/agent/sessions/{id}/messages    → 200 [AgentMessageResponse] (?limit, ≤200)
 *   GET    /api/repos/{o}/{r}/agent/sessions/{id}/stream      → SSE, `event: agent.session`
 *
 * The stream's data is services.AgentSessionEvent { session_id, action,
 * message?, status? }: action "message" carries the full AgentMessageResponse
 * (the SSE `id:` line is the message id, so replays dedupe), action "status"
 * carries only the new status word (active → completed | failed | cancelled)
 * and no `id:` line. Keep-alive lines are SSE comments.
 *
 * SSE carries live transcript updates; bounded snapshot reads repair initial
 * connection races and missed status wakeups. Streaming is verified in
 * both proxies the app rides: the Worker's platform proxy (apps/server/src/
 * proxies.ts handlePlatformProxy) passes the upstream body through untouched
 * and preserves the content type, and its fetch deadline covers the headers
 * only (apps/server/src/Http.ts fetchWithDeadline: "a streaming answer is
 * never cut off mid-body"); the native app's Bun proxy (apps/app/src/bun/
 * server.ts proxyCloud) streams the same way ("Once the upstream has answered
 * it is cleared, so a streaming body is never cut off mid-flight"). What
 * cannot ride the stream is the seam's own fetch: SeamContext.http is the
 * bounded fetch (state/controller/context.ts boundedFetch), which buffers the
 * whole body under a deadline — a stream through it would never deliver an
 * event. The stream therefore rides SeamContext.stream, the unbounded tapped
 * fetch; a context without one reads the transcript RESTfully and the card
 * says no live rows arrive.
 *
 * The session card is the EXISTING `agent` card's cloud variant (no new card
 * kind — packages/rpc/src/Cards.ts): session · repository · provider · state,
 * transcript rows appended as the stream delivers, Stop in the footer. The
 * card payload is the live window onto plue's transcript, never the record;
 * it holds the newest AGENT_TRANSCRIPT_ROW_CAP messages.
 */
import { actorSharedState } from "../ActorBindings"
import { CardSchema, type Card } from "../AppState"
import { canonicalStoredJsonValue } from "../EventValue"
import { resolveTargetRepo } from "../RepoContext"
import { CloudAnswerUnusable, cloudFailure, cloudUnreachable, createCloudClient } from "./CloudClient"
import type { CloudFailure } from "./CloudClient"
import { readResult } from "./SeamContext"
import type { SeamContext } from "./SeamContext"

/** The providers plue's message route accepts today are "smithers" and "codex"; "claude" is the spec's third door — plue refuses it in its own words until it lands. */
export const AGENT_PROVIDERS = ["codex", "claude", "smithers"] as const
export type AgentProvider = (typeof AGENT_PROVIDERS)[number]

export const isAgentProvider = (value: string): value is AgentProvider =>
  (AGENT_PROVIDERS as ReadonlyArray<string>).includes(value)

export const DEGRADED_AGENT_SESSION_REFUSAL =
  "This Smithers Cloud sign-in can't run agent sessions — sign in again to enable them."

/*
 * plue's messages route caps a page at 200 (services/agent.go
 * maxAgentMessagesPageSize); the card holds the newest page's worth. The
 * server stays the transcript's authority — the card is its live window.
 */
export const AGENT_TRANSCRIPT_ROW_CAP = 200

/** plue's session statuses: "active" on create; "completed" | "failed" | "cancelled" terminal. */
export const AGENT_SESSION_TERMINAL: ReadonlySet<string> = new Set(["completed", "failed", "cancelled"])

/** One session row off the wire, parsed (services.AgentSessionResponse). */
export interface AgentSessionRow {
  readonly id: string
  readonly title: string
  readonly status: string
  readonly messageCount: number
  readonly createdAt: string | null
  /** The kind=agent workspace the run executes in (RFD-004); null while the DTO names none. */
  readonly workspaceId: string | null
}

/** One message row off the wire, parsed (services.AgentMessageResponse). */
export interface AgentMessageRow {
  readonly id: number
  readonly sessionId: string
  readonly role: string
  readonly sequence: number
  readonly parts: ReadonlyArray<{ readonly type: string; readonly text: string }>
  readonly createdAt: string | null
}

type AgentCard = Extract<Card, { kind: "agent" }>
type AgentCloudPayload = Extract<AgentCard["payload"], { readonly cloud: true }>
type TranscriptRow = AgentCloudPayload["transcript"][number]

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

const textOrNull = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null)

const intOrNull = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null

/** One session row; null when the entry carries no usable session id. */
const parseSession = (value: unknown): AgentSessionRow | null => {
  if (!isRecord(value)) return null
  const id = textOrNull(value.id)
  const status = textOrNull(value.status)
  if (id === null || status === null) return null
  return {
    id,
    title: typeof value.title === "string" ? value.title : "",
    status,
    messageCount: intOrNull(value.message_count) ?? 0,
    createdAt: textOrNull(value.created_at),
    workspaceId: textOrNull(value.workspace_id)
  }
}

/*
 * A part's text, mirroring plue's own renderAgentTaskPartContent (services/
 * agent.go): a string is itself, an object's `value`/`output` string is the
 * text, anything else (a tool call's arguments) is its compact JSON. Bounded,
 * so one runaway part cannot bloat the persisted card.
 */
const PART_TEXT_CAP = 8_000
const partText = (content: unknown): string => {
  const text = typeof content === "string"
    ? content
    : isRecord(content) && typeof content.value === "string"
    ? content.value
    : isRecord(content) && typeof content.output === "string"
    ? content.output
    : JSON.stringify(content) ?? ""
  return text.length <= PART_TEXT_CAP ? text : `${text.slice(0, PART_TEXT_CAP)}…`
}

/** One message row; null when it carries no usable id. Parts read in part_index order. */
const parseMessage = (value: unknown): AgentMessageRow | null => {
  if (!isRecord(value)) return null
  const id = intOrNull(value.id)
  if (id === null) return null
  const parts = (Array.isArray(value.parts) ? value.parts : [])
    .flatMap((part) => {
      if (!isRecord(part)) return []
      const type = textOrNull(part.type)
      return type === null ? [] : [{ partIndex: intOrNull(part.part_index) ?? 0, type, text: partText(part.content) }]
    })
    .sort((left, right) => left.partIndex - right.partIndex)
    .map(({ type, text }) => ({ type, text }))
  return {
    id,
    sessionId: textOrNull(value.session_id) ?? "",
    role: textOrNull(value.role) ?? "assistant",
    sequence: intOrNull(value.sequence) ?? id,
    parts,
    createdAt: textOrNull(value.created_at)
  }
}

/** The card row for one message. */
const rowOf = (message: AgentMessageRow): TranscriptRow => ({
  id: message.id,
  role: message.role,
  sequence: message.sequence,
  createdAt: message.createdAt,
  parts: message.parts.map((part) => ({ ...part }))
})

/** Append (or replace, on a stream replay's redelivery) one row, oldest first, capped at the newest page. */
const appendRow = (rows: ReadonlyArray<TranscriptRow>, row: TranscriptRow): ReadonlyArray<TranscriptRow> =>
  [...rows.filter((existing) => existing.id !== row.id), row]
    .sort((left, right) => left.sequence - right.sequence || left.id - right.id)
    .slice(-AGENT_TRANSCRIPT_ROW_CAP)

const cardIdOf = (sessionId: string): string => `agent-session-${sessionId}`

/** One SSE frame off the wire: the `event`/`data`/`id` fields, comments dropped. */
interface SseFrame {
  readonly id: string | null
  readonly event: string
  readonly data: string
}

/** Split the buffered text into the complete frames and the partial tail. A frame ends at a blank line. */
const splitFrames = (buffer: string): { readonly frames: Array<SseFrame>; readonly rest: string } => {
  const blocks = buffer.split(/\r?\n\r?\n/)
  const rest = blocks.pop() ?? ""
  const frames: Array<SseFrame> = []
  for (const block of blocks) {
    let id: string | null = null
    let event = ""
    const data: Array<string> = []
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith(":")) continue
      if (line.startsWith("id:")) id = line.slice(3).trim()
      else if (line.startsWith("event:")) event = line.slice(6).trim()
      else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""))
    }
    if (data.length > 0) frames.push({ id, event, data: data.join("\n") })
  }
  return { frames, rest }
}

export interface AgentSessionSeam {
  /** `agent.session.new <owner/repo> <provider> <task…>`: create the session, post the task (dispatches the run), render the card, stream it. */
  readonly newSession: (repo: string, provider: AgentProvider, task: string) => Promise<string | { readonly value: string }>
  /** `agent.session.list [owner/repo]`: the repository's sessions as a transcript listing, each row naming its doors. */
  readonly listSessions: (repo?: string) => Promise<string | { readonly value: string }>
  /** `agent.session.view <id> [owner/repo]`: re-read one session and its transcript into the card; attach the stream while it is active. */
  readonly viewSession: (sessionId: string, repo?: string) => Promise<string | { readonly value: string }>
  /** `agent.session.say <id> <text…>`: post the follow-up message (dispatches the session's next run). */
  readonly sayToSession: (sessionId: string, text: string) => Promise<string | { readonly value: string }>
  /** `agent.session.stop <id> [owner/repo]`: DELETE the session — an active run is cancelled and finalized. */
  readonly stopSession: (sessionId: string, repo?: string) => Promise<string | { readonly value: string }>
  /** Abort every open stream; the controller dies. */
  readonly dispose: () => void
}

export const createAgentSessionSeam = (ctx: SeamContext, options: { readonly repairIntervalMs?: number } = {}): AgentSessionSeam => {
  const { url: cloud, get, send: sendJson } = createCloudClient(ctx)
  const identitySnapshot = (): string => JSON.stringify([
    ctx.store.collections.cloudSessions.get("cloud"),
    ctx.store.collections.identitySessions.get("identity")
  ])
  /* Streams share one holder across the user/agent actor pair, like the workspace seam's watches. */
  const shared = actorSharedState(ctx, "agentSession", () => {
    const state = {
      streams: new Map<string, AbortController>(),
      disposed: false,
      generation: 0,
      listEpochs: new Map<string, number>(),
      pendingLists: new Set<{ readonly repo: string; readonly updates: Map<string, Partial<AgentSessionRow> | null> }>(),
      subscriptions: [] as Array<{ unsubscribe(): void }>
    }
    let owner = identitySnapshot()
    const retire = (): void => {
      const next = identitySnapshot()
      if (next === owner) return
      owner = next
      state.generation += 1
      state.listEpochs.clear()
      state.pendingLists.clear()
      for (const controller of state.streams.values()) controller.abort()
      state.streams.clear()
    }
    // A response belongs to the authentication generation that admitted it.
    // Include identity changes even when the cloud-session refresh is pending.
    state.subscriptions.push(
      ctx.store.collections.cloudSessions.subscribeChanges(retire),
      ctx.store.collections.identitySessions.subscribeChanges(retire)
    )
    return state
  })
  const currentOperation = (): (() => boolean) => {
    const generation = shared.generation
    const identity = identitySnapshot()
    return () => !shared.disposed && shared.generation === generation && identitySnapshot() === identity
      && ctx.store.collections.cloudSessions.get("cloud")?.state === "signed-in"
  }

  const sessionsPath = (repo: string, rest = ""): string => {
    const [owner = "", name = ""] = repo.split("/")
    return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/agent/sessions${rest}`
  }

  const gate = (): string | void => {
    const session = ctx.store.collections.cloudSessions.get("cloud")
    if (session?.state !== "signed-in") return refuseCloudSignIn(ctx)
    if (session.scopes === "degraded") return DEGRADED_AGENT_SESSION_REFUSAL
  }

  /*
   * The repository a session's route rides: the one the invocation named,
   * else the one the session's card carries (a card button's act re-finds it
   * there), else the active target. Never a guess — the resolver's error
   * names the choice.
   */
  const resolveSessionRepo = (
    sessionId: string,
    explicit?: string
  ): { readonly repo: string } | { readonly error: string } => {
    if (explicit !== undefined && explicit !== "") return resolveTargetRepo(ctx.store, explicit)
    const card = ctx.store.collections.cards.get(cardIdOf(sessionId))
    if (card?.kind === "agent" && "cloud" in card.payload) return { repo: card.payload.repo }
    return resolveTargetRepo(ctx.store, undefined)
  }

  /* ---- the card ---- */

  const listCardId = (repo: string): string => `agent-sessions-${repo}`
  const nextListEpoch = (repo: string): number => {
    const epoch = (shared.listEpochs.get(repo) ?? 0) + 1
    shared.listEpochs.set(repo, epoch)
    return epoch
  }

  /** Replayed transport facts must not manufacture accepted journal events. */
  const persistObservation = async (card: Card, actor: "user" | "smithers" | "system"): Promise<void> => {
    const committed = ctx.store.committedCard(card.id)
    const current = ctx.store.collections.cards.get(card.id)
    const value = canonicalStoredJsonValue(CardSchema.parse(card))
    // A differing queued edit still needs this observation after its receipt.
    if (committed !== undefined && current !== undefined &&
      canonicalStoredJsonValue(committed) === value && canonicalStoredJsonValue(CardSchema.parse(current)) === value) return
    await ctx.dispatch({ type: "card.upsert", actor, card }).isPersisted.promise
  }

  /** Merge observations newer than a listing request, including successful deletion. */
  const updateListedSession = async (repo: string, id: string, patch: Partial<AgentSessionRow> | null, actor: "user" | "smithers" | "system" = ctx.actor()): Promise<void> => {
    for (const listing of shared.pendingLists) {
      if (listing.repo === repo) listing.updates.set(id, patch === null ? null : { ...listing.updates.get(id), ...patch })
    }
    const card = ctx.store.collections.cards.get(listCardId(repo))
    if (card?.kind !== "agents" || !("cloud" in card.payload)) return
    const sessions = card.payload.sessions.flatMap(row => row.id !== id ? [row] : patch === null ? [] : [{ ...row, ...patch }])
    await persistObservation({ ...card, payload: { ...card.payload, sessions } }, actor)
  }

  /** The card as one upsert; the live window's facts come from the arguments, never invented. */
  const renderSession = async (
    session: { readonly id: string; readonly title: string; readonly status: string; readonly workspaceId: string | null },
    facts: { readonly repo: string; readonly provider: AgentProvider | null },
    overrides: Partial<Pick<AgentCloudPayload, "transcript" | "error" | "task">> & { readonly clearError?: boolean } = {},
    actor: "user" | "smithers" | "system" = ctx.actor()
  ): Promise<void> => {
    const id = cardIdOf(session.id)
    const existing = ctx.store.collections.cards.get(id)
    const prior = existing?.kind === "agent" && "cloud" in existing.payload ? existing.payload : undefined
    const task = overrides.task !== undefined ? overrides.task : prior?.task
    const payload: AgentCloudPayload = {
      cloud: true,
      displayName: session.title === "" ? "Agent session" : session.title,
      sessionId: session.id,
      repo: facts.repo,
      provider: facts.provider,
      workspaceId: session.workspaceId,
      state: session.status,
      ...(task === undefined ? {} : { task }),
      transcript: overrides.transcript !== undefined ? [...overrides.transcript] : [...(prior?.transcript ?? [])],
      ...(overrides.clearError === true ? {} : overrides.error !== undefined ? { error: overrides.error } : prior?.error !== undefined ? { error: prior.error } : {})
    }
    const card: Card = {
      id,
      kind: "agent",
      title: `${payload.displayName} · ${payload.repo}`,
      status: "active",
      createdAt: existing?.createdAt ?? Date.now(),
      ordinal: existing?.ordinal ?? ctx.nextOrdinal(),
      payload
    }
    await Promise.all([
      persistObservation(card, actor),
      updateListedSession(facts.repo, session.id, { title: session.title, status: session.status, workspaceId: session.workspaceId }, actor)
    ])
  }

  /** The refusal rides the card too, so it stays visible beside the transcript. */
  const failOnCard = async (sessionId: string, error: string | undefined, actor: "user" | "smithers" | "system" = ctx.actor()): Promise<void> => {
    const existing = ctx.store.collections.cards.get(cardIdOf(sessionId))
    if (existing?.kind !== "agent" || !("cloud" in existing.payload)) return
    const { error: priorError, ...payload } = existing.payload
    await persistObservation({ ...existing, payload: { ...payload, ...(error === undefined ? {} : { error }) } }, actor)
  }

  /* ---- the stream ---- */

  /** Apply one parsed `agent.session` event to the card; a terminal status ends the stream. */
  const applyStreamEvent = async (sessionId: string, frame: SseFrame, close: () => void): Promise<void> => {
    if (frame.event !== "agent.session") return
    let parsed: unknown
    try {
      parsed = JSON.parse(frame.data)
    } catch {
      return
    }
    if (!isRecord(parsed) || parsed.session_id !== sessionId) return
    const existing = ctx.store.collections.cards.get(cardIdOf(sessionId))
    if (existing?.kind !== "agent" || !("cloud" in existing.payload)) return
    if (parsed.action === "message") {
      const message = parseMessage(parsed.message)
      if (message === null || message.sessionId !== sessionId || (frame.id !== null && frame.id !== String(message.id))) return
      const payload = existing.payload
      await persistObservation({ ...existing, payload: { ...payload, transcript: [...appendRow(payload.transcript, rowOf(message))] } }, "system")
      return
    }
    if (parsed.action === "status") {
      const status = textOrNull(parsed.status)
      if (status === null) return
      const payload = existing.payload
      await Promise.all([
        persistObservation({ ...existing, payload: { ...payload, state: status } }, "system"),
        updateListedSession(payload.repo, sessionId, { status }, "system")
      ])
      /* The session is over: no message follows a terminal status, so the stream's work is done. */
      if (AGENT_SESSION_TERMINAL.has(status)) close()
    }
  }

  // The route clamps to 100 even though its service allows 200. Read up to
  // three aligned pages around the session's observed count to retain the last
  // 200 rows, including for terminal sessions that will never open SSE.
  const readWindow = async (repo: string, session: AgentSessionRow, current: () => boolean, signal?: AbortSignal): Promise<TranscriptRow[] | string> => {
    const size = 100
    const start = Math.floor(Math.max(0, session.messageCount - AGENT_TRANSCRIPT_ROW_CAP) / size) * size
    const end = Math.max(start + size, Math.ceil(session.messageCount / size) * size)
    let rows: ReadonlyArray<TranscriptRow> = []
    for (let offset = start; offset < end && current(); offset += size) {
      const path = sessionsPath(repo, `/${encodeURIComponent(session.id)}/messages?limit=${size}${offset === 0 ? "" : `&cursor=${offset}`}`)
      const read = await get(path, undefined, signal)
      if (!current()) return SIGN_OUT_REFUSAL
      if ("error" in read) return featureRefusal(read, repo, session.id)
      if (!Array.isArray(read.body)) return `Smithers Cloud answered the messages of agent session ${session.id} with an unreadable payload`
      for (const value of read.body) {
        const message = parseMessage(value)
        if (message === null || message.sessionId !== session.id) return `Smithers Cloud answered the messages of agent session ${session.id} with an unreadable payload`
        rows = appendRow(rows, rowOf(message))
      }
      if (read.body.length < size) break
    }
    return [...rows]
  }

  /** One owned watcher serializes SSE and repair observations through receipts. */
  const attachStream = (repo: string, sessionId: string): void => {
    const streamFetch = ctx.stream
    const authorized = currentOperation()
    if (!authorized() || streamFetch === undefined || shared.streams.has(sessionId)) return
    const controller = new AbortController()
    shared.streams.set(sessionId, controller)
    const current = (): boolean => authorized() && !controller.signal.aborted && shared.streams.get(sessionId) === controller
    const interval = options.repairIntervalMs ?? 15_000
    let failures = 0
    let retryDelay = interval
    let queued = Promise.resolve()
    const detach = (): void => {
      if (shared.streams.get(sessionId) === controller) shared.streams.delete(sessionId)
      controller.abort()
    }
    const observe = (action: () => Promise<void>): Promise<void> => {
      const next = queued.then(() => current() ? action() : undefined)
      // Persistence rejection stops the watcher, including optimistic cursors.
      queued = next.catch(detach)
      return next
    }
    const refused = async (failure: CloudFailure): Promise<void> => {
      await failOnCard(sessionId, failure.error, "system")
      if (failure.status !== null && failure.status >= 400 && failure.status < 500
        && failure.status !== 408 && failure.status !== 429) {
        detach()
        return
      }
      retryDelay = Math.max(
        Math.min(Math.max(interval, 120_000), interval * 2 ** Math.min(failures++, 10)),
        (failure.retryAfterSeconds ?? 0) * 1_000
      )
    }
    const refresh = async (): Promise<void> => {
      const answer = await get(sessionsPath(repo, `/${encodeURIComponent(sessionId)}`), undefined, controller.signal)
      if (!current()) return
      if ("error" in answer) { await refused(answer); return }
      const session = parseSession(answer.body)
      if (session === null || session.id !== sessionId) return
      const rows = await readWindow(repo, session, current, controller.signal)
      if (!current() || typeof rows === "string") return
      const card = ctx.store.collections.cards.get(cardIdOf(sessionId))
      if (card?.kind !== "agent" || !("cloud" in card.payload)) return
      const transcript = rows.reduce<ReadonlyArray<TranscriptRow>>((prior, row) => appendRow(prior, row), card.payload.transcript)
      await renderSession(session, { repo, provider: card.payload.provider }, { transcript: [...transcript] }, "system")
      if (current() && AGENT_SESSION_TERMINAL.has(session.status)) detach()
    }
    const pause = (): Promise<void> => new Promise(resolve => {
      if (!current()) { resolve(); return }
      const finish = (): void => { clearTimeout(timer); controller.signal.removeEventListener("abort", finish); resolve() }
      const timer = setTimeout(finish, retryDelay)
      timer.unref?.()
      controller.signal.addEventListener("abort", finish, { once: true })
    })
    const repairs = async (): Promise<void> => {
      while (current()) {
        await pause()
        if (current()) await observe(refresh)
      }
    }
    const connection = async (): Promise<void> => {
      const card = ctx.store.collections.cards.get(cardIdOf(sessionId))
      const rows = card?.kind === "agent" && "cloud" in card.payload ? card.payload.transcript : []
      const cursor = Math.max(0, ...rows.map(row => row.id))
      const response = await streamFetch(cloud(sessionsPath(repo, `/${encodeURIComponent(sessionId)}/stream`)), {
        headers: { accept: "text/event-stream", "Last-Event-ID": String(cursor) }, signal: controller.signal
      })
      const contentType = response.headers.get("content-type") ?? ""
      if (!current()) {
        await response.body?.cancel().catch(() => {})
        return
      }
      if (!response.ok) {
        const failure = await cloudFailure(response, `Smithers Cloud could not open the session stream (HTTP ${response.status}).`)
        await observe(() => refused(failure))
        return
      }
      if (response.body === null || !contentType.includes("text/event-stream")) {
        await response.body?.cancel().catch(() => {})
        await observe(() => refused(cloudUnreachable(new CloudAnswerUnusable({ expected: "session stream" }))))
        return
      }
      failures = 0
      retryDelay = interval
      await observe(() => failOnCard(sessionId, undefined, "system"))
      const reader = response.body.getReader()
      const cancel = (): void => { void reader.cancel().catch(() => {}) }
      controller.signal.addEventListener("abort", cancel, { once: true })
      try {
        // Plue's cursor 0 starts at its connection head. Only a read after
        // readiness covers rows committed between an empty read and that head.
        // Status has no durable SSE ID, so this also repairs a missed terminal.
        await observe(refresh)
        const decoder = new TextDecoder()
        let buffer = ""
        while (current()) {
          const chunk = await reader.read()
          if (chunk.done || !current()) break
          buffer += decoder.decode(chunk.value, { stream: true })
          const split = splitFrames(buffer)
          buffer = split.rest
          for (const frame of split.frames) {
            if (!current()) break
            await observe(() => applyStreamEvent(sessionId, frame, detach))
          }
        }
      } finally {
        controller.signal.removeEventListener("abort", cancel)
        await reader.cancel().catch(() => {})
        reader.releaseLock()
      }
    }
    const run = async (): Promise<void> => {
      void repairs().catch(detach)
      try {
        while (current()) {
          try { await connection() } catch (error) {
            if (current()) await observe(() => refused(cloudUnreachable(error)))
          }
          if (current()) await pause()
        }
      } finally { detach() }
    }
    void run().catch(detach)
  }

  const detachStream = (sessionId: string): void => {
    const controller = shared.streams.get(sessionId)
    if (controller === undefined) return
    shared.streams.delete(sessionId)
    controller.abort()
  }

  /* ---- the acts ---- */

  const newSession: AgentSessionSeam["newSession"] = async (repoArg, provider, task) => {
    if (shared.disposed) return SIGN_OUT_REFUSAL
    const refusal = gate()
    if (refusal !== undefined) return refusal
    const current = currentOperation()
    const target = resolveTargetRepo(ctx.store, repoArg)
    if ("error" in target) return target.error
    const repo = target.repo
    const title = task.trim()
    const created = await sendJson("POST", sessionsPath(repo), { title })
    if (!current()) return SIGN_OUT_REFUSAL
    if ("error" in created) return featureRefusal(created, repo)
    const session = parseSession(created.body)
    if (session === null) return "Smithers Cloud answered the new agent session with an unreadable payload"
    // Keep the accepted session identity before the second POST launches a run.
    await renderSession(session, { repo, provider }, { task: title, clearError: true })
    if (!current()) return SIGN_OUT_REFUSAL
    /* The first message is what dispatches the run (routes/agent_sessions.go PostMessage). */
    const posted = await postMessage(repo, session.id, title, provider)
    if (!current()) return SIGN_OUT_REFUSAL
    if (typeof posted === "string") {
      await renderSession(session, { repo, provider }, { error: posted })
      if (!current()) return SIGN_OUT_REFUSAL
      return `The agent session was created on ${repo}, but the first message did not return a confirmed result: ${posted}`
    }
    await renderSession(session, { repo, provider }, { transcript: [rowOf(posted)], task: title, clearError: true })
    if (!current()) return SIGN_OUT_REFUSAL
    attachStream(repo, session.id)
    return {
      value: `Agent session ${session.id} started on ${repo} with ${provider} — the card streams its transcript. Follow up with agent.session.say ${session.id} <text>; stop it with agent.session.stop ${session.id}.`
    }
  }

  const postMessage = async (
    repo: string,
    sessionId: string,
    text: string,
    provider: AgentProvider | undefined
  ): Promise<AgentMessageRow | string> => {
    const answer = await sendJson("POST", sessionsPath(repo, `/${encodeURIComponent(sessionId)}/messages`), {
      role: "user",
      text,
      /* plue defaults an absent provider to "smithers" (routes normalizeAgentRuntimeRequest). */
      ...(provider === undefined ? {} : { agent_provider: provider })
    })
    if ("error" in answer) return answer.error
    const message = parseMessage(answer.body)
    return message !== null && message.sessionId === sessionId ? message : "Smithers Cloud answered the posted message with an unreadable payload"
  }

  const listSessions: AgentSessionSeam["listSessions"] = async (repoArg) => {
    if (shared.disposed) return SIGN_OUT_REFUSAL
    const refusal = gate()
    if (refusal !== undefined) return refusal
    const current = currentOperation()
    const target = resolveTargetRepo(ctx.store, repoArg)
    if ("error" in target) return target.error
    const repo = target.repo
    const epoch = nextListEpoch(repo)
    const pending = { repo, updates: new Map<string, Partial<AgentSessionRow> | null>() }
    shared.pendingLists.add(pending)
    const answer = await get(`${sessionsPath(repo)}?limit=100`, "the agent sessions").finally(() => { shared.pendingLists.delete(pending) })
    if (!current()) return SIGN_OUT_REFUSAL
    if (shared.listEpochs.get(repo) !== epoch) return readResult("Agent session list superseded by a newer update.")
    if ("error" in answer) return featureRefusal(answer, repo)
    if (!Array.isArray(answer.body)) return `Smithers Cloud answered agent sessions for ${repo} with an unreadable payload`
    const sessions = answer.body.flatMap((entry) => {
      const parsed = parseSession(entry)
      if (parsed === null) return []
      const update = pending.updates.get(parsed.id)
      return update === null ? [] : [{ ...parsed, ...update }]
    })
    const id = listCardId(repo)
    const existing = ctx.store.collections.cards.get(id)
    await ctx.dispatch({ type: "card.upsert", actor: ctx.actor(), card: {
      id, kind: "agents", title: `Agent sessions · ${repo}`, status: "active",
      createdAt: existing?.createdAt ?? Date.now(), ordinal: existing?.ordinal ?? ctx.nextOrdinal(),
      payload: { cloud: true, repo, sessions }
    } }).isPersisted.promise
    if (!current()) return SIGN_OUT_REFUSAL
    const listing = sessions.length === 0
      ? `No agent sessions on ${repo}.`
      : [
        `Agent sessions on ${repo}:`,
        ...sessions.map((session) =>
          `${session.title === "" ? "(untitled)" : session.title} · ${session.id} · ${session.status} · ${session.messageCount} message${session.messageCount === 1 ? "" : "s"}${session.createdAt === null ? "" : ` · ${session.createdAt}`}`
        )
      ].join("\n")
    return readResult(listing)
  }

  const viewSession: AgentSessionSeam["viewSession"] = async (sessionId, repoArg) => {
    if (shared.disposed) return SIGN_OUT_REFUSAL
    const refusal = gate()
    if (refusal !== undefined) return refusal
    const current = currentOperation()
    const target = resolveSessionRepo(sessionId, repoArg)
    if ("error" in target) return target.error
    const repo = target.repo
    detachStream(sessionId)
    const answer = await get(sessionsPath(repo, `/${encodeURIComponent(sessionId)}`))
    if (!current()) return SIGN_OUT_REFUSAL
    if ("error" in answer) return featureRefusal(answer, repo, sessionId)
    const session = parseSession(answer.body)
    if (session === null || session.id !== sessionId) return `Smithers Cloud answered agent session ${sessionId} with an unreadable payload`
    const transcript = await readWindow(repo, session, current)
    if (!current()) return SIGN_OUT_REFUSAL
    if (typeof transcript === "string") return transcript
    /*
     * The provider is per-message on the wire, never on the session DTO: what
     * the card already knows stands, and a session first met here states none
     * — a guessed provider is a lie the header would repeat.
     */
    const prior = ctx.store.collections.cards.get(cardIdOf(sessionId))
    const provider = prior?.kind === "agent" && "cloud" in prior.payload ? prior.payload.provider : null
    await renderSession(session, { repo, provider }, { transcript, clearError: true })
    if (!current()) return SIGN_OUT_REFUSAL
    if (!AGENT_SESSION_TERMINAL.has(session.status)) attachStream(repo, session.id)
    return {
      value: `Agent session ${session.id} on ${repo}: ${session.title === "" ? "(untitled)" : session.title} — ${session.status}, ${transcript.length} message${transcript.length === 1 ? "" : "s"} shown. The card ${AGENT_SESSION_TERMINAL.has(session.status) ? "holds the transcript" : "streams the transcript live"}.`
    }
  }

  const sayToSession: AgentSessionSeam["sayToSession"] = async (sessionId, text) => {
    if (shared.disposed) return SIGN_OUT_REFUSAL
    const refusal = gate()
    if (refusal !== undefined) return refusal
    const current = currentOperation()
    const message = text.trim()
    if (message === "") return "Write a message before sending it."
    /*
     * say's line carries no repository — the text is the rest of the line and
     * must survive intact — so the repo comes off the session's card or the
     * active target. When neither knows it, the honest remedy is the view
     * door, which takes the repo and records it on the card.
     */
    const target = resolveSessionRepo(sessionId, undefined)
    if ("error" in target) {
      return `Smithers doesn't know which repository agent session ${sessionId} is on — view it first with /agent.session.view ${sessionId} <owner/repo>.`
    }
    const repo = target.repo
    detachStream(sessionId)
    /* The follow-up keeps the session's provider; only the card remembers it (the wire carries it per message, never on the DTO). */
    const prior = ctx.store.collections.cards.get(cardIdOf(sessionId))
    const provider = prior?.kind === "agent" && "cloud" in prior.payload ? (prior.payload.provider ?? undefined) : undefined
    const posted = await postMessage(repo, sessionId, message, provider)
    if (!current()) return SIGN_OUT_REFUSAL
    if (typeof posted === "string") {
      await failOnCard(sessionId, posted)
      if (!current()) return SIGN_OUT_REFUSAL
      attachStream(repo, sessionId)
      return posted
    }
    const existing = ctx.store.collections.cards.get(cardIdOf(sessionId))
    if (existing?.kind === "agent" && "cloud" in existing.payload) {
      const payload = existing.payload
      await ctx.dispatch({
        type: "card.upsert",
        actor: ctx.actor(),
        card: { ...existing, payload: { ...payload, transcript: [...appendRow(payload.transcript, rowOf(posted))] } }
      }).isPersisted.promise
      if (!current()) return SIGN_OUT_REFUSAL
    }
    /* The message dispatches the session's next run: the card streams again from here. */
    attachStream(repo, sessionId)
    return {
      value: `Message posted to agent session ${sessionId}${provider === undefined ? " (plue's default provider)" : ` (${provider})`} — its run dispatches on it; the card streams the answer.`
    }
  }

  const stopSession: AgentSessionSeam["stopSession"] = async (sessionId, repoArg) => {
    if (shared.disposed) return SIGN_OUT_REFUSAL
    const refusal = gate()
    if (refusal !== undefined) return refusal
    const current = currentOperation()
    const target = resolveSessionRepo(sessionId, repoArg)
    if ("error" in target) return target.error
    const repo = target.repo
    detachStream(sessionId)
    const prior = ctx.store.collections.cards.get(cardIdOf(sessionId))
    const priorState = prior?.kind === "agent" && "cloud" in prior.payload ? prior.payload.state : undefined
    const answer = await sendJson("DELETE", sessionsPath(repo, `/${encodeURIComponent(sessionId)}`))
    if (!current()) return SIGN_OUT_REFUSAL
    if ("error" in answer) {
      await failOnCard(sessionId, answer.error)
      if (!current()) return SIGN_OUT_REFUSAL
      if (priorState !== undefined && !AGENT_SESSION_TERMINAL.has(priorState)) attachStream(repo, sessionId)
      return answer.error
    }
    detachStream(sessionId)
    const updates: Array<Promise<unknown>> = [updateListedSession(repo, sessionId, null)]
    /*
     * The row is tombstoned upstream (services.AgentService.DeleteSession: an
     * active run is cancelled and finalized first). The card stays as the
     * transcript's record: a session that was active wears plue's own
     * terminal word; one already terminal keeps the word it earned — deleting
     * the record changes neither.
     */
    const latest = ctx.store.collections.cards.get(cardIdOf(sessionId))
    if (latest?.kind === "agent" && "cloud" in latest.payload) {
      const payload = latest.payload
      updates.push(ctx.dispatch({
        type: "card.upsert",
        actor: ctx.actor(),
        card: {
          ...latest,
          payload: {
            ...payload,
            state: AGENT_SESSION_TERMINAL.has(payload.state) ? payload.state : "cancelled"
          }
        }
      }).isPersisted.promise)
    }
    await Promise.all(updates)
    if (!current()) return SIGN_OUT_REFUSAL
    return {
      value: priorState !== undefined && AGENT_SESSION_TERMINAL.has(priorState)
        ? `Agent session ${sessionId} was already ${priorState} — its record is deleted.`
        : `Agent session ${sessionId} stopped.`
    }
  }

  /*
   * The honest refusals the backend's own answers earn. A 403 off this family
   * is plue's agents feature gate (the router's gateAgents answers "feature
   * not available") or its ownership check; a 404 is a session or repository
   * the platform does not have. The sentence names the meaning; the server's
   * own words ride along verbatim.
   */
  const featureRefusal = (failure: { readonly error: string; readonly status: number | null }, repo: string, sessionId?: string): string =>
    failure.status === 403
      ? `Agent sessions are not enabled here — the backend answered 403: ${failure.error}`
      : failure.status === 404 && sessionId !== undefined
      ? `Agent session ${sessionId} on ${repo}: ${failure.error}.`
      : failure.error

  return {
    newSession,
    listSessions,
    viewSession,
    sayToSession,
    stopSession,
    dispose: () => {
      if (shared.disposed) return
      shared.disposed = true
      shared.generation += 1
      for (const subscription of shared.subscriptions) subscription.unsubscribe()
      for (const controller of shared.streams.values()) controller.abort()
      shared.streams.clear()
    }
  }
}
