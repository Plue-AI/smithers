/** Finalization reads approved native receipts from this host's existing stores. */
import { ControlRuntime } from "@smthrs/control/ControlRuntime"
import * as Digest from "@smthrs/core/Digest"
import { DurableEngineState } from "@smthrs/engine-store"
import * as RunCatalogRead from "@smthrs/engine-store/RunCatalogRead"
import { RunState } from "@smthrs/engine-store/RunState"
import { Action, Flow, FlowRuntime } from "@smthrs/flow"
import * as RunStore from "@smthrs/run-store/RunStore"
import { Effect, Exit, Option, Schema } from "effect"
import { ModuleOwner } from "../../packages/smithers/src/internal/ModuleOwner.ts"
import { Poc, PocInput } from "./poc.ts"
import { PrepareRequest } from "./preparation.ts"
import { Cursor, RequestFeedback } from "./request-flow.ts"
import { Coordinate, Request } from "./request.ts"
import { CodingError, RequestInput, type RequestResult, sameRevision } from "./schema.ts"
import { leafFeedback } from "./todo-route.ts"
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
/** New compositions inline Request and retain its Coordinate child. Older
 * native histories keep their original Request row and source receipt. */
const requestChildren = (catalog: RunCatalogRead.Service, parentRunId: string) =>
  catalog.listRuns({ filters: { flowName: Request._tag, parentRunId }, limit: 2 }).pipe(
    Effect.flatMap((legacy) =>
      legacy.cursor !== null || legacy.runs.length !== 0
        ? Effect.succeed(legacy)
        : catalog.listRuns({ filters: { flowName: Coordinate._tag, parentRunId }, limit: 2 })
    )
  )

