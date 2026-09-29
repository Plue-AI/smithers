import { Data } from "effect"
import type { Actor, Card } from "../AppState"
import { actorSharedState } from "../ActorBindings"
import { canonicalStoredJsonValue } from "../EventValue"
import { projectRuntimeCard, runtimeRunKey } from "../RuntimeProjection"
import { workflowLaunchOf, type WorkflowLaunch } from "../WorkflowLaunch"
import type { ControllerContext } from "./context"
import { TOAST_CANCELLED, TOAST_SUPERSEDED } from "./failures"
import { isFlowNotFound, type GatewayWorkspaceBinding } from "./gateway"
import { gatewayBindingFor } from "../RepoContext"
import { planCardSnapshot } from "../../cards/PlanNodes"
import { runFailureOf, stampOf } from "../RunFailure"
import { digest } from "@smthrs/core/Digest"
import { codingVibeRequestOf } from "../../cards/CodingVibe"
import { codingEvidenceOf } from "../../cards/CodingPlan"
import { engineProjectionPending } from "../../cards/EngineTrace"

type RunCard = Extract<Card, { kind: "run-trace" }>
/** A request that names its box: the only kind a new request card records. */
type BoxLaunch = WorkflowLaunch & { readonly workspaceId: string }
/** A launch refusal: one sentence in product words, and its code. */
type Refusal = { readonly message: string; readonly code?: string; readonly retryAfterSeconds?: number }
const terminal = new Set(["completed", "failed", "cancelled"])
/** Polls a completed request waits for its journal before judging whether it validated. */
const EVIDENCE_ROUNDS = 24
/** The dedup identity of a request: a change request is not the same work as a bare run of its first flow. */
const requestKey = (request: Pick<WorkflowLaunch, "owner" | "repo" | "workspaceId" | "workflow" | "input" | "then" | "triggerRegistration" | "source" | "rerunOf">): string =>
  canonicalStoredJsonValue([request.owner, request.repo, request.workspaceId ?? null, request.workflow,
    request.triggerRegistration ?? (request.workflow === "repository/trigger" && request.input.operation === "resume"
      ? { operation: "resume", slug: request.input.slug } : sourceFree(request)), ...(request.then === undefined ? [] : [request.then]),
    // The asked-for source is the request; the base preparation pins from it is not.
    ...(request.source === undefined ? [] : [{ from: request.source.explicit ? request.source.name : null }]),
    ...(request.rerunOf === undefined ? [] : [{ rerunOf: request.rerunOf }])])
const sourceFree = (request: Pick<WorkflowLaunch, "input" | "source">): Record<string, unknown> => {
  if (request.source === undefined) return request.input
  const { base: _base, ...rest } = request.input
  return rest
}
class RequestPersistenceError extends Data.TaggedError("RequestPersistenceError")<{ readonly message: string }> {
  constructor(message = "The launch request could not be saved.") { super({ message }) }
}

