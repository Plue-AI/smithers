/**
 * Grades a benchmark wave on all three dimensions and writes the scorecard.
 *
 * Launch line, from this directory:
 *
 * ```bash
 * node scorecard.ts
 * ```
 *
 * Reads, per instance:
 *
 * - the verdict from the official evaluator's own report (`resolved`,
 *   `unresolved`, `empty patch`, `eval error`);
 * - turns, model calls, tokens and the journal's own span from the run's
 *   journal, through `Forensics.digest` — the CLI's forensics projection, so
 *   the scorecard and `flows status` cannot disagree about what a run did;
 * - wall clock from `timings/<id>.json`, which the run script stamps around the
 *   agent process, because the journal's span ends at the last journaled event;
 * - USD from the committed price table in `prices.ts`, the seat's model turns
 *   and, in a column of its own, the run's Jev readings: the completion brake
 *   (`claim-demanded`), the per-frame supervisor (`supervisor-settled`), the
 *   agent's own `jev` flow calls (`cell-call-settled`) and the gates
 *   (`decision-settled` of a gate classifier), priced under the
 *   `typesafe-ai/jev` row and counted per caller. The codex arm asks Jev
 *   nothing, so its column is model-only either way;
 * - what the gates did, as counts: items `relevance-settled` withheld per
 *   kind, flows `relevance-restored`, deliveries per monitor and memory rows
 *   delivered from `steering-drained`, and messages `compaction-settled`
 *   removed. `lib/jev-replay.mjs` turns the same rows into rates.
 *
 * Per-call latency is reported when the journal carries it and reported as
 * unavailable when it does not. The current harness writes `durationMillis`;
 * the older speculative names remain fallbacks for imported journals.
 *
 * Writes `scorecard.json` and `scorecard.md`, and compares every instance
 * against the committed codex baseline in `baseline/`.
 *
 * Nothing here spends model tokens or needs docker: it is a projection of
 * artifacts a wave already produced.
 *
 * @since 0.1.0
 */
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath } from "node:url"
import type * as AgentEvent from "../../packages/smithers/agent/harness/src/AgentEvent.ts"
import type { ControlSchema } from "../../packages/smithers/control/src/index.ts"
import * as Forensics from "../../packages/smithers/src/Forensics.ts"
import { jevCaller, jevCellQuestionsOf, jevUsageOf } from "./jev-usage.ts"
import { jevModel, usd } from "./prices.ts"

const here = dirname(fileURLToPath(import.meta.url))

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

const flag = (name: string, fallback: string): string => {
  const index = process.argv.indexOf(`--${name}`)
  return index < 0 ? fallback : process.argv[index + 1] ?? fallback
}

const options = {
  work: resolve(here, flag("work", "work")),
  patches: resolve(here, flag("patches", "patches")),
  timings: resolve(here, flag("timings", "timings")),
  report: resolve(here, flag("report", "")),
  model: flag("model", "flows-cell-harness"),
  baseline: resolve(here, flag("baseline", "baseline/codex-comparison.json")),
  sample: resolve(here, flag("sample", "sample.json")),
  subject: resolve(here, flag("subject", ".subject.json")),
  out: resolve(here, flag("out", "."))
}
const instancesFlag = flag("instances", "")

// ---------------------------------------------------------------------------
// Verdicts, from the official evaluator's reports
// ---------------------------------------------------------------------------

const readVerdicts = (file: string): Record<string, string> => {
  if (file.length === 0 || !existsSync(file) || !statSync(file).isFile()) {
    throw new Error("scorecard requires --report <official evaluator report.json>")
  }
  const verdicts: Record<string, string> = {}
  const record = (id: string, verdict: string) => {
    if (verdicts[id] !== undefined) {
      throw new Error(`official evaluator report assigns ${id} both '${verdicts[id]}' and '${verdict}'`)
    }
    verdicts[id] = verdict
  }
  let report: Record<string, ReadonlyArray<string>>
  try {
    report = JSON.parse(readFileSync(file, "utf8"))
  } catch (error) {
    throw new Error(`could not read official evaluator report ${file}`, { cause: error })
  }
  for (const id of report.resolved_ids ?? []) record(id, "resolved")
  for (const id of report.unresolved_ids ?? []) record(id, "unresolved")
  for (const id of report.empty_patch_ids ?? []) record(id, "empty patch")
  for (const id of report.error_ids ?? []) record(id, "eval error")
  return verdicts
}