const readRequestEvidence = (input: typeof VibeInput.Type, expectedRequest?: typeof RequestResult.Type) =>
  Effect.gen(function*() {
    // ModuleAuthority supplies this per handler, never while layers are built.
    const currentOwner = yield* Effect.serviceOption(ModuleOwner)
    if (
      Option.isNone(currentOwner) ||
      (currentOwner.value.flowId !== "coding/vibe" && currentOwner.value.flowId !== "todo")
    ) {
      return yield* invalid("Only an approved delivery execution may admit finalization")
    }
    const owner = currentOwner.value
    const composed = owner.flowId === "todo"
    let todoBridge: string | undefined, todoTag: string | undefined, todoDigest: string | undefined
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
        const active = composed && (id === owner.rootId || id === todoBridge ||
          Option.isSome(state) && state.value.flowName === "coding/todo-review" && row.status === "running")
        if (
          Option.isNone(state) || row.status !== (active ? "running" : "completed") ||
          row.cancelRequestedAtMs !== null || state.value.cancellation !== undefined
        ) {
          return yield* invalid("Finalization requires uncancelled native evidence in its expected execution state")
        }
        return { row, state: state.value }
      })
    // A registry launch persists the request under its registered name,
    // coding/request, with delegate.call inlined, and the stack names the
    // control run it launched (agent/run): select that run's one request.
    let selected = input.requestExecutionId
    let requestRow = yield* read(selected)
    if (composed) {
      const run = yield* control.getRun(owner.rootId)
      todoDigest = run.executionDigest
      if (todoDigest === undefined || !/^[a-f0-9]{64}$/.test(todoDigest)) {
        return yield* invalid("TODO delivery requires the attempt's retained execution digest")
      }
      // Canonical Flow.make declarations use the registry's digest-qualified
      // adapter tag; the public name is not a persisted native execution tag.
      todoTag = `registry/entry/${todoDigest}/todo`
      // Settled launches remain evidence under this same control run. Only
      // its active launch can supply a new candidate; ancestry below binds
      // the selected request to that launch and the attempt's approved pin.
      const bridges = yield* catalog.listRuns({
        filters: { flowName: todoTag, parentRunId: owner.rootId, status: "running" },
        limit: 2
      })
      if (bridges.cursor !== null || bridges.runs.length !== 1) {
        return yield* invalid("TODO delivery requires one active composition launch in its current attempt")
      }
      todoBridge = bridges.runs[0]!.runId
      if (input.requestExecutionId === owner.rootId) {
        const children = yield* requestChildren(catalog, todoBridge)
        if (children.cursor !== null || children.runs.length !== 1) {
          return yield* invalid("TODO delivery requires one completed request in its current composition")
        }
        selected = children.runs[0]!.runId
        requestRow = yield* read(selected)
      }
    } else if (requestRow.state.flowName === "agent/run") {
      const children = yield* catalog.listRuns({
        filters: { flowName: "coding/request", parentRunId: selected },
        limit: 2
      })
      if (children.cursor !== null || children.runs.length !== 1) {
        return yield* invalid("Select a native coding/Request execution")
      }
      selected = children.runs[0]!.runId
      requestRow = yield* read(selected)
    }
    const inlined = requestRow.state.flowName === "coding/request"
    const coordinated = composed && requestRow.state.flowName === Coordinate._tag
    if (!coordinated && requestRow.state.flowName !== Request._tag && (composed || !inlined)) {
      return yield* invalid("Select a native coding/Request execution")
    }
    const request = yield* completed(requestRow.state, Request.successSchema, Request.errorSchema)
    if (expectedRequest !== undefined && Digest.canonical(expectedRequest) !== Digest.canonical(request)) {
      return yield* invalid("TODO delivery does not match its retained request result")
    }
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
    const cursor = coordinated ? Schema.decodeUnknownOption(Cursor)(requestRow.state.payload) : Option.none()
    if (coordinated && (Option.isNone(cursor) || cursor.value.requestRoute !== request.route)) {
      return yield* invalid("The coordinate result does not match its retained request route")
    }
    const payload = Schema.decodeUnknownOption(RequestInput)(
      coordinated
        ? cursor.pipe(Option.map((value) => value.requestInput), Option.getOrUndefined)
        : inlined
        ? (requestRow.state.payload as { readonly input?: unknown } | null)?.input
        : requestRow.state.payload
    )
    if (
      Option.isNone(payload) || (composed && payload.value.base === undefined &&
        (yield* read(requestRow.state.parentExecutionId ?? "")).state.flowName !== "coding/todo-review")
    ) {
      return yield* invalid("The request's retained input is invalid")
    }
    const visited = new Set<string>()
    let id = selected, bridged = false
    let compositionInput: typeof RequestInput.Type | undefined
    let root: { controlRunId: string; planId: string; planDigest: string } | undefined
    while (root === undefined) {
      if (visited.has(id) || visited.size >= 1024) {
        return yield* invalid("Finalization ancestry is cyclic or exceeds 1024 native executions")
      }
      visited.add(id)
      const entry = id === selected ? requestRow : yield* read(id)
      // Executable.fromDescriptor persists the descriptor's name and inlines
      // delegate.call. There need not be a separate coding/Request row.
      if ((!composed && entry.state.flowName === "coding/request") || (composed && id === todoBridge)) {
        const invocation = entry.state.payload as { readonly input?: unknown } | null
        const bridgeInput = Schema.decodeUnknownOption(RequestInput)(invocation?.input)
        if (
          bridged || (composed && entry.state.flowName !== todoTag) || Option.isNone(bridgeInput) ||
          (!composed && Digest.canonical(bridgeInput.value) !== Digest.canonical(payload.value))
        ) {
          return yield* invalid("The registered request bridge does not match its native request input")
        }
        if (composed) {
          // The pinned composition may add requirements to its request (J5).
          // Its outer invocation still matches the approved plan, and its
          // child must keep the attempt's admitted source and workspace ref.
          if (
            bridgeInput.value.base === undefined ||
            payload.value.base !== undefined &&
              Digest.canonical(bridgeInput.value.base) !== Digest.canonical(payload.value.base)
          ) return yield* invalid("The customized request changed its attempt's admitted source")
          compositionInput = bridgeInput.value
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
          !bridged || (composed ? id !== owner.rootId : id === owner.rootId) ||
          // A resumed control claim is accepted while its native execution
          // is already running. read() requires the current uncancelled
          // native root and adapter to be running, not merely admitted.
          (composed
            ? run.value.status !== "running" && run.value.status !== "accepted"
            : run.value.status !== "completed") ||
          run.value.planId === undefined ||
          entry.state.flowName !== "agent/run" || nativePayload?.planId !== run.value.planId ||
          parents.length !== 0 || entry.state.parentExecutionId !== undefined
        ) {
          return yield* invalid("The request is not owned by its expected approved control wrapper")
        }
        const plan = yield* control.getPlan(run.value.planId)
        const approvedInput = Schema.decodeUnknownOption(RequestInput)(plan.decodedInput)
        if (
          plan.decision !== "approved" || run.value.planDigest !== plan.card.digest ||
          (composed && (run.value.executionDigest !== todoDigest || plan.card.executionDigest !== todoDigest)) ||
          run.value.flowId !== (composed ? "todo" : "coding/request") ||
          plan.card.flowId !== (composed ? "todo" : "coding/request") ||
          // `coding/request` IS its own flow, so its approved envelope names no
          // delegate. An envelope that names one was approved for a descriptor
          // that handed this work to code the descriptor does not measure.
          plan.card.envelope.flows.length !== 0 ||
          Option.isNone(approvedInput) ||
          Digest.canonical(approvedInput.value) !== Digest.canonical(compositionInput ?? payload.value)
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
        if (
          composed && (
            (id === selected && parentId !== todoBridge &&
              (yield* read(parentId)).state.flowName !== "coding/todo-review") ||
            (id !== selected && id !== todoBridge && entry.state.flowName !== "coding/todo-review") ||
            (id === todoBridge && parentId !== owner.rootId) ||
            (entry.row.parentRunId !== null && entry.row.parentRunId !== parentId)
          )
        ) {
          return yield* invalid("TODO delivery ancestry does not belong to its current attempt")
        }
        if (entry.state.parentExecutionId !== undefined && entry.state.parentExecutionId !== parentId) {
          return yield* invalid("Native ancestry disagrees with the recorded child input")
        }
        id = parentId
      }
    }
    // Later steered plans may start after implementation. The one original
    // prepared child is source-qualified before any correction can mutate code.
    const preparationParent = coordinated ? requestRow.state.parentExecutionId : selected
    if (preparationParent === undefined) return yield* invalid("The inlined request has no retained preparation parent")
    let initialFeedback = payload.value.feedback ?? ""
    if (composed && owner.launchOrdinal !== undefined) {
      const contexts = yield* catalog.listRuns({
        filters: { flowName: RequestFeedback._tag, parentRunId: preparationParent },
        limit: 2
      })
      if (contexts.cursor !== null || contexts.runs.length !== 1) {
        return yield* invalid("The request needs exactly one retained initial feedback receipt")
      }
      const contextId = contexts.runs[0]!.runId
      const context = yield* read(contextId)
      const contextParents = yield* graph.runParents(contextId)
      const expected = {
        prompt: payload.value.prompt,
        feedback: initialFeedback,
        ...(payload.value.wiki === undefined ? {} : { wiki: payload.value.wiki }),
        ...(payload.value.answers === undefined ? {} : { answers: payload.value.answers })
      }
      if (
        context.state.flowName !== RequestFeedback._tag || context.state.parentExecutionId !== preparationParent ||
        contextParents.length !== 1 || contextParents[0]!.parentId !== preparationParent ||
        Digest.canonical(context.state.payload) !== Digest.canonical(expected)
      ) {
        return yield* invalid("The initial feedback receipt does not match the approved request input")
      }
      initialFeedback = yield* completed(context.state, RequestFeedback.successSchema, RequestFeedback.errorSchema)
    }
    const preparations = yield* catalog.listRuns({
      filters: { flowName: PrepareRequest._tag, parentRunId: preparationParent },
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
        preparation.state.parentExecutionId !== preparationParent ||
        parents.length !== 1 || parents[0]!.parentId !== preparationParent
      ) {
        return yield* invalid("The original preparation is not a direct child of this request")
      }
      const preparedInput = Schema.decodeUnknownOption(PrepareRequest.payloadSchema)(preparation.state.payload)
      const plan = yield* completed(preparation.state, PrepareRequest.successSchema, PrepareRequest.errorSchema)
      if (
        Option.isNone(preparedInput) || preparedInput.value.prompt !== payload.value.prompt ||
        preparedInput.value.feedback !== (request.route === undefined
            ? initialFeedback
            : leafFeedback(request.route, initialFeedback)) ||
        plan.observedHead === undefined ||
        plan.prompt !== payload.value.prompt
      ) {
        return yield* invalid("The original prepared source does not match the approved request input")
      }
      return {
        ...input,
        requestExecutionId: composed ? owner.rootId : input.requestExecutionId,
        ...root,
        preparationExecutionId,
        originalSource: plan.observedHead,
        request,
        fromStack: composed || payload.value.base !== undefined,
        ...(compositionInput?.base === undefined ? {} : { stackBase: compositionInput.base.commitId })
      }
    }
    // Compatibility for requests completed before the independent-POC change.
    // An absent modern receipt cannot borrow an unrelated prototype's source.
    const children = yield* catalog.listRuns({
      filters: { flowName: Poc._tag, parentRunId: selected },
      limit: 2
    })
    if (children.cursor !== null || children.runs.length !== 1) {
      return yield* invalid("The request needs exactly one retained original POC")
    }
    const pocExecutionId = children.runs[0]!.runId
    const poc = yield* read(pocExecutionId)
    const pocParents = yield* graph.runParents(pocExecutionId)
    if (
      poc.state.flowName !== Poc._tag || poc.state.parentExecutionId !== selected ||
      pocParents.length !== 1 || pocParents[0]!.parentId !== selected
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
    return {
      ...input,
      requestExecutionId: composed ? owner.rootId : input.requestExecutionId,
      ...root,
      pocExecutionId,
      originalSource: pocResult.source,
      request,
      fromStack: composed || payload.value.base !== undefined,
      ...(compositionInput?.base === undefined ? {} : { stackBase: compositionInput.base.commitId })
    }
  }).pipe(Effect.mapError((error) =>
    error instanceof CodingError ? error : new CodingError({
      code: "unavailable",
      message: "The retained request evidence could not be read from this host's native stores"
    })
  ))

