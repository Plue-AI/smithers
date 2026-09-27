// Deep reviewed and polished by a human on 2026-08-10.

/**
 * Derives allocation scopes and run-local invocation keys.
 *
 * Ordinal step identity has four components: the kind of durable operation
 * (an action dispatch or an internal engine operation), the stable
 * declaration identity (the action name, or a fixed internal label), an
 * optional explicit idempotency component — a caller-declared string or
 * object — and an optional structural dispatch site. Every ordinal counter
 * in the engine is keyed by the scope this module derives, and the scope is
 * also folded into the persisted key as `parentScope`, so two dispatches with
 * distinct declarations or structural sites can never swap ordinals under a
 * permuted fiber interleaving (issues #73, #85, #98, #101).
 *
 * The derivation is injective: distinct `(kind, name, idempotency, site)`
 * inputs always produce distinct scopes. The name and site are
 * length-prefixed so their contents cannot splice across component
 * separators, and both idempotency forms are canonicalized to a fixed-width
 * digest under distinct tags so a string can never alias the object identity
 * whose digest it happens to spell.
 *
 * Governing contract: `docs/concepts/execution-identity.md`.
 *
 * @since 0.1.0
 */

import { Sha256 } from "@smthrs/crypto"
import { DerivedKey, type StoredKey } from "@smthrs/keys"
import * as Context from "effect/Context"
import type * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"

/**
 * Validates the engine-owned coordinates of a run-local invocation.
 *
 * @private
 * @since 0.1.0
 */
const Invocation = Schema.Struct({
  runId: Schema.NonEmptyString,
  parentScope: Schema.optionalKey(Schema.NonEmptyString),
  ordinal: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  tier: Schema.Literals(["compensable", "irreversible", "unsealed"])
})

/**
 * The interpreter graph site currently dispatching an action.
 *
 * A site is a replay-stable structural address of an `ActionCall` node. It is
 * never derived from fiber arrival order and is never a diagnostic label. It
 * is durable key material: changing it deliberately changes ordinal scopes
 * and invocation keys. Handler-driven dispatches leave the service absent.
 *
 * @since 0.1.0
 * @category services
 */
export class DispatchSite extends Context.Service<DispatchSite, string>()(
  "@smthrs/flow/Action/DispatchSite"
) {}

/**
 * What one dispatch tells the node that drove it.
 *
 * `outcome` is the fact the walk above cannot see on its own: whether the
 * dispatch ran its body or was served from a durable record. `stepKeyDigest`
 * is the identity the rest of the engine addresses that dispatch by — the
 * digest `flows.engine.attempt-started` carries and `flows_attempts` is keyed
 * on — and `attempt` is the durable attempt it ran as. Both are optional
 * because a runtime that keeps no attempt rows has neither, and a node with
 * no digest says so rather than inventing one.
 *
 * @since 1.0.0
 * @category models
 */
export interface DispatchOutcome {
  readonly outcome: "executed" | "replayed"
  readonly stepKeyDigest?: string | undefined
  readonly attempt?: number | undefined
}

/**
 * Where the dispatches of one interpreter node report what happened to them.
 *
 * An engine knows facts the walk above it cannot see: whether a dispatch ran
 * its body or was served from a durable record, which step key it ran under,
 * and which durable attempt it was. Without the first a node that replayed
 * every one of its dispatches is indistinguishable from one that did the work
 * again. Without the other two a node's evidence cannot be joined to the
 * attempt records the engine wrote, because an attempt record carries a step
 * key digest and no node id while a node record carried no digest at all. The
 * interpreter installs one of these per node and reads the report back when
 * the node settles.
 *
 * Absent by default. A dispatch outside an interpreted graph — a handler
 * calling an action directly — reports to nobody, and reporting stays a
 * side channel rather than a change to what `actionExecute` returns.
 *
 * @since 1.0.0
 * @category services
 */
export class DispatchReport extends Context.Service<DispatchReport, {
  readonly dispatched: (dispatch: DispatchOutcome) => Effect.Effect<void>
}>()("@smthrs/flow/Action/DispatchReport") {}

/**
 * Reports one dispatch to the node that drove it, when a node drove it.
 *
 * @since 1.0.0
 * @category constructors
 */
