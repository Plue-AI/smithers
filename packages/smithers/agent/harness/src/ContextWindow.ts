/**
 * The immutable, provider-neutral context assembled for one model request.
 * Every value it exposes is frozen — the arrays, the segments, and the
 * messages, parts and tool declarations they hold — so a runtime mutation
 * throws in strict mode instead of silently invalidating the cached digest.
 *
 * Governing design: `../docs/concepts.md#context-window`.
 *
 * @since 0.1.0
 */

import * as Digest from "@smthrs/core/Digest"
import * as Fault from "@smthrs/flow/Fault"
import * as CanonicalJson from "@smthrs/model/CanonicalJson"
import * as ModelRequest from "@smthrs/model/ModelRequest"
import { dual } from "effect/Function"
import { type Pipeable, pipeArguments } from "effect/Pipeable"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import { compactable } from "./internal/compactable.ts"
import * as Tokens from "./Tokens.ts"

/**
 * The brand a {@link ContextWindow} carries so a structurally similar
 * object cannot pass for one.
 *
 * @category type ids
 * @since 0.1.0
 * @slop
 */
export const TypeId = "~flows/harness/ContextWindow" as const

/**
 * The type of {@link TypeId}.
 *
 * @category type ids
 * @since 0.1.0
 * @slop
 */
export type TypeId = typeof TypeId

/**
 * What a segment holds. The kind fixes where the segment may sit and
 * whether compaction is allowed to replace it.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export const SegmentKind = Schema.Literals([
  "system",
  "instructions",
  "registry",
  "tools",
  "transcript",
  "summary",
  "steering"
])

/**
 * The decoded form of {@link SegmentKind}.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type SegmentKind = typeof SegmentKind.Type

/**
 * Where a segment sits relative to the cache breakpoint. `prefix` segments
 * are stable across turns; `tail` segments change every turn.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export const SegmentZone = Schema.Literals(["prefix", "tail"])

/**
 * The decoded form of {@link SegmentZone}.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type SegmentZone = typeof SegmentZone.Type

/**
 * The parts a segment may hold: system text, transcript messages, and tool
 * declarations, in the provider-neutral vocabulary of `@smthrs/model`.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export const Content = Schema.Array(
  Schema.Union([ModelRequest.SystemPart, ModelRequest.Message, ModelRequest.ToolDefinition])
)

/**
 * The decoded form of {@link Content}.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type Content = typeof Content.Type

/**
 * What a compaction does with one prefix segment: `keep` it as it is,
 * `squash` it into the summary, or `remove` it outright.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export const Mark = Schema.Literals(["keep", "squash", "remove"])

/**
 * The decoded form of {@link Mark}.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type Mark = typeof Mark.Type

/**
 * The failure vocabulary of a context window operation.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export const ContextWindowErrorCode = Schema.Literals(["invalid_compaction_prefix", "invalid_compaction_marks"])

/**
 * The decoded form of {@link ContextWindowErrorCode}.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type ContextWindowErrorCode = typeof ContextWindowErrorCode.Type

/** Stable failure returned for an invalid public compaction prefix.
 * @category errors
 * @since 0.1.0
 * @slop
 */
export class ContextWindowError extends Schema.TaggedError<ContextWindowError>()(
  "flows/harness/ContextWindowError",
  {
    code: ContextWindowErrorCode,
    message: Schema.String
  }
) {}
Fault.register(
  "flows/harness/ContextWindowError",
  {
    invalid_compaction_prefix: "bug",
    invalid_compaction_marks: "bug"
  } satisfies Fault.Rows<ContextWindowErrorCode>
)

/** A stable, typed slice of the model-visible context.
 * @category models
 * @since 0.1.0
 * @slop
 */
export class Segment extends Schema.Class<Segment>("flows/harness/ContextWindow/Segment")({
  kind: SegmentKind,
  zone: SegmentZone,
  digest: Schema.String,
  tokens: Tokens.Count,
  content: Content
}) {}

