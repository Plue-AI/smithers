/**
 * Defines the sandbox lifecycle contract.
 *
 * @since 0.1.0
 */

import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import type { Scope } from "effect/Scope"
import type { ProviderError } from "../RemoteChildProcessSpawner/ProviderError.ts"
import type { Session } from "./Session.ts"

/**
 * A configured sandbox provider: something that can turn a session key into a
 * held machine.
 *
 * This is the lifecycle half the spawner-level
 * `RemoteChildProcessSpawner.Provider` deliberately does not have. That
 * contract assumes its machine exists and carries commands to it; this one
 * owns provisioning — create or reattach, and destroy — and hands back a
 * {@link Session} whose teardown is registered as a finalizer of the acquiring
 * scope. Closing the scope is the only way a session ends, which is the same
 * rule every other held resource in this repository follows: no `destroy`
 * method to forget, no `AbortSignal` to thread.
 *
 * What a machine *is* — an image, a memory limit, a network policy — belongs
 * to provider construction, not to this call. A caller that needs two
 * differently shaped machines holds two providers; `acquire` only names which
 * session it wants, so a crash-interrupted run that acquires the same key
 * again lands on the same machine wherever the provider can arrange it.
 *
 * That reattachment is what makes the session key **an exclusive claim, not a
 * shared handle**. Two live holders of one key are served the same machine,
 * and the first of them to close its scope tears that machine down under the
 * other. Give concurrent work distinct keys; reuse a key to resume, which is
 * the case reattachment exists for.
 *
 * @category services
 * @since 0.1.0
 */
export interface Provider {
  readonly acquire: (session: string) => Effect.Effect<Session, ProviderError, Scope>
}

/**
 * Sandbox provider service tag.
 *
 * Provider packages may expose this tag in addition to passing the configured
 * service directly to consumers, the way the spawner-level provider does.
 *
 * @category services
 * @since 0.1.0
 */
export const Provider: Context.Service<Provider, Provider> = Context.Service(
  "@smthrs/sandbox/Sandbox/Provider"
)
