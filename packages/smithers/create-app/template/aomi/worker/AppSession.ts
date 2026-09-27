/**
 * One chat session, as a Durable Object.
 *
 * A session is the app's whole persistent state: the transcript, the cards the
 * agent painted, and the flows it promoted with `flows/write-flow`. All three
 * live in this object's SQLite storage, keyed by nothing. The object *is* the
 * key, so a row here can never belong to another session.
 *
 * The same class also plays a second role. A Durable Object namespace cannot
 * be enumerated, so one well-known object (`registry.ts`, `INDEX_SESSION`)
 * holds the session list `GET /api/session` answers, and every other object
 * writes its own row there as a turn starts and settles. Only the `sessions`
 * table is used in that role; only the other three are used in the session
 * role.
 *
 * The engine journal is deliberately NOT here. A turn is one request and runs
 * on the in-memory flow engine (`@smthrs/create-app/worker`); this object
 * persists the app's own state instead. A turn cut off by eviction is not
 * resumed; the next turn starts fresh.
 */
import { DurableObject } from "cloudflare:workers"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import type { FlowRunCard } from "@smthrs/create-app/ui"
import {
  AppCard,
  type CancelResponse,
  type FlowRunRequest,
  type FlowRunResponse,
  type FlowSummary,
  type Message,
  type SessionState,
  type SessionSummary,
  type TurnRequest
} from "../src/api.ts"
import type { Env } from "./env.ts"
import type { HostSeams, SessionFlows } from "./host.ts"
import { INDEX_SESSION, indexSession, titleFrom } from "./registry.ts"
import { track } from "./stream.ts"
import { runTurn } from "./turn.ts"

