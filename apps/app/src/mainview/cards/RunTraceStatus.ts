import { Option, Schema } from "effect"
import * as Digest from "@smthrs/core/Digest"
import { callScope, openCallIndex, uniqueCallEvents } from "@smthrs/gateway/Diagnosis"
import { FlowActivity } from "@smthrs/registry/Descriptor"
import { Implementation, Receipt, receiptMatches, type Plan } from "../../../../../flows/coding/schema"
import { engineRunEvidence } from "./EngineTrace"
import { callSemantics, callSubject, type CallMetadata, type TraceModel } from "./RunTrace"

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
const text = (value: unknown): string | undefined => typeof value === "string" && value !== "" ? value : undefined
const strings = (value: unknown): ReadonlyArray<string> => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
const terminal = new Set(["completed", "failed", "cancelled", "no-capacity"])
/** One open or just-settled call, with the semantics its record was read through. */
interface CurrentCall {
  readonly flowName: string
  readonly callId?: string
  readonly scope?: string
  readonly input: unknown
  readonly semantics: CallMetadata
}

/**
 * What the run is doing, in the words its own declaration chose.
 *
 * The header reads a call through `callSemantics` and `callSubject`, the same
 * two answers the rows and the phase bands read, so a call declared `reads`
 * with an `inspected` verb cannot show a researching band, an "inspected" row
 * and a "Wrote a.ts" header at once. A flow whose record carries no
 * presentation and that the compatibility table does not know is named, not
 * described: the header says it is running, and nothing more.
 */
const callActivity = (call: CurrentCall, outcome: "pending" | "success" | "failure"): string => {
  const verb = call.semantics.presentation?.verb[outcome]
    ?? (outcome === "pending"
      ? `running ${call.flowName}`
      : outcome === "failure"
      ? `failed ${call.flowName}`
      : `finished ${call.flowName}`)
  const subject = callSubject(call.input, call.semantics.presentation?.subject)
  return `${verb.charAt(0).toUpperCase()}${verb.slice(1)}${subject === "" ? "" : ` ${subject}`}`
}
const visible = (model: TraceModel, cursor = Infinity) => uniqueCallEvents(model.journal.filter(row =>
  Number.isSafeInteger(row.sequence) && row.sequence! <= cursor &&
  (row.runId === undefined || `run:${row.runId}` === model.root.id)))

export interface RunStatus {
  readonly verdict?: string
  readonly activity?: string
  readonly condition?: "thrashing" | "blocked" | "approval" | "runaway"
  readonly action?: "resume" | "approval"
  /** The runaway guard a park recorded: a budget or a time limit was hit. */
  readonly guard?: "budget" | "time"
}

/** The park reasons the runaway guards record (budget and time limits are incidents, never working limits). */
const RUNAWAY_REASONS: Readonly<Record<string, "budget" | "time">> = {
  budget: "budget", "budget-limit": "budget", "token-budget": "budget",
  time: "time", "time-limit": "time", timeout: "time", runaway: "time"
}

/**
 * What one recorded invocation is still carrying.
 *
 * A module run interleaves several steps in one journal, so a condition
 * belongs to the step that recorded it. Another step's progress is not this
 * step's answer: only a mutation or a sufficiency observed in the SAME
 * invocation, attempt and retry closes the brake that invocation is under.
 */
interface StepCondition {
  thrashing: boolean
  parked: "resume" | "approval" | undefined
  /** The guard that parked this invocation; cleared by the run's own resume. */
  runaway: "budget" | "time" | undefined
}

