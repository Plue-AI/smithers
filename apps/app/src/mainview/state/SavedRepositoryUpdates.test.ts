import { expect, test } from "bun:test"
import type { Card } from "./AppState"
import { createSavedRepositoryUpdates } from "./SavedRepositoryUpdates"

const activity = (id: string, title: string, branch?: string): Extract<Card, { kind: "repo-update" }> => ({
  id, kind: "repo-update", title: "Activity", status: "active", createdAt: 1, ordinal: 1,
  payload: { repo: "owner/repo", scope: "anonymous", checkedAt: 1, summary: title,
    openIssues: 1, openPrs: 0, problems: [], ...(branch === undefined ? {} : { branch }),
    items: [{ id: "issue", version: "1", kind: "issue", number: 1, title, state: "open", tags: ["issue"], read: false }] }
})

test("the saved activity view owns its initial body and ignores other card families", async () => {
  const card = activity("activity", "Saved body", "main")
  const other: Card = { id: "other", kind: "status", title: "Other", status: "active", createdAt: 1, ordinal: 2, payload: { note: "Other body" } }
  const view = createSavedRepositoryUpdates([card, other])
  await view.collection.preload()
  try {
    expect(view.collection.size).toBe(1)
    card.payload.items[0]!.title = "Caller mutation"
    expect(view.collection.get(card.id)?.payload.items[0]!.title).toBe("Saved body")
    expect(view.collection.has(other.id)).toBe(false)
  } finally { await view.collection.cleanup() }
})

test("committed replacements preserve identity, replace optional fields, and remove retired bodies", async () => {
  const view = createSavedRepositoryUpdates([activity("activity", "First", "main")])
  await view.collection.preload()
  try {
    const revised = activity("activity", "Second")
    const next = [revised, activity("another", "Another")]
    view.publish(next)
    expect(view.collection.size).toBe(2)
    expect(view.collection.get("activity")?.payload.summary).toBe("Second")
    expect(view.collection.get("activity")?.payload.branch).toBeUndefined()
    view.publish(next)
    expect([...view.collection.values()].map(card => card.id).sort()).toEqual(["activity", "another"])
    view.publish([activity("another", "Remaining")])
    expect(view.collection.has("activity")).toBe(false)
    expect(view.collection.get("another")?.payload.summary).toBe("Remaining")
    view.publish([])
    expect(view.collection.size).toBe(0)
  } finally { await view.collection.cleanup() }
})
