/*
 * The workspace gateway, as this app calls it.
 *
 * Every call goes to the product Worker's relay, which holds the per-user
 * gateway credential a browser can never hold and writes the gateway's own RPC
 * frame. The names here are the gateway's names — `Plan`, `Run`, `Cancel`,
 * `Resume`, `Steer`, `Signal`, `List`, `Projection.Snapshot`,
 * `Approval.Submit` — so there is one vocabulary between this file, the
 * Worker, and the engine.
 *
 * The row schemas are imported from `@smthrs/gateway`, and every projection
 * snapshot is decoded against them, so a change to a served projection fails
 * this app's typecheck AND a row the gateway never served fails here instead
 * of reaching a user as an undefined field.
 */
import { ControlEvent, PlanCard, type PlanEdge, type PlanGraphNode, type PlanNode, PlanSummary, type SteerMessage } from "@smthrs/control/ControlSchema"
import { ApprovalRow, FlowDurationRow, NodeOutputRow, RunSummaryRow, TranscriptRow } from "@smthrs/gateway/GatewayProjection"
import { ProjectionCursor } from "@smthrs/gateway/GatewaySchema"
import { SubmitApprovalOutput } from "@smthrs/gateway/GatewayRpcs"
import { ForkOutput, type StepEdit, VerifyReport } from "@smthrs/gateway/RunHistory"
import { WORKFLOW_RPC_PATH } from "@smthrs/rpc/AgentApiRoutes"
import { Option, Schema } from "effect"
import { cloudFailure } from "../seams/CloudClient"
import { flowPageRequest, TOO_MANY_FLOWS, walkFlowPages } from "../FlowPages"
import { errorCodeOf, GATEWAY_REFUSED, gatewayRefusalSentence, workspaceAnswerSentence } from "./GatewayFailureCopy"

/**
 * What one relayed call answered. A refusal carries the sentence the relay
 * wrote and, when the gateway raised a typed error, its `code` (ControlError's
 * `code` field, else the error's tag), so a caller can answer a known refusal
 * by shape rather than by matching prose.
 */
export type GatewayResult<A> =
  | { readonly status: "ok"; readonly value: A; readonly cursor?: ProjectionCursor }
  | {
    readonly status: "error"
    /** One sentence in product words. */
    readonly message: string
    readonly code?: string
    readonly retryAfterSeconds?: number
    /** The workspace's own words, for Details and diagnostics only. */
    readonly detail?: string
  }

/** ControlError.FlowNotFound on the wire: its `code` and its tag. */
export const FLOW_NOT_FOUND_CODE = "flow_not_found"
export const FLOW_NOT_FOUND_TAG = "/control/FlowNotFound"

/** Whether a refusal's code is the control plane's "no flow with this id is registered". */
export const isFlowNotFound = (code: string | undefined): boolean =>
  code === FLOW_NOT_FOUND_CODE || code === FLOW_NOT_FOUND_TAG

/** This seam's own refusal: a projection snapshot it could not read as the rows it asked for. */
export const INVALID_PROJECTION_CODE = "invalid_projection"

/** This seam's own refusal: a `Run.Verify` or `Run.Fork` answer it could not read. */
export const INVALID_HISTORY_CODE = "invalid_history"

/**
 * A history host's refusal (`HistoryRefused`) is the sentence `smthrs runs
 * fork` and `smthrs runs verify` print, redacted by the host, so it is what a
 * person reads; a control-plane refusal keeps its registry sentence.
 */
const historyRefusal = <A>(result: Extract<GatewayResult<A>, { status: "error" }>): GatewayResult<A> =>
  result.message === GATEWAY_REFUSED && result.detail !== undefined ? { ...result, message: result.detail } : result

/** This seam's own refusal: a `Plan` answer it could not read as a plan card. */
export const INVALID_PLAN_CODE = "invalid_plan"

