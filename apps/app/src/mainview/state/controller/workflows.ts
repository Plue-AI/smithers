import { prepareTriggerRegistration, readTriggerRegistrations } from "../seams/TriggersSeam"
import type { TriggerRegistration } from "../WorkflowLaunch"
import { cloudFailure } from "../seams/CloudClient"
import { pinUserRefSource } from "../seams/UserRefSource"
import { outOfCreditRefusal, renderCreditExhausted, renderPlanLimit } from "../seams/BillingSeam"
import type { ViewAction } from "../PreparedView"
import { createWorkflowCatalogController } from "./workflow-catalog"
import { WORKFLOW_PROVISION_PATH } from "@smthrs/rpc/AgentApiRoutes"
import type { Card } from "../AppState"
import { sameApproval } from "../ApprovalReference"
import { reconcileRunApprovals } from "./approval-reconciliation"
import type { ControllerContext } from "./context"
import type { GatewayWorkspaceBinding } from "./gateway"
import { runCardIdFor, runScopeFromCard, sameRunScope } from "../RunReference"
import { flowAuthoringBinding, gatewayBindingFor, recordedRunBinding, repositoryJobBinding, resolveTargetRepo } from "../RepoContext"
import { refusalSentence } from "@smthrs/rpc/RefusalCopy"
import { FLOW_AUTHORING_ENTRY } from "@smthrs/rpc/FlowAuthoring"
import { dismissReadyWorkspaceFailures, TOAST_SUPERSEDED, ZERO_BALANCE_EXHAUSTED_TEXT } from "./failures"
import { Schema } from "effect"
import { declaredInput, formFieldsFor, draftFrom, missingFields } from "@smthrs/ui/flow-form"
import type { FormsController } from "./forms"
import { flowArgs } from "../../flows/FlowArgs"
import { projectRuntimeCard, runtimeApprovalIdOf, runtimeApprovalKey } from "../RuntimeProjection"
import { createWorkflowLaunchController } from "./workflow-launch"
import { canonical, digest } from "@smthrs/core/Digest"
import { planCardGraph, planCardNode, planCardSnapshot } from "../../cards/PlanNodes"
import type { FlowDurationsReader } from "./flowDurations"
import { foldRunGraph, runGraphOf } from "../../cards/FlowGraphStatus"
import { rekeySummary, type PreviewNode, type RekeySummary } from "../../cards/flowGraph/Rekey"
import { runtimeRunKey } from "../RuntimeProjection"
import { isTriggerNodeId } from "../../cards/FlowGraphTriggerNode"
import { canonicalStoredJsonValue } from "../EventValue"
import { actorSharedState } from "../ActorBindings"
import { authoredSources } from "../FlowAuthoringReceipts"
import { createFlowAuthoringController } from "./flowAuthoring"

/**
 * A launch the workspace refused, in the wire's own words and shape: the
 * message the seam surfaces, and the typed error's code (or tag) when the
 * gateway named one, so a caller can answer a known refusal by shape rather
 * than by matching prose (ControlError.FlowNotFound carries no message at all).
 */
export interface LaunchRefusal {
  readonly message: string
  readonly code?: string
  readonly retryAfterSeconds?: number
}

export interface WorkflowController {
  readonly resumeWorkflowRequests: () => void
  readonly requestTriggerRegistration: (repo: string, request: TriggerRegistration) => Promise<string | { value: string }>
  readonly requestTriggerRun: (repo: string, slug: string, operation?: "fire" | "resume") => Promise<string | { value: string }>
  readonly retryWorkflowRequest: (cardId: string) => boolean
  readonly createWorkflow: (description: string, repo?: string) => Promise<string | void | { readonly value: string }>
  readonly listWorkspaceWorkflows: ViewAction<[repo?: string, sourceCard?: string]>
  /** The Flows pane: the surface switch, and the same listing that fills it. */
  readonly showFlows: () => Promise<string | void | { readonly value: string }>
  readonly runWorkflow: (name: string, repo?: string, input?: Record<string, unknown>, sourceCard?: string) => Promise<string | void | { readonly value: string }>
  /** `change.request`: coding/request on the prompt, continuing into coding/vibe once it validates. */
  readonly requestChange: (prompt: string, repo?: string, from?: string) => Promise<string | void | { readonly value: string }>
  /** What a flow WOULD run: the plan card, filled in the background. */
  readonly planFlow: (name: string, repo?: string, input?: Record<string, unknown>, sourceCard?: string, against?: string) => Promise<string | void | { readonly value: string }>
  readonly chooseWorkflowRepo: (fullName: string) => Promise<string | void | { readonly value: string }>
  readonly forwardApprovalDecision: (
    card: Extract<Card, { kind: "approval" }>,
    decision: "approved" | "denied",
    answer?: unknown
  ) => Promise<void>
  /*
   * Lane runs shares the workflow lane's launch path: the run inbox's open,
   * resume, and rerun acts provision the same workspace, launch through the
   * same seam, and record the run on the same card, rather than growing a
   * second launch that could drift from the one `flow.run` proves.
   */
  readonly workflowIdentityGuard: () => string | undefined
  /** The refusal a $0 balance answers a launch with, already in the transcript; undefined when work may start. */
  readonly workflowBalanceGuard: () => string | undefined
  readonly workflowTargetRepo: (preferred?: string) => { readonly repo: string } | { readonly error: string }
  readonly provisionWorkspace: (repo: string, binding: GatewayWorkspaceBinding, signal?: AbortSignal) => Promise<true | string>
  readonly upsertRunCard: (args: {
    readonly cardId?: string
    readonly requireExisting?: boolean
    readonly runId: string
    readonly repo: string
    readonly workflow: string
    readonly title: string
    readonly firstStep: string
    readonly workspaceId: string
    readonly input?: Record<string, unknown>
    /** The run's kind (prototype, implement); absent for every other run. */
    readonly kind?: string
    /** Read the run once even when it already settled. */
    readonly observe?: boolean
  }) => Promise<string>
  readonly launchWorkflow: (args: {
    readonly repo: string
    readonly workflow: string
    readonly input: Record<string, unknown>
    readonly title: string
    readonly binding: GatewayWorkspaceBinding
    readonly kind?: string
  }) => Promise<{ readonly runId: string } | LaunchRefusal>
  readonly requestRerun: (args: {
    readonly repo: string
    readonly binding: GatewayWorkspaceBinding
    readonly runId: string
    readonly workflow: string
    readonly input: Record<string, unknown>
  }) => Promise<string | { readonly value: string }>
  /** A decision made on the workspace approvals inbox, for a gate whose own card never landed. */
  readonly forwardInboxApprovalDecision: (
    cardId: string,
    requestId: string,
    decision: "approved" | "denied",
    runId?: string,
    answer?: unknown
  ) => Promise<void>
}

