/**
 * Builds a supervised spawner over a remote provider.
 *
 * @since 0.1.0
 */

import * as CommandLine from "@smthrs/kernel/CommandLine"
import * as Deferred from "effect/Deferred"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as PlatformError from "effect/PlatformError"
import * as Ref from "effect/Ref"
import * as Schedule from "effect/Schedule"
import * as Scope from "effect/Scope"
import * as Semaphore from "effect/Semaphore"
import * as Stream from "effect/Stream"
import {
  type ChildProcessHandle,
  type ChildProcessSpawner,
  make as makeSpawner,
  makeHandle
} from "effect/unstable/process/ChildProcessSpawner"
import { elapsed } from "../internal/deadline.ts"
import { platformFailure } from "../internal/platformReason.ts"
import { makeOpened } from "../RemoteChildProcessSpawner/layer.ts"
import type { Provider } from "../RemoteChildProcessSpawner/Provider.ts"
import type { HealthState } from "../SandboxHealth/HealthState.ts"
import { make as makeHealth } from "../SandboxHealth/make.ts"
import type { Options } from "./Options.ts"
import { loggingReporter } from "./Reporter.ts"
import { SandboxUnhealthy } from "./SandboxUnhealthy.ts"

const MODULE = "ChildProcess"

/**
 * The failure a retired session hands to everything still running in it.
 *
 * `NotFound` is the reason `RemoteChildProcessSpawner` already maps the
 * provider's `unavailable` code onto, so an action cannot tell a session that
 * refused to open from a session that died under it — and does not need to.
 * Both are the same instruction to a retry policy: try again somewhere else.
 */
const retired = (session: string, reason: string): PlatformError.PlatformError =>
  PlatformError.systemError({
    _tag: "NotFound",
    module: MODULE,
    method: "supervise",
    description: `sandbox session \`${session}\` was retired: ${reason}`
  })

/** One open session, and the failure that retires everything running in it. */
interface Session {
  readonly scope: Scope.Closeable
  readonly spawner: ChildProcessSpawner["Service"]
  readonly failed: Deferred.Deferred<never, PlatformError.PlatformError>
}

/**
 * Re-reads a handle so its every wait ends when the session is retired.
 *
 * Without this a dead session is silent: the provider's streams stop producing
 * and the exit code never arrives, so the action waits forever instead of
 * failing.
 *
 * Each operation and each output pull races retirement only for the duration
 * of that wait. Process exit does not imply that stdout or stderr has ended:
 * a descendant can keep either pipe open. Racing individual pulls also leaves
 * no background stream listener to fail after its consumer has finished.
 */
const guarded = (
  handle: ChildProcessHandle,
  failed: Deferred.Deferred<never, PlatformError.PlatformError>
): Effect.Effect<ChildProcessHandle> => {
  const dies = Deferred.await(failed)
  const guard = <A>(effect: Effect.Effect<A, PlatformError.PlatformError>) => Effect.raceFirst(effect, dies)
  const guardStream = (stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>) =>
    Stream.transformPull(stream, (pull) => Effect.succeed(Effect.raceFirst(pull, dies)))
  return Effect.succeed(makeHandle({
    ...handle,
    exitCode: guard(handle.exitCode),
    isRunning: guard(handle.isRunning),
    stdout: guardStream(handle.stdout),
    stderr: guardStream(handle.stderr),
    all: guardStream(handle.all)
  }))
}

