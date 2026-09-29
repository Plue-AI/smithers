/**
 * Observational progress for attached durable runs. The same watch that waits
 * for settlement feeds a projection with bounded display labels; no second subscriber, polling,
 * journal write, or terminal rendering is involved in deciding run state.
 *
 * @since 1.0.0
 */

import * as clack from "@clack/prompts"
import * as Audience from "@smthrs/build-cli/Audience"
import type { ControlSchema } from "@smthrs/control"
import { callEventKey, nativeCallEvent, openCallIndex } from "@smthrs/gateway/Diagnosis"
import * as Redaction from "@smthrs/journal/Redaction"
import { Cause, Context, Effect, Exit, HashMap, HashSet, Stream } from "effect"
import type { Writable } from "node:stream"
import { stripVTControlCharacters } from "node:util"
import { causeLine } from "../internal/Failure.ts"

/**
 * Invocation-scoped display settings, independent of document encoding.
 *
 * @category models
 * @since 1.0.0
 */
export interface Options {
  readonly policy: Audience.Policy
  readonly output?: Writable | undefined
}

/**
 * The public CLI and compatibility entrypoint provide the same policy here.
 * Embedders can replace the stderr sink without changing process globals.
 *
 * @category services
 * @since 1.0.0
 */
export const Configuration = Context.Reference<Options | undefined>("/cli/RunProgress", {
  defaultValue: () => undefined
})

/**
 * Immutable run projection. Eight active labels are retained, plus compact
 * call lifecycle identities for exact replay deduplication; no event payloads
 * or task results are retained.
 *
 * @category models
 * @since 1.0.0
 */
export interface State {
  readonly turns: number
  readonly started: number
  readonly completed: number
  readonly failed: number
  readonly skipped: number
  /** Skipped or deferred nodes that had been scheduled, so they no longer run. */
  readonly skippedStarted: number
  readonly active: ReadonlyArray<string>
  /** Identities aligned with the bounded active-label window. */
  readonly activeCallIds: ReadonlyArray<string | undefined>
  /** A persistent set keeps incremental duplicate checks cheap and pure. */
  readonly reportedCalls: HashSet.HashSet<string>
  /** Native facts can correct an earlier telemetry result without counting twice. */
  readonly nativeCalls: HashSet.HashSet<string>
  readonly callFailures: HashMap.HashMap<string, boolean>
  readonly status: string
  readonly settled: boolean
}

/**
 * One bounded, already-sanitized human log line.
 *
 * @category models
 * @since 1.0.0
 */
export interface Line {
  readonly level: "step" | "info" | "success" | "warn" | "error"
  readonly text: string
}

/**
 * Initial projection for a newly attached run.
 *
 * @category constructors
 * @since 1.0.0
 */
export const initial = (): State => ({
  turns: 0,
  started: 0,
  completed: 0,
  failed: 0,
  skipped: 0,
  skippedStarted: 0,
  active: [],
  activeCallIds: [],
  reportedCalls: HashSet.empty(),
  nativeCalls: HashSet.empty(),
  callFailures: HashMap.empty(),
  status: "Connecting to run",
  settled: false
})

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}

/**
 * Sanitizes untrusted journal text before clipping it; terminal commands and
 * recognized credentials cannot survive in labels, logs, or failure text.
 *
 * @category rendering
 * @since 1.0.0
 */
export const text = (value: unknown, maximum = 180): string => {
  if (typeof value !== "string") return ""
  const safe = String(Redaction.redactDiagnostic(stripVTControlCharacters(value)))
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
  return safe.length <= maximum ? safe : `${safe.slice(0, maximum - 1)}…`
}

const logLines = (value: unknown): ReadonlyArray<Line> => {
  if (typeof value !== "string") return []
  // Redact before splitting: a token assignment must not be split into an
  // innocuous key and an unlabelled secret on the following line.
  const safe = String(Redaction.redactDiagnostic(stripVTControlCharacters(value)))
  let count = 0
  const shown: Array<Line> = []
  for (const line of safe.matchAll(/[^\r\n]+/g)) {
    if (line[0].trim() === "") continue
    count++
    if (shown.length < 4) shown.push({ level: "info", text: text(line[0]) })
  }
  return count > 4
    ? [...shown, { level: "info", text: `${count - 4} more lines saved; use smthrs runs logs` }]
    : shown
}

