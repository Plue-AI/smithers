/**
 * Read-only forensic projections of a run's journal events.
 *
 * The vault's Forensics concept fixes the CLI surface at exactly two
 * projections: `smthrs logs` projects journal queries and `smthrs status`
 * projects the run summary and its gating cause. This module is the rendering
 * half of both: pure functions from the `ControlEvent` deltas that
 * `Control.watch` already serves, to a turn-by-turn transcript, a one-line
 * follow view, and the status card's diagnosis. Nothing here opens a
 * database; the control plane stays the only read path, so `--remote` renders
 * exactly what a local run renders.
 *
 * The need is concrete: the first SWE-bench benchmark of the built-in harness
 * was diagnosed with ad-hoc SQLite scripts because a settled run's journal
 * had no readable projection. Every question those scripts answered, where
 * the turns went, which calls were refused and why, whether an edit was ever
 * attempted, and what the run died of, is computed here from the events alone.
 *
 * @since 0.1.0
 */

import * as AgentSession from "@smthrs/agent/AgentSession"
import { ControlSchema } from "@smthrs/control"
import {
  asNumber,
  asRecord,
  asString,
  clip,
  digest as diagnose,
  duration,
  firstLine,
  foreignVerdict,
  timeOf,
  uniqueCallEvents,
  usd
} from "@smthrs/gateway/Diagnosis"
import { causeLine, terminalSafe } from "./internal/Failure.ts"

/**
 * One refused flow call, aggregated by its refusal message. Reach for this in
 * diagnosis renderers that need the reason and its frequency together. The
 * digest normalizes malformed source events before constructing this shape, so
 * consumers do not handle a separate parse failure.
 *
 * @category models
 * @since 0.1.0
 */
export interface Refusal {
  readonly message: string
  readonly count: number
}

/**
 * Everything the diagnosis computes from one run's events. Reach for this
 * projection when a status card or transcript needs one consistent account of
 * activity, cost, gating, and outcome. Missing or malformed event fields become
 * optional or zero values rather than making construction fail.
 *
 * @category models
 * @since 0.1.0
 */
export interface Digest {
  /**
   * The last status transition seen, or undefined before launch. A
   * `control.run.*` kind that names an operation rather than a status, such as
   * `control.run.lineage`, is not one.
   */
  readonly status: string | undefined
  /** The journaled failure cause, when the run failed and recorded one. */
  readonly cause: string | undefined
  readonly seat: string | undefined
  readonly turns: number
  readonly calls: number
  readonly callsFailed: number
  /** Calls whose flow and input were byte-identical to an earlier call. */
  readonly duplicateCalls: number
  readonly editsAttempted: number
  readonly editsSucceeded: number
  /** Call counts by flow name, descending. */
  readonly flows: ReadonlyArray<readonly [string, number]>
  /** Refusal messages, descending by count. */
  readonly refusals: ReadonlyArray<Refusal>
  readonly inputTokens: number
  readonly outputTokens: number
  /** USD the run's priced model calls cost; zero when none was priced. */
  readonly costUsd: number
  /** The final assistant output, when the run resolved. */
  readonly finalOutput: string | undefined
  /** The pending ask's question, when the run parked for approval. */
  readonly parkedQuestion: string | undefined
  /** The serialized approval payload that unblocks a parked run. */
  readonly parkedApproval: string | undefined
  readonly startedAt: number | undefined
  readonly endedAt: number | undefined
}

/**
 * The `control.run.*` suffixes this fold reads a status off: the wire's own
 * vocabulary, plus the one state only the CLI reports.
 *
 * `@smthrs/gateway` `Diagnosis` folds `ControlSchema.RunStatus` alone, because
 * a client renders a typed status. `control.run.pending` is the executor
 * declining the launch, which the status card names and the wire does not
 * carry, so this fold keeps it and nothing else.
 */
const cardStatuses: ReadonlySet<string> = new Set([...ControlSchema.RunStatus.literals, "pending"])

const compact = (value: unknown, width: number): string => {
  const rendered = typeof value === "string" ? value : JSON.stringify(value) ?? String(value)
  return clip(terminalSafe(firstLine(rendered)), width)
}

/** A short journaled field, such as a seat or flow name, made terminal-inert. */
const field = (value: unknown, fallback: string): string => terminalSafe(asString(value) ?? fallback)

