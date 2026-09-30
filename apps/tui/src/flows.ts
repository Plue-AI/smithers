import * as Log from "./log.ts"
/**
 * The user's own file flows (`flows/<name>/flow.ts`), run in background tabs.
 *
 * Shares `lifecycle.ts` with `workspace.ts`: a request persists before any
 * work, returns a `requested` or `queued` receipt, and settles only from the
 * control plane's watch. The
 * `Port` is the seam to the native control host (`flow-control.ts`).
 */
import * as NodeOutput from "@smthrs/cli/NodeOutput"
import type { ControlSchema } from "@smthrs/control"
import * as Form from "@smthrs/ui/flow-form"
import { Data, Schema } from "effect"
import * as Deadline from "./deadline.ts"
import * as Extension from "./extension.ts"
import * as Failures from "./failures.ts"
import * as Lifecycle from "./lifecycle.ts"
import type * as Panels from "./panels.ts"
import type * as Session from "./session.ts"
import { TabError } from "./tab-error.ts"
import * as Transcript from "./transcript.ts"

type ControlEvent = ControlSchema.ControlEvent

/** A discovered flow: registry metadata only. A markdown flow is also an agent. */
export type Listed = Extension.Descriptor
/** An agent's prompt, read on demand; `digest` names the executable the tab ran. */
export interface Body {
  /** Settings from the same registry snapshot that verified these prompt bytes. */
  readonly descriptor: Listed
  readonly text: string
  readonly baseDirectory: string
  readonly digest: string
  /** The file's own `capabilities:`; the registry widens them to `*` when `flows:` is declared. */
  readonly capabilities?: ReadonlyArray<string>
}
/** A run in the control store, as `smthrs ps` lists it. */
export interface Recorded {
  readonly runId: string
  readonly flow: string
  readonly status: string
  /** When the store last changed the run. */
  readonly at?: number
}
/** The module flows the warm host imported, and the ones it refused; fixed until a restart. */
export interface Loaded {
  readonly flows: ReadonlyArray<{ readonly name: string; readonly input: Schema.Top | undefined }>
  readonly refused: ReadonlyArray<string>
}
/** A flow as `smithers.flows` describes it. */
export interface Described {
  readonly name: string
  readonly description: string
  readonly agent: boolean
  /** Absent until a run imported the module. */
  readonly input?: ReadonlyArray<{ readonly name: string; readonly type: string; readonly required: boolean }>
}
/** A plan card; `raw` is the control plane's, kept in memory only. */
export interface Card {
  readonly raw: unknown
}
export type Settled =
  | { readonly kind: "done"; readonly answer: string }
  | { readonly kind: "failed"; readonly message: string }
  | { readonly kind: "cancelled" }
export interface Watch {
  /** Settles only at a terminal event; a run parked for approval keeps it open. */
  readonly done: Promise<Settled>
  readonly close: () => void
}
export interface Port {
  /** Initialize the control host after the terminal has drawn. */
  readonly warm?: () => Promise<void>
  /** What the warm host imported; undefined when this directory has no flows. */
  readonly loaded?: () => Promise<Loaded | undefined>
  /** Registry only; never imports a flow module. */
  readonly discover: () => Promise<ReadonlyArray<Listed>>
  readonly input: (flow: string) => Promise<Schema.Top | undefined>
  /** A markdown flow's body; a module flow is refused. */
  readonly body: (flow: string) => Promise<Body>
  readonly plan: (flow: string, input: unknown) => Promise<Card>
  /** Approves and launches. A signal interrupts approval only; an admitted launch still returns its receipt. */
  readonly start: (card: Card, source?: string, signal?: AbortSignal) => Promise<string>
  readonly resume: (runId: string) => Promise<{ readonly runId: string } | Settled>
  /** Approves an open {@link Gate}'s payload, unchanged, before the run resumes. */
  readonly approve?: (approval: unknown) => Promise<void>
  readonly watch: (runId: string, onEvent: (event: ControlEvent) => void) => Watch
  readonly events: (runId: string) => Promise<ReadonlyArray<ControlEvent>>
  /** The newest runs in this directory's store, whoever started them; never imports a flow module. */
  readonly runs?: () => Promise<ReadonlyArray<Recorded>>
  readonly cancel: (runId: string) => Promise<void>
  readonly dispose: () => Promise<void>
}
/** Registry infrastructure failed; the last successful catalog remains available. */
export class FlowDiscoveryFailed extends Data.TaggedError("FlowDiscoveryFailed")<{
  readonly cause: unknown
  readonly message: string
}> {
  constructor(cause: unknown) {
    super({ cause, message: "Flow discovery unavailable" })
  }
}
/**
 * A discovery failure notice, by `Failures.identity`: an unchanged failure is
 * shown once, across session switches, until a listing succeeds.
 */