/**
 * One assembled, immutable model context: its ordered segments, the tools
 * currently active, and the token accounting for both. Every combinator
 * returns a new window rather than mutating this one.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export class ContextWindow extends Schema.Class<ContextWindow>("flows/harness/ContextWindow")({
  modelId: Schema.String,
  segments: Schema.Array(Segment),
  activeTools: Schema.Array(Schema.String),
  replaced: Schema.optional(Schema.String),
  digest: Schema.String,
  tokens: Tokens.Accounting
}) implements Pipeable {
  readonly [TypeId] = TypeId

  /** Threads this window through the data-last combinators of this module.
   *
   * `window.pipe(appendTurn(message), render)` is `render(appendTurn(window, message))`.
   *
   * @category combinators
   * @since 0.1.0
   */
  pipe<A>(this: A): A
  pipe<A, B>(this: A, ab: (_: A) => B): B
  pipe<A, B, C>(this: A, ab: (_: A) => B, bc: (_: B) => C): C
  pipe<A, B, C, D>(this: A, ab: (_: A) => B, bc: (_: B) => C, cd: (_: C) => D): D
  pipe<A, B, C, D, E>(this: A, ab: (_: A) => B, bc: (_: B) => C, cd: (_: C) => D, de: (_: D) => E): E
  pipe<A, B, C, D, E, F>(
    this: A,
    ab: (_: A) => B,
    bc: (_: B) => C,
    cd: (_: C) => D,
    de: (_: D) => E,
    ef: (_: E) => F
  ): F
  pipe<A, B, C, D, E, F, G>(
    this: A,
    ab: (_: A) => B,
    bc: (_: B) => C,
    cd: (_: C) => D,
    de: (_: D) => E,
    ef: (_: E) => F,
    fg: (_: F) => G
  ): G
  pipe<A, B, C, D, E, F, G, H>(
    this: A,
    ab: (_: A) => B,
    bc: (_: B) => C,
    cd: (_: C) => D,
    de: (_: D) => E,
    ef: (_: E) => F,
    fg: (_: F) => G,
    gh: (_: G) => H
  ): H
  pipe<A, B, C, D, E, F, G, H, I>(
    this: A,
    ab: (_: A) => B,
    bc: (_: B) => C,
    cd: (_: C) => D,
    de: (_: D) => E,
    ef: (_: E) => F,
    fg: (_: F) => G,
    gh: (_: G) => H,
    hi: (_: H) => I
  ): I
  pipe<A, B, C, D, E, F, G, H, I, J>(
    this: A,
    ab: (_: A) => B,
    bc: (_: B) => C,
    cd: (_: C) => D,
    de: (_: D) => E,
    ef: (_: E) => F,
    fg: (_: F) => G,
    gh: (_: G) => H,
    hi: (_: H) => I,
    ij: (_: I) => J
  ): J
  pipe(this: unknown, ..._operators: ReadonlyArray<(input: never) => unknown>): unknown {
    // eslint-disable-next-line prefer-rest-params -- matches Effect's Pipeable implementation
    return pipeArguments(this, arguments)
  }

  /** @category constructors @since 0.1.0 */
  static override make(input: MakeOptions): ContextWindow {
    return construct(input)
  }

  /** @category constructors @since 0.1.0 */
  static empty(modelId: string): ContextWindow {
    return empty(modelId)
  }

  /** @category combinators @since 0.1.0 */
  static appendTurn(self: ContextWindow, assistantMessage: ModelRequest.AssistantMessage): ContextWindow {
    return appendTurn(self, assistantMessage)
  }

  /** @category combinators @since 0.1.0 */
  static compact(
    self: ContextWindow,
    summary: ModelRequest.Message | ReadonlyArray<ModelRequest.Message>
  ): Result.Result<ContextWindow, ContextWindowError> {
    return compact(self, summary)
  }

  /** @category conversions @since 0.1.0 */
  static render(self: ContextWindow): ModelRequest.ModelRequest {
    return render(self)
  }
}

