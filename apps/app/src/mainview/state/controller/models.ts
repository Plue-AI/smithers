import { actorSharedState } from "../ActorBindings"
import { randomUuid } from "../../runtime/RandomUuid"
/** Resolve previously configured host model bindings without exposing a model laboratory. */
import type { ConfiguredModel, ModelBinding, SeatId } from "@smthrs/rpc/ConfiguredModel"
import { bindingOf, seatAccepts } from "@smthrs/rpc/ConfiguredModel"
import type { StoredModel } from "../AppState"
import type { AppStore } from "../AppStore"

/** The record alone, field by field: a live row also carries its last test and the collection's own sync metadata. */
const recordOf = (row: StoredModel): ConfiguredModel =>
  ({ id: row.id, ...bindingOf(row), ...(row.builtin === true ? { builtin: true } : {}) })

/** Every assignment a request may carry: the record still exists and is of the seat's kind. */
export const resolvedSeats = (
  store: Pick<AppStore, "collections">
): ReadonlyArray<{ readonly seat: SeatId; readonly model: ConfiguredModel }> =>
  [...store.collections.seats.values()].flatMap((row) => {
    const record = store.collections.models.get(row.recordId)
    return record === undefined || !seatAccepts(row.id, record.protocol) ? [] : [{ seat: row.id, model: recordOf(record) }]
  }).sort((left, right) => left.seat.localeCompare(right.seat))

/** What one seat's request carries; undefined leaves the host's default to answer. */
export const seatBinding = (store: Pick<AppStore, "collections">, seat: SeatId): ModelBinding | undefined => {
  const resolved = resolvedSeats(store).find((row) => row.seat === seat)
  return resolved === undefined ? undefined : bindingOf(resolved.model)
}


import { ModelBindingSchema } from "@smthrs/rpc/ConfiguredModel"
import type { ControllerContext } from "./context"

/** Owner assignments reuse the sealed install store, never browser-only seats. */
export const assignInstallAgentModel = async (ctx: ControllerContext, role: string, model: string): Promise<unknown> => {
 const epoch = ctx.accountEpoch
 if (ctx.commandActor !== "user") throw new Error("Owner access required")
 const url = `${ctx.baseUrl.replace(/\/$/, "")}/api/agents`
 const read = await ctx.http(url, { credentials: "same-origin" })
 if (!read.ok) throw new Error(await ctx.errorMessageOf(read, "Could not read agents"))
 const body = await read.json() as { canAssign?: boolean; roleBindings?: Record<string, unknown>; agents?: Array<{ id: string; binding?: unknown }> }
 if (!body.canAssign || epoch !== ctx.accountEpoch) throw new Error("Owner access required")
 const record = ctx.store.collections.models.get(model)
 const parsed = ModelBindingSchema.safeParse(record ? bindingOf(record) : body.roleBindings?.[role] ?? body.agents?.find(row => row.id === role)?.binding)
 if (!parsed.success) throw new Error("Choose model access first")
 const response = await ctx.http(`${url}/${encodeURIComponent(role)}/model`, {
  method: "PUT", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: { ...parsed.data, modelId: record?.modelId ?? model } })
 })
 if (!response.ok) throw new Error(await ctx.errorMessageOf(response, "Could not save model"))
 return response.json()
}

import { ConfiguredModelSchema, ModelTestResultSchema, MODEL_PROTOCOL_DEFAULTS, modelOriginOf, planModelBinding, type ModelProtocol } from "@smthrs/rpc/ConfiguredModel"
import type { FormsController } from "./forms"
export interface SaveModelInput { readonly name: string; readonly protocol: ModelProtocol; readonly modelId: string; readonly credential: string; readonly baseUrl?: string; readonly path?: string }

