/** Proof comes from this host's existing approved control and engine ancestry. */
import { ControlRuntime } from "@smthrs/control/ControlRuntime"
import * as Digest from "@smthrs/core/Digest"
import { DurableEngineState } from "@smthrs/engine-store"
import * as RunCatalogRead from "@smthrs/engine-store/RunCatalogRead"
import { RunState } from "@smthrs/engine-store/RunState"
import { Flow } from "@smthrs/flow"
import * as RunStore from "@smthrs/run-store/RunStore"
import { Effect, Exit, Option, Schema } from "effect"
import { CodingError } from "../coding/schema.ts"
import { verifyTrialChecks } from "./checks.ts"
import { RepositoryJob } from "./jobs.ts"
import { JobInput, JobResult, OperationResult, SetupInput } from "./schema.ts"

const invalid = (message: string) => new CodingError({ code: "invalid_receipt", message })
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
/** The one definition of an owned native result: the bounded store read, the
 * ancestry walk, and every identity binding between the proven execution, its
 * registered bridge dispatch and its approved control root. Callers vary only
 * in which ancestor statuses they accept and whether the proven execution's own
 * payload is the dispatched input; a step still inside a running job is not. */
export const ownedAncestry = <
  S extends Schema.Top & { readonly DecodingServices: never },
  E extends Schema.Top & { readonly DecodingServices: never },
  P extends Schema.Top & { readonly EncodingServices: never }
>(
  options: {
    readonly executionId: string
    readonly flow: string
    readonly bridge: string
    readonly payload: unknown
    readonly payloadSchema: P
    readonly success: S
    readonly error: E
    readonly ancestors: (status: string) => boolean
    readonly dispatched: boolean
  }
) =>
  Effect.gen(function*() {
    const store = yield* RunStore.RunStore,
      graph = yield* DurableEngineState.DurableEngineState,
      control = yield* ControlRuntime
    // The run driver stores every payload through the flow's own JSON codec, so
    // the expectation is compared in that stored form and never in its decoded
    // one; a field the schema does not declare is absent from both sides.
    const expected = Schema.encodeUnknownOption(Schema.toCodecJson(options.payloadSchema))(options.payload)
    if (Option.isNone(expected)) return yield* invalid("The expected receipt input does not fit its claimed flow")
    let bytes = 0
    const read = (id: string, selected: boolean) =>
      Effect.gen(function*() {
        const row = yield* store.get(id)
        bytes += row.stateJson.length
        if (
          row.runId !== id || !(selected ? row.status === "completed" : options.ancestors(row.status)) ||
          row.stateJson.length > 8 * 1024 * 1024 || bytes > 24 * 1024 * 1024
        ) return yield* invalid("The completed receipt or its ancestry is unavailable")
        const state = Schema.decodeUnknownOption(Schema.fromJsonString(RunState))(row.stateJson)
        if (Option.isNone(state) || state.value.cancellation !== undefined) {
          return yield* invalid("The receipt has invalid or cancelled native state")
        }
        return { row, state: state.value }
      })
    const selected = yield* read(options.executionId, true)
    if (
      selected.state.flowName !== options.flow ||
      Digest.canonical(selected.state.payload) !== Digest.canonical(expected.value)
    ) return yield* invalid("The receipt does not match its claimed flow and input")
    const result = Schema.decodeUnknownOption(
      Schema.toCodecJson(Flow.Result({ success: options.success, error: options.error }))
    )(selected.state.result)
    if (
      Option.isNone(result) || result.value._tag !== "Complete" || Exit.isFailure(result.value.exit)
    ) return yield* invalid("The native flow did not complete successfully")
    const visited = new Set<string>()
    let id = options.executionId, bridged = false, input: unknown = undefined
    while (visited.size < 128) {
      if (visited.has(id)) return yield* invalid("Native receipt ancestry contains a cycle")
      visited.add(id)
      const entry = id === options.executionId ? selected : yield* read(id, false)
      if (entry.state.flowName === options.bridge) {
        if (
          bridged ||
          (options.dispatched &&
            Digest.canonical(record(entry.state.payload).input) !== Digest.canonical(expected.value))
        ) return yield* invalid("The registered bridge does not match the receipt")
        bridged = true
        input = record(entry.state.payload).input
      }
      const parents = yield* graph.runParents(id)
      const root = yield* control.getRun(id).pipe(
        Effect.map(Option.some),
        Effect.catchTag("/control/RunNotFound", () => Effect.succeedNone)
      )
      if (Option.isSome(root)) {
        const run = root.value
        if (
          !bridged || parents.length !== 0 || entry.state.parentExecutionId !== undefined ||
          entry.state.flowName !== "agent/run" ||
          !options.ancestors(run.status) || run.flowId !== options.bridge || !run.planId ||
          record(entry.state.payload).planId !== run.planId
        ) return yield* invalid("The receipt has no single completed control owner")
        const plan = yield* control.getPlan(run.planId)
        if (
          plan.decision !== "approved" || run.planDigest !== plan.card.digest || plan.card.flowId !== options.bridge ||
          Digest.canonical(plan.decodedInput) !== Digest.canonical(options.dispatched ? expected.value : input)
        ) return yield* invalid("The receipt differs from its approved input")
        return { output: result.value.exit.value, run, plan, input }
      }
      if (parents.length > 1) return yield* invalid("The receipt has ambiguous native ownership")
      const parent = parents[0]?.parentId ?? entry.row.parentRunId
      if (
        !parent || (entry.state.parentExecutionId !== undefined && entry.state.parentExecutionId !== parent)
      ) return yield* invalid("The receipt has no retained native owner")
      id = parent
    }
    return yield* invalid("The receipt ancestry exceeds its bounded lookup")
  })
