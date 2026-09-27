import { describe, expect, test } from "bun:test"
import { active, all, entryId, merge, subagentsFromCards, toggle, type MainEntry } from "./ChatTimeline"
import type { Card, Message } from "./AppState"

const message = (id: string, at: number): MainEntry => ({ kind: "message", message: { id, ordinal: at, createdAt: at, text: id } as Message })
const cloud = (id: string, createdAt: number, state: string, text = "working"): Extract<Card, { kind: "agent" }> => ({
  id, kind: "agent", title: id, status: "active", createdAt, ordinal: createdAt, payload: {
    cloud: true, displayName: id, sessionId: id, repo: "owner/repo", provider: "codex", workspaceId: null, state,
    transcript: [{ id: 1, sequence: 1, role: "assistant", createdAt: "2026-09-14T09:00:00Z", parts: [{ type: "text", text }] }]
  }
})
const local = (id: string, createdAt: number): Extract<Card, { kind: "agent" }> => ({
  id, kind: "agent", title: id, status: "active", createdAt, ordinal: createdAt, payload: {
    harnessId: "claude", displayName: id, tabId: `tab-${id}`, sessionId: `tab-${id}`, cwd: "/repo", phase: "running", exitCode: null
  }
})
const card = (value: Card): MainEntry => ({ kind: "card", card: value })
const keys = (entries: ReturnType<typeof merge>): string[] => entries.map(entryId)

describe("chat timeline", () => {
  test("adjacent subagent cards fold into one grid, with a finished row for each settled member", () => {
    const one = cloud("one", 20, "active"), two = cloud("two", 21, "completed"), three = local("three", 40)
    const main = [message("chat-1", 10), card(one), card(two), message("chat-2", 30), card(three)]
    const rows = merge(main, subagentsFromCards([one, two, three]))
    expect(keys(rows)).toEqual(["chat-1", "subagents:one", "finished:two", "chat-2", "subagents:three"])
    const grid = rows[1]
    expect(grid?.kind === "subagents" && grid.subagents.map(each => each.id)).toEqual(["one", "two"])
  })

  test("source, kind, and case insensitive text filters compose and reset", () => {
    const agent = cloud("agent", 20, "active", "Needle")
    const main = [message("Hello", 10), card(agent)]
    const subagents = subagentsFromCards([agent])
    const hidden = toggle(all, "agent")
    expect(keys(merge(main, subagents, hidden))).toEqual(["Hello"])
    expect(keys(merge(main, subagents, toggle(all, "messages")))).toEqual(["subagents:agent"])
    expect(keys(merge(main, subagents, toggle(all, "cards")))).toEqual(["Hello"])
    expect(keys(merge(main, subagents, toggle(all, "chat")))).toEqual(["subagents:agent"])
    expect(keys(merge(main, subagents, { ...all, query: "nEeDlE" }))).toEqual(["subagents:agent"])
    expect(keys(merge(main, subagents, { ...all, query: "missing" }))).toEqual([])
    expect(active(hidden)).toBe(true)
    expect(toggle(hidden, "agent")).toEqual(all)
    expect(merge(main, subagents, all)).toHaveLength(2)
  })

  test("subagents take distinct lane colors in creation order, whatever order the cards arrive in", () => {
    const cards = [cloud("b", 50, "active"), local("a", 50), cloud("c", 10, "failed")]
    const subagents = subagentsFromCards(cards)
    expect(subagents.map(each => [each.id, each.color])).toEqual([["c", 0], ["a", 1], ["b", 2]])
    expect(subagentsFromCards([...cards].reverse()).map(each => [each.id, each.color])).toEqual(subagents.map(each => [each.id, each.color]))
    expect(subagents[0]?.subagent).toMatchObject({ title: "c", status: "failed", entries: [{ kind: "text", text: "working" }] })
  })

  test("a run card is an ordinary card, never a subagent of the chat", () => {
    const run = { id: "run", kind: "run-trace", title: "Build", createdAt: 51, ordinal: 51, status: "active", payload: {
      repo: "owner/repo", runId: "run-1", workflow: "build", phase: "running", steps: [], result: null, lastSeq: 0,
      transcriptRows: [{ sequence: 1, at: 60, kind: "answer", text: "built" }]
    } } as Card
    expect(subagentsFromCards([run])).toEqual([])
    expect(keys(merge([card(run)], []))).toEqual(["run"])
  })
})
