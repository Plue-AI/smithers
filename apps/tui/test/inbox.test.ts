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
const rows = (tabs: ReadonlyArray<Tab>, runs: ReadonlyArray<Flows.Run> = []) =>
  Inbox.rows({ tabs, runs, models: [], now })
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

  it("lists what the person can answer first, then working trees, failures, then done trees", () => {
    const sections = rows([
      tab("root", "running"),
      tab("child", "done", { parent: "root" }),
      tab("stuck", "parked", { parent: "root", wakeAt: new Date(2026, 8, 28, 14, 5).getTime() }),
      tab("grand", "running", { parent: "stuck" }),
      tab("old", "done"),
      tab("broke", "failed")
    ], [run("form", "input"), run("going", "running"), run("over", "done")])
    expect(shape(sections)).toEqual([
      ["needs", ["flow:form"]],
      ["working", ["root", "  child", "  stuck", "    grand", "flow:going"]],
      ["failed", ["broke"]],
      ["done", ["old", "flow:over"]]
    ])
    // A park waits under Working for its reset, which takes the seat column.
    expect(sections[1]!.rows[2]).toMatchObject({ group: "working", seat: "", clock: "resets 14:05" })
    expect(Inbox.count(sections)).toBe(1)
  })

  it("counts only asks, approvals, forms and driven frames as needing the person", () => {
    const sections = Inbox.rows({
      tabs: [
        tab("quota", "parked", { wakeAt: now + 60_000 }),
        tab("broke", "failed"),
        tab("approve", "running"),
        tab("drive", "waiting", { driver: { by: "you", from: now, messages: 0 } }),
        tab("wait", "waiting")
      ],
      runs: [run("form", "input"), run("gate", "running"), run("park", "parked")],
      models: [],
      now,
      approvals: ["approve", "flow:gate"]
    })
    expect(shape(sections)).toEqual([
      ["needs", ["approve", "drive", "flow:form", "flow:gate"]],
      ["working", ["quota", "wait", "flow:park"]],
      ["failed", ["broke"]]
    ])
    // The chat's own approvals have no row but still count.
    expect(Inbox.count(sections, 2)).toBe(6)
    expect(Inbox.count([])).toBe(0)
  })

  it("files a failure that a later run of the same work finished under Done, and keeps a newer failure", () => {
    const sections = rows([
      tab("first", "failed", { title: "Read math.js", prompt: "read", startedAt: now - 30_000 }),
      tab("again", "done", { title: "Read math.js", prompt: "read", startedAt: now - 10_000 }),
      tab("other", "failed", { title: "Read math.js", prompt: "read", parent: "root", startedAt: now - 5_000 }),
      tab("root", "running", { startedAt: now - 60_000 }),
      tab("later", "failed", { title: "Lint", prompt: "lint", startedAt: now - 1_000 }),
      tab("earlier", "done", { title: "Lint", prompt: "lint", startedAt: now - 20_000 })
    ], [
      run("a", "failed", { startedAt: now - 9_000 }),
      run("b", "done", { flow: "flow-a", startedAt: now - 4_000 }),
      run("c", "failed", { startedAt: now - 2_000 })
    ])
    expect(shape(sections)).toEqual([
      ["working", ["root"]],
      ["failed", ["other", "later", "flow:c"]],
      ["done", ["first", "again", "earlier", "flow:a", "flow:b"]]
    ])
    expect(Inbox.superseded(tab("x", "done"), [tab("y", "done")])).toBe(false)
  })

  it("counts concurrent person-held asks on one worker separately, preventing the sole-ask shortcut", () => {
    const ask: Asks.Ask = {
      id: "first",
      from: "worker",
      question: "Which name?",
      holder: Asks.person,
      trail: [Asks.person],
      askedAt: now,
      frames: 0,
      returned: false
    }
    const input = {
      tabs: [tab("worker", "running")],
      runs: [],
      models: [],
      now
    }
    const sections = Inbox.rows({
      ...input,
      asks: [ask, { ...ask, id: "second" }, { ...ask, id: "peer", holder: "other" }]
    })
    expect(shape(sections)).toEqual([["needs", ["worker"]]])
    expect(Inbox.count(sections)).toBe(2)
    expect(Inbox.count(sections) === 1).toBe(false)
    expect(Inbox.count(Inbox.rows({ ...input, asks: [ask] }))).toBe(1)
    expect(Inbox.count(Inbox.rows({ ...input, asks: [{ ...ask, holder: "other" }] }))).toBe(0)
  })

  it("counts each approval and form even when they share a row with another request", () => {
    const sections = Inbox.rows({
      tabs: [tab("worker", "running")],
      runs: [run("form", "input")],
      models: [],
      now,
      asks: [{
        id: "ask",
        from: "worker",
        question: "Which name?",
        holder: Asks.person,
        trail: [Asks.person],
        askedAt: now,
        frames: 0,
        returned: false
      }],
      approvals: ["worker", "worker", "flow:form"]
    })
    expect(shape(sections)).toEqual([["needs", ["worker", "flow:form"]]])
    expect(Inbox.count(sections, 1)).toBe(6)
  })

  it("keeps a failed worker that a later worker with the same title but another prompt finished", () => {
    const sections = rows([
      tab("root", "running", { startedAt: now - 60_000 }),
      tab("auth", "failed", { title: "Review", prompt: "Review auth.ts", parent: "root", startedAt: now - 9_000 }),
      tab("login", "done", { title: "Review", prompt: "Review login.ts", parent: "root", startedAt: now - 4_000 }),
      tab("math", "failed", { title: "Review", prompt: "Review math.ts", parent: "root", startedAt: now - 8_000 }),
      tab("again", "done", { title: "Review", prompt: "Review math.ts", parent: "root", startedAt: now - 3_000 })
    ])
    expect(shape(sections)).toEqual([
      ["working", ["root", "  login", "  math", "  again"]],
      ["failed", ["auth"]]
    ])
  })

  it("keeps a failed flow run that a later run of the same flow with other input finished", () => {
    const sections = rows([], [
      run("prod", "failed", { flow: "deploy", input: { env: "prod" }, startedAt: now - 9_000 }),
      run("staging", "done", { flow: "deploy", input: { env: "staging" }, startedAt: now - 4_000 }),
      run("fixed", "failed", { flow: "deploy", input: { env: "qa" }, startedAt: now - 8_000 }),
      run("again", "done", { flow: "deploy", input: { env: "qa" }, startedAt: now - 3_000 })
    ])
    expect(shape(sections)).toEqual([
      ["failed", ["flow:prod"]],
      ["done", ["flow:staging", "flow:fixed", "flow:again"]]
    ])
  })

  it("compares the input a run was filled with, not the input it was requested with", () => {
    const sections = rows([], [
      run("prod", "failed", { flow: "deploy", requested: "{}", input: { env: "prod" }, startedAt: now - 9_000 }),
      run("staging", "done", { flow: "deploy", requested: "{}", input: { env: "staging" }, startedAt: now - 4_000 }),
      run("fixed", "failed", { flow: "deploy", requested: "{}", input: { env: "qa" }, startedAt: now - 8_000 }),
      run("again", "done", { flow: "deploy", requested: `{"env":"qa"}`, input: { env: "qa" }, startedAt: now - 3_000 })
    ])
    expect(shape(sections)).toEqual([
      ["failed", ["flow:prod"]],
      ["done", ["flow:staging", "flow:fixed", "flow:again"]]
    ])
  })

  it("keeps a closed Failed group to its heading among the keys a person moves over", () => {
    const sections = rows([tab("run", "running"), tab("broke", "failed"), tab("old", "done")])
    expect(Inbox.keys(sections, false)).toEqual(["run", Inbox.failedKey, "old"])
    expect(Inbox.keys(sections, true)).toEqual(["run", Inbox.failedKey, "broke", "old"])
    expect(Inbox.flat(sections).map((row) => row.key)).toEqual(["run", "old"])
    expect(Inbox.flat(sections, true).map((row) => row.key)).toEqual(["run", "broke", "old"])
  })

  it("formats how long an ask has waited and when a park resets", () => {
    expect(Inbox.waited(0)).toBe("0:00")
    expect(Inbox.waited(12_900)).toBe("0:12")
    expect(Inbox.waited(754_000)).toBe("12:34")
    expect(Inbox.waited(-5)).toBe("0:00")
    expect(Inbox.resets(new Date(2026, 8, 28, 21, 43).getTime())).toBe("resets 21:43")
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
      models: [],
      now,
      monitors: [monitor("old", "stopped")]
    })
    expect(stoppedOnly).toEqual([])
  })

  it("drops empty groups", () => {
    expect(shape(rows([tab("a", "done")]))).toEqual([["done", ["a"]]])
  })

  it("keeps the model and elapsed time without telemetry columns", () => {
    const [section] = rows([tab("a", "running")])
    expect(section!.rows[0]).toMatchObject({ seat: "GPT-6.1 Sol", clock: "1m" })
    expect(section!.rows[0]).not.toHaveProperty("window")
    expect(section!.rows[0]).not.toHaveProperty("cache")
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
    ]))).toEqual([["working", ["kid"]], ["failed", ["stuck"]], ["done", ["gone", "  was"]]])
  })

  it("puts parked flows under Working, failed ones under Failed and cancelled ones under Done", () => {
    expect(shape(rows([], [run("p", "parked"), run("f", "failed"), run("c", "cancelled"), run("q", "queued")])))
      .toEqual([["working", ["flow:p", "flow:q"]], ["failed", ["flow:f"]], ["done", ["flow:c"]]])
  })

  it("leaves a queued row's clock blank", () => {
    const [section] = rows([tab("a", "queued")])
    expect(section!.rows[0]).toMatchObject({ clock: "" })
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
      models: [],
      now,
      asks: [ask, { ...ask, id: "ask-2", from: "plan", holder: "root" }]
    })
    expect(shape(shown)).toEqual([["needs", ["impl"]], ["working", ["plan"]]])
    // Its clock is how long the ask has waited.
    expect(shown[0]!.rows[0]!.clock).toBe("0:00")
    expect(Inbox.peek(shown[0]!.rows[0]!, () => Transcript.empty)).toEqual([
      "Cookie or bearer?",
      "cookie · bearer",
      "asked plan → you"
    ])
  })
})
