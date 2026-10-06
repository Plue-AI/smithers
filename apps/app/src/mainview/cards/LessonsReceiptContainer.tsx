import type { ComponentType } from "react"
import { LessonsReceiptSchema, type LessonsReceiptViewProps } from "@smthrs/rpc/ProposalCard"
import type { CatalogTag } from "@smthrs/rpc/CardAction"
import { cardActions, type CardActionDefinition, type CardCommandDispatch } from "../flows/cardActions"
import { LessonsReceiptView } from "./views/ProposalView"

/** Receipt refs are data. Only the named wiki/proposal subjects become gestures. */
export const LessonsReceiptContainer = ({ model: source, dispatch, allowed, View = LessonsReceiptView }: {
  readonly model: unknown
  readonly dispatch: CardCommandDispatch
  readonly allowed?: ReadonlySet<CatalogTag>
  readonly View?: ComponentType<LessonsReceiptViewProps>
}) => {
  const parsed = LessonsReceiptSchema.safeParse(source)
  if (!parsed.success) return null
  const definitions: CardActionDefinition<CatalogTag, string>[] = []
  const seen = new Set<string>()
  for (const lesson of parsed.data.lessons) {
    if (seen.has(lesson.ref)) continue
    seen.add(lesson.ref)
    const colon = lesson.ref.indexOf(":")
    if (colon < 0) continue
    const kind = lesson.ref.slice(0, colon), id = lesson.ref.slice(colon + 1)
    if (!id.trim()) continue
    if (kind === "wiki" && (!allowed || allowed.has("wiki.page"))) definitions.push({ tag: "wiki.page", label: lesson.title, gesture: lesson.ref, args: { name: id }, command_input: { name: id } })
    if (kind === "proposal" && (!allowed || allowed.has("proposal"))) definitions.push({ tag: "proposal", label: lesson.title, gesture: lesson.ref, args: { id }, command_input: { id } })
  }
  const bindings = cardActions<string>(dispatch, definitions)
  return <View model={parsed.data} actions={bindings.actions} gestures={bindings.gestures} onAction={bindings.onAction} view={{ maximized: false }} onView={() => {}} />
}
