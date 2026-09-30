/**
 * The production `EngineLike` binding: the harness engine port executed on the
 * durable flow engine from `@smthrs/engine`.
 *
 * `@smthrs/harness` declares the port (`sealStep` / `splice` / `suspend`) and
 * ships only `layer(implementation)` and `layerNoop`. This module supplies the
 * missing implementation, so a production consumer can run the harness on the
 * durable engine without reaching into `@smthrs/testing`.
 *
 * The binding is deliberately *not* `@smthrs/testing`'s `FlowEngineLike`:
 * that module adapts the engine to `EngineSubject`
 * (`run` / `result` / `interrupt` / `resume` / `journal`), the conformance
 * contract used by the testing library. The two ports share a backing engine
 * and nothing else, and `packages/testing/test/EngineSubject.test.ts` asserts
 * they stay distinct.
 *
 * How the port maps onto the engine:
 *
 * - `sealStep` resolves the route, runs `Route.prepare`, and digests the
 *   credential-free `PreparedRequest` — canonical body bytes included —
 *   together with the harness's declared key material into a `StepKey`
 *   (`docs/pages/concepts/step-keys.md`). That key is the *sealed* activity's
 *   idempotency key, so a provider wire change produces a new key and a
 *   replayed turn re-emits the recorded model events without calling the
 *   provider again. Credentials are signed on by the route after the digest
 *   and never enter it.
 * - `splice` refuses every child in an elaborated batch with a typed engine
 *   failure. The elaborated-subgraph path was superseded by the cell loop, so
 *   the port remains available to the harness but does not run that old path.
 *   An empty batch still produces an empty stream.
 * - `record` journals one nondeterministic controller read — the steering
 *   drain, and the workspace measurements below — as its own run-scoped
 *   boundary, so a resumed run replays the recorded value instead of reading
 *   the world a second time.
 * - `observe` measures the workspace through `WorkspaceObservation.Observer`
 *   when the composition provides one, and reports it unobserved when it does
 *   not. This is what lets the controller decide "did this frame change
 *   anything" from the tree rather than from what the frame's calls declared —
 *   a shell command declares nothing and writes wherever it likes.
 * - Every key folds in the resolved composition identity `Options.layers` — the
 *   host's layer stack and its resolved plugin list. A boundary resolved under a
 *   different composition is a different boundary.
 * - `suspend` is a real durable suspension (`Flow.suspend`), not a failure.
 *   The execution parks and can be resumed by the engine.
 *
 * Reference consulted: `reference/effect` `unstable/workflow` (Action /
 * Workflow / DurableDeferred) by way of the vendored fork in
 * `@smthrs/engine`, and `reference/temporal`'s activity-identity rules for
 * why a non-sealed invocation must carry a distinguishing key.
 *
 * @since 0.1.0
 */

import * as Permission from "@smthrs/capability/Permission"
import * as Digest from "@smthrs/core/Digest"
import type * as KeyMaterial from "@smthrs/core/KeyMaterial"
import { Action, Flow, FlowRuntime } from "@smthrs/flow"
import type { FileBoundary } from "@smthrs/flow/FileBoundary"
import * as Cell from "@smthrs/harness/Cell"
import * as EngineLike from "@smthrs/harness/EngineLike"
import * as HarnessError from "@smthrs/harness/HarnessError"
import type * as Plan from "@smthrs/harness/Plan"
import { CallFact } from "@smthrs/journal"
import * as CanonicalJson from "@smthrs/model/CanonicalJson"
import type * as Model from "@smthrs/model/Model"
import * as ModelError from "@smthrs/model/ModelError"
import * as ModelEvent from "@smthrs/model/ModelEvent"
import * as ModelRequest from "@smthrs/model/ModelRequest"
import * as Route from "@smthrs/model/Route"
import * as StepKey from "@smthrs/plan/StepKey"
import * as Checkpoints from "@smthrs/std/Checkpoints"
import type * as Cause from "effect/Cause"
import * as Clock from "effect/Clock"
import * as Context from "effect/Context"
import * as Crypto from "effect/Crypto"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Queue from "effect/Queue"
import * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as Budget from "./Budget.ts"
import { callId } from "./internal/CallIdentity.ts"
import { normalizeRecordedModelStep, recordModelStep } from "./internal/FlowEngineLike.ts"
import * as QuotaPolicy from "./QuotaPolicy.ts"
import * as RunawayGuard from "./RunawayGuard.ts"
import * as WorkspaceObservation from "./WorkspaceObservation.ts"
import type * as WorkspaceSandbox from "./WorkspaceSandbox.ts"

export { defaultModelIdleMs, defaultModelOverruns } from "./internal/FlowEngineLike.ts"

/**
 * Route resolution for one sealed model request.
 *
 * The port needs `Route.prepare` and nothing else, so a consumer can supply a
 * configured route, a router, or a recorded resolver in tests.
 *
 * @category models
 * @since 0.1.0
 */
export interface RouteResolver {
  readonly prepare: (
    request: ModelRequest.ModelRequest
  ) => Effect.Effect<Route.PreparedRequest, ModelError.ModelError>
}

/**
 * Adapts one configured model route to {@link RouteResolver}.
 *
 * @category constructors
 * @since 0.1.0
 */
export const routeResolver = <Body, Frame, Event, State>(
  route: Route.Route<Body, Frame, Event, State>
): RouteResolver => ({
  prepare: (request) => Route.prepare(route, request)
})

/**
 * Executes one flow call issued from inside a running cell.
 *
 * The runner owns lookup, decoding, attenuation, and placement; this module
 * owns only durability.
 *
 * @category models
 * @since 0.1.0
 */
export interface CallRunner {
  /**
   * Decides whether the call may proceed, before the durable boundary opens.
   *
   * Authority is not a side effect, and the distinction matters for replay: an
   * activity's outcome is journaled, so a permission requirement raised from
   * inside one would be replayed forever and no later grant could unblock it.
   * Checked here, a park records nothing, and the resumed attempt asks again
   * against the grant store as it now stands.
   */
  readonly authorize?: (
    call: Cell.Call
  ) => Effect.Effect<void, HarnessError.HarnessError>
  readonly run: (
    call: Cell.Call
  ) => Effect.Effect<Cell.CallResult, HarnessError.HarnessError>
}

/**
 * A cell-call runner that may touch the workspace it runs inside.
 *
 * The only difference from {@link CallRunner} is the `Workspace` requirement,
 * which is what a flow uses to read and write transactionally. A plain
 * `CallRunner` satisfies this too — it simply never asks for the service — so
 * {@link sandboxed} accepts either.
 *
 * @category models
 * @since 0.1.0
 */
export interface WorkspaceCallRunner {
  readonly authorize?: (
    call: Cell.Call
  ) => Effect.Effect<void, HarnessError.HarnessError>
  readonly run: (
    call: Cell.Call
  ) => Effect.Effect<Cell.CallResult, HarnessError.HarnessError, WorkspaceSandbox.Workspace>
}

