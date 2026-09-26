import type { ScrollBoxRenderable } from "@opentui/core"
import { testRender } from "@opentui/react/test-utils"
import { afterEach, expect, it } from "bun:test"
import { act, createRef, useState } from "react"
import * as DragScroll from "../src/drag-scroll.ts"

// The transcript's shape in app.tsx: a tab row above a sticky-bottom
// scroll box, a composer below, and the drag handlers on the root box.
const scroll = createRef<ScrollBoxRenderable>()
let setRows: (rows: number) => void = () => {}
let setup: Awaited<ReturnType<typeof testRender>> | undefined

const Transcript = (props: { readonly drag: DragScroll.DragScroll }) => {
  const [rows, set] = useState(80)
  setRows = set
  return (
    <box style={{ width: "100%", height: "100%", flexDirection: "column", paddingTop: 1 }} {...props.drag}>
      <text style={{ marginBottom: 1, flexShrink: 0 }}>Chat</text>
      <scrollbox ref={scroll} stickyScroll stickyStart="bottom" style={{ flexGrow: 1, flexShrink: 1, minHeight: 0 }}>
        {Array.from({ length: rows }, (_, index) => (
          <box key={index}>
            <text>row {index}</text>
          </box>
        ))}
      </scrollbox>
      <text style={{ height: 3, flexShrink: 0 }}>composer</text>
    </box>
  )
}

const mount = async () => {
  let drag: DragScroll.DragScroll | undefined
  setup = await testRender(
    <Transcript
      drag={{
        onMouseDown: (event) => drag!.onMouseDown(event),
        onMouseDrag: (event) => drag!.onMouseDrag(event),
        onMouseUp: (event) => drag!.onMouseUp(event)
      }}
    />,
    { width: 30, height: 20 }
  )
  drag = DragScroll.make(() => setup!.renderer.getSelection()?.isDragging === true)
  await setup.renderOnce()
  return { setup, box: scroll.current! }
}

/** Renders frames for `ms` of wall time, so autoscroll's clock advances. */
const frames = async (ms: number) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    await new Promise((resolve) => setTimeout(resolve, 16))
    await setup!.renderOnce()
  }
}

afterEach(() => {
  setup?.renderer.destroy()
  setup = undefined
})

it("wheel up scrolls the transcript and streamed rows do not snap it back", async () => {
  const { setup, box } = await mount()
  const bottom = box.scrollTop
  expect(bottom).toBeGreaterThan(0)
  for (let tick = 0; tick < 5; tick++) await setup.mockMouse.scroll(5, 10, "up")
  expect(box.scrollTop).toBe(bottom - 5)
  act(() => setRows(90))
  await setup.renderOnce()
  await setup.renderOnce()
  expect(box.scrollTop).toBe(bottom - 5)
})

it("a selection dragged above the transcript scrolls it up and extends the selection", async () => {
  const { setup, box } = await mount()
  const bottom = box.scrollTop
  await setup.mockMouse.pressDown(4, 12)
  await setup.mockMouse.emitMouseEvent("drag", 4, 8)
  await setup.mockMouse.emitMouseEvent("drag", 4, 0)
  await frames(400)
  expect(box.scrollTop).toBeLessThan(bottom - 5)
  await setup.mockMouse.release(4, 0)
  const selected = setup.renderer.getSelection()?.getSelectedText() ?? ""
  expect(selected).toContain(`row ${box.scrollTop}`)
  const settled = box.scrollTop
  await frames(100)
  expect(box.scrollTop).toBe(settled)
})

it("a selection dragged below the transcript scrolls it down", async () => {
  const { setup, box } = await mount()
  const bottom = box.scrollTop
  for (let tick = 0; tick < 20; tick++) await setup.mockMouse.scroll(5, 10, "up")
  expect(box.scrollTop).toBe(bottom - 20)
  await setup.renderOnce()
  await setup.mockMouse.pressDown(2, 6)
  await setup.mockMouse.emitMouseEvent("drag", 15, 10)
  await setup.mockMouse.emitMouseEvent("drag", 15, 19)
  await frames(400)
  expect(box.scrollTop).toBeGreaterThan(bottom - 15)
  await setup.mockMouse.release(15, 19)
})
