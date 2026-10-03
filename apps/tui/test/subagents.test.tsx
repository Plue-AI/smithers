import { testRender } from "@opentui/react/test-utils"
import { afterEach, describe, expect, it } from "bun:test"
import { act } from "react"
import * as RunCard from "../src/run-card.ts"
import * as SubagentView from "../src/subagent-view.tsx"
import * as Subagents from "../src/subagents.ts"
import { color } from "../src/theme.ts"
import * as Timeline from "../src/timeline.ts"
import * as Transcript from "../src/transcript.ts"
import * as Tree from "../src/tree.ts"
import type { Tab } from "../src/workspace.ts"

const tab = (id: string, status: Tab["status"], extra: Partial<Tab> = {}): Tab => ({
  id,
  depth: 0,
  title: id,
  prompt: `Do ${id}.`,
  seat: "openai:gpt-6-sol",
  file: `/tmp/${id}.jsonl`,
  status,
  startedAt: 0,
  ...extra
})
const event = (value: unknown) => value as Parameters<typeof Transcript.apply>[1]
/** A cell that writes `prose` and makes `calls`, each settled unless it is `running`. */
const cell = (
  transcript: Transcript.Transcript,
  at: number,
  prose: string,
  calls: ReadonlyArray<
    { flow: string; input: unknown; outcome?: "success" | "failure" | "running"; exitCode?: number; value?: unknown }
  >
): Transcript.Transcript => {
  let next = Transcript.apply(transcript, event({ _tag: "model-requested" }), at)
  next = Transcript.apply(
    next,
    event({ _tag: "model-delta", delta: { type: "text-delta", text: `${prose}\n\`\`\`js\nx\n\`\`\`` } }),
    at
  )
  next = Transcript.apply(next, event({ _tag: "cell-produced", cell: { text: "x" } }), at)
  calls.forEach((call, index) => {
    const identity = { session: "s", frame: at, cell: 1, ordinal: index }
    next = Transcript.apply(
      next,
      event({ _tag: "cell-call-started", call: { flowName: call.flow, input: call.input, identity } }),
      at + index + 1
    )
    if (call.outcome === "running") return
    next = Transcript.apply(
      next,
      event({
        _tag: "cell-call-settled",
        flowName: call.flow,
        identity,
        result: call.outcome === "failure"
          ? { outcome: "failure", message: "exit 1" }
          : {
            outcome: "success",
            value: call.value ?? (call.exitCode === undefined ? {} : { exitCode: call.exitCode })
          }
      }),
      at + index + 1
    )
  })
  return next
}

