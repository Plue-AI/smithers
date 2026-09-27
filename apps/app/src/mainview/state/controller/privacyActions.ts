import { createCollection, localOnlyCollectionOptions } from "@tanstack/db"
import { z } from "zod"
import { ToastSchema } from "../AppState"
import { actorSharedState } from "../ActorBindings"
import type { ControllerContext } from "./context"
import type { CommandLifecycle } from "../../flows/CommandLifecycle"

export const PRIVACY_WRITE_PENDING = "Account cleanup is running. Try again in a moment."
export const PRIVACY_WRITE_FAILED = "Account cleanup failed. Reload to retry."
const id = "toast-privacy-write"

/**
 * A refusal cannot use the journal whose privacy barrier refused the action.
 * Only this content-free notice lives outside durable state. No command or
 * input is queued, acknowledged as saved, or replayed into another account.
 */
export const createPrivacyActions = (ctx: ControllerContext) => actorSharedState(ctx, "privacy.actions", () => {
  const notices = createCollection(localOnlyCollectionOptions({
    id: `privacy-actions-${crypto.randomUUID()}`,
    schema: ToastSchema.extend({ actor: z.enum(["user", "smithers", "system"]), revision: z.number() }),
    getKey: row => row.id,
  }))
  let revision = 0
  ctx.onDispose(() => notices.cleanup())
  const clear = () => { if (notices.has(id)) notices.delete(id) }
  const refuse = (actor: "user" | "smithers" | "system"): string | undefined => {
    const state = ctx.store.privacyWriteState()
    if (ctx.disposed) return state === "failed" ? PRIVACY_WRITE_FAILED : undefined
    // A later background action is not an acknowledgment of the refused act.
    // Keep its content-free failure visible until the human dismisses it.
    if (state === "ready") return undefined
    const detail = state === "failed" ? PRIVACY_WRITE_FAILED : PRIVACY_WRITE_PENDING
    const notice = { id, key: "privacy-write", title: "Not saved", detail, status: "failed" as const,
      createdAt: notices.get(id)?.createdAt ?? Date.now(), updatedAt: Date.now(), actor, revision: ++revision }
    if (notices.has(id)) notices.update(id, draft => { Object.assign(draft, notice) })
    else notices.insert(notice)
    return detail
  }
  const before: NonNullable<CommandLifecycle["before"]> = (request, args, named) => {
    // Dismissing this local notice must remain possible while durable command
    // admission is blocked. It has no application effect or private payload.
    if (!ctx.disposed && request.actor === "user" && request.name === "toast.dismiss" && (named?.toastId ?? args?.trim()) === id) {
      clear()
      return { status: "executed" }
    }
    const error = refuse(request.actor)
    return error === undefined ? undefined : { status: "failed", error, persistenceFailed: true, writeRefused: true }
  }
  return { notices, refuse, before }
})
