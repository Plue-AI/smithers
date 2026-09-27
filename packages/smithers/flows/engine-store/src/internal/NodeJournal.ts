/**
 * The interpreter's node records, as journal entries.
 *
 * `@smthrs/flow` builds a record for the graph it drove and for every node it
 * scheduled and settled, and says nothing about where they go. This module is
 * the durable store's answer: one journal entry per record, addressed by the
 * record's own `sourceId`, typed by the payload schemas `@smthrs/journal`
 * publishes, and carrying the same event types the plan scheduler writes so a
 * reader folds both executors with one decoder.
 *
 * Two facts live here rather than in the interpreter. The journal's producer
 * identity is `(runId, sourceId, sourceSeq)`, so a resumed walk that
 * re-derives the same `sourceId` collapses onto the row the first walk wrote:
 * that is the exactly-once contract, and it holds because the identity is the
 * record's, never a fresh one minted per observation. And a declaration site
 * is made repo-relative here, because only the writer knows the root: a
 * journal is read on machines that did not write it, and an absolute path is
 * at best noise and at worst an operator's home directory published into a
 * run's history.
 *
 * @since 0.1.0
 */

import type { FlowRuntime } from "@smthrs/flow"
import { EngineEvent, JournalEvent, Redaction } from "@smthrs/journal"
import type * as Schema from "effect/Schema"
import * as JournalRecords from "./JournalRecords.ts"

/**
 * Where the records of one run are addressed from.
 *
 * @since 0.1.0
 * @category models
 */
export interface Scope {
  readonly runId: string
  /** The host's journal source, which every record of this run hangs under. */
  readonly sourceId: string
  readonly lineageId: string
  /**
   * The directory a declaration path is made relative to, when one is known.
   *
   * `undefined` means no path is recorded at all. That is the honest answer
   * for a host that cannot say where its sources live, and it is better than
   * a path a reader would have to guess the meaning of.
   */
  readonly root?: string | undefined
  /**
   * The revision the sources those declaration paths point into were read
   * at, when the host can name one.
   *
   * It lives here for the reason `root` does: a journal is read on machines
   * that did not write it, and only the writer knows which tree it loaded.
   * A path alone says where a node was declared and never which bytes were
   * at that line, so a reader without this opens no code at all rather than
   * whatever the working tree holds when they look (D-068).
   */
  readonly sourceRevision?: string | undefined
}

/**
 * A declaration path as a journal may carry it: relative to the root, or
 * nothing.
 *
 * The rule lives with the schema that refuses an absolute path
 * (`@smthrs/journal`'s `EngineEvent.DeclaredAt`), so every writer of a
 * declaration site obeys it the same way. It is named here because this is
 * the module that applies it, and because the store's own tests are written
 * against it.
 *
 * @since 0.1.0
 * @category accessors
 */
export const relativePath = EngineEvent.relativePath

/**
 * A value the journal will serialize, typed as what it will be.
 *
 * A node's effects are JSON by construction, but an optional member spelled
 * `undefined` is not assignable to `Json` under `exactOptionalPropertyTypes`,
 * and serialization is exactly what drops it. This is the journal's own
 * encoding performed one step early, so the type says what the stored value
 * is rather than asserting it. @private
 */
const asJson = (value: unknown): typeof Schema.Json.Type => JSON.parse(JSON.stringify(value))

/**
 * The directory declaration paths are recorded relative to.
 *
 * `process` is absent in a worker and in a browser, and a host that cannot
 * name its own working directory records no declaration path at all rather
 * than one a reader would have to guess the meaning of. `host` is the global
 * object by default and is named here so both answers are reachable without
 * taking the real one away from the runtime.
 *
 * @since 0.1.0
 * @category accessors
 */
export const hostRoot = (
  explicit: string | undefined,
  host: { readonly process?: { readonly cwd?: () => string } | undefined } = globalThis
): string | undefined => {
  if (explicit !== undefined) return explicit
  return typeof host.process?.cwd === "function" ? host.process.cwd() : undefined
}