describe("run receipts", () => {
  it("sums a worker's result: files per path without undone changes, and its last command's exit", () => {
    const worker = cell(Transcript.empty, 10, "", [
      { flow: "bash", input: { command: "npm test" }, value: { exitCode: 1 } },
      { flow: "edit", input: { path: "src/cart.js", oldString: "a", newString: "b" } },
      { flow: "bash", input: { command: "npm test\nnpm run lint" }, value: { exitCode: 0 } },
      // Showing the work is not checking it.
      { flow: "bash", input: { command: "git status --porcelain; git diff" }, value: { exitCode: 0 } },
      { flow: "bash", input: { command: "jj st" }, value: { exitCode: 0 } }
    ])
    const [edit] = (worker.items.find((item) => item.kind === "cell") as Extract<Transcript.Item, { kind: "cell" }>)
      .calls.filter((call) => call.flow === "edit")
    const patched = Transcript.patched(worker, {
      call: edit!.identity!,
      patches: [{ path: "src/cart.js", patch: "@@ -1 +1 @@\n-a\n+b" }, {
        path: "src/cart.js",
        patch: "@@ -2,0 +2 @@\n+c"
      }]
    })
    expect(Subagents.result(patched)).toEqual({
      files: [{ path: "src/cart.js", added: 2, removed: 1 }],
      check: { command: "npm test; npm run lint", exit: 0 }
    })
    const undone = Transcript.undone(patched, [edit!.identity!], ["src/cart.js"], 20)
    expect(Subagents.result(undone).files).toEqual([])
    expect(Subagents.result(Transcript.empty)).toEqual({ files: [] })
  })

  it("reports a multiline command whole, so its exit belongs to every line it ran", () => {
    const check = (command: string, exitCode: number) =>
      Subagents.result(cell(Transcript.empty, 10, "", [{ flow: "bash", input: { command }, exitCode }])).check
    expect(check("node -e \"process.exit(7)\"\nnode -e \"process.exit(0)\"", 0)).toEqual({
      command: "node -e \"process.exit(7)\"; node -e \"process.exit(0)\"",
      exit: 0
    })
    expect(check("node -e \"process.exit(0)\"\nnode -e \"process.exit(7)\"", 7)).toEqual({
      command: "node -e \"process.exit(0)\"; node -e \"process.exit(7)\"",
      exit: 7
    })
    expect(check("bun test \\\n  ./test &&\n  bun run typecheck\n", 0)).toEqual({
      command: "bun test ./test && bun run typecheck",
      exit: 0
    })
    expect(check("if test -f a; then\n  echo a\nfi", 0)).toEqual({ command: "if test -f a; then echo a; fi", exit: 0 })
  })

  it("keeps a version-control validation or failure as the check, and drops only a state display", () => {
    const check = (command: string, exitCode: number) =>
      Subagents.result(cell(Transcript.empty, 10, "", [
        { flow: "bash", input: { command: "npm test" }, exitCode: 0 },
        { flow: "bash", input: { command }, exitCode }
      ])).check
    expect(check("git diff --check", 2)).toEqual({ command: "git diff --check", exit: 2 })
    expect(check("git diff --check -- src", 0)).toEqual({ command: "git diff --check -- src", exit: 0 })
    expect(check("git diff --check && git status --porcelain", 0)).toEqual({
      command: "git diff --check && git status --porcelain",
      exit: 0
    })
    expect(check("git diff --exit-code", 1)).toEqual({ command: "git diff --exit-code", exit: 1 })
    expect(check("git status && npm test", 0)).toEqual({ command: "git status && npm test", exit: 0 })
    expect(check("git commit -m fix", 0)).toEqual({ command: "git commit -m fix", exit: 0 })
    expect(check("git status", 128)).toEqual({ command: "git status", exit: 128 })
    for (const shown of ["git status --porcelain; git diff", "git diff -- src", "jj st", "git log --oneline | head"]) {
      expect(check(shown, 0)).toEqual({ command: "npm test", exit: 0 })
    }
  })

  it("keeps result evidence for files retained after a partial undo of one call", () => {
    const worker = cell(Transcript.empty, 10, "", [
      { flow: "bash", input: { command: "npm test" }, value: { exitCode: 0 } }
    ])
    const command = worker.items.find((item) => item.kind === "cell")!
    if (command.kind !== "cell") throw new Error("missing cell")
    const identity = command.calls[0]!.identity!
    const patched = Transcript.patched(worker, {
      call: identity,
      patches: [
        { path: "reverted.ts", patch: "-old\n+new" },
        { path: "retained.ts", patch: "+one\n+two" }
      ]
    })
    const partial = Transcript.undone(patched, [identity], ["reverted.ts"], 20)
    expect(Subagents.result(partial)).toEqual({
      files: [{ path: "retained.ts", added: 2, removed: 0 }],
      check: { command: "npm test", exit: 0 }
    })
    const all = Transcript.undone(partial, [identity], ["retained.ts"], 21)
    expect(Subagents.result(all)).toEqual({ files: [], check: { command: "npm test", exit: 0 } })
  })

  it("keeps another file from the same call when only one file was undone", () => {
    const transcript: Transcript.Transcript = {
      ...Transcript.empty,
      items: [{
        kind: "cell",
        id: "edit",
        index: 1,
        source: "",
        prose: "",
        status: "done",
        startedAt: 0,
        printed: "",
        calls: [{
          flow: "edit",
          subject: "two files",
          status: "ok",
          startedAt: 1,
          patches: [
            { path: "first.js", patch: "@@ -1 +1 @@\n-a\n+b", undone: true },
            { path: "second.js", patch: "@@ -1 +1 @@\n-c\n+d" }
          ]
        }]
      }]
    }
    expect(Subagents.result(transcript).files).toEqual([{ path: "second.js", added: 1, removed: 1 }])
  })
})

