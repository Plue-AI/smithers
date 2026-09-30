/**
 * The DevTools projection: one run inspected the way React DevTools inspects
 * a component tree (#2931).
 *
 * A view over the trace model (`RunTrace.ts`), which is itself the fold of the
 * `run-events` projection the run card, the terminal and the CLI already read.
 * There is no second node model and no second data source: a DevTools node is
 * a trace span with its measured timing, and an inspection is that span's
 * recorded detail plus the journal records written while it was open. Every
 * reader folds the same journal, so the app pane, `/devtools` in the terminal
 * and `smthrs runs devtools` show one run the same way, and a live run updates
 * as its subscription appends records.
 *
 * Pure: no server, no filesystem, no clock.
 * @since 1.0.0
 */

import { clip, firstLine } from "./Diagnosis.ts"
import {
  durationWords,
  type JournalRecord,
  type SpanKind,
  spanPath,
  type SpanStatus,
  type TraceModel,
  type TraceSpan
} from "./RunTrace.ts"

/**
 * One node of the tree: a trace span with its measured timing.
 *
 * @category models
 * @since 1.0.0
 */
export interface DevToolsNode {
  readonly id: string
  readonly depth: number
  readonly kind: SpanKind
  readonly label: string
  readonly status: SpanStatus
  readonly startedAt: number
  /** Absent while the span is open. */
  readonly endedAt?: number | undefined
  /** Measured to the settlement, or to the trace's end while running; absent when nothing measured it. */
  readonly durationMs?: number | undefined
  /** Recorded children, so a collapsed reader still knows the node has any. */
  readonly children: number
  /** The journal sequence that opened the node. */
  readonly sequence?: number | undefined
}

/**
 * One journal record written while the inspected node was open.
 *
 * @category models
 * @since 1.0.0
 */
export interface DevToolsFrame {
  readonly sequence: number
  readonly at: number
  readonly kind: string
  readonly payload: unknown
}

/**
 * The inspected node: its recorded detail and its journal frames.
 *
 * Every field is read off the journal; a field the journal did not record is
 * absent, never invented.
 *
 * @category models
 * @since 1.0.0
 */
export interface DevToolsInspection {
  readonly node: DevToolsNode
  /** The recorded ancestry, root first, ending in the node itself. */
  readonly path: ReadonlyArray<string>
  /** A call's input, as journaled. */
  readonly input?: unknown | undefined
  /** A call's settled value, a model's text, or a resolved text. */
  readonly output?: string | undefined
  /** A cell's source text. */
  readonly source?: string | undefined
  /** What a cell printed for the next model turn. */
  readonly printed?: string | undefined
  /** A failure's message. */
  readonly failure?: string | undefined
  readonly seat?: string | undefined
  readonly tokens?: { readonly input: number; readonly output: number } | undefined
  /** A detached child's recorded execution id. */
  readonly childRunId?: string | undefined
  /** The journal kind that opened the node. */
  readonly event?: string | undefined
  /** Every other payload field the opening record carried. */
  readonly fields: ReadonlyArray<readonly [key: string, value: unknown]>
  /** The newest frames, oldest first, bounded by the reader's limit. */
  readonly frames: ReadonlyArray<DevToolsFrame>
  /** How many frames the node has in all, so a bounded list says what it left out. */
  readonly frameCount: number
}

/**
 * The tree of one run, in tree order, with the run's own counts.
 *
 * @category models
 * @since 1.0.0
 */
export interface DevToolsModel {
  readonly runId: string
  /** The root's label: the run and its flow, as the trace names them. */
  readonly label: string
  readonly status: string
  readonly nodes: ReadonlyArray<DevToolsNode>
  readonly counts: TraceModel["counts"]
  /** The recorded wall time of the whole trace. */
  readonly wallMs: number
}

/**
 * What a reader may bound.
 *
 * @category models
 * @since 1.0.0
 */
export interface DevToolsOptions {
  /** The most recent frames kept on an inspection; the default keeps 100. */
  readonly frames?: number | undefined
}

/**
 * The frames an inspection keeps when the reader names no bound.
 *
 * @category constants
 * @since 1.0.0
 */
export const defaultFrameLimit = 100

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}