/**
 * A segment before its digest and token count are computed. Supplying
 * `declaredDigest` or `tokens` skips the corresponding computation.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface SegmentInput {
  readonly kind: SegmentKind
  readonly zone: SegmentZone
  readonly content: Content
  readonly declaredDigest?: string | undefined
  readonly tokens?: Tokens.Count | undefined
}

/**
 * The declaration {@link ContextWindow.make} takes.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface MakeOptions {
  readonly modelId: string
  readonly segments?: ReadonlyArray<Segment | SegmentInput> | undefined
  readonly activeTools?: ReadonlyArray<string> | undefined
  readonly replaced?: string | undefined
}

const isSegment = (value: Segment | SegmentInput): value is Segment => value instanceof Segment

const jsonValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(jsonValue)
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, member]) => member !== undefined)
        .map(([key, member]) => [key, jsonValue(member)])
    )
  }
  return value
}

/**
 * What a segment is estimated from: its content, less every thinking part's
 * `signature`. A signature is opaque replay state, not context the provider
 * bills: on the ChatGPT route it is the whole encrypted reasoning item, often
 * larger than the turn's visible text, and counting it compacted a 400k-window
 * run at 31k to 41k billed input tokens (Terminal-Bench 4.0,
 * mp-checkpoint-consolidation, 2026-09-24). The digest still covers it.
 */
const withoutSignatures = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(withoutSignatures)
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>
    return Object.fromEntries(
      Object.entries(record)
        .filter(([key]) => !(record.type === "thinking" && key === "signature"))
        .map(([key, member]) => [key, withoutSignatures(member)])
    )
  }
  return value
}

const segmentText = (content: Content): string => CanonicalJson.stringify(withoutSignatures(jsonValue(content)))

const digest = (value: unknown): string => Digest.digest(CanonicalJson.stringify(value))

/** Every node in every graph this module has undertaken to freeze whole. */
const frozenWhole = new WeakSet<object>()

/**
 * Freezes one value and everything reachable from it.
 *
 * Freezing only the outer array kept the immutability promise for
 * `segments.push` and left `segments[0].content[0].content[0].text = "…"`
 * silent. A segment's digest is taken once, at construction, so a message or a
 * part edited in place afterwards renders content the window's own identity no
 * longer describes — and that identity is what the sealed step is keyed on.
 *
 * The module's own memo ends the walk. A value a caller froze is evidence only
 * that node cannot change, not that every descendant was frozen with it; a
 * segment this module already walked, on the other hand, can be reused across
 * turns in O(1). Recording a node before descending also makes a cycle end at
 * its first repeated edge.
 *
 * Members are limited to own enumerable string keys, as they were when this
 * walk used `Object.values`, but each one is read through its own descriptor.
 * An accessor is caller code, not data the freeze walk may execute.
 */
const freezeDeep = (value: unknown): void => {
  if (value === null || typeof value !== "object" || frozenWhole.has(value)) return
  // Recorded before the walk, so a graph that points at itself ends it.
  frozenWhole.add(value)
  Object.freeze(value)
  for (const key of Object.keys(value)) {
    const property = Object.getOwnPropertyDescriptor(value, key)
    if (property !== undefined && "value" in property) freezeDeep(property.value)
  }
}

