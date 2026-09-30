/**
 * The run trace model (factory spec 06, "the run trace": one card shows every
 * run).
 *
 * A run is a recursive program: the agent writes REPL cells in a code
 * container, every `ctx.call` is a durable span, and each turn is a frame. The
 * control journal already records exactly that (`@smthrs/agent` AgentSession
 * journals turn-opened, model-settled, cell-produced, cell-call-started,
 * cell-call-settled, cell-printed, cell-settled, resolved), and the gateway
 * serves it as the `run-events` projection the run card already reads. This
 * module folds those records into a span tree, run → frame → cell → call, and
 * the geometry of one bar per span on a shared time axis. No second data
 * source: what the journal does not carry (realm variables, child runs' own
 * frames) the model does not invent.
 *
 * Pure: the card renders the model, the tests read it from a fixture.
 * @since 1.0.0
 */

import { CallPresentation, FlowActivity, type FlowDescriptor } from "@smthrs/registry/Descriptor"
import { Schema } from "effect"
import { callScope, openCallIndex } from "./Diagnosis.ts"
import { engineTraceFromJournal } from "./EngineTrace.ts"
import { type CallEventFilter, callEventFilter, uniqueCallEvents } from "./internal/callEvents.ts"

/** One control journal record, as the run card stores it (the run-events projection's row shape).
 *
 * @category models
 * @since 1.0.0
 */
export interface JournalRecord {
  readonly runId?: string | undefined
  readonly sequence?: number | undefined
  readonly kind?: string | undefined
  readonly occurredAt?: number | undefined
  readonly payload?: unknown | undefined
}

/**
 * What kind of node a span is in the tree. `fork` is the row 0 of a forked run
 * (spec 06 §1); no journal record folds into it yet, so no fold produces one.
 *
 * @category models
 * @since 1.0.0
 */
export type SpanKind =
  | "run"
  | "frame"
  | "model"
  | "cell"
  | "call"
  | "approval"
  | "resolved"
  | "event"
  | "fork"
  | "execution"
  | "attempt"

/** What the journal said about the span; the run root wears the run's own status word.
 *
 * @category models
 * @since 1.0.0
 */
export type SpanStatus = "running" | "completed" | "failed" | "waiting" | "approved" | "denied" | string

/** The facts the details pane shows for one span: only what its journal records carry.
 *
 * @category models
 * @since 1.0.0
 */
export interface SpanDetail {
  /** The journal sequence that opened the span. */
  readonly sequence?: number | undefined
  /** The journal kind that opened the span. */
  readonly event?: string | undefined
  readonly seat?: string | undefined
  /** A cell's source text. */
  readonly source?: string | undefined
  /** What a cell printed for the next model turn. */
  readonly printed?: string | undefined
  /** A call's input, as journaled. */
  readonly input?: unknown | undefined
  /** A call's settled value, a model's text, or a resolved text. */
  readonly output?: string | undefined
  /** A detached child's recorded execution id; only the agent/spawn result establishes this edge. */
  readonly childRunId?: string | undefined
  /** A failure's message. */
  readonly message?: string | undefined
  readonly usage?: { readonly inputTokens?: number | undefined; readonly outputTokens?: number | undefined } | undefined
  /** Every other payload field the opening record carried, as the journal bound it. */
  readonly fields?: Readonly<Record<string, unknown>> | undefined
}

/**
 * One nested execution span with its original journal evidence.
 *
 * @category models
 * @since 1.0.0
 */
export interface TraceSpan {
  readonly id: string
  readonly kind: SpanKind
  readonly label: string
  readonly status: SpanStatus
  readonly startedAt: number
  /** Absent while the span is open. */
  readonly endedAt?: number | undefined
  readonly depth: number
  readonly children: ReadonlyArray<TraceSpan>
  readonly detail: SpanDetail
}

/** The run the trace belongs to, as the run card knows it.
 *
 * @category models
 * @since 1.0.0
 */
export interface TraceRun {
  readonly runId: string
  readonly flowId: string
  /** The run card's phase word (running, completed, failed, cancelled, waiting-approval, ...). */
  readonly status: string
  readonly kind?: string | undefined
}

/**
 * The recorded start and end of a trace in milliseconds.
 *
 * @category models
 * @since 1.0.0
 */
export interface TraceExtent {
  readonly start: number
  readonly end: number
}

/**
 * What a frame was doing, derived from what it did — never declared.
 *
 * `unrecorded` is the honest reading of a frame whose journal carries nothing
 * this fold can name: every other word here is a claim about the frame's work,
 * and a claim needs a record behind it.
 *
 * @category models
 * @since 1.0.0
 */
export type PhaseId = "researching" | "implementing" | "testing" | "stuck" | "blocked" | "unrecorded"

/** One contiguous run of frames in one phase.
 *
 * @category models
 * @since 1.0.0
 */
export interface PhaseBand {
  readonly phase: PhaseId
  readonly startedAt: number
  readonly endedAt: number
  /** Span ids of the frames in this band, in order. */
  readonly frames: ReadonlyArray<string>
  /** Journal sequence to scrub to when this band is clicked. */
  readonly seq: number
}

/** A moment a person would scrub to.
 *
 * @category models
 * @since 1.0.0
 */
export interface Milestone {
  readonly seq: number
  readonly at: number
  readonly label: string
  readonly tone: "warn" | "bad" | "good" | "brand"
  /**
   * The frame this moment was recorded under, carried through the scoped
   * merge. Two steps run at once in one journal, so the frame a milestone
   * belongs to is the one its OWN step had open, never whichever frame opened
   * last.
   */
  readonly spanId: string
}

/**
 * The frame one journal record was recorded under.
 *
 * The strip scrubs to sequences no milestone names, so the ownership rule has
 * to hold for every record, not only for the ones that mint a pin.
 *
 * @category models
 * @since 1.0.0
 */
export interface TraceOwner {
  readonly seq: number
  readonly spanId: string
}

/** What one frame did, in plain English, derived from its calls.
 *
 * @category models
 * @since 1.0.0
 */
export interface FrameLine {
  readonly spanId: string
  /** Frame ordinal as shown to a person, 1-based. */
  readonly frame: number
  readonly verb: string
  /** Empty when the call's input named nothing this fold reads as a subject; the card then prints the verb alone. */
  readonly subject: string
  readonly result: string
  readonly failed: boolean
  readonly wrote: boolean
  /** Frame ordinal this repeats, set ONLY inside a stall streak. */
  readonly repeatOf?: number | undefined
}

/** A discipline event, rendered where it happened.
 *
 * @category models
 * @since 1.0.0
 */
export interface TraceNote {
  readonly seq: number
  /** Span id of the frame it attaches under. */
  readonly spanId: string
  readonly tone: "warn" | "bad" | "good"
  readonly title: string
  readonly body: string
  /** Quoted evidence lines, already clipped. */
  readonly evidence?: ReadonlyArray<string> | undefined
}

/** Extra options the fold takes; every field optional, absent = today's behaviour.
 *
 * @category models
 * @since 1.0.0
 */
export interface TraceOptions {
  /** Plan targets are coverage requirements, never evidence that a call ran tests. */
  readonly checkTargets?: ReadonlyArray<string> | undefined
}

/**
 * The shared projection rendered by app and terminal monitors.
 *
 * @category models
 * @since 1.0.0
 */
export interface TraceModel {
  /** Source records for status and check receipts, including their settlement sequences. */
  readonly journal: ReadonlyArray<JournalRecord>
  readonly root: TraceSpan
  /** Every span in tree order, with its depth: the tree's rows and the waterfall's rows. */
  readonly rows: ReadonlyArray<TraceSpan>
  readonly extent: TraceExtent
  readonly counts: { readonly spans: number; readonly running: number; readonly failed: number }
  /** The run's frames merged into what they were doing; empty when the journal opened no frame. */
  readonly bands: ReadonlyArray<PhaseBand>
  /** The moments a person scrubs to, in journal order; empty when the journal recorded none. */
  readonly milestones: ReadonlyArray<Milestone>
  /** One line per frame that called something; a frame that called nothing has none. */
  readonly lines: ReadonlyArray<FrameLine>
  /** The discipline records that carry fields, attached where they happened. */
  readonly notes: ReadonlyArray<TraceNote>
  /** Every recorded sequence with the frame it was recorded under, in journal order. */
  readonly owners: ReadonlyArray<TraceOwner>
}

/** Mutable draft shared by the control and native journal folds; never persisted.
 *
 * @category models
 * @since 1.0.0
 */
export interface TraceBuilder {
  readonly id: string
  readonly kind: SpanKind
  label: string
  status: SpanStatus
  startedAt: number
  endedAt?: number | undefined
  readonly children: Array<TraceBuilder>
  detail: SpanDetail
}
type Builder = TraceBuilder

const TERMINAL_RUN: ReadonlySet<string> = new Set(["completed", "failed", "cancelled", "no-capacity"])

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
const asString = (value: unknown): string | undefined => typeof value === "string" ? value : undefined
const asNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined

/** The record's time: the agent's own `at` stamp when it carries one, the journal's otherwise (the gateway's rule). */
const timeOf = (record: JournalRecord, payload: Record<string, unknown>): number =>
  asNumber(payload.at) ?? asNumber(record.occurredAt) ?? 0

/** One line of text for a value the journal traced, or nothing. */
const textOf = (value: unknown): string | undefined => {
  if (value === undefined || value === null) return undefined
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/** The payload fields the pane does not already show by name. */
const restOf = (
  payload: Record<string, unknown>,
  shown: ReadonlyArray<string>
): Record<string, unknown> | undefined => {
  const rest: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(payload)) {
    if (shown.includes(key) || key === "at" || key === "journalVersion") continue
    rest[key] = value
  }
  return Object.keys(rest).length === 0 ? undefined : rest
}

const builder = (
  id: string,
  kind: SpanKind,
  label: string,
  status: SpanStatus,
  startedAt: number,
  detail: SpanDetail
): Builder => ({ id, kind, label, status, startedAt, children: [], detail })

/*
 * What the frame was DOING.
 *
 * Same discipline as the tree above, held one level closer to the reader:
 * every word below is read off a journal record, never off what the model said
 * it would do. A frame's line comes from the calls it made; its phase comes
 * from those calls and from the controller's own observations of the tree; a
 * note is a discipline record's own fields, quoted. Nothing here counts what
 * the journal may be missing, and a frame the journal says nothing about gets
 * nothing said about it.
 */

