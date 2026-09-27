/**
 * The truncation ledger: which bytes this run was handed as a fragment.
 *
 * A flow that caps a captured stream returns the part that fit and declares the
 * cut in a sibling flag. What the cell reads is an ordinary string, and by the
 * time that string reaches a write there is nothing on it that remembers it was
 * cut — so an agent that restores a file with `git show <rev>:<path>` and writes
 * the captured stdout back replaces the file with its last 30,000 bytes. That is
 * not hypothetical: on a graded benchmark instance a 645-line module became its
 * own tail, the compile check failed with an indentation error, the run repeated
 * the identical restore without re-reading the flag, and the mangled file was
 * the answer submitted.
 *
 * The call boundary is the only place that sees both halves — the result that
 * declared the truncation, and the later input carrying those same bytes — so
 * the ledger lives there. A write of bytes a call already reported as truncated
 * is refused rather than warned about, because there is no case in which
 * writing a known fragment over a file is what the caller meant.
 *
 * The producing half is `@smthrs/std`: `Bash` declares `stdoutTruncated` beside
 * `stdout`, and the paged flows declare a bare `truncated` beside the text they
 * cut. Neither is a shared type — the controller must not depend on the tool
 * library — so both are read here as documented wire conventions, exactly as
 * `invalidProbe` is read by `CellTurn`.
 *
 * @since 0.1.0
 */

import * as Digest from "@smthrs/core/Digest"
import { Effect, Schema } from "effect"
import { NonNegativeSafeInt } from "./internal/nonNegativeSafeInt.ts"

/**
 * The suffix a flow flags one named payload's truncation with.
 *
 * `stdoutTruncated: true` says the sibling `stdout` is a fragment. The prefix
 * names the field, which is what lets the ledger record what was cut without
 * knowing the flow.
 *
 * @category constants
 * @since 0.1.0
 * @slop
 */
export const flagSuffix = "Truncated"

/**
 * The suffix a flow states one named payload's discarded byte count with.
 *
 * @category constants
 * @since 0.1.0
 * @slop
 */
export const droppedSuffix = "DroppedBytes"

/**
 * The bare flag a single-payload flow declares its truncation with.
 *
 * A paged read returns `content` and `truncated`, with no field name to pair
 * them, so every long string beside the flag is treated as the cut payload.
 *
 * @category constants
 * @since 0.1.0
 * @slop
 */
export const flagKey = "truncated"

/**
 * Smallest payload, in UTF-8 bytes, the ledger records or refuses.
 *
 * The refusal exists because a truncated capture is a file-sized fragment; a
 * short one is neither destructive to write nor distinctive enough to match
 * safely. Every real capture clears this by an order of magnitude — a shell
 * stream is cut at 30,000 bytes and a paged read at 60,000 — so the floor costs
 * the guard nothing and keeps a one-line notice out of the ledger.
 *
 * @category constants
 * @since 0.1.0
 * @slop
 */
export const minimumBytes = 1024

/**
 * How many *distinct* captures one run carries forward.
 *
 * The ledger is durable controller state, so it is bounded: the digest of a
 * capture is what the guard compares, and a run that has produced sixteen newer
 * fragments is no longer plausibly about to write the seventeenth.
 *
 * The bound counts distinct payloads because the run this guard exists for
 * repeats itself: the graded instance ran the identical `git show` restore
 * frame after frame. Counting each repetition would let one command evict every
 * other fragment the run was handed and re-open the hole sixteen calls later.
 *
 * @category constants
 * @since 0.1.0
 * @slop
 */
export const retained = 16

/**
 * One payload a flow returned after cutting it.
 *
 * The bytes themselves are not kept. A capture carries their digest, which is
 * all an exact-match refusal needs and is what keeps the ledger small enough to
 * live in journaled controller state.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export class Capture extends Schema.Class<Capture>("flows/harness/TruncatedOutput/Capture")({
  /** The flow whose result declared the cut. */
  flow: Schema.String,
  /** The result field that carries the fragment. */
  field: Schema.String,
  /** Bytes the flow discarded, as it reported them; zero when it did not say. */
  droppedBytes: NonNegativeSafeInt,
  /** The digest of the exact string the flow returned. */
  digest: Schema.String
}) {}

/**
 * One input field found to carry the exact bytes of an earlier capture.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface Reuse {
  /** Where in the refused input the fragment was found. */
  readonly path: string
  /** The capture those bytes came from. */
  readonly capture: Capture
}

const encoder = new TextEncoder()

const byteLength = (text: string): number => encoder.encode(text).byteLength

const isObject = (value: Schema.Json): value is Schema.JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value)

const droppedBytes = (node: Schema.JsonObject, field: string): number => {
  const declared = node[`${field}${droppedSuffix}`]
  return typeof declared === "number" && Number.isSafeInteger(declared) && declared >= 0 ? declared : 0
}