describe("batches", () => {
  const delegating = cell(Transcript.user(Transcript.empty, "Split it", false, 5), 10, "Three workers.", [
    { flow: "agent.delegate", input: { id: "a", title: "auth", prompt: "a" } },
    { flow: "agent.delegate", input: { id: "b", title: "db", prompt: "b" } }
  ])
  const later = Transcript.note(delegating, "Requested.", 100)
  const tabs = [
    tab("a", "running", { title: "auth", startedAt: 11 }),
    tab("b", "done", { title: "db", startedAt: 12, endedAt: 200 }),
    tab("c", "running", { title: "cli", startedAt: 150 }),
    tab("a/x", "running", { parent: "a", title: "child", startedAt: 20 })
  ]

  it("groups a parent's workers at the cell that delegated them, others after the row before them", () => {
    const groups = Subagents.batches(later, tabs)
    const cellId = later.items.find((item) => item.kind === "cell")!.id
    expect(groups.map((batch) => [batch.anchor, batch.tabs.map((each) => each.id)])).toEqual([
      [cellId, ["a", "b"]],
      [later.items.at(-1)!.id, ["c"]]
    ])
    expect(Subagents.batches(later, tabs, "a").map((batch) => batch.tabs.map((each) => each.id))).toEqual([["a/x"]])
  })

  it("keeps each settled card at the same request anchor", () => {
    const rows = Timeline.rows(later)
    const lines = Subagents.lines(rows, Subagents.batches(later, tabs))
    expect(lines.map((line) => line.kind === "row" ? Timeline.text(line.row.item).split("\n")[0] : line.key)).toEqual([
      "Split it",
      "Three workers.",
      "batch:a",
      "Requested.",
      "batch:c"
    ])
  })

  it("keeps a flow below its request when its clock starts before the persisted anchor", () => {
    const transcript = Transcript.run(Transcript.empty, {
      surface: "flow:words",
      title: "wordcount",
      request: "/flow wordcount"
    }, 1001)
    const run = {
      id: "words",
      flow: "wordcount",
      by: "user" as const,
      input: {},
      requested: "{}",
      status: "running" as const,
      startedAt: 1000
    }
    const groups = Subagents.batches(transcript, [], undefined, [run])
    expect(groups[0]?.anchor).toBe(transcript.items[0]?.id)
    const lines = Subagents.lines(Timeline.rows(RunCard.chat(transcript)), groups)
    expect(lines.map((line) => line.kind === "row" ? Timeline.text(line.row.item) : line.key)).toEqual([
      "/flow wordcount",
      "batch:flow:words"
    ])
  })

  it("keeps cards whose delegating cell Chat leaves out at their request time", () => {
    const rows = Timeline.rows(RunCard.chat(later))
    expect(rows.some((row) => row.item.kind === "cell")).toBe(false)
    const lines = Subagents.lines(rows, Subagents.batches(later, tabs))
    expect(lines.map((line) => line.key)).toEqual(["chat:0", "batch:a", "chat:2", "batch:c"])
    const early = [tab("q", "done", { startedAt: 11, endedAt: 12 })]
    expect(Subagents.lines(rows, Subagents.batches(later, early)).map((line) => line.key)).toEqual([
      "chat:0",
      "batch:q",
      "chat:2"
    ])
  })
})

describe("card focus", () => {
  const order = ["panel", "agent:a", "agent:b", "agent:c", "last"]
  it("moves in order through a vertical card stack", () => {
    expect(Subagents.move(order, "agent:b", "down")).toBe("agent:c")
    expect(Subagents.move(order, "agent:c", "up")).toBe("agent:b")
    expect(Subagents.move(order, "agent:c", "down")).toBe("last")
    expect(Subagents.move(order, "agent:a", "up")).toBe("panel")
  })
  it("steps in order sideways and with tab, wrapping around", () => {
    expect(Subagents.move(order, "agent:a", "right")).toBe("agent:b")
    expect(Subagents.move(order, "agent:a", "left")).toBe("panel")
    expect(Subagents.move(order, "last", "next")).toBe("panel")
    expect(Subagents.move(order, "panel", "previous")).toBe("last")
  })
})