/**
 * What a flow would run, as the plan door answers it.
 *
 * The signed `envelope` and the `approval` payload are deliberately absent.
 * They are authority, and everything a card payload holds is written to disk
 * by the persistence backend, so they stay inside this module: `launch`
 * carries them straight from the answer into the two calls that need them.
 */
export interface PlannedFlow {
  readonly planId: string
  readonly digest: string
  readonly flowId: string
  readonly nodes: ReadonlyArray<PlanNode>
  /**
   * The labelled edges, when the workspace reported them (`dependsOn`
   * otherwise), and where it says each node was declared.
   */
  readonly graph?: {
    readonly edges: ReadonlyArray<PlanEdge>
    readonly nodes?: ReadonlyArray<PlanGraphNode> | undefined
  }
}

const decodePlanCard = Schema.decodeUnknownOption(PlanCard)

/** The card, minus the authority a reader must never persist. */
const plannedOf = (card: PlanCard): PlannedFlow => ({
  planId: card.planId,
  digest: card.digest,
  flowId: card.flowId,
  nodes: card.nodes,
  ...(card.graph === undefined ? {} : { graph: card.graph })
})

/** The rc.0 run statuses a card may render. */
export type RunStatus = RunSummaryRow["status"]

/** One discovered flow, as the flow list renders it. */
export interface FlowSummary {
  readonly flowId: string
  readonly description: string | null
  readonly inputSchema?: unknown
}

export type { ApprovalRow, ControlEvent, FlowDurationRow, NodeOutputRow, RunSummaryRow, TranscriptRow }

/** The box a flow call runs on. Every call names one. */
export interface GatewayWorkspaceBinding {
  readonly workspaceId: string
}

/** How the seam reaches the relay. */
export interface GatewayTransport {
  readonly baseUrl: string
  /** Capture ownership at request admission; a late answer cannot cross an account boundary. */
  readonly observationGuard?: () => () => boolean
  /** The box a call that names none runs on, or the refusal saying which box to open or pick. */
  readonly bindingFor: (repo: string, runId?: string) => GatewayWorkspaceBinding | { readonly error: string }
  readonly fetch: (url: string, init?: RequestInit) => Promise<Response>
  readonly errorMessageOf: (response: Response, fallback: string) => Promise<string>
}

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}

const map = <A, B>(result: GatewayResult<A>, project: (value: A) => B): GatewayResult<B> =>
  result.status === "ok" ? { ...result, value: project(result.value) } : result

/**
 * One projection snapshot's rows, decoded against the schema the gateway
 * serves for that selector.
 *
 * A snapshot whose `rows` is missing, is not an array, or carries a row the
 * served schema rejects is a malformed answer, not an empty workspace: it
 * crosses as a refusal coded `invalid_projection`, so no card renders a row
 * the wire never established. Only a valid empty array is an empty listing.
 */
const snapshotOf = <S extends Schema.Top>(row: S) => Schema.Struct({ rows: Schema.Array(row) })

// A legacy response may omit cursor metadata; its rows remain readable.
const decodeCursor = Schema.decodeUnknownOption(ProjectionCursor)

const rowsDecoder =
  <A>(decode: (input: unknown) => Option.Option<{ readonly rows: ReadonlyArray<A> }>) =>
  (result: GatewayResult<unknown>): GatewayResult<ReadonlyArray<A>> => {
    if (result.status !== "ok") return result
    const decoded = decode(result.value)
    const cursor = decodeCursor(asRecord(result.value).cursor)
    return Option.isSome(decoded)
      ? { status: "ok", value: decoded.value.rows, ...(Option.isSome(cursor) ? { cursor: cursor.value } : {}) }
      : {
        status: "error",
        message: "The workspace answered with a projection I couldn't read.",
        code: INVALID_PROJECTION_CODE
      }
  }

