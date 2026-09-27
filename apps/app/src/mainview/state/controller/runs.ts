/*
 * Lane runs — the run lifecycle beyond launch and cancel.
 *
 * `flow.run` launches a run and its card tracks it; this controller is
 * everything an operator does with a run after that: the inbox of every run
 * on the workspace (runs.list), opening one as a card (runs.open), the
 * lifecycle acts (resume, rerun, signal, the steer family), the facets a run
 * card grows (transcript with follow, the verbose events tab), stopping them
 * all, the trace's reader gestures (runs.trace.filter / runs.trace.select,
 * factory spec 06 §6), and the workspace approvals inbox (approvals.list /
 * approvals.open).
 *
 * Every read is a projection and every act a control procedure over the one
 * gateway seam (gateway.ts); nothing here invents a wire. What the wire does
 * not carry, the flows refuse honestly: `by=` names a launcher the run
 * summary does not record, so runs.list says that instead of silently
 * dropping the filter.
 */
import { questionOf } from "../../cards/ApprovalQuestion"
import { codingPlanOf } from "../../cards/CodingPlan"
import { runHandoff } from "../../cards/RunHandoff"
import type { TraceFilter } from "../../cards/RunTrace"
import { traceFromJournal } from "../../cards/RunTrace"
import type { CommandResult } from "../../flows/Flows"
import { flowArgs } from "../../flows/FlowArgs"
import { framePath } from "../../runtime/FrameHistory"
import { lostActRefusal, spokenLostAct } from "../BrowserWriteFailure"
import { actorSharedState } from "../ActorBindings"
import type { ApprovalsInboxRequest, Card, RunOpenRequest } from "../AppState"
import { pendingWorkflowLaunch, workflowInputOf } from "../WorkflowLaunch"
import { sameApproval } from "../ApprovalReference"
import { gatewayBindingFor,gatewayRunContextFor,recordedRunBinding,type GatewayBinding } from "../RepoContext"
import { approvalCardIdFor,cardContainsRun,runCardIdFor,runCardInScope,runScopeFromCard,sameRunScope,type BoxRunScope,type RunScope } from "../RunReference"
import { reconcileRunApprovals } from "./approval-reconciliation"
import type { ControllerContext } from "./context"
import { TOAST_SUPERSEDED } from "./failures"
import type { FormsController } from "./forms"
import type { ApprovalRow, RunSummaryRow } from "./gateway"
import type { WorkflowController } from "./workflows"

/**
 * Which of the run card's three views is showing.
 *
 * The wire is the authority: `RunTrace.ts` folds turns and the timeline and
 * knows nothing about the graph, which is a separate fold over the same
 * journal (FlowGraphStatus.ts).
 */
export type TraceView = NonNullable<Extract<Card, { kind: "run-trace" }>["payload"]["traceView"]>

export interface RunsController {
  readonly prepareRunHandoff: (runId: string, sourceCard?: string) => CommandResult
  readonly listRuns: (args: {
    readonly status?: string
    readonly flow?: string
    readonly lineage?: string
    readonly sourceCard?: string
    readonly by?: string
    readonly repo?: string
  }) => Promise<CommandResult>
  readonly openRun: (runId: string, repo?: string, sourceCard?: string, requestId?: string) => Promise<CommandResult>
  readonly resumeRun: (runId: string, sourceCard?: string) => Promise<CommandResult>
  readonly rerunRun: (runId: string, sourceCard?: string) => Promise<CommandResult>
  readonly signalRun: (runId: string, name: string, payload?: string, sourceCard?: string) => Promise<CommandResult>
  readonly steerRun: (runId: string, body: string, sourceCard?: string) => Promise<CommandResult>
  readonly steerRunSeat: (runId: string, seat: string, sourceCard?: string) => Promise<CommandResult>
  readonly steerRunThinking: (runId: string, thinking: string, sourceCard?: string) => Promise<CommandResult>
  readonly steerRunTools: (runId: string, toolNames: string, sourceCard?: string) => Promise<CommandResult>
  readonly showRunLogs: (runId: string, follow?: boolean, sourceCard?: string) => Promise<CommandResult>
  readonly showRunSteps: (runId: string, sourceCard?: string) => Promise<CommandResult>
  readonly showRunEvents: (runId: string, sourceCard?: string) => Promise<CommandResult>
  /*
   * Where the reader parked is durable state, so each of these gestures answers
   * only once its card write is. A gesture that answered first lost the write
   * to a reload issued straight after it: a production keyboard walk pressed
   * Latest, reloaded, and found the card still parked at its cursor.
   */
  /** `runs.trace.filter <runId> <filter>`: the trace's active filter, in the card payload (spec 06 §5, §6). */
  readonly traceFilter: (runId: string, filter: TraceFilter, sourceCard?: string) => Promise<CommandResult>
  /** `runs.trace.select <runId> <nodeId> [seq]`: the trace's selection and scrub cursor; leaves live tail. */
  readonly traceSelect: (runId: string, nodeId: string, seq?: number, sourceCard?: string) => Promise<CommandResult>
  readonly traceView: (runId: string, view: TraceView, sourceCard?: string) => Promise<CommandResult>
  /** `runs.graph.follow <runId> <on|off>`: whether the graph's camera follows the running node. */
  readonly graphFollow: (runId: string, follow: boolean, sourceCard?: string) => Promise<CommandResult>
  readonly traceLive: (runId: string, sourceCard?: string) => Promise<CommandResult>
  readonly selectCodingChange: (runId: string, changeId: string, sourceCard?: string) => Promise<CommandResult>
  readonly stopAllRuns: (repo?: string, sourceCard?: string) => Promise<CommandResult>
  /**
   * `approvals.list [owner/repo]`: persist the read request for the target
   * named NOW, acknowledge, and read the workspace inbox in the background
   * (root AGENTS "Instant chat; slow work runs in the background").
   */
  readonly listApprovals: (repo?: string) => Promise<CommandResult>
  /** Reconnect every persisted inbox read the current account still owns; idempotent. */
  readonly resumeApprovalRequests: () => void
  readonly resumeRunFacetRequests: () => void
  readonly resumeRunListRequests: () => void
  readonly resumeRunOpenRequests: () => void
  readonly openApproval: (runId: string, sourceCard?: string) => Promise<CommandResult>
}

/** Why a run is not moving, in one word the card can render. */
const waitingWord = (row: RunSummaryRow): string | undefined =>
  row.status === "accepted"
    // The CLI's own render-time convention: accepted means nothing is driving it yet.
    ? "executor"
    : row.status === "parked"
    ? row.waitingReason ?? "parked"
    : undefined