export const discoveryNotice = (
  shown: string | undefined,
  failure: FlowDiscoveryFailed | undefined,
  listed: boolean
): { readonly shown: string | undefined; readonly show: boolean } => {
  if (failure === undefined) return { shown: listed ? undefined : shown, show: false }
  const next = Failures.identity(failure)
  return { shown: next, show: next !== shown }
}
/**
 * A flow refusal or failure. The message is for the model and the log; a
 * person sees the sentence `Failures` builds from `code` and `subject`.
 * `stopped` is a person's own stop, never shown as a failure.
 */
export type FlowErrorCode =
  | "unknown_flow"
  | "unloaded"
  | "refused"
  | "person_only"
  | "denied"
  | "stopped"
  | "invalid_input"
  | "launch"
  | "control"
export class FlowError extends Data.TaggedError("FlowError")<{
  readonly code: FlowErrorCode
  readonly message: string
  readonly cause?: unknown
  readonly subject?: string
}> {
  constructor(code: FlowErrorCode, message: string, options?: ErrorOptions & { readonly subject?: string }) {
    super({
      code,
      message,
      ...(options?.cause === undefined ? {} : { cause: options.cause }),
      ...(options?.subject === undefined ? {} : { subject: options.subject })
    })
  }
}

const unloaded = (flow: string) =>
  new FlowError("unloaded", `${flow} was added after the flows loaded; restart to run it`, { subject: flow })

export interface Run {
  readonly id: string
  readonly flow: string
  readonly by: "user" | "agent"
  readonly input: Record<string, unknown>
  /** The original input as JSON, for deduplication. */
  readonly requested: string
  readonly status: Lifecycle.Status
  readonly runId?: string
  /** When the current attempt began: a retry or resume restarts it. */
  readonly startedAt: number
  /** When the control plane started the attempt, after any queue, input or approval wait. */
  readonly launchedAt?: number
  /** 1 for the first request, bumped by every retry or resume. Absent means 1. */
  readonly attempt?: number
  readonly endedAt?: number
  readonly message?: string
  /** Host-authored failure copy; raw control-plane messages never enter a Chat card. */
  readonly failure?: string
  readonly answer?: string
  /** A stop must follow an in-flight launch through its remote receipt. */
  readonly stopRequested?: true
  /** A queued admission must resume this durable run, not launch a replacement. */
  readonly resumeRequested?: true
}
export interface Request {
  readonly id?: string
  readonly flow: string
  readonly input: Record<string, unknown>
  readonly by: Run["by"]
}

export const interrupted = "Interrupted; retry to continue."

/** A done run's card words, `40ms → 5`: how long it ran, then its answer on one line. */
const doneWords = (run: Run): string => {
  const took = run.endedAt === undefined
    ? undefined
    : Transcript.duration(run.endedAt - (run.launchedAt ?? run.startedAt))
  const answer = run.answer?.replace(/\s+/g, " ").trim() ?? ""
  const words = [took, answer === "" ? undefined : `→ ${answer.length > 200 ? `${answer.slice(0, 199)}…` : answer}`]
    .filter((word) => word !== undefined)
  return words.length === 0 ? "done" : words.join(" ")
}

/** An approval a run is parked on: what it asks, and the payload that decides it. */
export interface Gate {
  readonly requestId: string
  readonly question: string
  readonly approval: unknown
}

const fields = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}

/**
 * The newest approval request in a run's events that no decision answered: a
 * budget raise, for one. Continue on the parked run approves it.
 */
export const openGate = (events: ReadonlyArray<ControlEvent>): Gate | undefined => {
  const decided = new Set<string>()
  for (const event of events) {
    if (event.kind !== "control.approval.approved" && event.kind !== "control.approval.denied") continue
    const payload = fields(event.payload)
    const target = fields(payload["approvalTarget"])
    for (const id of [payload["tokenId"], target["requestId"]]) if (typeof id === "string") decided.add(id)
  }
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]!
    if (event.kind !== "control.approval.requested") continue
    const payload = fields(event.payload)
    const { question, requestId } = payload
    if (typeof requestId !== "string" || typeof question !== "string" || decided.has(requestId)) continue
    if (payload["payload"] === undefined) continue
    return { requestId, question, approval: payload["payload"] }
  }
  return undefined
}
/** Concurrent flow runs; later requests wait FIFO in `queued` and start when one settles. */
export const seats = 3
/** Events the watch settles on; they never move a parked run back to running. */
export const terminal: ReadonlySet<string> = new Set([
  "control.run.completed",
  "control.run.failed",
  "control.run.cancelled",
  "control.run.pending"
])
/** Work is in flight: a launch in progress or a remote run. */
export const running = (run: Run): boolean =>
  run.status === "requested" || run.status === "running" || run.status === "waiting"
/** Holds a seat: in flight, or parked here for the user's input. */
const active = (run: Run) => running(run) || run.status === "input"