/** The first decoded row of a snapshot, absent when the projection served none. */
const firstRowDecoder =
  <A>(rows: (result: GatewayResult<unknown>) => GatewayResult<ReadonlyArray<A>>) =>
  (result: GatewayResult<unknown>): GatewayResult<A | undefined> => map(rows(result), (all) => all[0])

const decodeRunSummaryRows = rowsDecoder(Schema.decodeUnknownOption(snapshotOf(RunSummaryRow)))
const decodeRunSummaryRow = firstRowDecoder(decodeRunSummaryRows)
const decodeApprovalRows = rowsDecoder(Schema.decodeUnknownOption(snapshotOf(ApprovalRow)))
const decodeNodeOutputRow = firstRowDecoder(rowsDecoder(Schema.decodeUnknownOption(snapshotOf(NodeOutputRow))))
const decodeTranscriptRows = rowsDecoder(Schema.decodeUnknownOption(snapshotOf(TranscriptRow)))
const decodeControlEventRows = rowsDecoder(Schema.decodeUnknownOption(snapshotOf(ControlEvent)))
const decodeFlowDurationRows = rowsDecoder(Schema.decodeUnknownOption(snapshotOf(FlowDurationRow)))

/** One page of stored plans (`List { _tag: "plans" }`). */
const decodePlanPage = Schema.decodeUnknownOption(Schema.Struct({
  _tag: Schema.Literal("plans"),
  items: Schema.Array(PlanSummary),
  nextCursor: Schema.optional(Schema.String)
}))
const TargetInput = Schema.Struct({ label: Schema.String, digest: Schema.String })
const isTargetInput = Schema.is(TargetInput)
/** The most plan pages one inbox read walks: 50 pages of 100 plans. */
const PLAN_PAGE_CAP = 50

/**
 * A pending build target revision as an inbox row: the run is the plan's own
 * partition, the title is the target and its short revision, and the payload
 * is the plan approval `Approval.Submit` takes.
 */
const targetRow = (plan: PlanSummary, input: typeof TargetInput.Type): ApprovalRow => ({
  runId: `plan:${plan.card.planId}`,
  requestId: plan.card.planId,
  title: `${input.label} ${input.digest.slice(0, 12)}`,
  request: input,
  payload: plan.card.approval,
  requestedAt: 0,
  status: "pending"
})


/**
 * The Plue floor, as this app's own seam: list flows and runs, launch, read a
 * run, list and decide approvals (one run's or the workspace inbox), resume,
 * steer, signal, read a node's output or a run's transcript and events,
 * explain a run, and cancel it.
 *
 * @param transport how to reach the relay
 */
