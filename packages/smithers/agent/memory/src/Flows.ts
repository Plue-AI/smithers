/**
 * Memory flow declarations and runtime bindings.
 *
 * The declarations describe the runtime operation but intentionally perform
 * no memory I/O while a graph is being built.
 *
 * @see https://memory.smithers.sh/reference/api/
 * @see https://smithers.sh/docs/reference/api/patterns
 * @since 0.1.0
 */

import * as Effects from "@smthrs/core/Effects"
import * as Flow from "@smthrs/core/Flow"
import type * as DurableFlow from "@smthrs/flow/Flow"
import * as Pattern from "@smthrs/patterns/Pattern"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { resolveNamespace } from "./internal/ResolveNamespace.ts"
import { MemoryError } from "./MemoryError.ts"
import * as MemoryStore from "./MemoryStore.ts"
import * as Namespace from "./Namespace.ts"
import * as Recall from "./Recall.ts"
import * as WithMemory from "./WithMemory.ts"

/**
 * The registry name of the `remember` flow.
 *
 * @category identifiers
 * @since 0.1.0
 */
export const rememberName = "remember"

/**
 * The registry name of the `recall` flow.
 *
 * @category identifiers
 * @since 0.1.0
 */
export const recallName = "recall"

/**
 * The one-line description the model sees for the `remember` flow.
 *
 * @category descriptions
 * @since 0.1.0
 */
export const rememberDescription = "Persist a memory record in a named bank."

/**
 * The one-line description the model sees for the `recall` flow.
 *
 * @category descriptions
 * @since 0.1.0
 */
export const recallDescription = "Recall advisory memory rows from named banks."

/**
 * Maximum UTF-8 byte length of a remembered key.
 *
 * @category constants
 * @since 1.0.0
 */
export const MAX_REMEMBER_KEY_BYTES = 1_024

/**
 * Maximum UTF-8 byte length of a remembered text: the recall query cap, so a
 * fact never outgrows what one recall budget can return.
 *
 * @category constants
 * @since 1.0.0
 */
export const MAX_REMEMBER_TEXT_BYTES = Recall.MAX_RECALL_QUERY_BYTES

const utf8 = new TextEncoder()
const maxUtf8Bytes = (max: number, label: string) =>
  Schema.makeFilter((value: string) =>
    utf8.encode(value).byteLength <= max ? undefined : `${label} exceeds ${max} UTF-8 bytes`
  )

/**
 * The tag prefix a `remember` caller may not write.
 *
 * A `source:` tag claims where a record came from, and recall filters on it to
 * select trusted-source memory, so only a host writing through the store may
 * set it. A model-written fact carrying `source:eval` would otherwise pose as
 * an evaluation's finding.
 *
 * @category constants
 * @since 1.0.0
 */
export const RESERVED_REMEMBER_TAG_PREFIX = "source:"

const reservedTagIssue = (tags: ReadonlyArray<string>): string | undefined =>
  tags.some((tag) => tag.startsWith(RESERVED_REMEMBER_TAG_PREFIX))
    ? `invalid_tag: remember may not set a ${RESERVED_REMEMBER_TAG_PREFIX} tag`
    : undefined

/**
 * Input schema for remember.
 *
 * Tags use `Namespace.Tags` so model decoding and durable writes enforce the
 * same vocabulary, uniqueness rule, and 16-tag cap before the handler performs
 * I/O, and refuse the reserved `source:` prefix. The bank uses `Recall.BankName`, so every remembered
 * fact is in a bank recall can name, and key and text are byte-capped. `ttlMs` is passed to the authoritative fact row.
 *
 * @category schemas
 * @since 0.1.0
 */
export const RememberInput = Schema.Struct({
  bank: Recall.BankName,
  key: Schema.NonEmptyString.pipe(Schema.check(maxUtf8Bytes(MAX_REMEMBER_KEY_BYTES, "remember key"))),
  text: Schema.String.pipe(Schema.check(maxUtf8Bytes(MAX_REMEMBER_TEXT_BYTES, "remember text"))),
  tags: Schema.optional(
    Namespace.Tags.pipe(Schema.check(Schema.makeFilter(reservedTagIssue, { identifier: "invalid_tag" })))
  ),
  ttlMs: Schema.optional(
    Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)))
  )
})

/**
 * Output schema for remember.
 *
 * @category schemas
 * @since 0.1.0
 */
export const RememberOutput = Schema.Struct({ key: Schema.String })

/**
 * Input schema for the `recall` flow: `Recall.Input`, re-exported beside
 * `RememberInput` so a host declares both flows from this module.
 *
 * @category schemas
 * @since 0.1.0
 */
