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
 * owns provisioning and returns a scoped session. Ephemeral providers remove
 * the machine when its scope closes. A retained provider leaves it running and
 * supplies attach-only lookup plus explicit idempotent destruction, so durable
 * jobs can be observed from later scopes without recreating missing machines.
 *
 * What a machine *is* — an image, a memory limit, a network policy — belongs
 * to provider construction, not to this call. A caller that needs two
 * differently shaped machines holds two providers; `acquire` only names which
 * session it wants, so a crash-interrupted run that acquires the same key
 * again lands on the same machine wherever the provider can arrange it.
 *
 * That reattachment is what makes the session key **an exclusive claim, not a
 * shared handle**. Two live holders of one key are served the same machine,
 * and an ephemeral provider's first closing scope tears the machine down
 * under the other. Retained machines end only through explicit destruction.
 * Give independent work distinct keys; share a retained job key only to observe
 * or recover the same fenced worker.
 *
 * @category services
 * @since 0.1.0
 */
export interface Provider {
  readonly acquire: (session: string) => Effect.Effect<Session, ProviderError, Scope>
  /** Scope closure leaves the machine and detached jobs running. */
  readonly retained?: true | undefined
  /** Provider-owned writable job metadata root, outside its checkout. */
  readonly jobDirectory?: string | undefined
  /** Connect only to this existing machine. Never provision or revive it. */
  readonly attach?:
    | ((session: Pick<Session, "id" | "remoteId">) => Effect.Effect<Session, ProviderError, Scope>)
    | undefined
  /** Explicit, idempotent teardown of a retained machine. */
  readonly destroy?: ((session: Pick<Session, "id" | "remoteId">) => Effect.Effect<void, ProviderError>) | undefined
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