/**
 * The controller, keyboard, and footer share the same action eligibility. A
 * parked run (a budget or time guard, or an approval) offers Continue, which
 * approves its open request and resumes it, in place of Resume.
 */
export const actions = (run: Run | undefined): { retry: boolean; continue: boolean; stop: boolean } => ({
  retry: run !== undefined && (run.status === "failed" || run.status === "cancelled"),
  continue: run?.status === "parked",
  stop: run !== undefined && (active(run) || run.status === "queued" || run.status === "parked")
})

/** One row of a run: an agent's flow call or a module flow's step. */
export interface Step {
  readonly id: string
  readonly label: string
  readonly status: "done" | "failed" | "running" | "requested" | "cancelled"
  /** The step's recorded result, bounded by the engine. */
  readonly preview?: string
}

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}

/**
 * A module flow's steps from its engine journal (`flows.engine.node-*`), in
 * the order they were scheduled: each action call, and each call of another
 * flow. The run's own flow node and its registry entry are the run itself, and
 * control nodes (`AndThen`) are plumbing. An unsettled step runs while the
 * engine has an attempt open for it; the rest wait, and once the run settles
 * nothing is running.
 */
export const steps = (
  events: ReadonlyArray<ControlEvent>,
  flow: string,
  settled: boolean
): ReadonlyArray<Step> => {
  const order: Array<string> = []
  const nodes = new Map<string, { readonly label: string; readonly outcome?: string; readonly preview?: string }>()
  const started = new Set<string>()
  const finished = new Set<string>()
  for (const event of events) {
    if (event.kind !== "control.engine.event") continue
    const envelope = record(event.payload)
    const payload = record(envelope["payload"])
    const nodeId = typeof payload["nodeId"] === "string" ? payload["nodeId"] : undefined
    const action = typeof payload["action"] === "string" ? payload["action"] : undefined
    switch (envelope["eventType"]) {
      case "flows.engine.attempt-started":
        started.add(String(payload["stepKeyDigest"]))
        break
      case "flows.engine.attempt-finished":
        finished.add(String(payload["stepKeyDigest"]))
        break
      case "flows.engine.node-scheduled": {
        const step = payload["kind"] === "ActionCall" ||
          (payload["kind"] === "FlowCall" && action !== flow && !action?.startsWith("registry/entry/"))
        if (nodeId === undefined || action === undefined || !step) break
        // A retry schedules the same node again: it keeps its place and runs again.
        if (!nodes.has(nodeId)) order.push(nodeId)
        nodes.set(nodeId, { label: action.startsWith(`${flow}/`) ? action.slice(flow.length + 1) : action })
        break
      }
      case "flows.engine.node-settled": {
        const node = nodeId === undefined ? undefined : nodes.get(nodeId)
        if (node === undefined) break
        const preview = record(payload["result"])["preview"]
        nodes.set(nodeId!, {
          label: node.label,
          outcome: String(payload["outcome"]),
          ...(typeof preview === "string" ? { preview } : {})
        })
        break
      }
    }
  }
  let running = settled ? 0 : Math.max(1, [...started].filter((key) => !finished.has(key)).length)
  return order.map((id) => {
    const node = nodes.get(id)!
    const status: Step["status"] = node.outcome === undefined
      ? running-- > 0 ? "running" : "requested"
      : node.outcome === "failed"
      ? "failed"
      : node.outcome === "skipped" || node.outcome === "deferred"
      ? "cancelled"
      : "done"
    return { id, label: node.label, status, ...(node.preview === undefined ? {} : { preview: node.preview }) }
  })
}

