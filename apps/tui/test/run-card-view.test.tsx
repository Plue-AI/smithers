import { testRender } from "@opentui/react/test-utils"
import { afterEach, expect, test } from "bun:test"
import { act } from "react"
import stringWidth from "string-width"
import { RunCardView } from "../src/run-card-view.tsx"
import * as RunCard from "../src/run-card.ts"
import * as Theme from "../src/theme.ts"
import * as Transcript from "../src/transcript.ts"
import type { Tab } from "../src/workspace.ts"

let setup: Awaited<ReturnType<typeof testRender>> | undefined
afterEach(() => {
  if (setup !== undefined) act(() => setup?.renderer.destroy())
  setup = undefined
})
const tab: Tab = {
  id: "fix",
  depth: 0,
  title: "Fix addition",
  prompt: "Fix.",
  seat: "test",
  file: "session",
  status: "done",
  startedAt: 0,
  endedAt: 41_000,
  answer: "It now returns a + b.\nThe check passes.\nMore detail."
}
const changed: Transcript.Transcript = {
  ...Transcript.empty,
  items: [{
    kind: "cell",
    id: "c",
    index: 1,
    source: "",
    prose: "",
    status: "done",
    startedAt: 0,
    printed: "",
    calls: [
      {
        flow: "edit",
        subject: "math.js",
        status: "ok",
        startedAt: 1,
        patches: [{ path: "math.js", patch: "--- a/math.js\n+++ b/math.js\n@@ -1 +1 @@\n-return a - b\n+return a + b" }]
      },
      { flow: "bash", subject: "node check.mjs", status: "ok", exit: 0, startedAt: 2 }
    ]
  }]
}
const mount = async (
  card: RunCard.Card,
  width: number,
  height: number,
  callbacks: { onOpen: () => void; onDiff?: () => void; onUndo?: () => void }
) => {
  setup = await act(() =>
    testRender(
      <RunCardView id="agent:fix" card={card} width={width} focused lane={Theme.color.info} {...callbacks} />,
      { width, height }
    )
  )
  await act(() => setup!.renderOnce())
  return setup
}
const click = async (text: string) => {
  const lines = setup!.captureCharFrame().split("\n")
  const y = lines.findIndex((line) => line.includes(text))
  expect(y).toBeGreaterThanOrEqual(0)
  const x = stringWidth(lines[y]!.slice(0, lines[y]!.indexOf(text)))
  await act(async () => setup!.mockMouse.click(x + 1, y))
}

test.each([[110, 32], [80, 24]])(
  "settled card keeps its answer, receipts and keys visible at %s×%s",
  async (width, height) => {
    const calls: string[] = []
    await mount(RunCard.worker(tab, changed, 90_000), width, height, {
      onOpen: () => calls.push("open"),
      onDiff: () => calls.push("diff"),
      onUndo: () => calls.push("undo")
    })
    const frame = setup!.captureCharFrame()
    expect(frame).toContain("Fix addition · 41s")
    expect(frame).toContain("It now returns a + b.")
    expect(frame).toContain("The check passes.")
    expect(frame).not.toContain("More detail.")
    expect(frame).toContain("math.js +1")
    expect(frame).toContain("node check.mjs exit 0")
    expect(frame).toContain("d Diff  u Undo  enter Open")
    expect(frame).not.toContain("finished")
    await click("d Diff")
    await click("u Undo")
    expect(calls).toEqual(["diff", "undo"])
    await click("enter Open")
    await click("Fix addition")
    expect(calls).toEqual(["diff", "undo", "open", "open"])
  }
)

test("a scalar flow result uses the same card as one compact line", async () => {
  const card = RunCard.flow({
    id: "words",
    flow: "wordcount",
    by: "user",
    input: {},
    requested: "{}",
    status: "done",
    startedAt: 0,
    endedAt: 40,
    answer: "5"
  }, 90_000)
  const opened: string[] = []
  await mount(card, 80, 24, { onOpen: () => opened.push(card.surface) })
  const lines = setup!.captureCharFrame().split("\n").filter((line) => line.trim() !== "")
  expect(lines).toHaveLength(1)
  expect(lines[0]).toContain("wordcount · 40ms → 5")
  await click("wordcount")
  expect(opened).toEqual(["flow:words"])
})

test("a pending run without steps draws only its header", async () => {
  const card = RunCard.flow({
    id: "words",
    flow: "wordcount",
    by: "user",
    input: {},
    requested: "{}",
    status: "requested",
    startedAt: 0
  }, 0)
  await mount(card, 80, 24, { onOpen: () => {} })
  const rows = setup!.captureCharFrame().split("\n").filter((line) => line.trim() !== "")
  expect(rows).toHaveLength(1)
  expect(rows[0]).toContain("wordcount · requested")
})

test.each([80, 40])("a long scalar flow result stays one row at %s columns", async (width) => {
  const card = RunCard.flow({
    id: "pipeline",
    flow: "pipeline",
    by: "user",
    input: {},
    requested: "{}",
    status: "done",
    startedAt: 0,
    endedAt: 4_000,
    answer: "x".repeat(200)
  }, 9_000)
  await mount(card, width, 8, { onOpen: () => {} })
  const rows = setup!.captureCharFrame().split("\n").filter((line) => line.trim() !== "")
  expect(rows).toHaveLength(1)
  expect(rows[0]).toContain("✓ pipeline · 4s →")
  expect(stringWidth(rows[0]!)).toBeLessThanOrEqual(width)
})

test("undone receipts keep Diff and Open while removing Undo", async () => {
  const history = {
    ...changed,
    items: changed.items.map((item) =>
      item.kind !== "cell"
        ? item
        : ({
          ...item,
          calls: item.calls.map((call) => ({
            ...call,
            patches: call.patches?.map((patch) => ({ ...patch, undone: true as const }))
          }))
        })
    )
  }
  await mount(RunCard.worker(tab, history, 90_000), 80, 24, { onOpen: () => {} })
  expect(setup!.captureCharFrame()).toContain("undone")
  expect(setup!.captureCharFrame()).toContain("d Diff")
  expect(setup!.captureCharFrame()).toContain("enter Open")
  expect(setup!.captureCharFrame()).not.toContain("u Undo")
})

test.each([
  { title: "report-" + "x".repeat(70), status: "done" as const },
  { title: "report-" + "x".repeat(70), status: "failed" as const },
  { title: "report-" + "界".repeat(70), status: "done" as const },
  { title: "report-" + "界".repeat(70), status: "failed" as const }
])("a long $status flow title preserves its outcome in a 78-column card", async ({ title, status }) => {
  const card = RunCard.flow({
    id: "long",
    flow: title,
    by: "user",
    input: {},
    requested: "{}",
    startedAt: 0,
    endedAt: 40,
    status,
    ...(status === "done" ? { answer: "5" } : { failure: "Check exited 7." })
  }, 90_000)
  await mount(card, 78, 24, { onOpen: () => {} })
  const rows = setup!.captureCharFrame().split("\n").filter((row) => row.trim() !== "")
  expect(rows[0]).toContain(status === "done" ? "→ 5" : "failed: Check exited 7.")
  expect(rows[0]).toContain("report-")
  expect(stringWidth(rows[0]!)).toBeLessThanOrEqual(78)
  if (status === "done") expect(rows).toHaveLength(1)
})
