/**
 * The memory door: `remember` and `recall` as catalog entries.
 *
 * Binds the memory package's own shipped contract — its input/output
 * schemas and `runRemember`/`runRecall` handlers — under the flows'
 * declared names. Payloads and results are held to those schemas, with
 * the actual parse failure quoted in every refusal; store failures carry
 * the memory package's stable error code as the call's `cause`
 * (https://chain.smithers.sh/contract/).
 *
 * Composition note: hosts that also mount the memory flows through the
 * registry must bind them there OR here, not both — a catalog holding two
 * `remember` declarations discloses one and runs the other, and journals
 * written under the registry's digest will refuse to resume against this
 * door's digest.
 *
 * @since 0.1.0
 */

import * as Digest from "@smthrs/core/Digest"
import * as Flows from "@smthrs/memory/Flows"
import * as MemoryStore from "@smthrs/memory/MemoryStore"
import * as Recall from "@smthrs/memory/Recall"
import { Effect, Layer, Schema } from "effect"
import * as Catalog from "./Catalog.ts"
import { failureCode } from "./internal/failureCode.ts"
import * as JsonBoundary from "./JsonBoundary.ts"

// A store failure discloses only the memory package's own shipped code; a
// tag would leak an implementation name the flows never promised.
const codeOf = (error: unknown): string => failureCode(error, ["code"])

interface Contract {
  readonly name: string
  readonly description: string
  readonly input: Schema.Top
  readonly output: Schema.Top
  readonly effects: { readonly [key: string]: unknown }
}

/**
 * The digest of a memory entry's shipped contract — name, description,
 * effect declaration, and the input/output schema shapes — so a
 * memory-package upgrade that changes the contract re-keys every call
 * that names it instead of replaying stale results.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const contractDigest = (contract: Contract): string =>
  Digest.digest(Digest.canonical({
    description: contract.description,
    effects: { ...contract.effects },
    input: Schema.toJsonSchemaDocument(contract.input, { onExcessProperty: "error" }),
    name: contract.name,
    output: Schema.toJsonSchemaDocument(contract.output, { onExcessProperty: "error" })
  }))

const entryOf = <A>(
  contract: Contract,
  run: (input: A) => Effect.Effect<unknown, { readonly code: string; readonly message: string }>,
  decode: (payload: unknown) => Effect.Effect<A, unknown>
): Catalog.Entry => ({
  description: contract.description,
  digest: contractDigest(contract),
  handler: (payload) =>
    Effect.gen(function*() {
      const input = yield* decode(payload).pipe(
        Effect.mapError((error) =>
          new Catalog.CallError({
            cause: "invalid_input",
            message: `"${contract.name}" rejected its input: ${JsonBoundary.failureMessage(error)}`,
            name: contract.name
          })
        )
      )
      const result = yield* run(input).pipe(
        Effect.mapError((error) =>
          new Catalog.CallError({
            cause: codeOf(error),
            message: `"${contract.name}" failed [${codeOf(error)}]: ${JsonBoundary.failureMessage(error)}`,
            name: contract.name
          })
        )
      )
      // The shipped Output schema is the journal contract: a result that
      // does not decode never settles.
      return yield* Schema.decodeUnknownEffect(
        contract.output as unknown as Schema.Schema<unknown> & { readonly "DecodingServices": never }
      )(result).pipe(
        Effect.mapError((error) =>
          new Catalog.CallError({
            cause: "invalid_output",
            message: `"${contract.name}" produced output outside its contract: ${JsonBoundary.failureMessage(error)}`,
            name: contract.name
          })
        )
      )
    }),
  name: contract.name
})

/**
 * Builds the two memory entries over the ambient store and recall
 * services — exactly those two services are captured, so call-time
 * provisions of anything else are never shadowed.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const make: Effect.Effect<
  ReadonlyArray<Catalog.Entry>,
  never,
  MemoryStore.MemoryStore | Recall.Recall
> = Effect.gen(function*() {
  const store = yield* MemoryStore.MemoryStore
  const recall = yield* Recall.Recall
  const decodeRemember = Schema.decodeUnknownEffect(Flows.RememberInput)
  const decodeRecall = Schema.decodeUnknownEffect(Flows.RecallInput)
  return [
    entryOf(
      {
        description: Flows.rememberDescription,
        effects: { ...Flows.rememberEffects },
        input: Flows.RememberInput,
        name: Flows.rememberName,
        output: Flows.RememberOutput
      },
      (input: Flows.RememberInputType) =>
        Flows.runRemember(input).pipe(Effect.provideService(MemoryStore.MemoryStore, store)),
      decodeRemember
    ),
    entryOf(
      {
        description: Flows.recallDescription,
        effects: { ...Flows.recallEffects },
        input: Flows.RecallInput,
        name: Flows.recallName,
        output: Flows.RecallOutput
      },
      (input: Recall.Input) => Flows.runRecall(input).pipe(Effect.provideService(Recall.Recall, recall)),
      decodeRecall
    )
  ]
})

/**
 * The memory entries as a whole catalog of their own — composed with the
 * system entries, keeping the sealed realm's promise.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const layer: Layer.Layer<
  Catalog.Catalog,
  never,
  MemoryStore.MemoryStore | Recall.Recall
> = Layer.effect(Catalog.Catalog)(
  Effect.map(make, (entries) => Catalog.make(Catalog.withSystem(entries)))
)