export const createGatewaySeam = (transport: GatewayTransport) => {
  const { baseUrl, errorMessageOf } = transport

  /** One relayed gateway procedure. */
  const call = async (
    repo: string,
    procedure: string,
    payload: unknown,
    binding?: GatewayWorkspaceBinding
  ): Promise<GatewayResult<unknown>> => {
    const stillOwned = transport.observationGuard?.() ?? (() => true)
    if (!stillOwned()) return { status: "error", message: "This workspace request no longer belongs to the current session." }
    const candidate = asRecord(payload)
    const runId = candidate.runId ?? asRecord(candidate.selector).runId ?? asRecord(candidate.target).runId
    const target = binding ?? transport.bindingFor(repo, typeof runId === "string" ? runId : undefined)
    if ("error" in target) return { status: "error", message: target.error }
    let body: { ok?: unknown; payload?: unknown; error?: unknown; message?: unknown; status?: unknown } | undefined
    const resumeDeadline = Date.now() + 180_000
    try {
      for (;;) {
        if (!stillOwned()) return { status: "error", message: "This workspace request no longer belongs to the current session." }
        const response = await transport.fetch(`${baseUrl}${WORKFLOW_RPC_PATH}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ repo, procedure, payload, workspaceId: target.workspaceId })
        })
        if (!response.ok) {
          const failure = await cloudFailure(response.clone(), "The workspace didn't answer.")
          return { status: "error", message: await errorMessageOf(response, "The workspace didn't answer."),
            ...(failure.code === null ? {} : { code: failure.code }),
            ...(failure.retryAfterSeconds === null ? {} : { retryAfterSeconds: failure.retryAfterSeconds }) }
        }
        body = (await response.json().catch(() => undefined)) as typeof body
        // A snapshot and the flows list are reads. Keep their binding while a
        // sleeping box resumes or its coding host starts; never retry mutations
        // or turn a pending response into rows.
        if ((procedure !== "Projection.Snapshot" && procedure !== "List") || body?.status !== "provisioning" || Date.now() >= resumeDeadline) break
        await new Promise<void>(resolve => setTimeout(resolve, 2_000))
      }
    } catch {
      return { status: "error", message: "The workspace didn't answer: the flow service is unreachable." }
    }
    if (!stillOwned()) return { status: "error", message: "This workspace response belongs to a previous session." }
    if (body?.ok === true) return { status: "ok", value: body.payload }
    if (body?.ok === false) {
      const refused = asRecord(body.error)
      const words = refused.message
      const code = errorCodeOf(refused.detail)
      return {
        status: "error",
        message: gatewayRefusalSentence(code),
        ...(code === undefined ? {} : { code }),
        ...(typeof words === "string" && words !== "" ? { detail: words } : {})
      }
    }
    if (typeof body?.message === "string") return { status: "error", message: workspaceAnswerSentence(body), detail: body.message }
    return { status: "error", message: "The workspace answered in a shape I didn't understand." }
  }

  /** One projection snapshot, by selector. */
  const projection = (
    repo: string,
    selector: unknown,
    binding?: GatewayWorkspaceBinding,
    after?: ProjectionCursor
  ): Promise<GatewayResult<unknown>> =>
    call(repo, "Projection.Snapshot", { selector, ...(after === undefined ? {} : { after }) }, binding)

  return {
    call,

    /** Every flow the workspace has discovered, every page of it. */
    listFlows: async (repo: string, binding?: GatewayWorkspaceBinding): Promise<GatewayResult<ReadonlyArray<FlowSummary>>> => {
      const walked = await walkFlowPages<GatewayResult<never>>(async (cursor) => {
        const listed = await call(repo, "List", flowPageRequest(cursor), binding)
        return listed.status === "ok" ? { ok: true, page: listed.value } : { ok: false, refusal: listed }
      }, { status: "error", message: TOO_MANY_FLOWS })
      if (!walked.ok) return walked.refusal
      return {
        status: "ok",
        value: walked.items
          .filter((entry) => typeof entry.flowId === "string")
          .map((entry): FlowSummary => ({
            flowId: entry.flowId as string,
            description: typeof entry.description === "string" && entry.description.trim() !== ""
              ? entry.description
              : null,
            ...(entry.inputSchema === undefined ? {} : { inputSchema: entry.inputSchema })
          }))
      }
    },

    /**
     * What a flow WOULD run: its keyed nodes and the edges between them,
     * before anything runs.
     *
     * The answer is the control plane's own signed plan card, so it is decoded
     * against `@smthrs/control`'s schema rather than read field by field off a
     * record: a workspace that answers a shape the schema rejects is a refusal
     * here, never a plan that silently reports no nodes.
     */
    plan: async (
      repo: string,
      flowId: string,
      input: Record<string, unknown>,
      requestedBinding?: GatewayWorkspaceBinding,
      idempotencyKey?: string
    ): Promise<GatewayResult<PlannedFlow>> => {
      const binding = requestedBinding ?? transport.bindingFor(repo)
      if ("error" in binding) return { status: "error", message: binding.error }
      const planned = await call(repo, "Plan", { flowId, input, ...(idempotencyKey === undefined ? {} : { idempotencyKey }) }, binding)
      if (planned.status !== "ok") return planned
      const card = decodePlanCard(planned.value)
      return Option.isNone(card)
        ? { status: "error", code: INVALID_PLAN_CODE, message: "The workspace planned the flow but answered with a plan I couldn't read." }
        : { status: "ok", value: plannedOf(card.value) }
    },

    /**
     * Start a flow: plan it, approve the plan, and run it.
     *
     * Three calls because they are three decisions, and the middle one is the
     * approval a human or a policy grants. The relay never replays a `Run`, so
     * a lost answer here is reported rather than retried into a second run.
     */
    launch: async (
      repo: string,
      flowId: string,
      input: Record<string, unknown>,
      requestedBinding?: GatewayWorkspaceBinding,
      request?: string | { readonly idempotencyKey: string; readonly stillCurrent: () => boolean; readonly planKey?: string; readonly runKey?: string }
    ): Promise<GatewayResult<{
      readonly runId: string
      readonly workspaceId: string
      /** The plan the run was approved on, so the run card can draw it before any event arrives. */
      readonly planId?: string
      readonly digest?: string
      readonly nodes?: ReadonlyArray<PlanNode>
      /** The labelled edges and declaration sites that answer carried; a plan that reported none has none. */
      readonly graph?: PlannedFlow["graph"]
    }>> => {
      const binding = requestedBinding ?? transport.bindingFor(repo)
      if ("error" in binding) return { status: "error", message: binding.error }
      const owned = transport.observationGuard?.() ?? (() => true)
      const current = () => owned() && (typeof request === "string" ? true : request?.stillCurrent() ?? true)
      const superseded = { status: "error" as const, code: "request_superseded", message: "This launch belongs to a previous session." }
      // Preserve persisted authoring keys and the background launch controller's keys.
      const requestKey = typeof request === "string" ? `author:${request}` : request === undefined ? undefined : request.planKey ?? `plan:${request.idempotencyKey}`
      if (!current()) return superseded
      const planned = await call(repo, "Plan", { flowId, input, ...(requestKey === undefined ? {} : { idempotencyKey: requestKey }) }, binding)
      if (!current()) return superseded
      if (planned.status !== "ok") return planned
      const card = asRecord(planned.value)
      const planId = typeof card.planId === "string" ? card.planId : undefined
      const digest = typeof card.digest === "string" ? card.digest : undefined
      if (planId === undefined || digest === undefined) {
        return { status: "error", message: "The workspace planned the run but didn't name the plan." }
      }
      // The same answer the plan door decodes. A workspace whose card this
      // schema rejects still launches — the launch needs the plan id and the
      // digest, which are here — it simply hands the run no nodes to draw.
      const decoded = decodePlanCard(planned.value)
      const approved = await call(repo, "Approval.Submit", {
        target: { _tag: "Plan", planId, digest, envelope: card.envelope },
        scope: "run",
        idempotencyKey: `approve:${planId}`,
        decision: "approve"
      }, binding)
      if (!current()) return superseded
      if (approved.status !== "ok") return approved
      const started = await call(repo, "Run", {
        _tag: "Plan",
        planId,
        digest,
        envelope: card.envelope,
        idempotencyKey: typeof request === "object" && request.runKey !== undefined ? request.runKey : `run:${planId}`
      }, binding)
      if (!current()) return superseded
      if (started.status !== "ok") return started
      const runId = asRecord(started.value).runId
      return typeof runId === "string"
        ? {
          status: "ok",
          value: {
            runId,
            planId,
            digest,
            workspaceId: binding.workspaceId,
            ...(Option.isNone(decoded)
              ? {}
              : {
                nodes: decoded.value.nodes,
                ...(decoded.value.graph === undefined ? {} : { graph: decoded.value.graph })
              })
          }
        }
        : { status: "error", message: "The run started but the workspace didn't name it — ask me to check." }
    },

    /** One run's summary, including its diagnosis. */
    run: async (repo: string, runId: string, binding?: GatewayWorkspaceBinding): Promise<GatewayResult<RunSummaryRow | undefined>> =>
      decodeRunSummaryRow(await projection(repo, { _tag: "run-summary", runId }, binding)),

    /** Every gate this run has asked for, decided ones included. */
    approvals: async (repo: string, runId: string, binding?: GatewayWorkspaceBinding): Promise<GatewayResult<ReadonlyArray<ApprovalRow>>> =>
      decodeApprovalRows(await projection(repo, { _tag: "approvals", runId }, binding)),

    /**
     * Decide one gate — or answer one.
     *
     * The payload the projection published goes back unchanged, so the client
     * never reconstructs authority. One call records the decision AND resumes
     * the run it unblocked: there is no second resume for a lost answer to
     * strand.
     *
     * `answer` is what a person wrote for a gate that asked a question rather
     * than for a grant, and it travels with the same payload.
     */
    submitApproval: async (
      repo: string,
      approval: ApprovalRow["payload"],
      decision: "approve" | "deny",
      binding?: GatewayWorkspaceBinding,
      answer?: unknown
    ): Promise<GatewayResult<SubmitApprovalOutput>> => {
      const result = await call(
        repo,
        "Approval.Submit",
        // A gate that asks a question is answered, not granted: the workspace
        // routes the value to the wait point the row names. A denial refuses
        // the question and carries nothing.
        { ...approval, decision, ...(answer === undefined || decision === "deny" ? {} : { answer }) },
        binding
      )
      if (result.status !== "ok") return result
      const decoded = Schema.decodeUnknownOption(SubmitApprovalOutput)(result.value)
      if (Option.isNone(decoded)) return { status: "error", code: "invalid_approval_receipt", message: "The workspace returned an unreadable approval receipt. Check this approval before trying again." }
      const receipt = decoded.value.decision
      if ("runId" in receipt && receipt.runId !== undefined && approval.target._tag === "Node" && receipt.runId !== approval.target.runId) {
        return { status: "error", code: "invalid_approval_receipt", message: "The workspace returned a receipt for a different run. This approval was not confirmed." }
      }
      if (receipt._tag === "Conflict") return { status: "error", code: "approval_conflict", message: receipt.message }
      if (receipt._tag !== "Accepted" && receipt._tag !== "AlreadyApplied" && receipt._tag !== "Terminal") {
        return { status: "error", code: "invalid_approval_receipt", message: "The workspace did not confirm this approval decision. Check the run before trying again." }
      }
      return { status: "ok", value: decoded.value }
    },

    /** What one node produced. */
    nodeOutput: async (
      repo: string,
      runId: string,
      nodeId: string,
      binding?: GatewayWorkspaceBinding
    ): Promise<GatewayResult<NodeOutputRow | undefined>> =>
      decodeNodeOutputRow(await projection(repo, { _tag: "node-output", runId, nodeId }, binding)),

    /** What happened to a run, in words: the run summary's diagnosis. */
    explain: async (repo: string, runId: string, binding?: GatewayWorkspaceBinding): Promise<GatewayResult<string | undefined>> =>
      map(decodeRunSummaryRow(await projection(repo, { _tag: "run-summary", runId }, binding)), (row) => row?.verdict),

    /** Stop a run. Durable: the next read of it says cancelled. */
    cancel: (repo: string, runId: string, reason?: string, binding?: GatewayWorkspaceBinding): Promise<GatewayResult<unknown>> =>
      call(repo, "Cancel", {
        runId,
        idempotencyKey: `cancel:${runId}`,
        reason: reason === undefined || reason.trim() === "" ? "the human stopped it" : reason
      }, binding),

    /*
     * Lane runs — the run lifecycle beyond launch and cancel.
     *
     * Every mutation mints one idempotency key per invocation from a fresh
     * `crypto.randomUUID()`, never the clock: the relay may replay a lost
     * answer with the same frame, and the engine deduplicates on the key, so a
     * repeat lands one effect and two deliberate clicks land two even inside
     * one millisecond (a second resume of a live run is the gateway's own
     * ClaimLost).
     */

    /** Restart a parked run (or tell the run's owner to). */
    resume: (repo: string, runId: string, reason?: string, binding?: GatewayWorkspaceBinding): Promise<GatewayResult<unknown>> =>
      call(repo, "Resume", {
        runId,
        idempotencyKey: `resume:${runId}:${crypto.randomUUID()}`,
        ...(reason === undefined ? {} : { reason })
      }, binding),

    /**
     * What resuming a run under the workspace's current flow code would do:
     * the recorded steps it replays and the first it would execute again
     * (`Run.Verify`, the report `smthrs runs verify` prints). A divergent
     * report is an answer, not a refusal.
     */
    verify: async (repo: string, runId: string, binding?: GatewayWorkspaceBinding): Promise<GatewayResult<VerifyReport>> => {
      const result = await call(repo, "Run.Verify", { runId }, binding)
      if (result.status !== "ok") return historyRefusal(result)
      const decoded = Schema.decodeUnknownOption(VerifyReport)(result.value)
      return Option.isNone(decoded)
        ? { status: "error", code: INVALID_HISTORY_CODE, message: "The workspace returned an unreadable verification report." }
        : { status: "ok", value: decoded.value }
    },

    /**
     * Branch a run at the journal sequence `at` into a parked child, with one
     * recorded step's result edited when `step` is given (`Run.Fork`, as
     * `smthrs runs fork`). Answers the child to resume.
     */
    fork: async (
      repo: string,
      runId: string,
      at: number,
      step?: StepEdit,
      binding?: GatewayWorkspaceBinding
    ): Promise<GatewayResult<ForkOutput>> => {
      const result = await call(repo, "Run.Fork", { runId, at, ...(step === undefined ? {} : { step }) }, binding)
      if (result.status !== "ok") return historyRefusal(result)
      const decoded = Schema.decodeUnknownOption(ForkOutput)(result.value)
      return Option.isNone(decoded) || decoded.value.parentRunId !== runId
        ? { status: "error", code: INVALID_HISTORY_CODE, message: "The workspace returned an unreadable fork." }
        : { status: "ok", value: decoded.value }
    },

    /** Deliver a named signal to a run parked on a wait. */
    signal: (repo: string, runId: string, name: string, payload: unknown, binding?: GatewayWorkspaceBinding): Promise<GatewayResult<unknown>> =>
      call(repo, "Signal", {
        runId,
        signal: { name, payload: payload ?? {} },
        idempotencyKey: `signal:${runId}:${name}:${crypto.randomUUID()}`
      }, binding),

    /**
     * Steer a running agent. The steer envelope's principal is the server's
     * to stamp (`ControlServer` overwrites it with the authenticated one on
     * every steer that arrives over RPC), so the placeholder here never
     * reaches a journal as authority.
     */
    steer: (
      repo: string,
      runId: string,
      item:
        | { readonly kind: "Message"; readonly body: string }
        | { readonly kind: "Seat"; readonly seat: string }
        | { readonly kind: "Thinking"; readonly thinking: string }
        | { readonly kind: "Tools"; readonly toolNames: ReadonlyArray<string> },
      binding?: GatewayWorkspaceBinding
    ): Promise<GatewayResult<unknown>> => {
      const now = Date.now()
      const nonce = crypto.randomUUID()
      const envelope = {
        messageId: `steer-${runId}-${nonce}`,
        runId,
        principal: { id: "app-operator", kind: "user", stampedAt: now },
        createdAt: now
      }
      const message = (
        item.kind === "Message"
          ? { ...envelope, kind: "Message", body: item.body }
          : item.kind === "Seat"
          ? { ...envelope, kind: "Seat", seat: item.seat }
          : item.kind === "Thinking"
          ? { ...envelope, kind: "Thinking", thinking: item.thinking }
          : { ...envelope, kind: "Tools", toolNames: [...item.toolNames] }
      ) as SteerMessage
      return call(repo, "Steer", { runId, message, idempotencyKey: `steer:${runId}:${nonce}` }, binding)
    },

    /** Every run on the workspace, one summary row each (the run inbox's read). */
    workspaceRuns: async (repo: string, binding?: GatewayWorkspaceBinding): Promise<GatewayResult<ReadonlyArray<RunSummaryRow>>> =>
      decodeRunSummaryRows(await projection(repo, { _tag: "workspace-runs" }, binding)),

    /** The approvals inbox: every pending gate across the workspace's runs. */
    approvalsInbox: async (repo: string, binding?: GatewayWorkspaceBinding): Promise<GatewayResult<ReadonlyArray<ApprovalRow>>> =>
      decodeApprovalRows(await projection(repo, { _tag: "approvals" }, binding)),

    /**
     * Build targets waiting for approval: the box's pending `system/target`
     * plans, as inbox rows. A box that answers no plan listing, or more pages
     * than one read walks, refuses; the caller decides what that means.
     */
    targetApprovals: async (repo: string, binding?: GatewayWorkspaceBinding): Promise<GatewayResult<ReadonlyArray<ApprovalRow>>> => {
      const rows: Array<ApprovalRow> = []
      let cursor: string | undefined
      for (let pages = 0; pages < PLAN_PAGE_CAP; pages++) {
        const listed = await call(repo, "List", {
          _tag: "plans",
          filters: { flowId: "system/target", decision: "pending" },
          ...(cursor === undefined ? {} : { cursor })
        }, binding)
        if (listed.status !== "ok") return listed
        const page = decodePlanPage(listed.value)
        if (Option.isNone(page)) {
          return { status: "error", message: "The workspace answered with a plan list I couldn't read.", code: INVALID_PROJECTION_CODE }
        }
        for (const plan of page.value.items) if (isTargetInput(plan.input)) rows.push(targetRow(plan, plan.input))
        if (page.value.nextCursor === undefined || page.value.items.length === 0) return { status: "ok", value: rows }
        cursor = page.value.nextCursor
      }
      return { status: "error", message: "The workspace lists more build targets than Smithers reads." }
    },

    /** One run's turn-by-turn transcript. */
    transcript: async (repo: string, runId: string, binding?: GatewayWorkspaceBinding): Promise<GatewayResult<ReadonlyArray<TranscriptRow>>> =>
      decodeTranscriptRows(await projection(repo, { _tag: "transcript", runId }, binding)),

    /**
     * How long one flow's nodes have taken, per action tag, folded across
     * every run of it the workspace has finished (D-030).
     *
     * This is the one projection that is neither a run's nor a workspace
     * listing, and it is the newest: a box whose selector union predates it
     * refuses the call at its own RPC boundary, with a payload-decode failure
     * that carries no ControlError code. There is therefore nothing here to
     * tell that refusal from any other, so the caller treats EVERY refusal of
     * this projection as no rows and says nothing about it: a prediction
     * nobody asked for must never become an error somebody has to read.
     */
    flowDurations: async (
      repo: string,
      flowId: string,
      binding?: GatewayWorkspaceBinding
    ): Promise<GatewayResult<ReadonlyArray<FlowDurationRow>>> =>
      decodeFlowDurationRows(await projection(repo, { _tag: "flow-durations", flowId }, binding)),

    /** Journal rows after a cursor; omit it for full historical inspection. */
    runEvents: async (
      repo: string,
      runId: string,
      binding?: GatewayWorkspaceBinding,
      after?: ProjectionCursor
    ): Promise<GatewayResult<ReadonlyArray<ControlEvent>>> =>
      decodeControlEventRows(await projection(repo, { _tag: "run-events", runId }, binding, after))
  }
}

/** The gateway seam this app's controller holds. */
export type GatewaySeam = ReturnType<typeof createGatewaySeam>
