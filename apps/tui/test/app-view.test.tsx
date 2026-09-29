import { testRender } from "@opentui/react/test-utils"
import { afterEach, expect, test } from "bun:test"
import { act, type ReactNode } from "react"
import * as AppView from "../src/app-view.tsx"
import type * as Complete from "../src/complete.ts"
import type * as Extension from "../src/extension.ts"
import type { FlowForm } from "../src/key-dispatch.ts"
import type * as Models from "../src/models.ts"
import * as Transcript from "../src/transcript.ts"

let setup: Awaited<ReturnType<typeof testRender>> | undefined
afterEach(async () => {
  await act(async () => {
    setup?.renderer.destroy()
    setup = undefined
  })
})
const draw = async (node: ReactNode, height = 24) => {
  setup = await testRender(node, { width: 80, height })
  await setup.renderOnce()
  return setup.captureCharFrame()
}
const choices = Array.from(
  { length: 20 },
  (_, index) => ({ key: `choice-${index}`, label: `Choice ${String(index).padStart(2, "0")}` })
)

const composerModels: ReadonlyArray<Models.Model> = [
  { seat: "replay:chat", label: "Chat model", provider: "Replay" },
  { seat: "openai:gpt-6-sol", label: "GPT-6 Sol", provider: "OpenAI" }
]

test("chat composer names its model and provider", async () => {
  const frame = await draw(
    <text>
      <AppView.ComposerModel seat="replay:chat" models={composerModels} />
    </text>
  )
  expect(frame).toContain("Chat model")
  expect(frame).toContain("Replay")
})

test("composer names the driven worker's seat instead of the chat seat", async () => {
  const driven = await draw(
    <text>
      <AppView.ComposerModel seat="replay:chat" models={composerModels} worker={{ seat: "openai:gpt-6-sol" }} />
    </text>
  )
  expect(driven).toContain("sol")
  expect(driven).not.toContain("Chat model")
  expect(driven).not.toContain("Replay")
  expect(driven).not.toContain("OpenAI")
})

test("composer uses the worker's active routed seat when one is answering", async () => {
  const frame = await draw(
    <text>
      <AppView.ComposerModel
        seat="replay:chat"
        models={composerModels}
        worker={{ seat: "auto", activeSeat: "openai:gpt-6-sol" }}
      />
    </text>
  )
  expect(frame).toContain("sol")
  expect(frame).not.toContain("Chat model")
})

test("composer leaves an unjudged worker as auto, without naming the chat model", async () => {
  const frame = await draw(
    <text>
      <AppView.ComposerModel seat="replay:chat" models={composerModels} worker={{ seat: "auto" }} />
    </text>
  )
  expect(frame).toContain("auto")
  expect(frame).not.toContain("Chat model")
  expect(frame).not.toContain("Replay")
})

test("composer names a driven Claude Code seat by its alias", async () => {
  const frame = await draw(
    <text>
      <AppView.ComposerModel seat="replay:chat" models={composerModels} worker={{ seat: "claude-code:opus" }} />
    </text>
  )
  expect(frame).toContain("opus")
  expect(frame).not.toContain("Chat model")
})

