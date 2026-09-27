/**
 * Defines the provider-neutral remote execution contract.
 *
 * @since 0.1.0
 */

import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import type { Scope } from "effect/Scope"
import type * as Stream from "effect/Stream"
import type { Signal } from "effect/unstable/process/ChildProcess"
import type { ProviderError } from "./ProviderError.ts"

/**
 * A started remote process, in the same three pieces a local child process
 * exposes.
 *
 * @category models
 * @since 0.1.0
 */
export interface RemoteProcess {
  readonly stdout: Stream.Stream<Uint8Array, ProviderError>
  readonly stderr: Stream.Stream<Uint8Array, ProviderError>
  readonly exitCode: Effect.Effect<number, ProviderError>
}

/**
 * Options a rendered command carries to the remote side.
 *
 * @category models
 * @since 0.1.0
 */
export interface RemoteOptions {
  readonly cwd?: string | undefined
  readonly env?: Record<string, string | undefined> | undefined
  /**
   * The command's complete standard input, as bytes.
   *
   * Bounded and whole rather than a stream: a remote session is reached by
   * sending it one command, and the transports beneath the providers either
   * take an input blob up front or take none at all. A provider that cannot
   * deliver it leaves {@link Provider.stdin} unset, and the adapter refuses a
   * command that supplies input instead of dropping the input on the floor.
   */
  readonly stdin?: Uint8Array | undefined
}

/**
 * A configured remote provider.
 *
 * `session` is the stable provider-neutral session key. `open(session)` must
 * acquire the remote session and register its cancellation or close operation
 * as a scope finalizer. `spawn` starts one command in that opened session; its
 * scope is the process's lifetime.
 *
 * `kill` and `ping` are optional because a transport that can only post a
 * command line has neither. A provider that implements them buys two things it
 * cannot otherwise have: one command can be stopped without tearing down the
 * session that runs it, and the session's liveness can be supervised
 * (`SandboxSupervision`). A provider that omits them keeps the narrower
 * contract, and the adapter refuses `kill` instead of pretending to have
 * delivered a signal.
 *
 * @category services
 * @since 0.1.0
 */
export interface Provider {
  readonly session: string
  readonly open: (session: string) => Effect.Effect<void, ProviderError, Scope>
  readonly spawn: (
    command: string,
    options: RemoteOptions
  ) => Effect.Effect<RemoteProcess, ProviderError, Scope>
  /**
   * Sends one signal to a process this provider started. The `RemoteProcess`
   * is the value `spawn` returned, which is the only identity for a remote
   * process that crosses this seam.
   */
  readonly kill?: ((process: RemoteProcess, signal: Signal) => Effect.Effect<void, ProviderError>) | undefined
  /** A cheap round-trip proving the remote session is still alive. */
  readonly ping?: Effect.Effect<void, ProviderError> | undefined
  /**
   * Whether `spawn` delivers {@link RemoteOptions.stdin}. Declared rather
   * than assumed, because a transport that silently ignored a command's
   * input would turn every script fed on standard input into an empty one.
   */
  readonly stdin?: true | undefined
}

/**
 * Remote provider service tag.
 *
 * Provider packages may expose this tag in addition to passing the configured
 * service directly to `layer`.
 *
 * @category services
 * @since 0.1.0
 */
export const Provider: Context.Service<Provider, Provider> = Context.Service(
  "@smthrs/sandbox/RemoteChildProcessSpawner/Provider"
)
