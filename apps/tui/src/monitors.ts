/**
 * Monitors: standing watches the agent sets up on a source.
 *
 * Each tick observes the source. An unchanged observation costs nothing. A
 * changed one goes to Jev, which answers one yes/no question: is this change
 * notable for what the user asked to watch? Only a yes asks Luna for a
 * one-line update, which `deliver` shows and the session file keeps.
 *
 * There is no fallback. A Jev, Luna or source failure is a typed `Failure`:
 * the monitor settles `failed`, the failure is delivered like an update, and
 * creating the same id again restarts it.
 */
import * as Classifier from "@smthrs/model/Classifier"
import * as Evaluator from "@smthrs/model/Evaluator"
import { Effect } from "effect"
import type * as Session from "./session.ts"

export type Source =
  /** A background worker tab's transcript. */
  | { readonly kind: "tab"; readonly id: string }
  /** A Smithers flow run started with `smithers.run`. */
  | { readonly kind: "run"; readonly id: string }
  /** A shell command's output, run in the working directory on each tick. */
  | { readonly kind: "shell"; readonly command: string }

export type Trigger =
  /** Tick when the source reports a change. Tabs and runs only. */
  | { readonly kind: "events" }
  | { readonly kind: "interval"; readonly seconds: number }

export type Failure =
  | { readonly _tag: "JevFailed"; readonly code: Evaluator.EvaluatorErrorCode; readonly message: string }
  | { readonly _tag: "LunaFailed"; readonly message: string }
  | { readonly _tag: "SourceFailed"; readonly message: string }
  /** The approval gate refused a shell source on restore. */
  | { readonly _tag: "Refused"; readonly message: string }

/** Tagged like its failure, so a flow call that throws it reads as that failure. */
export class MonitorError extends Error {
  readonly _tag: Failure["_tag"]
  readonly code: string | undefined
  constructor(readonly failure: Failure) {
    super(failure.message)
    this._tag = failure._tag
    this.code = failure._tag === "JevFailed" ? failure.code : undefined
  }
}

export interface Monitor {
  readonly id: string
  readonly title: string
  /** What counts as notable, in the user's words. */
  readonly watch: string
  readonly source: Source
  readonly trigger: Trigger
  readonly status: "active" | "stopped" | "failed"
  readonly failure?: Failure
  /** The last observation, so a reload does not re-announce it. */
  readonly seen?: string
  readonly updates: number
  readonly createdAt: number
  readonly endedAt?: number
}

export interface Request {
  readonly id: string
  readonly title: string
  readonly watch: string
  readonly source: Source
  readonly trigger?: Trigger
}

/** What Jev judges and Luna writes from. */
export interface Judged {
  readonly watch: string
  readonly before: string
  readonly after: string
}

export type Delivery =
  | { readonly _tag: "update"; readonly id: string; readonly title: string; readonly text: string; readonly at: number }
  | {
    readonly _tag: "failed"
    readonly id: string
    readonly title: string
    readonly failure: Failure
    readonly at: number
  }

export interface Ports {
  /** Whether this host binds Jev; without it a monitor is refused at creation. */
  readonly judged: boolean
  readonly observe: (source: Source, signal: AbortSignal) => Promise<string>
  /** Jev. Rejects with a `MonitorError` carrying `JevFailed`. */
  readonly judge: (input: Judged) => Promise<boolean>
  /** Luna. */
  readonly compose: (input: Judged) => Promise<string>
  readonly deliver: (delivery: Delivery) => void
  readonly persist: (record: Session.Record) => void
  /** Change notifications for `events` triggers. */
  readonly subscribe: (source: Source, listener: () => void) => () => void
  readonly every?: (ms: number, run: () => void) => () => void
  /** How long an `events` trigger waits for a burst of changes to settle. Default 2000. */
  readonly settleMs?: number
  readonly restored?: ReadonlyArray<Monitor>
  /**
   * The approval gate for a restored shell source, which `monitor.create`
   * passed under the approval mode of its own session. Rejects when refused;
   * the monitor then fails `Refused` without running the command. Absent
   * means this host gates nothing.
   */
  readonly authorize?: (monitor: Monitor) => Promise<void>
}