/** The record's time: the agent's own `at` stamp when it carries one, the journal's otherwise (the fold's rule). */
const timeOf = (record: JournalRecord): number => {
  const at = asRecord(record.payload).at
  return typeof at === "number" && Number.isFinite(at) ? at : record.occurredAt ?? 0
}

const OPEN: ReadonlySet<string> = new Set(["running", "waiting"])

/** Measured to the settlement, or to the trace's end while the span is still running. */
const durationOf = (span: TraceSpan, model: TraceModel): number | undefined => {
  const end = span.endedAt ?? (OPEN.has(span.status) ? model.extent.end : undefined)
  return end === undefined ? undefined : Math.max(end - span.startedAt, 0)
}

const nodeOf = (span: TraceSpan, model: TraceModel): DevToolsNode => {
  const durationMs = durationOf(span, model)
  return {
    id: span.id,
    depth: span.depth,
    kind: span.kind,
    label: span.label,
    status: span.status,
    startedAt: span.startedAt,
    endedAt: span.endedAt,
    durationMs,
    children: span.children.length,
    sequence: span.detail.sequence
  }
}

/**
 * The tree of a run, one node per trace span in tree order.
 *
 * @param model the trace the reader already folds
 *
 * @category constructors
 * @since 1.0.0
 */
export const devTools = (model: TraceModel): DevToolsModel => ({
  runId: model.root.id.startsWith("run:") ? model.root.id.slice(4) : model.root.id,
  label: model.root.label,
  status: model.root.status,
  nodes: model.rows.map((span) => nodeOf(span, model)),
  counts: model.counts,
  wallMs: Math.max(model.extent.end - model.extent.start, 0)
})

/**
 * The journal records written while `span` was open: from the record that
 * opened it through the record that settled it (a frame closes on the next
 * frame's opening, so that record is its last), or every later record while
 * it is still open. Two calls open at once share the records of their
 * overlap. The run root owns the whole journal. A span the journal never
 * opened with a sequence has no frames.
 *
 * @param model the trace
 * @param span one of its spans
 *
 * @category getters
 * @since 1.0.0
 */
export const framesOf = (model: TraceModel, span: TraceSpan): ReadonlyArray<DevToolsFrame> => {
  const opened = span.detail.sequence
  if (span.kind !== "run" && opened === undefined) return []
  const frames: Array<DevToolsFrame> = []
  for (const record of model.journal) {
    if (typeof record.sequence !== "number") continue
    if (span.kind !== "run") {
      if (record.sequence < opened!) continue
      if (span.endedAt !== undefined && timeOf(record) > span.endedAt) continue
    }
    frames.push({ sequence: record.sequence, at: timeOf(record), kind: record.kind ?? "", payload: record.payload })
  }
  return frames
}

/**
 * The inspection of one node, or of the run itself when `id` names no span.
 *
 * @param model the trace
 * @param id the selected span id
 * @param options the frame bound
 *
 * @category getters
 * @since 1.0.0
 */
export const inspect = (model: TraceModel, id?: string, options: DevToolsOptions = {}): DevToolsInspection => {
  const span = (id === undefined ? undefined : model.rows.find((row) => row.id === id)) ?? model.root
  const { detail } = span
  const limit = Math.max(options.frames ?? defaultFrameLimit, 0)
  const all = framesOf(model, span)
  const usage = detail.usage
  const tokens = usage !== undefined && (usage.inputTokens !== undefined || usage.outputTokens !== undefined)
    ? { input: usage.inputTokens ?? 0, output: usage.outputTokens ?? 0 }
    : undefined
  return {
    node: nodeOf(span, model),
    path: spanPath(model, span.id).map((ancestor) => ancestor.label),
    input: detail.input,
    output: detail.output,
    source: detail.source,
    printed: detail.printed,
    failure: detail.message,
    seat: detail.seat,
    tokens,
    childRunId: detail.childRunId,
    event: detail.event,
    fields: Object.entries(detail.fields ?? {}),
    frames: all.slice(Math.max(all.length - limit, 0)),
    frameCount: all.length
  }
}

const glyphOf = (status: SpanStatus): string =>
  status === "running" || status === "waiting"
    ? "◐"
    : status === "failed" || status === "denied"
    ? "✗"
    : status === "completed" || status === "approved" || status === "resolved"
    ? "●"
    : "○"

