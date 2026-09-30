import { describe, expect, test } from "bun:test"
import { active, all, EARLIER_ID, entryId, fold, merge, subagentsFromCards, text, toggle, type MainEntry } from "./ChatTimeline"
import type { Card } from "./AppState"
import { initMessage } from "../Onboarding"

const message = (id: string, at: number): MainEntry => ({ kind: "message", message: { id, ordinal: at, createdAt: at, text: id, role: "user", status: "complete" } })
type AgentCard = Extract<Card, { kind: "agent" }>
type CloudCard = Omit<AgentCard, "payload"> & { payload: Extract<AgentCard["payload"], { cloud: true }> }
const cloud = (id: string, createdAt: number, state: string, text = "working"): CloudCard => ({
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
    const run: Extract<Card, { kind: "run-trace" }> = { id: "run", kind: "run-trace", title: "Build", createdAt: 51, ordinal: 51, status: "active", payload: {
      repo: "owner/repo", runId: "run-1", workflow: "build", phase: "running", steps: [], result: null, lastSeq: 0,
      transcriptRows: [{ sequence: 1, at: 60, kind: "answer", text: "built" }]
    } }
    expect(subagentsFromCards([run])).toEqual([])
    expect(keys(merge([card(run)], []))).toEqual(["run"])
  })

  test("filtering a chat separator groups visible workers without leaking finished rows for hidden workers", () => {
    const one = cloud("one", 1, "active"), two = cloud("two", 3, "completed")
    const main = [card(one), message("separator", 2), card(two)]
    const before = structuredClone(main)
    const workers = subagentsFromCards([one, two])
    expect(keys(merge(main, workers, { sources: ["chat"], kinds: [], query: "" }))).toEqual(["subagents:one", "finished:two"])
    expect(keys(merge(main, workers, { sources: ["two"], kinds: [], query: "" }))).toEqual(["subagents:one", "separator"])
    expect(main).toEqual(before)
  })

  test("tool target and card body searches keep their owning rows and preserve the filter draft", () => {
    const worker = cloud("worker", 1, "active", "unrelated output")
    worker.payload.transcript = [{ id: 1, sequence: 1, role: "assistant", createdAt: null,
      parts: [{ type: "tool_call", text: '{"name":"Read","arguments":{"path":"Needle.ts"}}' }] }]
    const ordinary: Extract<Card, { kind: "status" }> = { id: "ordinary", kind: "status", title: "Build", body: "Needle result", status: "active", createdAt: 2, ordinal: 2, payload: {} }
    const filter = { sources: [], kinds: [], query: "nEeDlE" }
    const main = [card(worker), card(ordinary), message("unrelated", 3)]
    const workers = subagentsFromCards([worker])
    expect(keys(merge(main, workers, filter))).toEqual(["subagents:worker", "ordinary"])
    expect(filter).toEqual({ sources: [], kinds: [], query: "nEeDlE" })
    expect(text(merge(main, workers)[0]!)).toBe("worker\nread Needle.ts")
    expect(text(card(ordinary))).toBe("Build\nNeedle result")
    const init = initMessage({ bootstrap: undefined, flowCount: 0, connectors: [], repositories: [] })
    expect(entryId({ kind: "init", message: init })).toBe("init-state")
    expect(text({ kind: "init", message: init })).toBe("**Smithers here.**\n**Smithers initialized successfully**\n\n- Host: unknown\n- Capabilities: none\n- Flows registered: 0\n- Repositories: none open")
  })

  test("lane colors wrap after six workers without sorting or mutating the caller's cards", () => {
    const cards = [local("g", 7), local("f", 6), local("e", 5), local("d", 4), local("c", 3), local("b", 2), local("a", 1)]
    const before = structuredClone(cards)
    expect(subagentsFromCards(cards).map(each => [each.id, each.color])).toEqual([["a", 0], ["b", 1], ["c", 2], ["d", 3], ["e", 4], ["f", 5], ["g", 0]])
    expect(cards).toEqual(before)
  })
})

describe("folding earlier subagent batches (#3033)", () => {
  /** `count` batches, each after its own message; every other one settled so it has a finished row. */
  const transcript = (count: number) => {
    const main: Array<MainEntry> = []
    const agents: Array<CloudCard> = []
    for (let index = 0; index < count; index++) {
      const agent = cloud(`a${index}`, index * 10 + 5, index % 2 === 0 ? "completed" : "active")
      agents.push(agent)
      main.push(message(`m${index}`, index * 10), card(agent))
    }
    return merge(main, subagentsFromCards(agents))
  }

  test("ten batches show in full", () => {
    const rows = transcript(10)
    expect(fold(rows, false)).toBe(rows)
  })

  test("the eleventh folds the oldest batch and its finished row into one row where it stood", () => {
    const rows = transcript(11)
    const folded = fold(rows, false)
    expect(keys(folded).slice(0, 4)).toEqual(["m0", EARLIER_ID, "m1", "subagents:a1"])
    expect(folded[1]).toEqual({ kind: "earlier", id: EARLIER_ID, batches: 1 })
    expect(keys(folded)).not.toContain("finished:a0")
    expect(keys(folded)).toContain("finished:a2")
    expect(folded.filter(entry => entry.kind === "subagents")).toHaveLength(10)
    expect(text(folded[1]!)).toBe("")
  })

  test("several folded batches become one row counting them, messages between them kept", () => {
    const folded = fold(transcript(13), false)
    expect(folded.filter(entry => entry.kind === "earlier")).toEqual([{ kind: "earlier", id: EARLIER_ID, batches: 3 }])
    expect(keys(folded).slice(0, 5)).toEqual(["m0", EARLIER_ID, "m1", "m2", "m3"])
  })

  test("an open row shows every batch where it stood", () => {
    const rows = transcript(13)
    expect(fold(rows, true)).toBe(rows)
  })
})
