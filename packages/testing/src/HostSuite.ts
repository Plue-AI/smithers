/**
 * Runner-agnostic conformance cases for complete Host bundles.
 *
 * One shared suite parameterized by layer set. Governing designs:
 * `packages/testing/docs/concepts/conformance.md`, "The host suite is
 * parameterized by a declaration".
 *
 * @since 0.0.0
 */

import type { Jj, JjFailure } from "@smthrs/jj"
import { Jj as JjTag } from "@smthrs/jj"
import { Clock, Deferred, Effect, Fiber, FileSystem, Path, Random, Stream } from "effect"
import type { Layer } from "effect"
import type * as PlatformError from "effect/PlatformError"
import * as HttpClient from "effect/unstable/http/HttpClient"
import type * as HttpClientError from "effect/unstable/http/HttpClientError"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner"
import { CapabilityContractError } from "./TestingError.ts"
import { poisonedClockAndRandom } from "./TestLayers.ts"

/**
 * A declared Host capability expectation.
 *
 * @category models
 * @since 0.0.0
 */
export type CapabilityExpectation =
  | { readonly supported: true }
  | { readonly supported: false; readonly code: string }

/**
 * HTTP requires an explicit probe target so the shared suite never invents a
 * live network call.
 *
 * @since 0.0.0
 * @category models
 */
export type HttpTransportExpectation =
  | {
    readonly supported: true
    readonly request: HttpClientRequest.HttpClientRequest
    readonly expectedStatus: number
  }
  | { readonly supported: false; readonly code: string }

/**
 * Every closed-list Host capability must be declared; omission is not an
 * admission mechanism. `code` is the stable code expected from the named
 * operation when a capability is unsupported.
 *
 * @since 0.0.0
 * @category models
 */
export interface HostProfile {
  /**
   * Scratch file used by the round-trip probe. Exclusive creation (`flag:
   * "wx"`) atomically refuses an existing path, including a dangling symlink,
   * with `FileSystem/scratchPath`. Removal is registered only after successful
   * creation and runs even when the read-back assertion fails.
   *
   * When omitted, the suite builds a randomized absolute path under `/tmp`
   * from the bundle's own `Path` and `Random`. A bundle whose platform has no
   * `/tmp` must declare a path of its own. Collisions fail without overwriting.
   */
  readonly fileSystemScratchPath?: string | undefined
  readonly fileSystem: CapabilityExpectation
  readonly path: CapabilityExpectation
  /**
   * A supported shell supplies a command that stays running until cancelled.
   * The cleanup case acquires its Host process handle, verifies it is running,
   * interrupts its scoped consumer, and verifies it stopped. An unsupported
   * shell is checked for its refusal code and makes no cleanup claim.
   */
  readonly shell:
    | { readonly supported: true; readonly interruptCommand: ChildProcess.Command }
    | { readonly supported: false; readonly code: string }
  readonly jj: CapabilityExpectation
  readonly httpTransport: HttpTransportExpectation
  readonly clock: CapabilityExpectation
  readonly random: CapabilityExpectation
}

/**
 * Every failure a host suite case may raise: the typed contract violation, and
 * the incidental host failures a supported capability's own probe can produce
 * (a filesystem or process probe, a jj command, an HTTP request).
 *
 * The channel used to be `unknown`, so a runner could not tell "this host
 * violates the contract" from "the scratch write failed because the disk is
 * full" — exactly what `TestingError`'s conformance-seam rule forbids.
 *
 * @category models
 * @since 0.0.0
 */
export type HostSuiteError =
  | CapabilityContractError
  | PlatformError.PlatformError
  | JjFailure
  | HttpClientError.HttpClientError

/**
 * A declarative conformance case consumable by any Effect test runner.
 *
 * @category models
 * @since 0.0.0
 */
export interface HostSuiteCase {
  readonly name: string
  readonly run: Effect.Effect<void, HostSuiteError>
}

