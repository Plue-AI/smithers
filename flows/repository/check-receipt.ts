/** The reserved CI receipt Plue's landing gate reads, re-derived from durable native state. */
import { ControlRuntime } from "@smthrs/control/ControlRuntime"
import * as Digest from "@smthrs/core/Digest"
import { DurableEngineState } from "@smthrs/engine-store"
import * as RunStore from "@smthrs/run-store/RunStore"
import { Cause, Context, Effect, Layer, Option, Schedule, Schema, Stream } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest, type HttpClientResponse } from "effect/unstable/http"
import { ModuleOwner } from "../../packages/smithers/src/internal/ModuleOwner.ts"
import { ChangeId, Resolved, SourcePublication } from "../coding/native-schema.ts"
import { CodingError } from "../coding/schema.ts"
import { CheckOutput, CheckStep } from "./checks.ts"
import { CiPolicy, type CiPolicyRef, rawCheckId } from "./ci-policy.ts"
import { finalCheckWork, type Work } from "./jobs.ts"
import { ownedAncestry } from "./receipts.ts"
import { JobInput, StepResult } from "./schema.ts"

const invalid = (message: string) => new CodingError({ code: "invalid_receipt", message })
const unavailable = (message: string) => new CodingError({ code: "unavailable", message })
const replaced = (message: string) => new CodingError({ code: "stale_revision", message })
const uncovered = (message: string) => new CodingError({ code: "fast_gate", message })
/** One instance, so the bounded retry recognises exactly this refusal. */
const unverifiedRun = unavailable(
  "Plue has not yet retained the run id for this repository job dispatch; its worker records it on retry"
)
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
const CommitId = Resolved.fields.commitId, Uuid = SourcePublication.fields.requestId
const PositiveId = Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER))
const Sha256 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/))
export const CheckOutcome = Schema.Struct({
  id: Schema.NonEmptyString.check(Schema.isMaxLength(100)),
  outcome: Schema.Literals(["passed", "skipped_no_matching_paths"])
})
export const CheckReceiptRequest = Schema.Struct({
  repo: Schema.NonEmptyString,
  workspace_id: Uuid,
  registration_id: Uuid,
  revision: PositiveId,
  digest: Sha256,
  execution_digest: Sha256,
  run_id: Schema.NonEmptyString,
  execution_id: Schema.NonEmptyString,
  commit_id: CommitId,
  change_id: ChangeId,
  base_commit_id: CommitId,
  checks: Schema.Array(CheckOutcome).check(Schema.isMaxLength(200)),
  gate: Schema.Literal("passed")
})
export const CheckReceipt = Schema.Struct({
  request_id: Uuid,
  context: Schema.NonEmptyString.check(Schema.isMaxLength(255)),
  commit_id: CommitId,
  status: Schema.Literal("success"),
  status_id: PositiveId
})
export class RepositoryCheckReceipts extends Context.Service<RepositoryCheckReceipts, {
  readonly report: (
    requestId: string,
    input: typeof CheckReceiptRequest.Type
  ) => Effect.Effect<typeof CheckReceipt.Type, CodingError>
}>()("repository/CheckReceipts") {}

/** An absent pinned policy is authoritative "no policy"; an unreadable one is an error. */
export const pinnedPolicy = (work: unknown): Effect.Effect<CiPolicy, CodingError> =>
  record(work).policy === undefined ?
    Effect.succeed({ kind: "none" as const })
    : Schema.decodeUnknownEffect(CiPolicy)(record(work).policy).pipe(
      Effect.mapError(() => invalid("The pinned repository CI policy is unreadable; inspect this job before landing"))
    )

/** Trusted provisioned gateway binding, never workflow or model input. */
export interface Options {
  readonly apiBaseUrl: string
  readonly gatewayId: string
  readonly credential: string
  readonly repositorySlug: string
  readonly workspaceId: string
  /** Plue refuses a truthful receipt while its own dispatch row is still
   * missing the run id; that window closes on its worker's own retry. */
  readonly unverifiedRunRetryMs?: number
}