export class FlowRuns {
  private runs: Lifecycle.Pool<Run>
  private events = new Map<string, Array<ControlEvent>>()
  private schemas = new Map<string, Schema.Top>()
  private watches = new Map<string, Watch>()
  private launching = new Map<string, AbortController>()
  private launches = new Set<Promise<void>>()
  /** Bumped by every restart of a run; a continuation from an older attempt drops its result. */
  private attempts = new Map<string, number>()
  private loaded = new Set<string>()
  private historyFailures = new Map<string, string>()
  private cache: ReadonlyArray<Listed> = []
  private discoveryFailure: FlowDiscoveryFailed | undefined
  private discovered = false
  /** Runs in the store this session did not start (`smthrs flow start`); read-only. */
  private recorded: ReadonlyArray<Recorded> = []
  /** Payload schemas read by a run's preparation, by flow; describing never imports a module. */
  private inputs = new Map<string, Schema.Top | undefined>()
  private discovery = 0
  private discovering: Promise<ReadonlyArray<Listed>> | undefined
  private discoveredAt = -Infinity
  private warming: Promise<void> | undefined
  /** The warm host's module catalog; a module flow outside it was added after launch. */
  private imported: { readonly flows: ReadonlySet<string>; readonly refused: ReadonlySet<string> } | undefined
  private opened = false
  private isOpening = false
  private closed = false
  constructor(
    private options: {
      /** Ids owned by worker tabs in the same session. */
      occupied?: (id: string) => boolean
      port?: Port | undefined
      persist: (record: Session.Record) => void
      restored?: ReadonlyArray<Run> | undefined
    }
  ) {
    this.runs = new Lifecycle.Pool<Run>({
      name: "flow",
      seats,
      holdsSeat: active,
      persist: (run) => options.persist({ type: "flow", run }),
      admit: (run) => {
        const attempt = this.attempt(run.id)
        this.runs.move({ ...run, message: undefined, failure: undefined }, "admit")
        queueMicrotask(() => void this.prepare(run.id, attempt))
      }
    })
    for (const run of options.restored ?? []) {
      // Anything unsettled, including statuses older builds wrote, resumes as interrupted.
      if (!Lifecycle.settled(run.status)) {
        this.runs.move({ ...run, message: interrupted, failure: undefined, endedAt: Date.now() }, "fail")
      } else this.runs.adopt(run)
    }
  }
  /** Idempotent background host opening, independent of request acknowledgments. */
  warm = (): void => {
    const port = this.options.port
    if (this.opened || this.warming !== undefined || this.closed || port?.warm === undefined) return
    this.isOpening = true
    this.changed()
    this.warming = port.warm().then(async () => {
      this.opened = true
      const loaded = await port.loaded?.().catch((error) => void Log.write("flow.catalog", error))
      if (loaded === undefined || this.closed) return
      for (const flow of loaded.flows) this.inputs.set(flow.name, flow.input)
      this.imported = { flows: new Set(loaded.flows.map((flow) => flow.name)), refused: new Set(loaded.refused) }
    }, (error) => Log.write("flow.open", error)).finally(() => {
      this.isOpening = false
      this.warming = undefined
      if (!this.closed) this.changed()
    })
  }
  get opening(): boolean {
    return this.isOpening
  }
  subscribe = (listener: () => void): () => void => this.runs.subscribe(listener)
  private changed() {
    this.runs.changed()
  }
  snapshot = (): ReadonlyArray<Run> => this.runs.values()
  /** A run parked for input never counts: it waits on the user, not on work. */
  get busy(): boolean {
    return this.runs.values().some((run) => running(run) || run.status === "queued")
  }
  has = (id: string): boolean => this.runs.has(id)
  get = (id: string): Run | undefined => this.runs.get(id)
  /** The payload schema of a run parked for input. */
  schema = (id: string): Schema.Top | undefined => this.schemas.get(id)
  /** The last discovery; `refresh` updates it in the background. */
  listed = (): ReadonlyArray<Listed> => this.cache
  /** A module flow listed after the host imported its modules: it runs after a restart. */
  unloaded = (name: string): boolean => {
    const flow = this.cache.find((each) => each.name === name)
    return flow !== undefined && !Extension.isAgent(flow) && this.imported !== undefined &&
      !this.imported.flows.has(name) && !this.imported.refused.has(name)
  }
  /** A flow's input field names once its module is imported; undefined before, and for an agent. */
  fields = (name: string): ReadonlyArray<string> | undefined => {
    if (!this.inputs.has(name)) return undefined
    const schema = this.inputs.get(name)
    return schema === undefined ? [] : Form.formFieldsFor(schema).map((field) => field.name)
  }
  /** The store's newest runs, whoever started them. */
  history = (): ReadonlyArray<Recorded> => this.recorded
  /** Why the newest discovery failed; cleared by the next one that succeeds. */
  failure = (): FlowDiscoveryFailed | undefined => this.discoveryFailure
  private discover(): Promise<ReadonlyArray<Listed>> {
    const version = ++this.discovery
    this.discoveredAt = -Infinity
    const pending = (async () => {
      let listed: ReadonlyArray<Listed>
      try {
        listed = await this.options.port!.discover()
      } catch (error) {
        if (version === this.discovery && !this.closed) {
          this.discoveryFailure = new FlowDiscoveryFailed(error)
          Log.write("flow.discovery", error)
          this.changed()
        }
        throw error
      }
      if (version === this.discovery && !this.closed) {
        this.cache = listed
        this.discoveryFailure = undefined
        this.discovered = true
        this.discoveredAt = Date.now()
        this.changed()
      }
      return listed
    })().finally(() => {
      if (this.discovering === pending) this.discovering = undefined
    })
    this.discovering = pending
    return pending
  }
  /** The last discovery, or undefined before the first one settled. */
  known = (): ReadonlyArray<Listed> | undefined => (this.discovered ? this.cache : undefined)
  /** Join an active scan, or reuse a successful listing within the caller's age bound. */
  listing = (options: { readonly maxAgeMs?: number } = {}): Promise<ReadonlyArray<Listed>> => {
    if (this.options.port === undefined || this.closed) return Promise.reject(new Error("Flows unavailable"))
    if (this.discovering !== undefined) return this.discovering
    if (Date.now() - this.discoveredAt < (options.maxAgeMs ?? 0)) return Promise.resolve(this.cache)
    return this.discover()
  }
  /**
   * What the coordinator sees of each flow: whether it is an agent, and its
   * input fields once a run imported its module (never imported for this).
   */
  describe = (keep: (flow: Listed) => boolean = () => true): ReadonlyArray<Described> =>
    this.cache.filter(keep).map((flow) => {
      const schema = this.inputs.get(flow.name)
      const input = Extension.isAgent(flow)
        ? [{ name: "args", type: "string", required: false }]
        : !this.inputs.has(flow.name)
        ? undefined
        : schema === undefined
        ? []
        : Form.formFieldsFor(schema).slice(0, 12).map((field) => ({
          name: field.name,
          type: field.kind,
          required: field.required
        }))
      return {
        name: flow.name,
        description: flow.description,
        agent: Extension.isAgent(flow),
        ...(input === undefined ? {} : { input })
      }
    })
  refresh = (): void => {
    const port = this.options.port
    if (port === undefined || this.closed) return
    // A failed listing keeps the last one and records `failure`; running a flow reports its own failure.
    this.discover().catch(() => {})
    port.runs?.().then((recorded) => {
      if (this.closed) return
      this.recorded = recorded
      this.changed()
    }, (error) => Log.write("flow.runs", error))
  }
  /** Writes a change to the current attempt; `event` moves the status. */
  private update(id: string, attempt: number, change: Partial<Omit<Run, "status">>, event?: Lifecycle.Event) {
    const run = this.runs.get(id)
    if (run === undefined || this.closed || this.attempts.get(id) !== attempt) return undefined
    const next = { ...run, ...(Object.hasOwn(change, "message") ? { failure: undefined } : {}), ...change }
    return event === undefined ? this.runs.put(next) : this.runs.move(next, event)
  }
  private fail(id: string, attempt: number, error: unknown) {
    if (
      this.runs.get(id)?.stopRequested && error instanceof FlowError && error.code === "stopped"
    ) {
      this.update(id, attempt, { endedAt: Date.now(), message: undefined }, "cancel")
      return
    }
    Log.write("flow.run", error)
    const failure = Failures.present("flow", error).sentence
    this.update(id, attempt, { endedAt: Date.now(), message: failure, failure }, "fail")
  }
  private attempt(id: string): number {
    const next = (this.attempts.get(id) ?? 0) + 1
    this.attempts.set(id, next)
    return next
  }
  request = (request: Request): { id: string; status: Run["status"] } => {
    if (this.closed) throw new TabError("closed", "Session closed")
    if (this.options.port === undefined) throw new TabError("flows_unavailable", "Flows unavailable")
    if (request.by === "agent" && this.cache.find((each) => each.name === request.flow)?.modelInvocable === false) {
      throw new FlowError("person_only", `${request.flow} is not for a model to start`, { subject: request.flow })
    }
    if (this.unloaded(request.flow)) throw unloaded(request.flow)
    const requested = JSON.stringify(request.input)
    const existing = request.id === undefined ? undefined : this.runs.get(request.id)
    if (existing !== undefined) {
      if (existing.flow !== request.flow || existing.requested !== requested) {
        throw new Error("Request id already belongs to another request")
      }
      return { id: existing.id, status: existing.status }
    }
    const id = request.id ?? `${request.flow}-${Date.now().toString(36)}`
    if (this.options.occupied?.(id)) throw new Error("Request id already belongs to a worker tab")
    // Persist FIRST; the receipt acknowledges only the request.
    const run = this.runs.create({
      id,
      flow: request.flow,
      by: request.by,
      input: request.input,
      requested,
      startedAt: Date.now()
    })
    if (run.status === "queued") {
      this.runs.enqueue(id, undefined)
      return { id, status: "queued" }
    }
    const attempt = this.attempt(id)
    queueMicrotask(() => void this.prepare(id, attempt))
    return { id, status: "requested" }
  }
  private async prepare(id: string, attempt: number) {
    if (this.runs.get(id)?.resumeRequested) return this.track(this.resumeExisting(id, attempt))
    const port = this.options.port!
    try {
      const listed = await this.discover()
      const run = this.runs.get(id)
      if (run === undefined || this.attempts.get(id) !== attempt || this.closed) return
      const found = listed.find((each) => each.name === run.flow)
      if (found === undefined) throw new FlowError("unknown_flow", `Unknown flow ${run.flow}`, { subject: run.flow })
      if (run.by === "agent" && !found.modelInvocable) {
        throw new FlowError("person_only", `${run.flow} is not for a model to start`, { subject: run.flow })
      }
      const schema = await port.input(run.flow).catch((error) => {
        // Listed, but the host imported its modules before the file existed.
        throw error instanceof FlowError && error.code === "unknown_flow" && !Extension.isAgent(found)
          ? unloaded(run.flow)
          : error
      })
      this.inputs.set(run.flow, schema)
      if (this.attempts.get(id) !== attempt || this.closed) return
      if (schema !== undefined && !Schema.is(schema)(run.input)) {
        this.schemas.set(id, schema)
        const fields = Form.formFieldsFor(schema)
        const missing = Form.missingLabels(fields, Form.draftFrom(fields, run.input, "json"))
        this.update(id, attempt, {
          message: missing.length === 0 ? "Invalid input" : `Needs: ${missing.join(", ")}`
        }, "input")
        return
      }
      await this.plan(id, attempt)
    } catch (error) {
      this.fail(id, attempt, error)
    }
  }
  private async plan(id: string, attempt: number) {
    const run = this.runs.get(id)!
    const card = await this.options.port!.plan(run.flow, run.input)
    if (this.attempts.get(id) !== attempt || this.closed) return
    await this.launch(id, attempt, card)
  }
  private launch(id: string, attempt: number, card: Card): Promise<void> {
    return this.track(this.start(id, attempt, card))
  }
  private track(task: Promise<void>): Promise<void> {
    this.launches.add(task)
    const settled = () => {
      this.launches.delete(task)
    }
    void task.then(settled, settled)
    return task
  }
  private async start(id: string, attempt: number, card: Card) {
    const controller = new AbortController()
    this.launching.set(id, controller)
    try {
      const runId = await this.options.port!.start(card, `flow:${id}`, controller.signal)
      const run = this.runs.get(id)!
      if (this.closed) {
        // Preserve the receipt even after the UI detached; retry must target this run.
        this.runs.move({ ...run, runId, message: interrupted, failure: undefined, endedAt: Date.now() }, "fail")
      } else {
        if (this.update(id, attempt, { runId, message: undefined, launchedAt: Date.now() }, "launch") === undefined) {
          return
        }
        this.follow(id, attempt, runId)
      }
      if (run.stopRequested) await this.stop(id, runId)
    } finally {
      this.launching.delete(id)
    }
  }
  private async resumeExisting(id: string, attempt: number): Promise<void> {
    const run = this.runs.get(id)
    if (run?.runId === undefined || this.closed) return
    this.update(
      id,
      attempt,
      { resumeRequested: undefined, message: undefined, launchedAt: Date.now() },
      run.status === "requested" ? "launch" : undefined
    )
    try {
      // Retry on a parked run is Continue: it approves the open request, such as a budget raise.
      const gate = openGate(this.events.get(id) ?? [])
      if (gate !== undefined && this.options.port!.approve !== undefined) {
        await this.options.port!.approve(gate.approval)
      }
      const receipt = await this.options.port!.resume(run.runId)
      if ("runId" in receipt) {
        if (this.closed) {
          const current = this.runs.get(id)!
          this.runs.move({
            ...current,
            runId: receipt.runId,
            message: interrupted,
            failure: undefined,
            endedAt: Date.now()
          }, "fail")
        } else if (this.update(id, attempt, { runId: receipt.runId }) !== undefined) {
          this.follow(id, attempt, receipt.runId)
        }
        if (this.runs.get(id)?.stopRequested) await this.stop(id, receipt.runId)
      } else this.settle(id, attempt, receipt)
    } catch (error) {
      this.fail(id, attempt, error)
    }
  }
  private async stop(id: string, runId: string) {
    try {
      await this.options.port!.cancel(runId)
    } catch (error) {
      const current = this.runs.get(id)
      if (current !== undefined && (active(current) || current.status === "parked" || this.closed)) {
        this.runs.put({ ...current, message: Failures.present("stop", error).sentence })
      }
    }
  }
  private follow(id: string, attempt: number, runId: string) {
    this.events.set(id, [])
    this.loaded.add(id)
    const watch = this.options.port!.watch(runId, (event) => {
      if (this.attempts.get(id) !== attempt) return
      this.events.get(id)?.push(event)
      const status = this.runs.get(id)?.status
      if (event.kind === "control.run.parked") this.update(id, attempt, {}, "park")
      else if (event.kind === "control.run.waiting-approval" && (status === "running" || status === "waiting")) {
        this.update(id, attempt, {}, "block")
      } else if (event.kind === "control.run.running" && (status === "waiting" || status === "parked")) {
        // A remote resume is already executing and cannot be queued by this UI.
        this.runs.put({ ...this.runs.get(id)!, status: "running", message: undefined })
      } else if (event.kind === "control.agent.suspended") {
        const reason = (event.payload as { reason?: { message?: unknown } } | null)?.reason
        if (typeof reason?.message === "string") this.update(id, attempt, { message: reason.message })
        else this.changed()
      } else this.changed()
    })
    this.watches.set(id, watch)
    watch.done.then((settled) => {
      if (this.watches.get(id) === watch) this.watches.delete(id)
      this.settle(id, attempt, settled)
    }, (error) => {
      if (this.watches.get(id) === watch) this.watches.delete(id)
      this.fail(id, attempt, error)
    })
  }
  private settle(id: string, attempt: number, settled: Settled) {
    const endedAt = Date.now()
    if (settled.kind === "done") {
      this.update(id, attempt, { answer: settled.answer, endedAt, message: undefined }, "done")
    } else if (settled.kind === "failed") {
      const failure = Failures.remoteFlowFailure(settled.message)
      this.update(id, attempt, { message: settled.message, failure, endedAt }, "fail")
    } else this.update(id, attempt, { endedAt, message: undefined }, "cancel")
  }
  /** Supplies the input a run parked for, then plans it. */
  fill = (id: string, input: Record<string, unknown>): void => {
    const run = this.runs.get(id)
    if (run?.status !== "input" || this.closed) return
    const attempt = this.attempt(id)
    this.runs.move({ ...run, input, message: undefined }, "fill")
    void this.plan(id, attempt).catch((error) => this.fail(id, attempt, error))
  }
  cancel = (id: string): void => {
    const run = this.runs.get(id)
    if (run === undefined || !actions(run).stop) return
    if (this.launching.has(id)) {
      this.runs.put({ ...run, stopRequested: true, message: "Stopping" })
      this.launching.get(id)!.abort()
      return
    }
    if (run.status === "queued" && run.resumeRequested && run.runId !== undefined) {
      this.runs.dequeue(id)
      this.runs.put({ ...run, status: "parked", stopRequested: true, resumeRequested: undefined })
      this.follow(id, this.attempts.get(id)!, run.runId)
      void this.stop(id, run.runId)
      return
    }
    if (
      run.runId !== undefined &&
      (run.status === "running" || run.status === "waiting" || run.status === "parked" || run.resumeRequested)
    ) {
      // The watch settles the status; a refused cancel keeps it running.
      this.runs.put({ ...run, stopRequested: true })
      void this.stop(id, run.runId)
      return
    }
    this.attempt(id)
    this.runs.move({ ...run, endedAt: Date.now() }, "cancel")
  }
  /** Runs a failed or stopped run again; the receipt says whether it waits for a seat. */
  retry = (id: string): { id: string; status: Run["status"] } => {
    const run = this.runs.get(id)
    if (run === undefined) throw new TabError("unknown_tab", "Unknown tab", id)
    if (!actions(run).retry && !actions(run).continue) {
      throw new TabError(
        "not_retryable",
        `Only a failed, stopped, or parked run can be retried; ${id} is ${run.status}`,
        id
      )
    }
    if (this.closed) throw new TabError("closed", "Session closed")
    if (this.options.port === undefined) throw new TabError("flows_unavailable", "Flows unavailable")
    const { endedAt: _ended, answer: _answer, launchedAt: _launched, failure: _failure, ...previous } = run
    // Each retry is new work with its own clock, so it is estimated and scored on its own.
    const resume = run.runId !== undefined &&
      (run.status === "parked" || run.message === interrupted || run.resumeRequested)
    const rest = {
      ...previous,
      attempt: (run.attempt ?? 1) + 1,
      startedAt: Date.now(),
      resumeRequested: resume ? true as const : undefined
    }
    const attempt = this.attempt(id)
    this.watches.get(id)?.close()
    this.watches.delete(id)
    if (this.runs.full()) {
      const next = resume ? rest : { ...rest, runId: undefined, stopRequested: undefined }
      this.runs.move({ ...next, message: undefined }, run.status === "parked" ? "wake" : "retry")
      this.runs.enqueue(id, undefined)
      return { id, status: "queued" }
    }
    if (run.runId !== undefined && run.stopRequested && run.status === "failed") {
      this.runs.move({ ...rest, message: undefined }, "reattach")
      this.follow(id, attempt, run.runId)
      void this.stop(id, run.runId)
      return { id, status: "running" }
    }
    if (resume) {
      this.runs.move({ ...rest, message: undefined }, run.status === "parked" ? "wake" : "reattach")
      void this.track(this.resumeExisting(id, attempt))
      return { id, status: "running" }
    }
    const { runId: _runId, stopRequested: _stop, ...fresh } = rest
    this.runs.move({ ...fresh, message: undefined }, "retry")
    queueMicrotask(() => void this.prepare(id, attempt))
    return { id, status: "requested" }
  }
  /** A run's events as far as its watch and history read them, in order. */
  journal = (id: string): ReadonlyArray<ControlEvent> => this.events.get(id) ?? []
  /** A run's calls and steps as far as its events show, in order: the graph's children of a flow run. */
  nodes = (id: string): ReadonlyArray<Step> => this.projected(id).map(({ details: _details, ...step }) => step)
  /** An agent's flow calls, then a module flow's steps, each with its recorded output. */
  private projected(id: string): ReadonlyArray<Step & { readonly details: ReadonlyArray<Panels.Block> }> {
    const events = this.events.get(id) ?? []
    const run = this.runs.get(id)
    const code = (value: unknown): ReadonlyArray<Panels.Block> => [{
      kind: "code",
      language: "json",
      code: (JSON.stringify(value ?? null, null, 2) ?? "null").slice(0, 200_000)
    }]
    return [
      ...NodeOutput.project(events).filter((node) => node.nodeId !== NodeOutput.resultNodeId).map((node) => ({
        id: node.nodeId,
        label: node.flowName,
        status: node.outcome === "success"
          ? "done" as const
          : node.outcome === "failure"
          ? "failed" as const
          : "running" as const,
        details: code(node.value ?? node.message)
      })),
      ...steps(events, run?.flow ?? "", run === undefined || Lifecycle.settled(run.status)).map((step) => ({
        ...step,
        details: step.preview === undefined ? [] : [{ kind: "code" as const, code: step.preview.slice(0, 200_000) }]
      }))
    ]
  }
  /** Read restored events outside render. A failed read is retryable on the next activation. */
  hydrate = async (id: string): Promise<void> => {
    const run = this.runs.get(id)
    if (run?.runId === undefined || this.loaded.has(id) || this.closed || this.options.port === undefined) return
    this.loaded.add(id)
    const attempt = this.attempts.get(id)
    try {
      const events = await this.options.port.events(run.runId)
      if (this.closed || this.attempts.get(id) !== attempt || this.events.get(id)?.length) return
      this.events.set(id, [...events])
      this.historyFailures.delete(id)
      this.changed()
    } catch (error) {
      if (this.closed || this.attempts.get(id) !== attempt) return
      this.loaded.delete(id)
      this.historyFailures.set(id, "Flow history unavailable")
      Log.write("flow.history", error)
      this.changed()
    }
  }
  panel = (id: string): Panels.Panel => {
    const run = this.runs.get(id)
    if (run === undefined) return { id: `flow:${id}`, title: id, summary: "Unknown run.", rows: [] }
    const summary = this.historyFailures.get(id) ?? (run.status === "failed" && run.message !== undefined
      ? `failed: ${run.message}`
      : run.message) ??
      (run.status === "done"
        ? doneWords(run)
        : run.status === "requested"
        ? this.opening ? "Opening flows" : "requested"
        : run.status === "cancelled"
        ? "stopped"
        : run.status === "parked"
        ? openGate(this.events.get(id) ?? [])?.question ?? "parked"
        : run.status === "failed"
        ? "failed"
        : run.status === "input"
        ? "asks"
        : run.status)
    const nodes = this.projected(id).map(({ preview: _preview, ...step }) => step)
    const act = run.status === "input"
      ? [{ id: "act", label: "Fill in", details: [], action: { label: "Fill in", prompt: "" } }]
      : []
    // The head holds a one-line answer; a longer one keeps its whole text in a row.
    const result = run.answer !== undefined && (run.answer.length > 200 || run.answer.trim().includes("\n"))
      ? [{
        id: NodeOutput.resultNodeId,
        label: "Result",
        status: "done" as const,
        details: [{ kind: "code" as const, code: run.answer.slice(0, 200_000) }]
      }]
      : []
    const deadline = Deadline.row(this.events.get(id) ?? [], !Lifecycle.settled(run.status))
    return { id: `flow:${id}`, title: run.flow, summary, rows: [...act, ...deadline, ...nodes, ...result] }
  }
  read = (id: string) => {
    const run = this.runs.get(id)
    if (run === undefined) throw new TabError("unknown_tab", "Unknown tab", id)
    const panel = this.panel(id)
    return {
      id: run.id,
      flow: run.flow,
      status: run.status,
      answer: run.answer?.slice(0, 8000),
      message: run.message,
      steps: panel.rows.slice(-8).map((row) => ({ label: row.label, status: row.status }))
    }
  }
  context = (): string => {
    const own = new Set(this.runs.values().flatMap((run) => (run.runId === undefined ? [] : [run.runId])))
    return JSON.stringify([
      ...this.runs.values().map(({ id, flow, status, answer, message }) => ({
        id,
        flow,
        status,
        answer: answer?.slice(0, 6000),
        message: message?.slice(0, 500)
      })),
      ...this.recorded.filter((run) => !own.has(run.runId)).map((run) => ({
        id: run.runId,
        flow: run.flow,
        status: run.status,
        by: "cli"
      }))
    ])
  }
  dispose = async (): Promise<void> => {
    this.closed = true
    this.runs.close()
    for (const controller of this.launching.values()) controller.abort()
    for (const watch of this.watches.values()) watch.close()
    this.watches.clear()
    await Promise.allSettled(this.launches)
  }
}
