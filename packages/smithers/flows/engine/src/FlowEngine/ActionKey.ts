/**
 * Derives the step identity an action dispatch is recorded under.
 *
 * @private
 * @since 0.1.0
 */

import { firstPath as schemaErrorPath } from "@smthrs/canonical/IssuePath"
import { Action, Flow, StepIdentity } from "@smthrs/flow"
import { DerivedKey, type StoredKey } from "@smthrs/keys"
import type * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import type * as SchemaAST from "effect/SchemaAST"
import * as SchemaRepresentation from "effect/SchemaRepresentation"

/**
 * Extracts the hermetic boundary descriptor from an action's metadata when
 * it is shaped like one (`readSet` digests, `writeSet`, `boundaryMode`).
 *
 * The descriptor is what gates cross-run cacheability, so it must be part of
 * the cache key (issue #25): a changed read-set digest, write set, or
 * boundary mode yields a different key and therefore a cache miss. The key
 * is only half of Skyframe's dirty→recheck→rebuild model, though: these
 * digests are caller-declared, so before a sealed hit is served the store
 * re-measures them through `StepBoundary.prepare` and refuses a hit whose
 * declaration no longer matches the host (issue #90). Metadata of any other
 * shape stays out of the key.
 */
const fileBoundary = (
  metadata: unknown
): Action.FileBoundary | undefined => Option.getOrUndefined(Schema.decodeUnknownOption(Action.FileBoundary)(metadata))

/**
 * The ordinal allocation scope of an action dispatch — its stable
 * declaration identity and optional structural interpreter site (issue #85),
 * derived by the one canonical path in `StepIdentity` (issue #101).
 *
 * The action name always contributes (issue #73), and a declared
 * `idempotencyKey` refines the scope further — the string form and the
 * object form both, through the same canonicalization:
 * two concurrent invocations of one action name with distinguishable
 * inputs declare distinct keys, so each owns its own counter and a replay
 * that reverses fiber-arrival order can never hand one invocation the
 * other's recorded outcome. Refining only the string form left object-keyed
 * actions on the name-only counter and exposed to exactly that swap.
 * A structural interpreter site refines the scope again, so distinct graph
 * nodes calling one declaration each own a counter even without a declared
 * key. Without a site or a declared key, invocations of one name share a
 * counter and remain allocation-ordered — indistinguishable dispatches have
 * no material to order them by. Omitting the site preserves the prior scope
 * encoding byte for byte.
 * A declared implementation version appends its own length-framed `/v:`
 * component; absence appends nothing. Version changes belong to newly planned
 * executions, not upgrades of existing runs.
 *
 * @private
 * @since 0.1.0
 */
export const ordinalScope = (
  action: Action.Any,
  site?: string | undefined
): Effect.Effect<string, Schema.SchemaError, Crypto.Crypto> =>
  StepIdentity.allocationScope({
    kind: "action",
    name: action.name,
    idempotency: action.idempotencyKey,
    site
  }).pipe(Effect.map((scope) =>
    action.implementationVersion === undefined
      ? scope
      : `${scope}/v:${action.implementationVersion.length}:${action.implementationVersion}`
  ))

/**
 * Finds the first rejected field without rendering its value.
 * @private
 * @since 0.1.0
 */
export { firstPath as schemaErrorPath } from "@smthrs/canonical/IssuePath"

/**
 * A caller-declared identity carried material canonicalization rejects
 * (issue #151): the failure surfaces as a recorded typed completion — the
 * same channel `RetryPolicy`'s terminal errors use — naming the offending
 * path, instead of `Result.getOrThrow` killing the fiber with an untyped
 * defect. It is non-retryable by construction: the same declaration derives
 * the same rejection on every attempt, so no retry loop is entered and the
 * body never runs.
 *
 * @private
 * @since 0.1.0
 */
export const uncanonicalKey = (
  actionName: string,
  error: Schema.SchemaError
): Flow.Complete<never, never> =>
  new Flow.Complete({
    exit: Exit.die(
      new Action.UncanonicalIdempotencyKey({
        actionName,
        reason: "canonicalize_failed",
        path: schemaErrorPath(error),
        message: error.message
      })
    )
  })

// Schema ASTs are immutable and shared by separately constructed actions.
// Weak keys keep discarded declarations collectible. Cache only successful
// hashes so a failed Crypto operation can be retried with a working service.
const declarations = new WeakMap<SchemaAST.AST, WeakMap<SchemaAST.AST, StoredKey>>()

/** SHA-256 of the canonical success/error declaration document (issue #120). */
const declarationDigest = Effect.fnUntraced(function*(action: Action.AnyWithProps) {
  const success = action.successSchema.ast
  const error = action.errorSchema.ast
  let errors = declarations.get(success)
  const cached = errors?.get(error)
  if (cached !== undefined) return cached
  const digest = yield* Schema.decodeUnknownEffect(DerivedKey)({
    success: SchemaRepresentation.toJson(SchemaRepresentation.toRepresentation(success)),
    error: SchemaRepresentation.toJson(SchemaRepresentation.toRepresentation(error))
  })
  if (errors === undefined) {
    errors = new WeakMap()
    declarations.set(success, errors)
  }
  errors.set(error, digest)
  return digest
})

const boundaries = new WeakMap<object, { readonly document: string; readonly digest: StoredKey }>()

