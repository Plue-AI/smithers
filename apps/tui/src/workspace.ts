import * as SmithersPlugin from "@smthrs/agent/SmithersPlugin"
import * as Fault from "@smthrs/flow/Fault"
import { Data } from "effect"
import { randomUUID } from "node:crypto"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import * as Log from "./log.ts"
/** Background work outlives a chat turn. Each tab has its own durable transcript. */
import * as QuotaPolicy from "@smthrs/agent/QuotaPolicy"
import * as Seat from "@smthrs/agent/Seat"
import type * as SeatRouter from "@smthrs/agent/SeatRouter"
import * as FailureCopy from "@smthrs/model/FailureCopy"
import * as Agents from "./agents.ts"
import * as Asks from "./asks.ts"
import * as Budget from "./budget.ts"
import type * as Context from "./context.ts"
import type * as Extension from "./extension.ts"
import * as Failures from "./failures.ts"
import type * as Host from "./host.ts"
import * as Lifecycle from "./lifecycle.ts"
import { type DelegateModel, delegateModels, delegateSeat, seatOf as modelSeatOf } from "./models.ts"
import * as Panels from "./panels.ts"
import * as Session from "./session.ts"
import * as Steering from "./steering.ts"
import * as Summary from "./summary.ts"
import { TabError } from "./tab-error.ts"
import * as Transcript from "./transcript.ts"
import * as Tree from "./tree.ts"
import * as Wrapped from "./wrapped.ts"

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
  /** The system-prompt variant Jev routed this tab to; retry and resume keep it with `seat`. */
  readonly variant?: string
  /** The backups Jev's route gave `seat`; retry and resume keep them with `seat`. */
  readonly backups?: ReadonlyArray<string>
  /** The panel Jev's route gave `seat`, its merger; retry and resume keep it with `seat`. */
  readonly panel?: NonNullable<SeatRouter.Route["panel"]>
  /** The answers `panel`'s members gave; a relaunch runs only the members without one. */
  readonly answered?: ReadonlyArray<readonly [seat: string, answer: string]>
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
  /** Token caps the person raised for this worker after it hit one. */
  readonly caps?: Host.Caps
  /** Who is driving it now (`t`): every frame waits for their message or their release. */
  readonly driver?: Driver
  /** Every finished take-over, oldest first; the mythical note's `drivers:`. */
  readonly drivers?: ReadonlyArray<Driver & { readonly to: number }>
  /** A wrapped harness runs this worker with its own tools; `session` once the vendor started it. */
  readonly harness?: {
    readonly vendor: Wrapped.Vendor
    readonly session?: string
    /** The file holding the session's brief: every launch on the session passes these bytes. */
    readonly brief?: string
  }
}
/** A person driving a worker: since when, and how many messages they sent. */
export interface Driver {
  readonly by: string
  readonly from: number
  readonly messages: number
}
/** `tab` with its current take-over, if any, closed at `at` and filed under `drivers`. */
const ended = (tab: Tab, at: number): Tab => {
  if (tab.driver === undefined) return tab
  const { driver, ...rest } = tab
  return { ...rest, drivers: [...tab.drivers ?? [], { ...driver, to: at }] }
}
/** What `agent.wait` returns per tab: its outcome so far, and an ask it holds for the waiting parent. */
export type Waited = Pick<Tab, "id" | "status" | "answer" | "message"> & {
  readonly ask?: { readonly id: string; readonly question: string; readonly options?: ReadonlyArray<string> }
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
  /** Run it on a wrapped harness (Claude Code, Codex) instead of the cell harness. */
  readonly harness?: Wrapped.Vendor | undefined
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
export class AgentDepthExceeded extends Data.TaggedError("AgentDepthExceeded")<{
  readonly code: "depth_exceeded"
  readonly message: string
}> {
  constructor() {
    super({ code: "depth_exceeded", message: "Maximum delegation depth is 3" })
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
  /** Tabs whose panel members are still answering; the merger has not started. */
  private members = new Set<string>()
  private steering = new Map<string, { readonly queue: Steering.Queue; readonly writer: Session.Writer }>()
  private closed = false
  private unsubscribeAsks: () => void = () => {}
  /** How many times each worker has asked for help with a failure. */
  private helpAsked = new Map<string, number>()
  /** Wrapped workers the person took over: resolved once the vendor stopped, released by `release`. */
  private handovers = new Map<
    string,
    { readonly ready: Deferred<string>; readonly back: Deferred<void>; withdrawn?: true }
  >()
  /** Each wrapped worker's headless vendor process now. */
  private vendorRuns = new Map<string, Wrapped.Handle>()
  /** The session each running wrapped worker's vendor named, before it is resumable. */
  private announced = new Map<string, string>()
  /** Open `ask` calls from workers, routed up the tree to the person. */
  readonly asks: Asks.Asks = new Asks.Asks({
    tab: (id) => this.tabs.get(id),
    tell: (id, text, shown) => this.tell(id, text, shown),
    changed: () => this.changed()
  })
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
                  headline: record.outcome.failure?.headline ?? FailureCopy.describe(undefined).headline
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
            failure: tab.failure ?? outcome.failure ?? FailureCopy.describe(undefined),
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
      // A take-over ends with its run.
      if (settled !== tab) settled = ended(settled, settled.endedAt ?? Date.now())
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
    // A holder that stops listening (parked, settled) passes its asks up at once.
    this.unsubscribeAsks = this.tabs.subscribe(() => this.asks.check())
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
  ): Promise<ReadonlyArray<Waited>> => {
    const parent = this.tabs.get(parentId)
    if (parent === undefined) throw new Error("Unknown parent tab")
    const children = ids.map((id) => {
      const child = this.tabs.get(id.startsWith(`${parentId}/`) ? id : `${parentId}/${id}`)
      if (child?.parent !== parentId) throw new Error(`Unknown child tab: ${id}`)
      return child.id
    })
    // Waiting frees the seat, so queued work may start.
    this.tabs.move(parent, "block")
    this.asks.waited(parentId)
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
        // A descendant's ask for this parent ends the wait early, once; it answers, then waits again.
        const asking = this.asks.waiting(parentId)
        if ((!asking && !tabs.every(settled)) || this.tabs.full()) return
        cleanup()
        this.tabs.move(this.tabs.get(parentId)!, "unblock")
        const asks = asking ? this.asks.take(parentId) : []
        const question = (id: string) => {
          const ask = asks.find((each) => each.from === id)
          return ask === undefined ? {} : {
            ask: { id: ask.id, question: ask.question, ...(ask.options === undefined ? {} : { options: ask.options }) }
          }
        }
        // Rows are read once the notification that ended the wait has settled, so a child
        // that asked as it failed reads failed, not the running it was an instant before.
        queueMicrotask(() =>
          resolve([
            ...tabs.map((tab) => this.tabs.get(tab.id) ?? tab).map(({ id, status, answer, message }) => ({
              id,
              status,
              answer,
              message,
              ...question(id)
            })),
            ...asks.filter((ask) => !children.includes(ask.from)).map((ask) => ({
              id: ask.from,
              status: this.tabs.get(ask.from)?.status ?? "running",
              ...question(ask.from)
            }))
          ])
        )
      }
      const unsubscribe = this.subscribe(check)
      signal?.addEventListener("abort", aborted, { once: true })
      if (signal?.aborted) aborted()
      else check()
    })
  }
  /**
   * Persists a request and returns its receipt. `kept` is a resumed or retried
   * tab's own seat and routed variant; otherwise the seat is the request's model, then the agent's
   * declared `model:`, then `Seat.auto` when the host routes, else the worker seat.
   */
  private open(
    request: Request,
    kept?: Pick<Tab, "seat" | "variant" | "backups" | "panel" | "answered">,
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
            : existing.seat === delegateSeat(request.model)
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
    // `auto` is the router's seat, never an agent: refused before any listing, which can take minutes.
    if (request.agent === Seat.auto) {
      throw new Agents.AgentError("seat_as_agent", "auto is the routed seat; omit agent", Seat.auto)
    }
    // Refuses now when the listing is known; otherwise the launch re-lists and fails the tab.
    const listed = request.agent === undefined ? undefined : this.agents().listed()
    if (
      request.agent !== undefined && listed !== undefined &&
      !listed.some((each) => each.name === request.agent) &&
      this.modelNamed(request.agent)
    ) throw new Agents.AgentError("seat_as_agent", `${request.agent} is a model seat; pass it as model`, request.agent)
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
      seat: kept?.seat ?? (request.model === undefined ? declared ?? this.unchosen() : delegateSeat(request.model)),
      ...(kept?.variant === undefined ? {} : { variant: kept.variant }),
      ...(kept?.backups === undefined ? {} : { backups: kept.backups }),
      ...(kept?.panel === undefined ? {} : { panel: kept.panel }),
      ...(kept?.answered === undefined ? {} : { answered: kept.answered }),
      history,
      file: writer.file,
      startedAt: prior?.startedAt ?? Date.now(),
      ...(parks === undefined || parks === 0 ? {} : { parks }),
      ...(request.model === undefined ? {} : { model: request.model }),
      ...(request.agent === undefined ? {} : { agent: { name: request.agent } }),
      ...(prior?.caps === undefined ? {} : { caps: prior.caps }),
      ...(request.harness !== undefined
        ? { harness: { vendor: request.harness } }
        : prior?.harness === undefined
        ? {}
        : { harness: prior.harness }),
      // A relaunched take-over parks again for its driver; finished ones stay on record.
      ...(prior?.driver === undefined ? {} : { driver: prior.driver }),
      ...(prior?.drivers === undefined ? {} : { drivers: prior.drivers })
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
    try {
      this.open(
        { id: tab.id, title: tab.title, prompt: tab.prompt, model: tab.model, agent: tab.agent?.name, by: "user" },
        tab,
        tab.parent,
        tab.depth,
        tab,
        tab.parks
      )
    } catch (error) {
      // A request this build refuses, such as an older session's `agent: "auto"`, fails its tab, not the process.
      const failure = Agents.unreadable(error, tab.agent?.name)
      const at = Date.now()
      const shown = Failures.present("retry", failure)
      const presentation: FailureCopy.Description = {
        headline: shown.sentence,
        fault: shown.fault,
        line: "",
        actions: ["resume", "details"]
      }
      this.tabs.put(tab)
      this.transcripts.set(tab.id, Transcript.failure(this.transcript(tab.id), presentation.headline, at))
      this.tabs.move(
        { ...tab, endedAt: at, message: failure.message, code: failure.code, failure: presentation },
        "fail"
      )
    }
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
    if (this.options.agents === undefined) throw new Agents.AgentError("unavailable", "Agents unavailable here")
    return this.options.agents
  }
  private modelNamed(name: string): boolean {
    return Object.hasOwn(delegateModels, name) || this.options.delegable?.includes(name) === true ||
      modelSeatOf(name, []) !== undefined
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
      const failure = error instanceof Agents.AgentError && error.code === "unknown_agent" &&
          this.modelNamed(tab.agent!.name)
        ? new Agents.AgentError(
          "seat_as_agent",
          `${tab.agent!.name} is a model seat; pass it as model`,
          tab.agent!.name
        )
        : Agents.unreadable(error, tab.agent!.name)
      const now = current()
      if (now !== undefined) {
        const at = Date.now()
        const shown = Failures.present("worker", failure)
        const presentation: FailureCopy.Description = {
          headline: shown.sentence,
          fault: shown.fault,
          line: "",
          actions: ["resume", "details"]
        }
        writer.append({
          type: "outcome",
          at,
          prompt: now.prompt,
          outcome: { _tag: "failed", message: failure.message, headline: presentation.headline, failure: presentation }
        })
        this.transcripts.set(now.id, Transcript.failure(this.transcript(now.id), presentation.headline, at))
        this.tabs.move(
          { ...now, endedAt: at, message: failure.message, code: failure.code, failure: presentation },
          "fail"
        )
      }
      return
    }
    const now = current()
    if (now === undefined) return
    const { answered, backups, panel, variant, ...rest } = now
    // A routed tab keeps `auto`, or the seat and route a retry carries.
    const seat = now.model === undefined
      ? profile.seat ?? (this.routes ? now.seat : this.options.workerSeat)
      : delegateSeat(now.model)
    const ready: Tab = {
      ...rest,
      seat,
      ...(variant === undefined || seat !== now.seat ? {} : { variant }),
      ...(backups === undefined || seat !== now.seat ? {} : { backups }),
      ...(panel === undefined || seat !== now.seat ? {} : { panel }),
      ...(answered === undefined || seat !== now.seat ? {} : { answered }),
      agent: { name: profile.name, digest: profile.digest }
    }
    this.tabs.put(ready)
    this.launch(ready, writer, history, profile)
  }
  private async describe(tab: Tab): Promise<void> {
    let description = tab.title.replace(/\s+/g, " ").trim().slice(0, 80)
    // The worker's own seat: the task never goes to a provider the user did not pick for it. A wrapped
    // worker's provider is its vendor, which is never asked for a title.
    if (!tab.seat.startsWith("replay:") && tab.seat !== Seat.auto && tab.harness === undefined) {
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
    this.cancelRequested.delete(tab.id)
    const at = Date.now()
    this.transcripts.set(
      tab.id,
      Transcript.user(this.transcripts.get(tab.id) ?? Transcript.empty, tab.prompt, false, at)
    )
    // A taken-over worker waiting for its driver frees its seat, and takes one back to go on.
    const steering = Steering.make({
      parked: () => {
        const current = this.tabs.get(tab.id)
        if (current?.status === "running") this.tabs.move(current, "block")
      },
      unparked: () => this.seated(tab.id)
    })
    try {
      writer.append({ type: "user", at, text: tab.prompt })
      const handle = tab.harness !== undefined ? this.runWrapped(tab, writer) : this.options.host.run({
        prompt: tab.prompt,
        seat: tab.seat,
        ...(tab.variant === undefined ? {} : { variant: tab.variant }),
        ...(tab.backups === undefined
          ? {}
          : { route: { backups: tab.backups, ...(tab.panel === undefined ? {} : { panel: tab.panel }) } }),
        ...(tab.answered === undefined ? {} : { answered: tab.answered }),
        onAnswered: (seat, answer) => {
          const current = this.tabs.get(tab.id)
          if (current?.file !== writer.file) return
          this.tabs.put({ ...current, answered: [...(current.answered ?? []), [seat, answer]] })
        },
        onMembers: (running) => {
          if (running) this.members.add(tab.id)
          else this.members.delete(tab.id)
          this.changed()
        },
        ...(tab.model === undefined && agent?.fallbackSeats !== undefined
          ? { fallbackSeats: agent.fallbackSeats }
          : {}),
        source: tab.id,
        history,
        role: "worker",
        ...(tab.caps === undefined ? {} : { caps: tab.caps }),
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
          wait: (ids, signal) => this.wait(tab.id, ids, signal),
          ask: (input, signal) => this.ask(tab.id, input, signal),
          answer: (id, answer) => {
            // An ask that offers options takes one of them, so an answer is never read as another.
            const options = this.asks.list().find((ask) => ask.id === id)?.options
            const fold = (text: string) => text.trim().toLowerCase()
            const chosen = options === undefined
              ? answer
              : options.find((option) => option === answer) ?? options.find((option) => fold(option) === fold(answer))
            if (chosen === undefined) throw new Error(`Answer one of: ${options!.join(", ")}`)
            if (!this.asks.answer(id, chosen, tab.id)) {
              throw new Error(`No open ask ${id} for this agent`)
            }
            return { id, status: "answered" }
          }
        },
        onSeat: ({ backups, panel, seat, variant }) => {
          const current = this.tabs.get(tab.id)
          if (current?.file !== writer.file) return
          // Retry and resume keep the route, so the tab is never routed twice.
          const routed: Tab = {
            ...current,
            seat,
            backups,
            ...(panel === undefined ? {} : { panel }),
            ...(variant === null ? {} : { variant })
          }
          this.tabs.put(routed)
          void this.describe(routed)
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
          if (event._tag === "cell-settled") this.asks.frame(tab.id)
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
      // A take-over survives a restart: the relaunched run parks at its next boundary again.
      if (this.tabs.get(tab.id)?.driver !== undefined) steering.hijack()
      this.tabs.move({ ...(this.tabs.get(tab.id) ?? tab), launchedAt: at }, "launch")
      void handle.done.then((outcome) => {
        // A parked retry can replace this execution before its cancellation settles.
        if (this.closed || this.tabs.get(tab.id)?.file !== writer.file) return
        this.handles.delete(tab.id)
        this.steering.delete(tab.id)
        const requestedCancel = this.cancelRequested.delete(tab.id)
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
            ? { _tag: "failed", message: outcome.message, headline: failure!.headline, failure: failure! }
            : { _tag: "cancelled" }
        })
        if (outcome._tag !== "done") {
          transcript = Transcript.failure(transcript, outcome._tag === "failed" ? failure!.headline : "Stopped", at)
          this.transcripts.set(tab.id, transcript)
        }
        // Opened before the worker settles, so a parent already in agent.wait gets it with the failure.
        if (outcome._tag === "failed") this.askForHelp(tab.id, outcome.error, failure!)
        this.tabs.move({
          ...ended(this.tabs.get(tab.id) ?? tab, at),
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
  /**
   * A wrapped worker's run: its memory and brief first, then the vendor headless on one session.
   * A take-over stops it (Claude Code at once, Codex once its turn completes, the 0.x rule), hands
   * the terminal over, and once released runs it on headless on the same session and brief.
   */
  private runWrapped(tab: Tab, writer: Session.Writer): Host.Turn {
    const vendor = tab.harness!.vendor
    // A retried or restarted worker has a new file; nothing from an older run writes into it.
    const own = () => this.tabs.get(tab.id)?.file === writer.file
    const note = (text: string) => {
      if (!own()) return
      const at = Date.now()
      writer.append({ type: "note", at, text })
      this.transcripts.set(tab.id, Transcript.note(this.transcript(tab.id), text, at))
      this.changed()
    }
    let cancelled = false
    let current: Wrapped.Handle | undefined
    const body = async (): Promise<Host.Outcome> => {
      // A take-over does not survive a restart: the vendor's own TUI went with the process.
      const restored = this.tabs.get(tab.id)
      if (restored?.driver !== undefined) this.tabs.put(ended(restored, Date.now()))
      let resume = tab.harness!.session !== undefined
      const file = tab.harness!.brief ?? `${tab.file}.brief.md`
      let brief: string
      if (existsSync(file)) brief = readFileSync(file, "utf8")
      else {
        const memory = this.options.host.memory
        const recalled = memory === undefined ? undefined : await memory(tab.prompt).catch((error: unknown) => {
          note(`→ ${Failures.line("memory", error)}`)
          return undefined
        })
        note(
          memory === undefined
            ? "→ memory unavailable"
            : recalled === undefined
            ? "→ memory none"
            : `→ memory ${recalled.kept} in · ${recalled.withheld} withheld`
        )
        // The brief is frozen for the session: every launch on it passes these bytes, so the prefix caches.
        brief = [SmithersPlugin.brief, recalled?.text ?? ""].filter((part) => part !== "").join("\n\n")
        writeFileSync(file, brief, { mode: 0o600 })
      }
      const now = this.tabs.get(tab.id)
      if (now !== undefined && now.harness?.brief !== file) {
        this.tabs.put({ ...now, harness: { ...now.harness!, brief: file } })
      }
      // Claude Code takes the id we choose; it is recorded once the vendor reports it started.
      const chosen = tab.harness!.session ?? (vendor === "claude" ? randomUUID() : undefined)
      // The vendor repeats a call's usage on each of its blocks: count each call once.
      const counted = new Set<string>()
      {
        for (;;) {
          if (cancelled) return { _tag: "cancelled" }
          const session = this.tabs.get(tab.id)?.harness?.session ?? chosen
          const handle = Wrapped.run({
            vendor,
            prompt: resume ? Wrapped.continuePrompt : tab.prompt,
            cwd: this.options.host.cwd,
            brief,
            ...(session === undefined ? {} : { session }),
            resume,
            approve: this.options.host.approvals?.mode ?? "all"
          }, (folded) => {
            if (!own()) return
            if (folded.announce !== undefined) this.announced.set(tab.id, folded.announce)
            const at = this.tabs.get(tab.id)!
            if (folded.session !== undefined && at.harness?.session !== folded.session) {
              this.tabs.put({ ...at, harness: { ...at.harness!, session: folded.session } })
            }
            for (const row of folded.rows) note(`${row.glyph} ${row.text}`)
            const usage = folded.usage
            if (usage !== undefined && (usage.call === undefined || !counted.has(usage.call))) {
              if (usage.call !== undefined) counted.add(usage.call)
              const transcript = this.transcript(tab.id)
              this.transcripts.set(tab.id, {
                ...transcript,
                usage: {
                  input: transcript.usage.input + usage.input,
                  output: transcript.usage.output + usage.output,
                  cached: transcript.usage.cached + usage.cached,
                  context: usage.input
                }
              })
              this.changed()
            }
          })
          current = handle
          this.vendorRuns.set(tab.id, handle)
          const outcome = await handle.done
          this.vendorRuns.delete(tab.id)
          const handover = this.handovers.get(tab.id)
          if (handover?.withdrawn === true && !cancelled) {
            // Released before the terminal was handed over: the run just goes on.
            this.handovers.delete(tab.id)
            if (outcome._tag === "stopped") {
              resume = true
              continue
            }
          } else if (handover !== undefined && !cancelled && outcome._tag !== "failed") {
            handover.ready.resolve(brief)
            await handover.back.promise
            this.handovers.delete(tab.id)
            resume = true
            continue
          }
          return outcome._tag === "done"
            ? { _tag: "done", answer: outcome.answer }
            : outcome._tag === "failed"
            ? { _tag: "failed", message: outcome.message, detail: "" }
            : { _tag: "cancelled" }
        }
      }
    }
    const done = (async (): Promise<Host.Outcome> => {
      try {
        return await body()
      } finally {
        // Whatever ended the run, a take-over waiting on it hears so and is gone.
        this.handovers.get(tab.id)?.ready.reject(new Error(`${tab.title} stopped before it was handed over`))
        this.handovers.delete(tab.id)
        this.vendorRuns.delete(tab.id)
        this.announced.delete(tab.id)
      }
    })()
    return {
      done,
      cancel: () => {
        cancelled = true
        current?.stop()
        this.handovers.get(tab.id)?.back.resolve()
      }
    }
  }
  /** Settles the tab, its timeline and its worker file as failed. */
  private fail(tab: Tab, writer: Session.Writer, error: unknown) {
    if (this.closed || this.tabs.get(tab.id)?.file !== writer.file) return
    this.handles.delete(tab.id)
    this.steering.delete(tab.id)
    this.cancelRequested.delete(tab.id)
    const at = Date.now()
    const message = String(error)
    const failure = FailureCopy.describe(error, this.tabs.get(tab.id)?.activeSeat ?? tab.seat)
    try {
      writer.append({
        type: "outcome",
        at,
        prompt: tab.prompt,
        outcome: { _tag: "failed", message, headline: failure.headline, failure }
      })
    } catch (error) {
      Log.write("worker.persist", error)
    }
    this.transcripts.set(tab.id, Transcript.failure(this.transcript(tab.id), failure.headline, at))
    this.tabs.move({
      ...ended(this.tabs.get(tab.id) ?? tab, at),
      endedAt: at,
      message,
      failure,
      detail: error instanceof Error ? error.stack : undefined
    }, "fail")
  }
  /**
   * A worker's `ask`: its seat is free while it waits, as `agent.wait` frees
   * one, and it runs on once answered and a seat is free.
   */
  private async ask(
    id: string,
    input: Asks.Input,
    signal?: AbortSignal
  ): Promise<{ readonly answer: string; readonly approved: boolean }> {
    const asker = this.tabs.get(id)
    if (asker === undefined) throw new Error("Unknown tab")
    const blocked = asker.status === "running"
    if (blocked) this.tabs.move(asker, "block")
    try {
      return { answer: await this.asks.ask(asker, input, signal), approved: true }
    } finally {
      if (blocked) await this.seated(id, signal)
    }
  }
  /**
   * A child worker whose failure the one ladder answers with help (the
   * person's or the plan's, not a limit, the platform or a defect) asks its
   * parent, then the person, to retry or stop; a top-level worker's failure
   * card already asks the person. Called as the worker settles, so a parent
   * waiting on it gets the ask with the failure. An answered retry relaunches
   * it; the ask is withdrawn once the worker runs again another way or its
   * parent stops or finishes.
   */
  private askForHelp(id: string, error: unknown, failure: FailureCopy.Description): void {
    const tab = this.tabs.get(id)
    if (tab?.parent === undefined) return
    const parent = tab.parent
    const noLadder = { attempt: 3, seatsLeft: 0, parksLeft: 0, replans: 2, veryHard: true }
    if (Fault.respond(Fault.of(error), noLadder) !== "help") return
    // A parent that already settled cannot answer; the child's own failure card stands.
    const settledParent = this.tabs.get(tab.parent)?.status
    if (settledParent === "done" || settledParent === "failed" || settledParent === "cancelled") return
    // At most twice in a worker's life: a third help-worthy failure stands as failed.
    const asked = this.helpAsked.get(id) ?? 0
    if (asked >= 2) return
    this.helpAsked.set(id, asked + 1)
    const withdrawn = new AbortController()
    let settled = false
    const unsubscribe = this.subscribe(() => {
      const status = this.tabs.get(id)?.status
      if (status === "failed") settled = true
      const holder = this.tabs.get(parent)?.status
      if ((settled && status !== "failed") || holder === "cancelled" || holder === "failed" || holder === "done") {
        withdrawn.abort()
      }
    })
    this.asks.ask(
      tab,
      { question: `${failure.headline}. ${failure.line}`, options: ["retry", "stop"] },
      withdrawn.signal
    )
      .then((answer) => {
        unsubscribe()
        if (answer.trim().toLowerCase() === "retry" && this.tabs.get(id)?.status === "failed") this.retry(id)
      })
      .catch((reason: unknown) => {
        unsubscribe()
        if (!withdrawn.signal.aborted) Log.write("worker.retry", reason)
      })
  }
  /** Resolves once a blocked worker has a seat again and is running. */
  private seated(id: string, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const check = () => {
        const current = this.tabs.get(id)
        if (this.closed || current === undefined || current.status !== "waiting" || signal?.aborted === true) {
          unsubscribe()
          return resolve()
        }
        if (this.tabs.full()) return
        unsubscribe()
        this.tabs.move(current, "unblock")
        resolve()
      }
      const unsubscribe = this.subscribe(check)
      check()
    })
  }
  /** Tells a running worker `text` at its next boundary, shown in its tab as `shown`, not as the person's words. */
  private tell(id: string, text: string, shown: string): boolean {
    const target = this.steering.get(id)
    if (target === undefined || this.tabs.get(id)?.status !== "running") return false
    target.queue.steer(text)
    this.transcripts.set(id, Transcript.note(this.transcript(id), shown, Date.now()))
    this.changed()
    return true
  }
  /** Sends `text` to a running worker at its next cell boundary; false when it is not running. */
  steer = (id: string, text: string): boolean => {
    const target = this.steering.get(id)
    if (target === undefined || this.tabs.get(id)?.status !== "running" || this.members.has(id)) return false
    const at = Date.now()
    target.queue.steer(text)
    target.writer.append({ type: "user", at, text, steered: true })
    this.transcripts.set(id, Transcript.user(this.transcript(id), text, true, at))
    this.changed()
    return true
  }
  /** Why a running worker cannot be steered or taken over yet; undefined when it can. */
  unsteerable = (id: string): string | undefined =>
    this.members.has(id) ? "Its panel members are answering; steer it once the merger starts" : undefined
  /** Takes over a running worker: each later frame waits for `drive` or `release`. */
  hijack = (id: string, by: string): boolean => {
    const target = this.steering.get(id)
    const tab = this.tabs.get(id)
    if (target === undefined || tab?.status !== "running" || tab.driver !== undefined || this.members.has(id)) {
      return false
    }
    // A wrapped worker is handed over whole, on its vendor session: Claude Code's once a call on it
    // settled, Codex's once named, as its hand-over waits for the turn to complete anyway.
    if (
      tab.harness !== undefined &&
      (tab.harness.vendor === "claude" ? tab.harness.session : tab.harness.session ?? this.announced.get(id)) ===
        undefined
    ) return false
    const at = Date.now()
    if (tab.harness === undefined) target.queue.hijack()
    else {
      this.handovers.set(id, { ready: deferred<string>(), back: deferred<void>() })
      // Claude Code resumes from any message; Codex only after its turn completed.
      if (tab.harness.vendor === "claude") this.vendorRuns.get(id)?.stop()
    }
    this.transcripts.set(id, Transcript.note(this.transcript(id), `⇄ ${by} took over`, at))
    this.tabs.put({ ...tab, driver: { by, from: at, messages: 0 } })
    return true
  }
  /**
   * Sends a taken-over worker's next message, or runs its waiting frame with nothing new when `text`
   * is blank; false when there is nothing to drive, or a blank Enter while it still works.
   */
  drive = (id: string, text: string): boolean => {
    const target = this.steering.get(id)
    const tab = this.tabs.get(id)
    if (target === undefined || tab?.driver === undefined || !target.queue.drive(text)) return false
    const at = Date.now()
    const blank = text.trim() === ""
    if (!blank) {
      target.writer.append({ type: "user", at, text, steered: true })
      this.transcripts.set(id, Transcript.user(this.transcript(id), text, true, at))
    }
    const current = this.tabs.get(id)!
    this.tabs.put({ ...current, driver: { ...current.driver!, messages: current.driver!.messages + (blank ? 0 : 1) } })
    return true
  }
  /** Hands a taken-over worker back: it runs on by itself and the take-over is recorded. */
  release = (id: string): boolean => {
    const tab = this.tabs.get(id)
    if (tab?.driver === undefined) return false
    const at = Date.now()
    this.steering.get(id)?.queue.release()
    // The run's own loop removes the hand-over once it takes the worker back. Released before the
    // vendor stopped, the hand-over is withdrawn: its TUI never starts beside the headless run.
    const handover = this.handovers.get(id)
    if (handover !== undefined && !handover.ready.settled()) {
      handover.withdrawn = true
      handover.ready.reject(new Error(`${tab.title} was released before it was handed over`))
    }
    handover?.back.resolve()
    this.transcripts.set(id, Transcript.note(this.transcript(id), `⇄ ${tab.driver.by} released`, at))
    this.tabs.put(ended(tab, at))
    return true
  }
  /**
   * The vendor's own TUI on a taken-over wrapped worker's session, once its headless run has
   * stopped: what the terminal runs until the person quits it and `release` hands it back.
   */
  handedOver = async (id: string): Promise<{ readonly command: string; readonly args: ReadonlyArray<string> }> => {
    const handover = this.handovers.get(id)
    if (handover === undefined) throw new Error(`${id} is not taken over`)
    const brief = await handover.ready.promise
    const tab = this.tabs.get(id)
    if (tab?.harness?.session === undefined) throw new Error(`${id} has no session to resume`)
    return Wrapped.interactive(
      tab.harness.vendor,
      tab.harness.session,
      this.options.host.cwd,
      brief,
      this.options.host.approvals?.mode ?? "all"
    )
  }

  /** Whether a taken-over worker is parked for its driver now. */
  holding = (id: string): boolean => this.steering.get(id)?.queue.holding() === true
  /** Records an undo of a tab's calls in its own file and transcript. */
  undone = (id: string, calls: ReadonlyArray<string>, paths: ReadonlyArray<string>, at: number): void => {
    const tab = this.tabs.get(id)
    if (tab === undefined) throw new TabError("unknown_tab", "Unknown tab", id)
    Session.reopen(tab.file).append({ type: "undo", at, calls, paths })
    this.transcripts.set(id, Transcript.undone(this.transcript(id), calls, paths, at))
    this.changed()
  }
  /** A worker's own transcript, for the chat timeline to interleave. */
  transcript = (id: string): Transcript.Transcript => this.transcripts.get(id) ?? Transcript.empty
  read = (id: string) => {
    const tab = this.tabs.get(id)
    if (tab === undefined) throw new TabError("unknown_tab", "Unknown tab", id)
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
    if (tab === undefined) throw new TabError("unknown_tab", "Unknown tab", id)
    if (tab.status !== "failed" && tab.status !== "cancelled" && tab.status !== "parked") {
      throw new TabError("not_retryable", `Only a failed or stopped tab can be retried; ${id} is ${tab.status}`, id)
    }
    if (tab.status === "parked" && this.handles.has(id)) {
      this.cancelRequested.add(id)
      this.handles.get(id)?.cancel()
    }
    this.tabs.forget(id)
    try {
      // Keeps the agent, the model, the seat and its routed variant; the agent's file is read again, so edits apply.
      // A seat the user picks is not routed, so it runs without the variant.
      return this.open(
        { id, title: tab.title, prompt: tab.prompt, model: tab.model, agent: tab.agent?.name, by: "user" },
        seat === undefined ? tab : { seat },
        tab.parent,
        tab.depth,
        tab
      )
    } catch (error) {
      this.tabs.adopt(tab)
      throw error
    }
  }
  /** Resumes a worker stopped at its run cap, with its prior steps, as a run with the chosen allowance. */
  raiseCap = (id: string, caps: Host.Caps): { id: string; status: Tab["status"] } => {
    const tab = this.tabs.get(id)
    if (tab?.status !== "failed" || !Budget.capped(tab.failure)) {
      throw new TabError(
        "not_capped",
        `Only a worker stopped at its run cap can be resumed with a new one; ${id} is not`,
        id
      )
    }
    this.tabs.put({ ...tab, caps })
    try {
      return this.retry(id)
    } catch (error) {
      this.tabs.put(tab)
      throw error
    }
  }
  /** Parks a failed worker until its known reset, then continues the same task. */
  waitForReset = (id: string): void => {
    const tab = this.tabs.get(id)
    if (tab?.status !== "failed") throw new TabError("not_failed", "Only a failed tab can wait", id)
    const wakeAt = Math.max(Date.now(), tab.wakeAt ?? Date.now() + 15 * 60_000)
    // The user chose this wait, so the resumed run gets a fresh park budget.
    const waiting = this.tabs.move({ ...tab, wakeAt, endedAt: undefined, parks: undefined }, "sleep")!
    setTimeout(() => {
      if (this.tabs.get(id)?.status === "parked" && this.tabs.get(id)?.file === tab.file) this.relaunch(waiting)
    }, wakeAt - Date.now())
  }
  dispose = (): void => {
    this.unsubscribeAsks()
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
/** The provider whose reset a parked tab waits for. */
const seatProvider = (seat: string): string =>
  seat.startsWith("openai:") ?
    "ChatGPT" :
    seat.startsWith("anthropic:")
    ? "Anthropic"
    : seat.split(":")[0] ?? "model"

/** The failure card's single progress and file-impact line. */
export const failureLine = (tab: Tab, transcript: Transcript.Transcript): string => {
  const steps = transcript.items.filter((item) => item.kind === "cell" && item.status !== "writing").length
  const changed = transcript.items.some((item) =>
    item.kind === "cell" && item.calls.some((call) => (call.patches?.length ?? 0) > 0 && call.undone !== true)
  )
  const prefix = tab.failure?.line ?? "The worker stopped before finishing."
  return `${prefix} ${steps} of ~40 steps done. ${changed ? "Files changed." : "No files changed."}`
}

/** A promise and its settlers. */
interface Deferred<A> {
  readonly promise: Promise<A>
  readonly resolve: (value: A) => void
  readonly reject: (error: Error) => void
  readonly settled: () => boolean
}
const deferred = <A>(): Deferred<A> => {
  let done = false
  let resolve: (value: A) => void = () => {}
  let reject: (error: Error) => void = () => {}
  const promise = new Promise<A>((ok, fail) => {
    resolve = (value) => {
      done = true
      ok(value)
    }
    reject = (error) => {
      done = true
      fail(error)
    }
  })
  // A hand-over nobody waits on may still be refused.
  promise.catch(() => {})
  return { promise, resolve, reject, settled: () => done }
}