const maximumBodyBytes = 256 * 1024
const readJson = (response: HttpClientResponse.HttpClientResponse) =>
  Effect.gen(function*() {
    const declared = response.headers["content-length"]
    if (
      declared !== undefined &&
      (!/^\d+$/.test(declared) || !Number.isSafeInteger(Number(declared)) || Number(declared) > maximumBodyBytes)
    ) {
      return yield* invalid("The CI receipt response exceeds its bounded size")
    }
    const decoder = new TextDecoder("utf-8", { fatal: true })
    const captured = yield* Stream.runFoldEffect(response.stream, () => ({ bytes: 0, text: "" }), (state, chunk) =>
      Effect.try({
        try: () => {
          if (state.bytes + chunk.length > maximumBodyBytes) {
            throw new Error("bound")
          }
          return { bytes: state.bytes + chunk.length, text: state.text + decoder.decode(chunk, { stream: true }) }
        },
        catch: () =>
          invalid("The CI receipt response is invalid or exceeds its bounded size")
      })).pipe(Effect.mapError((error) =>
        error instanceof CodingError ? error : unavailable("The CI receipt response could not be read")
      ))
    return yield* Effect.try({
      try: () =>
        JSON.parse(captured.text + decoder.decode()) as unknown,
      catch: () =>
        invalid("The CI receipt store returned no valid JSON receipt")
    })
  })

/** The gateway credential proves this workspace, never the repository landing token. */
export const make = (options: Options) =>
  Effect.gen(function*() {
    const client = yield* HttpClient.HttpClient
    const url = yield* Effect.try({
      try: () => new URL(options.apiBaseUrl),
      catch: () => unavailable("The CI receipt binding is invalid")
    })
    if (
      !/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash ||
      !url.pathname.endsWith("/api") || options.apiBaseUrl !== url.href.replace(/\/$/, "") ||
      !Schema.is(Uuid)(options.gatewayId) || !Schema.is(Uuid)(options.workspaceId) ||
      !options.credential.trim() || /[\r\n]/.test(options.credential)
    ) {
      return yield* unavailable("The CI receipt requires the exact provisioned gateway, API and credential binding")
    }
    const delay = Math.min(Math.max(options.unverifiedRunRetryMs ?? 12_000, 1), 15_000)
    const report = (requestId: string, input: typeof CheckReceiptRequest.Type) =>
      Effect.gen(function*() {
        const body = yield* Schema.encodeEffect(CheckReceiptRequest)(input).pipe(
          Effect.mapError(() => invalid("The CI receipt does not name an exact checked source"))
        )
        if (!Schema.is(Uuid)(requestId)) return yield* invalid("The CI receipt needs a stable request identity")
        const response = yield* HttpClient.withScope(client).execute(
          HttpClientRequest.put(
            `${options.apiBaseUrl}/gateways/${options.gatewayId}/repository-jobs/ci/check-receipts/${requestId}`
          ).pipe(
            (request) => HttpClientRequest.bodyJsonUnsafe(request, body as object),
            HttpClientRequest.bearerToken(options.credential),
            HttpClientRequest.acceptJson
          )
        )
          .pipe(Effect.mapError(() =>
            unavailable("The CI receipt store could not be reached; retry the same durable request")
          ))
        if (response.status !== 200 && response.status !== 201) {
          // Only the machine-readable refusal code is read back; remote prose never
          // reaches this host, and the status alone names every other cause.
          if (response.status === 409) {
            return yield* replaced(
              "The pinned repository CI policy changed before this receipt; replan under the current policy"
            )
          }
          if (response.status === 404) {
            return yield* replaced("The pinned repository CI policy no longer exists; replan under the current policy")
          }
          if (response.status === 422) {
            return yield* uncovered("The checked results do not cover every required repository CI check")
          }
          if (response.status === 503) {
            return yield* unavailable("The CI receipt store is unavailable; retry the same durable request")
          }
          if (response.status === 403) {
            const refusal = yield* readJson(response).pipe(Effect.orElseSucceed(() =>
              null
            ))
            if (record(refusal).code === "repository_ci_run_unverified") return yield* unverifiedRun
          }
          return yield* invalid(`The CI receipt was refused for this workspace binding (HTTP ${response.status})`)
        }
        const receipt = yield* readJson(response).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(CheckReceipt)),
          Effect.mapError((error) =>
            error instanceof CodingError ? error : invalid("The CI receipt does not match the required protocol")
          )
        )
        if (
          receipt.request_id !== requestId || receipt.commit_id !== input.commit_id ||
          receipt.context !== `repository-ci/${input.registration_id}@${input.revision}.${input.digest.slice(0, 12)}`
        ) {
          return yield* invalid("The CI receipt identifies another request, source or policy")
        }
        return receipt
      }).pipe(
        Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
        Effect.scoped,
        Effect.retry({
          times: 4,
          schedule: Schedule.spaced(`${delay} millis`),
          while: (error) => error === unverifiedRun
        }),
        Effect.timeoutOrElse({
          duration: "120 seconds",
          orElse: () =>
            Effect.fail(
              unavailable("The CI receipt store exceeded its request deadline; retry the same durable request")
            )
        }),
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause)
          const error = Cause.squash(cause)
          return Effect.fail(
            error instanceof CodingError
              ? error
              : unavailable("The CI receipt request failed before a receipt could be verified")
          )
        })
      )
    return RepositoryCheckReceipts.of({ report })
  })
