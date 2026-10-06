import { ProposalCardSchema } from "@smthrs/rpc/ProposalCard"
import type { Card } from "@smthrs/rpc/Cards"
import { actorSharedState } from "../ActorBindings"
import { readErrorMessage, unreachableSentence, type SeamContext } from "./SeamContext"

type ProposalEntry = Extract<Card, { kind: "proposal" }>
/** The server owns note resolution and TODO admission. Requests survive reload;
 * a replay uses the same note, whose accepted TODO is stored transactionally. */
export const createProposalSeam = (ctx: SeamContext) => {
  const shared = actorSharedState(ctx, "proposals", () => ({ sending: new Set<string>(), requesting: new Set<string>(), loading: new Set<string>() }))
  const identity = () => ctx.store.collections.identitySessions.get("identity")
  const entry = (id: string): ProposalEntry | undefined => {
    const row = ctx.store.collections.cards.get(`proposal:${id}`)
    return row?.kind === "proposal" ? row : undefined
  }
  const save = async (card: ProposalEntry) => {
    await ctx.dispatch({ type: "card.upsert", actor: ctx.actor(), card }).isPersisted.promise
  }
  const read = (id: string) => {
    const card = entry(id), load = card?.payload.load, principal = identity()
    if (!card || load?.state !== "pending" || principal?.state !== "signed-in" || principal.login !== load.owner) return
    const revision = principal.ownerRevision ?? principal.revision
    const key = JSON.stringify([id, principal.login, revision])
    if (shared.loading.has(key)) return
    const current = () => !ctx.isDisposed?.() && identity()?.state === "signed-in" && identity()?.login === load.owner
      && (identity()?.ownerRevision ?? identity()?.revision) === revision
    const pending = () => current() && entry(id)?.payload.load?.state === "pending" && entry(id)?.payload.load?.owner === load.owner
    shared.loading.add(key)
    const work = async (): Promise<void | string> => {
      let error: string | undefined
      try {
        const response = await ctx.http(`${ctx.baseUrl.replace(/\/$/, "")}/api/proposals`, { credentials: "include" })
        if (!pending()) return
        if (!response.ok) error = await readErrorMessage(response, "Could not open the proposal.")
        else {
          const rows: unknown = await response.json()
          const model = Array.isArray(rows) ? rows.map(row => ProposalCardSchema.safeParse(row)).find(row => row.success && row.data.id === id) : undefined
          if (!model?.success) error = "Proposal not found."
          else if (pending()) {
            const latest = entry(id)
            if (latest) await save({ ...latest, title: model.data.title, status: "active", payload: { ...latest.payload, model: model.data, load: undefined } })
          }
        }
      } catch (cause) { error = unreachableSentence("proposals", cause) }
      if (error && pending()) {
        const latest = entry(id)
        if (latest) await save({ ...latest, status: "error", payload: { ...latest.payload, load: { ...load, state: "failed", error } } })
        return error
      }
    }
    const run = ctx.withToast ? ctx.withToast(`proposal.read.${id}`, card.title, "Opened", work, false, current, card.id) : work()
    void run.catch(cause => ctx.report?.("proposal.read", cause)).finally(() => shared.loading.delete(key))
  }
  const send = (id: string) => {
    const card = entry(id), request = card?.payload.request, principal = identity()
    if (!card || !request || request.state !== "pending"
      || principal?.state !== "signed-in" || principal.login !== request.owner) return
    const revision = principal.ownerRevision ?? principal.revision
    const key = JSON.stringify([id, principal.login, revision])
    if (shared.sending.has(key)) return
    const current = () => !ctx.isDisposed?.() && identity()?.state === "signed-in"
      && identity()?.login === request.owner && (identity()?.ownerRevision ?? identity()?.revision) === revision
    shared.sending.add(key)
    const work = async (): Promise<void | string> => {
      let error: string | undefined
      try {
        const response = await ctx.http(`${ctx.baseUrl.replace(/\/$/, "")}/api/proposals/${encodeURIComponent(id)}/${request.action}`, {
          method: "POST", credentials: "include", headers: { "Content-Type": "application/json",
            ...(ctx.actor() === "smithers" ? { "Smithers-Via": "smithers" } : {}) }, body: "{}"
        })
        if (!current()) return
        if (!response.ok) error = await readErrorMessage(response, "Could not resolve the proposal.")
        else {
          const model = ProposalCardSchema.safeParse(await response.json())
          if (!model.success || model.data.id !== id || model.data.state !== (request.action === "accept" ? "accepted" : "dismissed")
            || request.action === "accept" && !model.data.todo) error = "Proposal resolution was not confirmed."
          else if (current()) {
            const latest = entry(id)
            if (latest) await save({ ...latest, status: "active", payload: { ...latest.payload, model: model.data, request: undefined, load: undefined } })
          }
        }
      } catch (cause) { error = unreachableSentence("proposals", cause) }
      if (error && current()) {
        const latest = entry(id)
        if (latest) await save({ ...latest, status: "error", payload: { ...latest.payload,
          request: { ...request, state: "failed", error } } })
        return error
      }
    }
    const run = ctx.withToast ? ctx.withToast(`proposal.${id}`, card.title,
      request.action === "accept" ? "TODO made" : "Dismissed", work, false, current, card.id) : work()
    void run.catch(cause => ctx.report?.("proposal.resolve", cause)).finally(() => shared.sending.delete(key))
  }
  return {
    openProposal: async (id: string): Promise<string | { readonly value: string }> => {
      const principal = identity()
      if (principal?.state !== "signed-in" || !principal.login) return "Sign in to open proposals."
      if (!id.trim()) return "Proposal not found."
      const old = entry(id)
      if (old?.payload.load?.state === "pending") { read(id); return { value: "Requested" } }
      const card: ProposalEntry = old ?? { id: `proposal:${id}`, kind: "proposal", title: "Proposal", status: "active", ordinal: ctx.nextOrdinal(), createdAt: Date.now(), payload: { id } }
      await save({ ...card, status: "active", payload: { ...card.payload, load: { owner: principal.login, state: "pending" } } })
      read(id)
      return { value: "Requested" }
    },
    resolveProposal: async (id: string, action: "accept" | "dismiss"): Promise<string | { readonly value: string }> => {
      const principal = identity()
      if (principal?.state !== "signed-in" || !principal.login) return "Sign in to resolve proposals."
      if (!id.trim()) return "Proposal not found."
      const key = JSON.stringify([id, principal.login, principal.ownerRevision ?? principal.revision])
      if (shared.requesting.has(key)) return { value: "Requested" }
      const old = entry(id)
      if (old?.payload.request?.state === "pending") return old.payload.request.owner === principal.login
        ? { value: "Requested" } as const : "Not your request."
      const card: ProposalEntry = old ?? { id: `proposal:${id}`, kind: "proposal", title: "Proposal", status: "active",
        ordinal: ctx.nextOrdinal(), createdAt: Date.now(), payload: { id } }
      shared.requesting.add(key)
      try {
        await save({ ...card, status: "active", payload: { ...card.payload,
          request: { action, owner: principal.login, state: "pending" } } })
        send(id)
        return { value: "Requested" } as const
      } finally { shared.requesting.delete(key) }
    },
    resumeProposals: () => {
      for (const row of ctx.store.collections.cards.values()) if (row.kind === "proposal") { read(row.payload.id); send(row.payload.id) }
    }
  }
}
export type ProposalSeam = ReturnType<typeof createProposalSeam>
