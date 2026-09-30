import { testRender } from "@opentui/react/test-utils"
import { afterEach, describe, expect, it } from "bun:test"
import { act, type ReactNode, useState } from "react"
import stringWidth from "string-width"
import * as View from "../src/subagent-view.tsx"
import * as Subagents from "../src/subagents.ts"
import { color } from "../src/theme.ts"
import * as Timeline from "../src/timeline.ts"
import * as Transcript from "../src/transcript.ts"
import * as Tree from "../src/tree.ts"
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

describe("overview component ownership", () => {
  const root = tab("root", { title: "Root audit" })
  const child = tab("child", { parent: "root", title: "Child edit" })
  const other = tab("other", { title: "Other work" })
  const nodes = Tree.walk([root, other, child])
  for (const selected of ["chat", "unknown"]) {
    it(`shows review for ${selected} without creating worker cards`, async () => {
      const { cards, opened } = recorder()
      const chosen: string[] = []
      const scrollRef = { current: undefined as ((direction: number) => void) | undefined }
      const mounted = await mount(
        <View.Overview
          nodes={nodes}
          selected={selected}
          pane="tree"
          width={80}
          cards={cards}
          onSelect={(id) => chosen.push(id)}
          review={<text>Conversation review</text>}
          scrollRef={scrollRef}
        />
      )
      const frame = mounted.captureCharFrame()
      expect(frame).toContain("Summary")
      expect(frame).toContain("Conversation review")
      expect(frame).not.toContain("42s · sol")
      await clickText("Chat")
      await clickText("Root audit")
      expect(chosen).toEqual(["chat", "root"])
      expect(opened).toEqual([])
      if (selected === "chat") expect(scrollRef.current).toBeUndefined()
      else {
        await act(() => scrollRef.current?.(1))
        await act(() => mounted.renderOnce())
        expect(mounted.captureCharFrame()).toBe(frame)
      }
    })
  }
  it("draws only the selected branch and descendants and opens the exact card", async () => {
    const { cards, opened } = recorder()
    const mounted = await mount(
      <View.Overview
        nodes={nodes}
        selected="root"
        pane="cards"
        width={100}
        cards={cards}
        onSelect={() => {}}
        review={<text>Conversation review</text>}
      />,
      100,
      14
    )
    const frame = mounted.captureCharFrame()
    expect(frame).not.toContain("Conversation review")
    expect(frame.match(/Root audit/g)?.length).toBe(3)
    expect(frame.match(/Child edit/g)?.length).toBe(2)
    expect(frame.match(/Other work/g)?.length).toBe(1)
    expect(frame.match(/42s · sol/g)?.length).toBe(2)
    const lines = frame.split("\n")
    const y = lines.findIndex((line) => line.includes("Root audit") && line.includes("▌"))
    await act(() => mounted.mockMouse.click(lines[y]!.indexOf("▌") + 3, y))
    expect(opened).toEqual(["root"])
  })
  it("reveals selection and focused card in a short pane and forwards viewport scroll", async () => {
    const workers = Array.from({ length: 12 }, (_, n) => tab(`w${n}`, { title: `Worker ${n}` }))
    const cards = recorder().cards
    const scrollRef = { current: undefined as ((direction: number) => void) | undefined }
    type Selection = { selected: string; pane: "tree" | "cards"; focused: string | undefined }
    let change: ((value: Selection) => void) | undefined
    function Harness() {
      const [state, setState] = useState<Selection>({ selected: "chat", pane: "tree", focused: undefined })
      change = setState
      return (
        <View.Overview
          nodes={Tree.walk(workers)}
          selected={state.selected}
          pane={state.pane}
          width={70}
          cards={{ ...cards, focused: state.focused }}
          onSelect={() => {}}
          review={<text>Review</text>}
          scrollRef={scrollRef}
        />
      )
    }
    const mounted = await mount(<Harness />, 70, 5)
    expect(mounted.captureCharFrame()).toContain("Chat")
    await act(() => change!({ selected: "w11", pane: "cards", focused: "agent:w11" }))
    await act(() => mounted.renderOnce())
    expect(mounted.captureCharFrame().match(/Worker 11/g)?.length).toBe(3)
    expect(mounted.captureCharFrame()).not.toContain("Review")
    expect(typeof scrollRef.current).toBe("function")
    await act(() => scrollRef.current!(1))
    await act(() => mounted.renderOnce())
    expect(mounted.captureCharFrame()).toContain("Worker 11")
  })
  it("scrolls the focused descendant card into view without changing selection", async () => {
    const workers = [
      tab("parent", { title: "Parent" }),
      ...Array.from({ length: 12 }, (_, n) => tab(`child${n}`, { parent: "parent", title: `Child ${n}` }))
    ]
    const cards = recorder().cards
    let focus: ((key: string) => void) | undefined
    function Harness() {
      const [focused, setFocused] = useState<string | undefined>(undefined)
      focus = setFocused
      return (
        <View.Overview
          nodes={Tree.walk(workers)}
          selected="parent"
          pane="cards"
          width={70}
          cards={{ ...cards, focused }}
          onSelect={() => {}}
          review={<text>Review</text>}
        />
      )
    }
    const mounted = await mount(<Harness />, 70, 6)
    expect(mounted.captureCharFrame()).not.toContain("Child 11")
    await act(() => focus!("agent:child11"))
    await act(() => mounted.renderOnce())
    expect(mounted.captureCharFrame()).toContain("Child 11")
    expect(mounted.captureCharFrame()).toContain("Parent")
    expect(mounted.captureCharFrame()).not.toContain("Review")
  })
  it("moves an overflowing branch viewport in both directions", async () => {
    const workers = [
      tab("parent", { title: "Parent" }),
      ...Array.from({ length: 8 }, (_, n) => tab(`child${n}`, { parent: "parent", title: `Child ${n}` }))
    ]
    const scrollRef = { current: undefined as ((direction: number) => void) | undefined }
    const mounted = await mount(
      <View.Overview
        nodes={Tree.walk(workers)}
        selected="parent"
        pane="cards"
        width={70}
        cards={recorder().cards}
        onSelect={() => {}}
        review={<text>Review</text>}
        scrollRef={scrollRef}
      />,
      70,
      6
    )
    const initial = mounted.captureCharFrame()
    expect(initial).toContain("▌◐ Parent")
    expect(initial).not.toContain("▌◐ Child 1")
    await act(() => scrollRef.current?.(1))
    await act(() => mounted.renderOnce())
    const advanced = mounted.captureCharFrame()
    expect(advanced).not.toContain("▌◐ Parent")
    expect(advanced).toContain("▌◐ Child 0")
    await act(() => scrollRef.current?.(-1))
    await act(() => mounted.renderOnce())
    expect(mounted.captureCharFrame()).toBe(initial)
  })
  it("clips wide Unicode tree labels within a narrow terminal", async () => {
    const mounted = await mount(
      <View.Overview
        nodes={Tree.walk([tab("wide", { title: "界界界界界界界界界界界界界界界" })])}
        selected="chat"
        pane="cards"
        width={35}
        cards={recorder().cards}
        onSelect={() => {}}
        review={<text>Review</text>}
      />,
      35,
      4
    )
    expect(mounted.captureCharFrame()).toContain("Review")
    expect(mounted.captureCharFrame()).not.toContain("界界界界界界界界界界界界界界界")
    for (const line of mounted.captureCharFrame().split("\n")) expect(stringWidth(line)).toBeLessThanOrEqual(35)
  })
})

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
      expect(frame).toContain("42s · sol")
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
      row={(line) => {
        rows.push(line)
        return <text key={line.key}>Parent receipt</text>
      }}
    />
  )
  const frame = mounted.captureCharFrame()
  expect(rows).toEqual([row])
  expect(rows[0]).toBe(row)
  expect(frame).toContain("Ran 1 subagent ✓")
  expect(frame).toContain("◉ Completed audit finished")
  expect(frame.indexOf("Parent receipt")).toBeLessThan(frame.indexOf("Ran 1 subagent ✓"))
  expect(frame.indexOf("Ran 1 subagent ✓")).toBeLessThan(frame.indexOf("◉ Completed audit finished"))
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

it("a narrow worker tree reserves duration while clipping CJK titles by columns", async () => {
  const worker = tab("wide", { title: "界界界界界界界界界界界界界界界" })
  const mounted = await mount(
    <View.Overview
      nodes={[{ tab: worker, level: 0 }]}
      selected="chat"
      pane="tree"
      width={35}
      cards={recorder().cards}
      onSelect={() => {}}
      review={<text>Review</text>}
    />,
    35,
    4
  )
  const row = mounted.captureCharFrame().split("\n")[2]!
  expect(row).toContain("界界界界界…")
  expect(row).toContain("42s")
})
