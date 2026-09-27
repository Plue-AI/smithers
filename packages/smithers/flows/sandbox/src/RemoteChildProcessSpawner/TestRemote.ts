/**
 * Constructs deterministic remote providers for tests.
 *
 * @since 0.1.0
 */

import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"
import { Provider, type RemoteProcess } from "./Provider.ts"
import type { ProviderError } from "./ProviderError.ts"
import type { TestRemoteProvider } from "./TestRemoteProvider.ts"
import type { TestRemoteState } from "./TestRemoteState.ts"
import type { TestScript } from "./TestScript.ts"

const encoder = new TextEncoder()

const scriptedOutput = (text: string | undefined): Stream.Stream<Uint8Array, ProviderError> =>
  text === undefined || text === "" ? Stream.empty : Stream.fromArray([encoder.encode(text)])

/**
 * What a scripted provider is built from.
 *
 * Named rather than inline, so a consumer can write a fixture factory whose
 * argument type is spellable — the sibling models `TestRemoteState` and
 * `TestRemoteProvider` already are.
 *
 * @category models
 * @since 0.1.0
 */
export interface TestRemoteOptions {
  readonly session?: string | undefined
  readonly scripts?: Readonly<Record<string, TestScript>> | undefined
  readonly openFailure?: ProviderError | undefined
  /** Gives the provider a `kill`, which records every signal it is asked for. */
  readonly kill?: boolean | undefined
  /** Makes the recorded `kill` fail with this error instead of succeeding. */
  readonly killFailure?: ProviderError | undefined
  /**
   * Makes the recorded `kill` succeed WITHOUT stopping anything: the adapter
   * that models a provider whose signal goes nowhere.
   */
  readonly killIsNoop?: boolean | undefined
  /** Gives the provider a `ping`, backed by this effect. */
  readonly ping?: Effect.Effect<void, ProviderError> | undefined
  /** Declares the provider able to deliver standard input, which it records. */
  readonly stdin?: boolean | undefined
}

/**
 * Constructs a deterministic scripted provider.
 *
 * @category testing
 * @since 0.1.0
 */
const makeTestRemote = (options: TestRemoteOptions = {}): TestRemoteProvider => {
  const state: TestRemoteState = {
    openedSessions: [],
    commands: [],
    inputs: [],
    kills: [],
    cancellations: 0
  }
  const started = new Map<RemoteProcess, string>()
  /** The exit a pending process is waiting for, so a kill can settle it. */
  const pending = new Map<RemoteProcess, Deferred.Deferred<number, ProviderError>>()

  const script = (command: string): TestScript =>
    options.scripts?.[command] ?? { stderr: `command not found: ${command}\n`, exitCode: 127 }

  const provider: TestRemoteProvider = {
    state,
    session: options.session ?? "test-session",
    open: (session) =>
      options.openFailure === undefined
        ? Effect.acquireRelease(
          Effect.sync(() => {
            state.openedSessions.push(session)
          }),
          () =>
            Effect.sync(() => {
              state.cancellations += 1
            })
        )
        : Effect.fail(options.openFailure),
    spawn: Effect.fnUntraced(function*(command: string, spawnOptions) {
      state.commands.push(command)
      state.inputs.push(spawnOptions.stdin)
      const current = script(command)
      if (current.failure !== undefined) return yield* Effect.fail(current.failure)
      if (current.pending === true) {
        // A pending command runs until something stops it, and a `kill` that
        // works is what stops it. Modelling that as `Effect.never` would make
        // every provider look like one whose signal goes nowhere.
        const exit = yield* Deferred.make<number, ProviderError>()
        const process: RemoteProcess = {
          stdout: Stream.never,
          stderr: Stream.never,
          exitCode: Deferred.await(exit)
        }
        started.set(process, command)
        pending.set(process, exit)
        return process
      }
      const process: RemoteProcess = {
        stdout: scriptedOutput(current.stdout),
        stderr: scriptedOutput(current.stderr),
        exitCode: Effect.succeed(current.exitCode ?? 0)
      }
      started.set(process, command)
      return process
    }),
    ...options.kill === true || options.killFailure !== undefined
      ? {
        kill: (process: RemoteProcess, signal: string) =>
          Effect.suspend(() => {
            /* v8 ignore next -- `spawn` records every process it returns and a `RemoteProcess` has no other source, so the fallback only discharges the optional a map read carries */
            state.kills.push({ command: started.get(process) ?? "unknown command", signal })
            if (options.killFailure !== undefined) return Effect.fail(options.killFailure)
            const exit = pending.get(process)
            return exit === undefined || options.killIsNoop === true
              ? Effect.void
              : Effect.asVoid(Deferred.succeed(exit, 143))
          })
      }
      : {},
    ...options.ping === undefined ? {} : { ping: options.ping },
    ...options.stdin === true ? { stdin: true as const } : {}
  }
  return Provider.of(provider) as TestRemoteProvider
}

/**
 * Deterministic scripted provider constructor for adapter and cancellation
 * tests.
 *
 * @category testing
 * @since 0.1.0
 */
export const TestRemote = {
  make: makeTestRemote
} as const