/** Legacy delivery reads a completed request; a TODO reads its own completed
 * child beneath the still-running approved composition. Both use the same
 * native evidence validation and original-source receipt. */
export const readVibeRequest = (input: typeof VibeInput.Type) => readRequestEvidence(input)

/** Derive identity from the host owner, never from repository-supplied IDs.
 * Comparing the supplied result prevents an override from substituting a
 * different planner result after the retained child completed. */
export const readTodoDelivery = ({ request }: { readonly request: typeof RequestResult.Type }) =>
  Effect.gen(function*() {
    const owner = yield* Effect.serviceOption(ModuleOwner)
    if (Option.isNone(owner) || owner.value.flowId !== "todo") {
      return yield* invalid("Only an approved TODO attempt may resolve delivery")
    }
    const instance = yield* FlowRuntime.FlowInstance
    const catalog = yield* RunCatalogRead.RunCatalogRead
    const children = yield* requestChildren(catalog, instance.executionId).pipe(
      Effect.mapError(() => new CodingError({ code: "unavailable", message: "TODO request catalog is unavailable" }))
    )
    if (children.cursor !== null || children.runs.length !== 1) {
      return yield* invalid("TODO delivery requires its own completed request")
    }
    const selected = { requestExecutionId: children.runs[0]!.runId }
    yield* readRequestEvidence(selected, request)
    return selected
  })
