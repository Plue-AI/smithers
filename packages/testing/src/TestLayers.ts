/**
 * Deterministic test layer bundles.
 *
 * Governing design: `packages/testing/docs/concepts/test-tiers.md`, "The unit
 * tier".
 *
 * @since 0.0.0
 */

import * as TestJournal from "@smthrs/journal/test/TestJournal"
import * as Kernel from "@smthrs/kernel"
import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Path from "effect/Path"
import * as Random from "effect/Random"
import * as Stream from "effect/Stream"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner"
import type { EngineSubject } from "./EngineSubject.ts"
import { ModelLike } from "./ModelLike.ts"
import * as TestHost from "./TestHost.ts"
import { CapabilityContractError } from "./TestingError.ts"

const denied = (capability: string, operation: string): CapabilityContractError =>
  new CapabilityContractError({ capability, operation })

/**
 * The unit-tier bundle: deterministic Host, in-memory Journal, the supplied
 * engine, and the **real** permission kernel (`/kernel` GrantStore over a
 * test Workspace, unattended so sealing violations fail typed instead of
 * suspending). Sealing violations fail in tests exactly as in production.
 *
 * @since 0.0.0
 * @category layers
 */
export const unit = <R, E>(
  engine: Layer.Layer<EngineSubject, E, R>
) => {
  const host = TestHost.TestHost
  const journal = TestJournal.layer()
  const permissions = Kernel.GrantStore.layer({ attended: false }).pipe(
    Layer.provide(Kernel.Workspace.layer("/"))
  )
  return Layer.mergeAll(host, journal, permissions, engine)
}

/**
 * Property names a runtime reads to classify a value rather than to use it:
 * promise adoption, structural inspection, and test-matcher probes. They
 * answer `undefined` so a poisoned service can still be stored, logged, and
 * awaited past; every other read is a capability touch.
 */
const probes = new Set([
  "$$typeof",
  "_id",
  "_op",
  "_tag",
  "asymmetricMatch",
  "catch",
  "constructor",
  "finally",
  "inspect",
  "nodeType",
  "then",
  "toJSON",
  "toString",
  "valueOf"
])

/**
 * A service whose every property read is a capability violation.
 *
 * Two earlier shapes were unsound. Returning a function for every property
 * made a synchronous data read succeed: under {@link poisoned}, `Path.sep` was
 * a function rather than `"/"`, so code that interpolated it produced garbage
 * and the purity gate reported nothing. Returning `Effect.fail` from every
 * method made the refusal *recoverable*: a plan body that wrapped a host read
 * in `Effect.catch`, `Effect.option`, `Effect.orElse`, or `Effect.result` —
 * ordinary in fallback-shaped code — swallowed the violation, the computation
 * succeeded, and `PlanAssertions.expectPure` reported the plan as pure.
 *
 * A thrown `CapabilityContractError` is neither: it fires on a data read as
 * loudly as on a method call, and it cannot be caught by `Effect.catch` or
 * `Effect.catchTag`, which is the semantics "a plan must never touch this"
 * requires.
 * The read raises synchronously, so it becomes a defect wherever Effect
 * captures the throw and a thrown error where it does not. `expectPure`
 * catches the whole cause, so a violation inside a plan computation still
 * surfaces as a typed `purity_violation`.
 */
const poisonedService = <A>(capability: string): A =>
  new Proxy(
    {},
    {
      get: (_target, property) => {
        if (typeof property === "symbol" || probes.has(property)) return undefined
        throw denied(capability, property)
      }
    }
  ) as A

const poisonedModel = ModelLike.of({
  stream: () => Stream.die(new CapabilityContractError({ capability: "model", operation: "stream" }))
})

const poisonedClock: Clock.Clock = {
  currentTimeMillisUnsafe: () => {
    throw denied("clock", "currentTimeMillisUnsafe")
  },
  currentTimeMillis: Effect.die(denied("clock", "currentTimeMillis")),
  currentTimeNanosUnsafe: () => {
    throw denied("clock", "currentTimeNanosUnsafe")
  },
  currentTimeNanos: Effect.die(denied("clock", "currentTimeNanos")),
  monotonicTimeNanosUnsafe: () => {
    throw denied("clock", "monotonicTimeNanosUnsafe")
  },
  monotonicTimeNanos: Effect.die(denied("clock", "monotonicTimeNanos")),
  sleep: () => Effect.die(denied("clock", "sleep"))
}

const poisonedRandom: typeof Random.Random.Service = {
  nextIntUnsafe: () => {
    throw denied("random", "nextIntUnsafe")
  },
  nextDoubleUnsafe: () => {
    throw denied("random", "nextDoubleUnsafe")
  }
}

/**
 * Poisoned `Clock` and `Random` references. `Clock` and `Random` are
 * `Context.Reference`s with ambient defaults, so their poisoning cannot appear
 * in a layer's output type; providing this layer beneath a bundle makes any
 * unprovided time or randomness access fail loudly instead of silently using
 * the Effect defaults.
 *
 * @since 0.0.0
 * @category layers
 */
export const poisonedClockAndRandom: Layer.Layer<never> = Layer.mergeAll(
  Layer.succeed(Clock.Clock)(poisonedClock),
  Layer.succeed(Random.Random)(poisonedRandom)
)

/**
 * A plan-time bundle: Host, Model, Clock, and Random access is rejected
 * instead of reaching a real environment. It deliberately does not provide an
 * engine. Governing design: `packages/testing/docs/concepts/test-tiers.md`,
 * "The plan-time tier".
 *
 * @since 0.0.0
 * @category layers
 */
export const poisoned: Layer.Layer<Kernel.HostServices.HostService | ModelLike> = Layer.mergeAll(
  Layer.succeed(FileSystem.FileSystem)(poisonedService<FileSystem.FileSystem>("filesystem")),
  Layer.succeed(Path.Path)(poisonedService<Path.Path>("path")),
  Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(
    poisonedService<ChildProcessSpawner.ChildProcessSpawner["Service"]>("shell")
  ),
  Layer.succeed(Kernel.Jj.Jj)(poisonedService<Kernel.Jj.Jj>("jj")),
  Layer.succeed(HttpClient.HttpClient)(poisonedService<HttpClient.HttpClient>("httpTransport")),
  Layer.succeed(ModelLike)(poisonedModel),
  poisonedClockAndRandom
)