export const readOwnedResult = <
  S extends Schema.Top & { readonly DecodingServices: never },
  E extends Schema.Top & { readonly DecodingServices: never },
  P extends Schema.Top & { readonly EncodingServices: never }
>(
  executionId: string,
  flow: string,
  bridge: string,
  payload: unknown,
  payloadSchema: P,
  success: S,
  error: E
) =>
  ownedAncestry({
    executionId,
    flow,
    bridge,
    payload,
    payloadSchema,
    success,
    error,
    ancestors: (status) => status === "completed",
    dispatched: true
  })

export const priorSetupReceipt = (input: SetupInput, operation: "evaluate" | "trial") =>
  Effect.gen(function*() {
    const catalog = yield* RunCatalogRead.RunCatalogRead, store = yield* RunStore.RunStore
    const page = yield* catalog.listRuns({ filters: { flowName: "repository/Setup" }, limit: 100 })
    for (const candidate of page.runs) {
      const row = yield* store.get(candidate.runId)
      if (row.status !== "completed" || row.stateJson.length > 8 * 1024 * 1024) continue
      const state = Schema.decodeUnknownOption(Schema.fromJsonString(RunState))(row.stateJson)
      if (Option.isNone(state)) continue
      const payload = Schema.decodeUnknownOption(SetupInput)(state.value.payload)
      if (
        Option.isNone(payload) || payload.value.repo !== input.repo || payload.value.job !== input.job ||
        payload.value.digest !== input.digest ||
        payload.value.revision !== input.revision || payload.value.operation !== operation
      ) continue
      const proof = yield* readOwnedResult(
        candidate.runId,
        "repository/Setup",
        "repository/setup",
        payload.value,
        SetupInput,
        OperationResult,
        CodingError
      )
      const receipt = proof.output.receipt
      if (
        receipt?.phase === "completed" && receipt.operation === operation && receipt.digest === input.digest &&
        receipt.revision === input.revision && receipt.runId === proof.run.runId
      ) {
        if (operation === "trial") {
          const runs = receipt.evidence.filter((ref) => ref.startsWith("run:")).map((ref) => ref.slice(4))
          if (runs.length !== 1 || !runs[0] || !receipt.trialIssue || !receipt.sourceRevision) {
            return yield* invalid("The trial has no single retained live job")
          }
          const job = yield* completedJob(runs[0], { ...input, sourceRevision: receipt.sourceRevision }, {
            source: receipt.trialIssue.source,
            issueNumber: receipt.trialIssue.number,
            trial: true
          })
          if (!job || !receipt.evidence.includes(`execution:${job.executionId}`)) {
            return yield* invalid("The trial's actual job result is unavailable")
          }
        }
        return receipt
      }
    }
    return yield* invalid(
      `Run ${operation === "evaluate" ? "evals" : "the live trial"} for this exact candidate before continuing`
    )
  })

