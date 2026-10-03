import { describe, expect, test } from "bun:test"
import { active, all, entryId, merge, text, toggle, type MainEntry } from "./ChatTimeline"
import type { Card } from "./AppState"
import { initMessage } from "../Onboarding"

const message = (id: string, at: number): MainEntry => ({ kind: "message", message: { id, ordinal: at, createdAt: at, text: id, role: "user", status: "complete" } })
const card = (value: Card): MainEntry => ({ kind: "card", card: value })
const keys = (entries: ReturnType<typeof merge>): string[] => entries.map(entryId)
const status = (): Card => ({ id: "status", kind: "status", title: "Build", body: "Needle result", createdAt: 2, ordinal: 2, status: "active", payload: {} })

describe("chat timeline", () => {
  test("message, card, source and case-insensitive text filters compose without changing their input", () => {
    const main = [message("Hello", 1), card(status()), message("Needle", 3)]
    const before = structuredClone(main)
    expect(keys(merge(main))).toEqual(["Hello", "status", "Needle"])
    const hidden = toggle(all, "messages")
    expect(active(hidden)).toBe(true)
    expect(keys(merge(main, hidden))).toEqual(["status"])
    expect(keys(merge(main, toggle(all, "cards")))).toEqual(["Hello", "Needle"])
    expect(keys(merge(main, toggle(all, "chat")))).toEqual([])
    expect(toggle(hidden, "messages")).toEqual(all)
    expect(active(all)).toBe(false)
    const filter = { ...all, query: "nEeDlE" }
    expect(keys(merge(main, filter))).toEqual(["status", "Needle"])
    expect(keys(merge(main, { ...hidden, query: "nEeDlE" }))).toEqual(["status"])
    expect(merge(main, { ...all, query: "missing" })).toEqual([])
    expect(main).toEqual(before)
    expect(filter).toEqual({ sources: [], kinds: [], query: "nEeDlE" })
  })

  test("run cards remain ordinary conversation cards in source order", () => {
    const run: Extract<Card, { kind: "run-trace" }> = { id: "run", kind: "run-trace", title: "Build", createdAt: 51, ordinal: 51, status: "active", payload: {
      repo: "owner/repo", runId: "run-1", workflow: "build", phase: "running", steps: [], result: null, lastSeq: 0,
      transcriptRows: [{ sequence: 1, at: 60, kind: "answer", text: "built" }]
    } }
    expect(keys(merge([message("before", 1), card(run), message("after", 2)]))).toEqual(["before", "run", "after"])
    expect(merge([card(run)])[0]?.kind).toBe("card")
  })

  test("row ids and searchable text retain card bodies, messages and initialization receipts", () => {
    expect(entryId(card(status()))).toBe("status")
    expect(text(card(status()))).toBe("Build\nNeedle result")
    expect(text(card({ ...status(), body: undefined }))).toBe("Build\n")
    expect(text(message("Hello", 1))).toBe("Hello")
    const init = initMessage({ bootstrap: undefined, flowCount: 0, connectors: [], repositories: [] })
    expect(entryId({ kind: "init", message: init })).toBe("init-state")
    expect(text({ kind: "init", message: init })).toBe("**Smithers here.**\n**Smithers initialized successfully**\n\n- Host: unknown\n- Capabilities: none\n- Flows registered: 0\n- Repositories: none open")
  })
})