/**
 * Builds a spawner that keeps exactly one live provider session.
 *
 * The session opens on the first command, not while the layer is building: a
 * host that never spawns anything must not pay for a sandbox, and a provider
 * that is down must fail the action that needed it rather than the composition
 * root. A heartbeat probes the open session on the configured cadence; an
 * unhealthy verdict retires it, which fails everything running in it and lets
 * the next command open a fresh one.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (
  provider: Provider,
  options: Options,
  /** @internal Shortens the platform-timer bound in regression tests. */
  reportWithin: Duration.Input = Duration.seconds(30)
): Effect.Effect<ChildProcessSpawner["Service"], never, Scope.Scope> =>
  Effect.gen(function*() {
    const parent = yield* Scope.Scope
    const reporter = options.reporter ?? loggingReporter
    const tolerance = options.tolerance ?? 1
    const probe: Effect.Effect<HealthState> = options.probe ??
      makeHealth(provider, options.deadline === undefined ? undefined : { deadline: options.deadline }).check
    const held = yield* Ref.make<Session | undefined>(undefined)
    // Reporting runs outside the spawn permit and heartbeat. Bound each
    // observer on the platform timer so a hung reporter does not accumulate
    // for the lifetime of the supervisor, even under a frozen ambient clock.
    const report = (event: SandboxUnhealthy) =>
      Effect.catchCause(
        Effect.raceFirst(reporter.unhealthy(event), elapsed(reportWithin)),
        (cause) => Effect.logWarning("the sandbox supervision reporter failed", cause)
      )
    // One session at a time: opening and retiring both rewrite the same cell,
    // and a burst of concurrent spawns must not open a session each.
    const turn = yield* Semaphore.make(1)

    // The heartbeat is the only fiber that clears the held session, and a spawn
    // fills the cell only when it is empty, so the session a verdict retires is
    // the one the probe that produced it ran against.
    //
    // Order and interruptibility are the contract here. Retiring HAS to fail
    // the in-flight commands and close the provider scope: skipping the first
    // leaves every waiter hanging, which is the failure `guarded` exists to
    // prevent, and skipping the second leaks the remote machine. Reporting is
    // observational and is caller-supplied, so it can defect, be interrupted,
    // or never return; sequencing it first put both mandatory operations
    // behind it, and behind the permit every future spawn needs.
    const retire = (session: Session, event: SandboxUnhealthy) =>
      Effect.gen(function*() {
        yield* turn.withPermit(Effect.uninterruptible(Effect.gen(function*() {
          yield* Ref.set(held, undefined)
          yield* Deferred.fail(session.failed, retired(event.session, event.reason))
          const released = yield* Effect.exit(Scope.close(session.scope, Exit.void))
          if (Exit.isFailure(released)) {
            yield* Effect.logWarning(`sandbox session \`${event.session}\` failed to release`, released.cause)
          }
        })))
        yield* Effect.forkScoped(report(event))
      })

    const heartbeat = Effect.gen(function*() {
      let unhealthy = 0
      yield* Effect.repeat(
        Effect.gen(function*() {
          const open = yield* Ref.get(held)
          if (open === undefined) {
            unhealthy = 0
            return
          }
          const state = yield* probe
          if (state._tag === "Healthy") {
            unhealthy = 0
            return
          }
          unhealthy += 1
          if (unhealthy < tolerance) return
          const probes = unhealthy
          unhealthy = 0
          yield* retire(
            open,
            new SandboxUnhealthy({
              session: provider.session,
              reason: state.reason,
              ...state.message === undefined ? {} : { message: state.message },
              probes
            })
          )
        }),
        Schedule.spaced(options.interval)
      )
    })

    // `makeOpened`, not `make`: `make` answers with a spawner whose every
    // command fails when the provider refused to open, which is right for a
    // caller holding one session and wrong for a supervisor. Cached as a
    // generation, that spawner replayed the one open failure for the life of
    // the layer, and only a `ping` verdict could ever have cleared it — so a
    // provider without `ping` never opened again at all. A failed open now
    // leaves the cell empty and closes its own scope, and the next command
    // opens a fresh generation.
    const openSession = Effect.gen(function*() {
      const scope = yield* Scope.fork(parent)
      const spawner = yield* Effect.onError(
        Effect.provideService(makeOpened(provider), Scope.Scope, scope),
        () => Scope.close(scope, Exit.void)
      )
      const failed = yield* Deferred.make<never, PlatformError.PlatformError>()
      const session: Session = { scope, spawner, failed }
      yield* Ref.set(held, session)
      return session
    })

    const session = turn.withPermit(
      Effect.flatMap(Ref.get(held), (open) => open === undefined ? openSession : Effect.succeed(open))
    )

    // The heartbeat belongs to the supervisor's own scope, so tearing the
    // supervisor down stops probing before the sessions it probed are gone.
    yield* Effect.forkScoped(heartbeat)

    return makeSpawner(
      Effect.fnUntraced(function*(command) {
        // Acquiring the session and retiring one both hold the permit, so the
        // selected session is never handed out already retired. A retirement
        // arriving between selection and spawn reaches the spawn through this
        // race, before the handle guard exists. Everything after that is the
        // guard's job.
        const open = yield* Effect.mapError(session, platformFailure("open", CommandLine.render(command)))
        const handle = yield* Effect.raceFirst(open.spawner.spawn(command), Deferred.await(open.failed))
        yield* Effect.yieldNow
        return yield* guarded(handle, open.failed)
      })
    )
  })