/**
 * What a recorded call means: what it did, and how it reads.
 *
 * The rows, the phase bands and the run header all read a call through this
 * one answer, so they cannot tell three different stories about one record.
 *
 * @category models
 * @since 1.0.0
 */
export type CallMetadata = Pick<FlowDescriptor, "activity" | "presentation">

/** Compatibility for journals whose descriptors predate presentation metadata. */
const legacy = (
  activity: FlowActivity | undefined,
  pending: string,
  success: string,
  failure: string,
  subject: CallPresentation["subject"],
  result: CallPresentation["result"]
): CallMetadata => ({
  ...(activity === undefined ? {} : { activity }),
  presentation: { verb: { pending, success, failure }, subject, result }
})

const LEGACY_PRESENTATION: ReadonlyMap<string, CallMetadata> = new Map([
  // `bash` has no compatibility activity for the same reason `@smthrs/std`
  // declares none: what a shell call does is in the command, which the rule
  // below reads off the record.
  ["bash", legacy(undefined, "running", "ran", "failed to run", "command", "command")],
  ["test", legacy("tests", "running", "ran", "failed to run", "selection", "tests")],
  ["edit", legacy("writes", "editing", "edited", "failed to edit", "path", "edit")],
  ["write", legacy("writes", "writing", "wrote", "failed to write", "path", "write")],
  ["apply_patch", legacy("writes", "patching", "patched", "failed to patch", "patch", "patch")],
  ["read", legacy("reads", "reading", "read", "failed to read", "path", "read")],
  ["grep", legacy("reads", "searching", "searched", "failed to search", "pattern", "matches")],
  ["glob", legacy("reads", "listing", "listed", "failed to list", "pattern", "paths")],
  ["ls", legacy("reads", "listing", "listed", "failed to list", "path", "entries")]
])

/** Read only the descriptor's validated display fields; a call input is never metadata. */
const recordedMetadata = (value: unknown, flowName: string): CallMetadata | undefined => {
  const descriptor = asRecord(value)
  if (descriptor.name !== flowName) return undefined
  if (descriptor.activity === undefined && descriptor.presentation === undefined) return undefined
  const activity = Schema.is(FlowActivity)(descriptor.activity) ? descriptor.activity : undefined
  const presentation = Schema.is(CallPresentation)(descriptor.presentation) ? descriptor.presentation : undefined
  return { activity, presentation }
}

/**
 * The name a queued checkpoint mint carries (`QuickJSSandbox` `checkpointFlow`).
 * A mint journals `control.agent.checkpoint-minted` and never a call, so no
 * call in a journal wears this name today; the dominant-call rule skips it
 * anyway, so a host that binds a flow by that name cannot make a frame's
 * headline read as bookkeeping.
 */
const CHECKPOINT_FLOW = "checkpoint"

/** The command line a call ran, for the flows that run one. */
const commandOf = (input: unknown): string | undefined => {
  const fields = asRecord(input)
  return asString(fields.command) ?? asString(fields.script)
}

/** The last segment of a path: the name a person calls the file. */
const basename = (path: string): string => path.split("/").filter((part) => part !== "").pop() ?? path

/**
 * The files a V4A patch names (`@smthrs/std` ApplyPatch's `*** Add File: `,
 * `*** Delete File: ` and `*** Update File: ` markers).
 *
 * `apply_patch` carries its entire patch in one `input` string, and the patch
 * is not the subject: what it patches is. A string that is not a patch names no
 * files and yields none, so a flow that happens to call its field `input` is
 * not mistaken for one.
 */
const patchedPaths = (patch: string): ReadonlyArray<string> => {
  const paths: Array<string> = []
  for (const line of patch.split("\n")) {
    const named = /^\*\*\* (?:Add|Delete|Update) File:\s*(\S.*)$/.exec(line.trim())?.[1]
    if (named !== undefined) paths.push(named.trim())
  }
  return paths
}

/**
 * Several files in the room one name has: the first named, the rest counted.
 *
 * A multi-file patch's line and a frame's write pin both say it through here,
 * so `views.py +1` means one thing wherever the card prints it. The count is a
 * fact the journal carried, never an estimate. No file, no words.
 */
const filesLabel = (paths: ReadonlyArray<string>): string => {
  const first = paths[0]
  if (first === undefined) return ""
  return paths.length === 1 ? basename(first) : `${basename(first)} +${paths.length - 1}`
}

/** The files an edit-like call names: its `path`, or every file its patch names. */
const writtenPaths = (input: unknown): ReadonlyArray<string> => {
  const fields = asRecord(input)
  const path = asString(fields.path)
  if (path !== undefined) return [path]
  const patch = asString(fields.input)
  return patch === undefined ? [] : patchedPaths(patch)
}

/**
 * What one recorded call was about, in the shape its declaration chose.
 *
 * Exported because the run header names the same subject as the row beneath
 * it: two readings of one input is two answers to one question.
 *
 * @param input the call input, as journaled
 * @param format the declared subject field, when the declaration named one
 *
 * @category utilities
 * @since 1.0.0
 */
export const callSubject = (input: unknown, format?: CallPresentation["subject"]): string => {
  const fields = asRecord(input)
  if (format === "none") return ""
  if (format === "path") return asString(fields.path) === undefined ? "" : basename(fields.path as string)
  if (format === "command") return commandOf(input) ?? ""
  if (format === "patch") return filesLabel(patchedPaths(asString(fields.input) ?? ""))
  if (format === "pattern") return asString(fields.pattern) ?? ""
  if (format === "selection") return stringList(fields.selection)?.join(" ") ?? ""
  const path = asString(fields.path)
  if (path !== undefined) return basename(path)
  const command = commandOf(input)
  if (command !== undefined) return command
  const patch = asString(fields.input)
  if (patch !== undefined) {
    // The patch is not the subject; the files it patches are.
    const files = filesLabel(patchedPaths(patch))
    if (files !== "") return files
  }
  // `test` names what it selected (`@smthrs/std` TestRun `Input.selection`).
  // An omitted selection means the record named nothing; that the flow would
  // then run everything is the flow's default, not a fact this record carries.
  const selection = Array.isArray(fields.selection)
    ? fields.selection.filter((one): one is string => typeof one === "string")
    : undefined
  if (selection !== undefined && selection.length > 0) return selection.join(" ")
  return asString(fields.pattern) ?? ""
}

/**
 * Legacy shell journals have no structured activity. Recognize only direct
 * invocations of known runners. Shell composition, expansion and quoted
 * programs remain unknown. Arguments can narrow a check without changing
 * its activity; no command here establishes a plan's required coverage.
 */
