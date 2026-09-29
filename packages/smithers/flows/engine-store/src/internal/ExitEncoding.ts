/**
 * Encoding a round's settlement so a terminal transition can never be lost.
 *
 * A run row leaves `running` only when the driver has bytes to write into
 * `state_json`, and those bytes come from the flow's OWN codec:
 * `Flow.Result({ success: flow.successSchema, error: flow.errorSchema })`.
 * A flow that declares `Schema.Unknown` for either channel — which is what
 * `@smthrs/agent`'s `agent/run` declares, because an agent run carries
 * whatever its body failed with — encodes that channel through `Schema.Json`,
 * and `Schema.Json` rejects every class instance: `SchemaAST.isJson` walks the
 * prototype chain and refuses anything that is not a plain object or an array.
 * Every `Data.TaggedError` in this repository is therefore unencodable through
 * such a flow, `HarnessError` and `ModelError` included.
 *
 * Guarding the terminal transition with `Effect.orDie` around that encode made
 * an unencodable failure fatal for the drain instead of terminal for the run.
 * The release validation caught the whole chain: `engine-store: coordinated
 * drain failed for run-1 SchemaError: Expected JSON value at
 * ["exit"]["cause"][0]["error"]`, `engine.db` `flows_runs` left at `running`
 * with a dead owner pid while `control.db` said `failed`, and 86 seconds later
 * the next process's stale-running sweep stole the row, opened a second turn,
 * and billed the provider seat again for a run the control plane had closed.
 *
 * So the encode fails CLOSED here rather than open. The ordinary path is the
 * flow's own codec, unchanged. When that codec rejects the value, the result
 * is still written — as a JSON projection of what could not be encoded (tag,
 * code, message, a stack summary, and nested causes) inside a `Die` reason —
 * and the caller is told, through {@link EncodedResult.note}, that it must
 * settle the run `failed`. A settled run is never re-executed, which is the
 * durability promise the release policy states as one terminal write.
 *
 * The projection is built as plain JSON rather than re-encoded through a
 * schema, so nothing in this module can raise. Its top-level object carries no
 * `message` key on purpose: `Schema.Defect` revives any JSON object that has a
 * string `message` as an `Error`, and a projection has to come back out of the
 * row as the structured record it went in as.
 *
 * @since 0.1.0
 */

import { Flow } from "@smthrs/flow"
import { Redaction } from "@smthrs/journal"
import type * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Schema from "effect/Schema"
import * as HostReflection from "./HostReflection.ts"

/**
 * Proxy and native-error detection, taken from the host that can answer them.
 *
 * `./HostReflection.ts` states why these are host predicates rather than a
 * `node:util/types` import: the module has to bundle for a browser, and only
 * some hosts can name a proxy at all.
 */
const { isNativeError, isProxy } = HostReflection.host

/**
 * The `_tag` every projection carries, so a reader of `state_json` can tell a
 * projected settlement from an encoded one without guessing.
 *
 * @since 0.1.0
 * @category constants
 */
export const projectionTag = "flows/engine-store/UnencodableResult"

/**
 * How many `cause` links a value projection follows before it stops.
 *
 * A provider failure nests two or three deep (`HarnessError` over
 * `ModelError` over the transport error); the bound exists so a self-linking
 * cause chain cannot make the projection unbounded.
 *
 * @since 0.1.0
 * @category constants
 */
export const maxCauseDepth = 4

/**
 * How many leading stack lines a value projection keeps.
 *
 * @since 0.1.0
 * @category constants
 */
export const maxStackLines = 4

/**
 * How many characters any single projected string keeps.
 *
 * @since 0.1.0
 * @category constants
 */
export const maxTextLength = 1024

/**
 * Maximum cause reasons retained by the terminal fallback.
 *
 * @category constants
 * @since 1.0.0
 */
export const maxReasonCount = 32

/**
 * Maximum serialized bytes retained by one fallback projection.
 *
 * @category constants
 * @since 1.0.0
 */
export const maxProjectionBytes = 64 * 1024

/**
 * A JSON-safe summary of one unencodable value.
 *
 * `type` is the constructor name for an object and the `typeof` for anything
 * else, so `ModelError` and `"boom"` are distinguishable in the row.
 *
 * @since 0.1.0
 * @category models
 */
export interface ValueProjection {
  readonly type: string
  readonly message: string
  readonly tag?: string
  readonly code?: string
  readonly stack?: string
  readonly cause?: ValueProjection
}

/**
 * A JSON-safe summary of one `Cause` reason.
 *
 * @since 0.1.0
 * @category models
 */
export interface ReasonProjection {
  readonly _tag: "Fail" | "Die" | "Interrupt"
  readonly error?: ValueProjection
  readonly fiberId?: number
}

/**
 * The record written in place of a settlement the flow's codec rejected.
 *
 * @since 0.1.0
 * @category models
 */
export interface ResultProjection {
  readonly _tag: typeof projectionTag
  readonly result: "Complete" | "Suspended" | "Handoff"
  readonly note: string
  readonly reasons: ReadonlyArray<ReasonProjection>
  readonly value: ValueProjection | null
}