/**
 * Computes the diagnosis for one run from its ordered events. Reach for this
 * before rendering status or transcript output so both views share the same
 * counts and final state.
 *
 * `@smthrs/gateway` `Diagnosis.digest` is the fold; this adds the three facts
 * a terminal card reports and a served row does not, so `smthrs status` and a
 * client's run card cannot disagree about one run: how many calls repeated an
 * earlier call byte for byte, how many calls each flow took, and the approval
 * payload that unblocks a parked run.
 *
 * Total on purpose: payloads are wire `Json`, so every field read tolerates
 * absence and the digest of a malformed journal is a sparse digest, never a
 * throw.
 *
 * @param events the run's watch stream
 * @param runId the run being digested; a `control.run.*` verdict stamped with
 *   another run's id, such as a child's, sets neither status nor cause.
 *   Omitted, every verdict folds.
 * @category constructors
 * @since 0.1.0
 */
export const digest = (events: ReadonlyArray<ControlSchema.ControlEvent>, runId?: string): Digest => {
  if (runId !== undefined) events = events.filter((event) => !foreignVerdict(event, runId))
  const facts = diagnose(events, runId)
  let status: string | undefined
  let duplicateCalls = 0
  let parkedApproval: string | undefined
  const flowCounts = new Map<string, number>()
  const seen = new Map<string, number>()

  for (const event of uniqueCallEvents(events)) {
    const payload = asRecord(event.payload)
    if (event.kind === "control.agent.cell-call-started") {
      const flowName = asString(payload.flowName) ?? "?"
      flowCounts.set(flowName, (flowCounts.get(flowName) ?? 0) + 1)
      const identity = `${flowName}\u0000${JSON.stringify(payload.input) ?? ""}`
      const previous = seen.get(identity) ?? 0
      if (previous > 0) duplicateCalls += 1
      seen.set(identity, previous + 1)
      continue
    }
    if (event.kind === "control.approval.requested") {
      const approval = payload.payload
      parkedApproval = approval === undefined ? undefined : JSON.stringify(approval)
      continue
    }
    if (!event.kind.startsWith("control.run.")) continue
    const suffix = event.kind.slice("control.run.".length)
    if (cardStatuses.has(suffix)) status = suffix
  }

  return {
    ...facts,
    status,
    duplicateCalls,
    flows: [...flowCounts.entries()].sort((left, right) => right[1] - left[1]),
    parkedApproval
  }
}

/**
 * The one-line verdict: the status plus the reason that most explains it.
 *
 * Priority order mirrors what a reader needs first: a recorded failure cause,
 * then a park's question, then the "worked but never edited" pathology that a
 * green status would otherwise hide, then the resolved output.
 */
const verdict = (d: Digest): string => {
  const status = d.status ?? "unlaunched"
  if (status === "failed") {
    return d.cause === undefined
      ? "failed: no cause recorded in the journal"
      : `failed: ${clip(causeLine(d.cause), 160)}`
  }
  // `control.run.pending` is the executor declining the launch. The run row is
  // durable and stays `accepted` with nothing driving it, which the bare word
  // `pending` told an operator nothing about.
  if (status === "pending") {
    return "pending: accepted, and no executor took the run; nothing is driving it"
  }
  if (status === "waiting-approval") {
    return d.parkedQuestion === undefined
      ? "waiting-approval: a permission gate is pending"
      : `waiting-approval: asks: ${clip(d.parkedQuestion, 90)}`
  }
  if (status === "completed" && d.calls > 0 && d.editsAttempted === 0) {
    return `completed: but 0 of ${d.calls} calls attempted an edit; the run only read`
  }
  if (status === "completed" && d.finalOutput !== undefined && d.finalOutput.length > 0) {
    return `completed: ${clip(firstLine(d.finalOutput), 100)}`
  }
  return status
}

const label = (name: string): string => name.padEnd(10)

/**
 * Characters a POSIX shell passes through unchanged in an unquoted word.
 *
 * Everything else, including the empty string, is quoted. The set is
 * deliberately narrow: a value is quoted unless it is provably inert.
 */
const inertWord = /^[A-Za-z0-9_@%+=:,./-]+$/

/**
 * Quotes one argv element as exactly one POSIX shell word. Reach for this for
 * every caller-controlled value in a copy-paste command. It preserves all
 * bytes, including newlines, and performs no semantic validation.
 *
 * A value made only of characters no shell interprets is returned unchanged,
 * so the advertised command reads as the one an operator would have typed.
 * Anything else, including the empty string, is wrapped in single quotes with
 * embedded quotes escaped as `'\''`.
 *
 * @category conversions
 * @since 0.1.0
 */
