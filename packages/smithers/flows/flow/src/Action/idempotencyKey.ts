// Deep reviewed and polished by a human on 2026-08-10.

/**
 * Derives run-local keys for internal durable operations.
 *
 * @since 0.1.0
 */

import type * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import { FlowInstance } from "../FlowRuntime/FlowInstance.ts"
import { CurrentAttempt } from "./Context.ts"
import * as StepIdentity from "./StepIdentity.ts"

/**
 * Computes a run-local invocation key for an internal durable operation.
 *
 * The caller name separates durable declarations that share a parent scope.
 *
 * @category idempotency
 * @since 0.1.0
 */
export const idempotencyKey: (
  name: string,
  options?: {
    readonly includeAttempt?: boolean | undefined
    readonly parentScope?: string | undefined
  } | undefined
) => Effect.Effect<string, never, FlowInstance | Crypto.Crypto> =
  // Untraced because action-key allocation is on every action attempt.
  Effect.fnUntraced(function*(name: string, options?: {
    readonly includeAttempt?: boolean | undefined
    readonly parentScope?: string | undefined
  }) {
    const instance = yield* FlowInstance
    const attempt = yield* CurrentAttempt
    // Internal durable operations are scoped by the caller's declaration name
    // and declared `parentScope` through the canonical `StepIdentity` derivation (issue
    // #98): a run-global counter numbered concurrent offers in fiber-arrival
    // order, so a replay with a permuted interleaving handed one payload's
    // ordinal to another and its await watched a deferred nothing resolves.
    // With the counter scoped per declared parent, each scope numbers its
    // own allocations deterministically; only allocations *within* one
    // scope remain arrival-ordered — they carry no input that orders them
    // by.
    const parentScope = options?.parentScope !== undefined
      ? options.parentScope
      : options?.includeAttempt
      ? `attempt:${attempt}`
      : undefined
    // String (or absent) idempotency input keeps the derivation total
    // (issue #151): schema decoding preserves typed identity failures while
    // injected cryptography keeps key construction platform-independent.
    const scope = yield* StepIdentity.allocationScope({
      kind: "internal",
      name,
      idempotency: parentScope
    }).pipe(Effect.orDie)
    const ordinal = instance.actionState.nextOrdinal(scope)
    const identityScope = JSON.stringify([name, parentScope ?? null])
    return yield* StepIdentity.invocationKey({
      runId: instance.executionId,
      ordinal,
      tier: "unsealed",
      parentScope: identityScope
    }).pipe(Effect.orDie)
  })