/** Current work and a separate condition. Historical callers must supply their cursor. */
export const traceStatus = (model: TraceModel, cursor?: number): RunStatus => {
  const latest = model.journal.reduce((seq, row) => Math.max(seq, row.sequence ?? 0), 0)
  if ((cursor === undefined || cursor >= latest) && terminal.has(model.root.status)) return { verdict: model.root.status }
  let activity: string | undefined, verdict: string | undefined
  const approvals = new Set<string>()
  const calls: Array<CurrentCall> = []
  const conditions = new Map<string, StepCondition>()
  /** The record's own step; a prompt journal records one unscoped stream. */
  const step = (row: { readonly payload?: unknown }): StepCondition => {
    const key = callScope(row) ?? ""
    const held = conditions.get(key) ?? { thrashing: false, parked: undefined, runaway: undefined }
    conditions.set(key, held)
    return held
  }
  /** The coordinates that say which invocation of one step recorded a fact. */
  const ordinals = (key: string): ReadonlyArray<number> => {
    const scope = JSON.parse(key) as ReadonlyArray<unknown>
    return [2, 3, 4, 6].map((index) => typeof scope[index] === "number" ? scope[index] : 0)
  }
  /**
   * A step records one invocation at a time, so the next one answers for it.
   *
   * `executionId`, `stepId` and `scope` name the step; `attempt`, `ask`,
   * `retry` and `generation` say which invocation of it this record belongs
   * to. A read-only invocation can never record a mutation, so a brake its
   * predecessor recorded would otherwise outlive every invocation that could
   * close it.
   */
  const supersede = (row: { readonly payload?: unknown }): void => {
    const key = callScope(row)
    if (key === undefined || conditions.size === 0) return
    const now = ordinals(key)
    const identity = JSON.parse(key) as ReadonlyArray<unknown>
    for (const held of conditions.keys()) {
      if (held === key || held === "") continue
      const was = JSON.parse(held) as ReadonlyArray<unknown>
      if (was[0] !== identity[0] || was[1] !== identity[1] || was[5] !== identity[5]) continue
      const previous = ordinals(held)
      const decided = now.findIndex((value, index) => value !== previous[index])
      if (decided >= 0 && now[decided]! > previous[decided]!) conditions.delete(held)
    }
  }
  for (const row of visible(model, cursor)) {
    supersede(row)
    const p = record(row.payload)
    switch (row.kind) {
      case "control.agent.turn-opened": activity = "Thinking"; break
      case "control.agent.cell-produced":
        // Native call facts can commit before this cell's telemetry arrives.
        // An active call is more specific than the delayed cell announcement.
        if (calls.length === 0) activity = "Running code"
        break
      case "control.agent.cell-call-started": {
        const name = text(p.flowName)
        if (name === undefined) break
        const call: CurrentCall = {
          flowName: name,
          callId: text(p.callId),
          scope: callScope(row),
          input: p.input,
          semantics: callSemantics(name, p)
        }
        calls.push(call)
        activity = callActivity(call, "pending")
        break
      }
      case "control.agent.cell-call-settled": {
        const index = openCallIndex(calls, text(p.callId), text(p.flowName), callScope(row))
        const ended = index < 0 ? undefined : calls.splice(index, 1)[0]
        const ongoing = calls.at(-1)
        if (ongoing !== undefined) activity = callActivity(ongoing, "pending")
        else if (ended !== undefined) activity = callActivity(ended, p.outcome === "failure" ? "failure" : "success")
        break
      }
      case "control.agent.repeat-demanded": step(row).thrashing = true; break
      case "control.agent.mutation-observed":
        if (p.basis === "observed" && p.mutated === true) step(row).thrashing = false
        break
      case "control.agent.sufficiency-observed":
        if (text(p.flow) !== undefined && p.passed !== undefined) step(row).thrashing = false
        break
      case "control.agent.suspended":
      case "control.run.parked": {
        const held = step(row)
        held.parked = p.reason === "approval" ? "approval" : "resume"
        held.runaway = typeof p.reason === "string" ? RUNAWAY_REASONS[p.reason] : undefined
        break
      }
      // The invocation ended. Whatever it was carrying ended with it.
      case "control.agent.resolved":
      case "control.agent.aborted": conditions.delete(callScope(row) ?? ""); break
      // The run's own record that it is running again ends every park it holds.
      // It says nothing about a brake, so it closes none.
      case "control.run.resumed": for (const one of conditions.values()) { one.parked = undefined; one.runaway = undefined } break
      case "control.approval.requested":
        if (text(p.requestId) !== undefined) approvals.add(p.requestId as string)
        break
      case "control.approval.approved":
      case "control.approval.denied": {
        const id = text(p.requestId) ?? text(p.tokenId)
        if (id !== undefined) approvals.delete(id)
        break
      }
      case "control.run.completed": verdict = "completed"; break
      case "control.run.failed": verdict = "failed"; break
      case "control.run.cancelled": verdict = "cancelled"; break
    }
  }
  if (verdict !== undefined) return { verdict }
  // The run's condition is what its steps still carry: a decision a person owes
  // first, then a park that needs a resume, then a brake that needs neither.
  const outstanding = [...conditions.values()]
  // A park a person can resume outranks one waiting on a decision, whichever
  // step recorded it first: the action is what the header offers.
  const parked = outstanding.some((one) => one.parked === "resume")
    ? "resume" : outstanding.find((one) => one.parked !== undefined)?.parked
  // A guard that parked the run is an incident: it outranks an ordinary park,
  // and a person answers it with the same Resume (continue) or a Stop.
  const guard = outstanding.find((one) => one.runaway !== undefined)?.runaway
  const condition: RunStatus["condition"] = approvals.size > 0 ? "approval"
    : guard !== undefined ? "runaway"
    : parked !== undefined ? "blocked"
    : outstanding.some((one) => one.thrashing) ? "thrashing" : undefined
  const action: RunStatus["action"] = approvals.size > 0 ? "approval" : parked === "resume" ? "resume" : undefined
  return {
    ...(activity === undefined ? {} : { activity }), ...(condition === undefined ? {} : { condition }),
    ...(action === undefined ? {} : { action }), ...(guard === undefined ? {} : { guard })
  }
}

