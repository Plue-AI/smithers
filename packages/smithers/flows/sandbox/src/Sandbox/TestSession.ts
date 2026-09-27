/**
 * Constructs deterministic sandbox providers for tests.
 *
 * @since 0.1.0
 */

import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"
import type { RemoteProcess } from "../RemoteChildProcessSpawner/Provider.ts"
import { ProviderError } from "../RemoteChildProcessSpawner/ProviderError.ts"
import type { TestScript } from "../RemoteChildProcessSpawner/TestScript.ts"
import type { Session } from "./Session.ts"
import type { TestSessionProvider } from "./TestSessionProvider.ts"
import type { TestSessionState } from "./TestSessionState.ts"

const encoder = new TextEncoder()

const scriptedOutput = (text: string | undefined): Stream.Stream<Uint8Array, ProviderError> =>
  text === undefined || text === "" ? Stream.empty : Stream.fromArray([encoder.encode(text)])

/**
 * What a scripted session is built from.
 *
 * Named rather than inline, so a consumer can write a fixture factory whose
 * argument type is spellable — the sibling models `TestSessionState` and
 * `TestSessionProvider` already are.
 *
 * @category models
 * @since 0.1.0
 */
export interface TestSessionOptions {
  readonly session?: string | undefined
  readonly remoteId?: string | undefined
  readonly workdir?: string | undefined
  /** Initial guest files, path to contents. */
  readonly files?: Readonly<Record<string, string | Uint8Array>> | undefined
  /** Scripted responses keyed by the exact command line. */
  readonly scripts?: Readonly<Record<string, TestScript>> | undefined
  /** Resolves a script for a command the record does not name. */
  readonly script?: ((command: string) => TestScript | undefined) | undefined
  readonly acquireFailure?: ProviderError | undefined
  /** Gives every session a `ping`, backed by this effect. */
  readonly ping?: Effect.Effect<void, ProviderError> | undefined
}

/**
 * Constructs a deterministic scripted session provider.
 *
 * @category testing
 * @since 0.1.0
 */
const makeTestSession = (options: TestSessionOptions = {}): TestSessionProvider => {
  const state: TestSessionState = {
    acquired: [],
    commands: [],
    inputs: [],
    files: new Map(
      Object.entries(options.files ?? {}).map(([path, content]) => [
        path,
        typeof content === "string" ? encoder.encode(content) : content.slice()
      ])
    ),
    released: 0
  }
  const resolve = (command: string): TestScript =>
    options.scripts?.[command] ?? options.script?.(command) ??
      { stderr: `command not found: ${command}\n`, exitCode: 127 }
  const session: Session = {
    id: options.session ?? "test-session",
    remoteId: options.remoteId ?? "test-remote",
    workdir: options.workdir ?? "/sandbox",
    spawn: Effect.fnUntraced(function*(command: string, spawnOptions) {
      state.commands.push(command)
      state.inputs.push(spawnOptions.stdin)
      const script = resolve(command)
      if (script.failure !== undefined) return yield* Effect.fail(script.failure)
      const process: RemoteProcess = {
        stdout: scriptedOutput(script.stdout),
        stderr: scriptedOutput(script.stderr),
        exitCode: Effect.succeed(script.exitCode ?? 0)
      }
      return process
    }),
    readFile: (path) =>
      Effect.suspend(() => {
        const content = state.files.get(path)
        return content === undefined
          ? Effect.fail(
            new ProviderError({ code: "not_found", message: `the sandbox holds nothing at ${path}` })
          )
          : Effect.succeed(content.slice())
      }),
    writeFile: (path, content) =>
      Effect.sync(() => {
        state.files.set(path, content.slice())
      }),
    ...options.ping === undefined ? {} : { ping: options.ping }
  }
  return {
    state,
    acquire: (key) =>
      options.acquireFailure === undefined
        ? Effect.acquireRelease(
          Effect.sync(() => {
            state.acquired.push(key)
            return session
          }),
          () =>
            Effect.sync(() => {
              state.released += 1
            })
        )
        : Effect.fail(options.acquireFailure)
  }
}

/**
 * Deterministic scripted sandbox constructor for projection and consumer
 * tests: an in-memory guest tree, command lines answered from a script table
 * or resolver, and observable acquire and release counts.
 *
 * @category testing
 * @since 0.1.0
 */
export const TestSession = {
  make: makeTestSession
} as const
