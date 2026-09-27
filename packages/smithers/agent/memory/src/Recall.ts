/**
 * The replaceable memory-recall seam.
 *
 * Recall is both a flow-valued injection slot and an Effect runtime service.
 *
 * @see https://memory.smithers.sh/reference/api/
 * @see https://smithers.sh/docs/reference/api/patterns
 *
 * @since 0.1.0
 */

import * as Pattern from "@smthrs/patterns/Pattern"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { compareText } from "./internal/Canonical.ts"
import * as Bank from "./internal/ResolveNamespace.ts"
import type * as MemoryError from "./MemoryError.ts"
import * as MemoryStore from "./MemoryStore.ts"
import * as Namespace from "./Namespace.ts"

/**
 * Maximum banks accepted by one model-facing recall request.
 *
 * @category constants
 * @since 0.1.0
 */
export const MAX_RECALL_BANKS = 16

/**
 * Maximum code-unit length of one recall bank name.
 *
 * @category constants
 * @since 0.1.0
 */
export const MAX_RECALL_BANK_NAME_LENGTH = 128

/**
 * Maximum UTF-8 byte length of a recall query.
 *
 * @category constants
 * @since 0.1.0
 */
export const MAX_RECALL_QUERY_BYTES = 16 * 1_024

/**
 * Maximum conservative byte budget accepted as `maxTokens`.
 *
 * @category constants
 * @since 0.1.0
 */
export const MAX_RECALL_TOKENS = 64 * 1_024

/**
 * Maximum tag groups accepted by one model-facing recall request.
 *
 * Every group is evaluated against every candidate row by each binding, so the
 * per-group depth and node bounds `Namespace.TagGroup` enforces only bound one
 * group. Without a cap on the array a single decoded request multiplies that
 * budget without limit, so the list is bounded here as well.
 *
 * @category constants
 * @since 0.1.0
 */
export const MAX_RECALL_TAG_GROUPS = 16

/**
 * Byte budget applied when a recall request omits `maxTokens`.
 *
 * @category constants
 * @since 0.1.0
 */
export const DEFAULT_MAX_TOKENS = 2048

/**
 * Rows a row-counting binding keeps for a byte budget: one per 256 bytes, at
 * least one.
 *
 * @category constructors
 * @since 0.1.0
 */
export const requestedRows = (maxTokens: number = DEFAULT_MAX_TOKENS): number => Math.max(1, Math.ceil(maxTokens / 256))

const encoder = new TextEncoder()
/**
 * A bank name recall accepts: non-empty and at most
 * {@link MAX_RECALL_BANK_NAME_LENGTH} code units.
 *
 * @category schemas
 * @since 1.0.0
 */
export const BankName = Schema.NonEmptyString.pipe(Schema.check(Schema.isMaxLength(MAX_RECALL_BANK_NAME_LENGTH)))
const Query = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter((query) =>
      encoder.encode(query).byteLength <= MAX_RECALL_QUERY_BYTES
        ? undefined
        : `recall query exceeds ${MAX_RECALL_QUERY_BYTES} UTF-8 bytes`
    )
  )
)

/**
 * A recall budget: an integer UTF-8 byte ceiling from 0 to
 * {@link MAX_RECALL_TOKENS}.
 *
 * @category schemas
 * @since 1.0.0
 */
export const MaxTokens = Schema.Int.pipe(
  Schema.check(Schema.isGreaterThanOrEqualTo(0)),
  Schema.check(Schema.isLessThanOrEqualTo(MAX_RECALL_TOKENS))
)

/**
 * A boolean tag predicate accepted by every recall implementation.
 *
 * @category models
 * @since 0.1.0
 */
export type TagGroup = Namespace.TagGroup

/**
 * Input to the recall slot.
 *
 * @category models
 * @since 0.1.0
 */
export const Input = Schema.Struct({
  banks: Schema.Array(BankName).pipe(Schema.check(Schema.isMaxLength(MAX_RECALL_BANKS))),
  query: Query,
  tagGroups: Schema.optional(
    Schema.Array(Namespace.TagGroup).pipe(Schema.check(Schema.isMaxLength(MAX_RECALL_TAG_GROUPS)))
  ),
  maxTokens: Schema.optional(MaxTokens),
  budget: Schema.optional(Schema.Literals(["low", "mid", "high"]))
})

/**
 * Input to the recall slot.
 *
 * @category models
 * @since 0.1.0
 */
export type Input = typeof Input.Type

/**
 * One recalled memory row.
 *
 * @category models
 * @since 0.1.0
 */
export const Result = Schema.Struct({
  bank: Schema.String,
  key: Schema.String,
  text: Schema.String,
  score: Schema.Number,
  updatedAtMs: Schema.optional(Schema.Number)
})

/**
 * One recalled memory row.
 *
 * @category models
 * @since 0.1.0
 */
export type Result = typeof Result.Type

/**
 * Output of the recall slot.
 *
 * @category models
 * @since 0.1.0
 */
export const Output = Schema.Array(Result)