/**
 * What {@link encode} produces: the bytes to persist, and — only when the
 * flow's codec rejected the settlement — the note describing why.
 *
 * A present `note` is an instruction to the caller, not decoration: the run
 * must reach a terminal `failed` row, because the alternative is the row this
 * lane exists to abolish, a `running` row whose owner is gone.
 *
 * @since 0.1.0
 * @category models
 */
export interface EncodedResult {
  readonly encoded: unknown
  readonly note: string | undefined
}

const truncate = (value: string, limit: number): string => value.length <= limit ? value : `${value.slice(0, limit)}…`

/**
 * Bounds one projected message or stack after the journal's redaction rules.
 *
 * The projection is observability text in `flows_runs.state_json`, and a git or
 * HTTP failure message embeds its remote URL, credentials included. Redaction
 * runs before truncation so a cut cannot leave half a credential the rules no
 * longer match.
 */
const redactedText = (value: string): string => truncate(Redaction.redact(value) as string, maxTextLength)

/**
 * Renders any value as a bounded string without raising.
 *
 * `JSON.stringify` answers `undefined` for a function, a symbol, and
 * `undefined` itself, and throws on a circular structure; both are answered
 * with a shape marker rather than propagated, because this module runs on the
 * path that must never fail.
 */
const text = (value: unknown): string => {
  switch (typeof value) {
    case "string":
      return JSON.stringify(value)
    case "number":
      return Number.isFinite(value) ? `${value}` : `[number]`
    case "boolean":
      return value ? "true" : "false"
    case "bigint":
      return `[bigint]`
    case "undefined":
    case "symbol":
    case "function":
      return `[${typeof value}]`
    case "object":
      return value === null ? "null" : Array.isArray(value) ? "[array]" : "[object]"
  }
}

const minimalValue = (): ValueProjection => ({ type: "object", message: "[unrepresentable]" })

/** Reads only an own data property; accessors are deliberately inert. */
const ownData = (value: object, name: PropertyKey): unknown => {
  const descriptor = Object.getOwnPropertyDescriptor(value, name)
  return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined
}

// Effect exits store their value/cause in one own data slot. Pinning the two
// library prototypes lets projection read that slot without invoking the
// public `value` / `cause` accessors or trusting a lookalike object.
const successExitPrototype = Object.getPrototypeOf(Exit.succeed(undefined))
const failureExitPrototype = Object.getPrototypeOf(Exit.fail(undefined))
const exitArguments = "~effect/Effect/args"

/**
 * Projects one value — a typed error, a defect, a success value, a handoff
 * payload — into JSON.
 *
 * @since 0.1.0
 * @category conversions
 */
export const projectValue = (value: unknown, depth = 0, seen = new WeakSet<object>()): ValueProjection => {
  if (value === null || typeof value !== "object") {
    return {
      type: value === null ? "null" : typeof value,
      message: redactedText(text(value))
    }
  }
  // Generic Proxy introspection is observable user code. A host that can name
  // a proxy from its internal slot rejects it without invoking a trap.
  if (isProxy(value) || seen.has(value)) return minimalValue()
  seen.add(value)
  try {
    const message = ownData(value, "message")
    const tag = ownData(value, "_tag")
    const code = ownData(value, "code")
    const stack = ownData(value, "stack")
    const cause = ownData(value, "cause")
    const projection: {
      type: string
      message: string
      tag?: string
      code?: string
      stack?: string
      cause?: ValueProjection
    } = {
      type: typeof tag === "string" && tag.length > 0
        ? truncate(tag, maxTextLength)
        : isNativeError(value)
        ? "Error"
        : Array.isArray(value)
        ? "Array"
        : "object",
      message: redactedText(typeof message === "string" ? message : text(value))
    }
    if (typeof tag === "string") projection.tag = truncate(tag, maxTextLength)
    if (typeof code === "string") projection.code = truncate(code, maxTextLength)
    // Native Error stacks are commonly accessors. They remain deliberately
    // unread; only an already-materialized own data string is retained.
    if (typeof stack === "string") {
      projection.stack = redactedText(stack.split("\n").slice(0, maxStackLines).join("\n"))
    }
    if (cause !== undefined && depth < maxCauseDepth) {
      projection.cause = projectValue(cause, depth + 1, seen)
    }
    return projection
  } catch {
    return minimalValue()
  }
}

const projectReason = (reason: Cause.Reason<unknown>): ReasonProjection => {
  if (isProxy(reason)) return { _tag: "Die", error: minimalValue() }
  try {
    const tag = ownData(reason, "_tag")
    if (tag === "Fail") return { _tag: "Fail", error: projectValue(ownData(reason, "error")) }
    if (tag === "Die") return { _tag: "Die", error: projectValue(ownData(reason, "defect")) }
    const fiberId = ownData(reason, "fiberId")
    return typeof fiberId === "number" ? { _tag: "Interrupt", fiberId } : { _tag: "Interrupt" }
  } catch {
    return { _tag: "Die", error: minimalValue() }
  }
}

/**
 * Projects every reason of a cause, in order. An absent cause — a
 * `Flow.Suspended` that carries none — projects to no reasons.
 *
 * @since 0.1.0
 * @category conversions
 */
