/**
 * The catalog of entries a script may call — gate 3 is membership in it.
 *
 * Every effect goes through this one door: a call names a visible entry,
 * pinned by its declaration digest, and settles as a journaled event
 * (https://chain.smithers.sh/contract/).
 *
 * @since 0.1.0
 */

import * as Digest from "@smthrs/core/Digest"
import { Clock, Context, type Effect, Layer, Random, Schema } from "effect"
import type * as CallKey from "./CallKey.ts"

/**
 * A call that reached its entry and failed there. The chain journals it as
 * an observation rather than crashing the run. The message is journaled
 * verbatim and shown to the model on the next link, so a handler must keep
 * credentials and private data out of it.
 *
 * @category errors
 * @since 0.1.0
 * @slop
 */
export class CallError extends Schema.TaggedError<CallError>()("/chain/CallError", {
  name: Schema.String,
  message: Schema.String,
  /**
   * The underlying stable code when the failing subsystem has one (a
   * memory error code, a permission verdict), so callers branch on it
   * rather than parsing prose.
   */
  cause: Schema.optional(Schema.String)
}) {}

/**
 * Where a call sits in its chain — handed to every handler so entries
 * that spawn scoped work (sub-chains) can derive deterministic child
 * identities from the slot.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface CallSlot {
  readonly chain: string
  readonly link: number
  readonly ordinal: number
  /** The durable replay identity of this invocation. */
  readonly key?: CallKey.CallKey
  /** Aborted on Stop for entries that settle before interruption returns. */
  readonly signal?: AbortSignal | undefined
}

/**
 * One entry a script may call: the name it is reached by, the description
 * the model reads, and the handler that settles it.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface Entry {
  readonly name: string
  readonly description: string
  /** Signal cancellation, then await the handler and its journal receipt before returning. */
  readonly settleOnInterrupt?: boolean | undefined
  readonly handler: (payload: unknown, slot?: CallSlot) => Effect.Effect<unknown, CallError>
  /**
   * An optional declaration digest overriding the default name+description
   * digest — richer catalogs (the registry) pin their full declaration.
   */
  readonly digest?: string | undefined
  /**
   * The capabilities this entry claims, as `action:resource` strings the
   * `Authorize` seam evaluates per call — the only policy input the seam
   * receives. Undeclared is conservatively the broadest claim — it
   * asks under rules, never silently passes.
   */
  readonly capabilities?: ReadonlyArray<string> | undefined
}

/**
 * The visible entries and the lookup gate 3 decides membership with.
 *
 * @category services
 * @since 0.1.0
 * @slop
 */
export interface Service {
  readonly entries: ReadonlyArray<Entry>
  readonly lookup: (name: string) => Entry | undefined
}

/**
 * The catalog service tag.
 *
 * @category services
 * @since 0.1.0
 * @slop
 */
export class Catalog extends Context.Service<Catalog, Service>()("/chain/Catalog") {}

/**
 * The declaration digest that pins an entry's identity into every call key
 * that names it.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const entryDigest = (entry: Entry): string =>
  // An empty override falls back too: every call key pins a non-empty
  // digest, whatever the host supplied. Declared capabilities are part
  // of the declaration: narrowing or widening a claim re-keys the calls
  // settled under it.
  entry.digest !== undefined && entry.digest !== ""
    ? entry.digest
    : Digest.digest(Digest.canonical({
      capabilities: entry.capabilities ?? null,
      description: entry.description,
      name: entry.name
    }))

/**
 * One entry copied out of the caller's object.
 *
 * The outer array is not enough. `Prompt.catalogBlock` reads `entries` and
 * gate 3 reads `lookup`, and both must keep answering about the SAME
 * declaration: renaming a caller-owned entry after construction would leave
 * the block advertising one name while the index still answers to another.
 * Only the declaration is copied — the handler is the entry's behavior and is
 * held by reference.
 */
const snapshotEntry = (entry: Entry): Entry =>
  Object.freeze({
    capabilities: entry.capabilities === undefined ? undefined : Object.freeze([...entry.capabilities]),
    description: entry.description,
    digest: entry.digest,
    handler: entry.handler,
    settleOnInterrupt: entry.settleOnInterrupt,
    name: entry.name
  })

/**
 * Builds a catalog over the given entries, indexed by name.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const make = (entries: ReadonlyArray<Entry>): Service => {
  // One frozen snapshot backs BOTH the advertised list and the dispatch
  // index. Retaining the caller's array would let a later push or pop move
  // `Prompt.catalogBlock` (which reads `entries`) away from `lookup` (which
  // gate 3 decides membership with), so the model would be shown a call the
  // chain refuses, or refused a call the model was never shown.
  const snapshot: ReadonlyArray<Entry> = Object.freeze(entries.map(snapshotEntry))
  const byName = new Map(snapshot.map((entry) => [entry.name, entry]))
  return Catalog.of({
    entries: snapshot,
    lookup: (name) => byName.get(name)
  })
}

/**
 * The system entries every sealed realm relies on: time and randomness as
 * ordinary journaled calls, so replay is deterministic with no special
 * identity (https://chain.smithers.sh/contract/).
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const system: ReadonlyArray<Entry> = [
  {
    // The empty claim set is deliberate: these are the harness's own
    // journaled reads, claiming no external authority, so the envelope
    // seam has nothing to evaluate and every ruleset admits them.
    capabilities: [],
    description: "The current wall-clock time in epoch milliseconds, journaled for replay",
    handler: () => Clock.currentTimeMillis,
    name: "sys/now"
  },
  {
    capabilities: [],
    description: "A uniform random number in [0, 1), journaled for replay",
    handler: () => Random.next,
    name: "sys/random"
  }
]

/**
 * Appends the system entries to a host's own — the composition every
 * sealed-realm host wants, since the QuickJS prelude deletes `Date` and
 * `Math.random` on the promise that `sys/now` and `sys/random` exist.
 *
 * The system entries come LAST because {@link make} indexes last-wins:
 * nothing a host passes can shadow `sys/now` or `sys/random` with an
 * unjournaled clock or RNG, which is what replay determinism rests on.
 * Every composition in the package goes through here, so the ordering has
 * one implementation rather than one per host.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const withSystem = (entries: ReadonlyArray<Entry>): ReadonlyArray<Entry> => [...entries, ...system]

/**
 * The empty catalog: every call misses gate 3.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const makeNoop = (): Service => make([])

/**
 * A catalog over the given entries, as a layer.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const layer = (entries: ReadonlyArray<Entry>): Layer.Layer<Catalog> => Layer.succeed(Catalog)(make(entries))

/**
 * The empty catalog as a layer.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const layerNoop: Layer.Layer<Catalog> = Layer.succeed(Catalog)(makeNoop())