/**
 * Rewrites one declared effect path into the workspace-relative form the
 * engine's file boundary speaks.
 *
 * The two sides use different vocabularies for the same idea. A flow
 * declaration is written against `@smthrs/core`'s `Effects.covers`, whose
 * only wildcard form is an absolute prefix glob — which is why every
 * filesystem flow in `@smthrs/std` declares `/**` for "any path". The
 * engine's `StepBoundary` resolves boundary paths against the pinned
 * workspace root, and `AtomicFileSystem` refuses `/**` outright as "path is
 * outside the pinned root". Handing the declaration across untranslated made
 * every `read`, `write`, `edit`, `glob`, `grep`, and `ls` call from a cell
 * fail before its handler ran.
 *
 * The translation is exact rather than lenient: a flow cannot reach outside
 * the workspace at all — the kernel filesystem pins it — so the declaration's
 * "anywhere" and the boundary's "everything under the root" name the same
 * set, and a leading `/` is the only difference between how the two write it.
 *
 * @category conversions
 * @since 0.1.0
 */
export const workspaceRelative = (path: string): string => path.startsWith("/") ? path.slice(1) : path

/**
 * Converts the agent-side declaration into the file boundary understood by
 * the production engine and its workspace sandbox.
 *
 * The agent declaration knows paths but has not measured them; the engine's
 * `StepBoundary` performs that measurement before dispatch. The placeholder
 * digest is therefore identity-bearing metadata only for direct conformance
 * harnesses; production never uses it as evidence.
 *
 * @category conversions
 * @since 0.1.0
 */
export const callBoundary = (call: Cell.Call): FileBoundary => ({
  readSet: call.effects.reads.map((path) => ({ path: workspaceRelative(path), digest: call.identity.declaration })),
  writeSet: call.effects.writes.map(workspaceRelative),
  boundaryMode: call.effects.mode === "hermetic" ? "hard" : "expected"
})

/**
 * The key material one cell call declares about itself.
 *
 * This is the workspace sandbox's separate content key over the declared call
 * material. The durable activity {@link callKey} uses `StepKey.content`
 * instead: it nests effects under the body and includes the resolved scope
 * layers, including the composition digest this function never receives. The
 * two keys therefore describe related boundaries but are intentionally not
 * equal. A sealed call is content-addressed; anything else folds in the cell
 * identity that keeps two invocations of one declaration distinct.
 *
 * @category constructors
 * @since 0.1.0
 */
export const callMaterial = (
  call: Cell.Call,
  layers: ReadonlyArray<string> = []
): KeyMaterial.KeyMaterial => ({
  version: "flows/key-material/v2",
  kind: call.effects.tier,
  body: {
    _tag: "CellCall",
    flowName: call.flowName,
    declaration: call.identity.declaration,
    input: call.input,
    // The tree the call reads. A sealed call is content-addressed on what it
    // asked, and "the same command against the tree this run opened on" is a
    // different question from "the same command against the tree as it stands"
    // — so without this the second of the two would replay the first's answer,
    // which is precisely the reading the fails-before proof depends on. Absent
    // spreads to nothing, so every key that existed before checkpoints is
    // byte-identical.
    ...(call.at === undefined ? {} : { at: call.at }),
    // Which version of the live tree a sealed reading is taken against: the
    // tree the frame opened on and the writes issued since, so a read after
    // any write, this run's or another's, is a new question.
    ...(call.epoch === undefined ? {} : { epoch: call.epoch }),
    ...(Option.isSome(call.placement) ? { placement: call.placement.value } : {}),
    ...(call.effects.tier === "sealed" ? {} : {
      session: call.identity.session,
      frame: call.identity.frame,
      cell: call.identity.cell,
      ordinal: call.identity.ordinal
    })
  },
  inputs: [],
  layers: [...new Set([...layers, ...call.identity.layers])].sort(),
  capabilities: [...call.capabilities].sort(),
  effects: call.effects,
  placement: undefined
})

/**
 * Runs every cell call inside an outer workspace transaction.
 *
 * This is the seam between the cell path and the scheduler the vault's
 * `Concepts/Reconciliation.md` describes: the call's *declared* effects and its
 * key material go in, the sandbox executes the runner against an isolated copy
 * of the workspace, and what comes back is a functional result — the files the
 * call would change, the provenance of what it actually read and wrote, and a
 * cache outcome keyed by `@smthrs/plan`'s compiler.
 *
 * Two properties are the point:
 *
 * - **A declaration is checked, not trusted.** A call that reads or writes
 *   outside what the cell chose comes back `Invalidated`, and this adapter
 *   turns that into a call failure the cell can catch rather than a silent
 *   host mutation. The speculative changes are discarded with it.
 * - **Materialization is explicit.** The sandbox admits a result before any
 *   host state moves, so a conflicting concurrent write is a typed refusal
 *   instead of a lost update.
 *
 * The adapter is a `CallRunner` decorator rather than an option on
 * {@link make}, so a host chooses the transaction boundary by composition and
 * a host that has no workspace to isolate composes nothing.
 *
 * @category constructors
 * @since 0.1.0
 */
export const sandboxed = (
  sandbox: WorkspaceSandbox.Service,
  runner: WorkspaceCallRunner,
  options: { readonly layers?: ReadonlyArray<string> | undefined } = {}
): Effect.Effect<CallRunner, never, Crypto.Crypto> =>
  Effect.map(Crypto.Crypto, (crypto): CallRunner => ({
    ...(runner.authorize === undefined ? {} : { authorize: runner.authorize }),
    run: (call) =>
      Effect.gen(function*() {
        const cacheKey = call.effects.tier === "sealed"
          ? yield* StepKey.fromKeyMaterial(callMaterial(call, options.layers), {}).pipe(
            Effect.provideService(Crypto.Crypto, crypto),
            Effect.mapError((cause) => engineFailed(`Cell call ${call.flowName} could not be keyed`, cause))
          )
          : undefined
        const outcome = yield* sandbox.execute({
          descriptor: callBoundary(call),
          ...(cacheKey === undefined ? {} : { cacheKey }),
          workflow: runner.run(call)
        }).pipe(
          Effect.provideService(Crypto.Crypto, crypto),
          Effect.mapError((cause) =>
            cause instanceof HarnessError.HarnessError
              ? cause
              : engineFailed(`Cell call ${call.flowName} could not run in its workspace sandbox`, cause)
          )
        )
        if (outcome._tag === "Invalidated") {
          const violated = outcome.violations
            .map((violation) => `${violation.kind} ${violation.resource.id}`)
            .join(", ")
          return new Cell.CallResult({
            outcome: "failure",
            value: null,
            message: `Flow ${call.flowName} touched what it did not declare (${violated}); its changes were discarded.`
          })
        }
        yield* sandbox.materialize(outcome).pipe(
          Effect.provideService(Crypto.Crypto, crypto),
          Effect.mapError((cause) =>
            engineFailed(`Cell call ${call.flowName} could not materialize its workspace changes`, cause)
          )
        )
        return outcome.result.output
      })
  }))