export const shellQuote = (value: string): string =>
  inertWord.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`

const shellCommand = (...arguments_: ReadonlyArray<string>): string => arguments_.map(shellQuote).join(" ")

/**
 * Renders the status card for one run: verdict, gating cause, activity
 * evidence, and the exact next commands. Reach for this in `smthrs status` or
 * another read-only projection. Missing summaries render as unknown values,
 * and long evidence is clipped instead of throwing.
 *
 * @category rendering
 * @since 0.1.0
 */
export const renderDiagnosis = (
  run: {
    readonly runId?: string
    readonly flowId?: string
    readonly codeDrift?: {
      readonly recorded?: string | undefined
      readonly current?: string | undefined
      readonly recordedEngine?: string | undefined
      readonly currentEngine?: string | undefined
    } | undefined
  } | undefined,
  d: Digest
): string => {
  const lines: Array<string> = []
  const runId = run?.runId ?? "?"
  lines.push(`${label("Verdict")}${verdict(d)}`)
  lines.push(
    `${label("Run")}${runId}${run?.flowId === undefined ? "" : ` · ${run.flowId}`}${
      d.seat === undefined ? "" : ` · ${d.seat}`
    } · ${duration(d)}`
  )
  if (run?.runId !== undefined) lines.push(`${label("Trace")}${AgentSession.traceId(run.runId)}`)
  lines.push(
    `${
      label("Activity")
    }${d.turns} turns · ${d.calls} calls (${d.callsFailed} refused, ${d.duplicateCalls} duplicate) · edits ${d.editsSucceeded}/${d.editsAttempted}`
  )
  lines.push(
    `${label("Tokens")}${d.inputTokens.toLocaleString("en-US")} in / ${d.outputTokens.toLocaleString("en-US")} out`
  )
  if (d.costUsd > 0) lines.push(`${label("Cost")}${usd(d.costUsd)}`)
  for (const [index, refusal] of d.refusals.slice(0, 3).entries()) {
    lines.push(`${label(index === 0 ? "Refusals" : "")}${refusal.count}× ${clip(refusal.message, 110)}`)
  }
  if (d.cause !== undefined) {
    lines.push(`${label("Cause")}${clip(causeLine(d.cause), 240)}`)
  }
  if (d.finalOutput !== undefined && d.finalOutput.length > 0) {
    lines.push(`${label("Output")}${clip(firstLine(d.finalOutput), 120)}`)
  }
  const drift = run?.codeDrift
  if (drift !== undefined) {
    const changes = [
      ...(drift.recorded === undefined ? [] : [`flow ${drift.recorded} → ${drift.current ?? "gone"}`]),
      ...(drift.recordedEngine === undefined
        ? []
        : [`engine ${drift.recordedEngine} → ${drift.currentEngine ?? "unknown"}`])
    ]
    // A flow that is gone has no code to adopt; the flag would be refused.
    const next = drift.recorded !== undefined && drift.current === undefined
      ? "restore the flow to resume"
      : `resume needs ${shellCommand("smthrs", "runs", "resume", runId, "--allow-code-drift")}`
    lines.push(`${label("Drift")}${changes.join(", ")}    # ${next}`)
  }
  if (d.parkedApproval !== undefined) {
    lines.push(
      `${label("Unblock")}${shellCommand("smthrs", "approvals", "approve", d.parkedApproval, "--scope", "run")} && ${
        shellCommand("smthrs", "runs", "resume", runId)
      }`
    )
  }
  if (d.status === "pending") {
    // The two ways out, in the order an operator reaches for them: the host
    // that drives the flow takes the run, or the run ends.
    lines.push(
      `${label("Unblock")}${
        shellCommand("smthrs", "runs", "cancel", runId)
      }    # or run the flow from the host program that registers it`
    )
  }
  lines.push(`${label("Next")}${shellCommand("smthrs", "runs", "logs", runId)}    # turn-by-turn transcript`)
  return lines.join("\n")
}

const offset = (at: number, start: number): string => {
  const seconds = Math.max(0, Math.round((at - start) / 1000))
  return `+${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`
}

/**
 * Renders one event as a single follow-mode line. Reach for this while polling
 * a live run. Unknown event kinds fall back to their compact payload, and
 * missing fields render as empty or question-mark values rather than failing.
 *
 * @category rendering
 * @since 0.1.0
 */