export const projectCause = (
  cause: Cause.Cause<unknown> | undefined
): ReadonlyArray<ReasonProjection> => {
  if (cause === undefined) return []
  if (isProxy(cause)) return [{ _tag: "Die", error: minimalValue() }]
  try {
    const reasons = ownData(cause, "reasons")
    if (!Array.isArray(reasons) || isProxy(reasons)) {
      return [{ _tag: "Die", error: minimalValue() }]
    }
    const projected = reasons.slice(0, maxReasonCount).map(projectReason)
    if (reasons.length > maxReasonCount) {
      projected.push({
        _tag: "Die",
        error: { type: "truncated", message: `[${reasons.length - maxReasonCount} reasons omitted]` }
      })
    }
    return projected
  } catch {
    return [{ _tag: "Die", error: minimalValue() }]
  }
}

const minimalResult = (note: string): ResultProjection => ({
  _tag: projectionTag,
  result: "Complete",
  note,
  reasons: [{ _tag: "Die", error: minimalValue() }],
  value: null
})

const withinBudget = (projection: ResultProjection): ResultProjection => {
  try {
    return new TextEncoder().encode(JSON.stringify(projection)).length <= maxProjectionBytes
      ? projection
      : minimalResult("the rejected settlement exceeded the diagnostic projection bound")
  } catch {
    return minimalResult("the rejected settlement could not be projected")
  }
}

/**
 * Projects a settlement the flow's codec rejected.
 *
 * @since 0.1.0
 * @category conversions
 */
export const projectResult = (
  result: Flow.Result<unknown, unknown>,
  note: string
): ResultProjection => {
  note = truncate(note, maxTextLength)
  if (isProxy(result)) return minimalResult(note)
  try {
    const tag = ownData(result, "_tag")
    if (tag === "Suspended") {
      return withinBudget({
        _tag: projectionTag,
        result: "Suspended",
        note,
        reasons: projectCause(ownData(result, "cause") as Cause.Cause<unknown> | undefined),
        value: null
      })
    }
    if (tag === "Handoff") {
      return withinBudget({
        _tag: projectionTag,
        result: "Handoff",
        note,
        reasons: [],
        value: projectValue(ownData(result, "payload"))
      })
    }
    const exit = ownData(result, "exit")
    if (typeof exit !== "object" || exit === null || isProxy(exit)) return minimalResult(note)
    const prototype = Object.getPrototypeOf(exit)
    const argument = ownData(exit, exitArguments)
    if (prototype !== successExitPrototype && prototype !== failureExitPrototype) return minimalResult(note)
    return withinBudget(
      prototype === successExitPrototype
        ? {
          _tag: projectionTag,
          result: "Complete",
          note,
          reasons: [],
          value: projectValue(argument)
        }
        : {
          _tag: projectionTag,
          result: "Complete",
          note,
          reasons: projectCause(argument as Cause.Cause<unknown> | undefined),
          value: null
        }
    )
  } catch {
    return minimalResult(note)
  }
}

/**
 * The encoded settlement written in place of one the codec rejected.
 *
 * A `Handoff` keeps its own shape, because its round settles `completed` with
 * a successor already created and the lineage has to stay readable. Everything
 * else becomes a failed `Complete`: a settlement whose bytes the codec refuses
 * is not resumable and not answerable, so the only honest durable record is
 * that the round failed, with the projection as its defect.
 */
const degrade = (result: Flow.Result<unknown, unknown>, projection: ResultProjection): unknown => {
  try {
    if (!isProxy(result) && ownData(result, "_tag") === "Handoff") {
      const flow = ownData(result, "flow")
      if (typeof flow === "string") return { _tag: "Handoff", flow, payload: projection, capabilityCeilings: [[]] }
    }
  } catch {
    // The terminal Complete below is the fail-closed representation.
  }
  return { _tag: "Complete", exit: { _tag: "Failure", cause: [{ _tag: "Die", defect: projection }] } }
}

/**
 * Encodes a round's settlement through the flow's own codec, and — when that
 * codec rejects it — through a JSON projection instead.
 *
 * The returned effect has no error channel and dies for nothing: a caller on
 * the terminal-transition path can always write the row it holds.
 *
 * @since 0.1.0
 * @category conversions
 */
export const encode = (
  flow: Flow.Any,
  result: Flow.Result<unknown, unknown>
): Effect.Effect<EncodedResult> =>
  Schema.encodeEffect(
    Schema.toCodecJson(Flow.Result({
      success: flow.successSchema,
      error: flow.errorSchema
    }))
  )(result).pipe(
    Effect.map((encoded): EncodedResult => ({ encoded, note: undefined })),
    Effect.catchCause((_cause) => {
      const note = "the flow result codec rejected the settlement"
      return Effect.as(
        Effect.logWarning(
          `engine-store: the settlement of ${flow._tag} could not be encoded through its own codec; persisting a JSON projection so the run still settles`
        ),
        { encoded: degrade(result, projectResult(result, note)), note } satisfies EncodedResult
      )
    })
  ) as Effect.Effect<EncodedResult>