/**
 * The output shape of the public Host bundle contract.
 *
 * `Clock` and `Random` are `Context.Reference`s (their identifier is `never`),
 * so they cannot appear in the layer's output type. The suite enforces them
 * behaviorally instead: the clock and random cases run over a poisoned
 * `Clock`/`Random` base, so a bundle that does not supply its own fails loudly
 * rather than silently using the ambient Effect defaults.
 *
 * @since 0.0.0
 * @category models
 */
export type HostBundle = Layer.Layer<
  | FileSystem.FileSystem
  | Path.Path
  | ChildProcessSpawner.ChildProcessSpawner
  | Jj
  | HttpClient.HttpClient
>

const failure = (capability: string, operation: string): Effect.Effect<never, CapabilityContractError> =>
  Effect.fail(new CapabilityContractError({ capability, operation }))

const assertEqual = (
  actual: unknown,
  expected: unknown,
  capability: string,
  operation: string
): Effect.Effect<void, CapabilityContractError> =>
  Object.is(actual, expected) ? Effect.void : failure(capability, operation)

const assertCapabilityError = <R>(
  effect: Effect.Effect<unknown, unknown, R>,
  capability: string,
  operation: string,
  code: string
): Effect.Effect<void, CapabilityContractError, R> =>
  effect.pipe(
    // A refusal that arrives as a defect is still a refusal. `Clock` and
    // `Random` are `Context.Reference`s, so their unsupported branch runs over
    // the poisoned base, which dies rather than failing; matching only the
    // recoverable channel meant a bundle that declares either unsupported was
    // a shape this suite could not assert at all, and the case died with a
    // defect instead of reporting the code it observed. Interruption is not a
    // refusal and still propagates.
    Effect.catchDefect((defect) => Effect.fail(defect)),
    Effect.matchEffect({
      onFailure: (error) => {
        const actual = typeof error === "object" && error !== null && "code" in error &&
            typeof error.code === "string"
          ? error.code
          : typeof error === "object" && error !== null && "reason" in error &&
              typeof error.reason === "object" && error.reason !== null && "_tag" in error.reason &&
              typeof error.reason._tag === "string"
          ? error.reason._tag
          : undefined
        return actual === code
          ? Effect.void
          : Effect.fail(
            new CapabilityContractError({
              capability,
              operation,
              expectedCode: code,
              ...(actual === undefined ? {} : { actualCode: actual })
            })
          )
      },
      onSuccess: () => failure(capability, operation)
    })
  )

const capabilityCode = (
  expectation: Extract<CapabilityExpectation, { readonly supported: false }>
): string => expectation.code

/**
 * The scratch file the round-trip probe owns for one invocation.
 *
 * The declared path wins. Otherwise the path is absolute, under `/tmp`, and
 * carries a random suffix drawn from the bundle's own `Random`, so two suites
 * are less likely to collide. Exclusive creation rejects any collision, and
 * nothing is written into the caller's working directory.
 */
const scratchTarget = (
  profile: HostProfile
): Effect.Effect<string, never, Path.Path> =>
  Effect.gen(function*() {
    if (profile.fileSystemScratchPath !== undefined) return profile.fileSystemScratchPath
    const path = yield* Path.Path
    const suffix = (yield* Random.nextIntBetween(0, 0xff_ffff)).toString(16)
    return path.join(path.sep, "tmp", `flows-host-suite-${suffix}.txt`)
  })

const provide = <E, R>(effect: Effect.Effect<void, E, R>, bundle: HostBundle): Effect.Effect<void, E> =>
  effect.pipe(Effect.provide(bundle)) as Effect.Effect<void, E>

/**
 * Provides the bundle over a poisoned `Clock`/`Random` base, so ambient Effect
 * defaults can never silently satisfy a time or randomness probe.
 */
const provideNoAmbient = <E, R>(effect: Effect.Effect<void, E, R>, bundle: HostBundle): Effect.Effect<void, E> =>
  effect.pipe(
    Effect.provide(bundle),
    Effect.provide(poisonedClockAndRandom)
  ) as Effect.Effect<void, E>

