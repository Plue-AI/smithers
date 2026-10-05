import type { Card } from "../AppState"
import { actorSharedState } from "../ActorBindings"
import type { ControllerContext } from "./context"
import type { GatewayWorkspaceBinding } from "./gateway"
import { recordedRunBinding } from "../RepoContext"
import { TOAST_SUPERSEDED } from "./failures"
import type { LaunchRefusal } from "./workflows"
import { randomUuid } from "../../runtime/RandomUuid"

type Catalog = Extract<Card, { kind: "workflow-list" }>
type Scope = { readonly repo: string; readonly binding: GatewayWorkspaceBinding }

/** A catalog request is durable; provisioning and the read never hold Chat open. */
export function createWorkflowCatalogController(ctx: ControllerContext, options: {
  readonly resolve: (repo?: string, sourceCard?: string) => Scope | string
  readonly provision: (repo: string, binding: GatewayWorkspaceBinding) => Promise<true | LaunchRefusal>
}) {
  const { store } = ctx
  const shared = actorSharedState(ctx, "workflow-catalog", () => ({
    running: new Map<string, { id: string; epoch: number; work: Promise<unknown> }>(),
    saving: new Map<string, Promise<unknown>>()
  }))
  const owner = () => {
    const identity = store.collections.identitySessions.get("identity")
    return identity?.state === "signed-in" ? identity.login : undefined
  }
  const read = (card: Catalog) => {
    const request = card.payload.catalogRequest!
    const epoch = ctx.accountEpoch
    const existing = shared.running.get(card.id)
    if (existing?.id === request.id && existing.epoch === epoch) return existing.work
    const current = () => {
      const latest = store.collections.cards.get(card.id)
      return !ctx.disposed && ctx.accountEpoch === epoch && ctx.accountOwner() === request.owner &&
        latest?.kind === "workflow-list" && latest.payload.catalogRequest?.id === request.id
    }
    const binding = recordedRunBinding(card.payload, "This card's box is gone.")
    const key = `flow.catalog.${card.id}`
    const title = "Loading flows…"
    const work = ctx.withToast(key, title, "Flows loaded", async () => {
      const fail = async (message: string) => {
        if (!current()) return TOAST_SUPERSEDED
        await store.dispatch({ type: "card.upsert", actor: "system", card: {
          ...card, loading: false, status: "error", body: message,
          payload: { ...card.payload, catalogRequest: { ...request, state: "failed" } }
        } }).isPersisted.promise
        return current() ? message : TOAST_SUPERSEDED
      }
      try {
        if (!current()) return TOAST_SUPERSEDED
        if ("error" in binding) return fail(binding.error)
        await store.dispatch({ type: "card.upsert", actor: "system", card: { ...card, loading: true, status: "active", body: undefined } }).isPersisted.promise
        if (!current()) return TOAST_SUPERSEDED
        const provisioned = await options.provision(card.payload.repo, binding)
        if (!current()) return TOAST_SUPERSEDED
        if (provisioned !== true) return fail(provisioned.message)
        const list = await ctx.gateway.listFlows(card.payload.repo, binding)
        if (!current()) return TOAST_SUPERSEDED
        if (list.status !== "ok") return fail(list.message)
        const workflows = list.value.map(flow => ({ key: flow.flowId, description: flow.description,
            ...(flow.inputSchema === undefined ? {} : { inputSchema: flow.inputSchema }) }))
        await store.dispatch({ type: "card.upsert", actor: "system", card: {
          ...card, loading: false, status: "active", body: undefined,
          payload: { ...card.payload, workflows, catalogRequest: undefined }
        } }).isPersisted.promise
        return !ctx.disposed && ctx.accountEpoch === epoch && ctx.accountOwner() === request.owner ? true : TOAST_SUPERSEDED
      } catch {
        try { return await fail("Flows could not be loaded. Try again.") }
        catch { return current() ? "Flows could not be saved. Try again." : TOAST_SUPERSEDED }
      }
    })
    const entry = { id: request.id, epoch, work }
    shared.running.set(card.id, entry)
    void work.then(result => {
      if (typeof result !== "string" || !current() || store.collections.toasts.has(`toast-${key}`)) return
      store.dispatch({ type: "toast.shown", actor: "system", key, title })
      ctx.resolveToast(key, { status: "failed", detail: result })
    }).finally(() => { if (shared.running.get(card.id) === entry) shared.running.delete(card.id) })
    return work
  }
  const list = async (repo?: string, sourceCard?: string) => {
    const scope = options.resolve(repo, sourceCard)
    if (typeof scope === "string") return scope
    const login = owner(), epoch = ctx.accountEpoch
    if (!login) return "Sign in with GitHub first."
    const id = `workflow-list@${encodeURIComponent(scope.repo)}@${encodeURIComponent(scope.binding.workspaceId)}`
    const current = () => !ctx.disposed && ctx.accountEpoch === epoch && ctx.accountOwner() === login
    for (let pending = shared.saving.get(id); pending; pending = shared.saving.get(id)) await pending.catch(() => {})
    if (!current()) return "The account changed. Open Flows again."
    const previous = store.collections.cards.get(id)
    const retained = previous?.kind === "workflow-list" ? previous : undefined
    if (retained?.payload.catalogRequest?.state === "pending" && retained.payload.catalogRequest.owner === login) {
      void read(retained)
      return { value: "Flows requested." }
    }
    const card: Catalog = { id, kind: "workflow-list", title: `Flows: ${scope.repo}`, status: "active", loading: true,
      createdAt: previous?.createdAt ?? Date.now(), ordinal: store.nextOrdinal(), tabId: previous?.tabId,
      payload: { repo: scope.repo, ...scope.binding, gatewayBindingVersion: 1, workflows: retained?.payload.workflows ?? [],
        catalogRequest: { id: randomUuid(), owner: login, state: "pending" } } }
    const saved = store.dispatch({ type: "card.upsert", actor: ctx.commandActor, card }).isPersisted.promise
    shared.saving.set(id, saved)
    try { await saved } catch { return "The catalog request could not be saved. Try again." }
    finally { if (shared.saving.get(id) === saved) shared.saving.delete(id) }
    if (!current()) return "The account changed. Open Flows again."
    void read(card)
    return { value: "Flows requested." }
  }
  const resume = () => {
    const login = owner(), epoch = ctx.accountEpoch
    if (!login || ctx.disposed) return
    const timer = setTimeout(() => {
      void (store.settled?.() ?? Promise.resolve()).then(() => {
        if (ctx.disposed || ctx.accountEpoch !== epoch || owner() !== login) return
        for (const card of store.collections.cards.values()) {
          if (card.kind === "workflow-list" && card.payload.catalogRequest?.state === "pending" && card.payload.catalogRequest.owner === login) void read(card)
        }
      }, () => {})
    }, 0)
    ctx.unref(timer)
  }
  return { list, resume }
}