test.each([
  { height: 12, selected: 0, shown: [0, 1, 2, 3, 4, 5] },
  { height: 12, selected: 19, shown: [14, 15, 16, 17, 18, 19] },
  { height: 19, selected: 10, shown: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16] },
  { height: 20, selected: 10, shown: [8, 9, 10, 11] },
  { height: 24, selected: 10, shown: [7, 8, 9, 10, 11, 12] }
])("picker height $height keeps selection $selected visible", async ({ height, selected, shown }) => {
  const frame = await draw(
    <AppView.PickerDialog
      title="Select model"
      query=""
      onQuery={() => {}}
      rows={choices}
      selected={selected}
      empty="No models"
      width={80}
      height={height}
    />,
    height
  )
  expect(frame).toContain("Select model")
  expect(frame).toContain("Search")
  expect(frame).toContain(`${selected + 1}/20`)
  expect(choices.filter((row) => frame.includes(row.label)).map((row) => Number(row.key.slice(7)))).toEqual([...shown])
})
test.each([12, 24])("empty picker at height %s shows refusal and accepts filter typing", async (height) => {
  const queries: string[] = []
  const frame = await draw(
    <AppView.PickerDialog
      title="Flows"
      query=""
      onQuery={(query) => queries.push(query)}
      rows={[]}
      selected={0}
      empty="No flows in this directory"
      width={80}
      height={height}
    />,
    height
  )
  expect(frame).toContain("No flows in this directory")
  await act(async () => {
    await setup!.mockInput.typeText("abc")
  })
  expect(queries).toEqual(["a", "ab", "abc"])
})
test("confirmation has choices without capturing text as a query", async () => {
  const queries: string[] = []
  const frame = await draw(
    <AppView.PickerDialog
      title="Undo notes.txt?"
      query={undefined}
      onQuery={(query) => queries.push(query)}
      rows={[{ key: "undo", label: "Undo" }, { key: "cancel", label: "Cancel" }]}
      selected={1}
      empty="No choices"
      width={80}
      height={24}
    />
  )
  expect(frame).toContain("Undo notes.txt?")
  expect(frame).toContain("Cancel")
  expect(frame).not.toContain("Search")
  await act(async () => {
    await setup!.mockInput.typeText("abc")
  })
  expect(queries).toEqual([])
})
const completion = (kind: Complete.Completion["kind"], items: Complete.Completion["items"]): Complete.Completion => ({
  kind,
  query: "",
  start: 0,
  end: 0,
  items
})
test.each([["command", "No matching commands"], ["argument", "No matches"], ["file", "No matches"]] as const)(
  "empty %s completion shows %s",
  async (kind, message) => {
    const frame = await draw(
      <AppView.CompletionMenu menu={completion(kind, [])} selected={0} seat="test:model" thinking={undefined} />
    )
    expect(frame.trim()).toBe(`┃${message}`)
  }
)
test.each([["/model test:model", undefined], ["/thinking default", undefined], ["/thinking high", "high"]] as const)(
  "argument completion marks current %s",
  async (insert, thinking) => {
    const frame = await draw(
      <AppView.CompletionMenu
        menu={completion("argument", [{ label: "Current", insert, submit: true, hint: "Provider", detail: "Details" }, {
          label: "Other",
          insert: "/model other:model",
          submit: true
        }])}
        selected={1}
        seat="test:model"
        thinking={thinking}
      />
    )
    expect(frame).toContain("● Current")
    expect(frame).toContain("Provider")
    expect(frame).toContain("Details")
    expect(frame).not.toContain("● Other")
  }
)
test("completion caps rows and reveals the last selected result", async () => {
  const frame = await draw(
    <AppView.CompletionMenu
      menu={completion("file", choices.map((row) => ({ label: row.label, insert: row.label, submit: false })))}
      selected={19}
      seat="test:model"
      thinking={undefined}
      rows={3}
    />
  )
  expect(choices.filter((row) => frame.includes(row.label)).map((row) => row.key)).toEqual([
    "choice-17",
    "choice-18",
    "choice-19"
  ])
  expect(frame).toContain("20/20")
  expect(frame).not.toContain("●")
})
const form: FlowForm = {
  id: "request",
  flow: "Deploy",
  focus: 1,
  fields: [
    { name: "project", label: "Project", kind: "text", required: true },
    { name: "count", label: "Copies", kind: "number", required: true },
    { name: "enabled", label: "Enabled", kind: "boolean", required: true }
  ],
  draft: { project: "smithers", count: 2, enabled: false }
}
test.each([false, true])("form compact=%s preserves error and focused number callback", async (compact) => {
  const changes: Array<[string, string]> = []
  const frame = await draw(
    <AppView.FlowFormView
      form={{ ...form, error: "Choose a positive count" }}
      height={10}
      compact={compact}
      onField={(name, value) => changes.push([name, value])}
    />
  )
  expect(frame).toContain("Deploy")
  expect(frame).toContain("smithers")
  expect(frame).toContain("Copies")
  expect(frame).toContain("✗")
  expect(frame).toContain("Choose a positive count")
  await act(async () => {
    await setup!.mockInput.typeText("3")
  })
  expect(changes).toEqual([["count", "23"]])
})
test("short form reveals the final focused field and error", async () => {
  const frame = await draw(
    <AppView.FlowFormView
      form={{ ...form, focus: 2, draft: { ...form.draft, enabled: true }, error: "Confirm the choice" }}
      height={6}
      compact={false}
      onField={() => {}}
    />
  )
  expect(frame).toContain("3/3")
  expect(frame).toContain("Enabled")
  expect(frame).toContain("✓")
  expect(frame).toContain("Confirm the choice")
  expect(frame).not.toContain("Project")
  expect(frame).not.toContain("Copies")
})

