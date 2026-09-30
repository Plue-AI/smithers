import { createCollection, localOnlyCollectionOptions } from "@tanstack/db"
import type { Card } from "./AppState"

type RepositoryUpdate = Extract<Card, { kind: "repo-update" }>
const updates = (cards: ReadonlyArray<Card>): ReadonlyArray<RepositoryUpdate> =>
  cards.filter((card): card is RepositoryUpdate => card.kind === "repo-update")

/** Last committed activity bodies in the public cards' scope; workspace/runtime joins do not decorate them. */
export const createSavedRepositoryUpdates = (cards: ReadonlyArray<Card>) => {
  const collection = createCollection(localOnlyCollectionOptions({
    id: "app-saved-repository-updates", getKey: (card: RepositoryUpdate) => card.id,
    initialData: updates(cards).map(card => structuredClone(card))
  }))
  let previous = cards
  const publish = (values: ReadonlyArray<Card>): void => {
    if (values === previous) return
    const next = new Map(updates(values).map(card => [card.id, card]))
    const removed = [...collection.keys()].filter(id => !next.has(id))
    if (removed.length > 0) collection.delete(removed)
    for (const [id, card] of next) {
      const current = collection.get(id)
      if (JSON.stringify(current) === JSON.stringify(card)) continue
      if (current === undefined) collection.insert(structuredClone(card))
      else collection.update(id, draft => {
        for (const field of Object.keys(draft)) if (!Object.hasOwn(card, field)) delete (draft as Record<string, unknown>)[field]
        Object.assign(draft, structuredClone(card))
      })
    }
    previous = values
  }
  return { collection, publish }
}