/** Hash the validated boundary once per distinct metadata document. */
const boundaryDigest = Effect.fnUntraced(function*(metadata: unknown) {
  const boundary = fileBoundary(metadata)
  if (boundary === undefined) return undefined
  // Metadata is caller-owned and may mutate. The decoded JSON snapshot is a
  // cheap equality check, never hash input: DerivedKey still canonicalizes
  // the descriptor, so object property order cannot change its identity.
  const document = JSON.stringify(boundary)
  const cached = boundaries.get(metadata as object)
  if (cached?.document === document) return cached.digest
  const digest = yield* Schema.decodeUnknownEffect(DerivedKey)(boundary)
  boundaries.set(metadata as object, { document, digest })
  return digest
})

/**
 * The persisted key an action dispatch is recorded under: a pure cache key
 * for a keyed sealed action, an ordinal-scoped invocation key otherwise.
 *
 * @private
 * @since 0.1.0
 */
export const actionKey = Effect.fnUntraced(function*(
  action: Action.AnyWithProps,
  executionId: string,
  ordinal: number,
  environment: Action.CacheEnvironment | undefined,
  scope: string
): Effect.fn.Return<StoredKey, Schema.SchemaError, Crypto.Crypto> {
  if (action.tier === "sealed" && action.idempotencyKey !== undefined) {
    // Skyframe's SkyKey is (functionName, argument): a string idempotencyKey
    // is namespaced by the action name so two distinct actions sharing an
    // idempotency string can never collide and replay each other's outcomes,
    // and the declared success/error schemas are folded in so the body is the
    // *compiled declaration* the step-key spec requires — a schema change
    // must miss rather than replay a stale row decoded under the new schema
    // (issue #120). The object form stays caller-owned (no
    // name and no schema material folded in) as the explicit, documented
    // escape hatch for rename- and refactor-stable identity. Note: folding
    // the declaration changes the digest of every persisted string-key row
    // from before this fix; those keys were unsafe to replay across schema
    // changes, so the break is intentional (same precedent as the
    // name-namespacing fix). Compact declaration and boundary SHA-256 keys
    // intentionally change those bytes again under the same precedent. A
    // boundary also re-keys the object form; boundary-free object keys retain
    // their encoding.
    // The two forms build `input` from different material, so the form itself
    // is key input. Without it a caller object that spells the string form's
    // `{action, idempotencyKey, declaration}` encoding — the shape a caller
    // reaches for when copying the engine's own encoding to get a
    // rename-stable key — digests byte-identically to the string form, shares
    // one attempt row and one cache row, and replays the string form's
    // recorded outcome under its own schema. `StepIdentity.allocationScope`
    // already tags the same aliasing `/s:` and `/c:` (StepIdentity.ts:88-89);
    // the persisted key omitted it. The tag is a sibling of `input`, not a
    // member of it, so the caller-owned object stays verbatim and
    // rename-stability is untouched.
    const form = typeof action.idempotencyKey === "string" ? "declared" : "caller"
    const input: Schema.JsonObject = typeof action.idempotencyKey === "string"
      ? {
        action: action.name,
        idempotencyKey: action.idempotencyKey,
        declaration: yield* declarationDigest(action)
      }
      : action.idempotencyKey
    // The cacheability-gating boundary descriptor is cache key input
    // (issue #25): a changed read set, write set, or boundary mode must miss
    // rather than replay a stale cross-run cache entry. Both key forms fold
    // it through this one path — the caller-owned object keeps
    // rename-stability (no name enters the digest) but can never opt out of
    // the read-set material `ActionPersistence` gates cacheability on
    // (issue #57): the descriptor derived from `action.metadata` overrides
    // any caller-supplied `boundary` field.
    const boundary = yield* boundaryDigest(action.metadata)
    // The caller-owned object can carry material canonicalization
    // rejects; the typed `SchemaError` propagates to the dispatch site
    // (issue #151) instead of being discarded through `Result.getOrThrow`.
    // A declared nondeterministic result is also key material. Otherwise a
    // tolerant declaration could consume a strict row (or the reverse) under
    // an identity whose conflict policy was never part of the claim. Omitting
    // it emits no field and preserves every deterministic key byte-for-byte.
    return yield* Schema.decodeUnknownEffect(DerivedKey)({
      kind: environment === undefined ? "run" : "cache",
      form,
      input,
      // This is outside caller-owned input, retaining object-key rename
      // stability while preventing it from masking an explicit version. An
      // absent version emits no field and preserves all legacy key bytes.
      ...(action.implementationVersion === undefined ? {} : { implementationVersion: action.implementationVersion }),
      ...(environment === undefined ? { runId: executionId } : { environment }),
      ...(action.nondeterministic === undefined ? {} : { nondeterministic: action.nondeterministic }),
      ...(boundary === undefined ? {} : { boundary })
    })
  }
  // The ordinal is allocated from a counter scoped to this action's
  // declaration identity and that scope is folded into the key as
  // `parentScope` (issues #73, #85). One per-run counter bumped in
  // fiber-arrival order made the identity of a compensable, irreversible, or
  // unsealed action depend on scheduling: under `Effect.all` with
  // concurrency a replay could hand `chargeCard` the ordinal `sendEmail`
  // recorded and replay the wrong attempt rows, checkpoint, and outcome.
  // Per-identity counters are stable under any interleaving of distinct
  // declarations or structural dispatch sites — distinct names, one name
  // with distinct declared idempotency keys, or distinct interpreter graph
  // nodes; the scope also keeps two identities from sharing the number 1.
  return yield* StepIdentity.invocationKey({
    runId: executionId,
    parentScope: scope,
    ordinal,
    tier: action.tier === "sealed" ? "unsealed" : action.tier
  })
})
