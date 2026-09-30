import { testRender } from "@opentui/react/test-utils"
import { afterEach, describe, expect, it } from "bun:test"
import { act, type ReactNode } from "react"
import stringWidth from "string-width"
import * as View from "../src/subagent-view.tsx"
import * as Subagents from "../src/subagents.ts"
import { color } from "../src/theme.ts"
import * as Timeline from "../src/timeline.ts"
import * as Transcript from "../src/transcript.ts"
import type { Tab } from "../src/workspace.ts"

const tab = (id: string, extra: Partial<Tab> = {}): Tab => ({
  id,
  depth: 0,
  title: id,
  prompt: `Do ${id}`,
  seat: "openai:gpt-6-sol",
  file: `/tmp/${id}.jsonl`,
  status: "running",
  startedAt: 0,
  ...extra
})
const recorder = () => {
  const opened: string[] = []
  const files: string[] = []
  const actions: Array<[Tab, Parameters<View.Cards["onAction"]>[1]]> = []
  const cards: View.Cards = {
    transcript: () => Transcript.empty,
    models: [],
    now: 42_000,
    lane: () => color.info,
    focused: undefined,
    open: new Set(),
    onOpen: (id) => opened.push(id),
    onFiles: (id) => files.push(id),
    onAction: (worker, action) => actions.push([worker, action])
  }
  return { cards, opened, files, actions }
}
let setup: Awaited<ReturnType<typeof testRender>> | undefined
afterEach(() => {
  if (setup !== undefined) act(() => setup?.renderer.destroy())
  setup = undefined
})
const mount = async (node: ReactNode, width = 80, height = 12) => {
  setup = await act(() => testRender(node, { width, height }))
  await act(() => setup!.renderOnce())
  return setup
}
const clickText = async (text: string) => {
  const lines = setup!.captureCharFrame().split("\n")
  const y = lines.findIndex((line) => line.includes(text))
  expect(y).toBeGreaterThanOrEqual(0)
  const x = stringWidth(lines[y]!.slice(0, lines[y]!.indexOf(text)))
  await act(() => setup!.mockMouse.click(x + 1, y))
}

describe("breadcrumb and card click ownership", () => {
  it("renders ancestry and sends a breadcrumb click once to Back", async () => {
    const backs: number[] = []
    const mounted = await mount(
      <View.Crumb title="Child 界" tone={color.info} path={["Chat", "Parent"]} onBack={() => backs.push(1)} />,
      60,
      3
    )
    expect(mounted.captureCharFrame()).toContain("Subagent · Child 界")
    expect(mounted.captureCharFrame()).toContain("Chat › Parent › Child 界")
    await clickText("Back (ctrl+y)")
    expect(backs).toEqual([1])
  })
  it("runs action chips with the original worker without opening its parent card", async () => {
    const worker = tab("active")
    const { cards, actions, opened, files } = recorder()
    const mounted = await mount(
      <View.Grid tabs={[worker]} width={80} cards={{ ...cards, focused: "agent:active" }} />,
      80,
      4
    )
    expect(mounted.captureCharFrame()).toContain("[x Stop] [s Steer]")
    await clickText("[x Stop]")
    await clickText("[s Steer]")
    expect(actions).toEqual([[worker, "stop"], [worker, "steer"]])
    expect(actions[0]![0]).toBe(worker)
    expect(opened).toEqual([])
    expect(files).toEqual([])
    await clickText("active")
    expect(opened).toEqual(["active"])
  })
  it("toggles changed files without opening the worker and draws expanded patch counts", async () => {
    const worker = tab("files")
    const { cards, files, opened, actions } = recorder()
    const transcript: Transcript.Transcript = {
      ...Transcript.empty,
      items: [{
        kind: "cell",
        id: "0",
        index: 1,
        prose: "Updated the file",
        source: "",
        status: "done",
        calls: [{
          flow: "edit",
          subject: "src/界.ts",
          status: "ok",
          startedAt: 0,
          patches: [{ path: "src/界.ts", patch: "--- a\n+++ b\n+one\n+two\n-old" }]
        }],
        printed: "",
        startedAt: 0
      }]
    }
    const mounted = await mount(
      <View.Grid
        tabs={[worker]}
        width={70}
        cards={{ ...cards, transcript: () => transcript, open: new Set(["files"]) }}
      />,
      70,
      9
    )
    const frame = mounted.captureCharFrame()
    expect(frame).toContain("src/界.ts")
    expect(frame).toContain("+2 -1")
    const lines = frame.split("\n")
    const y = lines.findIndex((line) => line.includes("file") && !line.includes("Updated") && !line.includes("▌◐"))
    expect(y).toBeGreaterThanOrEqual(0)
    await act(() => mounted.mockMouse.click(4, y))
    expect(files).toEqual(["files"])
    expect(opened).toEqual([])
    expect(actions).toEqual([])
  })
  for (const width of [18, 26, 80]) {
    it(`fits whole action chips at ${width} columns`, async () => {
      const { cards } = recorder()
      const mounted = await mount(
        <View.Grid
          tabs={[tab("wide", { title: "界界界界界界界界界界" })]}
          width={width}
          cards={{ ...cards, focused: "agent:wide" }}
        />,
        width,
        4
      )
      const frame = mounted.captureCharFrame()
      expect(frame).toContain("42s · ")
      if (width === 18) expect(frame).not.toContain("[x")
      else expect(frame).toContain("[x Stop]")
      if (width < 80) expect(frame).not.toContain("[s")
      else expect(frame).toContain("[s Steer]")
      for (const line of frame.split("\n")) expect(stringWidth(line)).toBeLessThanOrEqual(width)
    })
  }
})