const summary = (scope: Scope, node: FlowRuntime.NodeSummary) => {
  const path = node.declaredAt === undefined ? undefined : relativePath(scope.root, node.declaredAt.path)
  return {
    id: node.id,
    kind: node.kind,
    dependsOn: node.dependsOn,
    tier: node.tier,
    ...(node.action === undefined ? {} : { action: node.action }),
    ...(node.effects === undefined ? {} : { effects: asJson(node.effects) }),
    ...(path === undefined ? {} : { declaredAt: { path, line: node.declaredAt!.line } })
  }
}

const graph = (scope: Scope, record: FlowRuntime.PlanRecorded | FlowRuntime.SubgraphAppended) => ({
  nodes: record.nodes.map((node) => summary(scope, node)),
  edges: record.edges,
  // On every page, because every page carries its own sites.
  ...(scope.sourceRevision === undefined ? {} : { sourceRevision: scope.sourceRevision })
})

/**
 * How many bytes of a node's settled value a journal row keeps.
 *
 * A node record is a small row beside the plan record's 12,000-byte page
 * budget, and it is written once per node of every graph: a value kept whole
 * would put an agent transcript in a permanent row and a projection would
 * clip it without saying so. Two kibibytes is enough to read what a node
 * produced and small enough that the settlement stays a summary.
 *
 * @since 0.1.0
 * @category constants
 */
export const maximumResultBytes = 2_048

/**
 * How large a settled value may be before it is summarized at all.
 *
 * Redacting a value rebuilds every member of it and runs the textual rules
 * over every string, on the journal write path, for every node of every
 * graph. Past this ceiling the walk is the cost rather than the row, and the
 * honest answer is the size alone: the encoding is measured, `preview` is
 * empty, and `truncated` says the text was cut to nothing. Anything below it
 * is redacted whole and then cut.
 *
 * @since 0.1.0
 * @category constants
 */
export const maximumSummarizedBytes = 65_536

/** The redactor a node summary is scrubbed with, built once. @private */
const redactor = Redaction.make({ onTooDeep: "name" })

/** UTF-8 bytes of a string, without allocating the encoding. @private */
const utf8Bytes = (text: string): number => {
  let bytes = 0
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index)
    if (code < 0x80) bytes += 1
    else if (code < 0x800) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      bytes += 4
      index++
    } else bytes += 3
  }
  return bytes
}

/**
 * The longest prefix of `text` within `limit` UTF-8 bytes, never splitting a
 * pair.
 *
 * One cut, taken where the walk stopped, because the walk stops for two
 * reasons and only one of them can happen: the caller asks only for text it
 * has already measured as over the limit, so a second exit for text that fits
 * whole would be a line no run reaches. @private
 */
const clampToBytes = (text: string, limit: number): string => {
  let bytes = 0
  let index = 0
  while (index < text.length) {
    const code = text.charCodeAt(index)
    const pair = code >= 0xd800 && code <= 0xdbff && index + 1 < text.length
    const size = code < 0x80 ? 1 : code < 0x800 ? 2 : pair ? 4 : 3
    if (bytes + size > limit) break
    bytes += size
    index += pair ? 2 : 1
  }
  return text.slice(0, index)
}

/**
 * What a node settled with, redacted and then bounded.
 *
 * REDACTION COMES FIRST. `Redaction.redact` is the journal's own write-path
 * scrubber, and it is the one that reads a field NAME: `{ apiKey: "sk-..." }`
 * is a credential because of the key, which no rule over encoded text can see
 * once the value is a string inside a larger string. Running it over the
 * decoded value also collapses cycles and names functions, so the encoding
 * that follows always succeeds. Cutting the text first would be worse than
 * useless: a credential split across the boundary is a credential the textual
 * rules no longer recognise, and half of it would be kept.
 *
 * A value that will not encode even after redaction — a bigint, a value whose
 * own `toJSON` throws — gets no summary at all rather than a fabricated one.
 *
 * `bytes` is the size of the encoding `preview` was cut from, which for a
 * value past {@link maximumSummarizedBytes} is the value's own encoding: that
 * branch keeps nothing, so there is no second number to disagree with.
 *
 * @since 0.1.0
 * @category constructors
 */