const json = (value: unknown): string => {
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return String(value)
  }
}

const oneLine = (value: unknown): string => {
  try {
    return firstLine(typeof value === "string" ? value : JSON.stringify(value) ?? String(value))
  } catch {
    return String(value)
  }
}

const indent = (text: string): ReadonlyArray<string> => text.split("\n").map((line) => `  ${line}`)

/**
 * The tree and the inspection as text lines, for the terminal and the CLI.
 *
 * The tree is one line per node: glyph, label indented by depth, the status
 * word when it is not `completed`, and the measured duration. Under it, the
 * selected node's facts in the order the app pane shows them. The root is
 * inspected when `selected` names no node.
 *
 * @param model the trace
 * @param selected the selected span id
 * @param options the frame bound and the column width
 *
 * @category rendering
 * @since 1.0.0
 */
export const lines = (
  model: TraceModel,
  selected?: string,
  options: DevToolsOptions & { readonly width?: number | undefined } = {}
): ReadonlyArray<string> => {
  const tree = devTools(model)
  const width = Math.max(options.width ?? 100, 40)
  const inspection = inspect(model, selected, options)
  const facts = [
    `${tree.counts.spans} ${tree.counts.spans === 1 ? "span" : "spans"}`,
    tree.counts.running > 0 ? `${tree.counts.running} running` : undefined,
    tree.counts.failed > 0 ? `${tree.counts.failed} failed` : undefined,
    tree.counts.spans > 0 ? `t = ${durationWords(tree.wallMs)}` : undefined
  ].filter((fact) => fact !== undefined)
  const out: Array<string> = [`${tree.label} · ${tree.status} · ${facts.join(" · ")}`]
  const labelWidth = Math.max(width - 30, 20)
  for (const node of tree.nodes) {
    const marker = node.id === inspection.node.id ? ">" : " "
    const label = clip(`${"  ".repeat(node.depth)}${glyphOf(node.status)} ${node.label}`, labelWidth).padEnd(labelWidth)
    const status = node.status === "completed" ? "" : node.status
    const duration = node.durationMs === undefined ? "" : durationWords(node.durationMs)
    out.push(`${marker} ${label} ${status.padEnd(10)} ${duration}`.trimEnd())
  }
  const { node } = inspection
  out.push("", `${node.kind} · ${inspection.path.join(" / ")} · ${node.status}`)
  if (node.startedAt > 0) out.push(`started   ${new Date(node.startedAt).toISOString()}`)
  if (node.durationMs !== undefined) {
    out.push(`duration  ${durationWords(node.durationMs)}${node.endedAt === undefined ? " · open" : ""}`)
  }
  if (inspection.seat !== undefined) out.push(`seat      ${inspection.seat}`)
  if (inspection.tokens !== undefined) {
    out.push(`tokens    ${inspection.tokens.input} in / ${inspection.tokens.output} out`)
  }
  if (inspection.childRunId !== undefined) out.push(`child     ${inspection.childRunId}`)
  if (inspection.event !== undefined) {
    out.push(`journal   ${inspection.event}${node.sequence === undefined ? "" : ` · #${node.sequence}`}`)
  }
  if (node.children > 0) out.push(`children  ${node.children}`)
  const blocks: ReadonlyArray<readonly [title: string, text: string | undefined]> = [
    ["Script", inspection.source],
    ["Printed", inspection.printed],
    ["Input", inspection.input === undefined ? undefined : json(inspection.input)],
    ["Output", inspection.output],
    ["Failure", inspection.failure],
    [
      "Fields",
      inspection.fields.length === 0
        ? undefined
        : inspection.fields.map(([key, value]) => `${key.padEnd(12)} ${oneLine(value)}`).join("\n")
    ]
  ]
  for (const [title, text] of blocks) {
    if (text === undefined) continue
    out.push(title, ...indent(text))
  }
  const shown = inspection.frames.length
  out.push(`Frames ${shown === inspection.frameCount ? shown : `${shown} of ${inspection.frameCount}`}`)
  for (const frame of inspection.frames) {
    out.push(`  #${frame.sequence} ${clip(`${frame.kind} ${oneLine(frame.payload)}`, Math.max(width - 8, 20))}`)
  }
  return out
}