describe("the worker tree", () => {
  it("walks every top-level worker and its descendants in request order", () => {
    const tabs = [tab("a", "running"), tab("b", "done"), tab("a/x", "running", { parent: "a" })]
    expect(Tree.walk(tabs).map((node) => `${node.level}:${node.tab.id}`)).toEqual(["0:a", "1:a/x", "0:b"])
    expect(Tree.branch(tabs, "a").map((each) => each.id)).toEqual(["a", "a/x"])
  })
  it("draws each row with the shared glyph", () => {
    const panel = Tree.panel("a", [tab("a", "done", { launchedAt: 0, endedAt: 64_000 })], () => Transcript.empty, 1)
    expect(panel.rows[0]?.label).toContain("● a")
    expect(panel.rows[0]?.label).toContain("1m 04s")
  })
  it("names each row's model as every other surface does", () => {
    const tabs = [
      tab("a", "done", { seat: "openai:gpt-6.1-sol" }),
      tab("a/x", "running", { parent: "a", seat: "sonnet", activeSeat: "cerebras:qwen-3.8-27b" }),
      tab("a/y", "running", { parent: "a", seat: "auto", harness: { vendor: "claude" } })
    ]
    const labels = Tree.panel("a", tabs, () => Transcript.empty, 1).rows.map((row) => row.label)
    expect(labels[0]).toContain("● a  GPT-6.1 Sol  ")
    expect(labels[1]).toContain(" a/x  Qwen 3.8  ")
    expect(labels[2]).toContain(" a/y  claude  ")
  })
})

let setup: Awaited<ReturnType<typeof testRender>> | undefined
afterEach(() => {
  const mounted = setup
  setup = undefined
  if (mounted !== undefined) act(() => mounted.renderer.destroy())
})
const mount = async (node: Parameters<typeof testRender>[0], width: number, height: number) => {
  const mounted = await act(() => testRender(node, { width, height }))
  setup = mounted
  await act(() => mounted.renderOnce())
  return mounted
}

describe("the card grid", () => {
  const auth = cell(Transcript.empty, 10, "", [
    { flow: "read", input: { path: "auth/login.ts" } },
    { flow: "edit", input: { path: "login.ts", oldString: "a", newString: "b\nc" }, outcome: "running" }
  ])
  const tabs = [
    tab("auth", "running", { title: "auth-audit" }),
    tab("db", "waiting", { title: "db-migrate" }),
    tab("docs", "done", { title: "docs", endedAt: 64_000 })
  ]
  const cards = (focused?: string): SubagentView.Cards => ({
    transcript: (id) => id === "auth" ? auth : Transcript.empty,
    now: 42_000,
    lane: () => color.info,
    focused,
    onOpen: () => {}
  })
  const batch: Subagents.Batch = { key: "batch:auth", anchor: undefined, at: 0, tabs }

  it("stacks one card per run without a batch heading or model footer", async () => {
    const { captureCharFrame } = await mount(
      <SubagentView.Batch batch={batch} width={80} cards={cards("agent:auth")} />,
      80,
      20
    )
    const frame = captureCharFrame()
    const lines = frame.split("\n")
    const auth = lines.findIndex((line) => line.includes("auth-audit"))
    const db = lines.findIndex((line) => line.includes("db-migrate"))
    const docs = lines.findIndex((line) => line.includes("docs"))
    expect(auth).toBeGreaterThanOrEqual(0)
    expect(db).toBeGreaterThan(auth)
    expect(docs).toBeGreaterThan(db)
    expect(frame).toContain("Read auth/login.ts")
    expect(frame).toContain("Editing login.ts")
    expect(frame).not.toContain("Running 3 subagents")
    expect(frame).not.toContain("GPT-6 Sol")
    expect(frame).not.toContain("finished")
  })

  it.each([68, 80, 110])("keeps every card in its own row at %s columns", async (width) => {
    const { captureCharFrame } = await mount(
      <SubagentView.Grid tabs={tabs.slice(0, 2)} width={width} cards={cards()} />,
      width,
      12
    )
    const lines = captureCharFrame().split("\n")
    const first = lines.findIndex((line) => line.includes("auth-audit"))
    const second = lines.findIndex((line) => line.includes("db-migrate"))
    expect(first).toBeGreaterThanOrEqual(0)
    expect(second).toBeGreaterThan(first)
    expect(lines[first]).not.toContain("db-migrate")
  })
})