export const createRunsController = (
  ctx: ControllerContext,
  nextTranscriptOrdinal: () => number,
  workflows: WorkflowController,
  renderFlowForm?: FormsController["renderFlowForm"]
): RunsController => {
  const { store, gateway } = ctx

  // A named trace is the reader's exact view; ancillary cards identify only a run scope.
  const runCardFor = (scope: RunScope, sourceCard?: string) => {
    const source = sourceCard === undefined ? undefined : store.collections.cards.get(sourceCard)
    if (source?.kind === "run-trace") return sameRunScope(source.payload, scope) ? source : undefined
    return runCardInScope(store, scope)
  }
  const prepareRunHandoff: RunsController["prepareRunHandoff"] = (runId, sourceCard) => {
    const source = sourceCard === undefined ? undefined : store.collections.cards.get(sourceCard)
    const target = resolveRun(runId, sourceCard)
    if ("error" in target) return target.error
    const card = source?.kind === "run-trace" ? source : runCardFor(target)
    if (card === undefined) return "Open this run's card before preparing its handoff."
    const cardId = `handoff-${card.id}`
    const existing = store.collections.cards.get(cardId)
    if (existing?.kind === "flow-form" && existing.status !== "acted") return { value: "The editable handoff is already open; your draft is preserved." }
    const frame = [...store.collections.frames.values()].find(frame => frame.cardId === card.id)
    const origin = ctx.baseUrl || (typeof location === "undefined" ? "" : location.origin)
    const sourceHref = frame === undefined ? undefined : `${origin}${framePath({ workspaceId: frame.workspaceId, branchId: frame.branchId, frameId: frame.id })}`
    const rendered = renderFlowForm?.({
      name: "chat.copy-message", args: runHandoff(card, sourceHref), via: "user", cardId, title: `Handoff — ${card.title}`,
      hints: { fields: { text: { kind: "textarea", label: "Handoff brief" } }, submitLabel: "Copy brief" }
    })
    return rendered === undefined ? "The handoff form could not be rendered." : { value: "Prepared an editable handoff brief. Review the recorded evidence, fill in remaining work, then copy it." }
  }
  const patchRunCard = (scope: RunScope, patch: Partial<Extract<Card, { kind: "run-trace" }>["payload"]>): void => {
    const card = runCardFor(scope)
    if (card === undefined) return
    store.dispatch({ type: "card.updated", actor: "system", id: card.id, patch: { payload: { ...card.payload, ...patch } } })
  }
  const pokeRun = (scope: RunScope): void => {
    const card = runCardFor(scope)
    if (card !== undefined) ctx.pumpPokes.get(card.id)?.()
  }

  /** Capture the address once, before any await. An explicit source must actually contain this run. */
  const resolveRun = (runId: string, sourceCard?: string, preferred?: string, allowChild = false): BoxRunScope | { readonly error: string } => {
    const boxed = (scope: RunScope): BoxRunScope | { readonly error: string } => {
      const binding = recordedRunBinding(scope)
      return "error" in binding ? binding : { repo: scope.repo, runId: scope.runId, workspaceId: binding.workspaceId }
    }
    if (sourceCard !== undefined) {
      const source = store.collections.cards.get(sourceCard)
      if (source === undefined || !cardContainsRun(source, runId, allowChild)) {
        return { error: `Card ${sourceCard} does not record run ${runId}.` }
      }
      const scope = runScopeFromCard(store, source, runId)
      if (scope === undefined || (preferred !== undefined && preferred !== scope.repo)) {
        return { error: "The source card belongs to another repository or has no recorded gateway." }
      }
      return boxed(scope)
    }
    const recorded = gatewayRunContextFor(store, runId)
    if (recorded !== undefined) {
      if ("error" in recorded) return recorded
      if (preferred !== undefined && preferred !== recorded.repo) return { error: "The run belongs to another repository." }
      return boxed({ ...recorded, runId })
    }
    const target = workflows.workflowTargetRepo(preferred)
    if ("error" in target) return target
    const binding = gatewayBindingFor(store, target.repo)
    return "error" in binding ? binding : { repo: target.repo, runId, workspaceId: binding.workspaceId }
  }

  type RunListCard = Extract<Card, { kind: "run-list" }>
  type ListRequest = NonNullable<RunListCard["payload"]["listRequest"]>
  const listReads = actorSharedState(ctx, "run-list-reads", () => ({
    inFlight: new Map<string, { id: string; epoch: number; work: Promise<unknown> }>(),
    persisting: new Map<string, Promise<unknown>>()
  }))
  const sameList = (left: Pick<ListRequest, "repo" | "workspaceId" | "status" | "flow" | "lineage">, right: typeof left) =>
    left.repo === right.repo && left.workspaceId === right.workspaceId && left.status === right.status && left.flow === right.flow && left.lineage === right.lineage
  const listBinding = (card: RunListCard): GatewayBinding => {
    if (card.payload.workspaceId !== undefined || card.payload.gatewayBindingVersion === 1) return recordedRunBinding(card.payload, "This list's box is gone.")
    const scopes = card.payload.runs.map(run => runScopeFromCard(store, card, run.runId))
    if (scopes.some(scope => scope === undefined || scope.workspaceId !== scopes[0]?.workspaceId)) {
      return { error: "The historical run list records several boxes. Open a run from its own recorded card before listing that box." }
    }
    return recordedRunBinding({ workspaceId: scopes[0]?.workspaceId }, "This list's box is gone.")
  }
  const listCard = (id: string, request: ListRequest): RunListCard | undefined => {
    const card = store.collections.cards.get(id)
    return card?.kind === "run-list" && card.payload.listRequest?.id === request.id && sameList(card.payload, request) ? card : undefined
  }
  const readRunList = (cardId: string, request: ListRequest): Promise<unknown> => {
    const epoch = ctx.accountEpoch
    const running = listReads.inFlight.get(cardId)
    if (running?.id === request.id && running.epoch === epoch) return running.work
    const current = () => !ctx.disposed && ctx.accountEpoch === epoch && ctx.accountOwner() === request.owner && listCard(cardId, request) !== undefined
    const key = `runs.list.${cardId}`
    const work = ctx.withToast(key, "Loading runs…", "Runs loaded", async () => {
      try {
        if (!current()) return TOAST_SUPERSEDED
        const { repo } = request
        const binding = recordedRunBinding(request, "This list's box is gone.")
        if ("error" in binding) throw new Error(binding.error)
        const provisioned = await workflows.provisionWorkspace(repo, binding)
        if (!current()) return TOAST_SUPERSEDED
        if (provisioned !== true) throw new Error(provisioned)
        const attention = request.status === "attention"
        const [listed, inbox] = await Promise.all([
          gateway.workspaceRuns(repo, binding), attention ? gateway.approvalsInbox(repo, binding) : undefined
        ])
        if (!current()) return TOAST_SUPERSEDED
        if (listed.status !== "ok" && !attention) throw new Error(listed.message)
        const observed = listed.status === "ok" ? listed.value : []
        for (const summary of observed) {
          if (!current()) return TOAST_SUPERSEDED
          await store.dispatch({ type: "gateway.run.observed", actor: "system", observation: {
            scope: { repo, ...binding, runId: summary.runId }, summary
          } }).isPersisted.promise
        }
        if (inbox?.status === "ok") for (const runId of new Set(inbox.value.map(row => row.runId))) {
          if (!current()) return TOAST_SUPERSEDED
          await reconcileRunApprovals(store, { repo, ...binding, runId }, inbox.value.filter(row => row.runId === runId))
        }
        if (!current()) return TOAST_SUPERSEDED
        const pending = inbox?.status === "ok" ? inbox.value.filter(row => row.status === "pending") : []
        const errors = [listed.status === "error" ? listed.message : undefined, inbox?.status === "error" ? inbox.message : undefined]
          .filter((error): error is string => error !== undefined)
        const rows = observed.filter(row =>
          (request.status === undefined || (attention ? ["parked", "failed", "waiting-approval"].includes(row.status) : row.status === request.status)) &&
          (request.flow === undefined || row.flowId === request.flow) && (request.lineage === undefined || row.lineageId === request.lineage)
        ).sort((left, right) => right.createdAt - left.createdAt)
        const card = listCard(cardId, request)!
        await store.dispatch({ type: "card.upsert", actor: "system", card: { ...card, status: errors.length ? "error" : "active", payload: {
          ...card.payload, listRequest: { ...request, state: errors.length ? "failed" : "complete" },
          ...(attention ? { approvals: pending.map(({ runId, requestId, title }) => ({ runId, requestId, title })) } : {}),
          observedAt: Date.now(), ...(errors.length ? { observationError: errors.join(" · ") } : {}),
          statuses: [...new Set(observed.map(row => row.status))].sort(),
          runs: rows.map(row => ({ runId: row.runId, flowId: row.flowId, status: row.status,
            ...(row.statusRollup?.subjectId === `run:${row.runId}` && row.statusRollup.state === row.status ? { statusRollup: row.statusRollup } : {}),
            ...(waitingWord(row) === undefined ? {} : { waiting: waitingWord(row) }), createdAt: row.createdAt, turns: row.turns, calls: row.calls }))
        } } }).isPersisted.promise
        return current() ? errors.length ? errors.join(" · ") : true : TOAST_SUPERSEDED
      } catch (error) {
        if (!current()) return TOAST_SUPERSEDED
        const message = error instanceof Error ? error.message : String(error)
        const card = listCard(cardId, request)!
        try {
          await store.dispatch({ type: "card.upsert", actor: "system", card: { ...card, status: "error", payload: {
            ...card.payload, observationError: message, listRequest: { ...request, state: "failed" }
          } } }).isPersisted.promise
        } catch { return current() ? "The run list could not be saved. Refresh to retry." : TOAST_SUPERSEDED }
        return current() ? message : TOAST_SUPERSEDED
      }
    }, false, current)
    const entry = { id: request.id, epoch, work }
    listReads.inFlight.set(cardId, entry)
    void work.then(outcome => {
      if (typeof outcome !== "string" || !current() || listReads.inFlight.get(cardId) !== entry) return
      if (store.collections.toasts.get(`toast-${key}`) === undefined) store.dispatch({ type: "toast.shown", actor: "system", key, title: "Runs" })
      ctx.resolveToast(key, { status: "failed", detail: outcome })
    }).finally(() => {
      if (listReads.inFlight.get(cardId) === entry) listReads.inFlight.delete(cardId)
    }).catch(error => ctx.failures.report("toast.work", error, key))
    return work
  }

  const listRuns: RunsController["listRuns"] = async (args) => {
    const guard = workflows.workflowIdentityGuard()
    if (guard !== undefined) return guard
    /*
     * The wire's run summary carries no launcher principal, and Control.list
     * refuses the filter — so a by= the app silently dropped would list runs
     * the human asked to exclude. Refuse in words instead.
     */
    if (args.by !== undefined) {
      return "Runs don't record who launched them on this wire, so there is no by= to filter with — status, flow, and lineage are the filters that exist."
    }
    const named = args.sourceCard === undefined ? undefined : store.collections.cards.get(args.sourceCard)
    const target = workflows.workflowTargetRepo(args.repo ?? (named?.kind === "run-list" ? named.payload.repo : undefined))
    if ("error" in target) return target.error
    const repo = target.repo
    const source = args.sourceCard === undefined ? undefined : store.collections.cards.get(args.sourceCard)
    if (args.sourceCard !== undefined && (source?.kind !== "run-list" || source.payload.repo !== repo)) {
      return "The run list is unavailable or belongs to another repository."
    }
    const binding = source?.kind === "run-list" ? listBinding(source) : gatewayBindingFor(store, repo)
    if ("error" in binding) return binding.error
    const owner = ctx.accountOwner()
    if (typeof owner !== "string") return "Sign in with GitHub first."
    const epoch = ctx.accountEpoch
    const current = () => !ctx.disposed && ctx.accountEpoch === epoch && ctx.accountOwner() === owner
    const changed = "The account or run list changed. Refresh to retry."
    const cardId = source?.kind === "run-list" ? source.id : `run-list-${repo}-${binding.workspaceId}`
    for (let saving = listReads.persisting.get(cardId); saving !== undefined; saving = listReads.persisting.get(cardId)) {
      try { await saving } catch { /* The original command reports its failed save. */ }
      if (!current()) return changed
    }
    const existing = store.collections.cards.get(cardId)
    if (!current() || (existing !== undefined && existing.kind !== "run-list")) return changed
    if (args.sourceCard !== undefined) {
      if (existing?.kind !== "run-list" || existing.payload.repo !== repo) return changed
      const retained = listBinding(existing)
      if ("error" in retained || retained.workspaceId !== binding.workspaceId) return changed
    }
    const filters = { repo, workspaceId: binding.workspaceId,
      ...(args.status === undefined ? {} : { status: args.status }), ...(args.flow === undefined ? {} : { flow: args.flow }),
      ...(args.lineage === undefined ? {} : { lineage: args.lineage }) }
    const previous = existing?.payload.listRequest
    const running = listReads.inFlight.get(cardId)
    const acknowledgment = { value: "Runs requested." }
    if (previous?.owner === owner && sameList(previous, filters) && previous.state !== "failed" &&
      (previous.state === "pending" || running?.id === previous.id && running.epoch === epoch)) {
      void readRunList(cardId, previous)
      return acknowledgment
    }
    const request: ListRequest = { id: crypto.randomUUID(), owner, ...filters, state: "pending" }
    const saving = store.dispatch({ type: "card.upsert", actor: ctx.commandActor, card: {
      id: cardId, kind: "run-list", title: `${args.status === "attention" ? "Needs attention" : "Runs"} — ${repo}`, status: "active",
      createdAt: existing?.createdAt ?? Date.now(), ordinal: existing?.ordinal ?? nextTranscriptOrdinal(),
      payload: { ...filters, gatewayBindingVersion: 1, listRequest: request, runs: [], statuses: existing?.payload.statuses ?? [] }
    } }).isPersisted.promise
    listReads.persisting.set(cardId, saving)
    try { await saving } finally { if (listReads.persisting.get(cardId) === saving) listReads.persisting.delete(cardId) }
    if (!current() || listCard(cardId, request) === undefined) return changed
    void readRunList(cardId, request)
    return acknowledgment
  }

  const resumeRunListRequests = (): void => {
    const epoch = ctx.accountEpoch
    const owner = ctx.accountOwner()
    if (ctx.disposed || typeof owner !== "string") return
    const current = () => !ctx.disposed && ctx.accountEpoch === epoch && ctx.accountOwner() === owner
    const timer = setTimeout(() => {
      if (!current()) return
      void (store.settled?.() ?? Promise.resolve()).then(() => {
        if (!current() || workflows.workflowIdentityGuard() !== undefined) return
        for (const card of store.collections.cards.values()) {
          if (card.kind !== "run-list") continue
          const request = card.payload.listRequest
          if (request?.state === "pending" && request.owner === owner && sameList(card.payload, request)) void readRunList(card.id, request)
        }
      }, () => {})
    }, 0)
    ctx.unref(timer)
  }

  class OpenReadRefusal extends Error {}
  const openReads = actorSharedState(ctx, "run-open-reads", () => ({
    inFlight: new Map<string, { request: RunOpenRequest; epoch: number; work: Promise<unknown> }>(),
    persisting: new Map<string, Promise<unknown>>()
  }))
  const openKey = (target: Pick<RunOpenRequest, "repo" | "workspaceId" | "runId" | "cardId">): string =>
    JSON.stringify([target.repo, target.workspaceId ?? null, target.runId, target.cardId ?? null])
  const openRequest = (id: string) => store.session().runOpenRequests?.find(row => row.id === id)
  const openFailure = (request: RunOpenRequest, message: string): void => {
    const key = `runs.open.${encodeURIComponent(openKey(request))}`
    if (store.collections.toasts.get(`toast-${key}`) === undefined) store.dispatch({ type: "toast.shown", actor: "system", key, title: "Opening run" })
    ctx.resolveToast(key, { status: "failed", detail: message,
      action: { flow: "runs.open", args: flowArgs("runs.open", { runId: request.runId, repo: request.repo, requestId: request.id }), label: "Retry" } })
  }
  const readRunOpen = (request: RunOpenRequest): Promise<unknown> => {
    const key = openKey(request)
    const epoch = ctx.accountEpoch
    const running = openReads.inFlight.get(key)
    if (running?.request.id === request.id && running.epoch === epoch) return running.work
    let settling = false
    const ownsAccount = () => !ctx.disposed && ctx.accountEpoch === epoch && ctx.accountOwner() === request.owner
    const current = () => ownsAccount() && (openRequest(request.id) !== undefined || (settling && !(store.session().runOpenRequests ?? []).some(row => openKey(row) === key)))
    const work = ctx.withToast(`runs.open.${encodeURIComponent(key)}`, "Opening run…", "Run opened", async () => {
      try {
        if (!current()) return TOAST_SUPERSEDED
        const binding = recordedRunBinding(request)
        if ("error" in binding) throw new OpenReadRefusal(binding.error)
        const target: BoxRunScope = { repo: request.repo, runId: request.runId, workspaceId: binding.workspaceId }
        const provisioned = await workflows.provisionWorkspace(request.repo, binding)
        if (!current()) return TOAST_SUPERSEDED
        if (provisioned !== true) throw new OpenReadRefusal(provisioned)
        const summary = await gateway.run(request.repo, request.runId, binding)
        if (!current()) return TOAST_SUPERSEDED
        if (summary.status !== "ok") throw new OpenReadRefusal(summary.message)
        if (summary.value === undefined) throw new OpenReadRefusal(`There's no run ${request.runId} on ${request.repo}.`)
        const checkSource = (required = request.requireExisting): void => {
          const source = store.collections.cards.get(request.cardId)
          if ((required || source !== undefined) && (source?.kind !== "run-trace" || !sameRunScope(source.payload, target))) throw new OpenReadRefusal("The source run changed. Open it again.")
        }
        checkSource()
        await store.dispatch({ type: "gateway.run.observed", actor: "system", observation: { scope: target, summary: summary.value, summaryCursor: summary.cursor } }).isPersisted.promise
        if (!current()) return TOAST_SUPERSEDED
        checkSource()
        await workflows.upsertRunCard({ ...target, cardId: request.cardId, requireExisting: request.requireExisting, workflow: summary.value.flowId,
          title: `${summary.value.flowId} — ${request.repo}`, firstStep: `Watching ${summary.value.flowId} (run ${request.runId}).`, observe: true })
        if (!current()) return TOAST_SUPERSEDED
        checkSource(true)
        // The optimistic removal must not hide progress while its durable receipt is still held.
        settling = true
        await store.dispatch({ type: "runs.open.settled", actor: "system", id: request.id }).isPersisted.promise
        return ownsAccount() ? true : TOAST_SUPERSEDED
      } catch (error) {
        if (!current()) return TOAST_SUPERSEDED
        const message = error instanceof OpenReadRefusal ? error.message : lostActRefusal(error)
        // Background completion has no command failure surface to speak for a refused write.
        if (spokenLostAct(message)) {
          try { await store.dispatch({ type: "message.appended", actor: "system", text: message }).isPersisted.promise } catch { /* The failed toast remains visible if storage still refuses. */ }
          if (!current()) return TOAST_SUPERSEDED
        }
        try { await store.dispatch({ type: "runs.open.settled", actor: "system", id: request.id, error: message }).isPersisted.promise }
        catch { return current() ? "The run monitor could not be saved. Retry opening it." : TOAST_SUPERSEDED }
        return current() ? message : TOAST_SUPERSEDED
      }
    }, false, current)
    const entry = { request, epoch, work }
    openReads.inFlight.set(key, entry)
    void work.then(outcome => {
      if (typeof outcome === "string" && current() && openReads.inFlight.get(key) === entry) openFailure(request, outcome)
    }).finally(() => { if (openReads.inFlight.get(key) === entry) openReads.inFlight.delete(key) })
      .catch(error => ctx.failures.report("toast.work", error, key))
    return work
  }

  const openRun: RunsController["openRun"] = async (runId, repoArg, sourceCard, requestId) => {
    const guard = workflows.workflowIdentityGuard()
    if (guard !== undefined) return guard
    const owner = ctx.accountOwner()
    if (typeof owner !== "string") return "Sign in with GitHub first."
    const retry = requestId === undefined ? undefined : openRequest(requestId)
    if (requestId !== undefined && (retry === undefined || retry.owner !== owner || retry.runId !== runId ||
      (repoArg !== undefined && retry.repo !== repoArg) || sourceCard !== undefined)) return "The saved run request is unavailable. Open the run again."
    const retryBinding = retry === undefined ? undefined : recordedRunBinding(retry)
    const target = retry === undefined || retryBinding === undefined ? resolveRun(runId, sourceCard, repoArg, true)
      : "error" in retryBinding ? retryBinding : { repo: retry.repo, runId: retry.runId, workspaceId: retryBinding.workspaceId }
    if ("error" in target) return target.error
    const source = runCardFor(target, sourceCard)
    const cardId = retry?.cardId ?? source?.id ?? runCardIdFor(store, target)
    const requireExisting = retry === undefined ? source !== undefined : retry.requireExisting === true
    const key = openKey({ ...target, cardId })
    const epoch = ctx.accountEpoch
    const current = () => !ctx.disposed && ctx.accountEpoch === epoch && ctx.accountOwner() === owner
    for (let saving = openReads.persisting.get(key); saving !== undefined; saving = openReads.persisting.get(key)) {
      try { await saving } catch { /* The original command reports its refused admission. */ }
      if (!current()) return "The account changed before the run was requested."
    }
    if (!current()) return "The account changed before the run was requested."
    const recorded = store.session().runOpenRequests?.find(row => row.owner === owner && openKey(row) === key)
    const running = openReads.inFlight.get(key)
    const acknowledgment = { value: `Run requested: ${runId}.` }
    if (recorded?.error === undefined && running?.epoch === epoch && running.request.owner === owner) return acknowledgment
    if (recorded !== undefined && recorded.error === undefined) {
      void readRunOpen(recorded)
      return acknowledgment
    }
    const request = { id: crypto.randomUUID(), owner, ...target, cardId, ...(requireExisting ? { requireExisting: true } : {}) }
    const saving = store.dispatch({ type: "runs.open.requested", actor: ctx.commandActor, request }).isPersisted.promise
    openReads.persisting.set(key, saving)
    try { await saving } finally { if (openReads.persisting.get(key) === saving) openReads.persisting.delete(key) }
    const persisted = openRequest(request.id)
    if (!current() || persisted === undefined) return "The account changed before the run was requested."
    void readRunOpen(persisted)
    return acknowledgment
  }

  const resumeRunOpenRequests = (): void => {
    const epoch = ctx.accountEpoch
    const owner = ctx.accountOwner()
    if (ctx.disposed || typeof owner !== "string") return
    const current = () => !ctx.disposed && ctx.accountEpoch === epoch && ctx.accountOwner() === owner
    const timer = setTimeout(() => {
      if (!current()) return
      void (store.settled?.() ?? Promise.resolve()).then(() => {
        if (!current() || workflows.workflowIdentityGuard() !== undefined) return
        for (const request of store.session().runOpenRequests ?? []) {
          if (request.owner !== owner) continue
          if (request.error !== undefined) openFailure(request, request.error)
          else void readRunOpen(request)
        }
      }, () => {})
    }, 0)
    ctx.unref(timer)
  }

  const resumeRun = async (runId: string, sourceCard?: string): Promise<CommandResult> => {
    const guard = workflows.workflowIdentityGuard()
    if (guard !== undefined) return guard
    const target = resolveRun(runId, sourceCard)
    if ("error" in target) return target.error
    const card = runCardFor(target)
    const resumed = await gateway.resume(
      target.repo,
      runId,
      card?.payload.waiting === "executor" ? "Nothing was driving the run." : undefined,
      { workspaceId: target.workspaceId }
    )
    if (resumed.status !== "ok") return resumed.message
    pokeRun(target)
    return { value: `resume-requested run=${runId}` }
  }

  const rerunRun = async (runId: string, sourceCard?: string): Promise<CommandResult> => {
    const guard = workflows.workflowIdentityGuard()
    if (guard !== undefined) return guard
    const target = resolveRun(runId, sourceCard)
    if ("error" in target) return target.error
    const card = runCardFor(target, sourceCard)
    if (card === undefined) {
      return `Open the run first (runs.open ${runId}) — rerunning needs the card that knows the flow and its launch input.`
    }
    if (card.payload.input === undefined) {
      return `This run's launch input isn't recorded on this client, so there's nothing faithful to rerun — start the flow fresh with flow.run ${card.payload.workflow}.`
    }
    return workflows.requestRerun({
      repo: target.repo,
      binding: { workspaceId: target.workspaceId },
      runId,
      workflow: card.payload.workflow,
      input: workflowInputOf(card)!
    })
  }

  const signalRun = async (runId: string, name: string, payloadText?: string, sourceCard?: string): Promise<CommandResult> => {
    const guard = workflows.workflowIdentityGuard()
    if (guard !== undefined) return guard
    if (name.trim() === "") return "runs.signal needs the signal's name."
    let payload: unknown = {}
    if (payloadText !== undefined && payloadText.trim() !== "") {
      try {
        payload = JSON.parse(payloadText)
      } catch {
        return `That signal payload isn't JSON: ${payloadText}`
      }
    }
    const target = resolveRun(runId, sourceCard)
    if ("error" in target) return target.error
    const signaled = await gateway.signal(target.repo, runId, name.trim(), payload, { workspaceId: target.workspaceId })
    if (signaled.status !== "ok") return signaled.message
    pokeRun(target)
    return { value: `signal-sent run=${runId} signal=${name.trim()}` }
  }

  const steer = async (
    runId: string,
    item:
      | { readonly kind: "Message"; readonly body: string }
      | { readonly kind: "Seat"; readonly seat: string }
      | { readonly kind: "Thinking"; readonly thinking: string }
      | { readonly kind: "Tools"; readonly toolNames: ReadonlyArray<string> },
    sourceCard?: string
  ): Promise<CommandResult> => {
    const guard = workflows.workflowIdentityGuard()
    if (guard !== undefined) return guard
    const target = resolveRun(runId, sourceCard)
    if ("error" in target) return target.error
    const steered = await gateway.steer(target.repo, runId, item, { workspaceId: target.workspaceId })
    if (steered.status !== "ok") return steered.message
    patchRunCard(target, { steeringPending: true })
    pokeRun(target)
    return { value: `steered run=${runId}` }
  }

  const steerRun = (runId: string, body: string, sourceCard?: string): Promise<CommandResult> =>
    body.trim() === ""
      ? Promise.resolve("runs.steer needs the message to deliver.")
      : steer(runId, { kind: "Message", body }, sourceCard)

  const steerRunSeat = (runId: string, seat: string, sourceCard?: string): Promise<CommandResult> =>
    seat.trim() === ""
      ? Promise.resolve("runs.seat needs the seat to move the run to.")
      : steer(runId, { kind: "Seat", seat: seat.trim() }, sourceCard)

  const steerRunThinking = (runId: string, thinking: string, sourceCard?: string): Promise<CommandResult> =>
    thinking.trim() === ""
      ? Promise.resolve("runs.thinking needs the thinking level.")
      : steer(runId, { kind: "Thinking", thinking: thinking.trim() }, sourceCard)

  const steerRunTools = (runId: string, toolNames: string, sourceCard?: string): Promise<CommandResult> => {
    const names = toolNames.split(",").map((name) => name.trim()).filter((name) => name !== "")
    return names.length === 0
      ? Promise.resolve("runs.tools needs the tool names, comma-separated.")
      : steer(runId, { kind: "Tools", toolNames: names }, sourceCard)
  }

  type RunCard = Extract<Card, { kind: "run-trace" }>
  type FacetRequest = NonNullable<RunCard["payload"]["facetRequest"]>
  const facetReads = actorSharedState(ctx, "run-facet-reads", () => ({
    inFlight: new Map<string, { id: string; epoch: number; work: Promise<unknown> }>(),
    persisting: new Map<string, Promise<unknown>>()
  }))
  const facetCard = (cardId: string, request: FacetRequest): RunCard | undefined => {
    const card = store.collections.cards.get(cardId)
    return card?.kind === "run-trace" && sameRunScope(card.payload, request) && card.payload.facetRequest?.id === request.id ? card : undefined
  }

  /** Only the saved request owns its response; a new facet or account retires it. */
  const readRunFacet = (cardId: string, request: FacetRequest): Promise<unknown> => {
    const epoch = ctx.accountEpoch
    const running = facetReads.inFlight.get(cardId)
    if (running?.id === request.id && running.epoch === epoch) return running.work
    const current = () => !ctx.disposed && ctx.accountEpoch === epoch && ctx.accountOwner() === request.owner && facetCard(cardId, request) !== undefined
    const title = request.facet === "transcript" ? "Transcript" : "Events"
    const key = `runs.facet.${cardId}`
    const saveFailure = "The facet result could not be saved. Try again."
    const work = ctx.withToast(key, `Loading ${title.toLowerCase()}…`, `${title} loaded`, async () => {
      try {
        if (!current()) return TOAST_SUPERSEDED
        const binding = recordedRunBinding(request)
        if ("error" in binding) throw new Error(binding.error)
        const target: BoxRunScope = { repo: request.repo, runId: request.runId, workspaceId: binding.workspaceId }
        const result = request.facet === "transcript"
          ? { facet: "transcript" as const, answer: await gateway.transcript(request.repo, request.runId, binding) }
          : { facet: "events" as const, answer: await gateway.runEvents(request.repo, request.runId, binding) }
        if (!current()) return TOAST_SUPERSEDED
        if (result.answer.status !== "ok") throw new Error(result.answer.message)
        // The shared observation is run data; the reader's choice remains on its exact card.
        if (result.facet === "transcript") {
          await store.dispatch({ type: "gateway.run.observed", actor: "system", observation: {
            scope: target, transcript: [...result.answer.value], transcriptCursor: result.answer.cursor
          } }).isPersisted.promise
        } else {
          await store.dispatch({ type: "gateway.run.observed", actor: "system", observation: {
            scope: target, journal: { mode: "full", events: [...result.answer.value] }
          } }).isPersisted.promise
        }
        if (!current()) return TOAST_SUPERSEDED
        const card = facetCard(cardId, request)!
        const { transcriptAtRevision: previousRevision, ...payload } = card.payload
        const transcript = result.facet === "transcript" ? {
          follow: request.follow === true,
          ...(request.follow === true ? {} : { transcriptAtRevision: store.session().revision }),
          transcriptRows: result.answer.value.map(row => ({
            sequence: row.sequence, ...(row.turn === undefined ? {} : { turn: row.turn }),
            ...(row.at === undefined ? {} : { at: row.at }), kind: row.kind, text: row.text
          }))
        } : previousRevision === undefined ? {} : { transcriptAtRevision: previousRevision }
        await store.dispatch({ type: "card.upsert", actor: "system", card: { ...card, payload: {
          ...payload, ...transcript, facetRequest: { ...request, state: "complete" }
        } } }).isPersisted.promise
        if (!current()) return TOAST_SUPERSEDED
        if (request.follow === true) pokeRun(request)
        return true
      } catch (error) {
        if (!current()) return TOAST_SUPERSEDED
        const message = error instanceof Error ? error.message : String(error)
        const card = facetCard(cardId, request)!
        try {
          await store.dispatch({ type: "card.updated", actor: "system", id: cardId,
            patch: { payload: { ...card.payload, facetRequest: { ...request, state: "failed", error: message } } }
          }).isPersisted.promise
        } catch { return current() ? saveFailure : TOAST_SUPERSEDED }
        return current() ? message : TOAST_SUPERSEDED
      }
    }, false, current)
    const entry = { id: request.id, epoch, work }
    facetReads.inFlight.set(cardId, entry)
    void work.then(outcome => {
      // A failure inside the toast debounce still has a durable card error and a failed notice.
      if (typeof outcome !== "string" || !current() || facetReads.inFlight.get(cardId) !== entry) return
      if (store.collections.toasts.get(`toast-${key}`) === undefined) store.dispatch({ type: "toast.shown", actor: "system", key, title })
      ctx.resolveToast(key, { status: "failed", title, detail: outcome })
    }).finally(() => {
      if (facetReads.inFlight.get(cardId) === entry) facetReads.inFlight.delete(cardId)
    }).catch(error => ctx.failures.report("toast.work", error, key))
    return work
  }

  const requestRunFacet = async (runId: string, facet: "transcript" | "events", toggleFollow = false, sourceCard?: string): Promise<CommandResult> => {
    const guard = workflows.workflowIdentityGuard()
    if (guard !== undefined) return guard
    const target = resolveRun(runId, sourceCard)
    if ("error" in target) return target.error
    const selected = runCardFor(target, sourceCard)
    if (selected === undefined) return `Open the run first (runs.open ${runId}).`
    const owner = ctx.accountOwner()
    if (typeof owner !== "string") return "Sign in with GitHub first."
    const epoch = ctx.accountEpoch
    const current = () => !ctx.disposed && ctx.accountEpoch === epoch && ctx.accountOwner() === owner
    const changed = "The run or account changed before the facet could be read. Try again."
    // The user and agent doors share admission as well as the subsequent read.
    for (let saving = facetReads.persisting.get(selected.id); saving !== undefined; saving = facetReads.persisting.get(selected.id)) {
      try { await saving } catch { /* The original request reports its failed admission. */ }
      if (!current()) return changed
    }
    const card = store.collections.cards.get(selected.id)
    if (!current() || card?.kind !== "run-trace" || !sameRunScope(card.payload, target)) return changed
    const recorded = card.payload.facetRequest
    const running = facetReads.inFlight.get(card.id)
    const acknowledgment = { value: facet === "transcript" ? "Transcript requested." : "Events requested." }
    if (recorded?.owner === owner && sameRunScope(recorded, target) && recorded.facet === facet &&
      (recorded.toggleFollow === true) === toggleFollow && recorded.state !== "failed" &&
      (recorded.state === "pending" || running?.id === recorded.id && running.epoch === epoch)) {
      void readRunFacet(card.id, recorded)
      return acknowledgment
    }
    const request: FacetRequest = { id: crypto.randomUUID(), owner, ...target, facet, state: "pending",
      ...(facet === "transcript" ? { toggleFollow, follow: toggleFollow ? card.payload.follow !== true : false } : {}) }
    const saving = store.dispatch({ type: "card.updated", actor: ctx.commandActor, id: card.id,
      patch: { payload: { ...card.payload, facet, facetRequest: request } }
    }).isPersisted.promise
    facetReads.persisting.set(card.id, saving)
    try { await saving } finally {
      if (facetReads.persisting.get(card.id) === saving) facetReads.persisting.delete(card.id)
    }
    if (!current() || facetCard(card.id, request) === undefined) return changed
    void readRunFacet(card.id, request)
    return acknowledgment
  }

  const showRunLogs = (runId: string, follow?: boolean, sourceCard?: string): Promise<CommandResult> =>
    requestRunFacet(runId, "transcript", follow === true, sourceCard)

  /** Steps also retires an in-flight facet read, so its late answer cannot change this choice. */
  const showRunSteps = async (runId: string, sourceCard?: string): Promise<CommandResult> => {
    const target = resolveRun(runId, sourceCard)
    if ("error" in target) return target.error
    const card = runCardFor(target, sourceCard)
    if (card === undefined) return `Open the run first (runs.open ${runId}).`
    const { facetRequest: _request, ...payload } = card.payload
    await store.dispatch({ type: "card.upsert", actor: ctx.commandActor, card: { ...card, payload: { ...payload, facet: "steps", follow: false } } }).isPersisted.promise
    return { value: `steps run=${runId}` }
  }

  const showRunEvents = async (runId: string, sourceCard?: string): Promise<CommandResult> => {
    const guard = workflows.workflowIdentityGuard()
    if (guard !== undefined) return guard
    if (store.session().verbose !== true) return "The events tab is the run's raw journal — a debug view. Turn on /debug.verbose first."
    return requestRunFacet(runId, "events", false, sourceCard)
  }

  const resumeRunFacetRequests = (): void => {
    const epoch = ctx.accountEpoch
    const owner = ctx.accountOwner()
    if (ctx.disposed || typeof owner !== "string") return
    const current = () => !ctx.disposed && ctx.accountEpoch === epoch && ctx.accountOwner() === owner
    const timer = setTimeout(() => {
      if (!current()) return
      void (store.settled?.() ?? Promise.resolve()).then(() => {
        if (!current() || workflows.workflowIdentityGuard() !== undefined) return
        for (const card of store.collections.cards.values()) {
          if (card.kind !== "run-trace") continue
          const request = card.payload.facetRequest
          if (request?.state === "pending" && request.owner === owner && sameRunScope(card.payload, request)) void readRunFacet(card.id, request)
        }
      }, () => {})
    }, 0)
    ctx.unref(timer)
  }

  /*
   * The trace's reader gestures (spec 06 §6). Both change the card payload
   * alone (§5: the trace, selection, cursor, filters and live-tail flag live
   * there), so the tree, the waterfall and the pane re-render from one record
   * and no request leaves the browser. The pump keeps the journal current on
   * its own cycle.
   */
  const traceFilter = async (runId: string, filter: TraceFilter, sourceCard?: string): Promise<CommandResult> => {
    const target = resolveRun(runId, sourceCard)
    if ("error" in target) return target.error
    const card = runCardFor(target, sourceCard)
    if (card === undefined) return `Open the run first (runs.open ${runId}): the trace lives on its card.`
    await store.dispatch({
      type: "card.updated",
      actor: ctx.commandActor,
      id: card.id,
      patch: { payload: { ...card.payload, filter } }
    }).isPersisted.promise
    return { value: `trace-filter run=${runId} filter=${filter}` }
  }

  const traceSelect = async (runId: string, nodeId: string, seq?: number, sourceCard?: string): Promise<CommandResult> => {
    const target = resolveRun(runId, sourceCard)
    if ("error" in target) return target.error
    const card = runCardFor(target, sourceCard)
    if (card === undefined) return `Open the run first (runs.open ${runId}): the trace lives on its card.`
    // The node must be one the journal in hand folds to; a made-up id selects nothing, so say so.
    const { workflow, phase, kind, events } = card.payload
    const latest = (events ?? []).reduce(
      (max, record) => typeof record.sequence === "number" ? Math.max(max, record.sequence) : max,
      0
    )
    const cursorSeq = seq ?? card.payload.cursorSeq ?? latest
    if (!Number.isSafeInteger(cursorSeq) || cursorSeq < 0 || cursorSeq > latest) {
      return `Run ${runId} has no recorded journal sequence ${cursorSeq}.`
    }
    const records = (events ?? []).filter((record) =>
      typeof record.sequence === "number" && record.sequence <= cursorSeq
    )
    const model = traceFromJournal({
      runId,
      flowId: workflow,
      status: cursorSeq < latest ? "running" : phase,
      ...(kind === undefined ? {} : { kind })
    }, records)
    if (!model.rows.some((span) => span.id === nodeId)) return `Run ${runId} has no trace node ${nodeId}.`
    // Persist the embedded inspection.
    await store.dispatch({
      type: "card.updated",
      actor: ctx.commandActor,
      id: card.id,
      patch: { payload: { ...card.payload, facet: "steps", selection: nodeId, liveTail: false, cursorSeq } }
    }).isPersisted.promise

    return { value: `trace-select run=${runId} node=${nodeId}${seq === undefined ? "" : ` seq=${seq}`}` }
  }

  const selectCodingChange = async (runId: string, changeId: string, sourceCard?: string): Promise<CommandResult> => {
    const target = resolveRun(runId, sourceCard)
    if ("error" in target) return target.error
    const card = runCardFor(target, sourceCard)
    if (card === undefined) return `Open the run first (runs.open ${runId}): its plan lives on the card.`
    if (!codingPlanOf(card)?.changes.some((change) => change.id === changeId)) return `Run ${runId} has no recorded planned Change ${changeId}.`
    const { codingChangeId: previous, ...payload } = card.payload
    const selected = previous === changeId ? {} : { codingChangeId: changeId }
    await store.dispatch({ type: "card.upsert", actor: ctx.commandActor, card: { ...card, payload: { ...payload, ...selected } } }).isPersisted.promise
    return { value: `coding-plan-selection run=${runId} change=${previous === changeId ? "none" : changeId}` }
  }

  const traceView = async (runId: string, view: TraceView, sourceCard?: string): Promise<CommandResult> => {
    const target = resolveRun(runId, sourceCard)
    if ("error" in target) return target.error
    const card = runCardFor(target, sourceCard)
    if (card === undefined) return `Open the run first (runs.open ${runId}): the trace lives on its card.`
    await store.dispatch({
      type: "card.updated",
      actor: ctx.commandActor,
      id: card.id,
      patch: { payload: { ...card.payload, traceView: view } }
    }).isPersisted.promise
    return { value: `trace-view run=${runId} view=${view}` }
  }

  const graphFollow = async (runId: string, follow: boolean, sourceCard?: string): Promise<CommandResult> => {
    const target = resolveRun(runId, sourceCard)
    if ("error" in target) return target.error
    const card = runCardFor(target, sourceCard)
    if (card === undefined) return `Open the run first (runs.open ${runId}): the graph lives on its card.`
    const { graph: _graph, ...payload } = card.payload
    // The camera and the open node are different reader gestures on one field,
    // so neither clears the other (controller/graph.ts).
    const { follow: _follow, ...held } = card.payload.graph ?? {}
    const graph = { ...held, follow }
    // Follow defaults on. Persist an explicit false so reload preserves the
    // reader's choice, independently of drawer selection.
    await store.dispatch({
      type: "card.upsert",
      actor: ctx.commandActor,
      card: { ...card, payload: { ...payload, graph } }
    }).isPersisted.promise
    return { value: `graph-follow run=${runId} follow=${follow ? "on" : "off"}` }
  }

  const traceLive = async (runId: string, sourceCard?: string): Promise<CommandResult> => {
    const target = resolveRun(runId, sourceCard)
    if ("error" in target) return target.error
    const card = runCardFor(target, sourceCard)
    if (card === undefined) return `Open the run first (runs.open ${runId}): the trace lives on its card.`
    const { selection: _selection, cursorSeq: _cursorSeq, ...payload } = card.payload
    // card.updated merges payload fields. Replace the card to remove the cursor
    // durably: undefined patch values would disappear in the JSON journal.
    await store.dispatch({
      type: "card.upsert",
      actor: ctx.commandActor,
      card: { ...card, payload: { ...payload, liveTail: true } }
    }).isPersisted.promise
    return { value: `trace-live run=${runId}` }
  }

  /** Stop every live run card's run — one workspace's, when named. Each cancel is durable; the cards settle from the pump. */
  /** The wire statuses the run inbox counts as live (mirrors RunsCards LIVE_STATUSES). */
  const RUN_LIST_LIVE_STATUSES: ReadonlySet<string> = new Set(["accepted", "running", "parked", "waiting-approval"])
  const stopAllRuns = async (repoArg?: string, sourceCard?: string): Promise<CommandResult> => {
    const guard = workflows.workflowIdentityGuard()
    if (guard !== undefined) return guard
    /*
     * The button reads "Stop all N" off the run inbox's rows, so the act
     * cancels THOSE rows — the wire's live runs under the inbox's active
     * filter — never just the runs this client happens to hold cards for.
     * With no inbox open, the client's live cards are the only known set.
     */
    const source = sourceCard === undefined ? undefined : store.collections.cards.get(sourceCard)
    if (sourceCard !== undefined && (source?.kind !== "run-list" || (repoArg !== undefined && source.payload.repo !== repoArg))) return "The run list is unavailable or belongs to another repository."
    const inboxes = [...store.collections.cards.values()].filter(
      (card) => card.kind === "run-list" && (sourceCard === undefined || card.id === sourceCard) && (repoArg === undefined || card.payload.repo === repoArg)
    ) as Array<Extract<Card, { kind: "run-list" }>>
    const live: Array<RunScope> = inboxes.length > 0
      ? inboxes.flatMap((card) =>
        card.payload.runs
          .filter((run) => RUN_LIST_LIVE_STATUSES.has(run.status))
          .map((run) => (runScopeFromCard(store, card, run.runId)!))
      )
      : ([...store.collections.cards.values()].filter(
        (card) =>
          card.kind === "run-trace" &&
          !pendingWorkflowLaunch(card) &&
          (card.payload.phase === "launching" ||
            card.payload.phase === "running" ||
            card.payload.phase === "waiting-approval" ||
            card.payload.phase === "reconnecting")
      ) as Array<Extract<Card, { kind: "run-trace" }>>)
        .filter((card) => repoArg === undefined || card.payload.repo === repoArg)
        .map((card) => ({ repo: card.payload.repo, runId: card.payload.runId, workspaceId: card.payload.workspaceId }))
    if (live.length === 0) return repoArg === undefined ? "No runs are live." : `No runs are live on ${repoArg}.`
    let stopped = 0
    let firstRefusal: string | undefined
    for (const card of live.filter((scope, index) => live.findIndex((other) => sameRunScope(other, scope)) === index)) {
      const binding = recordedRunBinding(card)
      const cancelled = "error" in binding ? { status: "error" as const, message: binding.error }
        : await gateway.cancel(card.repo, card.runId, "the human stopped every run", binding)
      if (cancelled.status === "ok") {
        stopped += 1
      } else if (firstRefusal === undefined) {
        firstRefusal = cancelled.message
      }
    }
    return {
      value: `stop-all stopped=${stopped} of ${live.length}${
        firstRefusal === undefined ? "" : ` — first refusal: ${firstRefusal}`
      }`
    }
  }

  /*
   * The workspace approvals inbox is a slow read: the workspace may need
   * provisioning, and a Projection.Snapshot against a sleeping workspace
   * waits through the gateway's resume loop (gateway.ts, up to three
   * minutes). The ask therefore persists its target and owner first, answers
   * "requested", and the read runs behind the shared toast — through
   * provision AND the read — publishing the card only from received rows.
   *
   * The in-flight map is shared by the user and agent doors (one operation
   * per target), and every entry names the request id and owner it serves,
   * so a superseded or account-crossed operation is never shared again.
   */
  const inboxCardIdFor = (repo: string, workspaceId: string | undefined): string =>
    `approvals-inbox-${repo}${workspaceId === undefined ? "" : `-${workspaceId}`}`
  const approvalReads = actorSharedState(ctx, "approvals-list", () => ({
    inFlight: new Map<string, { readonly id: string; readonly owner: string; readonly epoch: number; readonly work: Promise<unknown> }>(),
    persisting: new Map<string, Promise<unknown>>()
  }))
  const inboxRequestFor = (key: string): ApprovalsInboxRequest | undefined =>
    (store.session().approvalsInboxRequests ?? []).find((row) => inboxCardIdFor(row.repo, row.workspaceId) === key)

  const resultSaveFailure = "Approvals could not be saved. Try again."
  const publishInbox = async (repo: string, binding: { readonly workspaceId?: string }, rows: ReadonlyArray<ApprovalRow>): Promise<number> => {
    const pending = rows.filter((row) => row.status === "pending")
    const cardId = inboxCardIdFor(repo, binding.workspaceId)
    const existing = store.collections.cards.get(cardId)
    const prior = existing?.kind === "approvals-inbox" ? existing.payload.approvals : []
    const card: Card = {
      id: cardId,
      kind: "approvals-inbox",
      title: `Approvals — ${repo}`,
      status: "active",
      createdAt: existing?.createdAt ?? Date.now(),
      ordinal: existing?.ordinal ?? nextTranscriptOrdinal(),
      payload: {
        repo, ...binding, gatewayBindingVersion: 1,
        approvals: pending.map((row) => {
          // A row's recorded decision survives a refresh: the freeze is the
          // server's answer, not something a re-list may thaw.
          const before = prior.find((entry) => sameApproval(entry, row))
          return {
            runId: row.runId,
            requestId: row.requestId,
            title: row.title,
            approval: row.payload as Record<string, unknown>,
            requestedAt: row.requestedAt,
            ...(questionOf(row) === undefined ? {} : { question: questionOf(row)! }),
            ...(before?.decision === undefined ? {} : { decision: before.decision }),
            ...(before?.decidedAt === undefined ? {} : { decidedAt: before.decidedAt }),
            ...(before?.decisionError === undefined ? {} : { decisionError: before.decisionError })
          }
        })
      }
    }
    try {
      await store.dispatch({ type: "card.upsert", actor: "system", card }).isPersisted.promise
    } catch { throw new Error(resultSaveFailure) }
    return pending.length
  }

  /** The background read for one persisted request; shared while it runs. Never replays a mutation. */
  const readInbox = (request: ApprovalsInboxRequest): Promise<unknown> => {
    const key = inboxCardIdFor(request.repo, request.workspaceId)
    const epoch = ctx.accountEpoch
    const running = approvalReads.inFlight.get(key)
    if (running !== undefined && running.id === request.id && running.owner === request.owner && running.epoch === epoch) return running.work
    const binding = recordedRunBinding(request, "This list's box is gone.")
    // The fence at every boundary: the controller is open, the account is
    // the one that asked, and this request is still the one on record.
    const ownsAccount = (): boolean => !ctx.disposed && ctx.accountEpoch === epoch && ctx.accountOwner() === request.owner
    const current = (): boolean => ownsAccount() && inboxRequestFor(key)?.id === request.id
    const settle = async (error?: string): Promise<boolean> => {
      if (!current()) return false
      try {
        await store.dispatch({ type: "approvals.inbox.settled", actor: "system", id: request.id, ...(error === undefined ? {} : { error }) }).isPersisted.promise
      } catch { throw new Error(resultSaveFailure) }
      return ownsAccount() && (error === undefined ? inboxRequestFor(key) === undefined : inboxRequestFor(key)?.id === request.id)
    }
    const toastKey = `approvals.list.${key}`
    const title = `Loading ${request.repo} approvals…`
    const work = ctx.withToast(toastKey, title, "Approvals loaded", async () => {
      try {
        if (!current()) return TOAST_SUPERSEDED
        if ("error" in binding) return await settle(binding.error) ? binding.error : TOAST_SUPERSEDED
        const provisioned = await workflows.provisionWorkspace(request.repo, binding)
        if (!current()) return TOAST_SUPERSEDED
        if (provisioned !== true) return await settle(provisioned) ? provisioned : TOAST_SUPERSEDED
        const inbox = await gateway.approvalsInbox(request.repo, binding)
        if (!current()) return TOAST_SUPERSEDED
        if (inbox.status !== "ok") return await settle(inbox.message) ? inbox.message : TOAST_SUPERSEDED
        for (const runId of new Set(inbox.value.map((row) => row.runId))) {
          await reconcileRunApprovals(store, { repo: request.repo, runId, ...binding }, inbox.value.filter((row) => row.runId === runId))
          if (!current()) return TOAST_SUPERSEDED
        }
        const pending = await publishInbox(request.repo, binding, inbox.value)
        if (!await settle()) return TOAST_SUPERSEDED
        return { value: pending === 0 ? `No approvals are pending on ${request.repo}.` : `${pending} approval${pending === 1 ? "" : "s"} pending on ${request.repo}.` }
      } catch (error) {
        if (!current()) return TOAST_SUPERSEDED
        const message = error instanceof Error ? error.message : String(error)
        try {
          if (!await settle(message)) return TOAST_SUPERSEDED
        } catch {
          // A rejected write rolls back; the owed request is retained and no
          // success is reported even when its failure cannot be saved either.
          return current() ? resultSaveFailure : TOAST_SUPERSEDED
        }
        return message
      }
    })
    const entry = { id: request.id, owner: request.owner, epoch, work }
    approvalReads.inFlight.set(key, entry)
    void work.then((outcome) => {
      // A refusal quicker than the toast debounce never showed a notice; the
      // failure still has to be visible, so it takes the same failed toast.
      if (typeof outcome !== "string" || !current() || approvalReads.inFlight.get(key) !== entry || store.collections.toasts.get(`toast-${toastKey}`) !== undefined) return
      store.dispatch({ type: "toast.shown", actor: "system", key: toastKey, title })
      ctx.resolveToast(toastKey, { status: "failed", detail: outcome })
    }).finally(() => { if (approvalReads.inFlight.get(key) === entry) approvalReads.inFlight.delete(key) })
    return work
  }

  const listApprovals = async (repoArg?: string): Promise<CommandResult> => {
    const guard = workflows.workflowIdentityGuard()
    if (guard !== undefined) return guard
    // The target is fixed here, before any await: a later selection cannot retarget the read.
    const target = workflows.workflowTargetRepo(repoArg)
    if ("error" in target) return target.error
    const repo = target.repo
    const binding = gatewayBindingFor(store, repo)
    if ("error" in binding) return binding.error
    const owner = ctx.accountOwner()
    if (typeof owner !== "string") return "Sign in with GitHub first: flows run on your own workspace."
    const epoch = ctx.accountEpoch
    const ownsAccount = (): boolean => !ctx.disposed && ctx.accountEpoch === epoch && ctx.accountOwner() === owner
    const accountChanged = "The account changed before the approvals could be read. Run the command again."
    const key = inboxCardIdFor(repo, binding.workspaceId)
    const acknowledgment = { value: "Approvals requested." }
    // An ask that arrives while an earlier ask for this target is still
    // committing waits for that commit, then shares whatever it started.
    for (let saving = approvalReads.persisting.get(key); saving !== undefined; saving = approvalReads.persisting.get(key)) {
      try { await saving } catch { /* the ask that saved it reports the failure */ }
      if (!ownsAccount()) return accountChanged
    }
    const recorded = inboxRequestFor(key)
    const running = approvalReads.inFlight.get(key)
    // Duplicate input shares the operation already reading this target for this account.
    if (recorded !== undefined && recorded.error === undefined && recorded.owner === owner && running?.id === recorded.id && running.owner === owner && running.epoch === epoch) {
      return acknowledgment
    }
    const request = { id: crypto.randomUUID(), repo, workspaceId: binding.workspaceId, owner }
    const saving = store.dispatch({ type: "approvals.inbox.requested", actor: ctx.commandActor, request }).isPersisted.promise
    approvalReads.persisting.set(key, saving)
    try {
      await saving
    } catch {
      return "The approval request could not be saved, so nothing was read."
    } finally {
      if (approvalReads.persisting.get(key) === saving) approvalReads.persisting.delete(key)
    }
    const persisted = inboxRequestFor(key)
    if (!ownsAccount() || persisted?.id !== request.id) {
      return accountChanged
    }
    void readInbox(persisted)
    return acknowledgment
  }

  const resumeApprovalRequests = (): void => {
    if (ctx.disposed) return
    const epoch = ctx.accountEpoch
    const owner = ctx.accountOwner()
    if (typeof owner !== "string") return
    const current = (): boolean => !ctx.disposed && ctx.accountEpoch === epoch && ctx.accountOwner() === owner
    /*
     * The identity answer that wakes this is an optimistic row until its
     * write settles, and provisioning compares that row by identity: a read
     * started inside the change notification would be refused as an account
     * change the moment the row persists. The notification fires before the
     * write is even queued, so wait one task for the commit, then for it to
     * settle, before reading the account that is actually on record.
     */
    const timer = setTimeout(() => {
      if (!current()) return
      let settled: Promise<void>
      try { settled = store.settled?.() ?? Promise.resolve() } catch { return }
      void settled.then(() => {
        if (!current() || workflows.workflowIdentityGuard() !== undefined) return
        for (const request of store.session().approvalsInboxRequests ?? []) {
          // A recorded failure stays visible and manual; another account's request is not this account's to run.
          if (request.error !== undefined || request.owner !== owner) continue
          void readInbox(request)
        }
      }, () => {})
    }, 0)
    ctx.unref(timer)
  }

  /**
   * Bring one run's pending gates into the transcript as approval cards —
   * the same cards the pump would have upserted, so deciding them rides the
   * existing per-card path (`approval.approve` / `approval.deny`) unchanged.
   */
  const openApproval = async (runId: string, sourceCard?: string): Promise<CommandResult> => {
    const guard = workflows.workflowIdentityGuard()
    if (guard !== undefined) return guard
    const target = resolveRun(runId, sourceCard)
    if ("error" in target) return target.error
    const repo = target.repo
    const binding = { workspaceId: target.workspaceId }
    const provisioned = await workflows.provisionWorkspace(repo, binding)
    if (provisioned !== true) return provisioned
    const approvals = await gateway.approvals(repo, runId, binding)
    if (approvals.status !== "ok") return approvals.message
    await reconcileRunApprovals(store, target, approvals.value)
    const alreadyOpen = [...store.collections.cards.values()].filter(
      (card) =>
        store.approvalRequest(card.id) !== undefined && card.kind === "approval" && card.payload.runId === runId &&
        sameRunScope(runScopeFromCard(store, card, runId) ?? { repo: "", runId }, target) && card.payload.decision === undefined
    )
    if (alreadyOpen.length > 0) {
      return {
        value: `${alreadyOpen.length} approval card${
          alreadyOpen.length === 1 ? " is" : "s are"
        } already open for run ${runId}.`
      }
    }
    const pending = approvals.value.filter((row) => row.status === "pending")
    if (pending.length === 0) return `Run ${runId} has no approvals pending.`
    for (const approval of pending) {
      const card: Card = {
        id: approvalCardIdFor(store, target, approval.requestId),
        kind: "approval",
        title: approval.title,
        status: "active",
        createdAt: Date.now(),
        ordinal: nextTranscriptOrdinal(),
        payload: {
          capability: approval.title,
          runId,
          requestId: approval.requestId,
          approval: approval.payload as Record<string, unknown>,
          ...(questionOf(approval) === undefined ? {} : { question: questionOf(approval)! }),
          repo, ...binding, gatewayBindingVersion: 1
        }
      }
      store.dispatch({ type: "card.upsert", actor: "system", card })
    }
    return { value: `${pending.length} approval${pending.length === 1 ? "" : "s"} opened for run ${runId}.` }
  }

  return {
    prepareRunHandoff,
    listRuns,
    openRun,
    resumeRun,
    rerunRun,
    signalRun,
    steerRun,
    steerRunSeat,
    steerRunThinking,
    steerRunTools,
    showRunLogs,
    showRunSteps,
    showRunEvents,
    traceFilter,
    traceSelect,
    selectCodingChange,
    traceView,
    graphFollow,
    traceLive,
    stopAllRuns,
    listApprovals,
    resumeApprovalRequests,
    resumeRunFacetRequests,
    resumeRunListRequests,
    resumeRunOpenRequests,
    openApproval
  }
}