/**
 * The collaborators a durable harness engine needs.
 *
 * `calls` is the cell loop's flow-call seam. A host that equips cells with
 * callable flows supplies it; without one, a cell call is refused with a typed
 * engine failure.
 *
 * @category models
 * @since 0.1.0
 */
export interface Options {
  readonly model: Model.Model
  /** Bounded model-boundary retry policy; injectable so tests and hosts control time. */
  readonly modelRetryPolicy?: Schedule.Schedule<unknown, Model.ModelFailure> | undefined
  readonly route: RouteResolver
  readonly calls?: CallRunner | undefined
  /**
   * The resolved composition identity every durable key folds in.
   *
   * This is the layer set the host actually built — model, permission, and host
   * layers, plus the resolved plugin list in resolution order. It belongs in the
   * key because it changes what a boundary *means*: the same declaration
   * resolved under a different plugin list is a different call, and serving it a
   * recorded result from the other composition is a stale-cache bug, not a
   * replay.
   */
  readonly layers?: ReadonlyArray<string> | undefined
  /**
   * The composition's COMPLETE effective authority, if the host knows it.
   *
   * A sealed boundary is cross-run cacheable, so the key has to distinguish
   * two compositions that grant different authority — the same sealed
   * `fs/read` resolved under `fs:read:/workspace/**` and under
   * `fs:read:/workspace/a/**` is not the same boundary, even when the call
   * declares identical capabilities, because the envelope is what attenuates
   * it (issue #75).
   *
   * The host must supply this only when the record really is complete. An
   * omitted value is the honest "my authority is unknown", and the engine
   * answers it by pinning every sealed key to the current execution — no
   * cross-run reuse, but never a stale result from a differently-authorized
   * composition. Declaring an empty record is a positive claim that the
   * composition grants nothing, and it is a lie if the host holds an
   * envelope; {@link module:Agent} declares the envelope it actually
   * built.
   */
  readonly capabilities?: Readonly<Record<string, ReadonlyArray<string>>> | undefined
}

/**
 * The durable outcome of one sealed model step.
 *
 * The array branch is the format written before model-boundary retries were
 * introduced. Keeping it decodable matters because a parked run may resume
 * against a newer agent package and replay that already-settled activity.
 * New records always use the object branch so a terminal typed model failure
 * can be replayed after its retry events.
 *
 * @category schemas
 * @since 0.1.0
 */
export const RecordedModelStep = Schema.Union([
  Schema.Array(ModelEvent.ModelEvent),
  Schema.Struct({
    events: Schema.Array(ModelEvent.ModelEvent),
    error: Schema.optional(ModelError.ModelError),
    /**
     * Which structured-output correction this call belonged to, when the
     * caller was running a correction ladder.
     *
     * The ordinal is durable twice over, and only one of the two is readable.
     * Each correction is its own session — `${executionId}/${tag}#${n}` — so
     * the ladder's rungs already have distinct sealed step keys and a replay
     * reproduces all of them; but a session is KEY MATERIAL, hashed into a
     * digest, and nothing downstream can read an ordinal back out of it. An
     * operator or a projection reading a run's steps could see three sealed
     * model calls and not which was the ask and which were its corrections.
     * The field is that answer, on the record itself.
     *
     * Optional because it is absent from two honest cases: a model call made
     * outside a correction ladder, and a record written before this field
     * existed, which a parked run may still resume onto.
     */
    correction: Schema.optional(Schema.Int)
  })
])

/**
 * The correction ordinal the model calls made under it belong to.
 *
 * {@link module:AgentAction} sets it around each rung of its structured-output
 * correction ladder, and this port stamps it onto the rung's sealed record. It
 * is deliberately NOT key material: the session already distinguishes the
 * rungs, and folding the ordinal into the key as well would change nothing
 * about which calls are distinct while making every recorded step un-replayable
 * by a caller that numbers its ladder differently.
 *
 * Absent by default, which is the honest reading of a model call made outside
 * any ladder.
 *
 * @category context
 * @since 0.1.0
 */
export const Correction = Context.Reference<number | undefined>(
  "@smthrs/agent/FlowEngineLike/Correction",
  { defaultValue: () => undefined }
)

/**
 * The first delay the production transport policy waits, in milliseconds.
 *
 * @category policies
 * @since 0.1.0
 */
export const defaultModelRetryBaseMillis = 1000

/**
 * The factor each successive production transport delay multiplies by.
 *
 * @category policies
 * @since 0.1.0
 */
export const defaultModelRetryFactor = 2

/**
 * How many times the production transport policy retries one sealed step.
 *
 * @category policies
 * @since 0.1.0
 */
export const defaultModelRetryTimes = 5

/**
 * The wall clock the production transport ladder may span, in milliseconds.
 *
 * The count alone is not a bound. Five rungs of jittered doubling from one
 * second sum to at most 37.2 s of *sleeping*, but a ladder also spends whatever
 * each failing attempt spends, and a dying HTTP/2 session does not fail
 * quickly: r92 of the SWE-bench full benchmark burned ten `transport` retries
 * and $0.85 across two instances against a socket that stayed dead for about
 * half a minute, and each of those attempts re-sent a whole prompt and streamed
 * a partial body before dying. A ladder whose only bound is a count charges for
 * that as many times as the count allows.
 *
 * 45,000 ms is the declared ladder's own jittered ceiling plus one rung's worth
 * of headroom for the attempts between the sleeps, so a ladder that fails as
 * fast as this policy assumes still runs all five rungs and nothing here
 * changes for it. What changes is the ladder whose attempts are slow: it stops
 * when the wall clock says the incident has outlasted the window this policy
 * was written to cover, rather than when the fifth rung happens to arrive. Past
 * that point waiting is not what is wrong, which is exactly what
 * `@smthrs/model` `RequestExecutor` `makeWith` and its `Transport` are for: a
 * client the host can replace, rather than a longer wait on the one that died.
 *
 * The elapsed time is the schedule's own, taken on the injected clock, so a
 * test that supplies one sees the window it declared and never a wall-clock
 * wait.
 *
 * @category policies
 * @since 1.0.0-rc.0
 */
export const defaultModelRetryWindowMillis = 45_000

