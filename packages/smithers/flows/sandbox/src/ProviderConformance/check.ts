/**
 * Runs the provider conformance suite.
 *
 * @since 0.1.0
 */

import type * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Option from "effect/Option"
import * as Stream from "effect/Stream"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { boundedCheck } from "../internal/boundedCheck.ts"
import { defaultCheckTimeout, elapsed } from "../internal/deadline.ts"
import { describeExit } from "../internal/describeExit.ts"
import { layer } from "../RemoteChildProcessSpawner/layer.ts"
import type { Provider } from "../RemoteChildProcessSpawner/Provider.ts"
import { make as makeHealth } from "../SandboxHealth/make.ts"
import { type Commands, defaultCopiesStdin, defaultStopsWithin } from "./Commands.ts"
import type { Violation } from "./Violation.ts"

/**
 * Runs one check against a fresh session, so a check that leaves a session
 * unusable cannot decide the next one, and under a deadline, so an adapter
 * that never answers is convicted instead of hanging the suite with it.
 *
 * The deadline covers the whole check, session acquisition and stream
 * consumption included: every one of `open`, `spawn`, a stdout stream that
 * never ends, `ping`, and `kill` can hang, and only the wait after a
 * successful kill was ever bounded.
 */
const inSession = <A>(
  provider: Provider,
  deadline: Duration.Input,
  effect: Effect.Effect<A, unknown, ChildProcessSpawner>
): Effect.Effect<Exit.Exit<A, unknown>> => boundedCheck(Effect.provide(effect, layer(provider)), deadline)

const writesItsOutput = (
  provider: Provider,
  commands: Commands,
  deadline: Duration.Input
): Effect.Effect<Violation | undefined> =>
  Effect.map(
    inSession(
      provider,
      deadline,
      Effect.flatMap(ChildProcessSpawner, (spawner) =>
        spawner.string(ChildProcess.make(commands.writes, { shell: commands.shell ?? false })))
    ),
    (exit) =>
      Exit.isSuccess(exit) && exit.value === commands.output ? undefined : {
        check: "writes-its-output",
        expected: `stdout ${JSON.stringify(commands.output)}`,
        actual: describeExit(exit)
      }
  )

const reportsANonzeroExit = (
  provider: Provider,
  commands: Commands,
  deadline: Duration.Input
): Effect.Effect<Violation | undefined> =>
  Effect.map(
    inSession(
      provider,
      deadline,
      Effect.flatMap(
        ChildProcessSpawner,
        (spawner) => spawner.exitCode(ChildProcess.make(commands.fails, { shell: commands.shell ?? false }))
      )
    ),
    (exit) =>
      Exit.isSuccess(exit) && exit.value === commands.failureCode ? undefined : {
        check: "reports-a-nonzero-exit",
        expected: `exit code ${commands.failureCode}`,
        actual: describeExit(exit)
      }
  )

const answersAPing = (
  provider: Provider,
  deadline: Duration.Input
): Effect.Effect<Violation | undefined> =>
  Effect.map(
    inSession(provider, deadline, makeHealth(provider).check),
    (exit) =>
      Exit.isSuccess(exit) && exit.value._tag === "Healthy" ? undefined : {
        check: "answers-a-ping",
        expected: "a healthy probe while the session is open",
        actual: describeExit(exit)
      }
  )

const signalsARunningCommand = (
  provider: Provider,
  commands: Commands,
  deadline: Duration.Input
): Effect.Effect<Violation | undefined> =>
  Effect.map(
    inSession(
      provider,
      deadline,
      Effect.scoped(Effect.gen(function*() {
        const spawner = yield* ChildProcessSpawner
        const handle = yield* spawner.spawn(ChildProcess.make(commands.runs, { shell: commands.shell ?? false }))
        yield* handle.kill()
        // A `kill` that RETURNS is not a `kill` that happened. An adapter whose
        // signal goes nowhere satisfies the type and leaves every cancelled
        // action's process running in the sandbox, which is the failure this
        // whole seam exists to prevent, so the process has to be observed
        // stopping.
        //
        // HOW it stopped is not the subject. A provider that reports a
        // signalled process as a failed `exitCode` is as conforming as one that
        // reports a status, so the exit is captured rather than awaited.
        const stopped = yield* Effect.raceFirst(
          Effect.map(Effect.exit(handle.exitCode), Option.some),
          Effect.as(elapsed(commands.stopsWithin ?? defaultStopsWithin), Option.none())
        )
        if (Option.isNone(stopped) || commands.survivor === undefined) return { stopped, survived: false }
        // The handle is the wrapper shell, and a shell that dies while its
        // child lives on satisfies everything above. The second look asks the
        // machine itself whether the command's work is still there.
        const survivor = yield* spawner.exitCode(
          ChildProcess.make(commands.survivor, { shell: commands.shell ?? false })
        )
        return { stopped, survived: survivor === 0 }
      }))
    ),
    (exit) =>
      Exit.isSuccess(exit) && Option.isSome(exit.value.stopped) && !exit.value.survived ? undefined : {
        check: "signals-a-running-command",
        expected: "a declared `kill` stops a live process and everything it started",
        actual: Exit.isSuccess(exit) && Option.isNone(exit.value.stopped)
          ? "the command was still running after the signal"
          : Exit.isSuccess(exit) && exit.value.survived
          ? "the command's work was still running after its handle reported it stopped"
          : describeExit(exit)
      }
  )