it("keeps parent rows, completed worker grids and settlement markers in supplied order", async () => {
  const worker = tab("done", { title: "Completed audit", status: "done", endedAt: 64_000 })
  const row: Extract<Subagents.Line, { kind: "row" }> = {
    kind: "row",
    key: "parent",
    row: Timeline.rows(Transcript.note(Transcript.empty, "Parent receipt", 1))[0]!
  }
  const rows: Array<typeof row> = []
  const mounted = await mount(
    <View.Lines
      lines={[
        row,
        { kind: "grid", key: "batch", batch: { key: "batch", anchor: "parent", at: 0, tabs: [worker] } },
        { kind: "finished", key: "settled", tab: worker }
      ]}
      width={80}
      cards={recorder().cards}
      onEarlier={() => {}}
      row={(line) => {
        rows.push(line)
        return <text key={line.key}>Parent receipt</text>
      }}
    />
  )
  const frame = mounted.captureCharFrame()
  expect(rows).toEqual([row])
  expect(rows[0]).toBe(row)
  expect(frame).toContain("✓ Completed audit · done at 1m 04s")
  expect(frame).toContain("◉ Completed audit done")
  expect(frame.indexOf("Parent receipt")).toBeLessThan(frame.indexOf("✓ Completed audit · done"))
  expect(frame.indexOf("✓ Completed audit · done")).toBeLessThan(frame.indexOf("◉ Completed audit done"))
})

it("summarizes earlier activity and retains a failed tool's visible result", async () => {
  const transcript: Transcript.Transcript = {
    ...Transcript.empty,
    items: [{
      kind: "cell",
      id: "0",
      index: 1,
      prose: "",
      source: "",
      status: "done",
      printed: "",
      startedAt: 0,
      calls: Array.from({ length: 8 }, (_, n): Transcript.Call => ({
        flow: "read",
        subject: `file${n}.ts`,
        status: n === 7 ? "failed" : "ok",
        startedAt: n
      }))
    }]
  }
  const mounted = await mount(
    <View.Grid tabs={[tab("history")]} width={60} cards={{ ...recorder().cards, transcript: () => transcript }} />,
    60,
    10
  )
  const frame = mounted.captureCharFrame()
  expect(frame).toContain("… +3 earlier")
  expect(frame).not.toContain("file0.ts")
  expect(frame).toContain("└ Read file7.ts ✗")
})

for (const width of [18, 80]) {
  it(`renders one bounded native earlier row and activates it by mouse at ${width} columns`, async () => {
    let opened = 0
    const mounted = await mount(
      <View.Lines
        lines={[{ kind: "earlier", key: "subagents:earlier", batches: 3 }]}
        width={width}
        cards={{ ...recorder().cards, focused: "subagents:earlier" }}
        row={() => {
          throw new Error("Earlier row must not render a transcript item")
        }}
        onEarlier={() => opened++}
      />,
      width,
      2
    )
    const lines = mounted.captureCharFrame().split("\n")
    expect(lines[0]).toContain("3 earlier")
    for (const line of lines) expect(stringWidth(line)).toBeLessThanOrEqual(width)
    expect(lines[1]!.trim()).toBe("")
    await act(() => mounted.mockMouse.click(2, 0))
    expect(opened).toBe(1)
  })
}
