/**
 * Adapts local child-process handles to the remote-process shape.
 *
 * @since 0.1.0
 */

import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"
import type { ChildProcessHandle } from "effect/unstable/process/ChildProcessSpawner"
import type { RemoteProcess } from "../RemoteChildProcessSpawner/Provider.ts"
import { ProviderError } from "../RemoteChildProcessSpawner/ProviderError.ts"
import { concat } from "./concat.ts"

/**
 * Wraps a failure cause in the provider vocabulary. A cause that is already a
 * `ProviderError` is the more precise answer and passes through unchanged.
 *
 * @category constructors
 * @since 0.1.0
 */
export const providerFailure = (code: ProviderError["code"], message: string) => (cause: unknown): ProviderError =>
  cause instanceof ProviderError ? cause : new ProviderError({ code, message, cause })

/**
 * Presents a locally spawned handle as a remote process. The in-repository
 * providers run their transport locally — a shell, a container CLI — so the
 * three pieces a remote process has are the local handle's, with failures
 * restated in the provider vocabulary.
 *
 * @category constructors
 * @since 0.1.0
 */
export const remoteProcessOf = (handle: ChildProcessHandle, command: string): RemoteProcess => ({
  stdout: Stream.mapError(handle.stdout, providerFailure("unknown", `\`${command}\`: stdout failed`)),
  stderr: Stream.mapError(handle.stderr, providerFailure("unknown", `\`${command}\`: stderr failed`)),
  exitCode: Effect.mapError(
    handle.exitCode,
    providerFailure("unknown", `\`${command}\`: exit could not be observed`)
  )
})

/**
 * One gathered local command run: concatenated stdout bytes, decoded stderr,
 * and the exit code, consumed concurrently so output larger than a pipe
 * cannot deadlock the exit observation.
 *
 * @category models
 * @since 0.1.0
 */
export interface GatheredRun {
  readonly stdout: Uint8Array
  readonly stderr: string
  readonly code: number
}

/**
 * Runs one local command to completion and gathers its outputs.
 *
 * @category constructors
 * @since 0.1.0
 */
export const gather = (
  handle: ChildProcessHandle,
  command: string
): Effect.Effect<GatheredRun, ProviderError> =>
  Effect.all(
    [
      Stream.runCollect(handle.stdout),
      Stream.mkString(Stream.decodeText(handle.stderr)),
      handle.exitCode
    ],
    { concurrency: "unbounded" }
  ).pipe(
    Effect.map(([stdout, stderr, code]) => ({ stdout: concat(stdout), stderr, code })),
    Effect.mapError(providerFailure("unknown", `\`${command}\` could not be observed to completion`))
  )