/** The observation kept and compared: its tail, so a long log stays bounded. */
export const maxObservation = 4000
export const maxActive = 8
export const minSeconds = 10
export const maxSeconds = 86_400

const failedWith = (error: unknown, fallback: (message: string) => Failure): Failure =>
  error instanceof MonitorError ? error.failure : fallback(error instanceof Error ? error.message : String(error))

export class Monitors {
  private monitors = new Map<string, Monitor>()
  private stops = new Map<string, () => void>()
  private observations = new Map<string, AbortController>()
  private ticks = new Map<string, { readonly generation: number | undefined; readonly task: Promise<void> }>()
  private generations = new Map<string, number>()
  private listeners = new Set<() => void>()
  private closed = false
  constructor(private ports: Ports) {
    for (const monitor of ports.restored ?? []) {
      this.monitors.set(monitor.id, monitor)
      if (monitor.status !== "active") continue
      if (monitor.source.kind !== "shell" || ports.authorize === undefined) {
        this.arm(monitor)
        continue
      }
      // Not armed until the gate answers: the command never runs unapproved.
      const generation = this.bump(monitor.id)
      ports.authorize(monitor).then(
        () => {
          const current = this.monitors.get(monitor.id)
          if (current?.status === "active" && this.generations.get(monitor.id) === generation && !this.closed) {
            this.arm(current)
          }
        },
        (error) =>
          this.fail(monitor.id, generation, {
            _tag: "Refused",
            message: error instanceof Error ? error.message : String(error)
          })
      )
    }
  }
  subscribe = (listener: () => void): () => void => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  private save(monitor: Monitor) {
    this.ports.persist({ type: "monitor", monitor })
    this.monitors.set(monitor.id, monitor)
    for (const listener of this.listeners) listener()
  }
  /** Persists and arms the monitor; returns before anything is observed. */
  create = (request: Request): { id: string; status: Monitor["status"] } => {
    if (this.closed) throw new Error("Session closed")
    if (!this.ports.judged) {
      throw new MonitorError({
        _tag: "JevFailed",
        code: "unreachable",
        message: "Connect a subscription seat to judge this run."
      })
    }
    const trigger = request.trigger ??
      (request.source.kind === "shell" ? { kind: "interval", seconds: 60 } : { kind: "events" })
    if (trigger.kind === "events" && request.source.kind === "shell") {
      throw new Error("A shell monitor needs an interval trigger")
    }
    if (trigger.kind === "interval" && !(trigger.seconds >= minSeconds && trigger.seconds <= maxSeconds)) {
      throw new Error(`An interval is ${minSeconds} to ${maxSeconds} seconds`)
    }
    const definition = JSON.stringify([request.title, request.watch, request.source, trigger])
    const existing = this.monitors.get(request.id)
    if (existing !== undefined) {
      if (JSON.stringify([existing.title, existing.watch, existing.source, existing.trigger]) !== definition) {
        throw new Error("Monitor id already belongs to another monitor")
      }
      if (existing.status === "active") return { id: existing.id, status: existing.status }
    }
    if ([...this.monitors.values()].filter((monitor) => monitor.status === "active").length >= maxActive) {
      throw new Error(`${maxActive} monitors are active; stop one first`)
    }
    const monitor: Monitor = {
      id: request.id,
      title: request.title,
      watch: request.watch,
      source: request.source,
      trigger,
      status: "active",
      updates: existing?.updates ?? 0,
      createdAt: Date.now()
    }
    this.save(monitor)
    this.arm(monitor)
    return { id: monitor.id, status: "active" }
  }
  private bump(id: string): number {
    const generation = (this.generations.get(id) ?? 0) + 1
    this.generations.set(id, generation)
    return generation
  }
  private arm(monitor: Monitor) {
    this.disarm(monitor.id)
    this.bump(monitor.id)
    if (monitor.trigger.kind === "interval") {
      const every = this.ports.every ?? ((ms, run) => {
        const timer = setInterval(run, ms)
        return () => clearInterval(timer)
      })
      const stop = every(monitor.trigger.seconds * 1000, () => void this.tick(monitor.id))
      this.stops.set(monitor.id, stop)
      // The first tick records the baseline, so the first change is judged against now.
      queueMicrotask(() => void this.tick(monitor.id))
      return
    }
    let pending: ReturnType<typeof setTimeout> | undefined
    const unsubscribe = this.ports.subscribe(monitor.source, () => {
      if (pending !== undefined) return
      pending = setTimeout(() => {
        pending = undefined
        void this.tick(monitor.id)
      }, this.ports.settleMs ?? 2000)
    })
    this.stops.set(monitor.id, () => {
      if (pending !== undefined) clearTimeout(pending)
      unsubscribe()
    })
    queueMicrotask(() => void this.tick(monitor.id))
  }
  private disarm(id: string) {
    this.stops.get(id)?.()
    this.stops.delete(id)
    this.observations.get(id)?.abort()
  }
  /**
   * One observation, judged if it changed. Ticks of one monitor never
   * overlap. A tick of the current generation joins the running one; a tick
   * after a restart waits for the old generation's tick, whose result is
   * dropped, and then runs, so the restart's baseline is never lost.
   */
  tick = (id: string): Promise<void> => {
    const generation = this.generations.get(id)
    const running = this.ticks.get(id)
    if (running !== undefined && running.generation === generation) return running.task
    const task: Promise<void> = (running?.task ?? Promise.resolve()).then(() => this.run(id)).finally(() => {
      if (this.ticks.get(id)?.task === task) this.ticks.delete(id)
    })
    this.ticks.set(id, { generation, task })
    return task
  }
  private async run(id: string): Promise<void> {
    const start = this.monitors.get(id)
    if (start?.status !== "active" || this.closed) return
    const generation = this.generations.get(id)
    const current = () => {
      const monitor = this.monitors.get(id)
      return monitor?.status === "active" && this.generations.get(id) === generation && !this.closed
        ? monitor
        : undefined
    }
    let after: string
    const observation = new AbortController()
    this.observations.set(id, observation)
    try {
      after = (await this.ports.observe(start.source, observation.signal)).slice(-maxObservation)
    } catch (error) {
      return this.fail(id, generation, failedWith(error, (message) => ({ _tag: "SourceFailed", message })))
    } finally {
      if (this.observations.get(id) === observation) this.observations.delete(id)
    }
    const observed = current()
    if (observed === undefined || observed.seen === after) return
    if (observed.seen === undefined) return this.save({ ...observed, seen: after })
    const judged: Judged = { watch: observed.watch, before: observed.seen, after }
    let notable: boolean
    try {
      notable = await this.ports.judge(judged)
    } catch (error) {
      return this.fail(
        id,
        generation,
        failedWith(error, (message) => ({ _tag: "JevFailed", code: "unreachable", message }))
      )
    }
    const decided = current()
    if (decided === undefined) return
    if (!notable) return this.save({ ...decided, seen: after })
    let text: string
    try {
      text = (await this.ports.compose(judged)).replace(/\s+/g, " ").trim().slice(0, 240)
      if (text === "") throw new Error("Luna wrote nothing")
    } catch (error) {
      return this.fail(id, generation, failedWith(error, (message) => ({ _tag: "LunaFailed", message })))
    }
    const composed = current()
    if (composed === undefined) return
    const at = Date.now()
    this.save({ ...composed, seen: after, updates: composed.updates + 1 })
    this.ports.persist({ type: "monitor-update", at, id, title: composed.title, text })
    this.ports.deliver({ _tag: "update", id, title: composed.title, text, at })
  }
  private fail(id: string, generation: number | undefined, failure: Failure) {
    const monitor = this.monitors.get(id)
    if (monitor?.status !== "active" || this.generations.get(id) !== generation || this.closed) return
    this.disarm(id)
    const at = Date.now()
    this.save({ ...monitor, status: "failed", failure, endedAt: at })
    this.ports.persist({ type: "monitor-update", at, id, title: monitor.title, text: message(failure), failed: true })
    this.ports.deliver({ _tag: "failed", id, title: monitor.title, failure, at })
  }
  stop = (id: string): { id: string; status: Monitor["status"] } => {
    const monitor = this.monitors.get(id)
    if (monitor === undefined) throw new Error("Unknown monitor")
    if (monitor.status !== "active") return { id, status: monitor.status }
    this.disarm(id)
    this.bump(id)
    this.save({ ...monitor, status: "stopped", endedAt: Date.now() })
    return { id, status: "stopped" }
  }
  list = (): ReadonlyArray<Omit<Monitor, "seen">> =>
    [...this.monitors.values()].map(({ seen: _seen, ...monitor }) => monitor)
  context = (): string =>
    JSON.stringify(
      this.list().map(({ id, title, status, updates, failure }) => ({
        id,
        title,
        status,
        updates,
        ...(failure === undefined ? {} : { failure: message(failure) })
      }))
    )
  dispose = (): Promise<void> => {
    this.closed = true
    for (const id of [...this.stops.keys()]) this.disarm(id)
    return Promise.allSettled([...this.ticks.values()].map((tick) => tick.task)).then(() => {})
  }
}

