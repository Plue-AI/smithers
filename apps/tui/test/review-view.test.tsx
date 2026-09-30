import { testRender } from "@opentui/react/test-utils"
import { afterEach, expect, test } from "bun:test"
import { act, createRef } from "react"
import * as Changes from "../src/changes.ts"
import { ReviewView } from "../src/review-view.tsx"
import * as Transcript from "../src/transcript.ts"
import * as Undo from "../src/undo.ts"

let setup: Awaited<ReturnType<typeof testRender>> | undefined
afterEach(async () => {
  await act(async () => {
    setup?.renderer.destroy()
    setup = undefined
  })
})

const call = (identity: string, ...patches: ReadonlyArray<Transcript.Patch>): Transcript.Call => ({
  flow: "bash",
  identity,
  subject: identity,
  status: "ok",
  startedAt: 0,
  patches
})
const run = (...calls: ReadonlyArray<Transcript.Call>): ReadonlyArray<Undo.Cell> => [{
  kind: "cell",
  id: "cell",
  index: 1,
  prose: "",
  source: "",
  status: "done",
  calls,
  printed: "",
  startedAt: 0
}]
const edit = Changes.patch(
  "math.js",
  "export function add(a, b) { return a - b; }\n",
  "export function add(a, b) { return a + b; }\n"
)!
// The shell redirect first creates an empty log, then a later run writes it.
const empty = Changes.patch("check.log", null, "")!
const log = Changes.patch("check.log", "", "2 checks passed\n")!

const draw = async (cells: ReadonlyArray<Undo.Cell>) => {
  const scrollRef = createRef<((by: number, page: boolean) => void) | undefined>() as {
    current: ((by: number, page: boolean) => void) | undefined
  }
  setup = await testRender(
    <ReviewView title="Fix add in math.js and run check" changes={Undo.changes(cells)} scrollRef={scrollRef} />,
    { width: 90, height: 24 }
  )
  await setup.renderOnce()
  return { frame: setup.captureCharFrame(), scrollRef }
}

test("draws the run's combined diff: its name and totals, then each file and its lines", async () => {
  const { frame, scrollRef } = await draw(run(call("a", empty), call("b", edit), call("c", log)))
  expect(frame).toContain("Fix add in math.js and run check  2 files +2 −1")
  expect(frame).not.toContain("undone")
  expect(frame).toMatch(/check\.log {2}new/)
  expect(frame).toMatch(/math\.js {2}\+1 −1/)
  expect(frame).toContain("- export function add(a, b) { return a - b; }")
  expect(frame).toContain("+ export function add(a, b) { return a + b; }")
  expect(frame).toContain("+ 2 checks passed")
  // The empty file's creation has no lines to show; its `new` says it.
  expect(frame).not.toContain("/dev/null")
  expect(frame.indexOf("check.log  new")).toBeLessThan(frame.indexOf("math.js  +1 −1"))
  expect(scrollRef.current).toBeDefined()
})

test("marks an undone file, and the whole run once every file is undone", async () => {
  const partly = await draw(run(call("a", { ...edit, undone: true }), call("b", log)))
  expect(partly.frame).toMatch(/math\.js {2}\+1 −1 · undone/)
  expect(partly.frame).toContain("2 files +2 −1")
  expect(partly.frame).not.toContain("2 files +2 −1 · undone")
  await act(async () => {
    setup?.renderer.destroy()
    setup = undefined
  })
  const all = await draw(run(call("a", { ...edit, undone: true }), call("b", { ...log, undone: true })))
  expect(all.frame).toContain("2 files +2 −1 · undone")
  expect(all.frame).not.toMatch(/math\.js {2}\+1 −1 · undone/)
})

test("shows a binary or large change as its label", async () => {
  const { frame } = await draw(run(call("a", { path: "logo.png", patch: "Binary or large file: logo.png" })))
  expect(frame).toContain("1 file")
  expect(frame).toContain("Binary or large file: logo.png")
})
