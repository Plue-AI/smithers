/**
 * A deterministic panel deliberation pattern.
 *
 * A panel asks several flows the same question under different instructions
 * and hands one moderator every answer. {@link make} declares that topology,
 * {@link run} performs it.
 *
 * @see https://smithers.sh/docs/concepts/ownership
 * @see https://smithers.sh/docs/reference/api/patterns#identity-and-ownership
 *
 * @since 0.1.0
 */

import * as Flow from "@smthrs/flow/Flow"
import * as Node from "@smthrs/plan/Node"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Bounded from "./Bounded.ts"
import * as Compose from "./internal/Compose.ts"
import type { Member } from "./internal/Member.ts"
import { call as callMember } from "./internal/Member.ts"
import { OpaqueInput } from "./internal/Payload.ts"
import { PatternError } from "./PatternError.ts"

/**
 * Configuration for {@link make}.
 *
 * Panelists are held in a record so their declared keys are stable shard
 * identities. The moderator receives `{ input, opinions }`, where `opinions`
 * preserves those keys and declaration order.
 *
 * A panelist named in `roles` is called with `{ input, role }` instead of the
 * bare input, and the role is part of that call's identity. `concurrency`
 * bounds how many panelists the declaration lets run at once; without it the
 * panel fans out in one join.
 *
 * @category models
 * @since 0.1.0
 */
export interface MakeOptions<R = never> {
  readonly name?: string | undefined
  readonly description?: string | undefined
  readonly panelists: Readonly<Record<string, Member<R>>>
  readonly moderator: Member<R>
  readonly roles?: Readonly<Record<string, string>> | undefined
  readonly concurrency?: number | undefined
}

/**
 * Operational callbacks for {@link run}.
 *
 * @category models
 * @since 0.1.0
 */
export interface RuntimeOptions<I, A, E, R, B, E2, R2> {
  readonly panelists: Readonly<Record<string, (input: I) => Effect.Effect<A, E, R>>>
  readonly moderator: (
    input: { readonly input: I; readonly opinions: Readonly<Record<string, A>> }
  ) => Effect.Effect<B, E2, R2>
  readonly concurrency?: number | undefined
}

const payload = (input: unknown, role: string | undefined): unknown => role === undefined ? input : { input, role }

/**
 * The declared form of a panel.
 *
 * @category models
 * @since 0.1.0
 */
export type PanelFlow<R = never> = Flow.Flow<
  string,
  typeof OpaqueInput,
  typeof Schema.Unknown,
  typeof Schema.Unknown,
  R
>

// The refusal is minted once, as a value. `make` throws it, because a
// declaration is built eagerly and a broken one is a programming error. `run`
// FAILS with it, because `PatternError` is in its declared error channel and a
// caller composing it must be able to claim the refusal with `Effect.catchTag`.
// A thrown refusal inside `Effect.suspend` would be a defect no handler claims.
// An absent concurrency is no bound at all, which is what `Node.all` already
// gives, so only a declared one is checked.
const widthRefusal = (concurrency: number | undefined): PatternError | undefined =>
  concurrency === undefined ? undefined : Compose.concurrencyRefusal("Panel", concurrency)

/**
 * Fans out every independent panelist call and then invokes the moderator.
 *
 * Without `concurrency`, `Node.all` gives child work structured-concurrency
 * ownership: interruption of the parent interrupts every outstanding
 * panelist, and one panelist failure fails the whole join. With
 * `concurrency`, the same members are batched by `Bounded.all`, so the plan
 * states how many panelists can be in flight.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = <R = never>(options: MakeOptions<R>): PanelFlow<R> => {
  const panelists = Object.entries(options.panelists)
  if (panelists.length === 0) {
    throw new PatternError({
      code: "invalid_decorator",
      message: "Panel requires at least one panelist"
    })
  }
  // The body runs when the graph builds, later than this call, so it reads
  // these snapshots and never the caller's options again. Roles are copied
  // as own entries, so a prototype-shaped panelist name never reads a role
  // off `Object.prototype`.
  const roles = options.roles === undefined ? undefined : new Map(Object.entries(options.roles))
  const moderator = options.moderator
  const concurrency = options.concurrency
  const width = widthRefusal(concurrency)
  if (width !== undefined) throw width
  for (const name of roles?.keys() ?? []) {
    if (!Object.hasOwn(options.panelists, name)) {
      throw new PatternError({
        code: "invalid_decorator",
        message: `Panel declares a role for the unknown panelist "${name}"`
      })
    }
  }
  const names = panelists.map(([name]) => name)
  const material = {
    panelists: names,
    ...(roles === undefined ? {} : { roles: names.map((name) => roles.get(name) ?? null) }),
    ...(concurrency === undefined ? {} : { concurrency })
  }
  const { name, description } = Compose.label("panel", { panelists: names }, options)
  const body = ({ input }: { readonly input: unknown }): Node.Node<unknown, unknown, R> => {
    const nodes = Object.fromEntries(
      panelists.map(([name, panelist]) => [name, callMember(panelist, payload(input, roles?.get(name)))])
    ) as Record<string, Node.Any>
    // The opinions record is a planned reference until the run produces it, so
    // the moderator is handed the reference rather than a spread of symbols.
    return Node.bindPlanned(
      concurrency === undefined ? Node.all(nodes) : Bounded.all(nodes, { concurrency }),
      Node.capture({ panelists: names }, (opinions) => callMember(moderator, { input, opinions }))
    )
  }
  return Flow.make(name, {
    ...(description === undefined ? {} : { description }),
    payload: OpaqueInput,
    success: Schema.Unknown,
    error: Schema.Unknown,
    body: Node.capture(material, body)
  })
}

/**
 * Runs every panelist against the same input and hands the moderator one
 * record of opinions keyed by panelist name.
 *
 * `concurrency` bounds how many panelists run at once; without it they all
 * start together. Keys follow declaration order whatever order the panelists
 * settle in, so a moderator never sees a race in its payload.
 *
 * @category combinators
 * @since 0.1.0
 */
export const run = <I, A, E, R, B, E2, R2>(
  input: I,
  options: RuntimeOptions<I, A, E, R, B, E2, R2>
): Effect.Effect<B, E | E2 | PatternError, R | R2> => {
  // Snapshots taken at the call, ahead of the suspend: the effect may run
  // later, and a caller's edit to the record or the option object in between
  // must not reach it.
  const panelists = Object.entries(options.panelists)
  const moderator = options.moderator
  const concurrency = options.concurrency
  return Effect.suspend((): Effect.Effect<B, E | E2 | PatternError, R | R2> => {
    if (panelists.length === 0) {
      return Effect.fail(
        new PatternError({ code: "invalid_decorator", message: "Panel requires at least one panelist" })
      )
    }
    const width = widthRefusal(concurrency)
    if (width !== undefined) return Effect.fail(width)
    return Effect.flatMap(
      Effect.forEach(
        panelists,
        ([name, panelist]) => Effect.map(panelist(input), (opinion) => [name, opinion] as const),
        { concurrency: concurrency ?? "unbounded" }
      ),
      (opinions) => moderator({ input, opinions: Object.fromEntries(opinions) })
    )
  })
}