/** Creates one segment, computing its identity and estimated token count.
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const makeSegment = (input: Segment | SegmentInput): Segment => {
  if (isSegment(input)) {
    freezeDeep(input.content)
    return input
  }
  const content: Content = [...input.content]
  freezeDeep(content)
  const segment = new Segment({
    kind: input.kind,
    zone: input.zone,
    digest: digest({
      kind: input.kind,
      zone: input.zone,
      content: jsonValue(content),
      ...(input.declaredDigest === undefined ? {} : { declaredDigest: input.declaredDigest })
    }),
    tokens: input.tokens ?? Tokens.count(segmentText(content)),
    content
  })
  freezeDeep(segment.content)
  return segment
}

const unique = (values: ReadonlyArray<string>): ReadonlyArray<string> => {
  const seen = new Set<string>()
  return values.filter((value) => {
    const normalized = value.trim().toLowerCase()
    return normalized !== "" && !seen.has(normalized) && (seen.add(normalized), true)
  })
}

const windowDigest = (
  modelId: string,
  segments: ReadonlyArray<Segment>,
  activeTools: ReadonlyArray<string>,
  replaced?: string
): string =>
  digest({
    modelId,
    segments: segments.map((segment) => segment.digest),
    activeTools,
    ...(replaced === undefined ? {} : { replaced })
  })

const construct = (options: MakeOptions): ContextWindow => {
  const segments = (options.segments ?? []).map(makeSegment)
  const activeTools = unique(options.activeTools ?? [])
  const window = new ContextWindow({
    modelId: options.modelId,
    segments,
    activeTools,
    replaced: options.replaced,
    digest: windowDigest(options.modelId, segments, activeTools, options.replaced),
    tokens: Tokens.combine(segments.map((segment) =>
      new Tokens.Segment({
        digest: segment.digest,
        zone: segment.zone,
        tokens: segment.tokens
      })
    ))
  })
  // The whole window, not its two outer arrays: a segment, a message, a part
  // and the token accounting are all values a caller holds a reference to, and
  // the digest above was taken over every one of them.
  freezeDeep(window)
  return window
}

/** Constructs a window from already-derived values.
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const make = (options: MakeOptions): ContextWindow => construct(options)

/** Constructs an empty context window for a model.
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const empty = (modelId: string): ContextWindow => make({ modelId })

/** Appends one settled assistant message.
 *
 * @category combinators
 * @since 0.1.0
 * @slop
 */
export const appendTurn: {
  (assistantMessage: ModelRequest.AssistantMessage): (self: ContextWindow) => ContextWindow
  (self: ContextWindow, assistantMessage: ModelRequest.AssistantMessage): ContextWindow
} = dual(2, (self: ContextWindow, assistantMessage: ModelRequest.AssistantMessage) =>
  construct({
    modelId: self.modelId,
    segments: [
      ...self.segments,
      makeSegment({ kind: "transcript", zone: "tail", content: [assistantMessage] })
    ],
    activeTools: self.activeTools,
    replaced: self.replaced
  }))

const summaryMessages = (summary: ModelRequest.Message | ReadonlyArray<ModelRequest.Message>): Content => {
  const messages: ReadonlyArray<ModelRequest.Message> = Array.isArray(summary)
    ? summary as ReadonlyArray<ModelRequest.Message>
    : [summary as ModelRequest.Message]
  return messages.map((message) =>
    message.role === "user"
      ? message
      : ModelRequest.Message.user(
        message.content.filter((part): part is ModelRequest.TextPart => part.type === "text")
      )
  )
}

const selectedPrefix = (
  self: ContextWindow,
  prefixLength: number
): Result.Result<ReadonlyArray<Segment>, ContextWindowError> => {
  if (!Number.isSafeInteger(prefixLength) || prefixLength < 0) {
    return Result.fail(
      new ContextWindowError({
        code: "invalid_compaction_prefix",
        message: "Compaction prefix length must be a non-negative safe integer"
      })
    )
  }
  const segments = compactable(self.segments)
  if (prefixLength > segments.length) {
    return Result.fail(
      new ContextWindowError({
        code: "invalid_compaction_prefix",
        message: "Compaction prefix length exceeds the compactable context"
      })
    )
  }
  return Result.succeed(segments.slice(0, prefixLength))
}

/**
 * Computes the declared identity of an exact compactable prefix.
 *
 * @category conversions
 * @since 0.1.0
 * @slop
 */
export const prefixDigest = (
  self: ContextWindow,
  prefixLength: number
): Result.Result<string, ContextWindowError> =>
  Result.map(selectedPrefix(self, prefixLength), (segments) => digest(segments.map((segment) => segment.digest)))

const marksError = (message: string): Result.Result<never, ContextWindowError> =>
  Result.fail(new ContextWindowError({ code: "invalid_compaction_marks", message }))

/**
 * Compacts an exact compactable prefix by its marks, one per prefix segment.
 *
 * The result holds, in order: the segments before the prefix; one `summary`
 * segment of `summary` when any segment is squashed; the kept segments, as
 * the same objects, so their digests are stable; then the suffix. Removed
 * segments are dropped. `summary` is required exactly when a segment is
 * squashed.
 *
 * @category combinators
 * @since 1.0.0-rc.0
 */