// ---------------------------------------------------------------------------
// The journal
// ---------------------------------------------------------------------------

interface JournalRow {
  readonly run_id: string
  readonly seq: number
  readonly event_type: string
  readonly payload_json: string
  readonly emitted_at_ms: number
}

/** The event shape `Forensics.digest` consumes, rebuilt from journal rows. */
const toControlEvent = (row: JournalRow): ControlSchema.ControlEvent => ({
  sequence: row.seq,
  kind: row.event_type,
  runId: row.run_id,
  occurredAt: row.emitted_at_ms,
  payload: JSON.parse(row.payload_json)
})

const readJournal = (workspace: string): ReadonlyArray<JournalRow> => {
  const rows: Array<JournalRow> = []
  for (const file of ["engine.db", "control.db"]) {
    const path = join(workspace, ".flows", file)
    if (!existsSync(path)) continue
    let database: DatabaseSync
    try {
      database = new DatabaseSync(path, { readOnly: true })
    } catch {
      continue
    }
    try {
      rows.push(
        ...database
          .prepare(
            "select run_id, seq, event_type, payload_json, emitted_at_ms from flows_journal_events order by run_id, seq"
          )
          .all() as unknown as Array<JournalRow>
      )
    } catch {
      // A journal without the events table is a workspace that never ran.
    }
    database.close()
  }
  // The same run can be journaled into both databases; keep one copy per event.
  const seen = new Set<string>()
  return rows.filter((row) => {
    const key = `${row.run_id}\u0000${row.seq}\u0000${row.event_type}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}

/** The canonical key is checked against the harness event; the rest preserve old imported journals. */
const modelSettledDurationKey = "durationMillis" satisfies keyof AgentEvent.ModelSettled
const durationKeys = [modelSettledDurationKey, "durationMs", "elapsedMs", "latencyMs", "tookMs"]

const durationOf = (payload: Record<string, unknown>): number | undefined => {
  for (const source of [payload, asRecord(payload.usage)]) {
    for (const key of durationKeys) {
      const value = source[key]
      if (typeof value === "number" && Number.isFinite(value)) return value
    }
  }
  return undefined
}

interface RunNumbers {
  readonly runIds: ReadonlyArray<string>
  readonly status: string | undefined
  readonly seat: string | undefined
  readonly turns: number
  readonly modelCalls: number
  readonly flowCalls: number
  readonly flowCallsRefused: number
  readonly editsAttempted: number
  readonly editsSucceeded: number
  readonly inputTokens: number
  readonly cachedInputTokens: number
  readonly outputTokens: number
  readonly jevCellCalls: number
  readonly jevCellQuestions: number
  /** Successful `jev` calls whose recorded result the journal bounded to a marker. */
  readonly jevCellQuestionsUnknown: number
  readonly jevBrakeReadings: number
  readonly jevSupervisorReadings: number
  readonly jevGateReadings: number
  readonly cellsWithJev: number
  readonly cells: number
  /** `decision-unjudged` plus `supervisor-unjudged`. */
  readonly jevUnjudged: number
  readonly jevInputTokens: number
  readonly jevOutputTokens: number
  /** Supervisor readings journaled unjudged, by reason; `interrupted` ones were asked and went unmetered. */
  readonly supervisorUnjudged: Readonly<Record<string, number>>
  /** Memory reads and writes the supervisor's store refused. */
  readonly supervisorMemoryFailures: number
  /** Items `relevance-settled` withheld, by kind. */
  readonly relevanceWithheld: Readonly<Record<string, number>>
  readonly relevanceRestored: number
  /** `steering-drained` deliveries, by monitor id. */
  readonly monitorsDelivered: Readonly<Record<string, number>>
  readonly memoryDelivered: number
  readonly compactionRemoved: number
  readonly journalSeconds: number | undefined
  readonly callLatencyMs: ReadonlyArray<number>
}

/**
 * Sums one workspace's runs. A resumed or re-driven instance journals more than
 * one run id into the same workspace, and the wave's cost is all of them.
 */
const runNumbers = (workspace: string): RunNumbers | undefined => {
  const rows = readJournal(workspace)
  if (rows.length === 0) return undefined
  const byRun = new Map<string, Array<ControlSchema.ControlEvent>>()
  for (const row of rows) {
    const events = byRun.get(row.run_id) ?? []
    events.push(toControlEvent(row))
    byRun.set(row.run_id, events)
  }

  let turns = 0
  let modelCalls = 0
  let flowCalls = 0
  let flowCallsRefused = 0
  let editsAttempted = 0
  let editsSucceeded = 0
  let inputTokens = 0
  let outputTokens = 0
  let status: string | undefined
  let seat: string | undefined
  let startedAt: number | undefined
  let endedAt: number | undefined
  for (const events of byRun.values()) {
    const digest = Forensics.digest(events)
    turns += digest.turns
    flowCalls += digest.calls
    flowCallsRefused += digest.callsFailed
    editsAttempted += digest.editsAttempted
    editsSucceeded += digest.editsSucceeded
    inputTokens += digest.inputTokens
    outputTokens += digest.outputTokens
    status = digest.status ?? status
    seat = digest.seat ?? seat
    if (digest.startedAt !== undefined) startedAt = Math.min(startedAt ?? digest.startedAt, digest.startedAt)
    if (digest.endedAt !== undefined) endedAt = Math.max(endedAt ?? digest.endedAt, digest.endedAt)
  }

  // Cached input and per-call duration are not in the digest, so they are read
  // from the same `model-settled` payloads the digest already counted.
  let cachedInputTokens = 0
  const callLatencyMs: Array<number> = []
  // Jev is metered on four other event types; `jev-usage.ts` owns which ones,
  // which caller each is and where each keeps its usage, so the scorecard and
  // the full benchmark's ledger cannot disagree about what a reading cost.
  const readings = { cell: 0, brake: 0, supervisor: 0, gate: 0 }
  let jevCellQuestions = 0
  let jevCellQuestionsUnknown = 0
  let jevUnjudged = 0
  // A cell's calls sit between its `cell-produced` and its `cell-settled`.
  let cells = 0
  let cellsWithJev = 0
  let cellRun: string | undefined
  let cellCalledJev = false
  let jevInputTokens = 0
  let jevOutputTokens = 0
  // The supervisor's own faults, counted rather than left to a log: a reading
  // cut off by the run's end cost a call no usage row records, and a memory
  // write lost to a locked store reads exactly like a run that remembered
  // nothing.
  const supervisorUnjudged: Record<string, number> = {}
  let supervisorMemoryFailures = 0
  const relevanceWithheld: Record<string, number> = {}
  let relevanceRestored = 0
  const monitorsDelivered: Record<string, number> = {}
  let memoryDelivered = 0
  let compactionRemoved = 0
  const tally = (counts: Record<string, number>, key: unknown) => {
    const name = typeof key === "string" ? key : "unknown"
    counts[name] = (counts[name] ?? 0) + 1
  }
  for (const row of rows) {
    if (row.run_id !== cellRun) {
      cellRun = row.run_id
      cellCalledJev = false
    }
    if (row.event_type === "control.agent.cell-settled") {
      cells += 1
      if (cellCalledJev) cellsWithJev += 1
      cellCalledJev = false
      continue
    }
    if (row.event_type === "control.agent.decision-unjudged") {
      jevUnjudged += 1
      continue
    }
    if (row.event_type === "control.agent.supervisor-unjudged") {
      jevUnjudged += 1
      const reason = asRecord(JSON.parse(row.payload_json)).reason
      const key = typeof reason === "string" ? reason : "unknown"
      supervisorUnjudged[key] = (supervisorUnjudged[key] ?? 0) + 1
      continue
    }
    if (row.event_type === "control.agent.supervisor-memory-failed") {
      supervisorMemoryFailures += 1
      continue
    }
    if (row.event_type === "control.agent.relevance-settled") {
      const withheld = asRecord(JSON.parse(row.payload_json)).withheld
      for (const item of Array.isArray(withheld) ? withheld : []) tally(relevanceWithheld, asRecord(item).kind)
      continue
    }
    if (row.event_type === "control.agent.relevance-restored") {
      relevanceRestored += 1
      continue
    }
    if (row.event_type === "control.agent.steering-drained") {
      const payload = asRecord(JSON.parse(row.payload_json))
      if (payload.monitor !== undefined) tally(monitorsDelivered, payload.monitor)
      if (Array.isArray(payload.memory)) memoryDelivered += payload.memory.length
      continue
    }
    if (row.event_type === "control.agent.compaction-settled") {
      const removed = asRecord(asRecord(JSON.parse(row.payload_json)).marks).removed
      if (typeof removed === "number") compactionRemoved += removed
      continue
    }
    if (row.event_type !== "control.agent.model-settled") {
      const payload = asRecord(JSON.parse(row.payload_json))
      const caller = jevCaller(row.event_type, payload)
      if (caller === "cell") cellCalledJev = true
      const metered = jevUsageOf(row.event_type, payload)
      if (caller === undefined || metered === undefined) continue
      readings[caller] += 1
      jevInputTokens += metered.inputTokens
      jevOutputTokens += metered.outputTokens
      if (caller === "cell") {
        const questions = jevCellQuestionsOf(payload)
        if (questions === undefined) jevCellQuestionsUnknown += 1
        else jevCellQuestions += questions
      }
      continue
    }
    modelCalls += 1
    const payload = asRecord(JSON.parse(row.payload_json))
    const usage = asRecord(payload.usage)
    const cached = usage.cachedInputTokens
    if (typeof cached === "number") cachedInputTokens += cached
    const duration = durationOf(payload)
    if (duration !== undefined) callLatencyMs.push(duration)
  }

  return {
    runIds: [...byRun.keys()],
    status,
    seat,
    turns,
    modelCalls,
    flowCalls,
    flowCallsRefused,
    editsAttempted,
    editsSucceeded,
    inputTokens,
    cachedInputTokens,
    outputTokens,
    jevCellCalls: readings.cell,
    jevCellQuestions,
    jevCellQuestionsUnknown,
    jevBrakeReadings: readings.brake,
    jevSupervisorReadings: readings.supervisor,
    jevGateReadings: readings.gate,
    cellsWithJev,
    cells,
    jevUnjudged,
    jevInputTokens,
    jevOutputTokens,
    supervisorUnjudged,
    supervisorMemoryFailures,
    relevanceWithheld,
    relevanceRestored,
    monitorsDelivered,
    memoryDelivered,
    compactionRemoved,
    journalSeconds: startedAt === undefined || endedAt === undefined
      ? undefined
      : Math.round((endedAt - startedAt) / 1000),
    callLatencyMs
  }
}

// ---------------------------------------------------------------------------
// The scorecard
// ---------------------------------------------------------------------------

const readJson = <A>(path: string, fallback: A): A => {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as A
  } catch {
    return fallback
  }
}

const bytesOf = (path: string): number => existsSync(path) ? statSync(path).size : 0

const mean = (values: ReadonlyArray<number>): number | undefined =>
  values.length === 0 ? undefined : Math.round(values.reduce((total, value) => total + value, 0) / values.length)

interface BaselineRow {
  readonly id: string
  readonly codex: {
    readonly verdict: string
    readonly tokens?: number
    readonly seconds?: number
    readonly patchBytes?: number
    readonly model?: string
  }
}

const callout = (flows: string, codex: string): string =>
  flows === "resolved" && codex !== "resolved"
    ? "FLOWS WIN"
    : codex === "resolved" && flows !== "resolved"
    ? "codex win"
    : flows === "resolved" && codex === "resolved"
    ? "both pass"
    : "both fail"

const verdicts = readVerdicts(options.report)
const baselineRows = readJson<ReadonlyArray<BaselineRow>>(options.baseline, [])
const baseline = new Map(baselineRows.map((row) => [row.id, row]))

const instances = instancesFlag.length > 0
  ? instancesFlag.split(",").map((id) => id.trim()).filter((id) => id.length > 0)
  : [
    ...new Set([
      ...readJson<{ instances?: ReadonlyArray<string> }>(options.sample, {}).instances ?? [],
      ...baselineRows.map((row) => row.id)
    ])
  ].filter((id) => existsSync(join(options.work, id)) || verdicts[id] !== undefined || baseline.has(id))

const rows = instances.map((id) => {
  const numbers = runNumbers(join(options.work, id))
  const timing = readJson<
    { wallClockSeconds?: number; seat?: string; budgetSeconds?: number; subject?: string }
  >(
    join(options.timings, `${id}.json`),
    {}
  )
  const model = numbers?.seat ?? timing.seat
  const tokens = {
    inputTokens: numbers?.inputTokens ?? 0,
    cachedInputTokens: numbers?.cachedInputTokens ?? 0,
    outputTokens: numbers?.outputTokens ?? 0
  }
  const priced = usd(model, tokens)
  const jevTokens = {
    inputTokens: numbers?.jevInputTokens ?? 0,
    cachedInputTokens: 0,
    outputTokens: numbers?.jevOutputTokens ?? 0
  }
  const jevPriced = usd(jevModel, jevTokens)
  const verdict = verdicts[id] ?? "not graded"
  const codexRow = baseline.get(id)?.codex
  const codexPriced = codexRow === undefined
    ? { usd: undefined, source: "no committed baseline" }
    // The committed baseline records one total token count per instance, from
    // the codex CLI's own report, without an input/output split. It is priced
    // at the input rate, which is a floor on what that run cost.
    : usd(codexRow.model ?? "gpt-5.6-sol", {
      inputTokens: codexRow.tokens ?? 0,
      cachedInputTokens: 0,
      outputTokens: 0
    })

  return {
    instanceId: id,
    quality: {
      verdict,
      patchBytes: bytesOf(join(options.patches, `${id}.patch`)),
      status: numbers?.status,
      editsAttempted: numbers?.editsAttempted ?? 0,
      editsSucceeded: numbers?.editsSucceeded ?? 0
    },
    speed: {
      wallClockSeconds: timing.wallClockSeconds,
      journalSeconds: numbers?.journalSeconds,
      budgetSeconds: timing.budgetSeconds,
      turns: numbers?.turns ?? 0,
      modelCalls: numbers?.modelCalls ?? 0,
      flowCalls: numbers?.flowCalls ?? 0,
      flowCallsRefused: numbers?.flowCallsRefused ?? 0,
      meanCallLatencyMs: mean(numbers?.callLatencyMs ?? []),
      perCallLatency: (numbers?.callLatencyMs.length ?? 0) > 0
        ? "journaled"
        : "unavailable: the journal carries no per-call duration"
    },
    cost: {
      model,
      inputTokens: tokens.inputTokens,
      cachedInputTokens: tokens.cachedInputTokens,
      outputTokens: tokens.outputTokens,
      usd: priced.usd,
      priceSource: priced.source,
      // The run's Jev readings, priced apart from the seat: `usd` above stays
      // the model's spend, and this is what judging it cost.
      jevCellCalls: numbers?.jevCellCalls ?? 0,
      jevCellQuestions: numbers?.jevCellQuestions ?? 0,
      jevCellQuestionsUnknown: numbers?.jevCellQuestionsUnknown ?? 0,
      jevBrakeReadings: numbers?.jevBrakeReadings ?? 0,
      jevSupervisorReadings: numbers?.jevSupervisorReadings ?? 0,
      jevGateReadings: numbers?.jevGateReadings ?? 0,
      cellsWithJev: numbers?.cellsWithJev ?? 0,
      cells: numbers?.cells ?? 0,
      jevUnjudged: numbers?.jevUnjudged ?? 0,
      jevInputTokens: jevTokens.inputTokens,
      jevOutputTokens: jevTokens.outputTokens,
      jevUsd: jevPriced.usd,
      jevPriceSource: jevPriced.source,
      // Readings the run's end interrupted: asked, never metered, so `jevUsd`
      // is a floor whenever this is non-zero.
      jevInterrupted: numbers?.supervisorUnjudged["interrupted"] ?? 0,
      supervisorUnjudged: numbers?.supervisorUnjudged ?? {},
      supervisorMemoryFailures: numbers?.supervisorMemoryFailures ?? 0,
      totalUsd: priced.usd === undefined || jevPriced.usd === undefined
        ? undefined
        : Math.round((priced.usd + jevPriced.usd) * 10_000) / 10_000
    },
    baseline: codexRow === undefined ? undefined : {
      verdict: codexRow.verdict,
      seconds: codexRow.seconds,
      tokens: codexRow.tokens,
      patchBytes: codexRow.patchBytes,
      usd: codexPriced.usd,
      priceSource: codexPriced.source
    },
    gates: {
      relevanceWithheld: numbers?.relevanceWithheld ?? {},
      relevanceRestored: numbers?.relevanceRestored ?? 0,
      monitorsDelivered: numbers?.monitorsDelivered ?? {},
      memoryDelivered: numbers?.memoryDelivered ?? 0,
      compactionRemoved: numbers?.compactionRemoved ?? 0
    },
    subject: timing.subject,
    callout: codexRow === undefined ? "no baseline" : callout(verdict, codexRow.verdict),
    runIds: numbers?.runIds ?? []
  }
})

const sum = (values: ReadonlyArray<number | undefined>): number =>
  values.reduce((total: number, value) => total + (value ?? 0), 0)

const aggregate = {
  instances: rows.length,
  flowsResolved: rows.filter((row) => row.quality.verdict === "resolved").length,
  codexResolved: rows.filter((row) => row.baseline?.verdict === "resolved").length,
  flowsWins: rows.filter((row) => row.callout === "FLOWS WIN").length,
  codexWins: rows.filter((row) => row.callout === "codex win").length,
  bothPass: rows.filter((row) => row.callout === "both pass").length,
  bothFail: rows.filter((row) => row.callout === "both fail").length,
  flowsWallClockSeconds: sum(rows.map((row) => row.speed.wallClockSeconds ?? row.speed.journalSeconds)),
  codexWallClockSeconds: sum(rows.map((row) => row.baseline?.seconds)),
  flowsTokens: sum(rows.map((row) => row.cost.inputTokens + row.cost.outputTokens)),
  codexTokens: sum(rows.map((row) => row.baseline?.tokens)),
  flowsUsd: Math.round(sum(rows.map((row) => row.cost.usd)) * 10_000) / 10_000,
  flowsJevReadings: sum(
    rows.map((row) =>
      row.cost.jevCellCalls + row.cost.jevBrakeReadings + row.cost.jevSupervisorReadings + row.cost.jevGateReadings
    )
  ),
  flowsJevTokens: sum(rows.map((row) => row.cost.jevInputTokens + row.cost.jevOutputTokens)),
  flowsJevUsd: Math.round(sum(rows.map((row) => row.cost.jevUsd)) * 10_000) / 10_000,
  flowsJevInterrupted: sum(rows.map((row) => row.cost.jevInterrupted)),
  flowsSupervisorUnjudged: sum(rows.map((row) => sum(Object.values(row.cost.supervisorUnjudged)))),
  flowsSupervisorMemoryFailures: sum(rows.map((row) => row.cost.supervisorMemoryFailures)),
  flowsTotalUsd: Math.round(sum(rows.map((row) => row.cost.totalUsd)) * 10_000) / 10_000,
  codexUsdFloor: Math.round(sum(rows.map((row) => row.baseline?.usd)) * 10_000) / 10_000,
  perCallLatency: rows.some((row) => row.speed.perCallLatency === "journaled")
    ? "journaled"
    : "unavailable: no run in this wave journaled a per-call duration"
}

// ---------------------------------------------------------------------------
// The subject: which bytes the wave measured
// ---------------------------------------------------------------------------

/**
 * The preconditions block. A wave report names commits; this names the content
 * that was loaded, which is not the same claim and is the one that can be
 * checked. See `lib/subject.mjs` for how the fingerprint is derived, and
 * `preflight.sh` for when it is pinned.
 *
 * `agreement` is the part that matters most. Every instance stamps the pinned
 * subject into its timings record when it starts, so a wave in which a sibling
 * lane edited `packages/smithers/agent/harness/src` between the first instance and the last
 * reports two stamps here instead of one, and cannot be written up as a single
 * measurement.
 */
interface PinnedSubject {
  readonly stamp?: string
  readonly head?: string
  readonly headSubject?: string
  readonly node?: string
  readonly platform?: string
  readonly marker?: { readonly path: string; readonly hash: string; readonly resolvedBy?: string }
  readonly cliDist?: { readonly directory?: string; readonly hash: string; readonly files: number }
  readonly cliSrc?: { readonly directory?: string; readonly hash: string; readonly files: number }
  readonly refusals?: ReadonlyArray<{ readonly code: string; readonly message: string }>
}

const pinned = readJson<PinnedSubject>(options.subject, {})
const stamped = rows.map((row) => row.subject)
const distinct = [...new Set(stamped.filter((stamp): stamp is string => stamp !== undefined))]
const unstamped = rows.filter((row) => row.subject === undefined).map((row) => row.instanceId)
const subject = {
  ...pinned,
  instances: Object.fromEntries(rows.map((row) => [row.instanceId, row.subject ?? "unstamped"])),
  agreement: distinct.length > 1
    ? `MISMATCH: this wave ran ${distinct.length} different subjects (${distinct.join(", ")})`
    : unstamped.length === rows.length
    ? "unstamped: no instance recorded a subject, so this wave cannot say what it measured"
    : unstamped.length > 0
    ? `partial: ${unstamped.length} of ${rows.length} instance(s) recorded no subject (${unstamped.join(", ")})`
    : pinned.stamp !== undefined && distinct[0] !== pinned.stamp
    ? `MISMATCH: the instances ran ${distinct[0]}, the pin now reads ${pinned.stamp}`
    : "one subject, pinned and stamped by every instance"
}

writeFileSync(
  join(options.out, "scorecard.json"),
  `${JSON.stringify({ subject, aggregate, instances: rows }, null, 2)}\n`
)

// ---------------------------------------------------------------------------
// The markdown rendering
// ---------------------------------------------------------------------------

const show = (value: number | string | undefined, suffix = ""): string =>
  value === undefined ? "—" : `${typeof value === "number" ? value.toLocaleString("en-US") : value}${suffix}`

/** Counts by name, `name:count` sorted by name, or `0`. */
const counts = (byName: Readonly<Record<string, number>>): string => {
  const entries = Object.entries(byName).sort(([a], [b]) => a.localeCompare(b))
  return entries.length === 0 ? "0" : entries.map(([name, count]) => `${name}:${count}`).join(" ")
}

const money = (value: number | undefined): string => value === undefined ? "—" : `$${value.toFixed(4)}`

const markdown = [
  "# SWE-bench Verified scorecard",
  "",
  `Instances: ${aggregate.instances} · flows resolved **${aggregate.flowsResolved}/${aggregate.instances}** · `
  + `codex resolved **${aggregate.codexResolved}/${aggregate.instances}** · `
  + `flows wins **${aggregate.flowsWins}** · codex wins ${aggregate.codexWins} · `
  + `both pass ${aggregate.bothPass} · both fail ${aggregate.bothFail}`,
  "",
  "## Preconditions: the subject this wave measured",
  "",
  "| | |",
  "| --- | --- |",
  `| subject | \`${subject.stamp ?? "unpinned"}\` |`,
  `| agreement | ${subject.agreement} |`,
  `| git HEAD | ${subject.head ?? "—"} ${subject.headSubject ?? ""} |`,
  // The path labels come from the subject record, never from today's layout:
  // a wave measured before a package move keeps the paths it actually loaded.
  `| \`${subject.marker?.path ?? "harness marker"}\` | \`${subject.marker?.hash ?? "—"}\` |`,
  `| loaded from | ${subject.marker?.resolvedBy ?? "—"} |`,
  `| \`${subject.cliDist?.directory ?? "CLI build"}\` | \`${subject.cliDist?.hash ?? "—"}\` (${
    subject.cliDist?.files ?? 0
  } modules) |`,
  `| \`${subject.cliSrc?.directory ?? "CLI source"}\` | \`${subject.cliSrc?.hash ?? "—"}\` (${
    subject.cliSrc?.files ?? 0
  } files, built above) |`,
  `| node | ${subject.node ?? "—"} ${subject.platform ?? ""} |`,
  "",
  ...(subject.refusals === undefined || subject.refusals.length === 0 ? [] : [
    "The preflight recorded these objections to the subject:",
    "",
    ...subject.refusals.map((refusal) => `- \`${refusal.code}\`: ${refusal.message}`),
    ""
  ]),
  "Every `@smthrs/*` package except `@smthrs/cli` is loaded from its `src`"
  + " directory, because that is where its workspace `exports` map points; the"
  + " harness under test is the working tree, not a build. `packages/smithers/agent/harness/dist`"
  + " is not in the loaded graph and its state means nothing here.",
  "",
  "## Quality",
  "",
  "| Instance | flows | codex | Bucket | Patch bytes | Edits ok/tried |",
  "| --- | --- | --- | --- | --- | --- |",
  ...rows.map((row) =>
    `| ${row.instanceId} | ${row.quality.verdict} | ${show(row.baseline?.verdict)} | ${row.callout} | `
    + `${show(row.quality.patchBytes)} | ${row.quality.editsSucceeded}/${row.quality.editsAttempted} |`
  ),
  "",
  "## Speed",
  "",
  "| Instance | flows wall clock | codex wall clock | Turns | Model calls | Mean call latency |",
  "| --- | --- | --- | --- | --- | --- |",
  ...rows.map((row) =>
    `| ${row.instanceId} | ${show(row.speed.wallClockSeconds ?? row.speed.journalSeconds, "s")} | `
    + `${show(row.baseline?.seconds, "s")} | ${show(row.speed.turns)} | ${show(row.speed.modelCalls)} | `
    + `${row.speed.meanCallLatencyMs === undefined ? "unavailable" : `${row.speed.meanCallLatencyMs} ms`} |`
  ),
  "",
  `Totals: flows ${aggregate.flowsWallClockSeconds}s · codex ${aggregate.codexWallClockSeconds}s.`,
  aggregate.perCallLatency === "journaled"
    ? "Per-call latency is journaled for this wave."
    : "Per-call latency is unavailable: the journaled model-settled event carries no duration field yet.",
  "",
  "## Cost",
  "",
  "| Instance | Input | Cached | Output | flows USD | Jev tokens | Jev USD | flows total | codex tokens | codex USD (floor) |",
  "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ...rows.map((row) =>
    `| ${row.instanceId} | ${show(row.cost.inputTokens)} | ${show(row.cost.cachedInputTokens)} | `
    + `${show(row.cost.outputTokens)} | ${money(row.cost.usd)} | `
    + `${show(row.cost.jevInputTokens + row.cost.jevOutputTokens)} | ${money(row.cost.jevUsd)} | `
    + `${money(row.cost.totalUsd)} | ${show(row.baseline?.tokens)} | ${money(row.baseline?.usd)} |`
  ),
  "",
  `Totals: flows ${money(aggregate.flowsUsd)} model + ${
    money(aggregate.flowsJevUsd)
  } Jev (${aggregate.flowsJevReadings} readings) = ${money(aggregate.flowsTotalUsd)} · codex ${
    money(aggregate.codexUsdFloor)
  } (floor).`,
  "",
  "Prices come from the committed table in `prices.ts`. `flows USD` is the seat's"
  + " model turns; `Jev USD` is every reading the run took of Jev (the completion"
  + " brake, the per-frame supervisor, the agent's own `jev` calls and the"
  + " gates), priced under the `typesafe-ai/jev` row, and `flows total` is both."
  + " The codex arm asks Jev nothing. The codex figure is a floor: the committed"
  + " baseline records one total token count per instance, with no input/output"
  + " split, so it is priced entirely at the input rate.",
  "",
  "## Jev",
  "",
  "| Instance | Cell calls | Cell questions | Questions unknown | Brake | Supervisor | Gates | Cells with Jev | Unjudged |",
  "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ...rows.map((row) =>
    `| ${row.instanceId} | ${row.cost.jevCellCalls} | ${row.cost.jevCellQuestions} | `
    + `${row.cost.jevCellQuestionsUnknown} | ${row.cost.jevBrakeReadings} | ${row.cost.jevSupervisorReadings} | `
    + `${row.cost.jevGateReadings} | ${row.cost.cellsWithJev}/${row.cost.cells} | ${row.cost.jevUnjudged} |`
  ),
  "",
  "## Gates",
  "",
  "| Instance | Withheld | Restored | Monitors delivered | Memory delivered | Compaction removed |",
  "| --- | --- | --- | --- | --- | --- |",
  ...rows.map((row) =>
    `| ${row.instanceId} | ${counts(row.gates.relevanceWithheld)} | ${row.gates.relevanceRestored} | `
    + `${counts(row.gates.monitorsDelivered)} | ${row.gates.memoryDelivered} | ${row.gates.compactionRemoved} |`
  ),
  ""
].join("\n")

writeFileSync(join(options.out, "scorecard.md"), markdown)

console.log(`scorecard.ts: ${join(options.out, "scorecard.json")}`)
console.log(`scorecard.ts: ${join(options.out, "scorecard.md")}`)
console.log(
  `flows ${aggregate.flowsResolved}/${aggregate.instances} · codex ${aggregate.codexResolved}/${aggregate.instances}`
    + ` · flows wins ${aggregate.flowsWins} · ${money(aggregate.flowsUsd)} + ${money(aggregate.flowsJevUsd)} Jev vs ${
      money(aggregate.codexUsdFloor)
    } (floor)`
    + ` · ${aggregate.flowsWallClockSeconds}s vs ${aggregate.codexWallClockSeconds}s`
)
