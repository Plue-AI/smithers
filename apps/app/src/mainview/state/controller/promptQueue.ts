import * as Queue from "@smthrs/rpc/PromptQueue"
import { parseSubmit } from "../../flows/registry"
import { promptQueueScope } from "../PromptQueue"
import type { ControllerContext } from "./context"
import type { TurnController } from "./turns"
import { randomUuid } from "../../runtime/RandomUuid"

export const createPromptQueueController = (ctx: ControllerContext, send: TurnController["send"]) => {
  const { store } = ctx
  let draining = false
  let scheduled = false
  let disposed = false
  const current = () => Queue.inScope(store.session().queuedPrompts ?? [], promptQueueScope(store.session()))
  const pause = (paused: boolean, actor: "user" | "system") =>
    store.dispatch({ type: "prompt.queue.paused", actor, paused }).isPersisted.promise

  const drain = async (): Promise<void> => {
    if (draining || disposed || ctx.disposed) return
    draining = true
    let failed = false
    try {
      // Never submit an optimistic queue entry or race a terminal receipt.
      await store.settled?.()
      if (disposed || ctx.disposed || store.session().phase !== "idle" || ctx.activeTurn || store.session().promptQueuePaused) return
      const prompt = Queue.next(store.session().queuedPrompts ?? [], promptQueueScope(store.session()))
      if (!prompt) return
      // message.submitted consumes this id in the same transaction that records
      // the user bubble. The turn adapter waits for that receipt before launch.
      const admitted = await send(prompt.text, { turnId: prompt.id, owner: ctx.accountOwner() })
      if (admitted !== true && !disposed && !ctx.disposed && current().some(item => item.id === prompt.id)) await pause(true, "system")
    } catch (error) {
      failed = true
      ctx.failures.report("prompt.queue", error)
      if (!disposed && !ctx.disposed) await pause(true, "system").catch(() => {})
    } finally {
      draining = false
      if (!disposed && !ctx.disposed && !failed && !ctx.activeTurn && !store.session().promptQueuePaused && current().length > 0) schedule()
    }
  }
  const schedule = () => {
    if (scheduled || draining || disposed || ctx.disposed || store.session().phase !== "idle" || store.session().promptQueuePaused) return
    scheduled = true
    queueMicrotask(() => { scheduled = false; void drain() })
  }
  const enqueuePrompt = (text: string, capturedDraft?: () => boolean): void => {
    const draftCurrent = capturedDraft ?? store.captureComposerDraft(text)
    const parsed = parseSubmit(text, ctx.commands.all())
    // Commands keep their normal immediate door, as in the terminal composer.
    if (parsed.kind !== "prompt") { void send(text, undefined, draftCurrent); return }
    const prompt = { id: randomUuid(), text: parsed.text, scope: promptQueueScope(store.session()) }
    void store.dispatch({ type: "prompt.queued", actor: "user", prompt, preserveDraft: !draftCurrent() }).isPersisted.promise.then(schedule)
      .catch(error => ctx.failures.report("prompt.queue", error))
  }
  const removeQueuedPrompt = (id: string, edit = false): void => {
    if (!current().some(item => item.id === id)) return
    store.dispatch({ type: "prompt.removed", actor: "user", id, edit })
  }
  const restoreQueuedPrompts = (): void => {
    // Reverse removal prepends each item, preserving FIFO above the existing draft.
    for (const item of [...current()].reverse()) removeQueuedPrompt(item.id, true)
  }
  const resumePromptQueue = (): void => { void pause(false, "user").then(schedule).catch(error => ctx.failures.report("prompt.queue", error)) }
  const subscribe = (): void => {
    const subscription = store.collections.sessions.subscribeChanges(schedule)
    ctx.onDispose(() => { disposed = true; subscription.unsubscribe() })
    schedule()
  }
  return { enqueuePrompt, removeQueuedPrompt, restoreQueuedPrompts, resumePromptQueue, subscribe }
}
