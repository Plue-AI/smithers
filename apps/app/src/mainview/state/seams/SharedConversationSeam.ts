import { Data } from "effect"
import { z } from "zod"
import { AgentTurnFrameSchema } from "@smthrs/rpc/NativeAgent"
import { ContextItemSchema, ToneSchema, PlaceholderAvatarUrl } from "@smthrs/rpc/CardPrimitives"
import { ContextPreflightResultSchema } from "@smthrs/rpc/ContextPreflight"
import { MessageSchema } from "../AppState"
import type { ControllerContext } from "../controller/context"
import type { LiveTopics } from "../useTopic"

export class SharedConversationFailure extends Data.TaggedError("SharedConversationFailure")<{ readonly sentence: "Theme unavailable" | "Conversation unavailable" | "View unavailable" }> {
  override get message() { return this.sentence }
}

// Imports reuse the durable message decoder and cannot decode as executable turns.
const SharedTurnSchema = z.object({
  origin: z.literal("smithers").optional(),
  id: z.string(), title: z.string().optional(), tone: ToneSchema.optional(), author: z.number().int().positive(), authorLogin: z.string().min(1), runId: z.string(), prompt: z.string(),
  state: z.enum(["accepted", "running", "completed", "failed", "cancelled", "uncertain"]),
  frames: z.array(AgentTurnFrameSchema), context: z.array(ContextItemSchema).optional(), preflight: ContextPreflightResultSchema.optional()
}).strict()
// The journal projection carries adapter drafts, not persisted browser messages.
// Validate its trusted identity before mapping it through the shared message decoder.
const ImportedTurnSchema = z.object({
  id: z.string().min(1), origin: z.literal("external"), read_only: z.literal(true),
  agent: z.enum(["claude-code", "codex"]), source_format_version: z.string().min(1),
  source_id: z.string().min(1), source_offset: z.number().int().nonnegative(),
  session_id: z.string().min(1), participant_id: z.string().min(1),
  owner_id: z.string().min(1), author_id: z.string().min(1),
  author: z.number().int().positive(), authorLogin: z.string().min(1), authorName: z.string().optional(),
  kind: z.enum(["prompt", "assistant", "thinking", "attachment", "tool_request", "tool_result", "edit", "error"]),
  body: z.json(), call_id: z.string().min(1).optional(), failed: z.boolean().optional()
}).superRefine((entry, ctx) => {
  if (entry.owner_id !== String(entry.author) ||
    entry.author_id !== (entry.kind === "prompt" ? entry.owner_id : entry.participant_id) ||
    entry.source_format_version !== (entry.agent === "codex" ? "codex/0.160.0" : "claude-code/2.1.0")) {
    ctx.addIssue({ code: "custom", message: "Incomplete external conversation identity" })
  }
}).transform(entry => {
  const person = { name: entry.authorName || entry.authorLogin, login: entry.authorLogin, avatar_url: PlaceholderAvatarUrl }
  return MessageSchema.parse({
    id: entry.id, origin: "external", read_only: true, agent_kind: entry.agent,
    format_version: entry.source_format_version, source_id: entry.source_id,
    session_id: entry.session_id, participant_id: entry.participant_id,
    correlation_id: entry.call_id,
    actor: entry.kind === "prompt" ? { kind: "person", ...person, color_index: entry.author % 6 } : {
      kind: "agent", id: entry.participant_id, agent: entry.agent, session_id: entry.session_id,
      for_member: person, avatar_url: PlaceholderAvatarUrl, color_index: entry.author % 6
    },
    role: entry.kind === "prompt" ? "user" : "smithers",
    text: entry.kind === "thinking" ? "" : typeof entry.body === "string" ? entry.body : JSON.stringify(entry.body, null, 2),
    reasoning: entry.kind === "thinking" ? (typeof entry.body === "string" ? entry.body : JSON.stringify(entry.body, null, 2)) : undefined,
    act: entry.kind === "tool_request" ? "tool-pending" : undefined,
    status: entry.failed || entry.kind === "error" ? "failed" : "complete",
    createdAt: 0, ordinal: 0
  })
})
export const SharedConversationSchema = z.object({
  id: z.string(),
  entries: z.array(z.union([ImportedTurnSchema, MessageSchema.refine(message => message.origin === "external"), SharedTurnSchema]))
}).transform(conversation => ({ ...conversation, entries: conversation.entries.map((entry, ordinal) =>
  "role" in entry ? { ...entry, ordinal } : entry) }))