/** The text the stdin check sends and expects back, newline-free so a pty transport cannot reframe it. */
const stdinFixture = "sandbox-conformance-stdin"

const deliversStandardInput = (
  provider: Provider,
  commands: Commands,
  deadline: Duration.Input
): Effect.Effect<Violation | undefined> =>
  Effect.map(
    inSession(
      provider,
      deadline,
      Effect.flatMap(ChildProcessSpawner, (spawner) =>
        spawner.string(
          ChildProcess.make(commands.copiesStdin ?? defaultCopiesStdin, {
            shell: commands.shell ?? false,
            stdin: Stream.make(new TextEncoder().encode(stdinFixture))
          })
        ))
    ),
    (exit) =>
      // `includes`, not equality: a transport whose channel is a pseudo-terminal
      // echoes the input alongside the command's own output, which is a
      // documented property of that channel rather than a lost input.
      Exit.isSuccess(exit) && exit.value.includes(stdinFixture) ? undefined : {
        check: "delivers-standard-input",
        expected: `stdout containing ${JSON.stringify(stdinFixture)}, the bytes given as stdin`,
        actual: describeExit(exit)
      }
  )

/**
 * Bounds how long the suite waits on a provider that does not answer.
 *
 * @category models
 * @since 0.1.0
 */
export interface CheckOptions {
  /**
   * How long any single check may take, session acquisition included, before
   * it is convicted as hung. Default 10 seconds. Raise it explicitly for slow
   * machine provisioning and size the test budget for the whole suite.
   */
  readonly checkTimeout?: Duration.Input | undefined
}

/**
 * Checks one provider against the `Provider` contract.
 *
 * A plugin that ships a provider runs this in its own test suite and asserts
 * the result is empty. The suite is the contract in executable form: what the
 * prose in `RemoteChildProcessSpawner` promises callers, stated as behavior an
 * adapter has to produce. It runs the checks through the real adapter layer,
 * because a provider that satisfies the interface but not the adapter is of no
 * use to a caller.
 *
 * The optional capabilities are checked only when the provider declares them.
 * A provider without `ping` is not asked to answer one, a provider without
 * `kill` is not asked to signal, and a provider that does not declare `stdin`
 * is not asked to deliver any: those are documented absences, not defects. A
 * provider that DOES declare one is held to it, `stdin` included — the flag is
 * what makes the adapter hand the bytes over, so a suite that took it at its
 * word would pass an adapter that sets it and drops them.
 *
 * Every check runs under {@link CheckOptions.checkTimeout} on the platform
 * timer rather than the ambient `Clock`, so an adapter that never answers
 * yields a named violation instead of a hang, under a frozen test clock too.
 *
 * @category constructors
 * @since 0.1.0
 */
export const check = (
  provider: Provider,
  commands: Commands,
  options: CheckOptions = {}
): Effect.Effect<ReadonlyArray<Violation>> =>
  Effect.gen(function*() {
    const deadline = options.checkTimeout ?? defaultCheckTimeout
    const found: Array<Violation | undefined> = [
      yield* writesItsOutput(provider, commands, deadline),
      yield* reportsANonzeroExit(provider, commands, deadline),
      ...provider.stdin === true ? [yield* deliversStandardInput(provider, commands, deadline)] : [],
      ...provider.ping === undefined ? [] : [yield* answersAPing(provider, deadline)],
      ...provider.kill === undefined ? [] : [yield* signalsARunningCommand(provider, commands, deadline)]
    ]
    return found.filter((violation): violation is Violation => violation !== undefined)
  })