export const resultSummary = (value: unknown): {
  readonly preview: string
  readonly bytes: number
  readonly truncated: boolean
} | undefined => {
  // The size first, from the value's own encoding, because it is the cheap
  // half: a value this row will not keep is named by its size and never
  // walked. A value that will not encode at all — a cycle, a bigint, a
  // throwing `toJSON` — says nothing here, and the redactor below is asked,
  // because it collapses cycles and names what it cannot rewrite.
  let raw: string | undefined
  try {
    raw = JSON.stringify(value)
  } catch {
    raw = undefined
  }
  if (raw !== undefined) {
    const rawBytes = utf8Bytes(raw)
    if (rawBytes > maximumSummarizedBytes) return { preview: "", bytes: rawBytes, truncated: true }
  }
  let encoded: string | undefined
  try {
    encoded = JSON.stringify(redactor(value))
  } catch {
    return undefined
  }
  if (encoded === undefined) return undefined
  const bytes = utf8Bytes(encoded)
  if (bytes > maximumSummarizedBytes) return { preview: "", bytes, truncated: true }
  if (bytes <= maximumResultBytes) return { preview: encoded, bytes, truncated: false }
  return { preview: clampToBytes(encoded, maximumResultBytes), bytes, truncated: true }
}

/**
 * The journal entry one node record is written as.
 *
 * @since 0.1.0
 * @category constructors
 */
export const entry = (scope: Scope, record: FlowRuntime.NodeRecord): JournalEvent.Input => {
  const options = {
    runId: scope.runId,
    sourceId: `${scope.sourceId}/${record.sourceId}`,
    lineageId: scope.lineageId,
    // Without an explicit sequence the journal ALLOCATES the next one for the
    // source, so a resumed walk would write a second row for every node it
    // re-derived. Pinning it to zero makes the re-emission an exact producer
    // retry, which is the whole of the exactly-once contract.
    sourceSeq: 0,
    // The sequence is derived from the record's own identity, so a collision
    // is the same node observed twice rather than two nodes wearing one
    // address. What differs between the observations is metadata ABOUT the
    // observation — a node the first walk BUILT settles CLEAN on the walk
    // that replayed it — and the first row, the one that says what actually
    // happened, stands.
    dedupe: "identity" as const
  }
  switch (record._tag) {
    case "PlanRecorded":
      return JournalRecords.planRecorded(options, {
        flow: record.flow,
        generation: record.generation,
        // The node COUNT of the whole graph, which is what this field has
        // always meant; the node LIST rides beside it as `graph`.
        nodes: record.nodeCount,
        page: record.page,
        pages: record.pages,
        graph: graph(scope, record)
      })
    case "SubgraphAppended":
      return JournalRecords.subgraphAppended(options, {
        flow: record.flow,
        generation: record.generation,
        nodeIds: record.nodes.map((node) => node.id),
        page: record.page,
        pages: record.pages,
        graph: graph(scope, record)
      })
    case "NodeScheduled":
      return JournalRecords.nodeScheduled(options, {
        nodeId: record.nodeId,
        kind: record.kind,
        attempt: record.attempt,
        ...(record.action === undefined ? {} : { action: record.action })
      })
    case "NodeSettled": {
      const result = record.value === undefined ? undefined : resultSummary(record.value)
      return JournalRecords.nodeSettled(options, {
        nodeId: record.nodeId,
        outcome: record.outcome,
        attempts: record.attempts,
        stepKeyDigests: record.stepKeyDigests,
        ...(record.action === undefined ? {} : { action: record.action }),
        ...(result === undefined ? {} : { result })
      })
    }
  }
}

/**
 * UTF-8 upper bound for the durable entry, including allocated envelope fields.
 *
 * Sequence/time reserve their largest JSON encodings so page boundaries never
 * depend on the current journal position or clock, including after a resume.
 * @since 1.0.0
 * @category accessors
 */
export const encodedBytes = (scope: Scope, record: FlowRuntime.NodeRecord): number => {
  const input = entry(scope, record)
  const sourceSeq = JournalEvent.SourceSeq.make(0)
  return new TextEncoder().encode(JSON.stringify({
    runId: input.runId,
    seq: Number.MAX_SAFE_INTEGER - 1,
    eventId: JournalEvent.makeEventId(input.runId, input.sourceId, sourceSeq),
    sourceId: input.sourceId,
    sourceSeq,
    emittedAtMs: Number.MAX_VALUE,
    eventType: input.eventType,
    payload: redactor(input.payload),
    meta: redactor(input.meta)
  })).byteLength
}