export type SharedConversation = z.infer<typeof SharedConversationSchema>
export const ConversationViewSchema = z.object({ instructions: z.array(z.object({ id: z.string(), command: z.literal("theme"), mode: z.enum(["light", "dark"]) })).default([]), scroll_anchor: z.string().optional(), card_view: z.record(z.string(), z.unknown()).optional(), last_seen_seq: z.number().int().nonnegative().optional(), toasts_hidden: z.boolean().optional(), timeline_visible_until: z.string().nullable().optional(), queue: z.array(z.object({ id: z.string(), prompt: z.string() })).default([]) }).passthrough()
export type ConversationView = z.infer<typeof ConversationViewSchema>
export interface ConversationSnapshot { readonly view?: ConversationView; readonly queue?: readonly { id: string; prompt: string }[]; readonly conversation?: SharedConversation; readonly error?: string }

/** Shared output stays outside browser history. Account/branch generations fence every read. */
export function createSharedConversationSeam(ctx: ControllerContext, live?: LiveTopics) {
  let snapshot: ConversationSnapshot = {}, generation = 0, disposed = false
  let key = "", branch = "main", stopLive: (() => void) | undefined
  let stopView: (() => void) | undefined
  let reading = false, again = false, viewRevision = 0
  let saving = Promise.resolve()
  const serializeView = (work: () => Promise<void>) => {
    const result = saving.then(work)
    saving = result.catch(() => {})
    return result
  }
  let scrollTimer: ReturnType<typeof setTimeout> | undefined
  const listeners = new Set<() => void>()
  const publish = (next: ConversationSnapshot) => { snapshot = next; for (const listener of listeners) listener() }
  const valid = (revision: number) => !disposed && !ctx.disposed && generation === revision
  const applying = new Set<string>()
  let uiWork = Promise.resolve()
  const applyInstructions = (view: ConversationView, revision: number) => {
    const owner = ctx.accountOwner(), at = branch
    if (!owner || !valid(revision)) return
    for (const instruction of view.instructions) {
      const id = JSON.stringify([owner, at, instruction.id])
      if (applying.has(id) || ctx.store.session().uiInstructionsSeen?.includes(id)) continue
      applying.add(id)
      uiWork = uiWork.then(async () => {
        if (!valid(revision)) return
        // The schema permits explicit theme assignments only. No tool payload,
        // arbitrary command, shared mutation or model continuation reaches this door.
        const outcome = await ctx.commands.submit({ name: "theme", payload: { mode: instruction.mode }, actor: "agent" })
        if (outcome.status !== "executed") throw new SharedConversationFailure({ sentence: "Theme unavailable" })
        await ctx.store.settled?.()
        if (valid(revision)) await ctx.store.dispatch({ type: "conversation.ui.applied", actor: "system", owner, id }).isPersisted.promise
      }).catch(error => { if (valid(revision)) ctx.failures.report("seam.failure", error, "conversation-ui") }).finally(() => applying.delete(id))
    }
  }
  const read = async () => {
    if (!key || disposed) return
    if (reading) { again = true; return }
    reading = true
    const revision = generation, at = branch, viewing = viewRevision
    try {
      const response = await ctx.boundedFetch(`${ctx.baseUrl}/api/conversations/${encodeURIComponent(at)}`, { credentials: "same-origin" })
      if (!response.ok) throw new SharedConversationFailure({ sentence: "Conversation unavailable" })
      const conversation = SharedConversationSchema.parse(await response.json())
      // The first view restores the transcript; publish its entries with it
      // so that restoration cannot unmount an already-open Context disclosure.
      const initial = snapshot.view === undefined
      if (!initial && valid(revision)) publish({ ...snapshot, conversation, error: undefined })
      const viewResponse = await ctx.boundedFetch(`${ctx.baseUrl}/api/conversations/${encodeURIComponent(at)}/view-state`, { credentials: "same-origin" })
      if (viewResponse.ok) {
        const view = ConversationViewSchema.parse(await viewResponse.json())
        if (valid(revision) && viewing === viewRevision) { publish({ ...snapshot, conversation, view, queue: view.queue, error: undefined }); applyInstructions(view, revision) }
        else if (initial) {
          await saving
          if (valid(revision)) publish({ ...snapshot, conversation, error: undefined })
        }
      } else if (initial && valid(revision)) publish({ ...snapshot, conversation, error: undefined })
    } catch { if (valid(revision)) publish({ error: "Conversation unavailable" }) }
    finally { reading = false; if (again) { again = false; void read() } }
  }
  const saveView = (patch: Partial<Pick<ConversationView, "scroll_anchor" | "card_view" | "last_seen_seq" | "toasts_hidden" | "timeline_visible_until">>) => {
    const revision = generation, at = branch
    if (!key || !valid(revision)) return Promise.resolve()
    ++viewRevision
    return serializeView(async () => {
      if (!valid(revision)) return
      const path = `${ctx.baseUrl}/api/conversations/${encodeURIComponent(at)}/view-state`
      const response = await ctx.boundedFetch(path, { credentials: "same-origin" })
      if (!response.ok) throw new SharedConversationFailure({ sentence: "View unavailable" })
      const { queue: _queue, instructions: _instructions, ...previous } = ConversationViewSchema.parse(await response.json())
      if (!valid(revision)) return
      const written = await ctx.boundedFetch(path, { method: "PUT", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...previous, ...patch }) })
      if (!written.ok) throw new SharedConversationFailure({ sentence: "View unavailable" })
      const view = ConversationViewSchema.parse(await written.json())
      if (valid(revision)) publish({ ...snapshot, view, queue: snapshot.queue, error: snapshot.error === "View unavailable" ? undefined : snapshot.error })
    }).catch(error => { if (valid(revision)) { publish({ ...snapshot, error: "View unavailable" }); ctx.failures.report("seam.failure", error, "conversation-view") } })
  }
  let timelineVisible = false
  let leaseTimer: ReturnType<typeof setTimeout> | undefined
  const renewTimeline = () => {
    if (leaseTimer !== undefined) clearTimeout(leaseTimer)
    leaseTimer = undefined
    if (disposed || !key) return
    const visible = timelineVisible && (typeof document === "undefined" || !document.hidden)
    void saveView({ timeline_visible_until: visible ? new Date(Date.now() + 30_000).toISOString() : null })
    if (visible) {
      leaseTimer = setTimeout(renewTimeline, 15_000)
      ctx.unref(leaseTimer)
    }
  }
  const setTimelineVisible = (visible: boolean) => {
    if (timelineVisible === visible) return
    timelineVisible = visible
    renewTimeline()
  }
  const visibilityChanged = () => { if (timelineVisible) renewTimeline() }
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", visibilityChanged)
  const rememberScroll = (anchor: string) => {
    if (scrollTimer !== undefined) clearTimeout(scrollTimer)
    const revision = generation
    scrollTimer = setTimeout(() => { scrollTimer = undefined; if (valid(revision)) void saveView({ scroll_anchor: anchor }) }, 200)
    ctx.unref(scrollTimer)
  }
  const change = () => {
    const owner = ctx.accountOwner(), navigation = ctx.store.session().branchNavigation
    const nextBranch = navigation && navigation.owner === owner ? navigation.selected_branch : "main"
    const identity = ctx.store.collections.identitySessions.get("identity")
    const next = identity?.state === "signed-in" && owner && nextBranch !== "earlier" ? JSON.stringify([owner, ctx.accountEpoch, nextBranch]) : ""
    if (next === key) return
    if (scrollTimer !== undefined) clearTimeout(scrollTimer)
    scrollTimer = undefined
    key = next; branch = nextBranch; ++generation; ++viewRevision; stopLive?.(); stopView?.(); stopLive = undefined; stopView = undefined; publish({})
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
    if (timelineVisible) renewTimeline()
  }
  const sessions = ctx.store.collections.sessions.subscribeChanges(change)
  const identities = ctx.store.collections.identitySessions.subscribeChanges(change)
  const stopAccount = ctx.onAccountChange(change)
  const dispose = () => { if (typeof document !== "undefined") document.removeEventListener("visibilitychange", visibilityChanged); if (leaseTimer !== undefined) clearTimeout(leaseTimer); if (scrollTimer !== undefined) clearTimeout(scrollTimer); disposed = true; ++generation; stopLive?.(); stopView?.(); sessions.unsubscribe(); identities.unsubscribe(); stopAccount(); listeners.clear() }
  ctx.onDispose(dispose)
  change()
  return { get: () => snapshot, subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }, read, saveView, serializeView, setTimelineVisible, rememberScroll, dispose }
}
export type SharedConversationSeam = ReturnType<typeof createSharedConversationSeam>
