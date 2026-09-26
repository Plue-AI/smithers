/**
 * Time and token estimates for chat turns, worker tabs and flow runs: the
 * first instance of the self-improving loop in `improve.ts`.
 *
 * Repeated work (a flow, a chat turn on one seat) is estimated from its own
 * history. Novel work (a delegated task, a flow that never ran) asks a model
 * with the most similar past tasks (word overlap on their subjects) and the
 * model's own scored errors in the prompt. A model that fails or answers
 * nothing usable is recorded as a typed failure before the class median
 * stands in. Every estimate is scored when the work settles, and the scores
 * calibrate the next one.
 */
import { existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import type * as Flows from "./flows.ts"
import * as Improve from "./improve.ts"
import * as Session from "./session.ts"
import type * as Workspace from "./workspace.ts"

export type Kind = "turn" | "delegate" | "flow"

export interface Work {
  readonly id: string
  readonly kind: Kind
  /** The reference class: `flow:<name>`, `turn:<seat>`, `delegate`. */
  readonly key: string
  readonly subject: string
  /** Anything else that helps a model estimate: a flow's description. */
  readonly context?: string
  readonly startedAt: number
}

/** Why the model produced no estimate. */
export type FailureReason = "model-error" | "unusable-answer"

export interface Estimate {
  readonly ms: number
  readonly tokens?: number
  readonly lowMs: number
  readonly highMs: number
  readonly method: string
  /** Scored predictions that calibrated it. */
  readonly basis: number
}

export type Model = (request: { readonly system: string; readonly prompt: string }) => Promise<string>

export interface Item {
  readonly id: string
  readonly title: string
  readonly status: string
  /** When the work itself began; queued work has not. */
  readonly startedAt: number
  /** The estimate's id when it differs from `id`. */
  readonly estimate?: string
  /** Waits FIFO for one of `seats` worker seats. */
  readonly queued?: boolean
}

export const ledgerFile = (cwd: string): string => join(Session.directory(cwd), "evals", "estimates.jsonl")
export const tabId = (tab: Workspace.Tab): string => `tab:${tab.file}`
/** One per attempt: a retry or resume is new work, estimated and scored on its own. */
export const runId = (run: Flows.Run): string => `flow:${run.id}:${run.attempt ?? 1}:${run.startedAt}`
/** When a tab's work began: its launch, not its request, so queue time is not work. */
export const tabStart = (tab: Workspace.Tab): number => tab.launchedAt ?? tab.startedAt

/** The general estimation prompt. */
export const system =
  `You estimate how long a task will take an autonomous coding agent, from request to final answer, and how many model tokens it will spend (input plus output, summed over every model call).

1. Choose the reference class: the past tasks below most similar in kind (investigation, bug fix, feature, refactor, review, flow run) and in size.
2. Start from their actual durations and tokens, not from how easy the task sounds.
3. Adjust for scope: packages and files touched, tests and builds to run, unknowns to investigate, approvals to wait on.
4. Correct for your past errors: actual / estimate above 1 means you have been estimating too low.
5. Give the median outcome, not the best case, and an 80% interval.

Reply with only JSON: {"minutes": number, "tokens": number, "low_minutes": number, "high_minutes": number}`

const minute = 60_000
const examples = 12

const words = (text: string): Set<string> =>
  new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 2))
/** Jaccard overlap of the subjects' words: cheap, deterministic, good enough to rank a reference class. */
export const similarity = (a: string, b: string): number => {
  const left = words(a)
  const right = words(b)
  if (left.size === 0 || right.size === 0) return 0
  let shared = 0
  for (const word of left) if (right.has(word)) shared++
  return shared / (left.size + right.size - shared)
}
/** The `count` past observations most similar to `subject`, newest breaking ties, returned oldest first. */
export const nearest = (
  subject: string,
  past: ReadonlyArray<Improve.Observation>,
  count: number
): ReadonlyArray<Improve.Observation> =>
  past
    .map((observation, index) => ({ observation, index, score: similarity(subject, observation.subject) }))
    .sort((a, b) => b.score - a.score || b.index - a.index)
    .slice(0, count)
    .sort((a, b) => a.index - b.index)
    .map((ranked) => ranked.observation)

