/**
 * Host-owned approval authority, separate from principal attribution and from
 * the permissions a workflow receives after approval.
 *
 * @since 1.0.0
 */

import { Effect, Schema } from "effect"
import { InvalidInput, type PersistenceError, Unauthorized } from "./ControlError.ts"
import { type ApprovalTarget, GrantScope, type Principal } from "./ControlSchema.ts"

/**
 * An approval decision whose caller has already been authenticated by its host.
 * @category models
 * @since 1.0.0
 */
export interface Request {
  readonly principal: Principal
  readonly target: ApprovalTarget
  readonly decision: "approved" | "denied"
  readonly scope: GrantScope
}

/**
 * A trusted host policy. Both refusals and unavailable policy storage fail
 * closed. Implementations must be bounded and safe inside a write transaction;
 * they must not recursively invoke Control or perform the gated work.
 * @category services
 * @since 1.0.0
 */
export interface Service {
  readonly authorize: (request: Request) => Effect.Effect<void, Unauthorized | PersistenceError>
}

const IdentityPart = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024))

/**
 * An explicit delegation to one authenticated identity, not everyone whose
 * kind resembles a role. Scopes are exact, not implicitly hierarchical. A
 * delegation may approve only its listed scopes and may deny either target
 * kind it names (denial installs no grant).
 * Delegation is reusable: `scopes: ["once"]` permits once-scoped grants, not
 * one lifetime decision. Use a host policy for expiry or one-use delegation.
 * @category schemas
 * @since 1.0.0
 */
export const Delegation = Schema.Struct({
  principal: Schema.Struct({ id: IdentityPart, kind: IdentityPart }),
  scopes: Schema.Array(GrantScope).check(Schema.isMinLength(1), Schema.isMaxLength(3)),
  targets: Schema.Array(Schema.Literals(["Plan", "Node"])).check(Schema.isMinLength(1), Schema.isMaxLength(2))
})

/**
 * One explicit host-owned approval delegation.
 * @category models
 * @since 1.0.0
 */
export type Delegation = typeof Delegation.Type

const identity = (principal: Pick<Principal, "id" | "kind">): string => JSON.stringify([principal.id, principal.kind])

const compile = (delegations: ReadonlyArray<Delegation>): Service => {
  // Separate target keys preserve each delegation's target/scope pairing;
  // unioning both dimensions independently would grant a cross product.
  const permissions = new Map<string, Set<GrantScope>>()
  for (const delegation of delegations) {
    for (const target of delegation.targets) {
      const key = JSON.stringify([identity(delegation.principal), target])
      const scopes = permissions.get(key) ?? new Set<GrantScope>()
      for (const scope of delegation.scopes) scopes.add(scope)
      permissions.set(key, scopes)
    }
  }
  return Object.freeze({
    authorize: (request: Request) =>
      Effect.suspend(() => {
        const scopes = permissions.get(JSON.stringify([identity(request.principal), request.target._tag]))
        return scopes !== undefined &&
            (request.decision === "denied" || (request.decision === "approved" && scopes.has(request.scope)))
          ? Effect.void
          : Effect.fail(new Unauthorized({ message: "This caller has no authority to make this approval decision" }))
      })
  })
}

/**
 * Builds an immutable policy from explicit host configuration. Invalid
 * configuration is refused without including its contents in the error.
 * The caller's arrays and objects are not retained after acquisition.
 * @category constructors
 * @since 1.0.0
 */
export const make = (
  delegations: ReadonlyArray<Delegation>
): Effect.Effect<Service, InvalidInput> =>
  Schema.decodeUnknownEffect(Schema.Array(Delegation).check(Schema.isMaxLength(1024)))(delegations, {
    onExcessProperty: "error"
  }).pipe(
    Effect.mapError(() => new InvalidInput({ issue: "Invalid approval-authority delegation configuration" })),
    Effect.map(compile)
  )

/**
 * Default trusted-local policy. Only the local operator identity is an
 * approver. A custom actor, gateway identity, or agent needs explicit host
 * delegation; setting Principal.kind is not itself an authorization. The
 * in-memory test adapter's `memory`/`test` identity is delegated only by that
 * adapter's own default policy, never here.
 * @category policies
 * @since 1.0.0
 */
export const local: Service = compile([
  { principal: { id: "local", kind: "operator" }, scopes: ["once", "run", "remembered"], targets: ["Plan", "Node"] }
])
