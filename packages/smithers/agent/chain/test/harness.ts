import { Effect, Layer, type Scope } from "effect"
import type * as Author from "../src/Author.ts"
import type * as Authorize from "../src/Authorize.ts"
import * as Catalog from "../src/Catalog.ts"
import * as Chain from "../src/Chain.ts"
import type * as Event from "../src/Event.ts"
import * as Journal from "../src/Journal.ts"
import type * as Outcome from "../src/Outcome.ts"
import * as ScriptRunner from "../src/ScriptRunner.ts"
import type * as Steering from "../src/Steering.ts"

/** Wraps script lines in the one fenced flow block the shape gate expects. */
export const flow = (...lines: ReadonlyArray<string>): string => ["```flow", ...lines, "```"].join("\n")

export interface RunOptions {
  readonly author: Layer.Layer<Author.Author>
  readonly chain?: string
  readonly goal?: string
  readonly entries?: ReadonlyArray<Catalog.Entry>
  /**
   * A catalog layer may itself need the base services (SubChains); `layersOf`
   * provides them from the very same memoized instances the chain runs on.
   */
  readonly catalog?: Layer.Layer<
    Catalog.Catalog,
    never,
    Journal.Journal | Author.Author | ScriptRunner.ScriptRunner
  >
  readonly initial?: ReadonlyArray<Event.Event>
  readonly runner?: Layer.Layer<ScriptRunner.ScriptRunner, ScriptRunner.ScriptFailure>
  readonly steering?: Layer.Layer<Steering.Steering>
  readonly authorize?: Layer.Layer<Authorize.Authorize>
  readonly envelope?: unknown
  readonly prefix?: string
  readonly maxLinks?: number
  readonly maxCallsPerLink?: number
}

export interface RunResult {
  readonly outcome: Outcome.RunResult
  readonly events: ReadonlyArray<Event.Event>
}

const layersOf = (options: RunOptions) => {
  if (options.catalog !== undefined && options.entries !== undefined) {
    throw new Error("runChain takes catalog or entries, not both")
  }
  // The base layers are shared by reference: a catalog layer that itself
  // needs the journal/author/runner (SubChains) receives the very same
  // memoized instances the chain runs on.
  const base = Layer.mergeAll(
    Journal.layerMemory(options.initial ?? []),
    options.author,
    options.runner ?? ScriptRunner.layerInProcess,
    ...(options.steering === undefined ? [] : [options.steering]),
    ...(options.authorize === undefined ? [] : [options.authorize])
  )
  const catalog = (options.catalog ?? Catalog.layer(options.entries ?? [])).pipe(Layer.provide(base))
  return Layer.mergeAll(base, catalog)
}

const chainOptions = (options: RunOptions): Chain.Options => ({
  chain: options.chain,
  goal: options.goal ?? "fix TODOs",
  envelope: options.envelope as Chain.Options["envelope"],
  prefix: options.prefix,
  maxLinks: options.maxLinks,
  maxCallsPerLink: options.maxCallsPerLink
})

/**
 * Runs one body against a layer. The body may need only what the layer
 * provides, so a service nobody provides fails tsc instead of at run time.
 */
export const runOn = <ROut, LE, A, E>(
  layer: Layer.Layer<ROut, LE>,
  body: Effect.Effect<A, E, NoInfer<ROut> | Scope.Scope>
): Promise<A> => Effect.runPromise(Effect.scoped(Effect.provide(body, layer)))

/** Runs a chain over an in-memory journal and returns outcome plus journal. */
export const runChain = (options: RunOptions): Promise<RunResult> =>
  runOn(
    layersOf(options),
    Effect.gen(function*() {
      const outcome = yield* Chain.run(chainOptions(options))
      const journal = yield* Journal.Journal
      const events = yield* journal.read
      return { events, outcome }
    })
  )

/** Runs a chain expected to fail, returning its typed error. */
export const failChain = (options: RunOptions): Promise<unknown> =>
  runOn(layersOf(options), Effect.flip(Chain.run(chainOptions(options))))

/** A catalog entry that counts its executions — the "zero effects" probe. */
export const countingEntry = (
  name: string,
  result: unknown
): { readonly entry: Catalog.Entry; readonly count: () => number } => {
  let calls = 0
  return {
    count: () => calls,
    entry: {
      description: `test entry ${name}`,
      handler: () =>
        Effect.sync(() => {
          calls = calls + 1
          return result
        }),
      name
    }
  }
}

/** A catalog entry that always fails with a typed call error. */
export const failingEntry = (name: string, message: string): Catalog.Entry => ({
  description: `failing entry ${name}`,
  handler: () => Effect.fail(new Catalog.CallError({ message, name })),
  name
})