/** One durable request owns preparation, launch and observation through remote settlement. */
export const createWorkflowLaunchController = (
  ctx: ControllerContext,
  nextOrdinal: () => number,
  pump: (cardId: string) => Promise<void>,
  prepare: (repo: string, binding: GatewayWorkspaceBinding, signal: AbortSignal, request: WorkflowLaunch, current: () => boolean) => Promise<true | Refusal | { input: Record<string, unknown>; source?: WorkflowLaunch["source"] }>,
  completed?: (request: WorkflowLaunch) => void
) => actorSharedState(ctx, "workflow-launch", () => {
  const { store } = ctx
  const inFlight = new Map<string, { epoch: number; controller: AbortController; work: Promise<unknown> }>()
  const persisting = new Map<string, Promise<unknown>>()
  const controllers = new Set<AbortController>()
  const owner = () => {
    const identity = store.collections.identitySessions.get("identity")
    return identity?.state === "signed-in" && identity.allowlisted ? identity.login : undefined
  }
  const read = (id: string): RunCard | undefined => { const card = store.collections.cards.get(id); return card?.kind === "run-trace" ? card : undefined }
  const save = (card: RunCard) => store.dispatch({ type: "card.upsert", actor: "system", card }).isPersisted.promise
  const pause = (ms: number, signal: AbortSignal) => new Promise<void>(resolve => {
    if (signal.aborted) { resolve(); return }
    const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve() }
    const timer = setTimeout(done, Math.max(1, ms))
    ctx.unref(timer)
    signal.addEventListener("abort", done, { once: true })
  })
  ctx.onDispose(() => { for (const controller of controllers) controller.abort(); controllers.clear() })

  const send = (id: string, request: WorkflowLaunch): void => {
    if (ctx.disposed || owner() !== request.owner) return
    const epoch = ctx.accountEpoch
    const previous = inFlight.get(id)
    if (previous?.epoch === epoch) return
    previous?.controller.abort()
    const controller = new AbortController()
    controllers.add(controller)
    // Admission needs a signed-in, allowlisted owner; work already admitted
    // continues through an identity outage and stops only on an owner change.
    const current = () => !ctx.disposed && !controller.signal.aborted && ctx.accountEpoch === epoch && ctx.accountOwner() === request.owner && workflowLaunchOf(read(id))?.id === request.id
    const preparationExpired = () => Date.now() - (request.preparationStartedAt ?? read(id)!.createdAt) >= ctx.workflowPreparationTimeoutMs
    const publish = async (next: WorkflowLaunch, patch: Partial<RunCard["payload"]> = {}) => {
      if (!current()) return
      const card = read(id)!
      try {
        await save({ ...card, status: next.error ? "error" : "active", payload: { ...card.payload, ...patch,
          input: { ...next.input, _workflowLaunch: next } } })
      } catch { throw new RequestPersistenceError() }
    }
    // A new request for the same work replaces its earlier failure on the shared stack.
    const registration = request.triggerRegistration
    const toastKey = registration ? `trigger.register.${request.repo}.${registration.slug}.${registration.requestId}`
      : request.triggerDispatch ? `trigger.run.${request.repo}.${request.triggerDispatch.slug}.${request.id}` : `flow.request.${digest(requestKey(request))}`
    // Repository registration's analysis is done when it reaches review; the review can take days.
    const analysis = request.workflow === "register-repository"
    const title = registration ? `Registering ${registration.slug} on ${request.repo}…`
      : request.triggerDispatch ? `${request.input.operation === "resume" ? "Resuming" : "Running"} ${request.triggerDispatch.slug} on ${request.repo}…`
      : analysis ? `Analyzing ${request.repo}…` : request.workflow
    const doneTitle = registration ? `${registration.slug} registered`
      : request.triggerDispatch ? `${request.triggerDispatch.slug} ${request.input.operation === "resume" ? "resumed" : "dispatched"}`
      : analysis ? `${request.repo} is in review` : `${request.workflow} completed`
    // A request saved before every request named its box has none to reach; Retry binds one.
    const box = request.workspaceId
    const work = ctx.withToast(toastKey, title, doneTitle, async () => {
      let stage: NonNullable<WorkflowLaunch["error"]>["stage"] = "preparation"
      /* Every refusal here is already a sentence: authored above, or a gateway result's (GatewayFailureCopy). */
      const fail = async (refused: Refusal) => {
        if (!current()) return TOAST_SUPERSEDED
        const record = { stage, code: refused.code ?? "launch_unavailable", message: refused.message }
        await publish({ ...request, error: record }, { phase: "failed", error: record.message })
        return record.message
      }
      /*
       * A change request lands only through coding/vibe, and coding/vibe
       * admits only a validated request. Read that verdict off the run's own
       * journal, then hand over to one follow-up request whose identity is
       * derived from this one, so a reload or a second observer resumes it
       * instead of starting another.
       */
      const continueChange = async (): Promise<true | string | typeof TOAST_SUPERSEDED> => {
        for (let round = 0; current(); round++) {
          const followed = workflowLaunchOf(read(id))?.next
          if (followed !== undefined) {
            const next = workflowLaunchOf(read(`flow-request-${followed}`))
            if (next !== undefined && !next.error) send(`flow-request-${followed}`, next)
            return true
          }
          const run = store.committedRuntimeRun(runtimeRunKey(read(id)!.payload))
          const card = projectRuntimeCard(read(id)!, run === undefined ? [] : [run], [])
          if (card.kind !== "run-trace") return TOAST_SUPERSEDED
          const validated = codingVibeRequestOf(card)
          if (validated !== undefined) {
            if (box === undefined) return "This request's box is gone."
            const fresh: BoxLaunch = { version: 1, id: `${request.id}.vibe`, owner: request.owner, repo: request.repo,
              workspaceId: box, workflow: "coding/vibe",
              input: { requestExecutionId: validated.requestExecutionId }, preparationStartedAt: Date.now() }
            // The plan card's own Vibe button may already have asked for the same landing.
            const adopted = [...store.collections.cards.values()].map(workflowLaunchOf)
              .find(held => held !== undefined && !held.error && requestKey(held) === requestKey(fresh))
            const next = adopted ?? fresh
            const nextId = next.id
            const cardId = `flow-request-${nextId}`
            // An adopted request has this one's key, so it names the same box.
            if (read(cardId) === undefined) await save(requestCard(cardId, { ...next, workspaceId: box }))
            if (!current()) return TOAST_SUPERSEDED
            await publish({ ...request, next: nextId })
            send(cardId, next)
            return true
          }
          const outcome = codingEvidenceOf(card).outcome
          if (outcome !== undefined && outcome.status !== "validated") {
            return outcome.blocked?.message ?? `Changes requested after ${outcome.rounds} ${outcome.rounds === 1 ? "round" : "rounds"}.`
          }
          if (round >= EVIDENCE_ROUNDS && run?.journalPending !== true && !engineProjectionPending(run?.events)) {
            return "The run finished without a validated change."
          }
          await pause(ctx.workflowPollMs, controller.signal)
        }
        return TOAST_SUPERSEDED
      }
      try {
        if (request.runId === undefined) {
          if (box === undefined) {
            const now = gatewayBindingFor(store, request.repo)
            return await fail({ code: "box_gone", message: "error" in now ? now.error : "This request's box is gone." })
          }
          const binding = { workspaceId: box }
          for (;;) {
            if (!current()) return TOAST_SUPERSEDED
            if (preparationExpired()) return await fail({ code: "workspace_preparation_timeout", message: "The box did not become ready. Retry the request." })
            const retryAt = workflowLaunchOf(read(id))?.retryAt
            if (retryAt !== undefined) await pause(retryAt - Date.now(), controller.signal)
            if (!current()) return TOAST_SUPERSEDED
            stage = "preparation"
            let ready = await prepare(request.repo, binding, controller.signal, request, current)
            if (!current()) return TOAST_SUPERSEDED
            if (ready !== true && "input" in ready) {
              request = { ...request, input: ready.input, inputPrepared: true, ...(ready.source === undefined ? {} : { source: ready.source }) }
              await publish(request)
              if (!current()) return TOAST_SUPERSEDED
              ready = true
            }
            stage = ready === true ? "launch" : "preparation"
            const result = ready === true ? await ctx.gateway.launch(request.repo, request.workflow, request.input, binding,
              { idempotencyKey: request.id, stillCurrent: current,
                ...(request.triggerRegistration ? { planKey: `trigger:${request.triggerRegistration.requestId}:register-plan`,
                  runKey: `trigger:${request.triggerRegistration.requestId}:register-run` } : {}) }) : { status: "error" as const, ...ready }
            if (!current()) return TOAST_SUPERSEDED
            if (result.status === "ok") {
              request = { ...request, runId: result.value.runId, retryAt: undefined, error: undefined }
              const plan = planCardSnapshot(result.value)
              // The remote job already exists. Retain its identity and retry
              // the local receipt without relaunching or settling its toast.
              let reported = false
              while (current()) {
                try {
                  await publish(request, { runId: result.value.runId, phase: "running", error: undefined,
                    ...(plan === undefined ? {} : { plan }) })
                  break
                } catch (error) {
                  if (!reported) {
                    reported = true
                    try {
                      void store.dispatch({ type: "message.appended", actor: "system",
                        text: "The run started, but this browser could not save its reference. Retrying the save." }).isPersisted.promise
                        .catch(failure => ctx.failures.report("toast.work", failure, id))
                    } catch (failure) { ctx.failures.report("toast.work", failure, id) }
                    ctx.failures.report("toast.work", error, id)
                  }
                  await pause(ctx.workflowPollMs, controller.signal)
                }
              }
              break
            }
            if (result.code === "workspace_starting") {
              stage = "preparation"
              if (preparationExpired()) return await fail({ code: "workspace_preparation_timeout", message: "The box did not become ready. Retry the request." })
              await publish({ ...request, retryAt: Date.now() + (result.retryAfterSeconds ?? ctx.workflowPollMs / 1000) * 1000 })
              continue
            }
            if (isFlowNotFound(result.code)) {
              const list = await ctx.gateway.listFlows(request.repo, binding)
              if (!current()) return TOAST_SUPERSEDED
              const names = list.status === "ok" ? list.value.slice(0, 8).map(flow => flow.flowId).join(", ") : ""
              return await fail({ ...result, message: `There's no flow called ${request.workflow} on ${request.repo}.${names ? ` The workspace has: ${names}.` : ""}` })
            }
            return await fail(result)
          }
        }
        if (!current()) return TOAST_SUPERSEDED
        void pump(id).catch(async () => {
          if (!current()) return
          const card = read(id)!
          await save({ ...card, payload: { ...card.payload, observationError: "The run could not be checked. Check again to reconnect." } })
        })
        // Read committed gateway receipts. A launched or quiet watcher is not a finished job.
        while (current()) {
          const card = read(id)!
          const run = store.committedRuntimeRun(runtimeRunKey(card.payload))
          const summary = run?.summary
          if (analysis && summary?.status === "waiting-approval") return true
          if (summary !== undefined && terminal.has(summary.status)) {
            if (summary.status === "completed") {
              completed?.(request)
              if (!current()) return TOAST_SUPERSEDED
              return request.then === undefined ? true : await continueChange()
            }
            if (summary.status === "cancelled") return TOAST_CANCELLED
            return runFailureOf({ workflow: request.workflow, error: summary.verdict,
              events: store.committedRuntimeRun(runtimeRunKey(card.payload))?.events, failure: stampOf(summary) }).message
          }
          await pause(ctx.workflowPollMs, controller.signal)
        }
        return TOAST_SUPERSEDED
      } catch (error) {
        if (!current()) return TOAST_SUPERSEDED
        if (error instanceof RequestPersistenceError) stage = "persistence"
        const message = stage === "persistence" ? "The run request could not be saved. Try again." : "The workspace did not answer. Retry the request."
        const code = stage === "persistence" ? "request_persistence_failed" : "launch_unreachable"
        // Losing a local write after launch cannot change the remote verdict.
        if (request.runId !== undefined) return message
        try { return await fail({ code, message }) } catch { return message }
      }
    }, false, current, id)
    inFlight.set(id, { epoch, controller, work })
    void work.finally(() => { if (inFlight.get(id)?.work === work) inFlight.delete(id); controllers.delete(controller) })
  }

  const resume = () => {
    for (const card of store.collections.cards.values()) {
      const request = workflowLaunchOf(card)
      if (request && !request.error) send(card.id, request)
    }
  }
  const retry = (id: string): boolean => {
    const card = read(id), request = workflowLaunchOf(card)
    if (!card || !request || request.runId !== undefined) return false
    if (owner() !== request.owner || persisting.has(id)) return true
    const active = inFlight.get(id)
    if (active) {
      if (request.error) void active.work.then(() => retry(id))
      return true
    }
    // A request saved with no box is bound to the box a new request would name; with none, it fails saying which to open or pick.
    const rebound = request.workspaceId === undefined ? gatewayBindingFor(store, request.repo) : { workspaceId: request.workspaceId }
    const bound = "error" in rebound ? {} : { workspaceId: rebound.workspaceId }
    const next = { ...request, ...bound, error: undefined, retryAt: undefined, preparationStartedAt: Date.now() }
    const saving = save({ ...card, status: "active", payload: { ...card.payload, ...bound, phase: "launching", error: undefined, input: { ...next.input, _workflowLaunch: next } } })
    persisting.set(id, saving)
    void saving.then(() => send(id, next), () => {}).finally(() => persisting.delete(id))
    return true
  }
  const requestCard = (id: string, request: BoxLaunch): RunCard => ({ id, kind: "run-trace", title: `${request.triggerRegistration ? `Register ${request.triggerRegistration.slug}` : request.triggerDispatch ? `${request.input.operation === "resume" ? "Resume" : "Run"} ${request.triggerDispatch.slug}` : request.workflow} · ${request.repo}`,
    status: "active", createdAt: Date.now(), ordinal: nextOrdinal(), payload: { repo: request.repo,
      workspaceId: request.workspaceId, gatewayBindingVersion: 1,
      workflow: request.workflow, runId: `pending-${request.id}`, phase: "launching", steps: [], result: null, lastSeq: 0, liveTail: true,
      input: { ...request.input, _workflowLaunch: request } } })
  const start = async (args: { repo: string; binding: GatewayWorkspaceBinding; workflow: string; input: Record<string, unknown>; actor: Actor; then?: "coding/vibe"; triggerDispatch?: WorkflowLaunch["triggerDispatch"]; triggerRegistration?: WorkflowLaunch["triggerRegistration"]; source?: WorkflowLaunch["source"]; rerunOf?: string }): Promise<string | { value: string }> => {
    const login = owner()
    if (!login) return "Sign in with GitHub first: flows run on your own workspace."
    // A request belongs to the account that made it: sign-out forgets its card, so no await may save it again.
    const epoch = ctx.accountEpoch
    const admitted = () => !ctx.disposed && ctx.accountEpoch === epoch && owner() === login
    const ended = "The account changed before the run was requested."
    const input = JSON.parse(canonicalStoredJsonValue(args.input)) as Record<string, unknown>
    const key = requestKey({ owner: login, repo: args.repo, workspaceId: args.binding.workspaceId, workflow: args.workflow, input, then: args.then, triggerRegistration: args.triggerRegistration, source: args.source, rerunOf: args.rerunOf })
    // Admission is serialized through persistence, shared by button, slash and agent bindings.
    while (persisting.has(key)) await persisting.get(key)
    if (!admitted()) return ended
    const prior = [...store.collections.cards.values()].find(card => {
      const held = workflowLaunchOf(card)
      return held && requestKey(held) === key &&
        (held.triggerRegistration !== undefined || held.runId === undefined || (card.kind === "run-trace" && !terminal.has(card.payload.phase)))
    })
    if (prior) {
      const held = workflowLaunchOf(prior)!
      if (held.error) retry(prior.id)
      else send(prior.id, held)
      return { value: `run-requested workflow=${args.workflow} request=${held.id} repo=${args.repo}` }
    }
    const request: BoxLaunch = { version: 1, id: crypto.randomUUID(), owner: login, repo: args.repo, workspaceId: args.binding.workspaceId, workflow: args.workflow,
      input, preparationStartedAt: Date.now(), ...(args.triggerRegistration === undefined ? {} : { triggerRegistration: args.triggerRegistration }), ...(args.triggerDispatch === undefined ? {} : { triggerDispatch: args.triggerDispatch }), ...(args.then === undefined ? {} : { then: args.then }), ...(args.source === undefined ? {} : { source: args.source }), ...(args.rerunOf === undefined ? {} : { rerunOf: args.rerunOf }) }
    const id = `flow-request-${request.id}`
    const saving = store.dispatch({ type: "card.upsert", actor: args.actor, card: requestCard(id, request) }).isPersisted.promise
    persisting.set(key, saving)
    try { await saving } catch { return "The run request could not be saved. Try again." } finally { persisting.delete(key) }
    if (!admitted()) return ended
    send(id, request)
    return { value: `run-requested workflow=${args.workflow} request=${request.id} repo=${args.repo}` }
  }
  return { start, resume, retry }
})