/**
 * Projects only deliberate lifecycle/log fields, never arbitrary inputs,
 * generated code, model reasoning, or complete task result payloads.
 *
 * @category constructors
 * @since 1.0.0
 */
export const project = (
  state: State,
  event: ControlSchema.ControlEvent
): { readonly state: State; readonly lines: ReadonlyArray<Line> } => {
  const native = nativeCallEvent(event)
  event = native ?? event
  const payload = record(event.payload)
  const callKey = callEventKey(event)
  if (callKey !== undefined) {
    const duplicate = HashSet.has(state.reportedCalls, callKey)
    if (duplicate) {
      if (native === undefined || HashSet.has(state.nativeCalls, callKey)) return { state, lines: [] }
      state = { ...state, nativeCalls: HashSet.add(state.nativeCalls, callKey) }
      if (event.kind === "control.agent.cell-call-settled") {
        const previous = HashMap.get(state.callFailures, callKey)
        const failed = payload["outcome"] === "failure"
        if (previous._tag === "Some") {
          state = {
            ...state,
            completed: state.completed + Number(!failed) - Number(!previous.value),
            failed: state.failed + Number(failed) - Number(previous.value),
            callFailures: HashMap.set(state.callFailures, callKey, failed)
          }
        }
      }
      return { state, lines: [] }
    }
    state = {
      ...state,
      reportedCalls: HashSet.add(state.reportedCalls, callKey),
      nativeCalls: native === undefined ? state.nativeCalls : HashSet.add(state.nativeCalls, callKey),
      callFailures: event.kind !== "control.agent.cell-call-settled" ?
        state.callFailures :
        HashMap.set(state.callFailures, callKey, payload["outcome"] === "failure")
    }
  }
  switch (event.kind) {
    case "flows.engine.plan-recorded": {
      const nodes = typeof payload["nodes"] === "number" ? payload["nodes"] : undefined
      return {
        state: { ...state, status: "Scheduling plan", settled: false },
        lines: [{ level: "step", text: nodes === undefined ? "Plan recorded" : `Plan recorded · ${nodes} tasks` }]
      }
    }
    case "control.run.accepted":
    case "control.run.running":
    case "control.run.resumed":
      return { state: { ...state, status: "Starting run", settled: false }, lines: [] }
    case "control.agent.turn-opened": {
      const turns = state.turns + 1
      const seat = text(payload["seat"], 80)
      return {
        state: { ...state, turns, status: `Turn ${turns}${seat === "" ? "" : ` · ${seat}`}`, settled: false },
        lines: [{ level: "step", text: `Turn ${turns}${seat === "" ? "" : ` · ${seat}`}` }]
      }
    }
    case "control.agent.model-settled":
      return { state: { ...state, status: "Preparing tasks", settled: false }, lines: [] }
    case "control.agent.cell-produced":
      return { state: { ...state, status: "Executing agent step", settled: false }, lines: [] }
    case "flows.engine.node-scheduled":
    case "control.agent.cell-call-started": {
      const node = event.kind === "flows.engine.node-scheduled"
      const name = text(node ? payload["nodeId"] : payload["flowName"], 100) || "task"
      const retry = node && typeof payload["attempt"] === "number" && payload["attempt"] > 1
      const alreadyActive = retry && state.active.includes(name)
      const callId = !node && typeof payload["callId"] === "string" ? payload["callId"] : undefined
      return {
        state: {
          ...state,
          started: state.started + (retry ? 0 : 1),
          active: alreadyActive ? state.active : [...state.active, name].slice(-8),
          activeCallIds: alreadyActive ? state.activeCallIds : [...state.activeCallIds, callId].slice(-8),
          status: name,
          settled: false
        },
        lines: [{ level: "step", text: `${retry ? "Retrying" : "Running"} ${name}` }]
      }
    }
    case "flows.engine.node-settled":
    case "control.agent.cell-call-settled": {
      const node = event.kind === "flows.engine.node-settled"
      const name = text(node ? payload["nodeId"] : payload["flowName"], 100) || "task"
      const failed = payload["outcome"] === "failure" || payload["outcome"] === "failed"
      const skipped = node && (payload["outcome"] === "skipped" || payload["outcome"] === "deferred")
      const cached = node && payload["outcome"] === "clean"
      const callId = !node && typeof payload["callId"] === "string" ? payload["callId"] : undefined
      const index = openCallIndex(
        state.active.map((flowName, position) => ({ flowName, callId: state.activeCallIds[position] })),
        callId,
        name
      )
      const message = failed ? text(payload["message"]) : ""
      return {
        state: {
          ...state,
          completed: state.completed + (failed || skipped ? 0 : 1),
          failed: state.failed + (failed ? 1 : 0),
          skipped: state.skipped + (skipped ? 1 : 0),
          skippedStarted: state.skippedStarted + (skipped && index >= 0 ? 1 : 0),
          active: index < 0 ? state.active : state.active.filter((_, position) => position !== index),
          activeCallIds: index < 0
            ? state.activeCallIds
            : state.activeCallIds.filter((_, position) => position !== index),
          status: "Working",
          settled: false
        },
        lines: [{
          level: failed ? "error" : skipped ? "warn" : "success",
          text: `${name}${failed ? " failed" : skipped ? " skipped" : cached ? " cached" : " completed"}${
            message === "" ? "" : ` · ${message}`
          }`
        }]
      }
    }
    case "control.agent.cell-printed":
      return { state, lines: logLines(payload["text"]) }
    case "control.approval.requested":
      return {
        state: { ...state, status: "Approval requested" },
        lines: [{ level: "warn", text: "Approval requested" }]
      }
    case "control.run.waiting-approval":
      return { state: { ...state, status: "Waiting for approval", settled: true }, lines: [] }
    case "control.run.pending":
      return { state: { ...state, status: "Pending · executor did not start", settled: true }, lines: [] }
    case "control.run.completed":
      return { state: { ...state, status: "Completed", settled: true }, lines: [] }
    case "control.run.failed": {
      const cause = payload["cause"] ?? payload["message"]
      return {
        state: { ...state, status: "Failed", settled: true },
        lines: logLines(typeof cause === "string" ? causeLine(cause) : cause)
      }
    }
    case "control.run.cancelled":
      return { state: { ...state, status: "Cancelled", settled: true }, lines: [] }
    default:
      return { state, lines: [] }
  }
}