export const createWorkflowController = (
  ctx: ControllerContext,
  nextTranscriptOrdinal: () => number,
  pumpWorkflowRun: (cardId: string, observeOnce?: boolean) => Promise<void>,
  renderFlowForm?: FormsController["renderFlowForm"],
  /* A plan card draws a graph, so the graph's predictions are read once, as
   * the card opens (controller/flowDurations.ts). */
  readFlowDurations?: FlowDurationsReader
): WorkflowController => {
  const { store, baseUrl, boundedFetch, gateway, unref, workflowPollMs, withToast } = ctx
  const RUN_POLL_MS = workflowPollMs
  const waitMs = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      const timer = setTimeout(resolve, ms)
      unref(timer)
    })

  const workflowIdentityGuard = (): string | undefined => {
    const identity = store.collections.identitySessions.get("identity")
    if (identity?.state !== "signed-in") {
      return "Sign in with GitHub first: flows run on your own workspace."
    }
    if (!identity.allowlisted) {
      return "Flows open up with the closed alpha: your account isn't allowlisted yet."
    }
    return undefined
  }

  /*
   * Launch Checklist D-4 / AppState.ts:290-296's ruling: chat is
   * complimentary and a $0 balance never pauses it, but a workflow run is
   * non-complimentary work — the one place the pause discipline applies.
   * `allowedToStartWork` only ever reads false after a definitive
   * "ok"/"low"/"empty" balance answer (refreshBalanceImpl), so a down or
   * unread billing seam never blocks a launch. `billing === undefined` is
   * kept as an explicit defensive branch — `seed()` (AppStore.ts) always
   * inserts `initialBillingAccount()` before the store resolves, so in
   * practice the row always exists by the time a command can run; this
   * guards the invariant rather than a state the store can actually
   * produce. The refusal is dispatched into the transcript directly (not
   * left to the generic toast channel) so it lands as an embedded chat
   * message per THE EMBED LAW regardless of whether a button, slash
   * command, or the agent triggered the launch; `surfaceCommandFailure`
   * recognizes `ZERO_BALANCE_EXHAUSTED_TEXT` and skips its toast for
   * pointer-driven triggers, so a button click doesn't double-surface the
   * same refusal as both a transcript message and a toast.
   */
  const zeroBalanceGuard = (): string | undefined => {
    const billing = store.collections.billingAccounts.get("billing")
    if (billing === undefined || billing.allowedToStartWork) return undefined
    void renderCreditExhausted(store, outOfCreditRefusal(ZERO_BALANCE_EXHAUSTED_TEXT),
      ctx.services.bootstrap?.capabilities.includes("billing.checkout") ?? true, "system")
    return ZERO_BALANCE_EXHAUSTED_TEXT
  }

  /**
   * The loaded repositories are the universe (lane piper): an explicit
   * `owner/repo` names the target; otherwise one loaded repository is the
   * target, none is the honest "load one first", and several (wave 12 §2) is
   * the genuine question of WHICH loaded repository. One loaded repository is
   * not a question; more than one, with no argument, is. Callers that reject
   * ambiguity use the two-way `workflowTargetRepo` below.
   */
  const NO_REPO_LOADED =
    "No repository is loaded yet — sign in with /cloud.sign-in, or name one as owner/repo"

  const workflowTargetRepoOrAsk = (
    preferred: string | undefined
  ): { readonly repo: string } | { readonly error: string } | { readonly ask: ReadonlyArray<string> } => {
    if (preferred !== undefined || store.session().activeRepoKey != null) return resolveTargetRepo(store, preferred)
    const loaded = [...store.collections.repositories.values()].map((repository) => repository.id)
    if (loaded.length === 0) return { error: NO_REPO_LOADED }
    if (loaded.length > 1) return { ask: loaded }
    return { repo: loaded[0] ?? "" }
  }

  /** The two-way form, for the calls that do not ask (list, run-by-name). */
  const workflowTargetRepo = (preferred?: string): { readonly repo: string } | { readonly error: string } =>
    resolveTargetRepo(store, preferred)

  /** The `owner/repo` shape the seam addresses — the same one the Worker refuses past. */
  const isWorkflowRepoArg = (value: string): boolean =>
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value) && !/(?:^|\/)\.{1,2}(?:\/|$)/.test(value)

  /**
   * `flow.create <description> [owner/repo]` — a trailing `owner/repo`
   * token is the target, everything before it is the description. Anything
   * that is not a repository name stays part of the description.
   */
  const splitDescriptionAndRepo = (
    input: string
  ): { readonly description: string; readonly repo?: string } => {
    const words = input.trim().split(/\s+/)
    const last = words.at(-1)
    if (words.length > 1 && last !== undefined && isWorkflowRepoArg(last)) {
      return { description: words.slice(0, -1).join(" "), repo: last }
    }
    return { description: input.trim() }
  }

  const provisionWorkspaceImpl = async (repo: string, binding: GatewayWorkspaceBinding, signal?: AbortSignal): Promise<true | LaunchRefusal> => {
    const identity = store.collections.identitySessions.get("identity")
    const owner = identity?.state === "signed-in" ? identity.login : null
    const epoch = ctx.accountEpoch
    // Preparation starts signed in and survives an identity outage; only an owner change stops it.
    const current = () => !ctx.disposed && owner !== null && ctx.accountEpoch === epoch && ctx.accountOwner() === owner
    // The backend answers 200 `{ status: "provisioning" }` while the box wakes
    // or its coding host starts (packages/backend/internal/compose/browser_flow.go):
    // poll that body to a bounded deadline, never stampede. Any non-2xx is a failure.
    const deadline = Date.now() + 180_000
    for (;;) {
      if (!current()) return { code: "request_superseded", message: "The account changed while the workspace was being prepared." }
      if (signal?.aborted) return { code: "request_aborted", message: "Workspace preparation was interrupted." }
      let body: { status?: unknown; message?: unknown } | undefined
      try {
        const response = await boundedFetch(`${baseUrl}${WORKFLOW_PROVISION_PATH}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ repo, workspaceId: binding.workspaceId }),
          signal
        })
        if (!response.ok) {
          const failure = await cloudFailure(response, "The workspace couldn't be prepared.")
          if (!current()) return { code: "request_superseded", message: "The account changed while the workspace was being prepared." }
          if (failure.refusal.rawCode === "plan_limit_exceeded") {
            return { code: "plan_limit_exceeded", message: await renderPlanLimit(store, failure.refusal, ctx.services.bootstrap?.capabilities.includes("billing.checkout") ?? true, ctx.commandActor) }
          }
          return { code: failure.code ?? "workspace_unavailable", message: refusalSentence(failure.refusal),
            ...(failure.retryAfterSeconds === null ? {} : { retryAfterSeconds: failure.retryAfterSeconds }) }
        }
        body = (await response.json().catch(() => undefined)) as typeof body
        if (!current()) return { code: "request_superseded", message: "The account changed while the workspace was being prepared." }
      } catch {
        return { code: "workspace_unreachable", message: "The workspace couldn't be prepared: the flow service didn't answer in time." }
      }
      if (body?.status === "ready") {
        dismissReadyWorkspaceFailures(ctx, repo, binding.workspaceId)
        return true
      }
      if (body?.status === "provisioning") {
        if (signal !== undefined) return { code: "workspace_starting", message: "Your workspace is starting." }
        if (Date.now() > deadline) {
          return { code: "workspace_starting", message: `The workspace for ${repo} is still being prepared. Try again in a moment.` }
        }
        await waitMs(RUN_POLL_MS)
        continue
      }
      if (typeof body?.message === "string") return { code: "workspace_unavailable", message: body.message }
      return { code: "invalid_workspace_response", message: "The workspace couldn't be prepared." }
    }
  }

  const provisionWorkspace = (repo: string, binding: GatewayWorkspaceBinding, signal?: AbortSignal): Promise<true | string> =>
    withToast(
      `flow.provision.${repo}.${binding.workspaceId}`,
      `Preparing your ${repo} box…`,
      "Box ready",
      async () => { const result = await provisionWorkspaceImpl(repo, binding, signal); return result === true ? true : result.message }
    )

  const requests = createWorkflowLaunchController(ctx, nextTranscriptOrdinal, pumpWorkflowRun, async (repo, binding, signal, request, current) => {
    if (request.triggerRegistration) {
      if (request.inputPrepared) return true
      return prepareTriggerRegistration({ baseUrl: ctx.baseUrl, http: (url, init) => ctx.boundedFetch(url, { ...init, signal }) },
        repo, request.triggerRegistration, binding.workspaceId, current)
    }
    /*
     * A change request starts from the caller's pushed ref: once the box is
     * ready, Cloud pins it as coding/request's base, once per request; a
     * reload keeps the pinned (or absent) base.
     */
    if (request.source !== undefined && request.workflow === "coding/request") {
      const provisioned = await provisionWorkspaceImpl(repo, binding, signal)
      if (provisioned !== true || request.inputPrepared) return provisioned
      const pinned = await pinUserRefSource({ http: (url, init) => ctx.boundedFetch(url, { ...init, signal }), baseUrl: ctx.baseUrl },
        repo, binding.workspaceId, request.source, signal)
      if (!current()) return { code: "request_superseded", message: "This request belongs to a previous session." }
      if ("code" in pinned) return pinned
      return { input: pinned.base === null ? request.input : { ...request.input, base: pinned.base },
        source: { ...request.source, commitId: pinned.base?.commitId ?? null } }
    }
    if (!request.triggerDispatch) return provisionWorkspaceImpl(repo, binding, signal)
    if (request.inputPrepared) return true
    const registered = await readTriggerRegistrations({ http: ctx.http, baseUrl: ctx.baseUrl }, repo)
    if (!registered.live) return { code: "trigger_lookup_unavailable", message: "The schedules could not be read. Retry the request." }
    const row = registered.triggers.find(trigger => trigger.slug === request.triggerDispatch!.slug)
    if (!row) return { code: "trigger_not_found", message: `No schedule "${request.triggerDispatch.slug}" is registered on ${repo}.` }
    if (request.input.operation === "fire" && !row.enabled) return { code: "trigger_paused", message: `Resume "${row.slug}" before running it.` }
    if (request.input.operation === "resume" && row.enabled) return { code: "trigger_already_enabled", message: `Schedule "${row.slug}" is already enabled.` }
    return { input: { ...request.input, flow: row.flowId, schedule: row.cron } }
  }, request => {
    // Refresh the listing independently; the committed run settles its own toast.
    if (request.triggerRegistration) {
      void ctx.withToast(`trigger.refresh.${request.repo}`, `Dispatcher · ${request.repo}`, `Dispatcher · ${request.repo}`, async () => {
        const result = await ctx.commands.run("triggers.list", request.repo, "automatic")
        return result.status === "failed" ? result.error : undefined
      }, true)
    } else if (request.triggerDispatch) void ctx.commands.run("triggers.list", request.repo, "automatic")
      .catch(error => ctx.failures.report("command.boundary", error, request.id))
  })
  const requestTriggerRegistration: WorkflowController["requestTriggerRegistration"] = async (repo, request) => {
    const binding = repositoryJobBinding(store, repo)
    if ("error" in binding) return binding.error
    const outcome = await requests.start({ repo, binding, workflow: "repository/trigger", input: {},
      triggerRegistration: request, actor: ctx.commandActor })
    return typeof outcome === "string" ? outcome : { value: `Registration requested for ${request.slug} on ${repo}.` }
  }

  const requestTriggerRun: WorkflowController["requestTriggerRun"] = async (repo, slug, operation = "fire") => {
    const binding = repositoryJobBinding(store, repo)
    if ("error" in binding) return binding.error
    const outcome = await requests.start({ repo, binding, workflow: "repository/trigger",
      input: { ...(operation === "fire" ? { requestId: crypto.randomUUID() } : {}), operation, repo, slug, input: {} }, triggerDispatch: { slug }, actor: ctx.commandActor })
    return typeof outcome === "string" ? outcome : { value: `Requested ${slug} on ${repo}.` }
  }

  const authoring = actorSharedState(ctx, "flow-authoring", () => createFlowAuthoringController(ctx, nextTranscriptOrdinal, provisionWorkspace, pumpWorkflowRun))
  ctx.observeFlowAuthoring = authoring.observe
  ctx.resumeFlowAuthoring = authoring.resume

  const upsertRunCard = async (args: {
    readonly cardId?: string
    readonly requireExisting?: boolean
    readonly runId: string
    readonly repo: string
    readonly workflow: string
    readonly title: string
    readonly firstStep: string
    readonly workspaceId: string
    readonly input?: Record<string, unknown>
    readonly kind?: string
    /** The plan the launch was approved on; absent for a run this client did not start. */
    readonly plan?: NonNullable<Extract<Card, { kind: "run-trace" }>["payload"]["plan"]>
    /** Read the run once even when it already settled (an opened run's recorded journal). */
    readonly observe?: boolean
  }): Promise<string> => {
    const epoch = ctx.accountEpoch
    const cardId = args.cardId ?? runCardIdFor(store, args)
    const existing = store.collections.cards.get(cardId)
    if (args.cardId !== undefined && (args.requireExisting || existing !== undefined) && (existing?.kind !== "run-trace" || !sameRunScope(existing.payload, args))) throw new Error("The source run changed. Open it again.")
    const held = existing?.kind === "run-trace" ? existing.payload : undefined
    const card: Card = {
      id: cardId,
      kind: "run-trace",
      title: args.title,
      status: "active",
      createdAt: existing?.createdAt ?? Date.now(),
      ordinal: existing?.ordinal ?? nextTranscriptOrdinal(),
      payload: {
        ...held,
        repo: args.repo,
        gatewayBindingVersion: 1,
        workspaceId: args.workspaceId,
        runId: args.runId,
        workflow: args.workflow,
        /* A monitor reopened after it settled keeps its recorded terminal status and failure. */
        phase: held?.phase ?? "running",
        steps: held?.steps ?? [args.firstStep],
        result: held?.result ?? null,
        lastSeq: held?.lastSeq ?? 0,
        ...(held?.error === undefined ? {} : { error: held.error }),
        ...(args.input === undefined ? held?.input === undefined ? {} : { input: held.input } : { input: args.input }),
        ...(args.kind === undefined ? {} : { kind: args.kind }),
        /* The launch's own plan snapshot; a re-open keeps the one already held. */
        ...(args.plan === undefined ? held?.plan === undefined ? {} : { plan: held.plan } : { plan: args.plan }),
        // All saved reader choices, including transcript snapshots and pending facets, survive reopening.
        ...(held === undefined ? { liveTail: true } : {})
      }
    }
    await store.dispatch({ type: "card.upsert", actor: ctx.commandActor, card }).isPersisted.promise
    const saved = store.collections.cards.get(cardId)
    if (!ctx.disposed && ctx.accountEpoch === epoch && saved?.kind === "run-trace" && sameRunScope(saved.payload, args)) void pumpWorkflowRun(cardId, args.observe === true)
    return cardId
  }

  /*
   * One card per (repo, flow, input), so a repeated ask moves the card it
   * already has.
   *
   * The input goes in as a digest of its RFC 8785 canonical bytes, not as its
   * JSON: the id reaches the DOM as an attribute and the toast as
   * `toast-flow.plan:<id>`, and `JSON.stringify` is key-order sensitive, so
   * the same input typed twice in another order would grow a second card.
   */
  const planCardId = (repo: string, name: string, input: Record<string, unknown>, against: string | undefined, workspaceId: string): string =>
    `flow-plan-${repo}-${name}-${Object.keys(input).length === 0 ? "" : digest(canonical(input)).slice(0, 16)}${
      against === undefined ? "" : `-vs-${against}`}-workspace-${digest(workspaceId).slice(0, 16)}`

  /*
   * Plan dedup state, shared by the user and agent bindings.
   *
   * `actors.pair` builds this controller a second time, lazily, on the
   * agent's first call. Both copies must see one set of in-flight asks, or a
   * plan asked by each goes out twice and either copy's late answer can
   * overwrite the other's newer one. The restart sweep runs inside the same
   * initializer, so it runs once, at boot, and never against a plan the user
   * copy has in flight.
   */
  const { planning, planAttempts, planSaving } = actorSharedState(ctx, "flow-plan", () => {
    // Legacy cards have no admitted request to reconnect. Keep their explicit retry.
    for (const card of store.collections.cards.values()) {
      if (card.kind !== "flow-plan" || card.payload.status !== "pending") continue
      if (card.payload.planRequest !== undefined || card.payload.sourceReceipt !== undefined) continue
      store.dispatch({
        type: "card.upsert",
        actor: "system",
        card: {
          ...card,
          status: "acted",
          payload: { ...card.payload, status: "failed", error: "The app restarted before this plan came back." }
        }
      })
    }
    return {
      /** The account generation of each in-flight plan, by card id. */
      planning: new Map<string, number>(),
      /** The newest ask per card, so an older answer that lands late writes nothing. */
      planAttempts: new Map<string, number>(),
      planSaving: new Map<string, Promise<unknown>>()
    }
  })

  /**
   * Fill one plan card from the workspace, in the background.
   *
   * A refusal stays on the card with the plan door beside it: the toast that
   * carried the progress is gone four seconds later, and a person who asked
   * for a graph and got nothing has to be able to see why and ask again.
   */
  /**
   * The re-key preview: a fresh plan against the plan a run was approved on.
   *
   * Every number comes off evidence this session already holds — that run's
   * plan snapshot, its journal, and the flow's measured history — so the
   * preview costs one `Plan` call and nothing else. It answers nothing when
   * the run it names is not one this client launched: without the plan that
   * run was approved on there is no previous key to compare against, and a
   * comparison with a plan taken now would say every node is unchanged.
   */
  const previewRekey = (
    repo: string,
    flowId: string,
    binding: GatewayWorkspaceBinding,
    against: string,
    nextNodes: ReadonlyArray<PreviewNode>
  ): RekeySummary | undefined => {
    const card = [...store.collections.cards.values()].find((candidate) =>
      candidate.kind === "run-trace" && candidate.payload.runId === against && candidate.payload.repo === repo &&
      candidate.payload.workspaceId === binding.workspaceId && candidate.payload.workflow === flowId)
    if (card?.kind !== "run-trace" || card.payload.plan === undefined) return undefined
    const events = store.committedRuntimeRun(runtimeRunKey({
      repo,
      runId: against,
      workspaceId: binding.workspaceId
    }))?.events ?? []
    const previousNodes = card.payload.plan.nodes
    const durations = [...store.collections.flowDurations.values()]
      .filter((row) => row.repo === repo && row.flowId === flowId && row.workspaceId === binding.workspaceId)
    return rekeySummary({
      flowId,
      previousNodes,
      nextNodes,
      events,
      status: runGraphOf(foldRunGraph(events), { planNodeIds: previousNodes.map((node) => node.id), flow: card.payload.workflow })?.status
        ?? new Map(),
      durations
    })
  }

  const fillPlanCard = async (args: {
    readonly id: string
    readonly repo: string
    readonly binding: GatewayWorkspaceBinding
    readonly name: string
    readonly input: Record<string, unknown>
    readonly attempt: number
    readonly epoch: number
    readonly request: NonNullable<Extract<Card, { kind: "flow-plan" }>["payload"]["planRequest"]>
    /** The run this plan was asked to be compared against (the re-key preview). */
    readonly against?: string
    readonly previousPlan?: Extract<Card, { kind: "flow-plan" }>["payload"]["previousPlan"]
    readonly sourceReceipt?: Extract<Card, { kind: "flow-plan" }>["payload"]["sourceReceipt"]
  }): Promise<void> => {
    const current = () => !ctx.disposed && ctx.accountEpoch === args.epoch && ctx.accountOwner() === args.request.owner && planAttempts.get(args.id) === args.attempt
    let writing = false
    const settle = async (patch: Extract<Card, { kind: "flow-plan" }>["payload"]): Promise<string | void> => {
      // An answer to an older ask, or to a controller that has since closed,
      // writes nothing: the card belongs to whatever was asked last.
      if (!current()) return
      const card = store.collections.cards.get(args.id)
      if (card?.kind !== "flow-plan") return
      /*
       * The reader's open drawer is theirs, not the answer's, so a re-plan
       * keeps it while the graph still draws that node: a drawer pointed at a
       * node this plan no longer has would be open over nothing
       * (controller/graph.ts). A schedule is drawn beside the plan and is
       * never in `nodes`, so a re-plan cannot take it away.
       */
      const held = card.payload.view
      const drawn = (node: string): boolean =>
        isTriggerNodeId(node) || (patch.nodes ?? []).some((candidate) => candidate.id === node)
      const kept = held?.node !== undefined && drawn(held.node) ? held : undefined
      writing = true
      await store.dispatch({
        type: "card.upsert",
        actor: ctx.commandActor,
        card: {
          ...card,
          status: patch.status === "failed" ? "error" : "active",
          payload: kept === undefined ? patch : { ...patch, view: kept }
        }
      }).isPersisted.promise
      writing = false
      return patch.status === "failed" ? patch.error : undefined
    }
    try {
      const outcome = await withToast(`flow.plan:${args.id}`, `Planning ${args.name}`, `Planned ${args.name}`, async () => {
        try {
          if (!current()) return TOAST_SUPERSEDED
          const provisioned = await provisionWorkspaceImpl(args.repo, args.binding)
          if (!current()) return TOAST_SUPERSEDED
          if (provisioned !== true) return (await settle(refusedPlan(args, provisioned.message))) ?? provisioned.message
          const planned = await gateway.plan(args.repo, args.name, args.input, args.binding, `plan:${args.request.id}`)
          if (!current()) return TOAST_SUPERSEDED
          if (planned.status !== "ok") return (await settle(refusedPlan(args, planned.message))) ?? planned.message
          const nodes = planned.value.nodes.map(planCardNode)
          /*
           * A comparison reads the flow's measured history BEFORE it is
           * computed. The estimate is a number off that history, and a read
           * fired beside the preview would answer after the card had already
           * frozen, so the first ask of a session would ship counts with no
           * estimate while the gateway held every row. The reader swallows
           * every refusal (controller/flowDurations.ts), so a box that will not
           * serve the projection costs the preview its estimate and nothing
           * else.
           */
          if (args.against !== undefined) await readFlowDurations?.(args.repo, args.name, args.binding)
          if (!current()) return TOAST_SUPERSEDED
          /* The comparison is over evidence already on the card and in the
           * collections, so it happens here, with the fresh plan in hand. */
          const rekey = args.against === undefined ? undefined : previewRekey(args.repo, args.name, args.binding, args.against, nodes)
          await settle({
            repo: args.repo,
            flowId: args.name,
            status: "done",
            workspaceId: args.binding.workspaceId,
            ...(Object.keys(args.input).length === 0 ? {} : { input: args.input }),
            planId: planned.value.planId,
            digest: planned.value.digest,
            nodes,
            /*
             * The labelled edges, where each node was declared, and the
             * revision those sites were read at — the same reduction the
             * launch path writes onto a run (cards/PlanNodes.ts), so a plan
             * card and a run's plan snapshot carry one shape.
             */
            ...(planned.value.graph === undefined ? {} : { graph: planCardGraph(planned.value.graph) }),
            ...(args.against === undefined ? {} : { against: args.against }),
            ...(args.previousPlan === undefined ? {} : { previousPlan: args.previousPlan }),
            ...(args.sourceReceipt === undefined ? {} : { sourceReceipt: args.sourceReceipt }),
            ...(rekey === undefined ? {} : { rekey })
          })
          if (!current()) return TOAST_SUPERSEDED
          // The graph is drawn, so its predictions are worth reading: one
          // call, off the toast's path, whose refusal shows as no numbers. A
          // comparison has already read them, above.
          if (args.against === undefined) void readFlowDurations?.(args.repo, args.name, args.binding)
          // Not a string: `withToast` reads a string outcome as the honest
          // failure line, so a drawn graph that answered with one would resolve
          // its own toast as a failure. The card is the claim surface anyway.
          return true
        } catch {
          if (!current()) return TOAST_SUPERSEDED
          const message = writing ? "The plan could not be saved. Try Plan again." : "The workspace did not answer. Try Plan again."
          try { await settle(refusedPlan(args, message)) } catch { /* The shared toast reports a refused write even when the card cannot. */ }
          return current() ? message : TOAST_SUPERSEDED
        }
      }, false, current)
      // A fast persistence failure still needs a visible, retryable explanation.
      if (typeof outcome === "string" && current() && !store.collections.toasts.has(`toast-flow.plan:${args.id}`)) {
        store.dispatch({ type: "toast.shown", actor: "system", key: `flow.plan:${args.id}`, title: `Planning ${args.name}` })
        ctx.resolveToast(`flow.plan:${args.id}`, { status: "failed", detail: outcome })
      }
    } finally {
      if (planAttempts.get(args.id) === args.attempt) planning.delete(args.id)
    }
  }

  const startPlan = (card: Extract<Card, { kind: "flow-plan" }>) => {
    const request = card.payload.planRequest
    const epoch = ctx.accountEpoch
    if (!request || ctx.disposed || ctx.accountOwner() !== request.owner || planning.get(card.id) === epoch) return
    const attempt = (planAttempts.get(card.id) ?? 0) + 1
    planAttempts.set(card.id, attempt)
    planning.set(card.id, epoch)
    const { repo, workspaceId, flowId: name, input = {}, against, previousPlan, sourceReceipt } = card.payload
    if (workspaceId === undefined) {
      // A plan asked before every plan named its box has none to reach.
      planning.delete(card.id)
      store.dispatch({ type: "card.upsert", actor: "system", card: { ...card, status: "error",
        payload: { ...card.payload, status: "failed", error: "This plan's box is gone." } } })
      return
    }
    void fillPlanCard({ id: card.id, repo, binding: { workspaceId }, name, input, attempt, epoch, request, against, previousPlan, sourceReceipt })
  }
  const resumePlans = () => {
    if (workflowIdentityGuard() !== undefined) return
    const epoch = ctx.accountEpoch
    const owner = ctx.accountOwner()
    const timer = setTimeout(() => {
      void (store.settled?.() ?? Promise.resolve()).then(() => {
        if (ctx.disposed || ctx.accountEpoch !== epoch || ctx.accountOwner() !== owner) return
        for (const card of store.collections.cards.values()) {
          if (card.kind === "flow-plan" && card.payload.status === "pending" && card.payload.planRequest?.owner === owner && !planSaving.has(card.id)) startPlan(card)
        }
      }, () => {})
    }, 0)
    unref(timer)
  }

  /** The plan card's payload for a refusal, keeping whatever graph it already drew. */
  const refusedPlan = (
    args: { readonly id: string; readonly repo: string; readonly binding: GatewayWorkspaceBinding; readonly name: string; readonly input: Record<string, unknown>; readonly request?: NonNullable<Extract<Card, { kind: "flow-plan" }>["payload"]["planRequest"]> },
    message: string
  ): Extract<Card, { kind: "flow-plan" }>["payload"] => {
    const card = store.collections.cards.get(args.id)
    const held = card?.kind === "flow-plan" ? card.payload : undefined
    return {
      ...(held ?? { repo: args.repo, flowId: args.name }),
      repo: args.repo,
      flowId: args.name,
      status: "failed",
      ...(args.request === undefined ? {} : { planRequest: args.request }),
      error: message,
      workspaceId: args.binding.workspaceId,
      ...(Object.keys(args.input).length === 0 ? {} : { input: args.input })
    }
  }

  const launchWorkflow = async (args: {
    readonly repo: string
    readonly workflow: string
    readonly input: Record<string, unknown>
    readonly title: string
    readonly binding: GatewayWorkspaceBinding
    readonly kind?: string
  }): Promise<{ readonly runId: string } | LaunchRefusal> => {
    const launch = await gateway.launch(args.repo, args.workflow, args.input, args.binding)
    if (launch.status !== "ok") return { message: launch.message, ...(launch.code === undefined ? {} : { code: launch.code }) }
    const { runId } = launch.value
    /*
     * The plan snapshot the graph view draws before the first event arrives.
     * It is written only where the flow builder is on (D-038: the engine
     * records the nodes whatever the app flag says, and a launch with the
     * flag off must persist exactly what it persisted before the lane), and
     * only when the workspace named the plan AND answered with nodes: a plan
     * with no nodes is a workspace that serves no graph, and an empty node
     * list on the card would read as a flow that does nothing.
     *
     * The labelled edges and declaration sites ride with it when that same
     * answer carried them. Dropping them here left the card with `dependsOn`
     * alone, which says WHICH nodes wait and never WHY, and the reader of a
     * just-launched run got an unlabelled graph the plan door had already
     * been told the reasons for.
     */
    const planned = planCardSnapshot(launch.value)
    await upsertRunCard({
      runId,
      repo: args.repo,
      workflow: args.workflow,
      title: args.title,
      firstStep: `Started ${args.workflow} on ${args.repo} (run ${runId}).`,
      workspaceId: launch.value.workspaceId,
      input: args.input,
      ...(args.kind === undefined ? {} : { kind: args.kind }),
      ...(planned === undefined ? {} : { plan: planned })
    })
    return { runId }
  }

  /*
   * Wave 12 §2 — the which-repo question, embedded. It renders only when the
   * answer is genuinely the user's (more than one loaded repository, no
   * argument); one act answers it, and the create resumes with the repo they
   * named.
   */
  const WORKFLOW_REPO_CARD_ID = "workflow-repo"

  const askWhichRepo = (
    description: string,
    repos: ReadonlyArray<string>
  ): { readonly value: string } => {
    const existing = store.collections.cards.get(WORKFLOW_REPO_CARD_ID)
    store.dispatch({
      type: "card.upsert",
      actor: ctx.commandActor,
      card: {
        id: WORKFLOW_REPO_CARD_ID,
        kind: "workflow-repo",
        title: "Which repository?",
        status: "active",
        createdAt: existing?.createdAt ?? Date.now(),
        ordinal: nextTranscriptOrdinal(),
        payload: { intent: "create", description, repos: [...repos], chosen: null }
      }
    })
    /*
     * A QUESTION is not a failure. A bare string result marks the outcome
     * `failed`, and live on canary the transcript read "Smithers tried
     * /flow.create — failed: You have 3 repositories loaded…" beside the card
     * that had just asked them, correctly, which one. The command did exactly
     * what it should; the value carries the question to the model, and the
     * card carries it to the human (§2b — values never render raw).
     */
    return { value: `You have ${repos.length} repositories loaded. Choose the one this flow belongs to.` }
  }

  const chooseWorkflowRepo = async (fullName: string): Promise<string | void | { readonly value: string }> => {
    const card = store.collections.cards.get(WORKFLOW_REPO_CARD_ID)
    if (card === undefined || card.kind !== "workflow-repo") {
      return "There's no repository question open right now."
    }
    if (card.payload.chosen !== null) {
      // A question is answered once. Two clicks landing before the card's
      // state came back would otherwise launch the same workflow twice, on
      // a seam where a launch is real work on the user's workspace.
      return `That question is already answered — I'm creating it on ${card.payload.chosen}.`
    }
    if (!card.payload.repos.includes(fullName)) {
      return `${fullName} isn't one of the repositories in that question.`
    }
    store.dispatch({
      type: "card.updated",
      actor: "user",
      id: WORKFLOW_REPO_CARD_ID,
      patch: { payload: { ...card.payload, chosen: fullName }, status: "acted" }
    })
    return createWorkflow(card.payload.description, fullName)
  }

  /*
   * A refused authoring attempt, said where it stays.
   *
   * The string a flow returns reaches the person as the command-failure
   * toast, which states itself and dismisses after four seconds. On
   * production that made this door look inert: it provisioned, the workspace
   * refused its plan, and by the time anyone looked there was no line, no
   * toast and no card — a door that created nothing and said nothing. The
   * refusing party's own sentence goes to the transcript, which is the half
   * of the answer that is still there afterwards.
   */
  const refuseCreate = (message: string): string => {
    store.dispatch({ type: "message.appended", actor: "system", text: message })
    return message
  }

  const createWorkflow = async (
    rawDescription: string,
    repoArg?: string
  ): Promise<string | void | { readonly value: string }> => {
    const guard = workflowIdentityGuard()
    if (guard !== undefined) return refuseCreate(guard)
    /* The zero-balance refusal is already an embedded message; a second one would say it twice. */
    const balanceGuard = zeroBalanceGuard()
    if (balanceGuard !== undefined) return balanceGuard
    // §2: `flow.create <description> [owner/repo]` — one argument string
    // for both the slash form and the agent tool.
    const split = repoArg === undefined
      ? splitDescriptionAndRepo(rawDescription)
      : { description: rawDescription.trim(), repo: repoArg }
    const description = split.description
    if (description === "") return refuseCreate("flow.create needs a description of what the flow should do")
    const target = workflowTargetRepoOrAsk(split.repo)
    if ("error" in target) return refuseCreate(target.error)
    if ("ask" in target) return askWhichRepo(description, target.ask)
    const repo = target.repo
    const binding = flowAuthoringBinding(store, repo)
    if ("error" in binding) return refuseCreate(binding.error)
    return authoring.request(description, repo, binding, ctx.commandActor)
  }

  /** A source card binds both catalog reads and launches to the retained host. */
  const workflowScope = (repoArg?: string, sourceCard?: string):
    { readonly repo: string; readonly binding: GatewayWorkspaceBinding } | { readonly error: string } => {
    if (sourceCard !== undefined) {
      const card = store.collections.cards.get(sourceCard)
      if (card?.kind !== "run-trace" && card?.kind !== "workflow-list" && card?.kind !== "flow-plan") return { error: "The source run or catalog card is unavailable." }
      if (repoArg !== undefined && repoArg !== card.payload.repo) return { error: "The source card belongs to another repository." }
      const binding = recordedRunBinding(card.payload, card.kind === "run-trace" ? undefined : "This card's box is gone.")
      return "error" in binding ? binding : { repo: card.payload.repo, binding }
    }
    const target = workflowTargetRepo(repoArg)
    if ("error" in target) return target
    const binding = gatewayBindingFor(store, target.repo)
    return "error" in binding ? binding : { repo: target.repo, binding }
  }

  const catalogs = createWorkflowCatalogController(ctx, {
    resolve: (repo, sourceCard) => {
      const guard = workflowIdentityGuard()
      if (guard !== undefined) return guard
      const scope = workflowScope(repo, sourceCard)
      return "error" in scope ? scope.error : scope
    },
    provision: provisionWorkspaceImpl
  })
  const listWorkspaceWorkflows = catalogs.list

  /*
   * Ask 5 (will, 2026-09-02): "where it says connect chat and world an option
   * should also be flows which should allow us to look at flows". The pane is
   * the flow.list card's rows, so opening it IS running that list — one seam,
   * one honest refusal when a repository is not loaded or the session is not
   * signed in, and the same toggle-back the World and Connect surfaces have.
   *
   * User-only on purpose: the model already has flow.list, whose answer is an
   * embedded card. THE EMBED LAW makes the pane the human's act alone.
   */
  const showFlows = async (): Promise<string | void | { readonly value: string }> => {
    if (store.session().surface === "flows") {
      store.dispatch({ type: "surface.changed", actor: "user", surface: "chat" })
      return
    }
    store.dispatch({ type: "surface.changed", actor: "user", surface: "flows" })
    return listWorkspaceWorkflows()
  }

  const requestRerun: WorkflowController["requestRerun"] = async ({ runId, ...args }) => {
    const guard = workflowIdentityGuard()
    if (guard !== undefined) return guard
    return requests.start({ ...args, rerunOf: runId, actor: ctx.commandActor })
  }

  const runWorkflow = async (name: string, repoArg?: string, inputArg?: Record<string, unknown>, sourceCard?: string): Promise<string | void | { readonly value: string }> => {
    const input = inputArg ?? {}
    const guard = workflowIdentityGuard()
    if (guard !== undefined) return guard
    const target = workflowScope(repoArg, sourceCard)
    if ("error" in target) return target.error
    const { repo, binding } = target
    // A box executes with its own configured provider. Its gateway enforces
    // box access, capacity and provider setup.
    const source = sourceCard === undefined ? undefined : store.collections.cards.get(sourceCard)
    const declaration = source?.kind === "workflow-list"
      ? source.payload.workflows.find(flow => flow.key === name)?.inputSchema
      : sourceCard === undefined ? store.collections.repositoryFlows.get(repo)?.flows.find(flow => flow.id === name)?.inputSchema : undefined
    const schema = declaredInput(declaration)
    const fields = schema === undefined ? [] : formFieldsFor(schema, undefined)
    if (schema !== undefined && ((inputArg === undefined && fields.length > 0) || !Schema.is(schema)(input))) {
      if (fields.length > 0 && renderFlowForm !== undefined) {
        const rendered = renderFlowForm({ name: "flow.run", input: schema, payloadField: "input",
          args: flowArgs("flow.run", { name, repo, input, sourceCard }),
          via: ctx.commandActor === "smithers" ? "agent" : "user",
          cardId: `form-flow-run-${sourceCard ?? repo}-${name}`, title: `${name} — ${repo}`,
          hints: { submitLabel: "Run flow" } })
        if (rendered !== undefined) return { value: `Prepared ${name}'s input form${missingFields(fields, draftFrom(fields, input)).length > 0 ? "; fill in the missing fields" : "; correct the inputs before running"}.` }
      }
      return `The inputs do not match ${name}'s declared schema.`
    }
    return requests.start({ repo, binding, workflow: name, input, actor: ctx.commandActor })
  }

  /*
   * A change typed in chat is a coding/request whose validated result lands
   * through coding/vibe. The request is durable before this returns; the
   * workspace's preparation, the run and the hand-over to vibe continue in
   * the background under the shared toast, and each stage has its own card.
   */
  const requestChange = async (prompt: string, repoArg?: string, from?: string): Promise<string | void | { readonly value: string }> => {
    const what = prompt.trim()
    if (what === "") return "change.request needs what to change"
    if (what.length > 32_768) return "The change request exceeds the coding request limit of 32,768 characters."
    const guard = workflowIdentityGuard()
    if (guard !== undefined) return guard
    const target = workflowScope(repoArg)
    if ("error" in target) return target.error
    const { repo, binding } = target
    return requests.start({ repo, binding, workflow: "coding/request", input: { prompt: what }, actor: ctx.commandActor, then: "coding/vibe",
      source: { name: from ?? "head", explicit: from !== undefined } })
  }

  /**
   * Plan a flow: what it WOULD run, before anything runs.
   *
   * The command returns as soon as the card exists. Planning crosses the
   * relay to a workspace that may still be provisioning, and a chat that sat
   * behind it would be a chat that stops answering because somebody asked to
   * see a graph. The card is the claim surface; the toast carries the
   * progress; the answer fills the card when it lands.
   */
  const planFlow = async (name: string, repoArg?: string, inputArg?: Record<string, unknown>, sourceCard?: string, against?: string): Promise<string | void | { readonly value: string }> => {
    const guard = workflowIdentityGuard()
    if (guard !== undefined) return guard
    const target = workflowScope(repoArg, sourceCard)
    if ("error" in target) return target.error
    const { repo, binding } = target
    const input = JSON.parse(canonicalStoredJsonValue(inputArg ?? {})) as Record<string, unknown>
    // One card per (repo, workspace, flow, input): asking twice for the same plan moves
    // the card rather than growing a second one, and a second ask while the
    // first is in flight is the same request, not a second durable Plan.
    /* A preview is its own card: it states numbers about one run, and a
     * plain re-plan of the same flow must not silently drop them. */
    const previousCard = against === undefined ? undefined : [...store.collections.cards.values()].find((card) =>
      card.kind === "flow-plan" && card.payload.repo === repo && card.payload.workspaceId === binding.workspaceId && card.payload.flowId === name && card.payload.planId === against)
    const prior = previousCard?.kind === "flow-plan" ? previousCard.payload : undefined
    const previousPlan = prior?.planId === undefined || prior.digest === undefined || prior.nodes === undefined ? undefined
      : { planId: prior.planId, digest: prior.digest, nodes: prior.nodes }
    const epoch = ctx.accountEpoch
    const owner = ctx.accountOwner()!
    // Comparison previews reuse their original card, including after a refusal
    // has replaced its old planId with the admitted request.
    const admitted = [...store.collections.cards.values()].find(card => card.kind === "flow-plan" &&
      card.payload.planRequest?.owner === owner && card.payload.repo === repo && card.payload.workspaceId === binding.workspaceId &&
      card.payload.flowId === name && card.payload.against === against && canonicalStoredJsonValue(card.payload.input ?? {}) === canonicalStoredJsonValue(input))
    const id = admitted?.id ?? previousCard?.id ?? planCardId(repo, name, input, against, binding.workspaceId)
    const current = () => !ctx.disposed && ctx.accountEpoch === epoch && ctx.accountOwner() === owner
    for (let saving = planSaving.get(id); saving; saving = planSaving.get(id)) await saving.catch(() => {})
    if (!current()) return "The account changed before the plan was requested."
    const existing = store.collections.cards.get(id)
    const held = existing?.kind === "flow-plan" ? existing.payload : undefined
    const source = sourceCard === undefined ? undefined : store.collections.cards.get(sourceCard)
    const receipt = source?.kind === "run-trace" && source.payload.workflow === FLOW_AUTHORING_ENTRY
      ? authoredSources(store.committedRuntimeRun(runtimeRunKey(source.payload))?.events ?? []).filter(receipt => receipt.flowId === name).at(-1)
      : undefined
    const sourceReceipt = receipt === undefined || source === undefined ? held?.sourceReceipt : { runCardId: source.id, receipt: receipt.receipt }
    const sameRequest = held !== undefined && canonicalStoredJsonValue(held.input ?? {}) === canonicalStoredJsonValue(input) &&
      held.against === against && held.sourceReceipt?.receipt === sourceReceipt?.receipt && held.sourceReceipt?.runCardId === sourceReceipt?.runCardId
    if (planning.get(id) === epoch) {
      if (sameRequest && held?.status !== "failed") return { value: `plan-requested flow=${name} repo=${repo}` }
      // Retry or a newer source receipt retires the old observer before committing its replacement.
      planAttempts.set(id, (planAttempts.get(id) ?? 0) + 1)
      planning.delete(id)
    }
    if (sameRequest && held?.status === "pending" && held.planRequest?.owner === owner && existing?.kind === "flow-plan") {
      startPlan(existing)
      return { value: `plan-requested flow=${name} repo=${repo}` }
    }
    const request = sameRequest && held?.planRequest?.owner === owner ? held.planRequest : { id: crypto.randomUUID(), owner }
    const card: Extract<Card, { kind: "flow-plan" }> = {
      id,
      kind: "flow-plan",
      title: `${name} — ${repo}`,
      status: "active",
      createdAt: existing?.createdAt ?? Date.now(),
      ordinal: sourceReceipt !== undefined && source?.kind === "run-trace" ? Math.max(0, source.ordinal - 1) : existing?.ordinal ?? nextTranscriptOrdinal(),
      payload: {
        repo,
        flowId: name,
        status: "pending",
        planRequest: request,
        workspaceId: binding.workspaceId,
        ...(Object.keys(input).length === 0 ? {} : { input }),
        // A re-plan keeps the graph it last drew, and the drawer the reader
        // has open on it, until a new one lands.
        ...(held?.nodes === undefined ? {} : { nodes: held.nodes }),
        ...(held?.graph === undefined ? {} : { graph: held.graph }),
        ...(held?.view === undefined ? {} : { view: held.view }),
        ...(against === undefined ? {} : { against }),
        ...(previousPlan === undefined ? held?.previousPlan === undefined ? {} : { previousPlan: held.previousPlan } : { previousPlan }),
        ...(sourceReceipt === undefined ? {} : { sourceReceipt })
      }
    }
    let saved: Promise<unknown>
    try { saved = store.dispatch({ type: "card.upsert", actor: ctx.commandActor, card }).isPersisted.promise }
    catch { return "The plan request could not be saved. Try again." }
    planSaving.set(id, saved)
    try { await saved } catch { return "The plan request could not be saved. Try again." }
    finally { if (planSaving.get(id) === saved) planSaving.delete(id) }
    if (!current()) return "The account changed before the plan was requested."
    startPlan(card)
    return { value: `plan-requested flow=${name} repo=${repo}` }
  }

  /**
   * Decide one gate.
   *
   * The payload the gateway published goes back unchanged, so the client never
   * reconstructs authority, and one call records the decision AND resumes the
   * run it unblocked. The card still freezes from the server's answer, never
   * from local optimism: a decision the workspace did not take is a decision
   * the human has to be able to take again.
   */
  const forwardApprovalDecision = async (
    card: Extract<Card, { kind: "approval" }>,
    decision: "approved" | "denied",
    humanAnswer?: unknown
  ): Promise<void> => {
    const trusted = store.approvalRequest(card.id)
    if (trusted?.kind !== "approval") return
    const { repo, approval } = trusted.payload
    if (repo === undefined || approval === undefined) {
      store.dispatch({
        type: "card.approval.decision.failed",
        actor: "system",
        id: card.id,
        message: "This approval is not linked to a run, so there is nothing to send the decision to."
      })
      return
    }
    const binding = recordedRunBinding({ workspaceId: trusted.payload.workspaceId
      ?? (trusted.payload.runId === undefined ? undefined : runScopeFromCard(store, trusted, trusted.payload.runId)?.workspaceId) })
    if ("error" in binding) {
      store.dispatch({ type: "card.approval.decision.failed", actor: "system", id: card.id, message: binding.error })
      return
    }
    const normalizedId = runtimeApprovalIdOf({ ...trusted, payload: { ...trusted.payload, ...binding } })
    const normalized = normalizedId === undefined ? undefined : store.collections.runtimeApprovals.get(normalizedId)
    if (normalized !== undefined) {
      if (!normalized.pending || normalized.submissionId === undefined || normalized.row.status !== "pending") return
      const submissionId = normalized.submissionId
      const answer = await gateway.submitApproval(repo, normalized.row.payload, decision === "approved" ? "approve" : "deny", binding, humanAnswer)
      if (ctx.disposed || store.collections.runtimeApprovals.get(normalized.id)?.submissionId !== submissionId) return
      if (answer.status !== "ok" || answer.value.decision._tag === "Terminal") {
        const observed = await gateway.approvals(repo, normalized.scope.runId, binding)
        if (ctx.disposed || store.collections.runtimeApprovals.get(normalized.id)?.submissionId !== submissionId) return
        if (observed.status === "ok") await reconcileRunApprovals(store, normalized.scope, observed.value)
      }
      if (ctx.disposed || store.collections.runtimeApprovals.get(normalized.id)?.submissionId !== submissionId) return
      await store.dispatch({ type: "gateway.approval.submission.changed", actor: answer.status === "ok" && answer.value.decision._tag !== "Terminal" ? "user" : "system",
        submission: { id: normalized.id, submissionId, state: answer.status === "ok" && answer.value.decision._tag !== "Terminal" ? decision : "failed",
          ...(answer.status === "ok" && answer.value.decision._tag !== "Terminal" ? { decidedAt: Date.now() } : { error: answer.status === "error" ? answer.message : "This run has finished. The workspace has not confirmed a decision for this approval." }) }
      }).isPersisted.promise
      return
    }
    const submitted = await gateway.submitApproval(
      repo,
      approval as Parameters<typeof gateway.submitApproval>[1],
      decision === "approved" ? "approve" : "deny",
      binding,
      humanAnswer
    )
    if (submitted.status !== "ok" || submitted.value.decision._tag === "Terminal") {
      if (trusted.payload.runId !== undefined) {
        const observed = await gateway.approvals(repo, trusted.payload.runId, binding)
        if (observed.status === "ok") await reconcileRunApprovals(store, { repo, runId: trusted.payload.runId, ...binding }, observed.value)
      }
      const current = store.collections.cards.get(card.id)
      if (current?.kind === "approval" && current.payload.decision !== undefined) return
      store.dispatch({
        type: "card.approval.decision.failed",
        actor: "system",
        id: card.id,
        message: submitted.status === "error" ? submitted.message : "This run has finished. The workspace has not confirmed a decision for this approval."
      })
      return
    }
    store.dispatch({
      type: "card.approval.decided",
      actor: "user",
      id: card.id,
      decision,
      decidedAt: Date.now()
    })
  }
  /**
   * A decision made on the workspace approvals inbox (lane runs §5).
   *
   * The gate the decision names belongs to a run whose approval card may
   * never have landed in this transcript — the inbox is how the human reaches
   * it anyway. The row carries the submit-ready envelope the gateway
   * published, so the decision goes back with it unchanged; the card freezes
   * from the server's answer, never from local optimism, exactly as
   * `forwardApprovalDecision` does for a per-run approval card.
   */
  const forwardInboxApprovalDecision = async (
    cardId: string,
    requestId: string,
    decision: "approved" | "denied",
    runId?: string,
    humanAnswer?: unknown
  ): Promise<void> => {
    const raw = store.collections.cards.get(cardId)
    const card = raw === undefined ? undefined : projectRuntimeCard(raw, [...store.collections.runtimeRuns.values()], [...store.collections.runtimeApprovals.values()])
    if (card === undefined || card.kind !== "approvals-inbox") return
    const trusted = store.approvalRequest(cardId)
    if (trusted?.kind !== "approvals-inbox") return
    // Old action IDs omitted the run. They remain valid only when unambiguous.
    const matches = trusted.payload.approvals.filter((entry) => entry.requestId === requestId && (runId === undefined || entry.runId === runId))
    if (matches.length !== 1) return
    const row = matches[0]!
    const displayed = card.payload.approvals.find((entry) => sameApproval(entry, row))
    if (row === undefined || displayed === undefined || displayed.decision !== undefined || displayed.pending === true) return
    const scope = runScopeFromCard(store, trusted, row.runId)
    const digest = (row.approval.target as { digest?: unknown } | undefined)?.digest
    const normalized = scope === undefined || typeof digest !== "string" ? undefined : store.collections.runtimeApprovals.get(runtimeApprovalKey(scope, row.requestId, digest))
    if (normalized !== undefined) {
      if (normalized.row.status !== "pending" || normalized.pending) return
      const submissionId = crypto.randomUUID()
      await store.dispatch({ type: "gateway.approval.submission.changed", actor: "user", submission: { id: normalized.id, submissionId, state: "pending" } }).isPersisted.promise
      if (ctx.disposed || store.collections.runtimeApprovals.get(normalized.id)?.submissionId !== submissionId) return
      const binding = recordedRunBinding(normalized.scope)
      if ("error" in binding) {
        await store.dispatch({ type: "gateway.approval.submission.changed", actor: "system", submission: { id: normalized.id, submissionId, state: "failed", error: binding.error } }).isPersisted.promise
        return
      }
      const answer = await gateway.submitApproval(normalized.scope.repo, normalized.row.payload, decision === "approved" ? "approve" : "deny", binding, humanAnswer)
      if (ctx.disposed || store.collections.runtimeApprovals.get(normalized.id)?.submissionId !== submissionId) return
      if (answer.status !== "ok" || answer.value.decision._tag === "Terminal") {
        const observed = await gateway.approvals(normalized.scope.repo, normalized.scope.runId, binding)
        if (ctx.disposed || store.collections.runtimeApprovals.get(normalized.id)?.submissionId !== submissionId) return
        if (observed.status === "ok") await reconcileRunApprovals(store, normalized.scope, observed.value)
      }
      if (ctx.disposed || store.collections.runtimeApprovals.get(normalized.id)?.submissionId !== submissionId) return
      const applied = answer.status === "ok" && answer.value.decision._tag !== "Terminal"
      await store.dispatch({ type: "gateway.approval.submission.changed", actor: applied ? "user" : "system", submission: { id: normalized.id, submissionId,
        state: applied ? decision : "failed", ...(applied ? { decidedAt: Date.now() } : { error: answer.status === "error" ? answer.message : "This run has finished. The workspace has not confirmed a decision for this approval." }) } }).isPersisted.promise
      return
    }
    const binding = recordedRunBinding({ workspaceId: trusted.payload.workspaceId ?? runScopeFromCard(store, trusted, row.runId)?.workspaceId })
    store.dispatch({
      type: "card.updated",
      actor: "error" in binding ? "system" : "user",
      id: cardId,
      patch: {
        payload: {
          ...card.payload,
          approvals: card.payload.approvals.map((entry) => !sameApproval(entry, row) ? entry
            : "error" in binding ? { ...entry, decisionError: binding.error, pending: undefined } : { ...entry, pending: true })
        }
      }
    })
    if ("error" in binding) return
    const submitted = await gateway.submitApproval(
      trusted.payload.repo,
      row.approval as Parameters<typeof gateway.submitApproval>[1],
      decision === "approved" ? "approve" : "deny",
      binding,
      humanAnswer
    )
    if (submitted.status !== "ok" || submitted.value.decision._tag === "Terminal") {
      const observed = await gateway.approvals(trusted.payload.repo, row.runId, binding)
      if (observed.status === "ok") await reconcileRunApprovals(store, { repo: trusted.payload.repo, runId: row.runId, ...binding }, observed.value)
    }
    const latest = store.collections.cards.get(cardId)
    if (latest === undefined || latest.kind !== "approvals-inbox") return
    if (latest.payload.approvals.find((entry) => sameApproval(entry, row))?.decision !== undefined) return
    const applied = submitted.status === "ok" && submitted.value.decision._tag !== "Terminal"
    // The local receipt time; projection observations never invent server timestamps.
    const decidedAt = Date.now()
    const approvals = latest.payload.approvals.map((entry) =>
      sameApproval(entry, row)
        ? applied
          ? { ...entry, decision, decidedAt, decisionError: undefined, pending: undefined }
          : { ...entry, decisionError: submitted.status === "error" ? submitted.message : "This run has finished. The workspace has not confirmed a decision for this approval.", pending: undefined }
        : entry
    )
    store.dispatch({
      type: "card.updated",
      actor: applied ? "user" : "system",
      id: cardId,
      patch: {
        payload: { ...latest.payload, approvals },
        // The inbox is acted only when no row is still undecided.
        ...(approvals.every((entry) => entry.decision !== undefined) ? { status: "acted" as const } : {})
      }
    })
  }
  return {
    resumeWorkflowRequests: () => { requests.resume(); catalogs.resume(); resumePlans() },
    retryWorkflowRequest: requests.retry,
    requestTriggerRun,
    requestTriggerRegistration,
    createWorkflow,
    listWorkspaceWorkflows,
    showFlows,
    runWorkflow,
    requestChange,
    planFlow,
    chooseWorkflowRepo,
    forwardApprovalDecision,
    workflowIdentityGuard,
    workflowBalanceGuard: zeroBalanceGuard,
    workflowTargetRepo,
    provisionWorkspace,
    upsertRunCard,
    launchWorkflow,
    requestRerun,
    forwardInboxApprovalDecision
  }
}
