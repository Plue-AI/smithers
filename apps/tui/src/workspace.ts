import * as Log from "./log.ts"
/** Background work outlives a chat turn. Each tab has its own durable transcript. */
import * as QuotaPolicy from "@smthrs/agent/QuotaPolicy"
import * as Seat from "@smthrs/agent/Seat"
import * as FailureCopy from "@smthrs/model/FailureCopy"
import * as Agents from "./agents.ts"
import type * as Context from "./context.ts"
import type * as Extension from "./extension.ts"
import type * as Host from "./host.ts"
import * as Lifecycle from "./lifecycle.ts"
import { type DelegateModel, delegateModels } from "./models.ts"
import * as Panels from "./panels.ts"
import * as Session from "./session.ts"
import * as Steering from "./steering.ts"
import * as Summary from "./summary.ts"
import * as Transcript from "./transcript.ts"
import * as Tree from "./tree.ts"

export interface Tab {
  readonly id: string
  readonly parent?: string
  readonly depth: number
  readonly title: string
  readonly description?: string
  readonly prompt: string
  readonly seat: string
  /** Seat currently answering; `seat` remains the original resume choice. */
  readonly activeSeat?: string
  readonly file: string
  readonly status: "queued" | "requested" | "running" | "waiting" | "parked" | "done" | "failed" | "cancelled"
  readonly wakeAt?: number
  /** Capacity parks since the last settled model answer; at `QuotaPolicy.defaultMaxParks` the next refusal fails the tab. */
  readonly parks?: number
  readonly failure?: FailureCopy.Description
  readonly detail?: string
  /** When the request was made; a queued tab waits before it launches. */
  readonly startedAt: number
  /** When the worker began, after any wait for a seat. */
  readonly launchedAt?: number
  readonly endedAt?: number
  readonly message?: string
  readonly answer?: string
  /** The delegate model asked for; retry keeps it. */
  readonly model?: DelegateModel
  /** The custom agent this tab runs; `digest` is recorded once its body is read. */
  readonly agent?: { readonly name: string; readonly digest?: string }
  /** A typed agent failure. */
  readonly code?: Agents.Code
  /** Conversation captured with the request so a queued launch survives restart. */
  readonly history?: ReadonlyArray<Context.Entry>
}
export interface Request {
  readonly id: string
  readonly title: string
  readonly prompt: string
  readonly model?: DelegateModel | undefined
  /** A custom agent: a markdown flow's name. */
  readonly agent?: string | undefined
  /** Who asked; only a person may start a `disable-model-invocation` agent. Default `agent`. */
  readonly by?: "user" | "agent"
}
export interface Snapshot {
  readonly tabs: ReadonlyArray<Tab>
  readonly panels: ReadonlyArray<Panels.Panel>
  /** Ids of panels placed as transcript cards; the rest are `ui:<id>` tabs. */
  readonly cards?: ReadonlyArray<string>
}
/** Settled tabs whose answer every coordinator turn carries, and how much of each. */
const contextAnswers = 5
const contextAnswerChars = 1500
/** Concurrent worker seats; later requests wait FIFO in `queued`. */
export const seats = Math.max(1, Number.parseInt(process.env.SMITHERS_TUI_WORKERS ?? "6", 10) || 6)
const active = (tab: Tab): boolean => tab.status === "running" || tab.status === "requested"
const settled = (tab: Tab): boolean => Lifecycle.settled(tab.status)
/** What a queued tab carries until it gets a seat: its launch, or a parked run's continuation. */
interface Entry {
  readonly writer?: Session.Writer
  readonly history?: ReadonlyArray<Context.Entry>
  readonly by?: "user" | "agent"
  readonly resume?: () => void
}
/** Refusal returned by agent.delegate at the maximum supported depth. */
export class AgentDepthExceeded extends Error {
  readonly _tag = "AgentDepthExceeded"
  readonly code = "depth_exceeded"
  constructor() {
    super("Maximum delegation depth is 3")
  }
}
const resetAt = (error: unknown): number | undefined => {
  let current = error
  const seen = new Set<unknown>()
  while (typeof current === "object" && current !== null && !seen.has(current)) {
    seen.add(current)
    const value = current as { resetAtEpochMillis?: unknown; cause?: unknown }
    if (typeof value.resetAtEpochMillis === "number") return value.resetAtEpochMillis
    current = value.cause
  }
  return undefined
}
export class Workspace {
  private tabs: Lifecycle.Pool<Tab, Entry>
  private panels = new Map<string, Panels.Panel>()
  private cards = new Set<string>()
  private transcripts = new Map<string, Transcript.Transcript>()
  private handles = new Map<string, Host.Turn>()
  private cancelRequested = new Set<string>()
  private steering = new Map<string, { readonly queue: Steering.Queue; readonly writer: Session.Writer }>()
  private closed = false
  constructor(
    private options: {
      /** Ids owned by flow runs in the same session. */
      occupied?: (id: string) => boolean
      host: Host.Host
      workerSeat: string
      history: () => ReadonlyArray<Context.Entry>
      persist: (record: Session.Record) => void
      restored?: Snapshot
      /** Custom agents; absent where flows cannot be listed. */
      agents?: Agents.Port
      /** Resolves an agent's declared `model:`; undefined when unknown. */
      seatOf?: (declared: string) => string | undefined
      /** Delegate models a request may name; absent, any. */
      delegable?: ReadonlyArray<DelegateModel>
      /** A worker's status item or key, owned `runtime:<tab id>`; throws a one-line refusal. */
      contribute?: (owner: string, contribution: Extension.Contribution) => void
    }
  ) {
    this.tabs = new Lifecycle.Pool<Tab, Entry>({
      name: "worker",
      seats,
      holdsSeat: active,
      persist: (tab) => options.persist({ type: "tab", tab }),
      admit: (tab, next) => {
        if (next.resume !== undefined) {
          this.tabs.move(tab, "wake")
          next.resume()
          return
        }
        if (next.writer === undefined || tab.file !== next.writer.file) return
        const requested = this.tabs.move(tab, "admit")!
        queueMicrotask(() => this.start(requested, next.writer!, next.history ?? [], next.by ?? "user"))
      }
    })
    for (const saved of options.restored?.tabs ?? []) {
      // Older sessions predate recursive tabs.
      const tab = { ...saved, depth: saved.depth ?? (saved.id.split("/").length - 1) }
      let records: ReadonlyArray<Session.Record> = []
      let transcript: Transcript.Transcript | undefined
      try {
        records = Session.load(tab.file)
        transcript = Session.restore(
          records.filter((record) => record.type !== "event" || record.event._tag !== "aborted").map((record) =>
            record.type === "outcome" && record.outcome._tag === "failed" && record.outcome.headline === undefined
              ? {
                ...record,
                outcome: {
                  ...record.outcome,
                  headline: FailureCopy.describe(record.outcome.message, tab.activeSeat ?? tab.seat).headline
                }
              }
              : record
          )
        ).transcript
      } catch { /* A persisted request can precede creation of its worker file. */ }
      let settled = tab
      if (
        tab.status === "running" || tab.status === "requested" || tab.status === "waiting" || tab.status === "parked"
      ) {
        // Prefer the worker's own receipt if the process exited before the parent saved it.
        const header = records[0]
        const boundary = header?.type === "session" && header.parent !== undefined &&
            records.some((record) =>
              record.type === "outcome" && record.at < header.createdAt &&
              (record.outcome._tag === "failed" || record.outcome._tag === "cancelled")
            )
          ? header.createdAt :
          undefined
        const receipt = records.filter((record) => record.type === "outcome").findLast((record) =>
          boundary === undefined || record.at >= boundary
        )
        const outcome = receipt?.type === "outcome" ? receipt.outcome : undefined
        settled = receipt === undefined || outcome === undefined
          ? tab
          : outcome._tag === "done"
          ? { ...tab, status: "done", answer: outcome.answer ?? "", endedAt: receipt.at }
          : outcome._tag === "cancelled"
          ? { ...tab, status: "cancelled", endedAt: receipt.at }
          : {
            ...tab,
            status: "failed",
            message: outcome.message ?? "Failed",
            failure: tab.failure ?? FailureCopy.describe(outcome.message, tab.activeSeat ?? tab.seat),
            endedAt: receipt.at
          }
      }
      // A worker whose host died has no outcome in its file; its timeline must not stay live.
      if (transcript !== undefined && settled.status === "failed" && transcript.activity?.status === "running") {
        transcript = Transcript.failure(
          transcript,
          settled.message ?? "Failed",
          settled.endedAt ?? Date.now()
        )
      }
      if (transcript !== undefined) this.transcripts.set(tab.id, transcript)
      if (settled === tab) this.tabs.adopt(tab)
      else {this.tabs.move(
          { ...settled, status: tab.status },
          Lifecycle.ending[settled.status as keyof typeof Lifecycle.ending]
        )}
      if (settled.status === "queued") {
        this.tabs.enqueue(tab.id, { writer: Session.reopen(tab.file), history: tab.history ?? [], by: "user" })
      }
      if (settled === tab && (active(tab) || tab.status === "waiting" || tab.status === "parked")) {
        this.scheduleResume(tab)
      }
    }
    for (const panel of options.restored?.panels ?? []) Panels.keep(this.panels, panel)
    for (const id of options.restored?.cards ?? []) if (this.panels.has(id)) this.cards.add(id)
    queueMicrotask(() => this.tabs.drain())
  }
  subscribe = (listener: () => void): () => void => this.tabs.subscribe(listener)
  private changed() {
    this.tabs.changed()
  }
  has = (id: string): boolean => this.tabs.has(id)
  /** Whether a worker with no chosen model is routed by Jev; a replay drives its own seat. */
  private get routes(): boolean {
    return this.options.host.routes === true && !this.options.workerSeat.startsWith("replay:")
  }
  snapshot = (): Snapshot => ({ tabs: this.tabs.values(), panels: [...this.panels.values()], cards: [...this.cards] })
  get busy(): boolean {
    return this.tabs.values().some((tab) =>
      active(tab) || tab.status === "waiting" || tab.status === "queued" || tab.status === "parked"
    )
  }
  /** Custom views kept; publishing one more replaces the least recently published. */
  static readonly maxPanels = Panels.limit
  /**
   * A tab or a card; tabs and cards share the panel limit. A chat card is
   * persisted as the `card` record its transcript item restores from; a
   * worker's card (`lane`) is drawn from the worker's own file.
   */
  publish = (value: Panels.Panel, placement: "tab" | "card" = "tab", at = Date.now(), lane?: string): Panels.Panel => {
    const panel = Panels.decode(value)
    this.options.persist(
      placement === "card" && lane === undefined
        ? { type: "card", at, panel }
        : { type: "panel", panel, ...(placement === "card" ? { placement } : {}) }
    )
    Panels.keep(this.panels, panel)
    if (placement === "card") this.cards.add(panel.id)
    else this.cards.delete(panel.id)
    for (const id of this.cards) if (!this.panels.has(id)) this.cards.delete(id)
    this.changed()
    return panel
  }
  /** A worker's `ui.publish`: its ids are prefixed `<tab>/` so two tabs never collide. */
  private contribute(
    tab: Tab,
    contribution: Extension.Contribution,
    writer: Session.Writer,
    update: (transcript: Transcript.Transcript) => void
  ) {
    const prefix = (id: string) => `${tab.id}/${id}`
    if (contribution.kind === "panel") {
      const panel = { ...contribution.panel, id: prefix(contribution.panel.id) }
      if (contribution.placement === "tab") return void this.publish(panel)
      const at = Date.now()
      const published = this.publish(panel, "card", at, tab.id)
      writer.append({ type: "card", at, panel: published })
      return update(Transcript.card(this.transcript(tab.id), published, at))
    }
    if (this.options.contribute === undefined) throw new Error("Status items and keys are unavailable here")
    this.options.contribute(
      `runtime:${tab.id}`,
      contribution.kind === "status"
        ? { ...contribution, status: { ...contribution.status, id: prefix(contribution.status.id) } }
        : { ...contribution, key: { ...contribution.key, id: prefix(contribution.key.id) } }
    )
  }
  request = (request: Request): { id: string; status: Tab["status"] } => this.open(request)
  /** Namespaces a child under its parent and refuses delegation beyond depth three. */
  requestChild = (parent: Tab, request: Request): { id: string; status: Tab["status"] } => {
    if (parent.depth >= 3) throw new AgentDepthExceeded()
    return this.open({ ...request, id: `${parent.id}/${request.id}` }, undefined, parent.id, parent.depth + 1)
  }
  /** A worker waits for its own children while its pool slot is available to queued work. */
  wait = (
    parentId: string,
    ids: ReadonlyArray<string>,
    signal?: AbortSignal
  ): Promise<ReadonlyArray<Pick<Tab, "id" | "status" | "answer" | "message">>> => {
    const parent = this.tabs.get(parentId)
    if (parent === undefined) throw new Error("Unknown parent tab")
    const children = ids.map((id) => {
      const child = this.tabs.get(id.startsWith(`${parentId}/`) ? id : `${parentId}/${id}`)
      if (child?.parent !== parentId) throw new Error(`Unknown child tab: ${id}`)
      return child.id
    })
    // Waiting frees the seat, so queued work may start.
    this.tabs.move(parent, "block")
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        unsubscribe()
        signal?.removeEventListener("abort", aborted)
      }
      const aborted = () => {
        cleanup()
        const current = this.tabs.get(parentId)
        if (!this.closed && current?.status === "waiting") this.tabs.move(current, "unblock")
        reject(new Error("Wait stopped"))
      }
      const check = () => {
        const current = this.tabs.get(parentId)
        if (this.closed || current === undefined || settled(current)) {
          cleanup()
          reject(new Error("Parent tab stopped while waiting"))
          return
        }
        const tabs = children.map((id) => this.tabs.get(id)!)
        if (!tabs.every(settled) || this.tabs.full()) return
        cleanup()
        this.tabs.move(this.tabs.get(parentId)!, "unblock")
        resolve(tabs.map(({ id, status, answer, message }) => ({ id, status, answer, message })))
      }
      const unsubscribe = this.subscribe(check)
      signal?.addEventListener("abort", aborted, { once: true })
      if (signal?.aborted) aborted()
      else check()
    })
  }
  /**
   * Persists a request and returns its receipt. `kept` is a resumed or retried
   * tab's own seat; otherwise the seat is the request's model, then the agent's
   * declared `model:`, then `Seat.auto` when the host routes, else the worker seat.
   */
  private open(
    request: Request,
    kept?: string,
    parent?: string,
    depth = 0,
    prior?: Tab,
    parks?: number
  ): { id: string; status: Tab["status"] } {
    if (this.closed) throw new Error("Session closed")
    const existing = this.tabs.get(request.id)
    if (existing !== undefined) {
      const same = existing.prompt === request.prompt && existing.agent?.name === request.agent && (
        existing.agent === undefined && existing.model === undefined
          // A tab saved before `model` was recorded is compared by seat.
          ? request.model === undefined
            ? existing.seat === this.options.workerSeat ||
              (this.routes && !Object.values<string>(delegateModels).includes(existing.seat))
            : existing.seat === delegateModels[request.model]
          : existing.model === request.model
      )
      if (!same) throw new Error("Request id already belongs to another request")
      return { id: existing.id, status: existing.status }
    }
    if (this.options.occupied?.(request.id)) throw new Error("Request id already belongs to a flow run")
    const delegable = this.options.delegable
    if (
      kept === undefined && request.model !== undefined && delegable !== undefined && !delegable.includes(request.model)
    ) {
      throw new Error(
        `Model ${request.model} is not available here; ${
          delegable.length === 0 ? "omit model" : `use ${delegable.join(", ")} or omit model`
        }`
      )
    }
    // Refuses now when the listing is known; otherwise the launch re-lists and fails the tab.
    const listed = request.agent === undefined ? undefined : this.agents().listed()
    const agent = request.agent === undefined || listed === undefined
      ? undefined
      : Agents.find(listed, request.agent, request.by ?? "agent")
    const declared = agent?.seat === undefined ? undefined : this.options.seatOf?.(agent.seat)
    const records = prior === undefined ? [] : this.priorRecords(prior)
    const writer = Session.create(
      this.options.host.cwd,
      "worker",
      prior === undefined ? {} : {
        parent: prior.file,
        seed: records.filter((record) => record.type !== "outcome")
      }
    )
    const history = this.boundedHistory([
      ...this.options.history(),
      ...(prior === undefined ? [] : this.continuation(prior, records, prior.message))
    ])
    // Persist FIRST; a receipt here acknowledges only the request, not the launch.
    const tab = this.tabs.create({
      id: request.id,
      title: request.title,
      prompt: request.prompt,
      ...(parent === undefined ? {} : { parent }),
      depth,
      seat: kept ?? (request.model === undefined ? declared ?? this.unchosen() : delegateModels[request.model]),
      history,
      file: writer.file,
      startedAt: prior?.startedAt ?? Date.now(),
      ...(parks === undefined || parks === 0 ? {} : { parks }),
      ...(request.model === undefined ? {} : { model: request.model }),
      ...(request.agent === undefined ? {} : { agent: { name: request.agent } })
    })
    void this.describe(tab)
    const by = request.by ?? "agent"
    if (tab.status === "queued") this.tabs.enqueue(tab.id, { writer, history, by })
    else queueMicrotask(() => this.start(tab, writer, history, by))
    return { id: tab.id, status: tab.status }
  }
  /** The seat of a worker nobody chose one for. */
  private unchosen(): string {
    return this.routes ? Seat.auto : this.options.workerSeat
  }
  private priorRecords(tab: Tab): ReadonlyArray<Session.Record> {
    try {
      return Session.load(tab.file).filter((record) => record.type !== "session")
    } catch (error) {
      Log.write("worker.history", error)
      return []
    }
  }
  private boundedHistory(entries: ReadonlyArray<Context.Entry>): ReadonlyArray<Context.Entry> {
    const kept: Array<Context.Entry> = []
    let remaining = 24_000
    for (const entry of entries.toReversed()) {
      const value: Context.Entry = entry.kind === "exchange"
        ? { kind: "exchange", user: entry.user.slice(-2_000), answer: entry.answer.slice(-20_000) }
        : entry.kind === "shell"
        ? { kind: "shell", text: entry.text.slice(-4_000) }
        : { kind: "undo", paths: entry.paths.slice(-50) }
      const size = JSON.stringify(value).length
      if (size > remaining) break
      kept.unshift(value)
      remaining -= size
    }
    return kept
  }
  private continuation(
    tab: Tab,
    records: ReadonlyArray<Session.Record>,
    lastError?: string
  ): ReadonlyArray<Context.Entry> {
    const transcript = records.length === 0 ? this.transcript(tab.id) : Session.restore(records).transcript
    const cells = transcript.items.filter((item) => item.kind === "cell")
    const output = cells.map((item) =>
      `Step ${item.index} output: ${item.printed.slice(-4_000)}${
        item.error === undefined ? "" : `\nError: ${item.error.slice(-1_000)}`
      }`
    ).join("\n")
    const sources = cells.slice(-6).map((item) => `Step ${item.index} source: ${item.source.slice(-1_000)}`).join("\n")
    const notes = transcript.items.flatMap((item) =>
      item.kind === "user" ?
        [`User: ${item.text}`] :
        item.kind === "error"
        ? [`Error: ${item.text}`]
        : []
    ).join("\n")
    const truncated = output.length > 12_000 || sources.length > 5_000 || notes.length > 1_000 ||
      cells.length > 6 ||
      cells.some((item) =>
        item.source.length > 1_000 || item.printed.length > 4_000 || (item.error?.length ?? 0) > 1_000
      )
    return [{
      kind: "exchange",
      user: tab.prompt,
      answer: `Continue the same worker task from this prior run. Do not repeat completed steps.\n${
        output.slice(-12_000)
      }\n${sources.slice(-5_000)}\n${notes.slice(-1_000)}${
        lastError === undefined ? "" : `\nLast error: ${lastError.slice(-1_000)}`
      }${truncated ? "\nPrior transcript truncated." : ""}`
    }]
  }
  private relaunch(tab: Tab): void {
    if (this.closed) return
    this.tabs.forget(tab.id)
    this.open(
      { id: tab.id, title: tab.title, prompt: tab.prompt, model: tab.model, agent: tab.agent?.name, by: "user" },
      tab.seat,
      tab.parent,
      tab.depth,
      tab,
      tab.parks
    )
  }
  private scheduleResume(tab: Tab): void {
    const resume = () => {
      if (
        !this.closed && this.tabs.get(tab.id)?.file === tab.file &&
        (this.tabs.get(tab.id)?.status === "parked" || this.tabs.get(tab.id)?.status === "running" ||
          this.tabs.get(tab.id)?.status === "requested" || this.tabs.get(tab.id)?.status === "waiting")
      ) this.relaunch(tab)
    }
    if (tab.status === "parked" && (tab.wakeAt ?? 0) > Date.now()) setTimeout(resume, tab.wakeAt! - Date.now())
    else queueMicrotask(resume)
  }
  /** Launches a requested tab; an agent's body is read first. */
  private start(tab: Tab, writer: Session.Writer, history: ReadonlyArray<Context.Entry>, by: "user" | "agent") {
    if (tab.agent === undefined) this.launch(tab, writer, history)
    else void this.prepare(tab, writer, history, by)
  }
  private agents(): Agents.Port {
    if (this.options.agents === undefined) throw new Agents.AgentError("unknown_agent", "Agents unavailable here")
    return this.options.agents
  }
  /** Reads an agent's body in the background; the request already returned. */
  private async prepare(tab: Tab, writer: Session.Writer, history: ReadonlyArray<Context.Entry>, by: "user" | "agent") {
    const current = () => {
      const now = this.tabs.get(tab.id)
      return !this.closed && now?.status === "requested" && now.file === tab.file ? now : undefined
    }
    if (current() === undefined) return
    let profile: Agents.Profile
    try {
      const { descriptor, body } = await this.agents().load(tab.agent!.name)
      Agents.find([descriptor], descriptor.name, by)
      profile = Agents.profile(descriptor, body, this.options.seatOf ?? (() => undefined))
    } catch (error) {
      const failure = Agents.unreadable(error)
      const now = current()
      if (now !== undefined) {
        this.tabs.move({ ...now, endedAt: Date.now(), message: failure.message, code: failure.code }, "fail")
      }
      return
    }
    const now = current()
    if (now === undefined) return
    const ready: Tab = {
      ...now,
      // A routed tab keeps `auto`, or the seat a retry carries.
      seat: now.model === undefined
        ? profile.seat ?? (this.routes ? now.seat : this.options.workerSeat)
        : delegateModels[now.model],
      agent: { name: profile.name, digest: profile.digest }
    }
    this.tabs.put(ready)
    this.launch(ready, writer, history, profile)
  }
  private async describe(tab: Tab): Promise<void> {
    let description = tab.title.replace(/\s+/g, " ").trim().slice(0, 80)
    // The worker's own seat: the task never goes to a provider the user did not pick for it.
    if (!tab.seat.startsWith("replay:") && tab.seat !== Seat.auto) {
      try {
        const generated = await this.options.host.describe?.({ title: tab.title, prompt: tab.prompt, seat: tab.seat })
        description = generated?.replace(/\s+/g, " ").trim().slice(0, 80) || description
      } catch (error) {
        Log.write("worker.describe", error)
      }
    }
    const current = this.tabs.get(tab.id)
    if (current === undefined || current.file !== tab.file || this.closed) return
    this.tabs.put({ ...current, description })
  }
  private launch(tab: Tab, writer: Session.Writer, history: ReadonlyArray<Context.Entry>, agent?: Agents.Profile) {
    if (this.closed || this.tabs.get(tab.id)?.status !== "requested") return
    const at = Date.now()
    this.transcripts.set(
      tab.id,
      Transcript.user(this.transcripts.get(tab.id) ?? Transcript.empty, tab.prompt, false, at)
    )
    const steering = Steering.make()
    try {
      writer.append({ type: "user", at, text: tab.prompt })
      const handle = this.options.host.run({
        prompt: tab.prompt,
        seat: tab.seat,
        ...(tab.model === undefined && agent?.fallbackSeats !== undefined
          ? { fallbackSeats: agent.fallbackSeats }
          : {}),
        source: tab.id,
        history,
        role: "worker",
        maxParks: Math.max(0, QuotaPolicy.defaultMaxParks - (tab.parks ?? 0)),
        ...(agent === undefined ? {} : { agent }),
        steering: steering.source,
        runtime: {
          publish: (contribution) =>
            this.contribute(tab, contribution, writer, (next) => {
              this.transcripts.set(tab.id, next)
              this.changed()
            }),
          delegate: (request) => this.requestChild(tab, request),
          read: (id) => this.read(id.startsWith(`${tab.id}/`) ? id : `${tab.id}/${id}`),
          list: () => this.snapshot().tabs.filter((child) => child.parent === tab.id),
          wait: (ids, signal) => this.wait(tab.id, ids, signal)
        },
        onSeat: (seat) => {
          const current = this.tabs.get(tab.id)
          // Retry and resume keep it, so the tab is never routed twice.
          if (current?.file === writer.file) this.tabs.put({ ...current, seat })
        },
        onCaption: (prose) => {
          writer.append({ type: "caption", prose })
          this.transcripts.set(tab.id, Transcript.caption(this.transcript(tab.id), prose))
          this.changed()
        },
        onPatch: (receipt) => {
          writer.append({ type: "patch", receipt })
          this.transcripts.set(tab.id, Transcript.patched(this.transcript(tab.id), receipt))
          this.changed()
        },
        onEvent: (event) => {
          if (this.tabs.get(tab.id)?.file !== writer.file) return
          const at = Date.now()
          if (event._tag !== "model-delta" && event._tag !== "aborted") writer.append({ type: "event", at, event })
          if (event._tag !== "aborted") {
            this.transcripts.set(tab.id, Transcript.apply(this.transcript(tab.id), event, at))
          }
          if (event._tag === "seat-failed-over") {
            this.tabs.put({ ...(this.tabs.get(tab.id) ?? tab), activeSeat: event.to })
          }
          if (event._tag === "model-parked") {
            const current = this.tabs.get(tab.id) ?? tab
            this.tabs.move({
              ...current,
              wakeAt: event.wakeAt,
              activeSeat: event.seat,
              parks: (current.parks ?? 0) + 1
            }, "park")
          }
          if (event._tag === "model-settled" && (this.tabs.get(tab.id)?.parks ?? 0) > 0) {
            this.tabs.put({ ...this.tabs.get(tab.id)!, parks: 0 })
          }
          if (event._tag === "model-unparked") {
            const current = this.tabs.get(tab.id) ?? tab
            // With every seat taken it waits FIFO; the run continues when its entry is admitted.
            if (
              this.tabs.move({ ...current, wakeAt: undefined, activeSeat: event.seat }, "wake")?.status === "queued"
            ) {
              return new Promise<void>((resolve) => {
                this.tabs.enqueue(tab.id, { resume: resolve })
                this.tabs.drain()
              })
            }
          }
          this.changed()
        }
      })
      this.handles.set(tab.id, handle)
      this.steering.set(tab.id, { queue: steering, writer })
      this.tabs.move({ ...(this.tabs.get(tab.id) ?? tab), launchedAt: at }, "launch")
      void handle.done.then((outcome) => {
        this.handles.delete(tab.id)
        this.steering.delete(tab.id)
        const requestedCancel = this.cancelRequested.delete(tab.id)
        if (this.closed || this.tabs.get(tab.id)?.file !== writer.file) return
        const current = this.tabs.get(tab.id)
        if (outcome._tag === "cancelled" && current?.status === "parked" && !requestedCancel) {
          this.scheduleResume(current)
          return
        }
        const at = Date.now()
        const described = outcome._tag === "failed"
          ? FailureCopy.describe(outcome.error ?? outcome.message, this.tabs.get(tab.id)?.activeSeat ?? tab.seat)
          : undefined
        const parks = current?.parks ?? 0
        const failure = described?.fault === "wait" && parks >= QuotaPolicy.defaultMaxParks
          ? { ...described, line: `Still limited after ${parks} waits.` }
          : described
        let transcript = this.transcript(tab.id)
        const undelivered = steering.take()
        if (undelivered.length > 0) {
          transcript = Transcript.note(transcript, `Not delivered: ${undelivered.join(" / ")}`, at)
          this.transcripts.set(tab.id, transcript)
        }
        writer.append({
          type: "outcome",
          at,
          prompt: tab.prompt,
          outcome: outcome._tag === "done"
            ? { _tag: "done", answer: outcome.answer }
            : outcome._tag === "failed"
            ? { _tag: "failed", message: outcome.message, headline: failure!.headline }
            : { _tag: "cancelled" }
        })
        if (outcome._tag !== "done") {
          transcript = Transcript.failure(transcript, outcome._tag === "failed" ? failure!.headline : "Stopped", at)
          this.transcripts.set(tab.id, transcript)
        }
        this.tabs.move({
          ...(this.tabs.get(tab.id) ?? tab),
          endedAt: at,
          ...(outcome._tag === "done"
            ? { answer: outcome.answer }
            : outcome._tag === "failed"
            ? { message: outcome.message, detail: outcome.detail, failure, wakeAt: resetAt(outcome.error) }
            : {})
        }, Lifecycle.ending[outcome._tag])
      }).catch((error) => this.fail(tab, writer, error))
    } catch (error) {
      this.fail(tab, writer, error)
    }
  }
  /** Settles the tab, its timeline and its worker file as failed. */
  private fail(tab: Tab, writer: Session.Writer, error: unknown) {
    this.handles.delete(tab.id)
    this.steering.delete(tab.id)
    const at = Date.now()
    const message = String(error)
    const failure = FailureCopy.describe(error, this.tabs.get(tab.id)?.activeSeat ?? tab.seat)
    try {
      writer.append({
        type: "outcome",
        at,
        prompt: tab.prompt,
        outcome: { _tag: "failed", message, headline: failure.headline }
      })
    } catch (error) {
      Log.write("worker.persist", error)
    }
    this.transcripts.set(tab.id, Transcript.failure(this.transcript(tab.id), failure.headline, at))
    this.tabs.move({
      ...(this.tabs.get(tab.id) ?? tab),
      endedAt: at,
      message,
      failure,
      detail: error instanceof Error ? error.stack : undefined
    }, "fail")
  }
  /** Sends `text` to a running worker at its next cell boundary; false when it is not running. */
  steer = (id: string, text: string): boolean => {
    const target = this.steering.get(id)
    if (target === undefined || this.tabs.get(id)?.status !== "running") return false
    const at = Date.now()
    target.queue.steer(text)
    target.writer.append({ type: "user", at, text, steered: true })
    this.transcripts.set(id, Transcript.user(this.transcript(id), text, true, at))
    this.changed()
    return true
  }
  /** Records an undo of a tab's calls in its own file and transcript. */
  undone = (id: string, calls: ReadonlyArray<string>, paths: ReadonlyArray<string>, at: number): void => {
    const tab = this.tabs.get(id)
    if (tab === undefined) throw new Error("Unknown tab")
    Session.reopen(tab.file).append({ type: "undo", at, calls, paths })
    this.transcripts.set(id, Transcript.undone(this.transcript(id), calls, paths, at))
    this.changed()
  }
  /** A worker's own transcript, for the chat timeline to interleave. */
  transcript = (id: string): Transcript.Transcript => this.transcripts.get(id) ?? Transcript.empty
  read = (id: string) => {
    const tab = this.tabs.get(id)
    if (tab === undefined) throw new Error("Unknown tab")
    const panel = this.panel(id)
    return {
      id: tab.id,
      title: tab.title,
      status: tab.status,
      ...(tab.status === "parked" && tab.wakeAt !== undefined ? { wakeAt: new Date(tab.wakeAt).toISOString() } : {}),
      answer: tab.answer?.slice(0, 8000),
      message: tab.message,
      summary: panel.summary,
      turns: panel.rows.slice(-8).map((row) => ({
        label: row.label,
        status: row.status,
        details: row.details.slice(0, 4).map((block) =>
          block.kind === "code"
            ? { ...block, code: block.code.slice(0, 4000) }
            : block.kind === "text"
            ? { ...block, text: block.text.slice(0, 4000) }
            : block.kind === "diff"
            ? { ...block, patch: block.patch.slice(0, 4000) }
            : { ...block, rows: block.rows.slice(0, 10) }
        )
      }))
    }
  }
  panel = (id: string): Panels.Panel => {
    const tab = this.tabs.get(id)
    const panel = Summary.panel(this.transcripts.get(id) ?? Transcript.empty, `tab:${id}`, tab?.title ?? id)
    const summary = (tab?.status === "failed" ? tab.failure?.headline ?? "Worker stopped unexpectedly" : undefined) ??
      (tab?.status === "done"
        ? Summary.sentence(tab.answer ?? panel.summary)
        : tab?.status === "requested"
        ? "Requested."
        : tab?.status === "queued"
        ? "Queued."
        : tab?.status === "parked"
        ? `waits for ${seatProvider(tab.activeSeat ?? tab.seat)} reset · ${
          new Date(tab.wakeAt ?? Date.now()).toLocaleTimeString("en-US", {
            hour: "2-digit",
            minute: "2-digit",
            hour12: false
          })
        }`
        : tab?.status === "cancelled"
        ? "Stopped."
        : panel.summary)
    return { ...panel, summary }
  }
  /** Projects a root and descendants from current tab state. */
  tree = (rootId: string): Panels.Panel => Tree.panel(rootId, this.tabs.values(), (id) => this.transcript(id))
  /**
   * What every coordinator turn is told about the tabs: every unsettled tab,
   * and the newest settled ones with a bounded answer. Older tabs keep only
   * their status; `tab.read` returns any tab in full.
   */
  context = (): string => {
    const settledTabs = this.tabs.values().filter(settled).sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
    const recent = new Set(settledTabs.slice(0, contextAnswers))
    return JSON.stringify(
      this.tabs.values().map((tab) => {
        const full = !settled(tab) || recent.has(tab)
        return {
          id: tab.id,
          title: tab.title,
          ...(tab.agent === undefined ? {} : { agent: tab.agent.name }),
          status: tab.status,
          ...(tab.status === "parked" && tab.wakeAt !== undefined
            ? { wakeAt: new Date(tab.wakeAt).toISOString() }
            : {}),
          ...(full && tab.answer !== undefined ? { answer: tab.answer.slice(0, contextAnswerChars) } : {}),
          ...(full && tab.message !== undefined ? { message: tab.message.slice(0, 500) } : {})
        }
      })
    )
  }
  cancel = (id: string): void => {
    for (const child of this.tabs.values().filter((entry) => entry.parent === id)) this.cancel(child.id)
    const removed = this.tabs.dequeue(id)
    const tab = this.tabs.get(id)
    if (
      tab?.status === "requested" || tab?.status === "queued" || (tab?.status === "parked" && !this.handles.has(id))
    ) {
      this.tabs.move({ ...tab, endedAt: Date.now() }, "cancel")
      this.handles.get(id)?.cancel()
    } else if (this.handles.has(id)) {
      this.cancelRequested.add(id)
      this.handles.get(id)!.cancel()
    }
    removed?.resume?.()
  }
  /** Runs a failed or stopped tab's task again, on the seat it asked for. */
  retry = (id: string, seat?: string): { id: string; status: Tab["status"] } => {
    const tab = this.tabs.get(id)
    if (tab === undefined) throw new Error("Unknown tab")
    if (tab.status !== "failed" && tab.status !== "cancelled" && tab.status !== "parked") {
      throw new Error(`Only a failed or stopped tab can be retried; ${id} is ${tab.status}`)
    }
    if (tab.status === "parked" && this.handles.has(id)) {
      this.cancelRequested.add(id)
      this.handles.get(id)?.cancel()
    }
    this.tabs.forget(id)
    try {
      // Keeps the agent, the model and the seat; the agent's file is read again, so edits apply.
      return this.open(
        { id, title: tab.title, prompt: tab.prompt, model: tab.model, agent: tab.agent?.name, by: "user" },
        seat ?? tab.seat,
        tab.parent,
        tab.depth,
        tab
      )
    } catch (error) {
      this.tabs.adopt(tab)
      throw error
    }
  }
  /** Parks a failed worker until its known reset, then continues the same task. */
  waitForReset = (id: string): void => {
    const tab = this.tabs.get(id)
    if (tab?.status !== "failed") throw new Error("Only a failed tab can wait")
    const wakeAt = Math.max(Date.now(), tab.wakeAt ?? Date.now() + 15 * 60_000)
    // The user chose this wait, so the resumed run gets a fresh park budget.
    const waiting = this.tabs.move({ ...tab, wakeAt, endedAt: undefined, parks: undefined }, "sleep")!
    setTimeout(() => {
      if (this.tabs.get(id)?.status === "parked" && this.tabs.get(id)?.file === tab.file) this.relaunch(waiting)
    }, wakeAt - Date.now())
  }
  dispose = (): void => {
    this.closed = true
    const queued = this.tabs.close()
    this.changed()
    for (const tab of this.tabs.values()) {
      if (tab.status === "queued") this.tabs.move({ ...tab, endedAt: Date.now() }, "cancel")
      this.handles.get(tab.id)?.cancel()
    }
    for (const entry of queued) entry.resume?.()
  }
}
/** A tab's toast text after its glyph. */
const seatProvider = (seat: string): string =>
  seat.startsWith("openai:") ?
    "ChatGPT" :
    seat.startsWith("anthropic:")
    ? "Anthropic"
    : seat.split(":")[0] ?? "model"

export const tabToast = (tab: Tab): string =>
  `${tab.agent === undefined ? tab.title : `${tab.agent.name}: ${tab.title}`} · ${
    tab.status === "failed" ?
      tab.failure?.headline ?? tab.message?.split("\n")[0]!.slice(0, 80) ?? "Worker stopped unexpectedly" :
      tab.status === "parked"
      ? `waits for ${seatProvider(tab.activeSeat ?? tab.seat)} reset · ${
        new Date(tab.wakeAt ?? Date.now()).toLocaleTimeString("en-US", {
          hour: "2-digit",
          minute: "2-digit",
          hour12: false
        })
      }`
      : tab.status
  }`

/** The failure card's single progress and file-impact line. */
export const failureLine = (tab: Tab, transcript: Transcript.Transcript): string => {
  const steps = transcript.items.filter((item) => item.kind === "cell" && item.status !== "writing").length
  const changed = transcript.items.some((item) =>
    item.kind === "cell" && item.calls.some((call) => (call.patches?.length ?? 0) > 0 && call.undone !== true)
  )
  const prefix = tab.failure?.line ?? "The worker stopped before finishing."
  return `${prefix} ${steps} of ~40 steps done. ${changed ? "Files changed." : "No files changed."}`
}
