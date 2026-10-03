import { describe, expect, it } from "bun:test"
import * as Asks from "../src/asks.ts"
import type * as Flows from "../src/flows.ts"
import * as Inbox from "../src/inbox.ts"
import * as Transcript from "../src/transcript.ts"
import type { Tab } from "../src/workspace.ts"

const now = 1_000_000
const tab = (id: string, status: Tab["status"], extra: Partial<Tab> = {}): Tab => ({
  id,
  title: id,
  prompt: id,
  depth: extra.parent === undefined ? 1 : 2,
  seat: "openai:gpt-6.1-sol",
  file: `/tmp/${id}.jsonl`,
  status,
  startedAt: now - 60_000,
  ...extra
})
const run = (id: string, status: Flows.Run["status"], extra: Partial<Flows.Run> = {}): Flows.Run => ({
  id,
  flow: `flow-${id}`,
  by: "user",
  input: {},
  requested: "{}",
  status,
  startedAt: now - 5_000,
  ...extra
})
const used = (input: number, cached: number, context: number): Transcript.Transcript => ({
  ...Transcript.empty,
  usage: { input, output: 10, cached, context, usd: 0 }
})
const rows = (tabs: ReadonlyArray<Tab>, runs: ReadonlyArray<Flows.Run> = [], transcript = () => Transcript.empty) =>
  Inbox.rows({ tabs, runs, transcript, contextWindow: () => 200_000, models: [], now })
const shape = (sections: ReadonlyArray<Inbox.Section>) =>
  sections.map((section) => [section.group, section.rows.map((row) => `${"  ".repeat(row.level)}${row.key}`)])

describe("the overview inbox", () => {
  it("lists a pending build target under Needs you by label and short revision", () => {
    const target = {
      key: "plan-1",
      target: "//images:push",
      revision: "177f95506bee0123456789",
      approval: {} as never
    }
    const sections = Inbox.rows({
      tabs: [],
      runs: [],
      transcript: () => Transcript.empty,
      contextWindow: () => 200_000,
      models: [],
      now,
      targets: [target]
    })
    expect(sections.map((section) => section.group)).toEqual(["needs"])
    expect(sections[0]!.rows).toEqual([{
      key: "target:plan-1",
      group: "needs",
      level: 0,
      target,
      status: "input",
      name: "//images:push 177f95506bee",
      seat: "target",
      clock: ""
    }])
  })

  it("lists what needs the person first, then working trees, then done trees", () => {
    const sections = rows([
      tab("root", "running"),
      tab("child", "done", { parent: "root" }),
      tab("stuck", "parked", { parent: "root", wakeAt: new Date(2026, 8, 28, 14, 5).getTime() }),
      tab("grand", "running", { parent: "stuck" }),
      tab("old", "done"),
      tab("broke", "failed")
    ], [run("form", "input"), run("going", "running"), run("over", "done")])
    expect(shape(sections)).toEqual([
      ["needs", ["stuck", "broke", "flow:form"]],
      ["working", ["root", "  child", "  grand", "flow:going"]],
      ["done", ["old", "flow:over"]]
    ])
    expect(sections[0]!.rows[0]!.clock).toBe("14:05")
  })

  it("lists each active monitor under Working with its clock and its watch as the peek", () => {
    const monitor = (id: string, status: "active" | "stopped" | "failed") => ({
      id,
      title: `Watch ${id}`,
      watch: `Tell me when ${id} changes`,
      createdAt: now - 90_000,
      status
    })
    const sections = Inbox.rows({
      tabs: [tab("done", "done")],
      runs: [run("going", "running")],
      transcript: () => Transcript.empty,
      contextWindow: () => 200_000,
      models: [],
      now,
      monitors: [monitor("ci", "active"), monitor("old", "stopped"), monitor("broke", "failed")]
    })
    expect(shape(sections)).toEqual([["working", ["flow:going", "monitor:ci"]], ["done", ["done"]]])
    const row = sections[0]!.rows[1]!
    expect(row).toMatchObject({ name: "Watch ci", seat: "monitor", status: "running", monitor: { id: "ci" } })
    expect(row.clock).not.toBe("")
    expect(Inbox.peek(row, () => Transcript.empty)).toEqual(["Tell me when ci changes"])
    const stoppedOnly = Inbox.rows({
      tabs: [],
      runs: [],
      transcript: () => Transcript.empty,
      contextWindow: () => 200_000,
      models: [],
      now,
      monitors: [monitor("old", "stopped")]
    })
    expect(stoppedOnly).toEqual([])
  })

  it("drops empty groups", () => {
    expect(shape(rows([tab("a", "done")]))).toEqual([["done", ["a"]]])
  })

  it("reads window and cache percent from the footer's usage", () => {
    const [section] = rows([tab("a", "running")], [], () => used(40_000, 36_400, 122_000))
    expect(section!.rows[0]).toMatchObject({ seat: "GPT-6.1 Sol", clock: "1m", window: 61, cache: 91 })
    expect(Inbox.meter(section!.rows[0]!)).toBe("61% 91%")
    expect(Inbox.meter({})).toBe("")
  })

  it("gives a flow run no model label and its form's question as the peek", () => {
    const [section] = rows([], [run("form", "input", { message: "Needs: title" })])
    const row = section!.rows[0]!
    expect(row).toMatchObject({ seat: "", clock: "5s" })
    expect(Inbox.peek(row, () => Transcript.empty)).toEqual(["Needs: title"])
  })

  it("lifts the children of a root that needs the person, and files a settled tree with a failed root under Done", () => {
    expect(shape(rows([
      tab("stuck", "failed"),
      tab("kid", "running", { parent: "stuck" }),
      tab("gone", "cancelled"),
      tab("was", "done", { parent: "gone" })
    ]))).toEqual([["needs", ["stuck"]], ["working", ["kid"]], ["done", ["gone", "  was"]]])
  })

  it("puts parked and failed flows under Needs you and cancelled ones under Done", () => {
    expect(shape(rows([], [run("p", "parked"), run("f", "failed"), run("c", "cancelled"), run("q", "queued")])))
      .toEqual([["needs", ["flow:p", "flow:f"]], ["working", ["flow:q"]], ["done", ["flow:c"]]])
  })

  it("leaves a queued row's clock blank and shows no cache figure a provider did not report", () => {
    const [section] = rows([tab("a", "queued")], [], () => used(40_000, 0, 20_000))
    expect(section!.rows[0]).toMatchObject({ clock: "", window: 10 })
    expect(section!.rows[0]!.cache).toBeUndefined()
  })

  it("lists a worker whose ask the person holds under Needs you, and peeks at the question and its path", () => {
    const ask: Asks.Ask = {
      id: "ask-1",
      from: "impl",
      question: "Cookie or bearer?",
      options: ["cookie", "bearer"],
      holder: Asks.person,
      trail: ["plan", Asks.person],
      askedAt: now,
      frames: 0,
      returned: false
    }
    const shown = Inbox.rows({
      tabs: [tab("plan", "running"), tab("impl", "running", { parent: "plan" })],
      runs: [],
      transcript: () => Transcript.empty,
      contextWindow: () => 200_000,
      models: [],
      now,
      asks: [ask, { ...ask, id: "ask-2", from: "plan", holder: "root" }]
    })
    expect(shape(shown)).toEqual([["needs", ["impl"]], ["working", ["plan"]]])
    expect(Inbox.peek(shown[0]!.rows[0]!, () => Transcript.empty)).toEqual([
      "Cookie or bearer?",
      "cookie · bearer",
      "asked plan → you"
    ])
  })
})