export const layer = (options: Options) => Layer.effect(RepositoryCheckReceipts)(make(options))

export interface VerifiedCheckStep {
  readonly runId: string
  readonly executionId: string
  readonly candidate: string
  readonly checks: ReadonlyArray<typeof CheckOutcome.Type>
}
/** The pinned policy of the delivering job owns the mapping: only a result with
 * exactly one reviewed rule behind it reaches the reserved CI receipt. A local
 * check belongs to the native gate alone — Plue stores no id for it — so it is
 * never listed here and can never stand in for a required reviewed rule. */
const outcomes = (
  output: typeof CheckOutput.Type,
  ref: CiPolicyRef,
  reviewed: ReadonlyArray<{ readonly id: string }>
) => {
  const checks: Array<typeof CheckOutcome.Type> = [], inherited = new Set<string>()
  for (const result of output.results) {
    const id = rawCheckId(ref, reviewed, result.checkId)
    if (id === undefined) continue
    const outcome = result.status === "passed" ?
      "passed" as const
      : result.status === "skipped" &&
          !output.results.some((other) =>
            other.policy === "required" && (other.status === "failed" || other.status === "error")
          ) ?
      "skipped_no_matching_paths" as const
      : undefined
    if (outcome === undefined) continue
    checks.push({ id, outcome })
    inherited.add(id)
  }
  // A pinned policy may be entirely advisory: a failed report rule is neither
  // passed nor out of scope, so honest coverage is empty and still attests the
  // gate for this exact commit and policy identity.
  if (checks.length > 200 || new Set(checks.map((check) => check.id)).size !== checks.length) {
    throw invalid("The checked results carry no unique bounded check identities")
  }
  for (const required of ref.requiredCheckIds) {
    if (!inherited.has(required)) {
      throw uncovered(`Required repository CI check ${required} has no passed or out-of-scope result`)
    }
  }
  return checks
}

/** Proof comes from the same durable ownership reader the completed-job
 * receipts use, relaxed only where a job waiting to land must be: its own
 * ancestry and control root are still running. The checked step's payload is
 * the exact Work this delivery reconstructs, so no claimed identity is taken
 * from the step output the delivering job happens to be carrying. */