const shellActivity = (command: string): FlowActivity => {
  if (/[;&|<>`$\n\r]/.test(command)) return "other"
  const words = command.trim().split(/\s+/)
  const first = words[0]!
  if (["pytest", "vitest", "jest"].includes(first)) return "tests"
  if (/^python[23]?$/.test(first) && words[1] === "-m" && ["pytest", "unittest"].includes(words[2] ?? "")) {
    return "tests"
  }
  if (first === "bun" && words[1] === "test") return "tests"
  if (["pnpm", "npm", "bun"].includes(first)) {
    if (words[1] === "test" || (words[1] === "run" && words[2] === "test")) return "tests"
    if (words[1] === "exec" && ["vitest", "jest"].includes(words[2] ?? "")) return "tests"
    if (words[1] === "run" && ["check", "typecheck", "lint"].includes(words[2] ?? "")) return "checks"
  }
  if (first === "go" && words[1] === "test") return "tests"
  if (first === "cargo" && words[1] === "test") return "tests"
  if (first === "tsc") return "checks"
  return "other"
}

/**
 * The one reading of a recorded call's semantics, shared by the rows, the
 * phase bands and the run header.
 *
 * Precedence, and why: the record's own `descriptor` wins, because it is what
 * the declaration said when the call was made, and only a record that carries
 * none falls back to {@link LEGACY_PRESENTATION}, which is a guess about the
 * flows that were journaled before a declaration could say anything. A flow the
 * table does not know stays unknown, and unknown is said as unknown.
 *
 * `bash` is the one activity read off the call rather than the declaration.
 * `@smthrs/std` declares none for it on purpose — the same flow runs a test
 * suite, a type check and `cat` — so a recognised runner in the recorded
 * command is the only thing that names the activity, and an explicit
 * declaration still outranks it.
 *
 * @param flowName the flow the record names
 * @param payload the `cell-call-started` payload, as journaled
 *
 * @category utilities
 * @since 1.0.0
 */
export const callSemantics = (
  flowName: string,
  payload: Record<string, unknown>
): CallMetadata => {
  const recorded = recordedMetadata(payload.descriptor, flowName)
  const metadata = recorded ?? LEGACY_PRESENTATION.get(flowName)
  const activity = metadata?.activity
    ?? (flowName === "bash" ? shellActivity(commandOf(payload.input) ?? "") : undefined)
  return {
    ...(activity === undefined ? {} : { activity }),
    ...(metadata?.presentation === undefined ? {} : { presentation: metadata.presentation })
  }
}

const stringList = (value: unknown): ReadonlyArray<string> | undefined =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : undefined

const countOf = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined

const counted = (value: number, noun: string, plural = `${noun}s`): string => `${value} ${value === 1 ? noun : plural}`

/** Known output fields only. Unknown objects remain in the call's raw output. */
const resultOf = (value: unknown, format?: CallPresentation["result"]): string => {
  if (format === "none") return ""
  if (typeof value === "string") return clip(value) ?? ""
  const fields = asRecord(value)
  if (fields.truncated === true && typeof fields.digest === "string") return ""
  switch (format) {
    case "read": {
      const start = countOf(fields.startLine)
      const end = countOf(fields.endLine)
      return start !== undefined && start > 0 && end !== undefined && end >= start - 1
        ? counted(end - start + 1, "line") :
        ""
    }
    case "write":
      return countOf(fields.bytesWritten) === undefined ? "" : counted(fields.bytesWritten as number, "byte")
    case "edit":
      return countOf(fields.replacements) === undefined ? "" : counted(fields.replacements as number, "replacement")
    case "patch": {
      const groups = [stringList(fields.added), stringList(fields.modified), stringList(fields.deleted)]
      return groups.every((group) => group !== undefined) ? counted(new Set(groups.flat()).size, "file") : ""
    }
    case "tests": {
      const passed = countOf(fields.passed)
      const failed = stringList(fields.failed)
      if (fields.parsed === true && passed !== undefined && failed !== undefined && fields.invalidProbe === undefined) {
        const exit = countOf(fields.exitCode)
        return `${passed} passed${
          failed.length > 0 ? ` · ${failed.length} failed` : exit !== undefined && exit !== 0 ? ` · exit ${exit}` : ""
        }`
      }
      return countOf(fields.exitCode) === undefined ? "" : `exit ${fields.exitCode}`
    }
    case "command":
      return countOf(fields.exitCode) === undefined ? "" : `exit ${fields.exitCode}`
    case "matches":
      return Array.isArray(fields.matches) ? counted(fields.matches.length, "match", "matches") : ""
    case "paths":
      return stringList(fields.paths) === undefined
        ? ""
        : counted((fields.paths as ReadonlyArray<string>).length, "file")
    case "entries":
      return Array.isArray(fields.entries) ? counted(fields.entries.length, "entry", "entries") : ""
    default:
      return ""
  }
}

/** A note body from the sentences the payload carried; a field the record omitted contributes nothing. */
const bodyOf = (...sentences: ReadonlyArray<string | undefined>): string =>
  sentences.filter((sentence) => sentence !== undefined).join(" ")

/** One quoted line of evidence, bounded the way the turn list bounds prose. */
const clip = (value: unknown): string | undefined => {
  const line = asString(value)
  if (line === undefined || line === "") return undefined
  return line.length <= 160 ? line : `${line.slice(0, 159).trimEnd()}…`
}

/** One call a frame made, as the journal opened and settled it. */
interface CallFacts {
  readonly flowName: string
  readonly callId?: string | undefined
  readonly input: unknown
  readonly activity?: FlowActivity | undefined
  readonly presentation?: CallPresentation | undefined
  /**
   * What a repeat is judged by: the flow and the input exactly as journaled. A
   * field the trail truncated still canonicalizes to its own digest, so a
   * repeat of a huge input is still recognised as one.
   */
  readonly signature: string
  settled?:
    | { readonly failed: boolean; readonly result: string; readonly denied: boolean; readonly value: unknown }
    | undefined
  /** What a repeat is matched on: the signature and the settlement. */
  reading?: string | undefined
}

/** What one frame did, as its own records said it. */
interface FrameFacts {
  readonly id: string
  readonly frame: number
  readonly seq: number
  readonly startedAt: number
  endedAt: number
  blocked: boolean
  /** `control.agent.mutation-observed`'s answer; absent when the frame closed on none. */
  mutated?: boolean | undefined
  /** A measured tree comparison outranks declared writes and successful no-op calls. */
  observedMutation?: boolean | undefined
  /** The write pin this frame minted: where it sits in the milestones, and every file it counts. */
  wrote?: { readonly milestone: number; readonly paths: Array<string> } | undefined
  readonly calls: Array<CallFacts>
}

/** Whether the frame made an edit-like call the journal recorded settling successfully. */
const madeAWrite = (entry: FrameFacts): boolean =>
  entry.calls.some((call) => call.activity === "writes" && call.settled?.failed === false && !call.settled.denied)

/**
 * The call a frame's line is about: a change it made, else the check it ran,
 * else the first thing it asked for.
 *
 * The phase rules and the lines read the same answer, so the two can never
 * disagree about whether the journal said anything about a frame at all.
 */
const dominantCall = (entry: FrameFacts): CallFacts | undefined =>
  entry.calls.find((one) => one.activity === "writes")
    ?? entry.calls.find((one) => one.activity === "checks" || one.activity === "tests")
    ?? entry.calls.find((one) => one.flowName !== CHECKPOINT_FLOW)

/**
 * Folds the journal a second time, into what a person would say the run was
 * doing: its phase bands, its milestones, one line per frame, and the
 * discipline notes.
 *
 * Read off the RECORDS rather than off the spans the fold above builds, for
 * three reasons. The spans keep a settled value as text (`textOf`), so an
 * `ask` denial would have to be parsed back out of JSON. An unrecognised
 * kind's span hangs off `cell ?? frame ?? root`, so the frame a note belongs
 * to would have to be recovered from tree position. And that span shape is the
 * fold's `default` arm: the day a kind gains a case of its own, notes read off
 * `detail.fields` would vanish without a word, while notes read off the
 * records keep working.
 *
 * @param runId the run, for the notes that land before any frame opened
 * @param ordered the journal, in sequence order, call events already deduplicated
 */
interface DisciplineState {
  readonly runId: string
  readonly frames: Array<FrameFacts>
  readonly notes: Array<TraceNote>
  readonly milestones: Array<Milestone>
  readonly owners: Array<TraceOwner>
  readonly open: Array<CallFacts>
  frame: FrameFacts | undefined
  lastAt: number
  /** Each frame's line as last built, reused while its inputs are the same objects. */
  readonly lineOf: WeakMap<FrameFacts, {
    readonly call: CallFacts
    readonly settled: CallFacts["settled"]
    readonly repeatOf: number | undefined
    readonly line: FrameLine
  }>
}

const disciplineInit = (runId: string): DisciplineState => ({
  runId,
  frames: [],
  notes: [],
  milestones: [],
  owners: [],
  open: [],
  frame: undefined,
  lastAt: 0,
  lineOf: new WeakMap()
})

/** One record of the discipline fold; the state is advanced in place. */
const disciplineStep = (state: DisciplineState, record: JournalRecord): void => {
  const { runId, frames, notes, milestones, owners, open } = state
  let frame = state.frame
  /** Where a discipline record attaches: the open frame, else the run itself. */
  const here = (): string => frame?.id ?? `run:${runId}`
  const note = (
    seq: number,
    tone: TraceNote["tone"],
    title: string,
    body: string,
    evidence: ReadonlyArray<string | undefined>
  ): void => {
    const quoted = evidence.filter((line): line is string => line !== undefined)
    notes.push({ seq, spanId: here(), tone, title, body, ...(quoted.length === 0 ? {} : { evidence: quoted }) })
  }
  /** A moment, owned by the frame that recorded it, exactly the way a note is. */
  const pin = (seq: number, at: number, label: string, tone: Milestone["tone"]): void => {
    milestones.push({ seq, at, label, tone, spanId: here() })
  }

  {
    const kind = record.kind ?? ""
    const payload = asRecord(record.payload)
    const at = timeOf(record, payload)
    const seq = record.sequence ?? 0
    state.lastAt = Math.max(state.lastAt, at)
    if (frame !== undefined) frame.endedAt = Math.max(frame.endedAt, at)
    switch (kind) {
      case "control.agent.turn-opened": {
        frame = {
          id: `frame-${frames.length + 1}`,
          frame: frames.length + 1,
          seq,
          startedAt: at,
          endedAt: at,
          blocked: false,
          calls: []
        }
        frames.push(frame)
        break
      }
      case "control.agent.cell-call-started": {
        const flowName = asString(payload.flowName) ?? ""
        const metadata = callSemantics(flowName, payload)
        const call: CallFacts = {
          flowName,
          callId: asString(payload.callId),
          input: payload.input,
          activity: metadata.activity,
          presentation: metadata.presentation,
          signature: `${flowName} ${textOf(payload.input) ?? ""}`
        }
        open.push(call)
        // A call journaled outside a frame belongs to no frame, and the tree
        // above puts it on the run. It is still open work, so it still pairs.
        frame?.calls.push(call)
        break
      }
      case "control.agent.cell-call-settled": {
        if (payload.outcome !== "success" && payload.outcome !== "failure") break
        const index = openCallIndex(open, asString(payload.callId), asString(payload.flowName))
        const call = index < 0 ? undefined : open.splice(index, 1)[0]
        if (call === undefined) break
        const failed = asString(payload.outcome) === "failure"
        // `ask` settles SUCCESSFULLY with the person's answer (`AgentSession`
        // answers `{ answer, approved }`), so a refusal is a denial and not a
        // failure. That is the call that settles with a denial.
        const denied = !failed && asRecord(payload.value).approved === false
        call.settled = {
          failed,
          result: (failed ? textOf(payload.message) : textOf(payload.value)) ?? "",
          denied,
          value: payload.value
        }
        if (denied && frame !== undefined) frame.blocked = true
        // A write is the fastest thing a run does, so its band is always too
        // narrow to carry a label, and its own marker is the only way to reach
        // the moment that matters most.
        if (!failed && !denied && call.activity === "writes") {
          // A pin is its label, so a pin with none is a marker nobody can read
          // and nobody can tell from the next one. The journal gave this call
          // no file; no file, no pin.
          const paths = [...new Set(writtenPaths(call.input))]
          const minted = frame?.wrote
          if (minted !== undefined) {
            // A frame's writes are ONE moment. A frame that edits fifteen files
            // does it inside a second, so a pin per file is fifteen names
            // stacked over a point on the axis nobody can aim between. The pin
            // stays where the frame started writing, on the file it names, and
            // counts the rest; a file written twice is still one file.
            for (const path of paths) if (!minted.paths.includes(path)) minted.paths.push(path)
            milestones[minted.milestone] = { ...milestones[minted.milestone]!, label: filesLabel(minted.paths) }
          } else if (paths.length > 0) {
            // A write journaled outside a frame has no frame to be counted
            // into, so it stays a moment of its own.
            if (frame !== undefined) frame.wrote = { milestone: milestones.length, paths }
            pin(seq, at, filesLabel(paths), "brand")
          }
        }
        break
      }
      case "control.agent.mutation-observed": {
        const mutated = payload.mutated === true
        if (frame !== undefined) frame.mutated = mutated
        if (frame !== undefined && payload.basis === "observed" && typeof payload.mutated === "boolean") {
          frame.observedMutation = payload.mutated
        }
        // Written for every frame, so only a frame that changed something is
        // worth a note. `basis` is the body because a `declared` answer is
        // paperwork and an `observed` one is a fact about the tree, and a
        // reader must not have to guess which one they are holding. `paths` is
        // a COUNT of what the measurement covered, not the paths themselves,
        // so it is not quotable evidence and is not quoted.
        if (mutated) {
          note(
            seq,
            asString(payload.basis) === "observed" ? "good" : "warn",
            "changed",
            asString(payload.basis) ?? "",
            []
          )
        }
        break
      }
      case "control.agent.permission-required": {
        if (frame !== undefined) frame.blocked = true
        pin(seq, at, "permission", "warn")
        break
      }
      case "control.agent.suspended": {
        if (frame !== undefined) frame.blocked = true
        break
      }
      case "control.agent.checkpoint-minted": {
        note(seq, "good", "checkpoint", asString(payload.ref) ?? "", [])
        break
      }
      case "control.agent.read-only-demanded": {
        // The caps are this run's own armed numbers, read off the payload: a
        // host overrides any of them, so a constant here would print a number
        // the run never used.
        const streak = asNumber(payload.streak)
        const cap = asNumber(payload.cap)
        const nextFrame = asNumber(payload.nextFrame)
        const nextAction = asString(payload.nextAction)
        note(
          seq,
          "warn",
          "read-only",
          bodyOf(
            streak === undefined || cap === undefined ? undefined : `${streak} of ${cap} frames changed nothing.`,
            nextFrame === undefined || nextAction === undefined ? undefined : `Frame ${nextFrame}: ${nextAction}.`
          ),
          []
        )
        pin(seq, at, "read-only", "warn")
        break
      }
      case "control.agent.repeat-demanded": {
        const spent = asNumber(payload.frames)
        const cap = asNumber(payload.cap)
        const nextFrame = asNumber(payload.nextFrame)
        note(
          seq,
          "warn",
          "repeat",
          bodyOf(
            spent === undefined || cap === undefined ? undefined : `${spent} of ${cap} frames repeated calls.`,
            nextFrame === undefined ? undefined : `Frame ${nextFrame}.`
          ),
          []
        )
        pin(seq, at, "repeat", "warn")
        break
      }
      case "control.agent.narrowed-demanded": {
        const flow = asString(payload.flow)
        const nextFrame = asNumber(payload.nextFrame)
        note(
          seq,
          "bad",
          "narrowed",
          bodyOf(
            flow === undefined ? undefined : `${flow} ran narrower than the reading it stands in for.`,
            nextFrame === undefined ? undefined : `Frame ${nextFrame}.`
          ),
          [clip(payload.broader), clip(payload.narrower)]
        )
        pin(seq, at, "narrowed", "bad")
        break
      }
      case "control.agent.unmoved-demanded": {
        const nextFrame = asNumber(payload.nextFrame)
        // Both digests or neither: one alone cannot tell an unmoved tree from a
        // measurement that never happened, and either may be the empty string.
        const opened = clip(payload.openedDigest)
        const current = clip(payload.currentDigest)
        note(
          seq,
          "bad",
          "unmoved",
          bodyOf(
            "The tree the run opened on is the tree it closed on.",
            nextFrame === undefined ? undefined : `Frame ${nextFrame}.`
          ),
          opened === undefined || current === undefined ? [] : [opened, current]
        )
        pin(seq, at, "unmoved", "bad")
        break
      }
      case "control.agent.unresolved-demanded": {
        const flow = asString(payload.flow)
        const nextFrame = asNumber(payload.nextFrame)
        note(
          seq,
          "bad",
          "unresolved",
          bodyOf(
            flow === undefined ? undefined : `${flow} failed and was not answered.`,
            nextFrame === undefined ? undefined : `Frame ${nextFrame}.`
          ),
          [clip(payload.failed), clip(payload.instead)]
        )
        pin(seq, at, "unresolved", "bad")
        break
      }
      case "control.agent.claim-demanded": {
        // Written on EVERY evaluation, and a reading that neither handed the
        // completion back nor refused it cost the run nothing and changed
        // nothing, so only those two are moments anyone would scrub to. A
        // refusal is the larger of them: it ends the run and takes its answer.
        if (payload.demanded !== true && payload.refused !== true) break
        const complete = asNumber(payload.complete)
        const overclaims = asNumber(payload.overclaims)
        const nextFrame = asNumber(payload.nextFrame)
        note(
          seq,
          "bad",
          payload.refused === true ? "claim refused" : "claim",
          bodyOf(
            complete === undefined || overclaims === undefined
              ? undefined
              : `complete ${complete}, overclaims ${overclaims}.`,
            nextFrame === undefined ? undefined : `Frame ${nextFrame}.`
          ),
          []
        )
        pin(seq, at, payload.refused === true ? "claim refused" : "claim", "bad")
        break
      }
      /*
       * The five kinds `AgentSession`'s `default` arm once journaled with
       * `payload: {}`, however rich their `AgentEvent` schema was:
       * cell-rejected-in-frame, read-only-demand-issued,
       * narrow-only-demanded, steering-drained and sufficiency-observed.
       * Their whole payload is late (`AgentSession` `lateFields`), so one
       * record carries every field or none, and each arm below reads what its
       * record has: a legacy record still folds, and still says nothing the
       * record does not carry. A note with no body and no evidence is a title
       * on its own, so a fieldless record writes none.
       */
      case "control.agent.cell-rejected-in-frame": {
        // A refused reply is a model call the frame paid for. The code is why
        // the parse refused it; the message is what the frame said back.
        const attempt = asNumber(payload.attempt)
        const code = asString(payload.code)
        const body = bodyOf(
          code === undefined ? undefined : `${code}.`,
          attempt === undefined ? undefined : `Attempt ${attempt}.`
        )
        if (body !== "") note(seq, "warn", "rejected", body, [clip(payload.message)])
        break
      }
      case "control.agent.read-only-demand-issued": {
        // The issuance's own numbers. `read-only-demanded` above carries the
        // same demand's later answer, and a run that crashes between the two
        // boundaries still has this one.
        const streak = asNumber(payload.streak)
        const cap = asNumber(payload.cap)
        const nextFrame = asNumber(payload.nextFrame)
        const body = bodyOf(
          streak === undefined || cap === undefined ? undefined : `${streak} of ${cap} frames changed nothing.`,
          nextFrame === undefined ? undefined : `Frame ${nextFrame}.`
        )
        if (body !== "") note(seq, "warn", "read-only", body, [])
        pin(seq, at, "read-only", "warn")
        break
      }
      case "control.agent.narrow-only-demanded": {
        // The sibling of `narrowed-demanded`: that one fires when a broader
        // reading exists and was not re-run, this one when none was ever
        // taken. There is no broader input to quote, so the subjects the
        // demand is about stand in its place.
        const flow = asString(payload.flow)
        const targets = Array.isArray(payload.targets)
          ? payload.targets.filter((one): one is string => typeof one === "string")
          : []
        const nextFrame = asNumber(payload.nextFrame)
        const body = bodyOf(
          flow === undefined || targets.length === 0
            ? undefined
            : `${flow} ran on ${targets.join(", ")} and nothing broader.`,
          nextFrame === undefined ? undefined : `Frame ${nextFrame}.`
        )
        if (body !== "") note(seq, "warn", "narrow-only", body, [clip(payload.check)])
        pin(seq, at, "narrow-only", "warn")
        break
      }
      case "control.agent.steering-drained": {
        // A drain is written at every frame boundary, and the queue is empty
        // at almost all of them. Only messages ON the record establish that a
        // person reached the run, so an empty drain is not a moment and a
        // legacy record — which carries no messages either way — cannot be
        // read as one. A steer too large to trace was still delivered; the
        // record says so even where its words are gone.
        const messages = Array.isArray(payload.messages) ? payload.messages : []
        if (messages.length === 0) break
        note(
          seq,
          "warn",
          "steering",
          messages.length === 1 ? "1 steer." : `${messages.length} steers.`,
          messages.map((message) => clip(asRecord(message).text))
        )
        pin(seq, at, "steering", "warn")
        break
      }
      case "control.agent.sufficiency-observed": {
        // The one observation that rewards a run rather than braking it: a
        // failing check answered by a passing one. The two inputs are the
        // whole of it, so they are quoted.
        const flow = asString(payload.flow)
        const nextFrame = asNumber(payload.nextFrame)
        const body = bodyOf(
          flow === undefined ? undefined : `${flow} failed before the change and passed after it.`,
          nextFrame === undefined ? undefined : `Frame ${nextFrame}.`
        )
        if (body !== "") note(seq, "good", "sufficiency", body, [clip(payload.failed), clip(payload.passed)])
        pin(seq, at, "sufficiency", "good")
        break
      }
      case "control.run.completed":
      case "control.run.failed":
      case "control.run.cancelled": {
        const verdict = kind.slice("control.run.".length)
        // A person's stop reads as the product word every surface uses.
        pin(seq, at, verdict === "cancelled" ? "stopped" : verdict, verdict === "completed" ? "good" : "bad")
        break
      }
      default:
        break
    }
    // After the record's own arm, so a turn-opened belongs to the frame it
    // opened: the rule `here()` already gives a note and a pin.
    owners.push({ seq, spanId: here() })
  }
  state.frame = frame
}

/**
 * What {@link disciplineStep} has read so far, as the model's arrays.
 *
 * The derived rows are rebuilt from the frames; the recorded ones are copied,
 * so a model taken now never sees a record stepped after it.
 */
const disciplineModel = (
  state: DisciplineState
): Pick<TraceModel, "bands" | "milestones" | "lines" | "notes" | "owners"> => {
  const { frames, lastAt } = state
  const notes = state.notes.slice()
  const milestones = state.milestones.slice()
  const owners = state.owners.slice()

  // A measured unchanged tree is authoritative even when a write succeeded.
  const changed = frames.map((entry) => entry.observedMutation ?? (entry.mutated === true || madeAWrite(entry)))

  // A repeated call is only evidence of a stall inside a STREAK, and only
  // across a span the workspace never moved in.
  //
  // Re-running one check after an edit is the OPPOSITE of a stall: it is the
  // answer `control.agent.sufficiency-observed` rewards. A rule that flagged
  // any second occurrence of a call would mark that good frame and a looping
  // one identically, and a rule that only checked THIS frame for a change
  // would still flag it, because the edit it answers happened in the frame
  // before. So a change resets what a first occurrence is: a call is judged
  // against the last time it ran on THIS tree, never against a run from before
  // an edit landed. On top of that a repeat counts only where the frames beside
  // it repeat too — each of them recording no change of its own — and
  // `repeatOf` is set only inside a streak of two or more such frames. Every
  // substantive call must repeat a settled reading; a fresh call, new result,
  // or pending result means this frame has not been shown to be redundant.
  const firstSeen = new Map<string, number>()
  const repeatedFrom = new Map<CallFacts, number>()
  const redundant: Array<boolean> = []
  frames.forEach((entry, index) => {
    const calls = entry.calls.filter((call) => call.flowName !== CHECKPOINT_FLOW)
    for (const call of calls) {
      if (call.settled === undefined) continue
      // A call settles once, so its reading is built once, not per model taken.
      call.reading ??= `${call.signature} ${JSON.stringify(call.settled)}`
      const reading = call.reading
      const seen = firstSeen.get(reading)
      if (seen === undefined) firstSeen.set(reading, entry.frame)
      else if (seen < entry.frame) repeatedFrom.set(call, seen)
    }
    redundant.push(calls.length > 0 && calls.every((call) => repeatedFrom.has(call)))
    // The tree moved in this frame, so every call recorded before it ran
    // against a tree that no longer exists and none of them can be repeated.
    if (changed[index] === true) firstSeen.clear()
  })
  const stalling = frames.map((_frame, index) => redundant[index] === true && changed[index] !== true)
  const stuck = stalling.map((flag, index) => flag && (stalling[index - 1] === true || stalling[index + 1] === true))

  // Phase, most specific rule first. The last rule is the honesty one: every
  // other word is a claim about what the frame was doing, and `researching` is
  // as much of a claim as the rest. A frame this fold cannot name one call for
  // is a frame it declines to write a line about, so it declines to name a
  // phase for it too.
  const phases = frames.map((entry, index): PhaseId =>
    entry.blocked
      ? "blocked"
      : stuck[index] === true
      ? "stuck"
      : changed[index] === true || entry.calls.some((call) => call.activity === "writes")
      ? "implementing"
      : entry.calls.some((call) => call.activity === "checks" || call.activity === "tests")
      ? "testing"
      : entry.calls.some((call) => call.activity === "reads")
      ? "researching"
      : "unrecorded"
  )

  const bands: Array<PhaseBand> = []
  frames.forEach((entry, index) => {
    const phase = phases[index]!
    // A frame's band ends where the next frame opens, and the last one ends
    // where the journal does: the rule the tree's own frames close by.
    const endedAt = frames[index + 1]?.startedAt ?? Math.max(entry.endedAt, lastAt)
    const last = bands[bands.length - 1]
    if (last !== undefined && last.phase === phase) {
      bands[bands.length - 1] = { ...last, endedAt, frames: [...last.frames, entry.id] }
      return
    }
    bands.push({ phase, startedAt: entry.startedAt, endedAt, frames: [entry.id], seq: entry.seq })
  })

  const lines = frames.flatMap((entry, index): ReadonlyArray<FrameLine> => {
    const call = dominantCall(entry)
    // A frame that called nothing has no line. Absence is absence.
    if (call === undefined) return []
    const repeatOf = stuck[index] === true ? repeatedFrom.get(call) : undefined
    const held = state.lineOf.get(entry)
    if (held !== undefined && held.call === call && held.settled === call.settled && held.repeatOf === repeatOf) {
      return [held.line]
    }
    const outcome = call.settled === undefined
      ? "pending"
      : call.settled.failed || call.settled.denied
      ? "failure"
      : "success"
    const line: FrameLine = {
      spanId: entry.id,
      frame: entry.frame,
      verb: call.presentation?.verb[outcome] ??
        `${call.flowName}${outcome === "pending" ? " pending" : outcome === "failure" ? " failed" : ""}`,
      subject: callSubject(call.input, call.presentation?.subject),
      // Read supported output fields through the descriptor's presentation.
      // The selected call retains the raw value, including unsupported shapes.
      result: call.settled?.failed === true
        ? clip(call.settled.result) ?? ""
        : resultOf(call.settled?.value, call.presentation?.result),
      failed: call.settled?.failed === true,
      wrote: call.activity === "writes" && call.settled?.failed === false && !call.settled.denied,
      ...(repeatOf === undefined ? {} : { repeatOf })
    }
    state.lineOf.set(entry, { call, settled: call.settled, repeatOf, line })
    return [line]
  })

  return { bands, milestones, lines, notes, owners }
}

/** The run a fold belongs to; its status is read when a model is taken. */
type TraceIdentity = Omit<TraceRun, "status">

/**
 * One dispatch's span fold, advanced one record at a time.
 *
 * Every field is what {@link foldStep} has read so far. The builders are live:
 * a model is taken by freezing them, never by handing them out.
 */
interface FoldState {
  readonly run: TraceIdentity
  readonly root: Builder
  frame: Builder | undefined
  cell: Builder | undefined
  frames: number
  calls: number
  seat: string | undefined
  lastAt: number
  /** Records stepped after deduplication: `ordered.length`. */
  count: number
  /** The journal's own verdict, from a `control.run.*` record. */
  verdict: string | undefined
  readonly openCalls: Array<{ readonly flowName: string; readonly callId?: string | undefined; readonly span: Builder }>
  readonly approvals: Map<string, Builder>
  readonly discipline: DisciplineState
  /** The native rows of this fold's own input, in order. */
  readonly engine: Array<JournalRecord>
  /** {@link engineTraceFromJournal} of `engine`, until another row arrives. */
  engineTrace: ReadonlyArray<Builder> | undefined
  /** The span each builder last froze to. */
  readonly frozen: WeakMap<Builder, TraceSpan>
  /**
   * The run's direct children a step may have changed since the last model.
   * Every other child is a closed subtree, and its frozen span is reused as is.
   */
  readonly dirty: Set<Builder>
  /** The run's direct child a call or approval span sits under, for {@link dirty}. */
  readonly topOf: WeakMap<Builder, Builder>
}

const isEngineRow = (record: JournalRecord): boolean =>
  record.kind === "control.engine.event" || record.kind === "control.engine.projection-gap"

const foldInit = (run: TraceIdentity): FoldState => ({
  run,
  root: builder(`run:${run.runId}`, "run", `run ${run.runId} · ${run.flowId}`, "running", 0, {
    ...(run.kind === undefined ? {} : { fields: { kind: run.kind } })
  }),
  frame: undefined,
  cell: undefined,
  frames: 0,
  calls: 0,
  seat: undefined,
  lastAt: 0,
  count: 0,
  verdict: undefined,
  openCalls: [],
  approvals: new Map(),
  discipline: disciplineInit(run.runId),
  engine: [],
  engineTrace: undefined,
  frozen: new WeakMap(),
  dirty: new Set(),
  topOf: new WeakMap()
})

/**
 * Folds one record, in sequence order, into a dispatch's trace.
 *
 * Frames open on `turn-opened` and close when the next opens or the run ends;
 * cells open on `cell-produced` and close on `cell-settled`; calls open on
 * `cell-call-started` under the open cell (or the frame, when a call is
 * journaled outside a cell) and settle by stable call identity the way the gateway's own
 * `run-tree` pairs them, so a call's `call-N` id is the node id the
 * `node-output` projection knows it by. A journal with no records yields the
 * run root alone, wearing the run's status: the honest empty trace.
 *
 * The same records fold a second time, into what a person would say the run
 * was doing: see {@link disciplineStep}.
 */
const foldStep = (state: FoldState, record: JournalRecord): void => {
  if (isEngineRow(record)) {
    state.engine.push(record)
    state.engineTrace = undefined
  }
  // route receives only the records kept by the shared call-event filter.
  const { root, openCalls, approvals, dirty, topOf } = state
  let { frame, cell, frames, calls, seat } = state
  const top = frame ?? cell
  if (top !== undefined) dirty.add(top)
  /** Marks the run's child that `span` sits under as changed. */
  const touch = (span: Builder): void => {
    // Both callers retrieve spans registered in topOf when they were opened.
    dirty.add(topOf.get(span)!)
  }
  /** Where a new span attaches: the open cell, else the open frame, else the run. */
  const parent = (): Builder => cell ?? frame ?? root
  const closeCell = (at: number, status: SpanStatus): void => {
    if (cell === undefined) return
    cell.endedAt = at
    cell.status = status
    cell = undefined
  }
  const closeFrame = (at: number): void => {
    if (frame === undefined) return
    closeCell(at, cell?.children.some((child) => child.status === "failed") === true ? "failed" : "completed")
    frame.endedAt = at
    frame.status = frame.children.some((child) => child.status === "failed") ? "failed" : "completed"
    frame = undefined
  }

  {
    const kind = record.kind ?? ""
    const payload = asRecord(record.payload)
    const at = timeOf(record, payload)
    if (state.count === 0) {
      root.startedAt = at
      state.lastAt = at
    } else state.lastAt = Math.max(state.lastAt, at)
    state.count += 1
    const opened = { sequence: record.sequence, event: kind }
    switch (kind) {
      case "control.engine.event":
      case "control.engine.projection-gap":
      case "control.engine.projection-started":
      case "control.engine.projection-settled":
        // Native records have their own identities and lifecycle. Never put
        // them under whichever agent frame happened to be open at ingestion.
        break
      case "control.agent.turn-opened": {
        closeFrame(at)
        frames += 1
        seat = asString(payload.seat) ?? seat
        frame = builder(
          `frame-${frames}`,
          "frame",
          `frame ${frames}${seat === undefined ? "" : ` · ${seat}`}`,
          "running",
          at,
          {
            ...opened,
            ...(seat === undefined ? {} : { seat }),
            fields: restOf(payload, ["seat"])
          }
        )
        root.children.push(frame)
        break
      }
      case "control.agent.model-settled": {
        const usage = asRecord(payload.usage)
        const duration = asNumber(payload.durationMillis)
        const span = builder(
          `model-${record.sequence ?? at}`,
          "model",
          "model",
          "completed",
          duration === undefined ? at : at - duration,
          {
            ...opened,
            ...(seat === undefined ? {} : { seat }),
            output: textOf(payload.text),
            usage: { inputTokens: asNumber(usage.inputTokens), outputTokens: asNumber(usage.outputTokens) },
            fields: restOf(payload, ["text", "usage", "durationMillis"])
          }
        )
        span.endedAt = at
        ;(frame ?? root).children.push(span)
        break
      }
      case "control.agent.cell-produced": {
        closeCell(at, "completed")
        const language = asString(payload.language)
        cell = builder(
          `cell-${record.sequence ?? at}`,
          "cell",
          `cell${language === undefined ? "" : ` · ${language}`}`,
          "running",
          at,
          {
            ...opened,
            source: asString(payload.text),
            fields: restOf(payload, ["text", "language"])
          }
        )
        ;(frame ?? root).children.push(cell)
        break
      }
      case "control.agent.cell-call-started": {
        calls += 1
        const flowName = asString(payload.flowName) ?? `call-${calls}`
        const span = builder(`call-${calls}`, "call", flowName, "running", at, {
          ...opened,
          input: payload.input,
          fields: restOf(payload, ["flowName", "input"])
        })
        openCalls.push({ flowName, callId: asString(payload.callId), span })
        topOf.set(span, frame ?? cell ?? span)
        parent().children.push(span)
        break
      }
      case "control.agent.cell-call-settled": {
        const index = openCallIndex(openCalls, asString(payload.callId), asString(payload.flowName))
        const settled = index < 0 ? undefined : openCalls.splice(index, 1)[0]
        if (settled === undefined) break
        const failed = asString(payload.outcome) === "failure"
        touch(settled.span)
        settled.span.endedAt = at
        settled.span.status = failed ? "failed" : "completed"
        settled.span.detail = {
          ...settled.span.detail,
          ...(failed ? { message: textOf(payload.message) } : { output: textOf(payload.value) }),
          ...(!failed && settled.flowName === "agent/spawn" && asString(asRecord(payload.value).child) !== undefined
            ? { childRunId: asString(asRecord(payload.value).child) }
            : {})
        }
        break
      }
      case "control.agent.cell-printed": {
        if (cell === undefined) {
          parent().children.push(
            builder(`printed-${record.sequence ?? at}`, "event", "printed", "completed", at, {
              ...opened,
              printed: textOf(payload.text)
            })
          )
          break
        }
        cell.detail = {
          ...cell.detail,
          printed: [cell.detail.printed, textOf(payload.text)].filter((text) => text !== undefined).join("\n")
        }
        break
      }
      case "control.agent.cell-settled": {
        closeCell(at, asString(payload.outcome) === "failure" ? "failed" : "completed")
        break
      }
      case "control.agent.resolved": {
        const span = builder(`resolved-${record.sequence ?? at}`, "resolved", "resolved", "completed", at, {
          ...opened,
          output: textOf(payload.text)
        })
        span.endedAt = at
        ;(frame ?? root).children.push(span)
        break
      }
      case "control.approval.requested": {
        const requestId = asString(payload.requestId) ?? `approval-${record.sequence ?? at}`
        const question = asString(payload.question)
        const span = builder(
          `approval-${requestId}`,
          "approval",
          `approval${question === undefined ? "" : ` · ${question}`}`,
          "waiting",
          at,
          {
            ...opened,
            fields: restOf(payload, ["question", "requestId", "payload", "runId"])
          }
        )
        approvals.set(requestId, span)
        topOf.set(span, frame ?? span)
        ;(frame ?? root).children.push(span)
        break
      }
      case "control.approval.approved":
      case "control.approval.denied": {
        const decided = kind === "control.approval.approved" ? "approved" : "denied"
        const key = asString(payload.tokenId) ?? asString(payload.requestId)
        const span = key === undefined
          ? [...approvals.values()].find((entry) => entry.status === "waiting")
          : approvals.get(key)
        if (span === undefined) break
        touch(span)
        span.status = decided
        span.endedAt = at
        break
      }
      case "control.run.completed":
      case "control.run.failed":
      case "control.run.cancelled": {
        closeFrame(at)
        root.endedAt = at
        // The journal's own verdict outranks the card's phase word: a scrub to this record shows the run settled.
        state.verdict = kind.slice("control.run.".length)
        break
      }
      default: {
        if (!kind.startsWith("control.")) break
        const span = builder(
          `event-${record.sequence ?? at}`,
          "event",
          kind.slice("control.".length),
          "completed",
          at,
          {
            ...opened,
            fields: restOf(payload, [])
          }
        )
        span.endedAt = at
        parent().children.push(span)
        if (kind === "control.agent.turn-closed" && payload.step !== undefined) {
          const closed = frame
          closeFrame(at)
          if (closed !== undefined && payload.outcome === "suspended") closed.status = "waiting"
          if (closed !== undefined && payload.outcome === "aborted") closed.status = "cancelled"
        }
      }
    }
  }
  Object.assign(state, { frame, cell, frames, calls, seat })
  const after = frame ?? cell
  if (after !== undefined) dirty.add(after)
  disciplineStep(state.discipline, record)
}

/**
 * The trace {@link foldStep} has read so far, as the run with `status` would
 * show it.
 *
 * Nothing live is mutated. A settled run closes its open frame where the
 * journal ends, so that close is applied to the frozen copy only.
 */
const foldModel = (
  state: FoldState,
  status: string,
  journal: ReadonlyArray<JournalRecord>,
  engine?: ReadonlyArray<Builder>
): TraceModel => {
  const { root, frame, cell, lastAt } = state
  const closed = new Map<Builder, { readonly status: SpanStatus; readonly endedAt: number }>()
  const statusOf = (node: Builder): SpanStatus => closed.get(node)?.status ?? node.status
  // A settled run leaves no frame open: the last frame ends where the journal does.
  const terminal = TERMINAL_RUN.has(status)
  if (terminal && frame !== undefined) {
    if (cell !== undefined) {
      closed.set(cell, {
        status: cell.children.some((child) => child.status === "failed") ? "failed" : "completed",
        endedAt: lastAt
      })
    }
    closed.set(frame, {
      status: frame.children.some((child) => statusOf(child) === "failed") ? "failed" : "completed",
      endedAt: lastAt
    })
  }
  if (engine === undefined && state.engineTrace === undefined) state.engineTrace = engineTraceFromJournal(state.engine)
  const children = [...root.children, ...(engine ?? state.engineTrace!)]
  closed.set(root, {
    status: state.verdict ?? status,
    endedAt: root.endedAt ?? (terminal && state.count > 0 ? lastAt : Number.NaN)
  })

  const freeze = (node: Builder, depth: number, members: ReadonlyArray<Builder>): TraceSpan =>
    freezeWith(node, depth, members.map((child) => freeze(child, depth + 1, child.children)))
  const freezeWith = (node: Builder, depth: number, frozenChildren: ReadonlyArray<TraceSpan>): TraceSpan => {
    const override = closed.get(node)
    const nodeStatus = override?.status ?? node.status
    const endedAt = override === undefined || Number.isNaN(override.endedAt) ? node.endedAt : override.endedAt
    const held = state.frozen.get(node)
    if (
      held !== undefined && held.depth === depth && held.label === node.label && held.status === nodeStatus &&
      held.startedAt === node.startedAt && held.endedAt === endedAt && held.detail === node.detail &&
      held.children.length === frozenChildren.length &&
      held.children.every((child, index) => child === frozenChildren[index])
    ) return held
    const span: TraceSpan = {
      id: node.id,
      kind: node.kind,
      label: node.label,
      status: nodeStatus,
      startedAt: node.startedAt,
      ...(endedAt === undefined ? {} : { endedAt }),
      depth,
      children: frozenChildren,
      detail: node.detail
    }
    state.frozen.set(node, span)
    return span
  }
  // A child no step touched since the last model is a closed subtree: its
  // frozen span stands, and nothing under it is walked again.
  const settledChild = (child: Builder): TraceSpan | undefined => {
    if (state.dirty.has(child) || closed.has(child)) return undefined
    const held = state.frozen.get(child)
    return held?.depth === 1 ? held : undefined
  }
  const frozenChildren = children.map((child) => settledChild(child) ?? freeze(child, 1, child.children))
  state.dirty.clear()
  const frozenRoot = freezeWith(root, 0, frozenChildren)
  const rows: Array<TraceSpan> = []
  const walk = (span: TraceSpan): void => {
    rows.push(span)
    for (const child of span.children) walk(child)
  }
  walk(frozenRoot)
  let start = Number.POSITIVE_INFINITY
  let end = 0
  let running = 0
  let failed = 0
  for (const span of rows) {
    start = Math.min(start, span.startedAt)
    end = Math.max(end, span.endedAt ?? span.startedAt)
    if (span.kind !== "run" && span.status === "running") running += 1
    if (span.kind !== "run" && span.status === "failed") failed += 1
  }
  const extent = state.count === 0 || !Number.isFinite(start)
    ? { start: 0, end: 0 }
    : { start, end: Math.max(end, start) }
  return {
    journal,
    root: frozenRoot,
    rows,
    extent,
    counts: { spans: rows.length - 1, running, failed },
    ...disciplineModel(state.discipline)
  }
}

/**
 * A run's trace fold, advanced one record at a time.
 *
 * {@link traceFromJournal} is {@link traceFold} over the whole journal and then
 * {@link traceFoldModel}; a live reader keeps the fold and hands it each new
 * record with {@link traceFoldStep}, so a record costs its own work rather than
 * a refold of the journal before it. The fold is mutable: stepping it consumes
 * the value it was, and a reader that needs an older trace takes a model first.
 *
 * @category models
 * @since 1.0.0
 */
export interface TraceFold {
  readonly run: Omit<TraceRun, "status">
  /** Every record stepped, in sequence order: the model's `journal`. */
  readonly journal: ReadonlyArray<JournalRecord>
}

interface FoldTop extends TraceFold {
  /** Records as they arrived, so a refold sorts exactly what the batch sorts. */
  arrived: Array<JournalRecord>
  journal: Array<JournalRecord>
  filter: CallEventFilter<JournalRecord>
  base: FoldState
  groups: Map<string, FoldState>
  /** The native rows of the raw journal, read while no record names a step. */
  engine: Array<JournalRecord>
  engineTrace: ReadonlyArray<Builder> | undefined
  firstAt: number
  terminal: JournalRecord | undefined
  /**
   * The records {@link traceFoldSync} last consumed, copied so a caller that
   * grows or rewrites its own array in place is still compared to what was read.
   */
  source: ReadonlyArray<JournalRecord> | undefined
  memo: { readonly status: string; readonly model: TraceModel } | undefined
}

const sequenceOf = (record: JournalRecord): number => record.sequence ?? 0

const TERMINAL_KINDS: ReadonlySet<string> = new Set([
  "control.run.completed",
  "control.run.failed",
  "control.run.cancelled"
])

/** One deduplicated record to the fold of the dispatch it was recorded under. */
const route = (state: FoldTop, record: JournalRecord): void => {
  // A run verdict stamped with another run's id (a child's, riding in this
  // journal) must not settle this run's trace or pin its milestone.
  if (
    record.kind?.startsWith("control.run.") === true && record.runId !== undefined && record.runId !== state.run.runId
  ) {
    return
  }
  state.firstAt = Math.min(state.firstAt, timeOf(record, asRecord(record.payload)))
  if (TERMINAL_KINDS.has(record.kind ?? "")) state.terminal = record
  const scope = callScope(record)
  if (scope === undefined) return foldStep(state.base, record)
  let group = state.groups.get(scope)
  if (group === undefined) {
    group = foldInit(state.run)
    state.groups.set(scope, group)
  }
  foldStep(group, record)
}

/** Refolds `arrived` from nothing: the batch rules, exactly. */
const reseed = (state: FoldTop, arrived: Array<JournalRecord>): void => {
  const journal = [...arrived].sort((left, right) => sequenceOf(left) - sequenceOf(right))
  const filter = callEventFilter<JournalRecord>()
  for (const record of journal) filter.push(record)
  Object.assign(state, {
    arrived,
    journal,
    filter,
    base: foldInit(state.run),
    groups: new Map(),
    engine: journal.filter(isEngineRow),
    engineTrace: undefined,
    firstAt: Number.POSITIVE_INFINITY,
    terminal: undefined,
    memo: undefined
  })
  for (const record of uniqueCallEvents(journal)) route(state, record)
}

/**
 * Folds `records` into a fold that later records can be stepped onto.
 *
 * @param run the run the journal belongs to
 * @param records its journal so far, in any order
 *
 * @category constructors
 * @since 1.0.0
 */
export const traceFold = (run: Omit<TraceRun, "status">, records: ReadonlyArray<JournalRecord> = []): TraceFold => {
  const state = {
    run: { runId: run.runId, flowId: run.flowId, ...(run.kind === undefined ? {} : { kind: run.kind }) }
  } as FoldTop
  state.source = undefined
  reseed(state, [...records])
  return state
}

/**
 * Folds one more record onto `fold`, which it returns.
 *
 * A record in sequence order costs its own work. One that arrives before a
 * sequence already stepped, or a native fact that supersedes telemetry the
 * fold already placed, refolds the journal, because the batch rules move an
 * earlier record for both.
 *
 * @param fold the fold; consumed
 * @param record the next journal record
 *
 * @category combinators
 * @since 1.0.0
 */
export const traceFoldStep = (fold: TraceFold, record: JournalRecord): TraceFold => {
  const state = fold as FoldTop
  state.memo = undefined
  state.arrived.push(record)
  const last = state.journal.at(-1)
  if (last !== undefined && !(sequenceOf(record) >= sequenceOf(last))) {
    reseed(state, state.arrived)
    return fold
  }
  state.journal.push(record)
  if (isEngineRow(record)) {
    state.engine.push(record)
    state.engineTrace = undefined
  }
  const verdict = state.filter.push(record)
  if (verdict._tag === "rewrite") reseed(state, state.arrived)
  else if (verdict._tag === "keep") route(state, verdict.event)
  return fold
}

/**
 * Brings `fold` up to `records`, stepping only what it has not read.
 *
 * `records` extends the array the fold last read when every earlier element is
 * the same object; anything else, or a different run, starts a new fold. The
 * comparison is against the records the fold consumed, not the caller's array,
 * so growing or rewriting that same array in place is seen. A reader that
 * re-renders one growing journal therefore pays per new record.
 *
 * @param fold the fold the reader holds, if any; consumed
 * @param run the run the journal belongs to
 * @param records the whole journal as the reader now holds it
 *
 * @category combinators
 * @since 1.0.0
 */
export const traceFoldSync = (
  fold: TraceFold | undefined,
  run: Omit<TraceRun, "status">,
  records: ReadonlyArray<JournalRecord>
): TraceFold => {
  const held = fold as FoldTop | undefined
  const source = held?.source
  const extends_ = held !== undefined && source !== undefined && held.run.runId === run.runId &&
    held.run.flowId === run.flowId && held.run.kind === run.kind && records.length >= source.length &&
    source.every((record, index) => records[index] === record)
  const next = extends_ ? held : traceFold(run) as FoldTop
  for (let index = extends_ ? source.length : 0; index < records.length; index++) traceFoldStep(next, records[index]!)
  next.source = records.slice()
  return next
}

/**
 * The trace a fold has read, as the run with `status` shows it.
 *
 * Taken again without a step between, it is the same object.
 *
 * @param fold the fold
 * @param status the run card's phase word
 *
 * @category utilities
 * @since 1.0.0
 */
export const traceFoldModel = (fold: TraceFold, status: string): TraceModel => {
  const state = fold as FoldTop
  if (state.memo?.status === status) return state.memo.model
  const model = mergeModel(state, status)
  state.memo = { status, model }
  return model
}

const mergeModel = (state: FoldTop, status: string): TraceModel => {
  const journal = state.journal.slice()
  if (state.groups.size === 0) {
    if (state.engineTrace === undefined) state.engineTrace = engineTraceFromJournal(state.engine)
    return foldModel(state.base, status, journal, state.engineTrace)
  }
  const base = foldModel(state.base, status, journal)
  const children = [...base.root.children]
  const bands = [...base.bands]
  const milestones = [...base.milestones]
  const lines = [...base.lines]
  const notes = [...base.notes]
  const owners = [...base.owners]
  const terminal = state.terminal
  const terminalAt = terminal === undefined ? undefined : timeOf(terminal, asRecord(terminal.payload))
  for (const [scope, group] of state.groups) {
    const prefix = `step:${encodeURIComponent(scope)}/`
    const scoped = foldModel(group, "running", journal)
    const rename = (span: TraceSpan): TraceSpan => ({
      ...span,
      id: `${prefix}${span.id}`,
      children: span.children.map(rename),
      ...(span.status === "running" && TERMINAL_RUN.has(base.root.status) ?
        {
          // A terminal run proves work stopped. It does not prove which open
          // step succeeded or caused the run to fail.
          status: "stopped",
          ...(terminalAt === undefined ? {} : { endedAt: terminalAt })
        } :
        {})
    })
    children.push(...scoped.root.children.map(rename))
    bands.push(...scoped.bands.map((band) => ({ ...band, frames: band.frames.map((id) => `${prefix}${id}`) })))
    // A moment, a line, a note and a position all name the frame they were
    // recorded under, so the merge renames each of them the same way: the
    // step's own frame, or this run's root for what the step recorded outside
    // any frame.
    const owned = (spanId: string): string => spanId === scoped.root.id ? base.root.id : `${prefix}${spanId}`
    milestones.push(...scoped.milestones.map((one) => ({ ...one, spanId: owned(one.spanId) })))
    lines.push(...scoped.lines.map((line) => ({ ...line, spanId: `${prefix}${line.spanId}` })))
    notes.push(...scoped.notes.map((note) => ({ ...note, spanId: owned(note.spanId) })))
    owners.push(...scoped.owners.map((one) => ({ ...one, spanId: owned(one.spanId) })))
  }
  children.sort((left, right) =>
    left.startedAt - right.startedAt || (left.detail.sequence ?? 0) - (right.detail.sequence ?? 0)
  )
  const root = { ...base.root, startedAt: state.firstAt, children }
  const rows: Array<TraceSpan> = []
  const walk = (span: TraceSpan): void => {
    rows.push(span)
    span.children.forEach(walk)
  }
  walk(root)
  const positions = new Map(rows.map((span, index) => [span.id, index]))
  // Each step folds its own frames from 1, so a merged run would print two
  // rows numbered 1 and a `same as 1` that names either. The merged list
  // numbers the rows a person reads, and a repeat names the renumbered row of
  // the step that recorded it.
  const merged = lines.sort((left, right) => positions.get(left.spanId)! - positions.get(right.spanId)!)
  const stepOf = (spanId: string): string => spanId.slice(0, spanId.lastIndexOf("/") + 1)
  const renumbered = new Map(merged.map((line, index) => [`${stepOf(line.spanId)}${line.frame}`, index + 1]))
  let start = Number.POSITIVE_INFINITY
  let end = Number.NEGATIVE_INFINITY
  for (const span of rows) {
    start = Math.min(start, span.startedAt)
    end = Math.max(end, span.endedAt ?? span.startedAt)
  }
  return {
    journal,
    root,
    rows,
    extent: { start, end },
    counts: {
      spans: rows.length - 1,
      running: rows.filter((span) => span.kind !== "run" && span.status === "running").length,
      failed: rows.filter((span) => span.kind !== "run" && span.status === "failed").length
    },
    bands: bands.sort((left, right) => left.startedAt - right.startedAt || left.seq - right.seq),
    milestones: milestones.sort((left, right) => left.seq - right.seq),
    lines: merged.map((line, index) => ({
      ...line,
      frame: index + 1,
      ...(line.repeatOf === undefined
        ? {}
        : { repeatOf: renumbered.get(`${stepOf(line.spanId)}${line.repeatOf}`)! })
    })),
    notes: notes.sort((left, right) => left.seq - right.seq),
    owners: owners.sort((left, right) => left.seq - right.seq)
  }
}

/**
 * Fold each recorded dispatch independently, keeping prompt-run addresses unchanged.
 *
 * The same fold a live reader advances with {@link traceFoldStep}, taken over
 * the whole journal at once.
 *
 * The options the card carries are accepted and read by nothing: a plan's
 * check targets are a coverage requirement, and a requirement is not evidence
 * that any call ran it. Every word this fold says is read off a record.
 *
 * @category utilities
 * @since 1.0.0
 */
export const traceFromJournal = (
  run: TraceRun,
  records: ReadonlyArray<JournalRecord>,
  _options: TraceOptions = {}
): TraceModel => traceFoldModel(traceFold(run, records), run.status)

/**
 * One span's bar on the shared axis, as percentages. An open span runs to the
 * axis end; an instant span is zero width and renders as a marker.
 *
 * @param span the span
 * @param extent the axis
 *
 * @category utilities
 * @since 1.0.0
 */
export const waterfallGeometry = (
  span: TraceSpan,
  extent: TraceExtent
): { readonly left: number; readonly width: number } => {
  const width = Math.max(extent.end - extent.start, 1)
  const from = span.startedAt
  const to = span.endedAt ?? extent.end
  const left = ((from - extent.start) / width) * 100
  const bar = Math.max(((to - from) / width) * 100, 0)
  return { left: Math.round(left * 100) / 100, width: Math.round(bar * 100) / 100 }
}

/**
 * The axis the phase strip measures on: the bands' own span when the journal
 * opened frames, the run's whole extent when it opened none.
 *
 * A milestone is a journal record, and the records that write one do not need a
 * frame: a journal of `read-only-demanded` and `sufficiency-observed` with no
 * `turn-opened` carries two moments and opens no band. Milestones therefore
 * survive without bands, and the axis that places them cannot be read off the
 * bands alone. The other choice — dropping a moment because no band was drawn
 * beside it — would be this fold deciding a record the journal made did not
 * happen, which is the one thing it may never do.
 *
 * @param model the trace
 *
 * @category utilities
 * @since 1.0.0
 */
export const phaseExtent = (model: TraceModel): TraceExtent => {
  return model.bands.length === 0 ? model.extent : {
    start: Math.min(...model.bands.map((band) => band.startedAt)),
    end: Math.max(...model.bands.map((band) => band.endedAt))
  }
}

/**
 * One band's share of that axis, as percentages, the way the waterfall measures
 * a span.
 *
 * A run whose frames all land in one millisecond recorded no elapsed time. Read
 * against a floored axis every such band is zero wide at left 0, so the whole
 * strip collapses onto the left edge and says nothing at all. The bands' ORDER
 * is a journal fact even where their durations are not, so with no duration to
 * measure the ordinal IS the axis: equal slices, left to right.
 *
 * @param band the band
 * @param extent the axis, from {@link phaseExtent}
 * @param index the band's place in the strip
 * @param count how many bands the strip holds
 *
 * @category utilities
 * @since 1.0.0
 */
export const phaseBandGeometry = (
  band: PhaseBand,
  extent: TraceExtent,
  index: number,
  count: number
): { readonly left: number; readonly width: number } => {
  const round = (value: number): number => Math.round(value * 100) / 100
  const axis = extent.end - extent.start
  if (axis <= 0) {
    const share = 100 / Math.max(count, 1)
    return { left: round(index * share), width: round(share) }
  }
  return {
    left: round(((band.startedAt - extent.start) / axis) * 100),
    width: round((Math.max(band.endedAt - band.startedAt, 0) / axis) * 100)
  }
}

/** The flows whose spans are messages between a coordinator and its workers (spec 06 §3). */
const MESSAGE_FLOWS: ReadonlySet<string> = new Set(["agent/send", "agent/await"])

/** Whether a span, or any span under it, passes the filter.
 *
 * @category utilities
 * @since 1.0.0
 */
export const spanMatches = (span: TraceSpan, filter: TraceFilter): boolean => {
  const own = filter === "all"
    ? true
    : filter === "running"
    ? span.status === "running" || span.status === "waiting"
    : filter === "failed"
    ? span.status === "failed"
    : filter === "model"
    ? span.kind === "model"
    : filter === "flow"
    ? span.kind === "call" || span.kind === "execution" || span.kind === "attempt"
    : filter === "forks"
    ? span.kind === "fork"
    : span.kind === "call" && MESSAGE_FLOWS.has(span.label)
  return own || span.children.some((child) => spanMatches(child, filter))
}

/** The tree's filters, in the slash grammar's words (spec 06 §6: `runs.trace.filter <runId> <filter>`).
 *
 * @category models
 * @since 1.0.0
 */
export type TraceFilter = "all" | "running" | "failed" | "model" | "flow" | "forks" | "messages"

/**
 * Stable filter identifiers accepted by run trace commands.
 *
 * @category utilities
 * @since 1.0.0
 */
export const TRACE_FILTER_IDS: ReadonlyArray<TraceFilter> = [
  "all",
  "running",
  "failed",
  "model",
  "flow",
  "forks",
  "messages"
]

const FILTER_LABELS: Readonly<Record<TraceFilter, string>> = {
  all: "all",
  running: "running",
  failed: "failed",
  model: "model calls",
  flow: "flow calls",
  forks: "forks",
  messages: "messages"
}

/**
 * The filter chips a run of this kind shows (spec 06 §2 and §3): a prototype
 * has `all | messages | failed` and nothing else; every other run has the
 * shared set. `messages` is a prototype's conversation across workers, so it
 * is not offered elsewhere.
 *
 * @param kind the run's kind
 *
 * @category utilities
 * @since 1.0.0
 */
export const traceFiltersFor = (kind: string | undefined): ReadonlyArray<readonly [TraceFilter, string]> =>
  (kind === "prototype"
    ? (["all", "messages", "failed"] as const)
    : (["all", "running", "failed", "model", "flow", "forks"] as const)).map((id) => [id, FILTER_LABELS[id]] as const)

/** Whether a filter word is one the trace knows.
 *
 * @category utilities
 * @since 1.0.0
 */
export const isTraceFilter = (value: string): value is TraceFilter =>
  (TRACE_FILTER_IDS as ReadonlyArray<string>).includes(value)

/** The two presentations of the same persisted run card.
 *
 * @category models
 * @since 1.0.0
 */
export type TraceView = "turns" | "timeline"

/** A concise projection of one recorded turn, never a generated claim about intent or correctness.
 *
 * @category models
 * @since 1.0.0
 */
export interface TurnNarrative {
  readonly frame: TraceSpan
  readonly number: number
  readonly text: string
  readonly source: "model" | "calls" | "journal"
}

/** The first prose line outside fenced code, bounded for the cheap turn list. Full text stays in the model span. */
const proseLine = (text: string | undefined): string | undefined => {
  if (text === undefined) return undefined
  let fence: string | undefined
  for (const line of text.split("\n")) {
    const trimmed = line.trim()
    const marker = /^(?:`{3,}|~{3,})/.exec(trimmed)?.[0]
    if (marker !== undefined) {
      if (fence === undefined) fence = marker
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined
      continue
    }
    if (fence !== undefined || trimmed === "") continue
    // A code-only response or the journal's truncated-field object is not explanatory prose.
    if (/^(?:[[{]|(?:const|let|var|await|import|export|function|return)\b)/.test(trimmed)) return undefined
    const words = trimmed.replace(/^#{1,6}\s+|^[-*+]\s+|^>\s+/, "").replace(/\s+/g, " ")
    const sentence = words.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? `${words}.`
    return sentence.length <= 180 ? sentence : `${sentence.slice(0, 179).trimEnd()}…`
  }
  return undefined
}

/** One cheap line per turn; falls back to actual call names when the model recorded only code.
 *
 * @category utilities
 * @since 1.0.0
 */
export const turnNarratives = (model: TraceModel): ReadonlyArray<TurnNarrative> =>
  model.root.children.filter((span) => span.kind === "frame").map((frame, index) => {
    const text = frame.children.filter((span) => span.kind === "model").map((span) => proseLine(span.detail.output))
      .find((value) => value !== undefined)
    if (text !== undefined) return { frame, number: index + 1, text, source: "model" }
    const names: Array<string> = []
    const walk = (span: TraceSpan): void => {
      if (span.kind === "call" && !names.includes(span.label)) names.push(span.label)
      for (const child of span.children) walk(child)
    }
    walk(frame)
    return names.length > 0
      ? {
        frame,
        number: index + 1,
        text: `The agent called ${names.slice(0, 3).join(", ")}${
          names.length > 3 ? ` and ${names.length - 3} other flows` : ""
        }.`,
        source: "calls"
      }
      : {
        frame,
        number: index + 1,
        text: frame.children.some((span) => span.kind === "cell")
          ? "The agent produced a script; no flow calls were recorded in this turn."
          : frame.children.some((span) => span.kind === "model")
          ? "The model responded; no script or flow calls were recorded in this turn."
          : "The turn started; no model response or flow calls have been recorded.",
        source: "journal"
      }
  })

/** The recorded ancestry of a selection, for breadcrumbs and the selected turn's scoped call tree.
 *
 * @category utilities
 * @since 1.0.0
 */
export const spanPath = (model: TraceModel, id: string): ReadonlyArray<TraceSpan> => {
  const visit = (span: TraceSpan): ReadonlyArray<TraceSpan> | undefined => {
    if (span.id === id) return [span]
    for (const child of span.children) {
      const path = visit(child)
      if (path !== undefined) return [span, ...path]
    }
    return undefined
  }
  return visit(model.root) ?? [model.root]
}

/** A duration in the trace's units: milliseconds under a second, seconds under a minute, minutes and seconds after.
 *
 * @category utilities
 * @since 1.0.0
 */
export const durationWords = (ms: number): string => {
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms - minutes * 60_000) / 1000)
  return `${minutes}m${String(seconds).padStart(2, "0")}s`
}

/** One memory item a run's relevance readings weighed.
 *
 * @category models
 * @since 1.0.0
 */
export interface MemoryItem {
  readonly id: string
  readonly kind: string
  /** How likely the item is needed: 1 − Jev's probability that it is not. */
  readonly relevance: number
}

/** The memory a run was shown and the memory Jev withheld from it.
 *
 * @category models
 * @since 1.0.0
 */
export interface RunMemory {
  readonly kept: ReadonlyArray<MemoryItem>
  readonly withheld: ReadonlyArray<MemoryItem>
}

const memoryItems = (value: unknown): ReadonlyArray<MemoryItem> =>
  Array.isArray(value) ?
    value.flatMap((raw: unknown) => {
      const item = typeof raw === "object" && raw !== null ? raw as Record<string, unknown> : undefined
      return item?.kind === "memory" && typeof item.id === "string" && typeof item.p === "number"
        ? [{ id: item.id, kind: "memory", relevance: 1 - item.p }]
        : []
    }) :
    []

/**
 * What memory a run was brought, from the `control.agent.relevance-settled`
 * rows of its `run-events` projection: ids and probabilities, never text. A
 * reading also weighs flows, skills and instructions; only memory counts here.
 * An item any reading kept is in; one only ever withheld is withheld; both
 * most relevant first. A row whose verdicts were not retained is no reading.
 * Undefined when Jev never read for the run.
 *
 * @category folds
 * @since 1.0.0
 */
export const runMemoryOf = (records: ReadonlyArray<JournalRecord>): RunMemory | undefined => {
  const kept = new Map<string, MemoryItem>()
  const withheld = new Map<string, MemoryItem>()
  let read = false
  for (const record of records) {
    if (record.kind !== "control.agent.relevance-settled") continue
    const payload = typeof record.payload === "object" && record.payload !== null
      ? record.payload as Record<string, unknown>
      : {}
    if (!Array.isArray(payload.kept) && !Array.isArray(payload.withheld)) continue
    read = true
    for (const item of memoryItems(payload.kept)) kept.set(item.id, item)
    for (const item of memoryItems(payload.withheld)) withheld.set(item.id, item)
  }
  if (!read) return undefined
  const byRelevance = (left: MemoryItem, right: MemoryItem) =>
    right.relevance - left.relevance || left.id.localeCompare(right.id)
  return {
    kept: [...kept.values()].sort(byRelevance),
    withheld: [...withheld.values()].filter((item) => !kept.has(item.id)).sort(byRelevance)
  }
}