/**
 * The production transport retry budget: five retries over a jittered
 * exponential backoff spanning roughly thirty seconds, inside a 45-second
 * wall-clock window.
 *
 * The shape is load-bearing, not decorative. A transport-class failure is
 * almost never local: a destroyed HTTP/2 session, a 5xx, an overloaded
 * provider. All three persist for seconds to tens of seconds, so a retry that
 * fires inside that window is a wasted attempt, and a budget that empties
 * inside it turns one provider incident into a dead run. Wave 4 of the
 * SWE-bench harness lost `pytest-dev__pytest-6197` exactly that way: both of
 * its `transport` retries were spent, and the run ended `failed`, while the
 * provider was still refusing.
 *
 * Doubling from one second across five retries spans about 31 s, which is
 * long enough for a connection pool to re-establish and for a short rate-limit
 * window to pass. Jitter is what keeps a fleet of runs that all hit the same
 * incident from re-converging on the provider in lockstep; {@link
 * Schedule.jittered} scales each delay by a random factor in `[0.8, 1.2]`
 * drawn from the injected `Random` service, and the sleep itself is taken on
 * the injected clock, so a test that supplies both sees the schedule it
 * declared and never a wall-clock wait.
 *
 * {@link defaultModelRetryWindowMillis} bounds the same ladder by elapsed time,
 * because five rungs is a bound on how many attempts are made and not on what
 * they cost. Whichever limit arrives first ends the ladder.
 *
 * @category policies
 * @since 0.1.0
 */
export const defaultModelRetryPolicy: Schedule.Schedule<unknown, Model.ModelFailure> = Schedule
  .exponential(defaultModelRetryBaseMillis, defaultModelRetryFactor)
  .pipe(
    Schedule.jittered,
    Schedule.upTo({ times: defaultModelRetryTimes, duration: Duration.millis(defaultModelRetryWindowMillis) })
  )

/**
 * Applies a composition's additional quota-parking policy.
 *
 * {@link recordModelStep} folds a `ModelError` into the step's recorded VALUE
 * on purpose: a provider's refusal is evidence, and a replay that re-issued it
 * would ask the provider again for an answer it already gave. A quota refusal
 * is the one class where that is wrong. It says nothing about the request — the
 * same bytes succeed a minute later — so recording it under a content key would
 * pin "this prompt is refused" into the shared cache and make the wake
 * pointless: the retried call would replay the refusal forever.
 *
 * {@link recordModelStep} already fails every normalized capacity refusal
 * unconditionally. This policy hook may classify additional provider-specific
 * failures for parking, but it cannot weaken that floor. With
 * `QuotaPolicy.layerUnclassified` it is the identity for recorded values.
 */
const unlessParked = (quota: QuotaPolicy.Service) =>
(
  recorded: typeof RecordedModelStep.Type
): Effect.Effect<typeof RecordedModelStep.Type, ModelError.ModelError> => {
  const error = normalizeRecordedModelStep(recorded).error
  if (error === undefined) return Effect.succeed(recorded)
  return Effect.flatMap(
    Clock.currentTimeMillis,
    (now) => Option.isSome(quota.classify(error, now)) ? Effect.fail(error) : Effect.succeed(recorded)
  )
}

/**
 * Fails an exhausted call timeout instead of sealing it, when the host guards
 * timeouts: the guard parks the run on it, and a sealed timeout would replay
 * into every Continue the operator chose.
 */
const unlessGuarded = (guarded: boolean) =>
(
  recorded: typeof RecordedModelStep.Type
): Effect.Effect<typeof RecordedModelStep.Type, ModelError.ModelError> => {
  const error = normalizeRecordedModelStep(recorded).error
  return guarded && error?.code === "call_timeout" ? Effect.fail(error) : Effect.succeed(recorded)
}

/**
 * Model, permission, and usage-infrastructure failures as one encodable
 * boundary schema. The engine stores an activity's failure as well as its
 * success, so the port's error channel cannot be an opaque value.
 */
const ModelFailure = Schema.Union([
  ModelError.ModelError,
  Permission.PermissionRequired,
  Permission.PermissionDenied,
  Permission.GrantStoreError,
  HarnessError.HarnessError
])

const sealStepActivityName = "harness/sealStep"

const cellCallActivityName = (flowName: string): string => `harness/cell-call/${flowName}`

const boundaryActivityName = (name: string): string => `harness/boundary/${name}`

const engineFailed = (message: string, cause: unknown): HarnessError.HarnessError =>
  new HarnessError.HarnessError({ code: "engine_failed", message, cause })

/** The ledger key prefix for the usage a recorded boundary paid for. */
const boundaryUsagePrefix = "boundary-usage/"

/**
 * Reports a budget that could not account this run.
 *
 * It is an engine failure rather than a model one because nothing about the
 * provider or the prompt is wrong: the seam that says what the run may spend
 * cannot answer, and a run that kept calling anyway would be spending an
 * envelope nobody is holding. The step fails and can be re-dispatched — the
 * sealed model step replays from its recorded answer, so a retry pays the
 * ledger again, not the provider.
 */
const accountingFailed = (cause: Budget.AccountingUnavailable): HarnessError.HarnessError =>
  engineFailed(cause.message, cause)

/**
 * Supplies the hashing service `@smthrs/plan`'s step-key compiler runs under.
 *
 * The compiler is the main tree's, so the material it hashes and the `key1_`
 * format it emits are the main tree's too. Only the hash *provider* is local:
 * `Digest.provideSync` uses a synchronous SHA-256 proven byte-identical to the
 * platform service (`@smthrs/core` `Digest.test.ts`), which keeps `EngineLike`
 * free of a `Crypto` requirement it would otherwise have to thread through
 * every stream and activity signature.
 */
const keyed = <A, E>(effect: Effect.Effect<A, E, Crypto.Crypto>): Effect.Effect<A, E> => Digest.provideSync(effect)

/**
 * Drops `undefined`-valued properties from an already-encoded JSON value.
 *
 * Canonical serialization rejects `undefined` outright, and `Schema.encodeSync`
 * keeps optional fields as explicit `undefined`. Applied only to encoded
 * request JSON, never to arbitrary values, so Canonical still rejects class
 * instances and `Redacted` material on its own.
 */
const stripUndefined = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stripUndefined)
  if (typeof value !== "object" || value === null) return value
  const stripped: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) stripped[key] = stripUndefined(item)
  }
  return stripped
}

interface ModelCallDeclaration {
  readonly _tag: "ModelCall"
  readonly request: ModelRequest.ModelRequest
}

const isModelCall = (value: unknown): value is ModelCallDeclaration =>
  typeof value === "object" && value !== null &&
  (value as { readonly _tag?: unknown })._tag === "ModelCall" && "request" in value

/**
 * Digests the harness key material together with the prepared wire request.
 *
 * The harness declaration embeds the live `ModelRequest` (class instances that
 * Canonical refuses), so it is re-encoded to plain JSON before hashing.
 */