/**
 * Started work that has not settled yet.
 *
 * @category getters
 * @since 1.0.0
 */
export const running = (state: State): number =>
  Math.max(0, state.started - state.completed - state.failed - state.skippedStarted)

const summary = (state: State): string => {
  const active = running(state)
  const counts = `${state.completed} completed${state.failed === 0 ? "" : ` · ${state.failed} failed`}${
    state.skipped === 0 ? "" : ` · ${state.skipped} skipped`
  }`
  return `${state.status} · ${counts}${active === 0 || state.settled ? "" : ` · ${active} running`}`
}

const quote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`

/**
 * A renderer's bounded lifetime. Closing it never cancels the durable run.
 *
 * @category models
 * @since 1.0.0
 */
export interface Renderer {
  readonly event: (event: ControlSchema.ControlEvent) => void
  readonly close: (reason: "ended" | "interrupted" | "failed") => void
}

/**
 * Clack owns the live indicator; plain human sessions receive stable lines,
 * and agent/silent sessions allocate no timer or terminal listener.
 *
 * @category constructors
 * @since 1.0.0
 */
export const make = (runId: string, options: Options): Renderer => {
  if (options.policy.progress === "silent") return { event: () => {}, close: () => {} }
  const destination: Writable = options.output ?? process.stderr
  // Clack's timer and cleanup write outside the event callback. Give those
  // paths the same closed-stream guard as immediate lifecycle rendering so
  // closing stderr cannot leave a timer or signal listener behind.
  const output = new Proxy(destination, {
    get(target, key) {
      if (key === "write") {
        return (...args: Parameters<Writable["write"]>): boolean => {
          if (target.destroyed || target.writableEnded) return false
          try {
            return target.write(...args)
          } catch {
            return false
          }
        }
      }
      const value = Reflect.get(target, key, target)
      return typeof value === "function" ? value.bind(target) : value
    }
  })
  const common = { output }
  const live = options.policy.progress === "live"
  const spinner = live ? clack.spinner(common) : undefined
  let state = initial()
  let closed = false
  let spinning = false
  let lastSettlement: string | undefined
  const clear = (): void => {
    spinner?.clear()
    spinning = false
  }
  const animate = (): void => {
    if (spinner === undefined) return
    if (spinning) spinner.message(summary(state))
    else {
      spinner.start(summary(state))
      spinning = true
    }
  }
  const conclude = (message: string, failed = false): void => {
    const level = failed || state.status === "Failed" ? "error" : state.status === "Completed" ? "success" : "warn"
    if (spinner !== undefined && spinning) {
      if (level === "error") spinner.error(message)
      else if (level === "success") spinner.stop(message)
      else {
        spinner.clear()
        clack.log.warn(message, common)
      }
      spinning = false
    } else if (live) clack.log[level](message, common)
    else output.write(`${message}\n`)
  }
  // A closed stderr (for example, a pipe consumer exiting) must not fail or
  // cancel the action being observed. Rendering is best-effort observation.
  const paint = (body: () => void): void => {
    if (output.destroyed || output.writableEnded) return
    try {
      body()
    } catch {
      // The underlying command remains authoritative on success/failure.
    }
  }
  paint(() => {
    const heading = `Run ${text(runId, 100)}`
    if (live) clack.intro(heading, common)
    else output.write(`${heading}\n`)
    animate()
  })
  return {
    event(event) {
      if (closed) return
      const next = project(state, event)
      state = next.state
      paint(() => {
        if (next.lines.length > 0) clear()
        for (const line of next.lines) {
          if (live) clack.log[line.level](line.text, common)
          else output.write(`${line.text}\n`)
        }
        if (state.settled) {
          const result = summary(state)
          if (lastSettlement !== result) conclude(result)
          lastSettlement = result
        } else {
          lastSettlement = undefined
          animate()
        }
      })
    },
    close(reason) {
      if (closed) return
      closed = true
      paint(() => {
        const result = state.settled
          ? summary(state)
          : reason === "interrupted"
          ? "Stopped watching · run status is retained"
          : reason === "failed"
          ? "Progress stream failed · inspect the saved run"
          : "Stopped watching before settlement"
        if (lastSettlement !== result) conclude(result, reason === "failed")
        const next = state.status === "Waiting for approval"
          ? `smthrs approvals list\nsmthrs runs logs ${quote(text(runId, 100))}`
          : state.status === "Completed"
          ? `smthrs runs output ${quote(text(runId, 100))}`
          : `smthrs runs show ${quote(text(runId, 100))}\nsmthrs runs logs ${quote(text(runId, 100))}`
        if (live) clack.note(next, "Next", common)
        else output.write(`${next}\n`)
      })
      // Clear also releases Clack's timer/listeners if the output closed while
      // the run was active; cleanup must not depend on a writable terminal.
      clear()
    }
  }
}

/**
 * Taps the existing settlement stream and releases progress on success,
 * failure, or interruption. It never changes events or error semantics.
 *
 * @category combinators
 * @since 1.0.0
 */
export const observe = <E, R>(
  events: Stream.Stream<ControlSchema.ControlEvent, E, R>,
  runId: string,
  silent = false
): Stream.Stream<ControlSchema.ControlEvent, E, R> =>
  Stream.unwrap(Effect.gen(function*() {
    const configured = yield* Configuration
    const options = configured ?? {
      policy: Audience.resolve({
        env: process.env,
        stdin: process.stdin.isTTY === true,
        stdout: process.stdout.isTTY === true,
        stderr: process.stderr.isTTY === true
      })
    }
    if (silent || options.policy.progress === "silent") return events
    const renderer = yield* Effect.acquireRelease(
      Effect.sync(() => make(runId, options)),
      (renderer, exit) =>
        Effect.sync(() =>
          renderer.close(
            Exit.isFailure(exit)
              ? Cause.hasInterrupts(exit.cause) ? "interrupted" : "failed"
              : "ended"
          )
        )
    )
    return Stream.tap(events, (event) => Effect.sync(() => renderer.event(event)))
  }))