/**
 * Produces the shared Host conformance suite. Supported capabilities receive
 * behavioral assertions; unsupported ones must fail the documented operation
 * with its declared typed code.
 *
 * @since 0.0.0
 * @category constructors
 */
export const hostSuite = (bundle: HostBundle, profile: HostProfile): ReadonlyArray<HostSuiteCase> => {
  const fileSystemExpectation = profile.fileSystem
  const fileSystem = fileSystemExpectation.supported
    ? provide(
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const encoder = new TextEncoder()
        const decoder = new TextDecoder()
        const scratchPath = yield* scratchTarget(profile)
        // Acquire atomically and register removal only after creation succeeds.
        // acquireRelease also closes the interruption gap before registration.
        yield* Effect.scoped(
          Effect.gen(function*() {
            yield* Effect.acquireRelease(
              fs.writeFile(scratchPath, encoder.encode("host-suite"), { flag: "wx" }).pipe(
                Effect.mapError((error) =>
                  error.reason._tag === "AlreadyExists"
                    ? new CapabilityContractError({ capability: "FileSystem", operation: "scratchPath" })
                    : error
                )
              ),
              () => fs.remove(scratchPath, { force: true }).pipe(Effect.orDie)
            )
            const value = decoder.decode(yield* fs.readFile(scratchPath))
            yield* assertEqual(value, "host-suite", "FileSystem", "readFile")
          })
        )
      }),
      bundle
    )
    : provide(
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        yield* assertCapabilityError(
          fs.readFileString("/host-suite/missing.txt"),
          "FileSystem",
          "readFileString",
          capabilityCode(fileSystemExpectation)
        )
      }),
      bundle
    )

  const pathExpectation = profile.path
  const path = pathExpectation.supported
    ? provide(
      Effect.gen(function*() {
        const path = yield* Path.Path
        yield* assertEqual(
          path.normalize("/host-suite/./nested/../value.txt"),
          "/host-suite/value.txt",
          "Path",
          "normalize"
        )
      }),
      bundle
    )
    : provide(
      Effect.gen(function*() {
        const path = yield* Path.Path
        yield* assertCapabilityError(
          path.fromFileUrl(new URL("file:///host-suite/value.txt")),
          "Path",
          "fromFileUrl",
          capabilityCode(pathExpectation)
        )
      }),
      bundle
    )

  // `Shell` is gone: process spawning is Effect's `ChildProcessSpawner`, which
  // streams rather than buffering, so the probe collects stdout and the exit
  // code concurrently off one handle.
  const unlistedCommand = ChildProcess.make("host-suite-unlisted-command", { shell: true })

  const runUnlisted = Effect.scoped(
    Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const handle = yield* spawner.spawn(unlistedCommand)
      const [stdout, exitCode] = yield* Effect.all(
        [Stream.mkString(Stream.decodeText(handle.stdout)), handle.exitCode],
        { concurrency: "unbounded" }
      )
      return { stdout, exitCode: exitCode }
    })
  )

  const shellExpectation = profile.shell
  const shell = shellExpectation.supported
    ? provide(
      Effect.gen(function*() {
        const result = yield* runUnlisted
        yield* assertEqual(result.exitCode, 127, "ChildProcessSpawner", "spawn")
        yield* assertEqual(result.stdout, "", "ChildProcessSpawner", "spawn")
      }),
      bundle
    )
    : provide(
      assertCapabilityError(
        runUnlisted,
        "ChildProcessSpawner",
        "spawn",
        capabilityCode(shellExpectation)
      ),
      bundle
    )

  const jjExpectation = profile.jj
  const jj = jjExpectation.supported
    ? provide(
      Effect.gen(function*() {
        const jj = yield* JjTag
        const status = yield* jj.status()
        if (typeof status !== "string") yield* failure("Jj", "status")
      }),
      bundle
    )
    : provide(
      Effect.gen(function*() {
        const jj = yield* JjTag
        yield* assertCapabilityError(jj.status(), "Jj", "status", capabilityCode(jjExpectation))
      }),
      bundle
    )

  const httpExpectation = profile.httpTransport
  const httpTransport = httpExpectation.supported
    ? provide(
      Effect.gen(function*() {
        const transport = yield* HttpClient.HttpClient
        const response = yield* Effect.scoped(transport.execute(httpExpectation.request))
        yield* assertEqual(
          response.status,
          httpExpectation.expectedStatus,
          "HttpTransport",
          "execute"
        )
      }),
      bundle
    )
    : provide(
      Effect.gen(function*() {
        const transport = yield* HttpClient.HttpClient
        yield* assertCapabilityError(
          Effect.scoped(transport.execute(HttpClientRequest.get("https://example.invalid/host-suite"))),
          "HttpTransport",
          "execute",
          capabilityCode(httpExpectation)
        )
      }),
      bundle
    )

  const clockExpectation = profile.clock
  const clock = clockExpectation.supported
    ? provideNoAmbient(
      Effect.gen(function*() {
        const first = yield* Clock.currentTimeMillis
        const second = yield* Clock.currentTimeMillis
        if (!Number.isInteger(first) || !Number.isInteger(second) || second < first) {
          yield* failure("Clock", "currentTimeMillis")
        }
      }),
      bundle
    )
    : provideNoAmbient(
      assertCapabilityError(
        Clock.currentTimeMillis,
        "Clock",
        "currentTimeMillis",
        capabilityCode(clockExpectation)
      ),
      bundle
    )

  const randomExpectation = profile.random
  const random = randomExpectation.supported
    ? provideNoAmbient(
      Effect.gen(function*() {
        const value = yield* Random.next
        if (!Number.isFinite(value) || value < 0 || value >= 1) yield* failure("Random", "next")
      }),
      bundle
    )
    : provideNoAmbient(assertCapabilityError(Random.next, "Random", "next", capabilityCode(randomExpectation)), bundle)

  const cleanup = shellExpectation.supported
    ? provide(
      Effect.gen(function*() {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
        const ready = yield* Deferred.make<ChildProcessSpawner.ChildProcessHandle, PlatformError.PlatformError>()
        const fiber = yield* Effect.scoped(
          spawner.spawn(shellExpectation.interruptCommand).pipe(
            Effect.tap((handle) => Deferred.succeed(ready, handle)),
            Effect.andThen(Effect.never)
          )
        ).pipe(
          // Acquisition can fail before a handle is published. Wake the waiter
          // with that cause instead of leaving it blocked on the handshake.
          Effect.onError((cause) => Deferred.failCause(ready, cause)),
          Effect.forkChild({ startImmediately: true })
        )
        const handle = yield* Deferred.await(ready)
        yield* Effect.gen(function*() {
          yield* assertEqual(yield* handle.isRunning, true, "Scope", "interrupt_running")
          yield* Fiber.interrupt(fiber)
          yield* assertEqual(yield* handle.isRunning, false, "Scope", "interrupt_cleanup")
        }).pipe(
          // A nonconforming bundle must fail the assertion before we attempt
          // recovery, so killing here cannot hide a leaked resource.
          Effect.ensuring(
            Effect.gen(function*() {
              yield* Fiber.interrupt(fiber)
              if (yield* handle.isRunning) yield* handle.kill()
            }).pipe(Effect.orDie)
          )
        )
      }),
      bundle
    )
    : provide(
      assertCapabilityError(runUnlisted, "ChildProcessSpawner", "spawn", capabilityCode(shellExpectation)),
      bundle
    )

  return [
    { name: "FileSystem round-trips", run: fileSystem },
    { name: "Path normalizes", run: path },
    { name: "Shell behavior is deterministic", run: shell },
    { name: "Jj has a declared capability result", run: jj },
    { name: "HttpTransport has a declared capability result", run: httpTransport },
    { name: "Clock is monotonic", run: clock },
    { name: "Random produces a valid value", run: random },
    { name: "Scoped resources clean up on fiber interruption", run: cleanup }
  ]
}
