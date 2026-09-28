import { describe, expect, test } from "vitest"
import { enqueue, inScope, next, remove, restoreDraft } from "../src/PromptQueue.ts"

describe("prompt queue", () => {
  const first = { id: "first", text: "First request", scope: "conversation-a", source: "composer" }
  const second = { id: "second", text: "Second request", scope: "conversation-b", source: "terminal" }

  test("admits trimmed requests in order without changing existing entries", () => {
    const original = [first]
    const admitted = enqueue(original, {
      id: "third",
      text: "  First request\n",
      scope: "conversation-a",
      source: "composer"
    })

    expect(admitted).toEqual([
      first,
      { id: "third", text: "First request", scope: "conversation-a", source: "composer" }
    ])
    expect(admitted).not.toBe(original)
    expect(admitted[0]).toBe(first)
    expect(original).toEqual([first])
  })

  test("rejects blank text and duplicate identities without replacing a queued request", () => {
    const original = [first]
    expect(enqueue(original, { id: "blank", text: " \n\t ", scope: "conversation-b", source: "terminal" })).toBe(
      original
    )
    expect(enqueue(original, { id: "first", text: "Changed request", scope: "conversation-b", source: "terminal" }))
      .toBe(original)
    expect(original).toEqual([first])
  })

  test("removes only the matching identity and keeps remaining order and metadata", () => {
    const original = [first, second, {
      id: "third",
      text: "Third request",
      scope: "conversation-a",
      source: "composer"
    }]
    expect(remove(original, "second")).toEqual([first, original[2]])
    expect(remove(original, "missing")).toEqual(original)
    expect(original).toHaveLength(3)
  })

  test("keeps conversation membership fixed and chooses its oldest request", () => {
    const third = { id: "third", text: "Third request", scope: "conversation-a", source: "terminal" }
    const items = [second, first, third]
    expect(inScope(items, "conversation-a")).toEqual([first, third])
    expect(inScope(items, "conversation-b")).toEqual([second])
    expect(inScope(items, "conversation-c")).toEqual([])
    expect(next(items, "conversation-a")).toBe(first)
    expect(next(items, "conversation-b")).toBe(second)
    expect(next(items, "conversation-c")).toBeUndefined()
    expect(items).toEqual([second, first, third])
  })

  test.each(
    [
      [[first, second], "Unfinished draft", "First request\n\nSecond request\n\nUnfinished draft"],
      [[first, second], "", "First request\n\nSecond request"],
      [[], "Unfinished draft", "Unfinished draft"],
      [[], "", ""]
    ] as const
  )("restores queued text and draft without losing either", (items, draft, expected) => {
    expect(restoreDraft(items, draft)).toBe(expected)
  })
})
