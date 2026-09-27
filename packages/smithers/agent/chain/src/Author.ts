/**
 * The author seat — the one thing the chain needs from a model.
 *
 * The seat is mocked at this boundary, not at the provider wire: the model
 * layer sits beneath a production implementation and no chain code changes
 * when it arrives. The author call carries no tools; the root stays
 * clean (https://chain.smithers.sh/contract/).
 *
 * @since 0.1.0
 */

import { Context, Effect, Layer, Ref, Schema } from "effect"

/**
 * A failure of the author seat: the seat is unreachable, or a scripted mock
 * ran out of outputs.
 *
 * @category errors
 * @since 0.1.0
 * @slop
 */
export class AuthorError extends Schema.TaggedError<AuthorError>()("/chain/AuthorError", {
  code: Schema.Literals(["author_unavailable", "exhausted"]),
  message: Schema.String,
  /**
   * The underlying typed condition when one exists — a model failure code
   * (`rate_limited`, `context_overflow`), a permission tag, or a stop
   * reason (`length`, `content-filter`) — so callers branch on it rather
   * than parsing prose.
   */
  cause: Schema.optional(Schema.String)
}) {}

/**
 * What the harness hands the seat: the stable fixed prefix and the context
 * the previous link's code built — nothing else.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface Input {
  readonly prefix: string
  readonly context: ReadonlyArray<string>
}

/**
 * Normalizes an author call's payload into its context lines: scripts call
 * the author entry with `{ context: [...] }`, and anything else — a script
 * passing garbage stays a journaled observation, never a crash — normalizes
 * to no context.
 * Context elements use string coercion, falling back to JSON text when
 * coercion fails, or `[unprintable context]` if serialization also fails.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const contextOf = (payload: unknown): ReadonlyArray<string> => {
  if (typeof payload === "object" && payload !== null && "context" in payload) {
    const context = (payload as { readonly context: unknown }).context
    if (Array.isArray(context)) {
      return context.map((part) => {
        try {
          return String(part)
        } catch {
          try {
            return JSON.stringify(part) ?? "[unprintable context]"
          } catch {
            return "[unprintable context]"
          }
        }
      })
    }
  }
  return []
}

/**
 * The seat's one operation: turn an author input into the raw model output
 * the chain extracts a script from.
 *
 * @category services
 * @since 0.1.0
 * @slop
 */
export interface Service {
  readonly author: (input: Input) => Effect.Effect<string, AuthorError>
}

/**
 * The author seat service tag.
 *
 * @category services
 * @since 0.1.0
 * @slop
 */
export class Author extends Context.Service<Author, Service>()("/chain/Author") {}

/**
 * Builds a seat from an implementation.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const make = (implementation: Service): Service => Author.of(implementation)

/**
 * A seat whose every operation fails as unavailable, with per-operation
 * overrides — the default a test starts from.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const makeNoop = (overrides: Partial<Service> = {}): Service =>
  make({
    author: Effect.fn("Author.author")(() =>
      Effect.fail(new AuthorError({ code: "author_unavailable", message: "author is unavailable" }))
    ),
    ...overrides
  })

/**
 * The unavailable seat as a layer.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const layerNoop = (overrides: Partial<Service> = {}): Layer.Layer<Author> =>
  Layer.succeed(Author)(makeNoop(overrides))

/**
 * A reactive mock: the test supplies the function from input to raw model
 * output, and can capture the inputs it saw.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const layerFn = (f: (input: Input) => string): Layer.Layer<Author> =>
  Layer.succeed(Author)(
    make({
      author: Effect.fn("Author.author")((input) => Effect.sync(() => f(input)))
    })
  )

/**
 * A scripted mock: pops canned raw outputs in order and fails with
 * `exhausted` when asked for more than it holds.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const layerMock = (outputs: ReadonlyArray<string>): Layer.Layer<Author> =>
  Layer.effect(Author)(
    Effect.gen(function*() {
      const remaining = yield* Ref.make(outputs)
      return make({
        author: Effect.fn("Author.author")(() =>
          Effect.gen(function*() {
            const next = yield* Ref.modify(remaining, (queue) => [queue[0], queue.slice(1)] as const)
            if (next === undefined) {
              return yield* new AuthorError({
                code: "exhausted",
                message: `the mock author ran out of outputs after ${outputs.length}`
              })
            }
            return next
          })
        )
      })
    })
  )