export const compactMarked = (
  self: ContextWindow,
  prefixLength: number,
  marks: ReadonlyArray<Mark>,
  summary: ModelRequest.Message | ReadonlyArray<ModelRequest.Message> | undefined
): Result.Result<ContextWindow, ContextWindowError> =>
  Result.gen(function*() {
    const replacedSegments = yield* selectedPrefix(self, prefixLength)
    if (marks.length !== replacedSegments.length) {
      return yield* marksError("Compaction marks must name every prefix segment once")
    }
    if (marks.includes("squash") !== (summary !== undefined)) {
      return yield* marksError("A compaction summary is required exactly when a prefix segment is squashed")
    }
    if (replacedSegments.length === 0) return self
    const replaced = digest(replacedSegments.map((segment) => segment.digest))
    const positions = self.segments.flatMap((segment, index) =>
      compactable([segment]).length === 0 ? [] : [index]
    ).slice(0, prefixLength)
    const first = positions[0]!
    const selected = new Set(positions)
    const segments = [
      ...self.segments.slice(0, first),
      ...(summary === undefined ? [] : [
        makeSegment({ kind: "summary", zone: "tail", content: summaryMessages(summary) })
      ]),
      ...replacedSegments.filter((_, index) => marks[index] === "keep"),
      ...self.segments.slice(first).filter((_, index) => !selected.has(first + index))
    ]
    return construct({ modelId: self.modelId, segments, activeTools: self.activeTools, replaced })
  })

/**
 * Replaces an exact compactable prefix while retaining every suffix segment:
 * {@link compactMarked} with every segment squashed.
 *
 * @category combinators
 * @since 0.1.0
 * @slop
 */
export const compactPrefix = (
  self: ContextWindow,
  prefixLength: number,
  summary: ModelRequest.Message | ReadonlyArray<ModelRequest.Message>
): Result.Result<ContextWindow, ContextWindowError> =>
  Result.flatMap(selectedPrefix(self, prefixLength), (replacedSegments) =>
    compactMarked(
      self,
      prefixLength,
      replacedSegments.map(() => "squash"),
      replacedSegments.length === 0 ? undefined : summary
    ))

/** Replaces the compactable transcript prefix with a summary segment.
 *
 * The most recent transcript segment remains the suffix, so a compacted
 * projection renders summary first followed by the un-compacted tail.
 *
 * @category combinators
 * @since 0.1.0
 * @slop
 */
export const compact: {
  (
    summary: ModelRequest.Message | ReadonlyArray<ModelRequest.Message>
  ): (self: ContextWindow) => Result.Result<ContextWindow, ContextWindowError>
  (
    self: ContextWindow,
    summary: ModelRequest.Message | ReadonlyArray<ModelRequest.Message>
  ): Result.Result<ContextWindow, ContextWindowError>
} = dual(2, (self: ContextWindow, summary: ModelRequest.Message | ReadonlyArray<ModelRequest.Message>) => {
  const segments = compactable(self.segments)
  const prefixLength = segments.length > 1 ? segments.length - 1 : segments.length
  return compactPrefix(self, prefixLength, summary)
})

/** Renders this provider-neutral value into a model request.
 * @category conversions
 * @since 0.1.0
 * @slop
 */
export const render = (self: ContextWindow): ModelRequest.ModelRequest => {
  const system: Array<ModelRequest.SystemPart> = []
  const messages: Array<ModelRequest.Message> = []
  const definitions = new Map<string, ModelRequest.ToolDefinition>()
  const definitionKey = (name: string): string => name.trim().toLowerCase()
  for (const segment of self.segments) {
    for (const item of segment.content) {
      if ("role" in item) messages.push(item)
      else if ("name" in item) definitions.set(definitionKey(item.name), item)
      else system.push(item)
    }
  }
  const active = new Set(self.activeTools.map(definitionKey))
  const tools = [...definitions.values()].filter((definition) =>
    definition.deferred === true || active.has(definitionKey(definition.name))
  )
  return ModelRequest.ModelRequest.make({
    modelId: self.modelId,
    system,
    messages,
    tools,
    params: ModelRequest.GenerationParams.make()
  })
}
