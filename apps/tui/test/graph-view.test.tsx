import { testRender } from "@opentui/react/test-utils"
import { afterEach, expect, it } from "bun:test"
import { act, useState } from "react"
import type * as Graph from "../src/graph.ts"
import { GraphView } from "../src/subagent-view.tsx"

let setup: Awaited<ReturnType<typeof testRender>> | undefined
afterEach(() => {
  const mounted = setup
  setup = undefined
  if (mounted !== undefined) act(() => mounted.renderer.destroy())
})

const forest = (glyph: string): Graph.Node => ({
  key: "root",
  glyph,
  tone: "#ffffff",
  name: "root",
  sub: "sol",
  children: Array.from({ length: 8 }, (_, index) => ({
    key: `child ${index}`,
    glyph,
    tone: "#ffffff",
    name: `child ${index}`,
    sub: "sol",
    children: []
  }))
})

it("keeps where PageDown scrolled when the forest redraws, and scrolls only for a new selection", async () => {
  const scroll: { current: ((direction: number) => void) | undefined } = { current: undefined }
  let turn: (glyph: string) => void = () => {}
  let choose: (key: string) => void = () => {}
  function Spinning() {
    const [glyph, setGlyph] = useState("◐")
    const [selected, setSelected] = useState("root")
    turn = setGlyph
    choose = setSelected
    return <GraphView root={forest(glyph)} selected={selected} scrollRef={scroll} />
  }
  setup = await act(() => testRender(<Spinning />, { width: 70, height: 10 }))
  await act(() => setup!.renderOnce())
  expect(setup.captureCharFrame()).toContain("│ ◐ root")
  await act(async () => {
    scroll.current!(1)
    await setup!.renderOnce()
  })
  const scrolled = setup.captureCharFrame()
  expect(scrolled).not.toContain("root")
  // The spinner turns: the forest redraws, and the view stays where the person scrolled it.
  await act(async () => {
    turn("◓")
    await setup!.renderOnce()
  })
  await act(() => setup!.renderOnce())
  expect(setup.captureCharFrame()).toBe(scrolled.replaceAll("◐", "◓"))
  // A new selection scrolls its box into view.
  await act(async () => {
    choose("child 0")
    await setup!.renderOnce()
  })
  // The scroll waits for layout.
  await act(() => new Promise((done) => setTimeout(done, 10)))
  await act(() => setup!.renderOnce())
  expect(setup.captureCharFrame()).toContain("child 0")
})

it("opens scrolled to a selection far down the forest", async () => {
  setup = await act(() => testRender(<GraphView root={forest("●")} selected="child 7" />, { width: 70, height: 10 }))
  await act(() => setup!.renderOnce())
  await act(() => new Promise((done) => setTimeout(done, 10)))
  await act(() => setup!.renderOnce())
  expect(setup.captureCharFrame()).toContain("child 7")
})
