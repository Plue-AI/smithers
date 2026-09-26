/** Finalization reads approved native receipts from this host's existing stores. */
import { ControlRuntime } from "@smthrs/control/ControlRuntime"
import * as Digest from "@smthrs/core/Digest"
import { DurableEngineState } from "@smthrs/engine-store"
import * as RunCatalogRead from "@smthrs/engine-store/RunCatalogRead"
import { RunState } from "@smthrs/engine-store/RunState"
import { Action, Flow } from "@smthrs/flow"
import * as RunStore from "@smthrs/run-store/RunStore"
import { Effect, Exit, Option, Schema } from "effect"
import { ModuleOwner } from "../../packages/smithers/src/internal/ModuleOwner.ts"
import { Poc, PocInput } from "./poc.ts"
import { PrepareRequest } from "./preparation.ts"
import { Request } from "./request.ts"
import { CodingError, RequestInput, sameRevision } from "./schema.ts"
import { VibeEvidence, VibeInput } from "./vibe-schema.ts"
export { VibeEvidence, VibeInput } from "./vibe-schema.ts"

export const ReadVibeRequest = Action.make("coding/read-vibe-request", {
  payload: VibeInput,
  success: VibeEvidence,
  error: CodingError,
  nondeterministic: true
})
const refuse = (message: string) => new CodingError({ code: "invalid_receipt", message })
const invalid = (message: string) => Effect.fail(refuse(message))
const completed = <
  S extends Schema.Top & { readonly DecodingServices: never },
  E extends Schema.Top & { readonly DecodingServices: never }
>(state: RunState, success: S, error: E) =>
  Effect.gen(function*() {
    const result = Schema.decodeUnknownOption(Schema.toCodecJson(Flow.Result({ success, error })))(state.result)
    if (Option.isNone(result) || result.value._tag !== "Complete" || Exit.isFailure(result.value.exit)) {
      return yield* invalid("Finalization requires a retained successful native result")
    }
    return result.value.exit.value
  })

