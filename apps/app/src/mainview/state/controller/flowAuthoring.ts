import { canonical, digest } from "@smthrs/core/Digest"
import { FLOW_AUTHORING_ENTRY, flowAuthoringUnavailable } from "@smthrs/rpc/FlowAuthoring"
import type { Card } from "../AppState"
import { authoredSources, type AuthoredSource } from "../FlowAuthoringReceipts"
import { runtimeRunKey } from "../RuntimeProjection"
import { recordedRunBinding } from "../RepoContext"
import { engineProjectionPending } from "../../cards/EngineTrace"
import { flowArgs } from "../../flows/FlowArgs"
import { Data } from "effect"
import { presentAppFailure } from "./AppFailure"
import type { ControllerContext } from "./context"
import { isFlowNotFound, type GatewayWorkspaceBinding } from "./gateway"
import { TOAST_CANCELLED, TOAST_SUPERSEDED } from "./failures"
import { failureDetail } from "@smthrs/rpc/UserFailure"

type Run = Extract<Card, { kind: "run-trace" }>
type Plan = Extract<Card, { kind: "flow-plan" }>

/** The durable request, launch and journal observer share one background lifetime. */
/** A launch refusal this app or the gateway already worded for a person. */
class AuthoringRefusal extends Data.TaggedError("AuthoringRefusal")<{ readonly sentence: string; readonly detail?: string }> {
  /** `detail` is the refusing party's raw words (a gateway result's `detail`), for Details and diagnostics only. */
  constructor(sentence: string, detail?: string) { super({ sentence, ...(detail === undefined ? {} : { detail }) }) }
  /** The sentence, with the raw words after it, is the error's diagnostic message. */
  override get message(): string { return this.detail === undefined ? this.sentence : `${this.sentence} (${this.detail})` }
}

