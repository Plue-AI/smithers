import { createCollection, localOnlyCollectionOptions } from "@tanstack/db"
import type { Message } from "./AppState"

/** A disposable view of journal receipts, rebuilt from committed state on every open. */
export const createSavedSignInPrompts = (messages: ReadonlyArray<Message>) => {
  const rows = (values: ReadonlyArray<Message>) => values.filter(message => message.action?.flow === "sign-in").map(({ id }) => ({ id }))
  const collection = createCollection(localOnlyCollectionOptions({ id: "app-saved-sign-in-prompts", getKey: (row: { id: string }) => row.id, initialData: rows(messages) }))
  let previous = messages
  const publish = (values: ReadonlyArray<Message>): void => {
    if (values === previous) return
    previous = values
    const next = new Set(rows(values).map(row => row.id))
    const removed = [...collection.keys()].filter(id => !next.has(id))
    if (removed.length > 0) collection.delete(removed)
    for (const id of next) if (!collection.has(id)) collection.insert({ id })
  }
  return { collection, publish }
}
