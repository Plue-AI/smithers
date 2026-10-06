import { TOAST_SUPERSEDED } from "./failures"
import { randomUuid } from "../../runtime/RandomUuid"
import type { SharedPrompt } from "../AppState"
import type { ControllerContext } from "./context"
import { SharedConversationSchema, type SharedConversationSeam } from "../seams/SharedConversationSeam"
import { z } from "zod"

const Admission = z.object({ turnId: z.string().min(1), terminal: z.boolean() })

/** Browser owns only admission receipts. The existing host dispatcher owns execution. */
export function createSharedPrompts(ctx: ControllerContext, source: SharedConversationSeam) {
  const pending = new Set<string>(), waking = new Set<() => void>()
  const branch = () => {
    const navigation = ctx.store.session().branchNavigation
    return navigation?.owner === ctx.accountOwner() ? navigation?.selected_branch ?? "main" : "main"
  }
  const url = (at: string) => `${ctx.baseUrl}/api/conversations/${encodeURIComponent(at)}`
  const save = (request: SharedPrompt, clearDraft = false) => ctx.store.dispatch({ type: "conversation.prompt.changed", actor: "user", request, clearDraft }).isPersisted.promise
  const pause = () => new Promise<void>(resolve => {
    const done = () => { clearTimeout(timer); waking.delete(done); resolve() }
    const timer = setTimeout(done, 500); ctx.unref(timer); waking.add(done)
  })
  const request = async (path: string, method: string, body?: unknown) => {
    const response = await ctx.boundedFetch(path, { method, credentials: "same-origin", headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    if (!response.ok) throw new Error(await ctx.errorMessageOf(response, "Prompt unavailable"))
    return response
  }
  const launch = (saved: SharedPrompt) => {
    if (pending.has(saved.id) || ctx.disposed || saved.owner !== ctx.accountOwner()) return
    pending.add(saved.id)
    const epoch = ctx.accountEpoch
    const current = () => !ctx.disposed && ctx.accountEpoch === epoch && ctx.accountOwner() === saved.owner
    void ctx.withToast(`prompt-${saved.id}`, "Prompt", "Prompt", async () => {
      let row = saved
      try {
        await ctx.store.settled?.()
        if (!current()) return
        while (current()) {
          const local = ctx.store.session().sharedPrompts?.find(item => item.id === row.id)
          if (local?.state === "cancelled") return TOAST_SUPERSEDED
          if (local?.state === "failed") throw new Error(local.error ?? "Prompt stopped")
          if (local?.state === "requested") row = local
        if (row.state === "requested") {
          const response = row.turnId
            ? await request(`${url(row.branch)}/turns/${encodeURIComponent(row.turnId)}`, "PATCH", { prompt: row.prompt })
            : await request(`${url(row.branch)}/prompt`, "POST", { prompt: row.prompt, idempotencyKey: row.id })
          const accepted = row.turnId ? { turnId: row.turnId } : Admission.parse(await response.json())
          if (!current()) return
          if (ctx.store.session().sharedPrompts?.find(item => item.id === row.id)?.state === "cancelled") return TOAST_SUPERSEDED
          row = { ...row, turnId: accepted.turnId, state: "accepted", error: undefined }
          await save(row)
        }
          const response = await request(url(row.branch), "GET")
          const conversation = SharedConversationSchema.parse(await response.json())
          if (!current()) return
          if (branch() === row.branch) await source.read()
          const turn = conversation.entries.find(entry => entry.id === row.turnId)
          if (ctx.store.session().sharedPrompts?.find(item => item.id === row.id)?.state === "requested") continue
          if (turn && ["completed", "failed", "cancelled", "uncertain"].includes(turn.state)) {
            if (turn.state !== "completed") throw new Error(turn.state === "cancelled" ? "Prompt stopped" : "Prompt failed")
            await save({ ...row, state: "completed" })
            return
          }
          await pause()
        }
      } catch (error) {
        if (!current()) return
        if (ctx.store.session().sharedPrompts?.find(item => item.id === row.id)?.state === "cancelled") return TOAST_SUPERSEDED
        const message = error instanceof Error ? error.message : "Prompt unavailable"
        await save({ ...row, state: "failed", error: message })
        throw new Error(message)
      }
    }, false, current).catch(error => ctx.failures.report("prompt.queue", error)).finally(() => pending.delete(saved.id))
  }
  const recover = () => {
    for (const row of ctx.store.session().sharedPrompts ?? []) if (row.state === "editing" || row.state === "requested" || row.state === "accepted") launch(row)
  }
  const submit = async (text: string, capturedDraft?: () => boolean): Promise<boolean> => {
    const owner = ctx.accountOwner(), at = branch(), prompt = text.trim()
    if (!owner || !prompt || at === "earlier" || ctx.store.collections.identitySessions.get("identity")?.state !== "signed-in") return false
    const previous = ctx.store.session().sharedPrompts?.find(row => row.owner === owner && row.branch === at && row.prompt === prompt && row.state === "requested")
    if (previous) { launch(previous); return true }
    const draftCurrent = capturedDraft ?? ctx.store.captureComposerDraft(text)
    const editing = ctx.store.session().sharedPrompts?.find(row => row.owner === owner && row.branch === at && row.state === "editing")
    const row: SharedPrompt = { id: editing?.id ?? randomUuid(), ...(editing?.turnId ? { turnId: editing.turnId } : {}), owner, branch: at, prompt, state: "requested" }
    await save(row, draftCurrent())
    launch(row)
    return true
  }
  const stop = () => {
    const login = ctx.store.collections.identitySessions.get("identity")?.login
    const turn = source.get().conversation?.entries.find(row => row.authorLogin === login && ["accepted", "running"].includes(row.state))
    if (!turn) return
    void ctx.withToast(`stop-${turn.id}`, "Stop", "Stop", async () => {
      await request(`${url(branch())}/turns/${encodeURIComponent(turn.id)}/stop`, "POST")
      await source.read()
    })
  }
  const remove = (id: string, edit = false) => {
    const row = source.get().queue?.find(row => row.id === id), at = branch(), owner = ctx.accountOwner(), epoch = ctx.accountEpoch
    if (!row || !owner) return
    const current = () => !ctx.disposed && ctx.accountOwner() === owner && ctx.accountEpoch === epoch && branch() === at
    if (edit) {
      const saved = ctx.store.session().sharedPrompts?.find(item => item.owner === owner && item.turnId === id)
      const editing: SharedPrompt = { id: saved?.id ?? randomUuid(), owner, branch: at, prompt: row.prompt, turnId: id, state: "editing" }
      return (async () => {
        for (const previous of ctx.store.session().sharedPrompts ?? []) if (previous.owner === owner && previous.branch === at && previous.state === "editing" && previous.id !== editing.id) await save({ ...previous, state: "accepted" })
        if (!current()) return
        await save(editing)
        if (current()) await ctx.store.dispatch({ type: "composer.changed", actor: "user", draft: row.prompt }).isPersisted.promise
      })()
    }
    return ctx.withToast(`queue-${id}`, "Queued prompt", "Queued prompt", async () => {
      await request(`${url(at)}/turns/${encodeURIComponent(id)}`, "DELETE")
      if (!current()) return
      const saved = ctx.store.session().sharedPrompts?.find(item => item.owner === owner && item.turnId === id)
      if (saved) await save({ ...saved, state: "cancelled", error: undefined })
      await source.read()
    }, false, current)
  }
  const retry = () => {
    const saved = ctx.store.session().sharedPrompts?.filter(row => row.owner === ctx.accountOwner() && row.branch === branch() && row.state === "failed").at(-1)
    if (!saved) return
    // A failed transport retries the same admission key; a committed terminal turn gets a fresh one.
    const next: SharedPrompt = { ...saved, id: saved.turnId ? randomUuid() : saved.id, turnId: undefined, state: "requested", error: undefined }
    void save(next).then(() => launch(next))
  }
  const sessions = ctx.store.collections.sessions.subscribeChanges(recover)
  const identities = ctx.store.collections.identitySessions.subscribeChanges(recover)
  ctx.onDispose(() => { sessions.unsubscribe(); identities.unsubscribe(); for (const wake of waking) wake() })
  recover()
  const restore = () => {
    const rows = [...(source.get().queue ?? [])], at = branch(), owner = ctx.accountOwner(), epoch = ctx.accountEpoch
    const current = () => !ctx.disposed && ctx.accountEpoch === epoch && ctx.accountOwner() === owner && branch() === at
    void ctx.withToast("queue-restore", "Queued prompts", "Queued prompts", async () => {
      for (const row of rows.reverse()) {
        await request(`${url(at)}/turns/${encodeURIComponent(row.id)}`, "DELETE")
        if (!current()) return
        const saved = ctx.store.session().sharedPrompts?.find(item => item.owner === owner && item.turnId === row.id)
        if (saved) await save({ ...saved, state: "cancelled", error: undefined })
        await ctx.store.dispatch({ type: "composer.changed", actor: "user", draft: [row.prompt, ctx.store.session().draft].filter(Boolean).join("\n") }).isPersisted.promise
      }
      await source.read()
    }, false, current)
  }
  return { submit, stop, remove, retry, restore }
}