export const createFlowAuthoringController = (
  ctx: ControllerContext,
  nextOrdinal: () => number,
  provision: (repo: string, binding: GatewayWorkspaceBinding) => Promise<true | string>,
  pump: (cardId: string) => Promise<void>
) => {
  const { store } = ctx
  const pending = new Map<string, Promise<unknown>>()
  const persisting = new Map<string, Promise<unknown>>()
  const refreshing = new Map<string, Promise<void>>()
  const read = (id: string): Run | undefined => {
    const card = store.collections.cards.get(id)
    return card?.kind === "run-trace" ? card : undefined
  }
  const current = (card: Run) => !ctx.disposed && card.payload.authoring?.owner === store.collections.identitySessions.get("identity")?.login
  const upsert = (card: Card) => store.dispatch({ type: "card.upsert", actor: "system", card }).isPersisted.promise

  // Subscription waits on persisted collection state, not a second polling loop.
  // One scope finalizer wakes the waits still open; a settled wait leaves the set.
  const waits = new Set<() => void>()
  ctx.onDispose(() => { for (const wake of [...waits]) wake() })
  const until = (done: () => boolean): Promise<void> => new Promise((resolve, reject) => {
    const subscriptions: Array<{ unsubscribe(): void }> = []
    let finished = false
    const close = () => {
      finished = true
      waits.delete(check)
      for (const subscription of subscriptions) subscription.unsubscribe()
    }
    const check = () => {
      if (finished) return
      if (ctx.disposed) { close(); resolve(); return }
      // Collection notifications can precede the durable receipt read by done().
      // Evaluate after that write settles, even if no later journal page arrives.
      void (async () => {
        await store.settled?.()
        if (finished || !ctx.disposed && !done()) return
        close()
        resolve()
      })().catch(error => { if (!finished) { close(); reject(error) } })
    }
    for (const collection of [store.collections.cards, store.collections.runtimeRuns, store.collections.identitySessions]) subscriptions.push(collection.subscribeChanges(check))
    waits.add(check)
    check()
  })

  const observe = (id: string): Promise<void> => {
    const active = refreshing.get(id)
    if (active) return active
    const work = (async () => {
      for (;;) {
        const card = read(id)
        if (!card || card.payload.workflow !== FLOW_AUTHORING_ENTRY || !current(card)) return
        // Reconnecting an older completed author must never replay its source
        // receipt over a later edit. Compare the journal's recorded times
        // across this workspace's authors; untimed legacy rows cannot establish
        // which source update is newest and do not trigger automatic planning.
        const heads = new Map<string, { source: AuthoredSource; runCardId: string; ordinal: number }>()
        for (const author of store.collections.cards.values()) {
          if (author.kind !== "run-trace" || author.payload.workflow !== FLOW_AUTHORING_ENTRY || !current(author) ||
            author.payload.repo !== card.payload.repo || author.payload.workspaceId !== card.payload.workspaceId) continue
          for (const source of authoredSources(store.committedRuntimeRun(runtimeRunKey(author.payload))?.events ?? [])) {
            if (source.occurredAt === undefined) continue
            const held = heads.get(source.flowId)
            if (!held || source.occurredAt > held.source.occurredAt! ||
              source.occurredAt === held.source.occurredAt && author.ordinal >= held.ordinal) {
              heads.set(source.flowId, { source, runCardId: author.id, ordinal: author.ordinal })
            }
          }
        }
        const latest = [...heads.values()].filter(head => head.runCardId === id).map(head => head.source)
        const plans = Array.from<Card>(store.collections.cards.values()).filter((candidate): candidate is Plan => candidate.kind === "flow-plan" &&
          candidate.payload.repo === card.payload.repo && candidate.payload.workspaceId === card.payload.workspaceId)
        const planFor = (flowId: string) => plans.find(candidate => candidate.payload.flowId === flowId && candidate.payload.sourceReceipt?.runCardId === id)
          ?? plans.find(candidate => candidate.payload.flowId === flowId && candidate.payload.sourceReceipt !== undefined)
          ?? plans.find(candidate => candidate.payload.flowId === flowId && candidate.payload.against === undefined)
        const next = latest.find(source => {
          const plan = planFor(source.flowId)
          return plan?.payload.sourceReceipt?.receipt !== source.receipt || plan.payload.status === "pending"
        })
        if (!next) return
        const previous = planFor(next.flowId)
        // Same registered Plan door as slash, button and agent. No second compiler.
        const outcome = await ctx.commands.run("flow.plan", flowArgs("flow.plan", {
          name: next.flowId, repo: card.payload.repo, sourceCard: id,
          ...(previous?.payload.planId === undefined ? {} : { against: previous.payload.planId }),
          ...(previous?.payload.input === undefined ? {} : { input: previous.payload.input })
        }), "automatic")
        if (outcome.status !== "executed") return
        // The command dispatcher can coalesce a newer receipt before it opens
        // the Plan door. Wait for that flow's settled card, then re-read the
        // journal; waiting for the superseded receipt would never finish.
        await until(() => !current(card) || [...store.collections.cards.values()].some(candidate => candidate.kind === "flow-plan" &&
          candidate.payload.flowId === next.flowId && candidate.payload.sourceReceipt?.runCardId === id && candidate.payload.status !== "pending"))
        if (!current(card)) return
      }
    })().finally(() => refreshing.delete(id))
    refreshing.set(id, work)
    return work
  }

  const send = (id: string): Promise<unknown> => {
    const active = pending.get(id)
    if (active) return active
    const initial = read(id)
    if (!initial?.payload.authoring || !current(initial)) return Promise.resolve()
    const work = ctx.withToast(`flow.author:${id}`, "Creating a flow", "Authoring finished", async () => {
      try {
        let card = read(id)!
        if (card.payload.runId === "") {
          const binding = recordedRunBinding(card.payload, "This request's box is gone.")
          if ("error" in binding) throw new AuthoringRefusal(binding.error)
          const ready = await provision(card.payload.repo, binding)
          if (!current(card)) return TOAST_SUPERSEDED
          if (ready !== true) throw new AuthoringRefusal(ready)
          const launched = await ctx.gateway.launch(card.payload.repo, FLOW_AUTHORING_ENTRY, { args: card.payload.input?.args }, binding, card.payload.authoring!.requestId)
          if (!current(card)) return TOAST_SUPERSEDED
          if (launched.status !== "ok") throw isFlowNotFound(launched.code)
            ? new AuthoringRefusal(flowAuthoringUnavailable(card.payload.repo))
            : new AuthoringRefusal(launched.message, launched.detail)
          card = read(id)!
          await upsert({ ...card, status: "active", payload: { ...card.payload, runId: launched.value.runId,
            phase: "running", observationError: undefined, follow: true,
            authoring: { ...card.payload.authoring!, launchError: undefined } } })
        }
        void pump(id)
        await until(() => {
          const live = read(id)
          if (!live || !current(live)) return true
          const run = store.committedRuntimeRun(runtimeRunKey(live.payload))
          return run?.observer?.error !== undefined || run?.summary !== undefined &&
            ["completed", "failed", "cancelled"].includes(run.summary.status) && !engineProjectionPending(run.events)
        })
        card = read(id)!
        if (!card || !current(card)) return TOAST_SUPERSEDED
        await observe(id)
        const run = store.committedRuntimeRun(runtimeRunKey(card.payload))
        return run?.observer?.error ?? (run?.summary?.status === "completed" ? true : run?.summary?.status === "cancelled" ? TOAST_CANCELLED : run?.summary?.verdict ?? "The run could not be observed.")
      } catch (error) {
        const card = read(id)
        if (!card || !current(card)) return TOAST_SUPERSEDED
        // The card keeps the raw words behind Details; the toast says the sentence.
        const message = failureDetail(error)
        await upsert({ ...card, status: "error", payload: { ...card.payload, observationError: message,
          authoring: { ...card.payload.authoring!, launchError: message } } })
        return error instanceof AuthoringRefusal ? error.sentence : presentAppFailure(error,
          failure => ctx.failures.report("toast.work", failure, id),
          { fault: "bug", sentence: "The flow could not be created. Not your fault.", actions: ["retry"] }).sentence
      }
    }, false, () => { const card = read(id); return card !== undefined && current(card) }, id).finally(() => pending.delete(id))
    pending.set(id, work)
    return work
  }

  const request = async (description: string, repo: string, binding: GatewayWorkspaceBinding, actor: ControllerContext["commandActor"]) => {
    const owner = store.collections.identitySessions.get("identity")?.login ?? ""
    const id = `flow-author-${digest(canonical([owner, repo, binding.workspaceId, description])).slice(0, 24)}`
    const existing = read(id)
    if (existing && pending.has(id)) return { value: `flow-requested repo=${repo}` }
    const completed = existing && store.committedRuntimeRun(runtimeRunKey(existing.payload))?.summary?.status === "completed"
    if (completed) return { value: `run-started workflow=${FLOW_AUTHORING_ENTRY} run=${existing.payload.runId} repo=${repo}` }
    let saved = persisting.get(id)
    if (!existing && !saved) {
      // Reserve the preceding slot for the graph. Later chat cannot take it,
      // and moving an existing plan here never ties its order with the run.
      const ordinal = nextOrdinal() + 1
      saved = store.dispatch({ type: "card.upsert", actor, card: {
        id, kind: "run-trace", title: "Creating a flow", status: "active", ordinal, createdAt: Date.now(),
        payload: { repo, ...binding, gatewayBindingVersion: 1, runId: "", workflow: FLOW_AUTHORING_ENTRY, phase: "launching", steps: [], result: null, lastSeq: 0,
          input: { args: description }, authoring: { requestId: crypto.randomUUID(), owner } }
      } }).isPersisted.promise
      persisting.set(id, saved)
    }
    // A rejected save must not answer every later request for this card.
    if (saved) try { await saved } finally { if (persisting.get(id) === saved) persisting.delete(id) }
    void send(id)
    return { value: `flow-requested repo=${repo}` }
  }
  const resume = (retryCardId?: string) => {
    for (const card of store.collections.cards.values()) {
      if (card.kind !== "run-trace" || !card.payload.authoring || !current(card)) continue
      if (retryCardId === card.id && card.payload.authoring.launchError !== undefined) {
        void upsert({ ...card, payload: { ...card.payload, authoring: { ...card.payload.authoring, launchError: undefined }, observationError: undefined } }).then(() => send(card.id))
      } else if (card.payload.authoring.launchError === undefined) void send(card.id)
      void observe(card.id)
    }
  }
  return { request, observe, resume }
}
