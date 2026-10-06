import type { ContextItem } from "@smthrs/rpc/CardPrimitives"
import { cardActions, type CardActionDefinition, type CardCommandDispatch } from "./cardActions"

/** Providers decide which pinned refs can open; absent providers expose no action. */
export const contextActions = (
  items: readonly ContextItem[],
  dispatch: CardCommandDispatch,
  actionFor: (item: ContextItem) => CardActionDefinition | undefined
) => {
  const definitions = items.map(actionFor)
  const bindings = cardActions(dispatch, definitions.flatMap((definition, index) =>
    definition === undefined ? [] : [{ ...definition, scope: String(index) }]))
  return {
    openActions: definitions.map((definition, index) => definition === undefined ? undefined : {
      ...bindings.forScope(String(index)).actions[0]!, args: { index: String(index) }
    }),
    onAction: (tag: Parameters<typeof bindings.onAction>[0], input?: Record<string, string>) => {
      const index = input?.index
      if (index === undefined) return
      bindings.forScope(index).onAction(tag)
    }
  }
}