const seal = Effect.fn("FlowEngineLike.seal")(function*(
  step: EngineLike.SealedModelStep,
  route: RouteResolver
) {
  const prepared = yield* route.prepare(step.request)
  const declaration = step.keyMaterial.body
  const material = {
    ...step.keyMaterial,
    body: {
      _tag: "PreparedModelCall",
      declaration: isModelCall(declaration)
        ? {
          _tag: "ModelCall",
          request: stripUndefined(Schema.encodeSync(ModelRequest.ModelRequest)(declaration.request))
        }
        : declaration,
      request: {
        routeId: prepared.routeId,
        protocolId: prepared.protocolId,
        method: prepared.method,
        url: prepared.url,
        publicHeaders: prepared.publicHeaders,
        body: ""
      }
    }
  } satisfies KeyMaterial.KeyMaterial
  // Keep historical keys byte-for-byte: Uint8Array.join emits exactly the
  // decimal JSON elements of Array.from(body), without allocating or walking
  // a million generic canonical-JSON nodes. Let StepKey canonicalize all other
  // material, then splice these known-canonical byte elements at its hash seam.
  const wire = `[${prepared.body.join(",")}]`
  const crypto = yield* keyed(Crypto.Crypto)
  for (let ordinal = 0;; ordinal++) {
    material.body.request.body = `flows/agent/wire-body/${ordinal}`
    const marker = JSON.stringify(material.body.request.body)
    let collision = false
    const key = yield* StepKey.fromKeyMaterial(material, {}).pipe(
      Effect.provideService(Crypto.Crypto, {
        ...crypto,
        digest: (algorithm, data) => {
          const canonical = new TextDecoder().decode(data)
          const offset = canonical.indexOf(marker)
          // Caller material can contain the same literal. Retry with another
          // marker rather than replacing any caller-owned value. No marker is
          // ever part of the returned key's bytes.
          collision = offset < 0 || canonical.indexOf(marker, offset + marker.length) !== -1
          return crypto.digest(
            algorithm,
            collision ? data : new TextEncoder().encode(
              canonical.slice(0, offset) + wire + canonical.slice(offset + marker.length)
            )
          )
        }
      }),
      Effect.mapError((cause) => engineFailed("The prepared model request could not be sealed", cause))
    )
    if (!collision) return key
  }
})

/**
 * The composition and run scope every durable key in this port folds in.
 *
 * `layers` is the resolved composition identity; `run` names the one flow
 * execution the port was built for.
 */
interface Scope {
  readonly layers: ReadonlyArray<string>
  readonly run: string
}

/**
 * Derives one cell call's activity identity.
 *
 * A sealed call is content-addressed on the declaration digest, the resolved
 * layer set, the declared capabilities, and the arguments, so the same sealed
 * call replays one recorded result wherever it appears — that is exactly the
 * semantics "sealed" declares.
 *
 * Anything else folds in the whole cell identity: session, frame, cell digest,
 * and the call's execution ordinal. That keeps two invocations of one
 * declaration distinct, scopes an irreversible effect so it can never be
 * shared across sessions, and — because re-executing a cell reaches the same
 * ordinal with the same declaration — makes a crash mid-cell replay the
 * boundaries that already settled instead of re-running them. Cross-execution
 * isolation itself is the engine's: every non-sealed activity is keyed by
 * ordinal under the execution id, so two runs can never alias one another's
 * journaled boundaries regardless of what this port declares.
 *
 * The layer set is part of both keys, and it is the union of what the cell
 * frame declared and what the host actually composed — the resolved plugin list
 * included. Two otherwise identical calls resolved under different layers are
 * different calls.
 */
const callKey = (
  call: Cell.Call,
  scope: Scope,
  continued: number
): Effect.Effect<StepKey.StepKey, HarnessError.HarnessError> =>
  keyed(
    StepKey.content({
      body: {
        _tag: "CellCall",
        flowName: call.flowName,
        declaration: call.identity.declaration,
        input: call.input,
        effects: call.effects,
        // See `callMaterial`: the tree a call reads is part of what it asked,
        // and so is which version of the live tree it stood at.
        ...(call.at === undefined ? {} : { at: call.at }),
        ...(call.epoch === undefined ? {} : { epoch: call.epoch }),
        ...(Option.isSome(call.placement) ? { placement: call.placement.value } : {}),
        ...(call.effects.tier === "sealed" ? {} : {
          session: call.identity.session,
          frame: call.identity.frame,
          cell: call.identity.cell,
          ordinal: call.identity.ordinal
        })
      },
      inputs: {},
      layers: [
        ...new Set([
          ...scope.layers,
          ...call.identity.layers,
          // See `sealStep`: each Continue re-issues under a key of its own.
          ...(continued > 0 ? [`timeout-continue:${continued}`] : [])
        ])
      ],
      capabilities: { declared: [...call.capabilities].sort() }
    })
  ).pipe(
    Effect.mapError((cause) =>
      engineFailed(`Cell call ${call.flowName} #${call.identity.ordinal} could not be keyed`, cause)
    )
  )

/**
 * Derives one journaled controller boundary's activity identity.
 *
 * A recorded boundary is never content-addressed — the whole point is that
 * the read is not a pure function — so the key folds in the boundary name,
 * the controller-supplied identity, and the run scope: one recording per
 * boundary per execution, replayed verbatim by any re-execution of the frame.
 */
const boundaryKey = (
  name: string,
  identity: EngineLike.BoundaryIdentity,
  scope: Scope
): Effect.Effect<StepKey.StepKey, HarnessError.HarnessError> =>
  keyed(
    StepKey.content({
      body: {
        _tag: "HarnessBoundary",
        name,
        frame: identity.frame,
        boundary: identity.boundary,
        ...(identity.session === undefined ? {} : { session: identity.session }),
        run: scope.run
      },
      inputs: {},
      layers: scope.layers,
      capabilities: { declared: [] }
    })
  ).pipe(
    Effect.mapError((cause) => engineFailed(`Boundary ${name} could not be keyed`, cause))
  )

/** Public coordinates name the logical run explicitly; the source harness
 * calls it session, which must not be confused with an authentication token. */
const factCall = (call: Cell.Call): CallFact.Call => {
  const { session, ...identity } = call.identity
  // The declaration's display projection travels with the invocation, so the
  // native fact a card reads says what the call meant without the card having
  // to guess from a flow name. `Cell.displayDescriptor` answers `undefined`
  // for a declaration that claimed nothing, and the field is then omitted.
  const descriptor = Cell.displayDescriptor(call)
  return {
    callId: callId(call.identity),
    identity: { runId: session, ...identity },
    flowName: call.flowName,
    input: call.input,
    ...(descriptor === undefined ? {} : { descriptor })
  }
}