export const verifiedCheckStep = (
  input: {
    readonly executionId: string
    readonly commitId: string
    readonly baseCommitId: string
    readonly work: typeof Work.Type
    readonly source: unknown
    readonly ref: CiPolicyRef
    readonly checks: ReadonlyArray<{ readonly id: string }>
  }
) =>
  Effect.gen(function*() {
    const connected = yield* Effect.all([
      Effect.serviceOption(RunStore.RunStore),
      Effect.serviceOption(DurableEngineState.DurableEngineState),
      Effect.serviceOption(ControlRuntime)
    ])
    if (Option.isNone(connected[0]) || Option.isNone(connected[1]) || Option.isNone(connected[2])) {
      return yield* unavailable("The check receipt stores are not connected to this host")
    }
    // The approved control identity of the delivery that is asking to land, from
    // the host's own composition state rather than anything the receipt claims.
    const owner = yield* Effect.serviceOption(ModuleOwner)
    if (Option.isNone(owner)) {
      return yield* unavailable("This host supplies no approved control owner for the delivering job")
    }
    const bridge = `repository-jobs/${input.work.job}`
    // The producer's own construction, never a second derivation of it.
    const payload = {
      work: finalCheckWork(input.work, {
        head: input.source as typeof Work.Type["evidence"]["source"],
        base: input.baseCommitId
      })
    }
    const proof = yield* ownedAncestry({
      executionId: input.executionId,
      flow: CheckStep._tag,
      bridge,
      payload,
      payloadSchema: CheckStep.payloadSchema,
      success: StepResult,
      error: CodingError,
      dispatched: false,
      ancestors: (status) => status !== "failed" && status !== "cancelled"
    }).pipe(
      Effect.provideService(RunStore.RunStore, connected[0].value),
      Effect.provideService(DurableEngineState.DurableEngineState, connected[1].value),
      Effect.provideService(ControlRuntime, connected[2].value)
    )
    if (proof.run.cancellation !== undefined) {
      return yield* invalid("The checked execution's control run is being stopped")
    }
    if (proof.run.runId !== owner.value.rootId || owner.value.flowId !== bridge) {
      return yield* invalid("The checked execution was approved under another delivery's control root")
    }
    const job = Schema.decodeUnknownOption(JobInput)(proof.input)
    if (
      Option.isNone(job) || job.value.repo !== input.work.repo || job.value.job !== input.work.job ||
      job.value.event.source !== input.work.event.source ||
      job.value.event.deliveryKey !== input.work.event.deliveryKey ||
      job.value.configuration.landing !== input.work.landing ||
      job.value.configuration.replies !== input.work.replies ||
      !job.value.configuration.steps.some((step) => Digest.canonical(step) === Digest.canonical(input.work.step))
    ) {
      return yield* invalid("The checked execution belongs to another repository job dispatch")
    }
    const output = Schema.decodeUnknownOption(CheckOutput)(proof.output.output)
    if (
      Option.isNone(output) || output.value.gate !== "passed" || output.value.candidate !== input.commitId ||
      output.value.base !== input.baseCommitId
    ) {
      return yield* invalid("The durable check result does not pass on this exact delivered source and base")
    }
    const checks = yield* Effect.try({
      try: () => outcomes(output.value, input.ref, input.checks),
      catch: (error) => error instanceof CodingError ? error : invalid("The durable check results could not be read")
    })
    return {
      runId: proof.run.runId,
      executionId: input.executionId,
      candidate: output.value.candidate,
      checks
    } satisfies VerifiedCheckStep
  }).pipe(Effect.mapError((error) =>
    error instanceof CodingError ?
      error
      : error instanceof RunStore.RunStoreError && error.code === "not_found_row"
      ? invalid("The claimed check execution or its ancestry is not retained by this host")
      : unavailable("The check receipt stores are unavailable; retry the same durable request")
  ))
