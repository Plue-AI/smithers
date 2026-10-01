/**
 * Runs a unit of work on a provisioned machine and returns what it changed.
 *
 * @since 1.0.0
 */

import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type { ProviderError } from "../RemoteChildProcessSpawner/ProviderError.ts"
import { type Host, hostContext, type LayerHostOptions } from "./layerHost.ts"
import type { Provider } from "./Provider.ts"
import { capture, type CaptureError, type CheckoutOptions, resolveBase, Work } from "./Work.ts"

/**
 * Which session to hold, where its checkout is, and what its work is
 * measured from.
 *
 * @category models
 * @since 1.0.0
 */
export interface RunOptions extends LayerHostOptions, CheckoutOptions {
  /**
   * The git revision, resolved in the checkout once the session is acquired,
   * that the work is measured from. Default `HEAD`: in a jj-colocated
   * checkout that is the parent of the working-copy change, the commit the
   * provider checked out, never a change made inside the guest. Name a
   * revision the host can fetch.
   */
  readonly base?: string | undefined
}

/**
 * A body's result beside the work its session left in the checkout.
 *
 * @category models
 * @since 1.0.0
 */
export interface Sandboxed<A> {
  readonly result: A
  readonly work: Work
}

/**
 * The schema of {@link Sandboxed} for a body whose result `result` encodes.
 * Use it as an action's success, so the journal records the work with the
 * result and a crash after the machine is gone loses neither.
 *
 * @category models
 * @since 1.0.0
 */
export const Sandboxed = <S extends Schema.Top>(result: S) => Schema.Struct({ result, work: Work })

/**
 * Acquires one machine, runs `body` with the machine's host surface (the
 * services `layerHost` provides), and captures the checkout's work before
 * the machine is released.
 *
 * The base is resolved right after the provider hands the session over, so a
 * provider that refreshes its checkout during acquisition (`jj new
 * main@origin`) is measured from the commit it refreshed to. The capture runs
 * inside the scope that holds the machine, ahead of its teardown: a provider
 * that deletes its machine on release, as Smithers Cloud does, has already
 * yielded the diff. A body that fails fails the run, and no work is captured.
 *
 * @category constructors
 * @since 1.0.0
 */
export const run = <A, E, R>(
  provider: Provider,
  options: RunOptions,
  body: Effect.Effect<A, E, R>
): Effect.Effect<Sandboxed<A>, E | ProviderError | CaptureError, Exclude<R, Host>> =>
  Effect.scoped(Effect.gen(function*() {
    const session = yield* provider.acquire(options.session)
    const base = yield* resolveBase(session, { checkout: options.checkout, revision: options.base })
    const context = yield* hostContext(session, options)
    const result = yield* Effect.provide(body, context)
    const work = yield* capture(session, { checkout: options.checkout, base })
    return { result, work }
  }))