/**
 * Constructs the durable harness engine port.
 *
 * `FlowInstance` is per-execution, so this must be built inside a running flow
 * body — the harness layer stack is provided from the flow the harness is the
 * body of. The captured services are supplied back to every activity, which is
 * what keeps the port's streams requirement-free the way `EngineLike` declares
 * them.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (
  options: Options
): Effect.Effect<
  EngineLike.EngineLike,
  never,
  Crypto.Crypto | FlowRuntime.FlowRuntime | FlowRuntime.FlowInstance | Budget.Budget | QuotaPolicy.QuotaClassifier
> =>
  Effect.gen(function*() {
    const instance = yield* FlowRuntime.FlowInstance
    const services: Context.Context<Crypto.Crypto | FlowRuntime.FlowRuntime | FlowRuntime.FlowInstance> = yield* Effect
      .context<
        Crypto.Crypto | FlowRuntime.FlowRuntime | FlowRuntime.FlowInstance
      >()
    // The run scope is read from the execution the port is built inside, not
    // declared by a caller, so it cannot be forgotten or spoofed by one.
    const scope: Scope = {
      layers: [
        ...(options.layers ?? []),
        `flows/agent/composition/v1:${Digest.digest(CanonicalJson.stringify(options.layers ?? []))}`
      ],
      run: `${instance.flow._tag}/${instance.executionId}`
    }
    // The engine pins a sealed content key to its execution unless the
    // composition declares a COMPLETE content environment (issue #75): a key
    // whose authority is unknown is treated as unproven-pure and can never be
    // reused by another run. This port is the composition for layers — it
    // already folds the resolved layer set into every key — so it declares
    // that set unconditionally.
    //
    // Capabilities are the host's to declare, and the port must not invent
    // them: an unconditional `capabilities: {}` here would assert "this
    // composition grants nothing", which is false for every host that holds a
    // capability envelope, and would make a sealed boundary computed under a
    // broad envelope cross-run reusable by a run with an attenuated one — the
    // exact stale-cache class issue #75 exists to close. Omitting the field
    // instead leaves keys run-local until a host supplies `Options.capabilities`,
    // and the environment is now complete-or-absent, so an undeclared envelope
    // means no environment reference at all rather than a partial one.
    const context = options.capabilities === undefined
      ? services
      : Context.merge(
        services,
        Context.make(Action.CurrentCacheEnvironment, {
          layers: scope.layers,
          capabilities: options.capabilities
        })
      )

    // The wait a budget park declared, applied when the frame suspends.
    let parkedOn: FlowRuntime.WaitingAnnotation | undefined
    // The run's timeout guard, read where the controller asks: the host that
    // owns approvals provides `Budget.Parking` around the run it drives.
    const guarding = Effect.map(
      Effect.serviceOption(Budget.Parking),
      (parking) => Option.isSome(parking) && parking.value.guardsTimeouts ? parking.value : undefined
    )
    const parkOn = (parked: Budget.Parked) =>
      Effect.suspend(() => {
        parkedOn = parked.waiting
        return Effect.fail(parked.failure)
      })
    const sealStep = (
      step: EngineLike.SealedModelStep,
      onLive?: (event: ModelEvent.ModelEvent) => Effect.Effect<void>
    ): Stream.Stream<ModelEvent.ModelEvent, Model.ModelFailure | HarnessError.HarnessError> =>
      Stream.unwrap(
        Effect.gen(function*() {
          yield* accountedResume
          const sealed = yield* seal(step, options.route)
          // A guarded host parks an exhausted call timeout instead of failing
          // the run. The timed-out attempt's failure is durable under its key,
          // so each Continue the operator chose re-issues the call under a key
          // of its own, as a capacity cycle does, and Stop replays the failure
          // into the stopped incident without asking a provider again.
          const guard = yield* guarding
          let key = sealed
          if (guard !== undefined) {
            const admitted = yield* guard.admit(sealed)
            if (admitted._tag === "park") return yield* parkOn(admitted.parked)
            if (admitted.continued > 0) {
              key = yield* seal({
                ...step,
                keyMaterial: {
                  ...step.keyMaterial,
                  layers: [...step.keyMaterial.layers, `timeout-continue:${admitted.continued}`]
                }
              }, options.route)
            }
          }
          // The composition's spending ceiling, applied where every model call
          // in the run passes: a step that assembles its own loop cannot evade
          // a budget declared for the whole run. `warn` journals inside the
          // budget itself and falls through here.
          //
          // The sealed key goes with the question, and it has to: the check
          // runs BEFORE the activity below replays, so on a resumed run it is
          // asked about steps whose answers are already journaled and whose
          // replay pays a provider nothing. Unnamed, it projects prior spend
          // plus an estimate for a call the ledger already holds, and a run
          // killed after its last model call resumes straight into
          // `BudgetExceeded` for a call that costs zero.
          const verdict = yield* budget.reserve(key).pipe(Effect.mapError(accountingFailed))
          if (verdict._tag === "refuse" && verdict.failure instanceof Budget.BudgetExceeded) {
            // `park` suspends the run for an operator's raise when the host
            // can take approvals; without one it is a refusal like `fail`.
            const parking = verdict.failure.onExceeded === "park"
              ? yield* Effect.serviceOption(Budget.Parking)
              : Option.none()
            if (Option.isSome(parking)) {
              const parked = yield* parking.value.park(verdict.failure)
              parkedOn = parked.waiting
              return yield* Effect.fail(parked.failure)
            }
          }
          if (verdict._tag === "refuse") {
            return yield* Effect.fail(
              new HarnessError.HarnessError({
                code: "model_failed",
                message: verdict.failure.message,
                // The verdict decides which failure this is: the step that
                // broke the budget reports `BudgetExceeded`, and every call
                // after a `skip-remaining` latch reports `Budget.Skipped`.
                cause: verdict.failure
              })
            )
          }
          // Read OUTSIDE the activity, from the caller's context: the ladder
          // rung is the caller's fact about this call, and it has to be on the
          // record the activity writes rather than discovered by whatever
          // re-executes it.
          const correction = yield* Correction
          const recorded = yield* Action.make({
            name: sealStepActivityName,
            success: RecordedModelStep,
            error: ModelFailure,
            tier: "sealed",
            idempotencyKey: key,
            execute: Effect.suspend(() => {
              let reported: ModelEvent.Usage | undefined
              return Effect.gen(function*() {
                // This names an actual, unsealed invocation, not the logical
                // sealed key. A retry after capacity refusal is fresh provider
                // work; charging it under `key` would mark every later retry
                // paid and bypass admission. Allocate before dispatch, and keep
                // the identity fixed through accounting's transaction retries.
                const receipt = yield* crypto.randomUUIDv4.pipe(
                  Effect.mapError((cause) => engineFailed("Could not allocate a model usage receipt", cause))
                )
                return yield* recordModelStep(
                  options.model,
                  step.request,
                  options.modelRetryPolicy ?? defaultModelRetryPolicy,
                  step.modelCallMs,
                  correction,
                  (usage) => {
                    reported = usage
                  },
                  onLive
                ).pipe(
                  Effect.flatMap(unlessParked(quota)),
                  Effect.flatMap(unlessGuarded(guard !== undefined)),
                  // The normal sealed result is accounted below, including on
                  // replay. This finalizer covers only exits that cannot seal.
                  // It runs uninterruptibly before releasing the reservation;
                  // a failed write remains pending and blocks fresh admission.
                  Effect.onExit((exit) =>
                    Exit.isFailure(exit) && reported !== undefined
                      ? budget.record(`unsealed-model/${key}/${receipt}`, reported, step.request.modelId).pipe(
                        Effect.mapError(accountingFailed)
                      )
                      : Effect.void
                  )
                )
              })
            })
          }).pipe(
            Effect.catchIf(
              (error): error is ModelError.ModelError =>
                guard !== undefined && error instanceof ModelError.ModelError && error.code === "call_timeout",
              (error) =>
                guard!.trip(
                  new RunawayGuard.Timeout({
                    source: "model-call",
                    subject: sealed,
                    limitMillis: step.modelCallMs,
                    message: error.message
                  })
                ).pipe(Effect.flatMap(parkOn))
            )
          )
          const normalized = normalizeRecordedModelStep(recorded)
          // Accounted after the step settles. The accumulator is keyed by the
          // step key, so a step whose body really did re-run counts once, and
          // a resumed run folds back what it recorded before the restart from
          // the budget's own durable usage records.
          yield* budget.record(key, ModelEvent.ModelEvent.settledMessage(normalized.events).usage, step.request.modelId)
            .pipe(
              Effect.mapError(accountingFailed)
            )
          const replay = Stream.fromIterable(normalized.events)
          return normalized.error === undefined
            ? replay
            : Stream.concat(replay, Stream.fail(normalized.error))
        }).pipe(Effect.scoped, Effect.provide(context))
      )

    const sealStepWithEvents: EngineLike.EngineLike["sealStepWithEvents"] = (step) =>
      Stream.callback<ModelEvent.ModelEvent, Model.ModelFailure | HarnessError.HarnessError>((queue) => {
        let live = false
        let settlement: ModelEvent.ModelEvent | undefined
        return Effect.onExit(
          Stream.runCollect(sealStep(step, (event) => {
            live = true
            if (event.type === "settle") {
              settlement = event
              return Effect.void
            }
            return Queue.offer(queue, event).pipe(Effect.asVoid)
          })).pipe(Effect.flatMap((recorded) =>
            live
              ? Effect.gen(function*() {
                const usage = [...recorded].filter((event) => event.type === "usage").at(-1)
                if (usage !== undefined) yield* Queue.offer(queue, usage)
                yield* Queue.offer(queue, settlement!)
              })
              : Effect.forEach(recorded, (event) => Queue.offer(queue, event), { discard: true })
          )),
          (exit) => Effect.asVoid(exit._tag === "Success" ? Queue.end(queue) : Queue.failCause(queue, exit.cause))
        )
      })

    const splice = (batch: Plan.Batch): Stream.Stream<Plan.SpliceEvent, HarnessError.HarnessError> =>
      Stream.fromIterable(batch.children).pipe(
        Stream.mapEffect((child) => Effect.fail(engineFailed("No child runner is configured", child.flowName)))
      )

    // Calls `admit` authorized and `call` has not yet issued, by identity.
    const admitted = new Set<string>()
    // How many times the operator chose Continue for a timed-out cell call,
    // by its guard subject, as this drive's guard admitted it.
    const continuedCalls = new Map<string, number>()
    const admission = (request: Cell.Call): string => JSON.stringify(request.identity)

    /**
     * Authorizes a call before the controller starts its per-call clock.
     *
     * A denial is the cell's to read, as `capability_refused` carrying the
     * hook's own message: a person or a policy said no, and the run goes on
     * without that effect. The code set is part of the sealed call key, so a
     * denial reuses an existing code rather than adding one; the host tells its
     * own denials apart by the message it wrote. A park and every other failure
     * still escape, so the run parks or fails exactly as it would from `call`.
     */
    const authorize = options.calls?.authorize
    const admit = authorize === undefined ? undefined : (
      request: Cell.Call
    ): Effect.Effect<Cell.CallResult | undefined, HarnessError.HarnessError> =>
      authorize(request).pipe(
        Effect.tap(() => Effect.sync(() => admitted.add(admission(request)))),
        Effect.as(undefined),
        Effect.catchIf(
          (error) => error.cause instanceof Permission.PermissionDenied,
          (error) =>
            Effect.succeed(
              new Cell.CallResult({
                outcome: "failure",
                value: null,
                code: "capability_refused",
                message: error.message
              })
            )
        )
      )

    const call = (
      request: Cell.Call
    ): Effect.Effect<Cell.CallResult, HarnessError.HarnessError> =>
      Effect.gen(function*() {
        yield* accountedResume
        const decoded = yield* Effect.fromResult(Schema.decodeUnknownResult(Cell.Call)(request)).pipe(
          Effect.mapError((cause) =>
            engineFailed(
              `Cell call ${request.flowName} #${request.identity.ordinal} is not serializable`,
              cause
            )
          )
        )
        const calls = options.calls
        if (calls === undefined) {
          return yield* Effect.fail(engineFailed("No cell-call runner is configured", decoded.flowName))
        }
        // A call `admit` already authorized is not asked twice: a grant a
        // person gave once would otherwise be requested again here.
        if (calls.authorize !== undefined && !admitted.delete(admission(decoded))) yield* calls.authorize(decoded)
        // A call the operator continued past its timeout runs again: its
        // timed-out attempt may have settled durably under the earlier key.
        const key = yield* callKey(decoded, scope, continuedCalls.get(EngineLike.callSubject(decoded.identity)) ?? 0)
        return yield* Action.make({
          name: cellCallActivityName(decoded.flowName),
          success: Cell.CallResult,
          error: HarnessError.HarnessError,
          tier: decoded.effects.tier,
          idempotencyKey: key,
          metadata: callBoundary(decoded),
          annotations: Context.make(CallFact.Annotation, {
            phase: "invoked",
            call: factCall(decoded)
          }),
          // Admission is separate from the schema whose representation is
          // durable key material. Validate before persistence, including
          // instances a host mutated after construction, with a typed cause.
          execute: calls.run(decoded).pipe(Effect.tap(Cell.decodeCallResult))
        })
      }).pipe(Effect.provide(context))

    const record = <A>(
      boundary: EngineLike.RecordBoundary<A>
    ): Effect.Effect<A, HarnessError.HarnessError> =>
      Effect.gen(function*() {
        yield* accountedResume
        const key = yield* boundaryKey(boundary.name, boundary.identity, scope)
        // `irreversible` is the honest tier: the read is not
        // content-addressable and cannot be undone, only recorded — so the
        // boundary is journaled under its run-scoped key and a replayed frame
        // is served the recorded value instead of reading the world again.
        const value = yield* Action.make({
          name: boundaryActivityName(boundary.name),
          success: boundary.success,
          error: HarnessError.HarnessError,
          tier: "irreversible",
          idempotencyKey: key,
          ...(boundary.name !== "cell-call" || boundary.call === undefined ? {} : {
            annotations: Context.make(CallFact.Annotation, {
              phase: "settled",
              call: factCall(boundary.call)
            })
          }),
          execute: boundary.execute
        })
        // What a boundary paid a model for, such as a completion judge's
        // reading, is the run's spend like any sealed step's (#2681). It is
        // read off the recorded value and accounted under the boundary's own
        // key after the record settles, live or replayed, so the ledger holds
        // it exactly once and the next paid call is admitted against it.
        const paid = boundary.usage?.(value)
        if (paid !== undefined) {
          yield* budget.record(`${boundaryUsagePrefix}${key}`, paid).pipe(Effect.mapError(accountingFailed))
        }
        return value
      }).pipe(Effect.provide(context))

    // Resolved once, at construction, and asked nothing further. A composition
    // either equips its runs with a way to measure their workspace or it does
    // not, and the controller reads the absence as "unobserved" and says so in
    // the journal rather than presenting declared writes as measurements.
    const observer = yield* Effect.serviceOption(WorkspaceObservation.Observer)
    const quota = yield* QuotaPolicy.current
    const budget = yield* Budget.current
    // A port is built when the run is driven, so a suspension the run recorded
    // ends here rather than at its next model call. A replayed model step
    // never reaches admission, so a resume that was not recorded would leave
    // the span open over live cell and tool work and subtract that work as
    // parked time. Accounting fails closed: until the resume is recorded, at
    // the instant the run actually resumed, the port does no work.
    const logSuspension = (message: string) => (cause: Cause.Cause<Budget.AccountingUnavailable>) =>
      Effect.logWarning(message, cause)
    const resumedAt = yield* Clock.currentTimeMillis
    let resumed = Exit.isSuccess(
      yield* budget.resume(resumedAt).pipe(
        Effect.tapCause(logSuspension("A budget resume could not be recorded")),
        Effect.exit
      )
    )
    const accountedResume: Effect.Effect<void, HarnessError.HarnessError> = Effect.suspend(() =>
      resumed ? Effect.void : budget.resume(resumedAt).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            resumed = true
          })
        ),
        Effect.mapError(accountingFailed)
      )
    )
    const crypto = yield* Crypto.Crypto
    const observe = Option.match(observer, {
      onNone: (): Effect.Effect<Option.Option<EngineLike.Observation>, HarnessError.HarnessError> =>
        Effect.succeed(Option.none()),
      onSome: (service) => Effect.asSome(service.observe)
    })

    // Resolved once for the same reason the observer is: a composition either
    // equips its runs with somewhere to pin a tree or it does not, and the
    // controller reads the absence as a catchable refusal the cell can route
    // around rather than as a failed run.
    const store = yield* Effect.serviceOption(Checkpoints.Checkpoints)
    const capture = Option.match(store, {
      onNone: () =>
      (
        _request: EngineLike.CaptureRequest
      ): Effect.Effect<Option.Option<EngineLike.Snapshot>, HarnessError.HarnessError> => Effect.succeed(Option.none()),
      onSome: (checkpoints) => (request: EngineLike.CaptureRequest) =>
        checkpoints.capture(request.id).pipe(
          Effect.map((snapshot) => Option.some(new EngineLike.Snapshot({ id: snapshot.id, ref: snapshot.ref }))),
          // A store that failed is reported to the cell as "nothing was
          // pinned", because that is what happened and the cell can act on it.
          // The reason the store gave is not thrown away: it is logged, so a
          // run whose checkpoints never work says why in its own log rather
          // than only in the shape of what it stopped doing.
          Effect.catchCause((cause) =>
            Effect.as(
              Effect.annotateLogs(Effect.logWarning("A checkpoint could not be pinned", cause), {
                checkpoint: request.id
              }),
              Option.none<EngineLike.Snapshot>()
            )
          )
        )
    })

    // What this port does to a request on its way out is nothing, so the
    // request is the one it was handed; the route is the two names of it, read
    // off the same credential-free view the sealed key digests. A request no
    // route accepts resolves to none, so no record says it was sent, and it
    // fails where it always did, in `sealStep`, with the route's typed error:
    // this is the record of a call, not a second place for the call to fail.
    const resolve = (request: ModelRequest.ModelRequest): Effect.Effect<Option.Option<EngineLike.Resolved>> =>
      options.route.prepare(request).pipe(
        Effect.map((prepared) =>
          Option.some({
            request,
            binding: Option.some(
              new EngineLike.Binding({ routeId: prepared.routeId, protocolId: prepared.protocolId })
            )
          })
        ),
        Effect.orElseSucceed(() => Option.none<EngineLike.Resolved>())
      )

    const guard: EngineLike.Guard = {
      admit: (subject) =>
        Effect.gen(function*() {
          const parking = yield* guarding
          if (parking === undefined) return
          const admitted = yield* parking.admit(subject)
          if (admitted._tag === "park") return yield* parkOn(admitted.parked)
          if (admitted.continued > 0) continuedCalls.set(subject, admitted.continued)
        }),
      trip: (timeout) =>
        Effect.gen(function*() {
          const parking = yield* guarding
          if (parking === undefined) return
          return yield* parkOn(yield* parking.trip(new RunawayGuard.Timeout(timeout)))
        })
    }

    return EngineLike.make({
      sealStep,
      sealStepWithEvents,
      splice,
      call,
      guard,
      ...(admit === undefined ? {} : { admit }),
      record,
      observe,
      capture,
      resolve,
      suspend: (reason) =>
        Effect.annotateLogs(Effect.logDebug("Harness parked the engine frame"), {
          code: reason.code,
          reason: reason.message
        }).pipe(
          // Parked time is not active time. Without the record the run is
          // charged the wait, the conservative side, so it is logged.
          Effect.andThen(
            budget.suspend.pipe(Effect.catchCause(logSuspension("A budget suspension could not be recorded")))
          ),
          Effect.andThen(Effect.suspend(() => {
            if (parkedOn !== undefined) {
              instance.waiting = parkedOn
              parkedOn = undefined
            }
            return Flow.suspend(instance)
          }))
        )
    })
  })

/**
 * Provides the durable harness engine port.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = (
  options: Options
): Layer.Layer<
  EngineLike.EngineLike,
  never,
  | FlowRuntime.FlowRuntime
  | FlowRuntime.FlowInstance
  | Crypto.Crypto
  // Carried, not defaulted. The port reads both services outright, so a
  // composition that provides neither cannot build this layer at all: the
  // spending ceiling and the quota policy are decisions a host makes, and the
  // type is what stops one being made by omission.
  | Budget.Budget
  | QuotaPolicy.QuotaClassifier
> => Layer.effect(EngineLike.EngineLike)(make(options))
