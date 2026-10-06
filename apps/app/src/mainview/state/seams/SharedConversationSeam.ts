import { z } from "zod"
import { AgentTurnFrameSchema } from "@smthrs/rpc/NativeAgent"
import { ContextItemSchema } from "@smthrs/rpc/CardPrimitives"
import type { ControllerContext } from "../controller/context"
import type { LiveTopics } from "../useTopic"

export const SharedConversationSchema = z.object({ id: z.string(), entries: z.array(z.object({
  id: z.string(), author: z.number().int().positive(), authorLogin: z.string().min(1), runId: z.string(), prompt: z.string(),
  state: z.enum(["accepted", "running", "completed", "failed", "cancelled", "uncertain"]),
  frames: z.array(AgentTurnFrameSchema), context: z.array(ContextItemSchema).optional()
})) })
export type SharedConversation = z.infer<typeof SharedConversationSchema>
export const ConversationViewSchema = z.object({ queue: z.array(z.object({ id: z.string(), prompt: z.string() })).default([]) })
export interface ConversationSnapshot { readonly queue?: readonly { id: string; prompt: string }[]; readonly conversation?: SharedConversation; readonly error?: string }

/** Shared output stays outside browser history. Account/branch generations fence every read. */
export function createSharedConversationSeam(ctx: ControllerContext, live?: LiveTopics) {
  let snapshot: ConversationSnapshot = {}, generation = 0, disposed = false
  let key = "", branch = "main", stopLive: (() => void) | undefined
  let stopView: (() => void) | undefined
  let reading = false, again = false
  const listeners = new Set<() => void>()
  const publish = (next: ConversationSnapshot) => { snapshot = next; for (const listener of listeners) listener() }
  const valid = (revision: number) => !disposed && !ctx.disposed && generation === revision
  const read = async () => {
    if (!key || disposed) return
    if (reading) { again = true; return }
    reading = true
    const revision = generation, at = branch
    try {
      const response = await ctx.boundedFetch(`${ctx.baseUrl}/api/conversations/${encodeURIComponent(at)}`, { credentials: "same-origin" })
      if (!response.ok) throw new Error("Conversation unavailable")
      const conversation = SharedConversationSchema.parse(await response.json())
      if (valid(revision)) publish({ ...snapshot, conversation })
      const viewResponse = await ctx.boundedFetch(`${ctx.baseUrl}/api/conversations/${encodeURIComponent(at)}/view-state`, { credentials: "same-origin" })
      if (viewResponse.ok) {
        const view = ConversationViewSchema.parse(await viewResponse.json())
        if (valid(revision)) publish({ ...snapshot, queue: view.queue })
      }
    } catch { if (valid(revision)) publish({ error: "Conversation unavailable" }) }
    finally { reading = false; if (again) { again = false; void read() } }
  }
  const change = () => {
    const owner = ctx.accountOwner(), navigation = ctx.store.session().branchNavigation
    const nextBranch = navigation && navigation.owner === owner ? navigation.selected_branch : "main"
    const identity = ctx.store.collections.identitySessions.get("identity")
    const next = identity?.state === "signed-in" && owner && nextBranch !== "earlier" ? JSON.stringify([owner, ctx.accountEpoch, nextBranch]) : ""
    if (next === key) return
    key = next; branch = nextBranch; ++generation; stopLive?.(); stopView?.(); stopLive = undefined; stopView = undefined; publish({})
    if (!key) return
    // The HTTP response and authorized topic use the same SharedEntries projection.
    // Topic invalidations trigger a fresh bounded read, including reconnects.
    stopLive = live?.subscribe(`conversation:${branch}`, () => {
      const topic = live.getSnapshot(`conversation:${branch}`)
      if (topic?.error) { ++generation; publish({ error: "Conversation unavailable" }); return }
      void read()
    })
    if (identity?.memberId) stopView = live?.subscribe(`view:${identity.memberId}:${branch}`, () => { void read() })
    void read()
  }
  const sessions = ctx.store.collections.sessions.subscribeChanges(change)
  const identities = ctx.store.collections.identitySessions.subscribeChanges(change)
  const stopAccount = ctx.onAccountChange(change)
  const dispose = () => { disposed = true; ++generation; stopLive?.(); stopView?.(); sessions.unsubscribe(); identities.unsubscribe(); stopAccount(); listeners.clear() }
  ctx.onDispose(dispose)
  change()
  return { get: () => snapshot, subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }, read, dispose }
}
export type SharedConversationSeam = ReturnType<typeof createSharedConversationSeam>