describe("the Summary overview's tree row", () => {
  const row = {
    key: "w1",
    group: "working",
    level: 0,
    status: "running",
    name: "Fix UTF-8 split-chunk decoding in flows/release so a multibyte char survives",
    seat: "Claude Opus 5.5",
    clock: "11m 43s"
  } as const
  const seat = SubagentView.seatColumn([row, { seat: "GPT-6.1 Sol" }], 64)
  it("sizes the model column to the longest model name, short of squeezing names under a dozen cells", () => {
    expect(seat).toBe("Claude Opus 5.5".length + 1)
    expect(SubagentView.seatColumn([{ seat: "fn" }], 64)).toBe(9)
    expect(SubagentView.seatColumn([{ seat: "openrouter:anthropic/claude-sonnet-4.5" }], 46)).toBe(18)
    expect(SubagentView.seatColumn([], 64)).toBe(9)
  })
  it("keeps a space between the clipped name and every column, and the whole model name", () => {
    const line = SubagentView.treeRow(row, 4, 64, seat)
    const text = `${line.title}${" ".repeat(line.gap)}${line.aside}`
    expect(4 + text.length).toBeLessThanOrEqual(64 - 1)
    expect(text).toMatch(/… +Claude Opus 5\.5 +11m 43s *$/)
    expect(text).not.toContain("%")
  })
  it("pads short values to the same columns, so rows line up", () => {
    const a = SubagentView.treeRow({ ...row, seat: "Qwen 3.8", clock: "4s" }, 4, 64, seat)
    const b = SubagentView.treeRow(row, 4, 64, seat)
    expect(a.aside.indexOf("4s")).toBe(b.aside.indexOf("11m 43s"))
    expect(a.title.length + a.gap).toBe(b.title.length + b.gap)
  })
  it("keeps names and clock separated in a narrow pane", () => {
    const line = SubagentView.treeRow(row, 4, 46, seat)
    expect(line.aside).not.toContain("%")
    expect(`${line.title}${" ".repeat(line.gap)}${line.aside}`).toMatch(/… +Claude Opus 5\.5 +11m 43s *$/)
  })
  for (const width of [80, 110]) {
    it(`draws every model name whole at ${width} columns`, async () => {
      const rows = [
        { ...row, key: "a", name: "Review", seat: "GPT-6.1 Sol", clock: "4s" },
        { ...row, key: "b", name: "Docs", seat: "Claude Sonnet 5.5", clock: "9s" }
      ]
      const { captureCharFrame } = await mount(
        <SubagentView.Overview
          sections={[{ group: "working", rows }]}
          selected={SubagentView.chat}
          pane="tree"
          width={width}
          cards={{
            transcript: () => Transcript.empty,
            now: 0,
            lane: () => color.info,
            focused: undefined,
            onOpen: () => {}
          }}
          tabs={[]}
          onSelect={() => {}}
          review={null}
        />,
        width,
        12
      )
      const frame = captureCharFrame()
      expect(frame).toMatch(/◐ Review +GPT/)
      expect(frame).toMatch(/GPT-6\.1 Sol +4s/)
      expect(frame).toMatch(/Claude Sonnet 5\.5 +9s/)
      expect(frame).not.toContain("…")
    })
  }
})

/** Separate messages make separate real delegation batches. */
const manyBatches = (count: number, parent?: string) => {
  let transcript = Transcript.empty
  const workers: Tab[] = []
  for (let index = 0; index < count; index++) {
    transcript = Transcript.note(transcript, `message ${index}`, index * 10)
    workers.push(tab(`batch-${index}`, "done", {
      startedAt: index * 10 + 1,
      endedAt: index * 10 + 2,
      ...(parent === undefined ? {} : { parent })
    }))
  }
  return {
    transcript,
    workers,
    rows: Timeline.rows(transcript),
    groups: Subagents.batches(transcript, workers, parent)
  }
}