export const reportDispatch = (dispatch: DispatchOutcome): Effect.Effect<void> =>
  Effect.flatMap(
    Effect.serviceOption(DispatchReport),
    (report) => Option.isNone(report) ? Effect.void : report.value.dispatched(dispatch)
  )

/**
 * The declaration material an allocation scope is derived from.
 *
 * @since 0.1.0
 * @category models
 */
export interface AllocationIdentity {
  /**
   * `"action"` for user-declared action dispatches, `"internal"` for
   * engine-owned durable operations (queue offers, deferred tokens). The two
   * kinds own disjoint counter namespaces.
   */
  readonly kind: "action" | "internal"
  /**
   * The stable declaration identity: an action's declared name, or a fixed
   * label for an internal operation family. Diagnostic names must not be
   * passed here unless they are part of identity.
   */
  readonly name: string
  /**
   * The explicit idempotency component. A declared string and a declared
   * cache key input both refine the scope — two concurrent invocations of
   * one name with distinguishable inputs each own their own counter, so a
   * replay that reverses fiber-arrival order can never hand one invocation
   * the other's recorded outcome. Absent, invocations of one name share a
   * counter and remain allocation-ordered — indistinguishable declarations
   * have no material to order them by.
   */
  readonly idempotency?: string | Schema.JsonObject | undefined
  /**
   * The replay-stable structural address of the interpreter graph node that
   * drives this dispatch. Absent for handler-driven dispatches, preserving
   * their existing allocation scopes byte for byte.
   */
  readonly site?: string | undefined
}

/**
 * Derives the ordinal allocation scope of a durable operation.
 *
 * The scope keys the operation's ordinal counter and is folded into its
 * persisted invocation key as `parentScope`, so identity is stable
 * under any interleaving of distinct declarations.
 *
 * Injectivity: the name is length-prefixed (`<kind>/<length>:<name>`), so a
 * name containing `/s:` or `/c:` material cannot collide with a keyed form
 * of a shorter name, and the idempotency component is a fixed-shape tagged
 * digest appended after the name. Both idempotency forms canonicalize under
 * distinct one-character tags so a string can never alias the object identity
 * whose digest it happens to spell. A present site is appended as
 * `/g:<length>:<site>`; its length prefix prevents site contents from
 * aliasing another component or splicing across a future suffix. An absent
 * site appends nothing, preserving the prior encoding exactly.
 *
 * The object form is caller-owned material, so it can carry values canonical
 * serialization rejects (`Date`, `undefined`, class instances, `Redacted`);
 * the failure surfaces as the typed `SchemaError` (issue #151), never
 * as a thrown defect. The string and absent forms
 * are total — the first overload keeps their error channel `never`.
 *
 * @since 0.1.0
 * @category derivations
 */
export const allocationScope = (
  identity: AllocationIdentity
): Effect.Effect<string, Schema.SchemaError, Crypto.Crypto> =>
  Effect.gen(function*() {
    let scope = `${identity.kind}/${identity.name.length}:${identity.name}`
    if (typeof identity.idempotency === "string") {
      const digest = yield* Schema.decodeUnknownEffect(Sha256)(identity.idempotency)
      scope = `${scope}/s:${digest}`
    } else if (identity.idempotency !== undefined) {
      const key = yield* Schema.decodeUnknownEffect(DerivedKey)({ kind: "declaration", input: identity.idempotency })
      scope = `${scope}/c:${key}`
    }
    if (identity.site === undefined) return scope
    return `${scope}/g:${identity.site.length}:${identity.site}`
  })

/**
 * Derives an invocation key from engine-generated input.
 *
 * The input is engine-generated by construction — a finite counter
 * ordinal, a literal tier, and plain string scopes — so canonical
 * serialization cannot reject it. A failure here is an engine defect, and it
 * surfaces as the typed `SchemaError` itself (issue #151) rather than
 * being discarded through `Result.getOrThrow`.
 *
 * @since 0.1.0
 * @category derivations
 */
export const invocationKey = (input: {
  readonly runId: string
  readonly parentScope?: string | undefined
  readonly ordinal: number
  readonly tier: "unsealed" | "compensable" | "irreversible"
}): Effect.Effect<StoredKey, Schema.SchemaError, Crypto.Crypto> =>
  Schema.decodeUnknownEffect(Invocation)(input).pipe(
    Effect.flatMap((validated) => Schema.decodeUnknownEffect(DerivedKey)({ kind: "invocation", ...validated }))
  )