test("missing focused text begins empty and publishes its field name with the typed value", async () => {
  const changes: Array<[string, string]> = []
  const frame = await draw(
    <AppView.FlowFormView
      form={{ ...form, focus: 0, draft: {} }}
      height={10}
      compact={true}
      onField={(name, value) => changes.push([name, value])}
    />
  )
  expect(frame).toContain("Project")
  expect(frame).not.toContain("smithers")
  expect(frame).toContain("✗")
  await act(async () => {
    await setup!.mockInput.typeText("new")
  })
  expect(changes).toEqual([["project", "n"], ["project", "ne"], ["project", "new"]])
})

test.each([
  { outdated: false, irrelevant: false, context: "" },
  { outdated: true, irrelevant: false, context: "context: outdated · compact?  " },
  { outdated: false, irrelevant: true, context: "context: irrelevant · compact?  " },
  { outdated: true, irrelevant: true, context: "context: outdated + irrelevant · compact?  " }
])("meter preserves context warning combination $outdated/$irrelevant", ({ outdated, irrelevant, context }) => {
  const transcript: Transcript.Transcript = {
    ...Transcript.empty,
    usage: { input: 12, output: 4, cached: 0, context: 75 },
    contextAssessment: { scope: "run", frame: 1, outdated, irrelevant }
  }
  expect(AppView.meter(transcript, 100, undefined)).toEqual({
    percent: 75,
    context,
    usage: "↑12 ↓4",
    window: "  75.0%/100"
  })
})

test("meter has no percentage label without a known window and includes cached and compaction counts", () => {
  const transcript: Transcript.Transcript = {
    ...Transcript.empty,
    usage: { input: 12, output: 4, cached: 3, context: 75 }
  }
  expect(AppView.meter(transcript, 0, 50)).toEqual({
    percent: 0,
    context: "",
    usage: "↑12 ↓4 R3",
    window: " cache 25%"
  })
  expect(AppView.meter(transcript, 100, 50)).toEqual({
    percent: 75,
    context: "",
    usage: "↑12 ↓4 R3",
    window: "  75.0%/100 · compact 50 cache 25%"
  })
})

test("status line renders the assessment and dispatches only the item actually clicked", async () => {
  const selected: Extension.Status[] = []
  const item: Extension.Status = { id: "review", text: "Review", tone: "warning" }
  const frame = await draw(
    <AppView.StatusLine
      lead="/workspace"
      hints={[]}
      items={[item]}
      onItem={(value) => selected.push(value)}
      meter={{ percent: 95, context: "context: outdated · compact?  ", usage: "↑12 ↓4", window: "  95.0%/100" }}
    />
  )
  expect(frame).toContain("/workspace")
  expect(frame).toContain("context: outdated · compact?")
  expect(frame).toContain("↑12 ↓4")
  expect(frame).toContain("95.0%/100")
  expect(selected).toEqual([])
  const lines = frame.split("\n")
  const y = lines.findIndex((line) => line.includes("Review"))
  await setup!.mockMouse.click(lines[y]!.indexOf("Review") + 1, y)
  expect(selected).toEqual([item])
  expect(selected[0]).toBe(item)
})