export const duration = (ms: number): string => {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.round(seconds / 60)
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h${minutes % 60 === 0 ? "" : `${minutes % 60}m`}`
}
export const count = (tokens: number): string =>
  tokens >= 1_000_000
    ? `${Number((tokens / 1_000_000).toFixed(1))}M`
    : tokens >= 1000
    ? `${Math.round(tokens / 1000)}k`
    : `${Math.round(tokens)}`

/**
 * What the model is told: the task, its context, the most similar finished
 * tasks of its kind, and the model's own error stats. Examples show the
 * model's earlier estimate only where the model made it, and the error ratio
 * is fitted on the model method alone, so history and class estimates never
 * pose as the model's.
 */
export const prompt = (work: Work, ledger: Improve.Ledger): string => {
  const past = nearest(
    work.subject,
    ledger.observations((observation) => observation.kind === work.kind && observation.outcome === "done"),
    examples
  )
  const lines = past.map((observation) => {
    const prediction = ledger.prediction(observation.id)
    const estimated = prediction?.method === "model" ? prediction.value.ms : undefined
    const took = observation.actual.ms === undefined ? "unknown" : duration(observation.actual.ms)
    const tokens = observation.actual.tokens === undefined ? "" : ` | ${count(observation.actual.tokens)} tokens`
    const subject = observation.subject.replace(/\s+/g, " ").trim().slice(0, 200)
    return `- ${subject} | ${estimated === undefined ? "" : `estimated ${duration(estimated)}, `}took ${took}${tokens}`
  })
  const stats = ledger.stats((prediction) => prediction.kind === work.kind && prediction.method === "model", [
    "ms",
    "tokens"
  ])
  const bias = [
    stats.bias.ms === undefined ? undefined : `time ${stats.bias.ms.toFixed(2)}x`,
    stats.bias.tokens === undefined ? undefined : `tokens ${stats.bias.tokens.toFixed(2)}x`
  ].filter((part) => part !== undefined)
  return [
    `Task (${work.kind}):\n${work.subject.slice(0, 4000)}`,
    ...(work.context === undefined || work.context === "" ? [] : [`Context:\n${work.context.slice(0, 2000)}`]),
    `Most similar past tasks, newest last:\n${lines.length === 0 ? "(none yet)" : lines.join("\n")}`,
    `Your past estimates, actual / estimate (median of ${stats.n}): ${
      bias.length === 0 ? "none scored yet" : bias.join(", ")
    }.`
  ].join("\n\n")
}

/** The model's JSON answer as raw metrics, or undefined when it is not usable. */
export const parse = (
  text: string
): { raw: Improve.Metrics; low?: Improve.Metrics; high?: Improve.Metrics } | undefined => {
  const match = /\{[\s\S]*\}/.exec(text)
  if (match === null) return undefined
  try {
    const value = JSON.parse(match[0]) as Record<string, unknown>
    const positive = (field: unknown) =>
      typeof field === "number" && Number.isFinite(field) && field > 0 ? field : undefined
    const minutes = positive(value.minutes)
    if (minutes === undefined) return undefined
    const tokens = positive(value.tokens)
    const low = positive(value.low_minutes)
    const high = positive(value.high_minutes)
    return {
      raw: { ms: minutes * minute, ...(tokens === undefined ? {} : { tokens }) },
      ...(low === undefined ? {} : { low: { ms: low * minute } }),
      ...(high === undefined ? {} : { high: { ms: high * minute } })
    }
  } catch {
    return undefined
  }
}

/** Tokens a transcript's model calls spent, or undefined when it recorded none. */
export const usage = (records: ReadonlyArray<Session.Record>): number | undefined => {
  let total: number | undefined
  for (const record of records) {
    if (record.type !== "event" || record.event._tag !== "model-settled") continue
    const spent = record.event.usage as
      | { totalTokens?: number; inputTokens?: number; outputTokens?: number }
      | undefined
    const tokens = spent?.totalTokens ??
      (spent === undefined ? undefined : (spent.inputTokens ?? 0) + (spent.outputTokens ?? 0))
    if (tokens !== undefined) total = (total ?? 0) + tokens
  }
  return total
}
/**
 * Time a transcript spent working: each request to its outcome, summed.
 * Idle time between turns, and queue time before the first, is not work.
 */
export const worked = (records: ReadonlyArray<Session.Record>): number | undefined => {
  let total: number | undefined
  let open: number | undefined
  for (const record of records) {
    if (record.type === "user" && open === undefined) open = record.at
    if (record.type === "outcome" && open !== undefined) {
      total = (total ?? 0) + Math.max(0, record.at - open)
      open = undefined
    }
  }
  return total
}
const load = (file: string): ReadonlyArray<Session.Record> => {
  try {
    return Session.load(file)
  } catch {
    return []
  }
}

const present = (value: Improve.Prediction): Estimate => ({
  ms: value.value.ms!,
  ...(value.value.tokens === undefined ? {} : { tokens: value.value.tokens }),
  lowMs: value.low.ms!,
  highMs: value.high.ms!,
  method: value.method,
  basis: value.basis
})

/** Remaining time and total tokens on a running row: `~7m·250k`, `late` past the interval. */
export const label = (estimate: Estimate | undefined, startedAt: number, now: number): string => {
  if (estimate === undefined) return ""
  const left = remaining(estimate, now - startedAt)
  if (left === undefined) return "late"
  return `~${duration(left)}${estimate.tokens === undefined ? "" : `·${count(estimate.tokens)}`}`
}
const remaining = (estimate: Estimate, elapsed: number): number | undefined =>
  elapsed <= estimate.ms ? estimate.ms - elapsed : elapsed <= estimate.highMs ? estimate.highMs - elapsed : undefined

/** Items that share seats: worker tabs, or flow runs. */
const pool = (item: Item): string => (item.estimate ?? item.id).split(":")[0]!
const settled = (status: string): status is "done" | "failed" | "cancelled" =>
  status === "done" || status === "failed" || status === "cancelled"
const minutes = (ms: number) => Math.round(ms / minute * 10) / 10

export class Estimator {
  readonly ledger: Improve.Ledger
  private model: Model | undefined
  private works = new Map<string, Work>()
  private inflight = new Map<string, Promise<void>>()
  /** Work the model was asked about once; a failed answer is not retried on every reconcile. */
  private asked = new Set<string>()
  private listeners = new Set<() => void>()
  private report: ((failure: Improve.Failure) => void) | undefined
  private reported = false
  constructor(options: {
    readonly ledger: Improve.Ledger
    readonly model?: Model | undefined
    /** Called on the first model failure; every failure is in the ledger. */
    readonly onFailure?: (failure: Improve.Failure) => void
  }) {
    this.ledger = options.ledger
    this.model = options.model
    this.report = options.onFailure
  }
  subscribe = (listener: () => void): () => void => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  private changed() {
    for (const listener of this.listeners) listener()
  }
  /** Settles when every model estimate in flight has been recorded. */
  idle = async (): Promise<void> => {
    while (this.inflight.size > 0) await Promise.all(this.inflight.values())
  }
  get = (id: string): Estimate | undefined => {
    const prediction = this.ledger.prediction(id)
    return prediction?.value.ms === undefined ? undefined : present(prediction)
  }
  /**
   * Estimates new work and records the prediction. Returns at once: a model
   * estimate arrives later through `subscribe`, and meanwhile this is undefined.
   */
  request = (work: Work): Estimate | undefined => {
    const existing = this.get(work.id)
    if (existing !== undefined || this.inflight.has(work.id) || this.ledger.observation(work.id) !== undefined) {
      return existing
    }
    this.works.set(work.id, work)
    if (work.kind !== "delegate") {
      const past = this.ledger.observations((observation) =>
        observation.key === work.key && observation.outcome === "done" && observation.actual.ms !== undefined
      ).slice(-20)
      if (past.length > 0) return this.record(work, "history", reference(past))
    }
    if (
      this.model !== undefined && work.kind !== "turn" && !this.asked.has(work.id) &&
      this.ledger.failure(work.id) === undefined
    ) {
      this.asked.add(work.id)
      const model = this.model
      const pending = model({ system, prompt: prompt(work, this.ledger) })
        .then(
          (text): ReturnType<typeof parse> | { readonly reason: FailureReason; readonly message: string } =>
            parse(text) ?? { reason: "unusable-answer", message: text.replace(/\s+/g, " ").trim().slice(0, 200) },
          (error: unknown) => ({
            reason: "model-error" as const,
            message: error instanceof Error ? error.message : String(error)
          })
        )
        .then((answer) => {
          // Hindsight is not a prediction: work that settled first stays unestimated.
          if (this.ledger.observation(work.id) !== undefined) return
          if (answer !== undefined && "reason" in answer) {
            this.failed(work, answer.reason, answer.message)
            this.fallback(work)
          } else if (answer !== undefined) this.record(work, "model", answer)
          this.changed()
        })
        .finally(() => this.inflight.delete(work.id))
      this.inflight.set(work.id, pending)
      return undefined
    }
    return this.fallback(work)
  }
  private failed(work: Work, reason: FailureReason, message: string) {
    const failure: Improve.Failure = {
      id: work.id,
      kind: work.kind,
      key: work.key,
      method: "model",
      reason,
      message,
      at: Date.now()
    }
    this.ledger.fail(failure)
    if (this.reported) return
    this.reported = true
    this.report?.(failure)
  }
  /** The median of the kind: the estimate when nothing better is known. */
  private fallback(work: Work): Estimate | undefined {
    const past = this.ledger.observations((observation) =>
      observation.kind === work.kind && observation.outcome === "done" && observation.actual.ms !== undefined
    ).slice(-20)
    return past.length === 0 ? undefined : this.record(work, "class", reference(past))
  }
  private record(work: Work, method: string, answer: NonNullable<ReturnType<typeof parse>>): Estimate {
    return present(this.ledger.predict({
      id: work.id,
      kind: work.kind,
      key: work.key,
      method,
      subject: work.subject,
      at: work.startedAt,
      ...answer
    }))
  }
  /** Records how requested work ended. */
  settle = (id: string, actual: Improve.Metrics, outcome: Improve.Observation["outcome"], at = Date.now()): void => {
    const work = this.works.get(id)
    const prediction = this.ledger.prediction(id)
    const kind = work?.kind ?? prediction?.kind
    if (kind === undefined || this.ledger.observation(id) !== undefined) return
    this.ledger.observe({
      id,
      kind,
      key: work?.key ?? prediction!.key,
      subject: work?.subject ?? prediction!.subject,
      at,
      outcome,
      actual
    })
    this.works.delete(id)
    this.changed()
  }
  /**
   * Reconciles worker tabs: estimates each new one, queued ones included, and
   * observes each settled one from its transcript's own turns.
   */
  tabs = (tabs: ReadonlyArray<Workspace.Tab>): void => {
    for (const tab of tabs) {
      const id = tabId(tab)
      const work: Work = {
        id,
        kind: "delegate",
        key: "delegate",
        subject: `${tab.title}\n${tab.prompt}`,
        startedAt: tabStart(tab)
      }
      if (!settled(tab.status)) {
        this.request(work)
        continue
      }
      if (this.ledger.observation(id) !== undefined || tab.endedAt === undefined) continue
      const records = load(tab.file)
      const tokens = usage(records)
      this.works.set(id, work)
      this.settle(
        id,
        { ms: worked(records) ?? tab.endedAt - tabStart(tab), ...(tokens === undefined ? {} : { tokens }) },
        tab.status,
        tab.endedAt
      )
    }
  }
  /** Reconciles flow runs. The control plane reports no token usage, so they score time only. */
  flows = (runs: ReadonlyArray<Flows.Run>, describe: (flow: string) => string | undefined = () => undefined): void => {
    for (const run of runs) {
      const id = runId(run)
      const work: Work = {
        id,
        kind: "flow",
        key: `flow:${run.flow}`,
        subject: `${run.flow} ${JSON.stringify(run.input).slice(0, 500)}`,
        ...(describe(run.flow) === undefined ? {} : { context: describe(run.flow)! }),
        startedAt: run.startedAt
      }
      if (!settled(run.status)) {
        this.request(work)
        continue
      }
      if (this.ledger.observation(id) !== undefined || run.endedAt === undefined) continue
      this.works.set(id, work)
      this.settle(id, { ms: run.endedAt - (run.launchedAt ?? run.startedAt) }, run.status, run.endedAt)
    }
  }
  /** Seeds delegate history from worker transcripts written before this ledger existed. */
  seed = (folder: string): void => {
    if (!existsSync(folder)) return
    let added = false
    for (const name of readdirSync(folder).filter((name) => name.endsWith(".jsonl")).sort()) {
      const file = join(folder, name)
      const id = `tab:${file}`
      if (this.ledger.observation(id) !== undefined) continue
      let records: ReadonlyArray<Session.Record>
      try {
        records = Session.load(file)
      } catch {
        continue
      }
      const user = records.find((record) => record.type === "user")
      const outcome = records.findLast((record) => record.type === "outcome")
      const ms = worked(records)
      if (user?.type !== "user" || outcome?.type !== "outcome" || !settled(outcome.outcome._tag) || ms === undefined) {
        continue
      }
      const tokens = usage(records)
      this.ledger.observe({
        id,
        kind: "delegate",
        key: "delegate",
        subject: user.text.slice(0, 300),
        at: outcome.at,
        outcome: outcome.outcome._tag,
        actual: { ms, ...(tokens === undefined ? {} : { tokens }) }
      })
      added = true
    }
    if (added) this.changed()
  }
  /**
   * Every active task's ETA as plain JSON: the answer to "what is the ETA on
   * all tasks". Queued tabs wait for the first of `seats` seats to free, so
   * their remaining time includes the wait.
   */
  eta = (items: ReadonlyArray<Item>, now = Date.now(), seats = 3) => {
    const known = items.map((item) => {
      const estimate = this.get(item.estimate ?? item.id)
      const elapsed = item.queued ? 0 : Math.max(0, now - item.startedAt)
      const failure = this.ledger.failure(item.estimate ?? item.id)
      return {
        item,
        estimate,
        elapsed,
        left: estimate === undefined ? undefined : item.queued ? estimate.ms : remaining(estimate, elapsed),
        failure: failure === undefined ? null : `${failure.method} ${failure.reason}: ${failure.message}`
      }
    })
    // Seats per pool (worker tabs, flow runs): each running item holds one until its
    // remaining time is up (unknown without an estimate); queued items take the first
    // to free, oldest first.
    const order = (slots: Array<number | undefined>) => slots.sort((x, y) => (x ?? Infinity) - (y ?? Infinity))
    const wait = new Map<Item, number | undefined>()
    for (const name of new Set(known.map((task) => pool(task.item)))) {
      const members = known.filter((task) => pool(task.item) === name)
      const slots = order([
        ...members.filter((task) => !task.item.queued).map((task) => task.left),
        ...Array<number>(seats).fill(0)
      ].slice(0, Math.max(seats, 0)))
      for (const task of members.filter((task) => task.item.queued)) {
        const start = slots.shift()
        wait.set(task.item, start)
        slots.push(start === undefined || task.left === undefined ? undefined : start + task.left)
        order(slots)
      }
    }
    const tasks = known.map(({ item, estimate, elapsed, left, failure }) => {
      const queuedFor = wait.get(item)
      const total = !item.queued ? left : left === undefined || queuedFor === undefined ? undefined : queuedFor + left
      return {
        id: item.id,
        title: item.title,
        status: item.status,
        elapsedMinutes: minutes(elapsed),
        estimateMinutes: estimate === undefined ? null : minutes(estimate.ms),
        rangeMinutes: estimate === undefined ? null : [minutes(estimate.lowMs), minutes(estimate.highMs)],
        remainingMinutes: total === undefined ? null : minutes(total),
        overdue: !item.queued && estimate !== undefined && elapsed > estimate.ms,
        tokens: estimate?.tokens === undefined ? null : Math.round(estimate.tokens),
        method: estimate?.method ?? null,
        failure
      }
    })
    const scored = this.ledger.stats(() => true, ["ms"])
    return {
      tasks,
      allDoneInMinutes: tasks.some((task) => task.remainingMinutes === null)
        ? null
        : Math.max(0, ...tasks.map((task) => task.remainingMinutes!)),
      accuracy: {
        scored: scored.n,
        typicalMiss: scored.error.ms === undefined ? null : Number(scored.error.ms.toFixed(2))
      }
    }
  }
}

/** The reference class's median and 10th to 90th percentile. */
const reference = (past: ReadonlyArray<Improve.Observation>): NonNullable<ReturnType<typeof parse>> => {
  const times = past.map((observation) => observation.actual.ms!)
  const tokens = past.flatMap((observation) =>
    observation.actual.tokens === undefined ? [] : [observation.actual.tokens]
  )
  const raw: Improve.Metrics = tokens.length === 0
    ? { ms: Improve.quantile(times, 0.5) }
    : { ms: Improve.quantile(times, 0.5), tokens: Improve.quantile(tokens, 0.5) }
  return {
    raw,
    ...(past.length < 3 ? {} : {
      low: { ms: Improve.quantile(times, 0.1) },
      high: { ms: Improve.quantile(times, 0.9) }
    })
  }
}

/** The active tabs and flow runs, queued ones included, as `eta` items. */
export const active = (tabs: ReadonlyArray<Workspace.Tab>, runs: ReadonlyArray<Flows.Run>): ReadonlyArray<Item> => [
  ...tabs.filter((tab) => !settled(tab.status)).sort((a, b) => a.startedAt - b.startedAt).map((tab) => ({
    id: tab.id,
    title: tab.title,
    status: tab.status,
    startedAt: tabStart(tab),
    estimate: tabId(tab),
    queued: tab.status === "queued"
  })),
  ...runs.filter((run) => !settled(run.status)).sort((a, b) => a.startedAt - b.startedAt).map((run) => ({
    id: run.id,
    title: run.flow,
    status: run.status,
    startedAt: run.launchedAt ?? run.startedAt,
    estimate: runId(run),
    queued: run.status === "queued"
  }))
]
