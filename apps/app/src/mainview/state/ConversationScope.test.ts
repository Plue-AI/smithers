import { describe, expect, test } from "bun:test"
import type { Suggestion, Tab } from "./AppState"
import { conversationTabIdOf, inConversation, SuggestionSchema, TabSchema } from "./AppState"

/*
 * The conversation seam and the two types derived from their schemas. None of
 * this was pinned: `conversationTabIdOf` took a tab-lookup callback it never
 * called (every caller built one), and `Tab`/`Suggestion` were hand-written
 * twins of `TabSchema`/`SuggestionSchema` that could drift apart silently.
 */

const session = (phase: "idle" | "responding", turnTabId?: string | null) => ({ phase, turnTabId })

describe("conversation scope", () => {
  test("the seam reads the session alone: no tab lookup is needed to name the conversation", () => {
    expect(conversationTabIdOf.length).toBe(1)
    expect(conversationTabIdOf(session("responding", "tab-7"))).toBe("tab-7")
  })

  test("a turn in flight keeps writing where it started; main and every settled phase are undefined", () => {
    expect(conversationTabIdOf(session("responding", null))).toBeUndefined()
    expect(conversationTabIdOf(session("responding"))).toBeUndefined()
    expect(conversationTabIdOf(session("idle", "tab-7"))).toBeUndefined()
  })

  test("a row belongs to the conversation its tabId names; a row without one is main's", () => {
    expect(inConversation({ tabId: "tab-7" }, "tab-7")).toBe(true)
    expect(inConversation({ tabId: "tab-7" }, undefined)).toBe(false)
    expect(inConversation({}, undefined)).toBe(true)
  })
})

describe("types derived from their schemas", () => {
  test("a card tab row parses as the schema's card member and opens without the collection's ordinal", () => {
    const row = TabSchema.parse({ id: "tab-7", kind: "card", title: "Balance", cardId: "balance", ordinal: 3 })
    if (row.kind !== "card") throw new Error("the card member parsed as something else")
    const { ordinal: _ordinal, ...opened } = row
    const tab: Tab = opened
    expect(tab).toEqual({ id: "tab-7", kind: "card", title: "Balance", cardId: "balance" })
  })

  test("a suggestion parsed from the schema is the Suggestion the pills render", () => {
    const suggestion: Suggestion = SuggestionSchema.parse({
      id: "open",
      label: "Open a repository",
      flow: "repo.open",
      emphasis: "primary",
      why: "nothing is open yet"
    })
    expect(suggestion.emphasis).toBe("primary")
    expect(suggestion.why).toBe("nothing is open yet")
  })
})