export const RecallInput = Recall.Input

/**
 * Output schema for the `recall` flow: `Recall.Output`.
 *
 * @category schemas
 * @since 0.1.0
 */
export const RecallOutput = Recall.Output

/**
 * Unsealed effect declaration for durable memory writes.
 *
 * @category effects
 * @since 0.1.0
 */
export const rememberEffects = Effects.make({
  reads: ["memory/**"],
  writes: ["memory/**"],
  mode: "expected",
  onConflict: "serialize",
  tier: "irreversible"
})

/**
 * Sealed effect declaration for mutable cross-run memory reads.
 *
 * The core declaration shape requires a conflict policy, so this pure read
 * uses `fail` instead of the serializing policy reserved for writes.
 *
 * @category effects
 * @since 0.1.0
 */
export const recallEffects = Effects.make({
  reads: ["memory/**"],
  writes: [],
  mode: "expected",
  onConflict: "fail",
  tier: "sealed"
})

/**
 * Declaration for a memory write.
 *
 * @category flows
 * @since 0.1.0
 */
export const remember = Flow.make({
  name: rememberName,
  description: rememberDescription,
  input: RememberInput,
  output: RememberOutput,
  effects: rememberEffects
})

/**
 * Declaration for advisory memory recall.
 *
 * @category flows
 * @since 0.1.0
 */
export const recall = Flow.make<typeof RecallInput, typeof RecallOutput, never>({
  name: recallName,
  description: recallDescription,
  input: RecallInput,
  output: RecallOutput,
  effects: recallEffects
})

/**
 * Resolves the recall slot to a supplied signature.
 *
 * A slot is filled with the `@smthrs/flow` flow a signature carries, because
 * that is the value a pattern composes into a graph. The signature is what a
 * caller holds, so it is what this takes.
 *
 * @category constructors
 * @since 0.1.0
 */
export const bindRecall = (supplied: Flow.Any): DurableFlow.Any => Pattern.bind(Recall.slot, supplied.flow)

/**
 * Runtime binding for the remember declaration, carrying explicit provenance.
 *
 * Provenance is bound once, when a host builds the handler, and every call the
 * returned function serves records it. Binding time is when a host knows the
 * run coordinates, and keeping the handler itself one-argument is what lets it
 * satisfy the `(input, call)` handler contract `FlowBinding.make` types: a
 * second positional argument there would receive the `Call`, not provenance,
 * and would persist the whole call payload into `provenance_json`.
 *
 * @category handlers
 * @since 0.1.0
 */
export const runRememberWith = (provenance: MemoryStore.Provenance) =>
(
  input: RememberInputType
): Effect.Effect<typeof RememberOutput.Type, MemoryError, MemoryStore.MemoryStore> =>
  Effect.gen(function*() {
    const store = yield* MemoryStore.MemoryStore
    const { namespace } = yield* resolveNamespace(input.bank)
    const reserved = reservedTagIssue(input.tags ?? [])
    if (reserved !== undefined) return yield* Effect.fail(new MemoryError({ code: "invalid_tag", message: reserved }))
    yield* store.putFact({
      namespace,
      key: input.key,
      value: { content: input.text },
      tags: input.tags ?? [],
      ...(input.ttlMs === undefined ? {} : { ttlMs: input.ttlMs }),
      provenance
    })
    return { key: input.key }
  })

/**
 * Runtime binding for the remember declaration.
 *
 * Records no provenance. It takes exactly one argument so a host can hand it
 * straight to `FlowBinding.make({ flow, handler })`. Use
 * {@link runRememberWith} to bind run coordinates.
 *
 * @category handlers
 * @since 0.1.0
 */
export const runRemember = (
  input: RememberInputType
): Effect.Effect<typeof RememberOutput.Type, MemoryError, MemoryStore.MemoryStore> => runRememberWith({})(input)

/**
 * Runtime binding for the selected recall service.
 *
 * @category handlers
 * @since 0.1.0
 */
export const runRecall = (
  input: Recall.Input
): Effect.Effect<Recall.Output, MemoryError, Recall.Recall> =>
  Effect.flatMap(Recall.Recall, (service) => service.recall(input))

const missingPolicy = Effect.fail(
  new MemoryError({
    code: "invalid_namespace",
    message: "memory flow carries no policy; bind a WithMemory.withMemory declaration"
  })
)

const validatePolicyBank = (bank: string, policy: WithMemory.Policy): Effect.Effect<void, MemoryError> =>
  Effect.gen(function*() {
    const { namespace } = yield* resolveNamespace(bank)
    const allowed = yield* Effect.forEach(policy.banks, resolveNamespace)
    if (!allowed.some((entry) => entry.namespace.kind === namespace.kind && entry.namespace.id === namespace.id)) {
      return yield* Effect.fail(
        new MemoryError({
          code: "invalid_namespace",
          message: "memory bank is outside the policy namespace"
        })
      )
    }
  })