export const completedJob = (
  runId: string,
  input: Pick<JobInput, "repo" | "job" | "revision" | "digest"> & { sourceRevision?: string },
  event: {
    source: "github" | "smithers-cloud"
    issueNumber: number
    deliveryKey?: string
    manualStep?: string
    trial?: boolean
  }
) =>
  Effect.gen(function*() {
    const control = yield* ControlRuntime,
      catalog = yield* RunCatalogRead.RunCatalogRead,
      store = yield* RunStore.RunStore
    const root = yield* control.getRun(runId)
    if (root.status === "failed" || root.status === "cancelled") {
      return yield* invalid("The live job failed or was stopped; inspect its run before retrying")
    }
    if (root.status !== "completed") return undefined
    const page = yield* catalog.listRuns({ filters: { flowName: RepositoryJob._tag }, limit: 100 })
    for (const row of page.runs) {
      const stored = yield* store.get(row.runId)
      if (stored.status !== "completed" || stored.stateJson.length > 8 * 1024 * 1024) continue
      const state = Schema.decodeUnknownOption(Schema.fromJsonString(RunState))(stored.stateJson)
      if (Option.isNone(state)) continue
      const payload = Schema.decodeUnknownOption(JobInput)(state.value.payload)
      if (Option.isNone(payload)) continue
      const value = payload.value
      if (
        value.repo !== input.repo || value.job !== input.job || value.digest !== input.digest ||
        value.revision !== input.revision ||
        (input.sourceRevision !== undefined && value.sourceRevision !== input.sourceRevision) ||
        value.event.source !== event.source ||
        (value.event.issueNumber ?? 0) !== event.issueNumber ||
        (event.deliveryKey !== undefined && value.event.deliveryKey !== event.deliveryKey) ||
        value.event.manualStep !== event.manualStep || (event.trial === true && value.event.trial !== true)
      ) continue
      const proof = yield* readOwnedResult(
        row.runId,
        RepositoryJob._tag,
        `repository-jobs/${input.job}`,
        value,
        JobInput,
        JobResult,
        RepositoryJob.errorSchema
      )
      if (proof.run.runId !== runId) continue
      if (
        proof.output.repo !== value.repo || proof.output.job !== value.job ||
        proof.output.revision !== value.revision || proof.output.digest !== value.digest ||
        proof.output.eventKey !== value.event.deliveryKey || proof.output.status !== "completed" ||
        proof.output.results.length === 0 ||
        proof.output.results.some((step) => step.status !== "completed") || (event.manualStep !== undefined &&
          (proof.output.results.length !== 1 || proof.output.results[0]!.stepId !== event.manualStep))
      ) {
        return yield* invalid("The live job did not complete its selected work; inspect the actual results")
      }
      if (event.trial === true) {
        yield* Effect.try({
          try: () => verifyTrialChecks(value.configuration, proof.output),
          catch: (error) => error instanceof CodingError ? error : invalid("The AI trial results could not be verified")
        })
      }
      return { ...proof, executionId: row.runId }
    }
    return yield* invalid("The completed live run has no matching native repository job receipt")
  })