/**
 * Output of the recall slot.
 *
 * @category models
 * @since 0.1.0
 */
export type Output = typeof Output.Type

/**
 * Flow-valued recall injection slot.
 *
 * @category slots
 * @since 0.1.0
 */
export const slot = Pattern.slot({ input: Input, output: Output })

/**
 * Runtime recall implementation.
 *
 * @category services
 * @since 0.1.0
 */
export interface Service {
  readonly recall: (input: Input) => Effect.Effect<Output, MemoryError.MemoryError>
}

/**
 * Context tag for the replaceable recall implementation.
 *
 * @category services
 * @since 0.1.0
 */
export class Recall extends Context.Service<Recall, Service>()("flows/memory/Recall") {}

const serializedByteLength = (result: Result): number => encoder.encode(JSON.stringify(result)).byteLength

// `JSON.stringify(rows)` is `[` + rows joined by `,` + `]`, so the serialized
// size of a selection is the two brackets plus every row's own serialization
// plus one separator per row after the first. Tracking that sum lets the cap
// serialize each row exactly once instead of re-serializing the selection for
// every candidate.
const ARRAY_BRACKETS_BYTES = 2
const SEPARATOR_BYTES = 1

/**
 * Applies Smithers' conservative UTF-8 byte cap: complete rows are selected
 * greedily, then only the first overflowing row is truncated by binary search.
 * `maxTokens` is treated as a byte ceiling because UTF-8 bytes conservatively
 * bound token count without selecting a model-specific tokenizer.
 *
 * @category constructors
 * @since 0.1.0
 */
export const capRecallResults = (results: ReadonlyArray<Result>, maxTokens = DEFAULT_MAX_TOKENS): Array<Result> => {
  const normalized = results.filter((result) => result.text.length > 0)
  const byteBudget = Math.max(0, Math.floor(maxTokens))
  const selected: Array<Result> = []
  let usedBytes = ARRAY_BRACKETS_BYTES
  for (const result of normalized) {
    const separatorBytes = selected.length > 0 ? SEPARATOR_BYTES : 0
    const rowBudget = byteBudget - usedBytes - separatorBytes
    const rowBytes = serializedByteLength(result)
    if (rowBytes <= rowBudget) {
      selected.push(result)
      usedBytes += separatorBytes + rowBytes
      continue
    }
    const characters = [...result.text]
    let low = 0
    let high = characters.length
    while (low < high) {
      const middle = Math.ceil((low + high) / 2)
      const candidate = { ...result, text: characters.slice(0, middle).join("") }
      if (serializedByteLength(candidate) <= rowBudget) {
        low = middle
      } else {
        high = middle - 1
      }
    }
    if (low > 0) {
      selected.push({ ...result, text: characters.slice(0, low).join("") })
    }
    break
  }
  return selected
}

/**
 * The ranking every binding sorts by: score descending, newest update, key,
 * then bank, so the order never depends on the request's bank order.
 *
 * @category constructors
 * @since 0.1.0
 */
export const compareResults = (left: Result, right: Result): number =>
  right.score - left.score || (right.updatedAtMs ?? 0) - (left.updatedAtMs ?? 0) ||
  compareText(left.key, right.key) || compareText(left.bank, right.bank)

/**
 * Provides a store-backed recall binding, capturing the MemoryStore once so
 * the service method needs no environment.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerFrom = (
  run: (input: Input) => Effect.Effect<Output, MemoryError.MemoryError, MemoryStore.MemoryStore>
): Layer.Layer<Recall, never, MemoryStore.MemoryStore> =>
  Layer.effect(
    Recall,
    Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      return Recall.of({ recall: (input) => run(input).pipe(Effect.provideService(MemoryStore.MemoryStore, store)) })
    })
  )

/**
 * Provides a recall service.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = (implementation: Service): Layer.Layer<Recall> => Layer.succeed(Recall)(Recall.of(implementation))

/**
 * Constructs a recall service that returns no rows.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeNoop = (): Service => Recall.of({ recall: () => Effect.succeed([]) })

/**
 * Provides the empty recall implementation.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerNoop: Layer.Layer<Recall> = Layer.succeed(Recall)(makeNoop())

/**
 * Maps a structured namespace back to the public bank name recall accepts.
 * `namespaceForBank` is its inverse for every prefixed bank.
 *
 * @category constructors
 * @since 0.1.0
 */
export const bankForNamespace: (namespace: Namespace.Namespace) => string = Bank.bankForNamespace

/**
 * Performs the unvalidated syntactic inverse of {@link bankForNamespace}.
 * Prefixes preserve explicit lifetimes; an unprefixed bank is flow-local.
 * The returned `id` is intentionally typed as `string`, not
 * `Namespace.NonEmptyString`. Use `Bank.parse` at every I/O boundary.
 *
 * @category constructors
 * @since 0.1.0
 */
export const namespaceForBank: (bank: string) => { readonly kind: Namespace.Kind; readonly id: string } =
  Bank.namespaceForBank