/** No global run scan, second ledger, caller-supplied success or ambient repo ID. */
export const readVibeRequest = (input: typeof VibeInput.Type) =>
  Effect.gen(function*() {
    // ModuleAuthority supplies this per handler, never while layers are built.
    const currentOwner = yield* Effect.serviceOption(ModuleOwner)
    if (Option.isNone(currentOwner) || currentOwner.value.flowId !== "coding/vibe") {
      return yield* invalid("Only an approved coding/vibe execution may admit finalization")
    }
    const owner = currentOwner.value
    const store = yield* RunStore.RunStore, graph = yield* DurableEngineState.DurableEngineState
    const control = yield* ControlRuntime, catalog = yield* RunCatalogRead.RunCatalogRead
    let totalBytes = 0
    const read = (id: string) =>
      Effect.gen(function*() {
        const row = yield* store.get(id).pipe(Effect.mapError((error) =>
          error.code === "not_found_row"
            ? refuse(
              "Finalization ancestry or its original source receipt was collected; this request cannot supply the required receipt"
            )
            : error
        ))
        totalBytes += new TextEncoder().encode(row.stateJson).length
        if (row.runId !== id || row.stateJson.length > 16 * 1024 * 1024 || totalBytes > 32 * 1024 * 1024) {
          return yield* invalid("Finalization evidence exceeds its bounded native-state lookup")
        }
        const state = Schema.decodeUnknownOption(Schema.fromJsonString(RunState))(row.stateJson)
        if (Option.isNone(state) || row.status !== "completed" || state.value.cancellation !== undefined) {
          return yield* invalid("Finalization requires completed, uncancelled native ancestry")
        }
        return { row, state: state.value }
      })
    const requestRow = yield* read(input.requestExecutionId)
    if (requestRow.state.flowName !== Request._tag) return yield* invalid("Select a native coding/Request execution")
    const request = yield* completed(requestRow.state, Request.successSchema, Request.errorSchema)
    if (
      request.outcome.status !== "validated" || request.outcome.blocked !== null ||
      request.outcome.result?.status !== "validated" || request.outcome.result.findings.length !== 0
    ) {
      return yield* invalid("The selected request has not reached a validated domain outcome")
    }
    if (
      request.outcome.result.changes.some((change) =>
        new Set(change.receipts.map((receipt) => receipt.checkId)).size !== change.receipts.length
      )
    ) {
      return yield* invalid("Finalization check receipts must have unique IDs within each Change")
    }
    const payload = Schema.decodeUnknownOption(RequestInput)(requestRow.state.payload)
    if (Option.isNone(payload)) return yield* invalid("The request's retained input is invalid")
    const visited = new Set<string>()
    let id = input.requestExecutionId, bridged = false
    let root: { controlRunId: string; planId: string; planDigest: string } | undefined
    while (root === undefined) {
      if (visited.has(id) || visited.size >= 1024) {
        return yield* invalid("Finalization ancestry is cyclic or exceeds 1024 native executions")
      }
      visited.add(id)
      const entry = id === input.requestExecutionId ? requestRow : yield* read(id)
      // Executable.fromDescriptor persists the descriptor's name and inlines
      // delegate.call. There need not be a separate coding/Request row.
      if (entry.state.flowName === "coding/request") {
        const invocation = entry.state.payload as { readonly input?: unknown } | null
        const bridgeInput = Schema.decodeUnknownOption(RequestInput)(invocation?.input)
        if (
          bridged || Option.isNone(bridgeInput) ||
          Digest.canonical(bridgeInput.value) !== Digest.canonical(payload.value)
        ) {
          return yield* invalid("The registered request bridge does not match its native request input")
        }
        bridged = true
      }
      const parents = yield* graph.runParents(id)
      const run = yield* control.getRun(id).pipe(
        Effect.map(Option.some),
        Effect.catchTag("/control/RunNotFound", () => Effect.succeedNone)
      )
      if (Option.isSome(run)) {
        const nativePayload = entry.state.payload as { readonly planId?: unknown } | null
        if (
          !bridged || id === owner.rootId || run.value.status !== "completed" || run.value.planId === undefined ||
          entry.state.flowName !== "agent/run" || nativePayload?.planId !== run.value.planId ||
          parents.length !== 0 || entry.state.parentExecutionId !== undefined
        ) {
          return yield* invalid("The request is not owned by one completed approved control wrapper")
        }
        const plan = yield* control.getPlan(run.value.planId)
        const approvedInput = Schema.decodeUnknownOption(RequestInput)(plan.decodedInput)
        if (
          plan.decision !== "approved" || run.value.planDigest !== plan.card.digest ||
          run.value.flowId !== "coding/request" || plan.card.flowId !== "coding/request" ||
          // `coding/request` IS its own flow, so its approved envelope names no
          // delegate. An envelope that names one was approved for a descriptor
          // that handed this work to code the descriptor does not measure.
          plan.card.envelope.flows.length !== 0 ||
          Option.isNone(approvedInput) || Digest.canonical(approvedInput.value) !== Digest.canonical(payload.value)
        ) {
          return yield* invalid("The native request does not match its retained approved input and delegate")
        }
        root = { controlRunId: id, planId: run.value.planId, planDigest: plan.card.digest }
      } else {
        // Ordinary spawn edges are authoritative; a trampoline has a row parent.
        // This product's one-owner progression rejects diamonds rather than
        // borrowing authority from one of several possible control ancestors.
        if (parents.length > 1) return yield* invalid("Finalization requires unambiguous native ownership")
        const parentId = parents[0]?.parentId ?? entry.row.parentRunId
        if (parentId === null || parentId === undefined) {
          return yield* invalid("The request has no retained control ancestor")
        }
        if (entry.state.parentExecutionId !== undefined && entry.state.parentExecutionId !== parentId) {
          return yield* invalid("Native ancestry disagrees with the recorded child input")
        }
        id = parentId
      }
    }
    // Later steered plans may start after implementation. The one original
    // prepared child is source-qualified before any correction can mutate code.
    const preparations = yield* catalog.listRuns({
      filters: { flowName: PrepareRequest._tag, parentRunId: input.requestExecutionId },
      limit: 2
    })
    if (preparations.cursor !== null || preparations.runs.length > 1) {
      return yield* invalid("The request needs exactly one retained original preparation")
    }
    if (preparations.runs.length === 1) {
      const preparationExecutionId = preparations.runs[0]!.runId
      const preparation = yield* read(preparationExecutionId)
      const parents = yield* graph.runParents(preparationExecutionId)
      if (
        preparation.state.flowName !== PrepareRequest._tag ||
        preparation.state.parentExecutionId !== input.requestExecutionId ||
        parents.length !== 1 || parents[0]!.parentId !== input.requestExecutionId
      ) {
        return yield* invalid("The original preparation is not a direct child of this request")
      }
      const preparedInput = Schema.decodeUnknownOption(PrepareRequest.payloadSchema)(preparation.state.payload)
      const plan = yield* completed(preparation.state, PrepareRequest.successSchema, PrepareRequest.errorSchema)
      if (
        Option.isNone(preparedInput) || preparedInput.value.prompt !== payload.value.prompt ||
        preparedInput.value.feedback !== (payload.value.feedback ?? "") || plan.observedHead === undefined ||
        plan.prompt !== payload.value.prompt
      ) {
        return yield* invalid("The original prepared source does not match the approved request input")
      }
      return { ...input, ...root, preparationExecutionId, originalSource: plan.observedHead, request }
    }
    // Compatibility for requests completed before the independent-POC change.
    // An absent modern receipt cannot borrow an unrelated prototype's source.
    const children = yield* catalog.listRuns({
      filters: { flowName: Poc._tag, parentRunId: input.requestExecutionId },
      limit: 2
    })
    if (children.cursor !== null || children.runs.length !== 1) {
      return yield* invalid("The request needs exactly one retained original POC")
    }
    const pocExecutionId = children.runs[0]!.runId
    const poc = yield* read(pocExecutionId)
    const pocParents = yield* graph.runParents(pocExecutionId)
    if (
      poc.state.flowName !== Poc._tag || poc.state.parentExecutionId !== input.requestExecutionId ||
      pocParents.length !== 1 || pocParents[0]!.parentId !== input.requestExecutionId
    ) {
      return yield* invalid("The original POC is not a direct child of this request")
    }
    const pocInput = Schema.decodeUnknownOption(PocInput)(poc.state.payload)
    const pocResult = yield* completed(poc.state, Poc.successSchema, Poc.errorSchema)
    // CapturePocSource already fenced the native head. This check binds that
    // recorded result to its original input; it is not a second source capture.
    if (
      Option.isNone(pocInput) || !sameRevision(pocInput.value.source, pocResult.source) ||
      pocInput.value.plan.observedHead === undefined ||
      !sameRevision(pocInput.value.plan.observedHead, pocResult.source)
    ) {
      return yield* invalid("The original POC source does not match its captured request input")
    }
    return { ...input, ...root, pocExecutionId, originalSource: pocResult.source, request }
  }).pipe(Effect.mapError((error) =>
    error instanceof CodingError ? error : new CodingError({
      code: "unavailable",
      message: "The retained request evidence could not be read from this host's native stores"
    })
  ))