/**
 * Applies the memory policy a flow carries to a recall request.
 *
 * Empty banks use the policy namespace; every explicit bank must resolve to
 * that same namespace or the entire request fails before recall runs. The
 * policy budget is a default the caller may override. `recall: "none"`
 * returns no rows before bank validation or any call to the recall service.
 * A flow that carries no policy fails with `invalid_namespace` before recall
 * runs; `runRecall` is the explicitly unscoped call.
 *
 * @category handlers
 * @since 0.1.0
 */
export const runRecallFor = (
  flow: Flow.Any,
  input: Recall.Input
): Effect.Effect<Recall.Output, MemoryError, Recall.Recall> => {
  const policy = WithMemory.policyOf(flow)
  if (policy === undefined) return missingPolicy
  if (policy.recall === "none") return Effect.succeed([])
  return Effect.gen(function*() {
    const banks = input.banks.length > 0 ? input.banks : policy.banks
    for (const bank of banks) yield* validatePolicyBank(bank, policy)
    return yield* runRecall({
      ...input,
      banks,
      maxTokens: input.maxTokens ?? policy.maxTokens
    })
  })
}

/**
 * Applies the memory policy a flow carries to a memory write.
 *
 * An unnamed bank resolves to the policy namespace. An explicit foreign bank
 * fails before the store runs. `retain: "never"` drops the write before bank
 * validation: the caller still receives the key it asked for, and nothing
 * reaches the store. The optional provenance argument is forwarded unchanged.
 * A flow that carries no policy fails with `invalid_namespace` before the store
 * runs; `runRememberWith` is the explicitly unscoped write.
 *
 * The flow comes first so this can never be mistaken for a `FlowBinding`
 * handler; {@link handlersFor} is the one-argument handler a host binds.
 *
 * @category handlers
 * @since 0.1.0
 */
export const runRememberFor = (
  flow: Flow.Any,
  input: RememberInputType,
  provenance: MemoryStore.Provenance = {}
): Effect.Effect<typeof RememberOutput.Type, MemoryError, MemoryStore.MemoryStore> => {
  const policy = WithMemory.policyOf(flow)
  if (policy === undefined) return missingPolicy
  if (policy.retain === "never") return Effect.succeed({ key: input.key })
  return Effect.gen(function*() {
    const bank = input.bank.length > 0 ? input.bank : policy.banks[0]!
    yield* validatePolicyBank(bank, policy)
    return yield* runRememberWith(provenance)({ ...input, bank })
  })
}

/**
 * The runtime handlers one bound memory declaration answers with.
 *
 * Each handler takes exactly one argument, the decoded flow input, so it
 * satisfies the `(input, call)` handler contract `FlowBinding.make` types.
 * Provenance is bound by {@link handlersFor}, not passed per call.
 *
 * @category models
 * @since 0.1.0
 */
export interface Handlers {
  readonly remember: (
    input: RememberInputType
  ) => Effect.Effect<typeof RememberOutput.Type, MemoryError, MemoryStore.MemoryStore>
  readonly recall: (input: Recall.Input) => Effect.Effect<Recall.Output, MemoryError, Recall.Recall>
}

/**
 * Builds the handlers for one memory declaration, reading the memory policy
 * that declaration carries.
 *
 * A host binds the declaration a cell was given, which for delegated work is
 * the policy-carrying copy `withMemory` produced, not the bare declaration
 * exported here. Passing that copy is what makes the namespace, the recall
 * budget, and `recall: "none"` reach the runtime:
 *
 * ```ts
 * const bound = WithMemory.withMemory(Flows.recall, policy)
 * FlowBinding.make({ flow: bound, handler: Flows.handlersFor(bound).recall })
 * ```
 *
 * The optional `provenance` is bound here, once, and recorded on every fact the
 * returned `remember` handler writes. A host that knows its run coordinates
 * passes them at binding time; the handler stays one-argument so it remains a
 * legal `FlowBinding` handler.
 *
 * @category handlers
 * @since 0.1.0
 */
export const handlersFor = (
  flow: Flow.Any,
  provenance: MemoryStore.Provenance = {}
): Handlers => ({
  remember: (input) => runRememberFor(flow, input, provenance),
  recall: (input) => runRecallFor(flow, input)
})

/**
 * What the `remember` flow accepts.
 *
 * @category types
 * @since 0.1.0
 */
export type RememberInputType = typeof RememberInput.Type