export const eventLine = (event: ControlSchema.ControlEvent): string => {
  const payload = asRecord(event.payload)
  switch (event.kind) {
    case "control.agent.turn-opened":
      return `turn opened · ${field(payload.seat, "")}`
    case "control.agent.model-settled": {
      const usage = asRecord(payload.usage)
      return `model   ${compact(asString(payload.text) ?? "", 100)} (${asNumber(usage.inputTokens) ?? 0} in / ${
        asNumber(usage.outputTokens) ?? 0
      } out)`
    }
    case "control.agent.cell-produced":
      return `cell    ${compact(asString(payload.text) ?? "", 100)}`
    // The realm's whole channel to the next model turn. It used to be the
    // transition's `context`, which the `continue` line below reported in
    // bytes; that field left with the filing surface, and this is what
    // replaced it, so the reader is shown the same fact from where it now
    // lives.
    case "control.agent.cell-printed":
      return `print   ${compact(asString(payload.text) ?? "", 100)}`
    case "control.agent.cell-call-started":
      return `call    ${field(payload.flowName, "?")} ${compact(payload.input, 90)}`
    case "control.agent.cell-call-settled":
      return asString(payload.outcome) === "failure"
        ? `  -> FAIL ${compact(asString(payload.message) ?? "", 100)}`
        : `  -> ok ${compact(payload.value, 90)}`
    case "control.agent.transition-applied": {
      const transition = asRecord(payload.transition)
      const tag = asString(transition._tag) ?? "?"
      const justification = asString(transition.justification)
      // Only where the journal actually carries them, so a current run's line
      // is not two constants and a wave that filed is still read in full.
      const filed = [
        transition.state === undefined || transition.state === null
          ? undefined
          : `state ${JSON.stringify(transition.state).length}B`,
        Array.isArray(transition.context) && transition.context.length > 0
          ? `context ${JSON.stringify(transition.context).length}B`
          : undefined
      ].filter((part) => part !== undefined).join(" · ")
      return tag === "complete"
        ? `complete ${compact(asString(transition.output) ?? "", 90)}`
        : tag === "park"
        ? `park (${field(transition.reason, "?")}) ${compact(asString(transition.message) ?? "", 80)}`
        // `context` and `state` were the filing surface's two slots, and this
        // line used to report their byte sizes. Nothing populates either since
        // 2026-08-24, so reading them off a current run prints two constants;
        // journals from the r90–r96 waves still carry them, and those are the
        // only runs the byte counts are read for.
        : `continue${justification === undefined ? "" : ` · ${compact(justification, 90)}`}${
          filed === "" ? "" : ` · filed ${filed}`
        }`
    }
    case "control.agent.cell-settled": {
      const outcome = asRecord(payload.outcome)
      const tag = asString(outcome._tag) ?? "?"
      return tag === "settled"
        ? "cell settled"
        : `cell ${tag.toUpperCase()} ${compact(asString(outcome.message) ?? "", 90)}`
    }
    default:
      return `${event.kind} ${compact(event.payload, 80)}`
  }
}

/**
 * Renders the whole run as a turn-by-turn transcript. Reach for this when the
 * operator needs event order and model-turn boundaries rather than raw JSON.
 *
 * One `=== turn N ===` header per model turn; one line per event under it,
 * offset-stamped from the run's first event. Refusals and errors keep their
 * message; successful payloads are compressed to a line, because the reader
 * scanning for "where did it go wrong" needs the shape of the run, not the
 * bytes of every result.
 *
 * @param events the run's watch stream
 * @param watchedRunId the run being rendered; a child's verdict does not set its status
 * @category rendering
 * @since 0.1.0
 */
export const renderTranscript = (
  events: ReadonlyArray<ControlSchema.ControlEvent>,
  watchedRunId?: string
): string => {
  if (events.length === 0) return "No events."
  const d = digest(events, watchedRunId)
  const start = d.startedAt ?? 0
  const runId = watchedRunId ?? events.find((event) => event.runId !== undefined)?.runId
  const lines: Array<string> = [
    `${runId ?? "?"} · ${d.status ?? "?"} · ${
      duration(d)
    } · ${d.turns} turns · ${d.calls} calls (${d.callsFailed} refused) · ${
      d.inputTokens.toLocaleString("en-US")
    } in / ${d.outputTokens.toLocaleString("en-US")} out tok${d.costUsd > 0 ? ` · ${usd(d.costUsd)}` : ""}`
  ]
  let turn = 0
  for (const event of uniqueCallEvents(events)) {
    if (event.kind === "control.agent.turn-opened") {
      turn += 1
      lines.push("", `=== turn ${turn} · ${field(asRecord(event.payload).seat, "")} ===`)
      continue
    }
    if (!event.kind.startsWith("control.agent.")) {
      if (event.kind.startsWith("control.run.") || event.kind === "control.approval.requested") {
        lines.push(`[${offset(timeOf(event), start)}] ${event.kind.slice("control.".length)}`)
      }
      continue
    }
    if (event.kind === "control.agent.turn-closed" || event.kind === "control.agent.steering-drained") continue
    lines.push(`[${offset(timeOf(event), start)}] ${eventLine(event)}`)
  }
  return lines.join("\n")
}