// The tool services this object backs — `FlowStore`, `CardSink`, `CellHistory`
// — are declared once, in `../tools/promote.ts` and `../tools/ui.ts`. This file
// used to restate their shapes because those modules did not exist yet.

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS messages (
     id TEXT PRIMARY KEY,
     role TEXT NOT NULL,
     text TEXT NOT NULL,
     at INTEGER NOT NULL,
     seq INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS cards (
     id TEXT PRIMARY KEY,
     json TEXT NOT NULL,
     at INTEGER NOT NULL,
     seq INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS flows (
     id TEXT PRIMARY KEY,
     description TEXT NOT NULL,
     files_json TEXT NOT NULL,
     at INTEGER NOT NULL
   )`,
  // Only the registry object has rows here; see the class comment.
  `CREATE TABLE IF NOT EXISTS sessions (
     id TEXT PRIMARY KEY,
     title TEXT NOT NULL,
     status TEXT NOT NULL,
     stage TEXT NOT NULL,
     at INTEGER NOT NULL
   )`,
  // Both registry statements read this table newest-first. Without the index
  // each one sorted every row the deployment ever wrote.
  `CREATE INDEX IF NOT EXISTS sessions_at ON sessions(at)`
] as const

/**
 * How much of the registry the Recent column reads, and how much it keeps.
 *
 * The table holds one row per session that ever started a turn across the whole
 * deployment, and nothing deleted them: an unbounded read grew with the age of
 * the deployment on a path the shell hits on every page load. The column shows
 * a page, so the read takes a page, and a write drops whatever falls past the
 * history the column can page through.
 */
const RECENT_LIMIT = 100
const RECENT_RETENTION = 1000

type MessageRow = {
  readonly id: string
  readonly role: string
  readonly text: string
  readonly at: number
}

type CardRow = {
  readonly id: string
  readonly json: string
  readonly at: number
}

type FlowRow = {
  readonly id: string
  readonly description: string
  readonly files_json: string
  readonly at: number
}

type SessionRow = {
  readonly id: string
  readonly title: string
  readonly status: string
  readonly stage: string
  readonly at: number
}

const isStatus = (value: string): value is SessionSummary["status"] =>
  value === "ready" || value === "running" || value === "failed" || value === "idle"

const isRole = (value: string): value is Message["role"] =>
  value === "user" || value === "assistant" || value === "system"

/**
 * One persisted card row, decoded from the JSON a past deploy wrote.
 *
 * A row can hold a shape this build's `AppCard` union no longer admits — a
 * `flow-run` phase that left the union, say — or JSON that was truncated. The
 * read used to be `JSON.parse(row.json) as AppCard`, so one such row threw or
 * failed the shell's `Schema.decodeUnknownSync(SessionState)` and made the
 * whole session unreachable until someone deleted the row by hand. Decoding a
 * row at a time keeps that row's problem to that row.
 */
const decodeCard = Schema.decodeUnknownOption(Schema.fromJsonString(AppCard))

// ---------------------------------------------------------------------------
// The object
// ---------------------------------------------------------------------------

export class AppSession extends DurableObject<Env> {
  /**
   * True while a turn is streaming. Transient on purpose: an eviction ends
   * every stream this object was serving, so a `busy` that survived it would
   * be a lie the next reader could not clear.
   */
  private busy = false

  /**
   * Cancellation, one controller per turn or flow run in flight.
   *
   * workerd forbids one request touching another request's I/O, so `cancel`
   * does not reach into the turn's `fetch`. It aborts a controller the work
   * itself is watching, and the work checks `signal.aborted` between frames.
   * That is the same shape the flows canary settled on for its own server-side
   * turn kill.
   *
   * The set is not keyed by session id: this object is one session, so every
   * controller in it belongs to the session `cancel` names.
   */
  private readonly cancels = new Set<AbortController>()

  /**
   * The id of the flow this session last ran, which is the `stage` the Recent
   * column shows. Transient: it is only read while work this object started is
   * still in flight.
   */
  private stage = ""

  /**
   * The registry stub, made once and reused.
   *
   * Cloudflare orders calls only within one stub. A fresh stub per status
   * change let the `running` this object sent at turn start arrive after the
   * `ready` it sent at settle milliseconds later, leaving the Recent column
   * spinning on a turn that had finished. One stub keeps this object's writes
   * in the order it made them; {@link recordSession} covers the rest.
   */
  private registryStub: ReturnType<typeof indexSession> | undefined

  /**
   * What a Node test replaces in the run host: the QuickJS build, the seat,
   * the judge, the chain. The Worker never sets it, so a deployed turn runs on
   * the workerd build, the provider keys, and the configured fork.
   */
  seams: HostSeams | undefined

  /** The session half `flows/write-flow` writes through. */
  private flowStore(): SessionFlows {
    return {
      writeFlow: (id, description, files) => this.writeFlow(id, description, files),
      listFlows: () => this.listFlows()
    }
  }

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    ctx.storage.transactionSync(() => {
      for (const statement of SCHEMA) ctx.storage.sql.exec(statement)
      this.migrateTranscript()
    })
  }

  private get sql(): SqlStorage {
    return this.ctx.storage.sql
  }

  // -- transcript ----------------------------------------------------------

  /**
   * Old tables have no shared clock. Recover timestamp order once, breaking
   * ties by table-local insertion order, then kind (cards before messages).
   * Exact cross-table order for old timestamp ties cannot be recovered.
   */
  private migrateTranscript(): void {
    let migrate = false
    for (const table of ["messages", "cards"] as const) {
      const columns = this.sql.exec<{ name: string }>(`PRAGMA table_info(${table})`).toArray()
      if (columns.some((column) => column.name === "seq")) continue
      this.sql.exec(`ALTER TABLE ${table} ADD COLUMN seq INTEGER`)
      migrate = true
    }
    if (!migrate) return
    const rows = this.sql.exec<{ kind: string; id: string }>(`
      SELECT 'message' AS kind, id, at, rowid AS position FROM messages
      UNION ALL
      SELECT 'card' AS kind, id, at, rowid AS position FROM cards
      ORDER BY at ASC, position ASC, kind ASC
    `).toArray()
    for (const [index, row] of rows.entries()) {
      const table = row.kind === "message" ? "messages" : "cards"
      this.sql.exec(`UPDATE ${table} SET seq = ? WHERE id = ?`, index + 1, row.id)
    }
  }

  /** Synchronous writes share one sequence even within a millisecond. */
  private nextSequence(): number {
    return this.sql.exec<{ seq: number }>(`
      SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM (
        SELECT seq FROM messages UNION ALL SELECT seq FROM cards
      )
    `).toArray()[0]!.seq
  }

  /** Appends one transcript row and returns it. */
  appendMessage(role: Message["role"], text: string): Message {
    const message: Message = { id: crypto.randomUUID(), role, text, at: Date.now() }
    this.sql.exec(
      "INSERT INTO messages (id, role, text, at, seq) VALUES (?, ?, ?, ?, ?)",
      message.id,
      message.role,
      message.text,
      message.at,
      this.nextSequence()
    )
    return message
  }

  /** Persists a card, replacing any earlier version with the same id. */
  appendCard(card: AppCard): void {
    this.sql.exec(
      `INSERT INTO cards (id, json, at, seq) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET json = excluded.json`,
      card.id,
      JSON.stringify(card),
      Date.now(),
      this.nextSequence()
    )
  }

  private messages(): Array<Message> {
    return this.sql
      .exec<MessageRow>("SELECT id, role, text, at FROM messages ORDER BY seq ASC")
      .toArray()
      .flatMap((row) => (isRole(row.role) ? [{ id: row.id, role: row.role, text: row.text, at: row.at }] : []))
  }

  private cards(): Array<AppCard> {
    return this.sql
      .exec<CardRow>("SELECT id, json, at FROM cards ORDER BY seq ASC")
      .toArray()
      .flatMap((row) => {
        const card = decodeCard(row.json)
        if (Option.isNone(card)) {
          console.warn(`aomi: dropping card ${row.id}; its stored JSON does not decode as an AppCard`)
          return []
        }
        return [card.value]
      })
  }

  // -- API -----------------------------------------------------------------

  /** `GET /api/session?id=` — everything the shell needs to redraw. */
  state(id: string): SessionState {
    const messages = this.messages()
    const cards = this.cards()
    // A row either side dropped has no entry: an entry naming a card the
    // response does not carry is a gap the shell cannot render.
    const messageIds = new Set(messages.map((message) => message.id))
    const cardIds = new Set(cards.map((card) => card.id))
    const entries = this.sql.exec<{ kind: string; id: string }>(`
      SELECT 'message' AS kind, id, seq FROM messages WHERE role IN ('user', 'assistant', 'system')
      UNION ALL
      SELECT 'card' AS kind, id, seq FROM cards
      ORDER BY seq ASC
    `).toArray().flatMap((row) =>
      row.kind === "message"
        ? (messageIds.has(row.id) ? [{ kind: "message" as const, messageId: row.id }] : [])
        : (cardIds.has(row.id) ? [{ kind: "card" as const, cardId: row.id }] : [])
    )
    return { id, messages, cards, entries, busy: this.busy }
  }

  /**
   * `POST /api/agent/turn` — one turn, streamed as NDJSON.
   *
   * A second turn on a busy session is refused rather than queued: two turns
   * writing one transcript is a race the shell has no way to render. A turn the
   * host cannot run (a missing seat key or fork endpoint) is
   * refused with a typed JSON body before the session is marked running.
   */
  async turn(request: TurnRequest): Promise<Response> {
    if (this.busy) {
      return Response.json(
        { error: "A turn is already streaming for this session." },
        { status: 409 }
      )
    }
    // Held across the lazy load, so a second request cannot start a turn while
    // this one is still being built.
    this.busy = true
    const controller = new AbortController()
    this.cancels.add(controller)
    const release = (): void => {
      this.busy = false
      this.cancels.delete(controller)
    }

    let body: Awaited<ReturnType<typeof runTurn>>
    try {
      body = await runTurn({
        env: this.env,
        session: {
          ...this.flowStore(),
          appendMessage: (role, text) => this.appendMessage(role, text),
          appendCard: (card) => this.appendCard(card),
          settle: (status) => this.register(request.sessionId, request.message, status)
        },
        seams: this.seams,
        request,
        signal: controller.signal
      })
    } catch (cause) {
      release()
      return Response.json(
        { error: cause instanceof Error ? cause.message : String(cause) },
        { status: 500 }
      )
    }
    if (!(body instanceof ReadableStream)) {
      release()
      const { status, error, message } = body
      return Response.json({ error: message, code: error }, { status })
    }
    this.stage = request.flowId
    this.register(request.sessionId, request.message, "running")

    // The flag and the controller belong to this stream, so they are cleared
    // where the stream ends rather than where the request returns. `track` runs
    // that cleanup on all three endings; a `TransformStream`'s `flush` ran on
    // only one of them, so a cancelled readable side or a failed source left
    // `busy` true and every later turn answered 409. A hangup also aborts the
    // controller, which is the signal the turn itself watches.
    const tracked = track(body, {
      onSettle: release,
      onCancel: (reason) => controller.abort(reason)
    })

    return new Response(tracked, {
      headers: {
        "content-type": "application/x-ndjson; charset=utf-8",
        "cache-control": "no-store",
        // Frames must reach the shell as they are written, not when a proxy
        // decides the body is big enough.
        "x-content-type-options": "nosniff"
      }
    })
  }

  /**
   * `POST /api/agent/turn/cancel` — asks everything in flight to stop.
   *
   * `cancelled` reports whether there was anything to abort, so a shell that
   * pressed Esc after the turn already ended learns that rather than assuming
   * it killed a live turn.
   */
  cancel(sessionId: string): CancelResponse {
    const controllers = [...this.cancels]
    this.cancels.clear()
    for (const controller of controllers) controller.abort()
    if (controllers.length === 0) return { cancelled: false }
    this.register(sessionId, "", "idle")
    return { cancelled: true }
  }

  // -- flows ---------------------------------------------------------------

  /** The flows this session saved, newest first. File flows come from the router. */
  listFlows(): Array<FlowSummary> {
    return this.sql
      .exec<FlowRow>("SELECT id, description, files_json, at FROM flows ORDER BY at DESC")
      .toArray()
      .map((row) => ({
        id: row.id,
        description: row.description,
        source: "saved" as const,
        chat: false
      }))
  }

  /** The `FlowStore.write` half: `flows/write-flow` lands here. */
  writeFlow(id: string, description: string, files: Record<string, string>): { readonly files: Array<string> } {
    const names = Object.keys(files).sort()
    this.sql.exec(
      "INSERT OR REPLACE INTO flows (id, description, files_json, at) VALUES (?, ?, ?, ?)",
      id,
      description,
      JSON.stringify(files),
      Date.now()
    )
    return { files: names }
  }

  /** The source of a saved flow, or `undefined` when this session never saved it. */
  flowFiles(id: string): Record<string, string> | undefined {
    const rows = this.sql
      .exec<FlowRow>("SELECT id, description, files_json, at FROM flows WHERE id = ?", id)
      .toArray()
    const row = rows[0]
    return row === undefined ? undefined : (JSON.parse(row.files_json) as Record<string, string>)
  }

  /**
   * `POST /api/flows/run` — starts one pipeline flow and reports its id.
   *
   * The response carries the execution id and nothing else. The run itself
   * outlives the request: it writes a `flow-run` card immediately, keeps
   * replacing that card as steps settle, and the shell reads the latest
   * version through `GET /api/session?id=`. `ctx.waitUntil` is what keeps the
   * object alive for the writes that land after the response was sent.
   *
   * The router has already refused an unrouted flow and a chat flow
   * (`worker/router.ts`, `flowRefusal`); a direct object call that bypasses
   * it gets the same refusal as a `failed` card.
   */
  runFlow(request: FlowRunRequest): FlowRunResponse {
    const executionId = crypto.randomUUID()
    this.appendCard({
      kind: "flow-run",
      id: executionId,
      flowId: request.flowId,
      executionId,
      phase: "running",
      steps: []
    })
    this.stage = request.flowId
    this.register(request.sessionId, request.flowId, "running")
    const controller = new AbortController()
    this.cancels.add(controller)
    this.ctx.waitUntil(this.driveFlow(request, executionId, controller))
    return { executionId }
  }

  /** The half of {@link runFlow} that outlives the response. */
  private async driveFlow(
    request: FlowRunRequest,
    executionId: string,
    controller: AbortController
  ): Promise<void> {
    let phase: FlowRunCard["phase"] = "failed"
    try {
      // Lazy for the reason `turn.ts` is lazy: the flow runtime performs I/O
      // as it loads, and a Worker may not do that in module scope.
      const { runFlowRun } = await import("./flowRunImpl.ts")
      phase = await runFlowRun({
        env: this.env,
        session: this.flowStore(),
        seams: this.seams,
        request,
        executionId,
        signal: controller.signal,
        emit: (frame) => {
          if (frame.type === "card" || frame.type === "card.update") this.appendCard(frame.card)
        }
      })
    } catch (cause) {
      // A run that threw still has to leave a settled card behind: a card left
      // on `running` is a spinner the shell has no way to end.
      this.appendCard({
        kind: "flow-run",
        id: executionId,
        flowId: request.flowId,
        executionId,
        phase: "failed",
        steps: [{ name: request.flowId, status: "failed" }],
        error: cause instanceof Error ? cause.message : String(cause)
      })
    } finally {
      this.cancels.delete(controller)
      this.register(request.sessionId, request.flowId, phaseStatus(phase))
    }
  }

  // -- the registry role ---------------------------------------------------

  /**
   * Writes this session's row into the registry object.
   *
   * Fire and forget through `ctx.waitUntil`: the Recent column being one turn
   * stale is a cosmetic loss, and making a turn wait on a second object before
   * its first frame is not. `fallbackTitle` is used only until the session has
   * a user message of its own.
   */
  private register(sessionId: string, fallbackTitle: string, status: SessionSummary["status"]): void {
    if (sessionId === INDEX_SESSION) return
    const summary: SessionSummary = {
      id: sessionId,
      title: this.title(fallbackTitle),
      status,
      stage: this.stage,
      at: Date.now()
    }
    this.registryStub ??= indexSession(this.env)
    this.ctx.waitUntil(this.registryStub.recordSession(summary))
  }

  /** The session's first user message, which is what the Recent column shows. */
  private title(fallback: string): string {
    const rows = this.sql
      .exec<{ text: string }>("SELECT text FROM messages WHERE role = 'user' ORDER BY seq ASC LIMIT 1")
      .toArray()
    return titleFrom(rows[0]?.text ?? fallback)
  }

  /**
   * Registry role: records one session's row.
   *
   * The title is written once. A session's first user message names it, and a
   * later turn must not rename a row the user is reading, so the upsert leaves
   * `title` out of what it updates.
   *
   * The last writer by `at` wins. A turn reports `running` at start and
   * `ready`, `failed` or `idle` at settle, `cancel` reports `idle`, and each
   * arrives here as its own call: an unconditional replace let a slow `running`
   * land after the settle it preceded and strand the row. The guard makes the
   * row the newest report about the session rather than the last one delivered.
   *
   * The delete is the table's retention rule; see {@link RECENT_RETENTION}.
   */
  recordSession(summary: SessionSummary): void {
    this.sql.exec(
      `INSERT INTO sessions (id, title, status, stage, at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET status = excluded.status, stage = excluded.stage, at = excluded.at
       WHERE excluded.at >= sessions.at`,
      summary.id,
      summary.title,
      summary.status,
      summary.stage,
      summary.at
    )
    this.sql.exec(
      "DELETE FROM sessions WHERE id IN (SELECT id FROM sessions ORDER BY at DESC LIMIT -1 OFFSET ?)",
      RECENT_RETENTION
    )
  }

  /**
   * Registry role: `GET /api/session` with no id.
   *
   * A row is what its session last reported. An object evicted mid-turn never
   * reports the settle, so a `running` row can outlive its turn; the shell
   * learns the truth from `GET /api/session?id=`, which reads the session
   * object itself.
   *
   * One page, newest first, ordered by the `sessions_at` index. The whole list
   * used to come back and then be sorted a second time in JavaScript.
   */
  sessions(): ReadonlyArray<SessionSummary> {
    return this.sql
      .exec<SessionRow>(
        "SELECT id, title, status, stage, at FROM sessions ORDER BY at DESC LIMIT ?",
        RECENT_LIMIT
      )
      .toArray()
      .flatMap((row) =>
        isStatus(row.status)
          ? [{ id: row.id, title: row.title, status: row.status, stage: row.stage, at: row.at }]
          : []
      )
  }
}

/** What a settled run means for the session's row in the Recent column. */
const phaseStatus = (phase: FlowRunCard["phase"]): SessionSummary["status"] => {
  switch (phase) {
    case "completed":
      return "ready"
    case "failed":
      return "failed"
    case "cancelled":
      return "idle"
    default:
      return "running"
  }
}