/** Assignment-only restoration. Records reuse the existing persisted model collection. */
export const createModelsController = (ctx: ControllerContext, deps: { readonly renderFlowForm: FormsController["renderFlowForm"]; readonly listAgents: (role?: string, model?: string) => Promise<string | void> }) => {
 const authorize = async () => {
  const epoch = ctx.accountEpoch
  if (ctx.commandActor !== "user") return false
  const response = await ctx.http(`${ctx.baseUrl.replace(/\/$/, "")}/api/agents`, { credentials: "same-origin" })
  return response.ok && (await response.json() as { canAssign?: boolean }).canAssign === true && epoch === ctx.accountEpoch
 }
 const openForm = (input?: SaveModelInput) => { deps.renderFlowForm({ name: "model.save", args: input ? JSON.stringify(input) : undefined, via: "user" }) }
 const newModel = async () => { if (!await authorize()) return "Owner access required"; openForm() }
 const editModel = async (id: string) => {
  if (!await authorize()) return "Owner access required"
  const model = ctx.store.collections.models.get(id)
  if (!model || model.builtin) return "Model unavailable"
  openForm({ name: model.id, ...bindingOf(model) })
 }
 const saveModel = async (input: SaveModelInput) => {
  if (!await authorize()) return "Owner access required"
  const parsed = ConfiguredModelSchema.safeParse({ id: input.name, protocol: input.protocol, modelId: input.modelId, credential: input.credential,
   ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}), ...(input.path ? { path: input.path } : {}) })
  if (!parsed.success || ctx.store.collections.models.get(input.name)?.builtin) return "Invalid model"
  const origin = modelOriginOf(parsed.data.baseUrl ?? MODEL_PROTOCOL_DEFAULTS[parsed.data.protocol].baseUrl)
  const planned = planModelBinding(bindingOf(parsed.data), [{ name: parsed.data.credential, present: true, origins: origin ? [origin] : [] }])
  if (!planned.ok && planned.failure.code === "invalid") return "Invalid model"
  await ctx.store.dispatch({ type: "model.saved", actor: "user", model: parsed.data }).isPersisted.promise
  await deps.listAgents()
 }
 const removeModel = async (id: string) => {
  if (!await authorize()) return "Owner access required"
  const model = ctx.store.collections.models.get(id)
  if (!model || model.builtin) return "Model unavailable"
  await ctx.store.dispatch({ type: "model.removed", actor: "user", id }).isPersisted.promise
 }
 const shared = actorSharedState(ctx, "model-tests", () => ({ pending: new Map<string, number>() }))
 const markTest = (id: string, pending: boolean, error?: string, request?: { requestId: string; model: ConfiguredModel }, keepRequest = false) => {
  const card = ctx.store.collections.cards.get("agents")
  if (card?.kind !== "agents" || !("agents" in card.payload)) return
  const testing = new Set(card.payload.testing ?? [])
  if (pending) testing.add(id); else testing.delete(id)
  const testRequests = { ...card.payload.testRequests }
  if (request) testRequests[id] = request
  if (!pending && !keepRequest) delete testRequests[id]
  return ctx.store.dispatch({ type: "card.upsert", actor: "system", card: { ...card, payload: { ...card.payload, testing: [...testing], testRequests, error } } }).isPersisted.promise
 }
 const testModel = async (id: string) => {
  if (ctx.commandActor !== "user") return "Owner access required"
  if (shared.pending.has(id) && shared.pending.get(id) === ctx.accountEpoch) return
  const card = ctx.store.collections.cards.get("agents")
  const recovered = card?.kind === "agents" && "agents" in card.payload ? card.payload.testRequests?.[id] : undefined
  const model = recovered?.model ?? ctx.store.collections.models.get(id)
  if (!model) { markTest(id, false, "Model unavailable"); return "Model unavailable" }
  const epoch = ctx.accountEpoch
  shared.pending.set(id, epoch)
  const request = recovered ?? { requestId: randomUuid(), model: recordOf(model) }
  await deps.listAgents()
  await markTest(id, true, undefined, request)
  void ctx.withToast(`model.test.${id}`, "Testing model", "Model tested", async () => {
   let error: string | undefined
   let finished = false
   try {
    if (!await authorize() || epoch !== ctx.accountEpoch) throw new Error("Owner access required")
    const response = await ctx.http(`${ctx.baseUrl.replace(/\/$/, "")}/api/model/test`, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requestId: request.requestId, model: request.model }) })
    if (!response.ok) throw new Error(await ctx.errorMessageOf(response, "Could not test model"))
    let result: unknown = await response.json()
    if (response.status === 202) {
     while (!ctx.disposed && epoch === ctx.accountEpoch) {
      const receipt = await ctx.http(`${ctx.baseUrl.replace(/\/$/, "")}/api/model/test/receipt?requestId=${encodeURIComponent(request.requestId)}`, { credentials: "same-origin" })
      if (!receipt.ok) throw new Error(await ctx.errorMessageOf(receipt, "Could not read model test"))
      const status = await receipt.json() as { state?: string; result?: unknown }
      if (status.state === "completed" || status.state === "failed") { result = status.result; break }
      if (status.state === "uncertain" || status.state === "cancelled") { finished = true; throw new Error("Model test interrupted") }
      await new Promise<void>(resolve => setTimeout(resolve, 500))
     }
     if (ctx.disposed || epoch !== ctx.accountEpoch) return true
    }
    const parsed = ModelTestResultSchema.safeParse(result)
    if (!parsed.success) throw new Error("Invalid model test")
    finished = true
    if (ctx.disposed || epoch !== ctx.accountEpoch) return true
    const current = ctx.store.collections.models.get(id)
    if (current && JSON.stringify(recordOf(current)) === JSON.stringify(recordOf(model)))
     await ctx.store.dispatch({ type: "model.tested", actor: "system", test: { id, testedAt: Date.now(), result: parsed.data } }).isPersisted.promise
    return parsed.data.ok ? true : "Model test failed"
   } catch (failure) { error = failure instanceof Error ? failure.message : "Could not test model"; return error }
   finally { if (shared.pending.get(id) === epoch) shared.pending.delete(id); if (!ctx.disposed && epoch === ctx.accountEpoch) markTest(id, false, error, undefined, !finished) }
  }, false, () => !ctx.disposed && epoch === ctx.accountEpoch, "agents")
 }
 const restoreTests = () => {
  if (ctx.disposed || ctx.commandActor !== "user") return
  const recovery = ctx.store.collections.cards.get("agents")
  if (recovery?.kind !== "agents" || !("agents" in recovery.payload)) return
  for (const id of recovery.payload.testing ?? []) {
   if (!recovery.payload.testRequests?.[id]) { void markTest(id, false, "Model test interrupted"); continue }
   if (!shared.pending.has(id)) void testModel(id)
  }
 }
 // Persisted cards may hydrate after controller construction. Reconnect when
 // the collection receives them, rather than relying on a one-time read.
 const stopRecovery = ctx.store.collections.cards.subscribeChanges?.(() => { queueMicrotask(restoreTests) })
 queueMicrotask(restoreTests)
 const stopAccount = ctx.onAccountChange?.(() => {
  const card = ctx.store.collections.cards.get("agents")
  if (card?.kind === "agents" && "agents" in card.payload && (card.payload.testing?.length || Object.keys(card.payload.testRequests ?? {}).length))
   ctx.store.dispatch({ type: "card.upsert", actor: "system", card: { ...card, payload: { ...card.payload, testing: [], testRequests: {} } } })
 })
 void ctx.onDispose(() => { stopAccount?.(); stopRecovery?.unsubscribe() })
 const showModel = async (id: string) => {
  if (!ctx.store.collections.models.has(id)) return "Model unavailable"
  await deps.listAgents(undefined, id)
 }
 return { newModel, editModel, saveModel, removeModel, testModel, showModel }
}