const captureField = (
  flow: string,
  node: Schema.JsonObject,
  field: string,
  into: Array<Capture>
): void => {
  const text = node[field]
  if (typeof text !== "string" || byteLength(text) < minimumBytes) return
  into.push(
    new Capture({
      flow,
      field,
      droppedBytes: droppedBytes(node, field),
      digest: Digest.digest(text)
    })
  )
}

const captureNode = (flow: string, node: Schema.JsonObject, into: Array<Capture>): void => {
  for (const [key, value] of Object.entries(node)) {
    if (value !== true) continue
    if (key === flagKey) {
      for (const sibling of Object.keys(node)) captureField(flow, node, sibling, into)
      continue
    }
    if (!key.endsWith(flagSuffix) || key.length === flagSuffix.length) continue
    captureField(flow, node, key.slice(0, -flagSuffix.length), into)
  }
}

const collect = (flow: string, value: Schema.Json, into: Array<Capture>): void => {
  if (Array.isArray(value)) {
    for (const item of value) collect(flow, item, into)
    return
  }
  if (!isObject(value)) return
  captureNode(flow, value, into)
  for (const item of Object.values(value)) collect(flow, item, into)
}

/**
 * Reads every truncated payload one settled call result declares.
 *
 * @category conversions
 * @since 0.1.0
 * @slop
 */
export const captures = (flow: string, value: Schema.Json): ReadonlyArray<Capture> => {
  const found: Array<Capture> = []
  collect(flow, value, found)
  return found
}

const search = (
  value: Schema.Json,
  path: string,
  known: ReadonlyMap<string, Capture>
): Reuse | undefined => {
  if (typeof value === "string") {
    if (byteLength(value) < minimumBytes) return undefined
    const capture = known.get(Digest.digest(value))
    return capture === undefined ? undefined : { path: path === "" ? "input" : path, capture }
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      const found = search(value[index], `${path}[${index}]`, known)
      if (found !== undefined) return found
    }
    return undefined
  }
  if (!isObject(value)) return undefined
  for (const [key, member] of Object.entries(value)) {
    const found = search(member, path === "" ? key : `${path}.${key}`, known)
    if (found !== undefined) return found
  }
  return undefined
}

/**
 * Finds the first input field that carries an earlier capture verbatim.
 *
 * Only an exact match counts. Content the agent derived from a fragment —
 * re-indented, spliced, summarized — is its own value and is not this
 * function's business; the one case being caught is the fragment handed
 * straight back as if it were whole.
 *
 * @category conversions
 * @since 0.1.0
 * @slop
 */
export const reuse = (
  input: Schema.Json,
  ledger: ReadonlyArray<Capture>
): Reuse | undefined =>
  ledger.length === 0
    ? undefined
    : search(input, "", new Map(ledger.map((capture) => [capture.digest, capture])))

/**
 * States why a call carrying a known fragment was refused.
 *
 * The message names the alternative, because a refusal an agent cannot act on
 * costs a frame and changes nothing: a file is restored from git with git
 * itself, never by piping a revision through captured output.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const refusal = (flow: string, found: Reuse): string =>
  `Flow ${flow} was refused: its ${found.path} is byte-identical to output this run already returned truncated — ${found.capture.flow} cut ${found.capture.field} and dropped ${found.capture.droppedBytes} bytes. Those bytes are a fragment of the value, not the value, so writing them replaces the target with a piece of itself. To restore a file from git, run git checkout or git restore on the path; never route file content through captured stdout.`

/**
 * Bounds the ledger to the {@link retained} most recent distinct captures.
 *
 * A repeated call returns the same bytes and so the same digest, and the guard
 * compares digests, so a second copy adds nothing but costs a slot. Collapsing
 * them keeps the bound a bound on what the run was handed rather than on how
 * many times it asked: a cell looping on one truncated `git show` no longer
 * pushes the fragment it captured before that loop out of the ledger.
 *
 * The newest position of a repeated digest is the one kept, so the record
 * states when the run was last handed those bytes.
 *
 * @category conversions
 * @since 0.1.0
 * @slop
 */
export const retain = (ledger: ReadonlyArray<Capture>): ReadonlyArray<Capture> => {
  const newest = new Map<string, Capture>()
  for (const capture of ledger) {
    newest.delete(capture.digest)
    newest.set(capture.digest, capture)
  }
  if (newest.size === ledger.length && ledger.length <= retained) return ledger
  const distinct = [...newest.values()]
  return distinct.length <= retained ? distinct : distinct.slice(distinct.length - retained)
}

/**
 * The ledger schema carried in controller state.
 *
 * @category schemas
 * @since 0.1.0
 * @slop
 */
export const Ledger = Schema.Array(Capture).pipe(
  Schema.withConstructorDefault(Effect.succeed<ReadonlyArray<Capture>>([])),
  Schema.withDecodingDefaultKey(Effect.succeed<ReadonlyArray<Capture>>([]))
)