describe("earlier subagent batches (#3033)", () => {
  it("folds stopped, unchecked and failed outcomes together and restores their cards on expansion", () => {
    const { rows, transcript, workers } = manyBatches(13)
    const states: Partial<Tab>[] = [
      { status: "cancelled" },
      { unchecked: true },
      {
        status: "failed",
        failure: { headline: "Model call failed", fault: "dependency", line: "", actions: ["resume"] }
      }
    ]
    const changed = workers.map((worker, index) => ({ ...worker, ...states[index] }))
    const groups = Subagents.batches(transcript, changed)
    const closed = Subagents.lines(rows, groups)
    expect(closed.filter((line) => line.kind === "earlier")).toEqual([{
      kind: "earlier",
      key: Subagents.earlierKey(),
      batches: 3
    }])
    expect(closed.filter((line) => line.kind === "grid").flatMap((line) => line.batch.tabs.map((tab) => tab.id)))
      .toEqual(changed.slice(3).map((worker) => worker.id))
    const opened = Subagents.lines(rows, groups, true)
    const restored = opened.filter((line) => line.kind === "grid").slice(0, 3)
    expect(restored.flatMap((line) => line.batch.tabs)).toEqual(changed.slice(0, 3))
    expect(opened.filter((line) => line.kind === "row").map((line) => line.key)).toEqual(rows.map((row) => row.key))
  })

  it("shows ten batches without a disclosure", () => {
    const { rows, groups } = manyBatches(10)
    const lines = Subagents.lines(rows, groups)
    expect(lines.filter((line) => line.kind === "grid")).toHaveLength(10)
    expect(lines.some((line) => line.kind === "earlier")).toBe(false)
  })

  it("folds the eleventh's oldest grid in its original slot, preserving messages", () => {
    const { rows, groups } = manyBatches(11)
    const lines = Subagents.lines(rows, groups)
    expect(lines.slice(0, 3).map((line) => line.key)).toEqual([rows[0]!.key, Subagents.earlierKey(), rows[1]!.key])
    expect(lines.filter((line) => line.kind === "earlier")).toEqual([{
      kind: "earlier",
      key: Subagents.earlierKey(),
      batches: 1
    }])
    expect(lines.filter((line) => line.kind === "grid")).toHaveLength(10)
    expect(lines.map((line) => line.key)).not.toContain("batch:batch-0")
    expect(lines.filter((line) => line.kind === "row").map((line) => line.key)).toEqual(rows.map((row) => row.key))
    expect(Subagents.lines(rows, groups, true).filter((line) => line.kind === "grid")).toHaveLength(11)
  })

  it("counts multiple older batches once and selects them by time even if restored groups arrive out of order", () => {
    const { rows, groups } = manyBatches(13)
    const lines = Subagents.lines(rows, groups.toReversed())
    expect(lines.filter((line) => line.kind === "earlier")).toEqual([{
      kind: "earlier",
      key: Subagents.earlierKey(),
      batches: 3
    }])
    expect(lines.filter((line) => line.kind === "grid").map((line) => line.batch.at)).toEqual(
      groups.slice(3).map((group) => group.at)
    )
    expect(lines.filter((line) => line.kind === "row")).toHaveLength(13)
    expect(lines.map((line) => line.key)).not.toContain("batch:batch-0")
    const opened = Subagents.lines(rows, groups, true)
    expect(opened.filter((line) => line.kind === "grid")).toHaveLength(13)
    expect(opened.some((line) => line.kind === "earlier")).toBe(false)
  })

  it("places a filtered oldest anchor at its time and scopes a worker's disclosure separately", () => {
    const { rows, groups } = manyBatches(11, "parent")
    const lines = Subagents.lines(rows.slice(1), groups, false, "parent")
    expect(lines[0]).toEqual({ kind: "earlier", key: Subagents.earlierKey("parent"), batches: 1 })
    expect(Subagents.earlierKey("parent")).not.toBe(Subagents.earlierKey())
    expect(Subagents.lines([], [])).toEqual([])
  })
})