/** A failure as one line. */
export const message = (failure: Failure): string =>
  failure._tag === "JevFailed"
    ? `Jev failed (${failure.code}): ${failure.message}`
    : failure._tag === "LunaFailed"
    ? `Luna failed: ${failure.message}`
    : failure._tag === "Refused"
    ? `Refused: ${failure.message}`
    : `Source failed: ${failure.message}`

const question = {
  notable: Classifier.boolean({
    instructions:
      "The user asked to be told when this happens: `watching`. Compare `before` with `after`. Is there a new development in `after` that the user would want to hear about now? Routine progress, repeated output and unrelated changes are not notable.",
    criteria: { true: "notable: tell the user now", false: "routine: stay quiet" }
  })
}

/** The Jev judge over an evaluator: one boolean question, every failure typed. */
export const jev = (
  evaluate: (request: Evaluator.Request) => Promise<Evaluator.Response>
) =>
async (input: Judged): Promise<boolean> => {
  let response: Evaluator.Response
  try {
    response = await evaluate({
      state: { watching: input.watch, before: input.before, after: input.after },
      questions: question
    })
  } catch (error) {
    const typed = error as Partial<Evaluator.EvaluatorError>
    throw new MonitorError(
      typeof typed?.code === "string"
        ? {
          _tag: "JevFailed",
          code: typed.code,
          message: Evaluator.publicMessage({ code: typed.code, message: String(typed.message) })
        }
        : { _tag: "JevFailed", code: "unreachable", message: error instanceof Error ? error.message : String(error) }
    )
  }
  return Effect.runPromise(
    Classifier.decodeAnswers(question, response.answers).pipe(
      Effect.map((answers) => answers.notable.value),
      Effect.mapError(() =>
        new MonitorError({
          _tag: "JevFailed",
          code: "invalid_answer",
          message: "Jev did not answer the notable question"
        })
      )
    )
  )
}