export type GoalState = "pending" | "running" | "passed" | "failed" | "narrowed" | "stale"
export interface GoalCheck { readonly id: string; readonly target: string; readonly required: boolean; readonly state: GoalState }
export interface TraceGoal { readonly id: string; readonly title: string; readonly state: GoalState; readonly checks: ReadonlyArray<GoalCheck> }

/**
 * The activity the journal bound to this call, when its descriptor named one.
 *
 * A display hint can only ever DISQUALIFY a call here: it says what the flow
 * does, never that this run's required check passed.
 */
const recordedActivity = (payload: Record<string, unknown>, flowName: string): FlowActivity | undefined => {
  const descriptor = record(payload.descriptor)
  if (descriptor.name !== flowName) return undefined
  return Schema.is(FlowActivity)(descriptor.activity) ? descriptor.activity : undefined
}

/** Only these direct runner forms establish command checks. Shell programs and unknown runners do not. */
const checkSelection = (flow: string, input: unknown): ReadonlyArray<string> | undefined => {
  const p = record(input)
  if (flow === "test") return strings(p.selection)
  if (flow === "target.run") return text(p.label) === undefined ? undefined : [p.label as string]
  if (flow !== "bash" || typeof p.command !== "string" || /[;&|`$<>\n]/.test(p.command)) return undefined
  // Only complete literal arguments are supported; concatenated shell words cannot prove a target.
  if (!/^\s*(?:[^\s"'\\]+|"[^"\\]*"|'[^']*')(?:\s+(?:[^\s"'\\]+|"[^"\\]*"|'[^']*'))*\s*$/.test(p.command)) return undefined
  const tokens = p.command.match(/"[^"\n]*"|'[^'\n]*'|[^\s]+/g)?.map(token => token.replace(/^(['"])(.*)\1$/, "$2")) ?? []
  const prefix = tokens.slice(0, 3).join(" ")
  if (prefix === "bun run check" || prefix === "pnpm run check" || prefix === "python -m pytest") return tokens.slice(3)
  if (["bun test", "npx vitest", "pnpm vitest"].includes(tokens.slice(0, 2).join(" "))) return tokens.slice(tokens[2] === "run" ? 3 : 2)
  if (tokens[0] === "pytest" || tokens[0] === "vitest") return tokens.slice(tokens[1] === "run" ? 2 : 1)
  return undefined
}

const match = (selection: ReadonlyArray<string> | undefined, target: string): "full" | "narrowed" | undefined => {
  if (selection === undefined || target === "") return undefined
  const exact = selection.includes(target)
  const child = !target.startsWith("//") && selection.some(value => value.startsWith(`${target}/`) || value.startsWith(`${target}::`))
  if (!exact && !child) return undefined
  const flags = selection.filter(token => token.startsWith("-"))
  const narrowing = new Set(["-k", "-t", "-m", "--filter", "--grep", "--test-name-pattern", "--testNamePattern", "--testPathPattern", "--onlyFailures"])
  // An unknown flag establishes neither full coverage nor narrowing.
  if (flags.some(flag => !narrowing.has(flag.split("=")[0]!))) return undefined
  return child || flags.length > 0 ? "narrowed" : "full"
}

const relativePath = (value: string): string | undefined => {
  const path = value.replaceAll("\\", "/")
  if (path.startsWith("/") || /^[a-z]:\//i.test(path) || /[*?]/.test(path)) return undefined
  const parts: Array<string> = []
  for (const part of path.split("/")) {
    if (part === "..") { if (parts.pop() === undefined) return undefined }
    else if (part !== "" && part !== ".") parts.push(part)
  }
  return parts.join("/")
}
const overlap = (left: string, right: string): boolean => {
  if (right.startsWith("//")) return false
  const a = relativePath(left), b = relativePath(right)
  // An unanchored path or glob cannot establish that a change was unrelated.
  return a === undefined || b === undefined || a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)
}
const decodeImplementation = Schema.decodeUnknownOption(Implementation)
const decodeReceipt = Schema.decodeUnknownOption(Receipt)

/** Goals are the plan's changes. Only matching results can advance their checks. */
export const traceGoals = (model: TraceModel, plan: Plan | undefined, cursor?: number): ReadonlyArray<TraceGoal> => {
  if (plan === undefined) return []
  const journal = visible(model, cursor)
  const native = engineRunEvidence(journal, model.root.id.slice(4))
  const planKey = Digest.canonical(plan)
  const planSequence = native.completed.reduce((seq, execution) =>
    ["coding/PreparePlan", "coding/PrepareWithWiki"].includes(execution.flowName ?? "") && Digest.canonical(execution.result!.value) === planKey
      ? Math.max(seq, execution.result!.sequence) : seq, 0)
  return plan.changes.map(change => {
    const paths = change.atoms.flatMap(atom => [...atom.reads, ...atom.writes])
    const checks = change.checks.map(check => {
      // Whether a receipt bound to this check has already answered it. Unbound
      // evidence never replaces a bound answer; only a change to the tree the
      // receipt covered, or a newer receipt, moves it.
      let state: GoalState = "pending", invalidated = 0, resultSequence = 0, certified = false
      let checkedTree: string | undefined
      const nativeChecks = native.executions.flatMap(execution => {
        const wrapper = record(execution.input), input = record(wrapper.input ?? wrapper)
        const implementation = decodeImplementation(input.implementation)
        if (Option.isNone(implementation) || implementation.value.change !== change.id || input.check === undefined ||
          Digest.canonical(input.check) !== Digest.canonical(check) ||
          execution.flowName !== "coding/CommandCheck" && execution.flowName !== check.flow ||
          execution.flowName === "coding/CommandCheck" && wrapper.flow !== check.flow) return []
        const first = journal.find(row => row.kind === "control.engine.event" &&
          record(row.payload).executionId === execution.executionId && record(row.payload).generation === execution.generation)
        if (first === undefined || first.sequence! < planSequence) return []
        return [{ execution, implementation: implementation.value, opened: first.sequence! }]
      })
      const open: Array<{
        flowName: string; callId?: string; scope?: string; input: unknown; sequence: number
        activity?: FlowActivity; match?: "full" | "narrowed"
      }> = []
      const invalidate = (seq: number, changed: ReadonlyArray<string>) => {
        if (changed.length > 0 && paths.length > 0 && !changed.some(path => paths.some(planned => overlap(path, planned)) || overlap(path, check.target))) return
        invalidated = seq
        if (state !== "pending") state = "stale"
      }
      for (const row of journal) {
        const p = record(row.payload), seq = row.sequence!
        if (seq < planSequence) continue
        if (nativeChecks.some(entry => entry.opened === seq)) {
          state = "running"; resultSequence = seq
        }
        if (row.kind === "control.agent.mutation-observed" && p.basis === "observed" && p.mutated === true) invalidate(seq, strings(p.paths))
        if (row.kind === "control.agent.cell-call-started") {
          const flowName = text(p.flowName) ?? "", activity = recordedActivity(p, flowName)
          // A call the journal recorded as a read, a write or anything else is
          // not a check, whatever it is named. The band and the goal then read
          // one record the same way, instead of the strip saying researching
          // while the goal says the check ran.
          const matched = activity === undefined || activity === "checks" || activity === "tests"
            ? match(checkSelection(flowName, p.input), check.target) : undefined
          open.push({ flowName, activity, callId: text(p.callId), scope: callScope(row), input: p.input, sequence: seq, match: matched })
          if (matched !== undefined && !certified) { state = matched === "full" ? "running" : "narrowed"; resultSequence = seq }
        }
        if (row.kind === "control.agent.cell-call-settled") {
          const index = openCallIndex(open, text(p.callId), text(p.flowName), callScope(row))
          const call = index < 0 ? undefined : open.splice(index, 1)[0]
          if (call === undefined) continue
          // A custom flow the journal recorded as a write moves the tree exactly
          // as a built-in one does, so the paths it named invalidate the same
          // evidence. The recorded activity is the whole answer when the record
          // carries one: a familiar name over a call recorded as a read says
          // what the flow was called, never what it did.
          const wrote = call.activity !== undefined
            ? call.activity === "writes"
            : ["edit", "write", "apply_patch"].includes(call.flowName)
          if (wrote && p.outcome === "success") {
            const input = record(call.input)
            const patchPaths = typeof input.input === "string" ? [...input.input.matchAll(/^\*\*\* (?:(?:Add|Delete|Update) File|Move to): (.+)$/gm)].map(hit => hit[1]!) : []
            invalidate(seq, text(input.path) === undefined ? patchPaths : [input.path as string])
          }
          if (call.match === undefined || call.sequence < resultSequence || certified) continue
          resultSequence = call.sequence
          const value = record(p.value)
          state = invalidated >= call.sequence ? "stale" : p.outcome === "failure" || value.invalidProbe !== undefined ? "failed"
            : typeof value.exitCode !== "number" || !Number.isInteger(value.exitCode) ? "pending"
            : value.exitCode !== 0 || strings(value.failed).length > 0 ? "failed"
            // A recorded command that matched the target's TEXT is not this
            // plan's check: nothing on it binds the result to the check's
            // implementation, revision or scope, which is what a receipt binds.
            // It is partial evidence, and partial evidence never verifies.
            : value.parsed === true && value.passed === 0 ? "pending" : "narrowed"
        }
        if (row.kind === "control.agent.narrowed-demanded" || row.kind === "control.agent.narrow-only-demanded") {
          const inputs = [p.broader, p.narrower, p.check].map(value => {
            if (typeof value !== "string") return value
            try { return JSON.parse(value) as unknown } catch { return { command: value } }
          })
          if (!certified && (inputs.some(input => match(checkSelection(text(p.flow) ?? "", input), check.target) !== undefined) || strings(p.targets).includes(check.target))) {
            state = "narrowed"; resultSequence = seq
          }
        }
        for (const execution of native.completed.filter(entry => entry.result!.sequence === seq)) {
          if (![change.implementation, "coding/ImplementAtoms"].includes(execution.flowName ?? "")) continue
          const implemented = decodeImplementation(execution.result!.value)
          if (Option.isSome(implemented) && implemented.value.change === change.id &&
            checkedTree !== undefined && checkedTree !== implemented.value.head.treeId) invalidate(seq, implemented.value.writes)
        }
        for (const { execution, implementation, opened } of nativeChecks) {
          if (opened < resultSequence) continue
          if (execution.failure?.sequence === seq) { state = "failed"; resultSequence = opened; certified = true }
          if (execution.result?.sequence !== seq) continue
          const receipt = decodeReceipt(execution.result.value)
          if (Option.isNone(receipt) || !receiptMatches(implementation, check, receipt.value)) {
            state = "pending"
            continue
          }
          state = invalidated >= opened || receipt.value.status === "superseded" ? "stale" : receipt.value.status
          checkedTree = implementation.head.treeId
          resultSequence = opened
          certified = true
        }
      }
      return { id: check.id, target: check.target, required: check.required, state }
    })
    const required = checks.filter(check => check.required)
    const state: GoalState = required.length > 0 && required.every(check => check.state === "passed") ? "passed"
      : required.some(check => check.state === "failed") ? "failed"
      : required.some(check => check.state === "stale") ? "stale"
      : required.some(check => check.state === "narrowed") ? "narrowed"
      : required.some(check => check.state === "running") ? "running" : "pending"
    return { id: change.id, title: change.title, state, checks }
  })
}
