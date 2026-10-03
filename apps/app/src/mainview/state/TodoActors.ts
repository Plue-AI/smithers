import { toActor, type ActorContext, type ProductActor } from "./ProductActor"
import type { Actor } from "@smthrs/rpc/CardPrimitives"

/** Normalize the S1 TODO author fields before the shared projection schema decodes them. */
export const todoActors = (value: unknown, context: ActorContext = {}): unknown => {
  if (!value || typeof value !== "object") return value
  const model = value as Record<string, unknown>
  const actor = (wire: unknown) => toActor(wire as ProductActor | Actor, context.roster, context.runs, context.sessions)
  const authored = (value: unknown) => {
    if (!value || typeof value !== "object") return value
    const row = value as Record<string, unknown>
    return row.by === undefined ? row : { ...row, by: actor(row.by) }
  }
  const rows = (value: unknown) => Array.isArray(value) ? value.map(authored) : value
  return { ...model, prompt_revisions: rows(model.prompt_revisions), steers: rows(model.steers), waits: rows(model.waits),
    ...(model.first_answer ? { first_answer: authored(model.first_answer) } : {}),
    ...(Array.isArray(model.present) ? { present: model.present.map(actor) } : {}) }
}