/** What Luna is told. */
export const composeSystem =
  "Write one line (at most 120 characters) telling the user the notable update. Plain English, the fact itself, no preamble."
export const composeText = (input: Judged): string =>
  `Watching for: ${input.watch}\n\nBefore:\n${input.before}\n\nAfter:\n${input.after}`

/**
 * Reads a source as text. A tab or run reads as its status, summary and step
 * labels, never streamed tokens, so a change means progress and not typing.
 */
export const observer = (options: {
  readonly tab: (
    id: string
  ) => {
    status: string
    summary?: string
    message?: string
    answer?: string
    turns: ReadonlyArray<{ label: string; status?: string }>
  }
  readonly run: (
    id: string
  ) => { status: string; message?: string; answer?: string; steps: ReadonlyArray<{ label: string; status?: string }> }
  readonly shell: (command: string, signal?: AbortSignal) => Promise<{ output: string; exitCode: number | null }>
}) =>
async (source: Source, signal?: AbortSignal): Promise<string> => {
  if (source.kind === "shell") {
    const result = await options.shell(source.command, signal)
    return `${result.output}\n(exit ${result.exitCode ?? "killed"})`
  }
  const read = source.kind === "tab" ? options.tab(source.id) : options.run(source.id)
  const steps = "turns" in read ? read.turns : read.steps
  return [
    `status: ${read.status}`,
    ...("summary" in read && read.summary !== undefined ? [`summary: ${read.summary}`] : []),
    ...(read.message === undefined ? [] : [`message: ${read.message}`]),
    ...steps.map((step) => `- ${step.status ?? ""} ${step.label}`),
    ...(read.answer === undefined ? [] : [`answer: ${read.answer}`])
  ].join("\n")
}
