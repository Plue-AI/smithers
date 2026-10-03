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
  expect(driven).toContain("GPT-6 Sol")
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
  expect(frame).toContain("GPT-6 Sol")
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

test("composer names a driven Claude Code seat by the model it runs, as the picker does", async () => {
  const frame = await draw(
    <text>
      <AppView.ComposerModel seat="replay:chat" models={composerModels} worker={{ seat: "claude-code:opus" }} />
    </text>
  )
  expect(frame).toContain("Claude Opus 5.5")
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
test("the undo checklist lists files and its keys without capturing text as a query", async () => {
  const queries: string[] = []
  const frame = await draw(
    <AppView.PickerDialog
      title="Undo Fix add?"
      query={undefined}
      onQuery={(query) => queries.push(query)}
      rows={[{ key: "math.js", label: "[x] math.js", hint: "+1 −1" }, {
        key: "check.log",
        label: "[x] check.log",
        hint: "new"
      }]}
      selected={1}
      empty="No choices"
      width={80}
      height={24}
      keys={[
        { id: "undo-files", keys: ["enter"], label: "Undo 2 files", context: "checklist", group: "Undo" },
        { id: "undo-back", keys: ["esc"], label: "Back", context: "checklist", group: "Undo" }
      ]}
    />
  )
  expect(frame).toContain("Undo Fix add?")
  expect(frame).toMatch(/\[x\] math\.js\s+\+1 −1/)
  expect(frame).toMatch(/\[x\] check\.log\s+new/)
  expect(frame).toContain("enter Undo 2 files  esc Back")
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
      <AppView.CompletionMenu menu={completion(kind, [])} selected={0} seat="test:model" />
    )
    expect(frame.trim()).toBe(`┃${message}`)
  }
)
test.each(["/model test:model"] as const)(
  "argument completion marks current %s",
  async (insert) => {
    const frame = await draw(
      <AppView.CompletionMenu
        menu={completion("argument", [{ label: "Current", insert, submit: true, hint: "Provider", detail: "Details" }, {
          label: "Other",
          insert: "/model other:model",
          submit: true
        }])}
        selected={1}
        seat="test:model"
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
test.each([
  {
    terminal: 24,
    height: 10,
    compact: false,
    question:
      "Before implementing authentication, should the request carry the existing session cookie, or should it carry a bearer header for the remote workspace?",
    last: "workspace?"
  },
  // Word wrap needs a row per word here, more than the question's cells divided by the width.
  {
    terminal: 24,
    height: 10,
    compact: false,
    question: ["a", "b", "c"].map((letter) => letter.repeat(40)).join(" "),
    last: "c".repeat(40)
  },
  {
    terminal: 12,
    height: 8,
    compact: true,
    question: "First line\nSecond line with 界界 and 👩‍💻\nWhich workspace?",
    last: "Which workspace?"
  }
])(
  "an answer form at terminal height $terminal shows its whole wrapped question above its choices",
  async ({ terminal, height, compact, question, last }) => {
    const frame = await draw(
      <box style={{ width: 80, height: terminal }}>
        <box style={{ flexGrow: 1 }} />
        <AppView.FlowFormView
          form={{
            ...form,
            id: "ask:wrapped",
            fields: [],
            draft: {},
            ask: { question, options: ["Session cookie", "Bearer header"], choice: 0, armedAt: 0 }
          }}
          width={80}
          height={height}
          compact={compact}
          onField={() => {}}
        />
        <text wrapMode="none">Composer</text>
        <text wrapMode="none">Status</text>
      </box>,
      terminal
    )
    // The renderer's own wrapping sizes the question, so its last line is not cut off.
    expect(frame).toContain(question.slice(0, 10))
    expect(frame).toContain(last)
    expect(frame).toContain("> Session cookie")
    expect(frame).toContain("  Bearer header")
    expect(frame).toContain("  other…")
    expect(frame).toContain("Composer")
    expect(frame).toContain("Status")
  }
)
test.each([
  { terminal: 24, height: 8, compact: false, question: "Which workspace should the request carry? ".repeat(3) },
  { terminal: 12, height: 6, compact: true, question: "First line\nSecond line with 界界 and 👩‍💻\nWhich workspace?" },
  { terminal: 12, height: 6, compact: true, question: "Which workspace? ".repeat(80) }
])(
  "a typed answer keeps its text cursor under a question at terminal height $terminal",
  async ({ terminal, height, compact, question }) => {
    const changes: Array<[string, string]> = []
    const frame = await draw(
      <box style={{ width: 80, height: terminal }}>
        <box style={{ flexGrow: 1 }} />
        <AppView.FlowFormView
          form={{
            id: "ask:text",
            flow: "implement/api",
            focus: 0,
            fields: [],
            draft: { answer: "east" },
            ask: { question, options: [], choice: 0, armedAt: 0 }
          }}
          width={80}
          height={height}
          compact={compact}
          onField={(name, value) => changes.push([name, value])}
        />
        <text wrapMode="none">Composer</text>
        <text wrapMode="none">Status</text>
      </box>,
      terminal
    )
    expect(frame).toContain("◆ ")
    expect(frame).toContain("> east")
    expect(frame).toContain("Composer")
    expect(frame).toContain("Status")
    await act(async () => {
      await setup!.mockInput.typeText("!")
    })
    expect(changes).toEqual([["answer", "east!"]])
  }
)
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

const sum: FlowForm = {
  id: "sum-1",
  flow: "sum",
  focus: 2,
  fields: [
    { name: "a", label: "A", kind: "number", required: true },
    { name: "b", label: "B", kind: "number", required: true },
    {
      name: "unit",
      label: "Unit",
      kind: "select",
      required: true,
      options: [{ value: "kg", label: "kg" }, { value: "lb", label: "lb" }]
    }
  ],
  draft: { a: 2, b: 3 }
}
test("a choice shows every option before one is chosen, and fills the chosen one", async () => {
  const unchosen = await draw(<AppView.FlowFormView form={sum} height={10} compact={false} onField={() => {}} />)
  const unit = unchosen.split("\n").find((line) => line.includes("Unit"))!
  // Both options are visible with nothing chosen yet: no blank field until Right.
  expect(unit).toMatch(/Unit\s+kg\s+lb/)
  await act(async () => {
    setup!.renderer.destroy()
  })
  const chosen = await draw(
    <AppView.FlowFormView
      form={{ ...sum, draft: { ...sum.draft, unit: "lb" } }}
      height={10}
      compact={false}
      onField={() => {}}
    />
  )
  expect(chosen.split("\n").find((line) => line.includes("Unit"))).toMatch(/Unit\s+kg\s+lb/)
  // Every field's value is on the row, and labels take only the width they need.
  const lines = chosen.split("\n")
  expect(lines.find((line) => line.includes(" A ")) ?? "").toMatch(/A\s{5}\s*2/)
  expect(lines.find((line) => /\bB\b/.test(line))).toContain("3")
  expect(chosen).not.toContain("No estimate")
})
test("a value box is as wide as its text, between its bounds", () => {
  expect(AppView.boxWidth("", 8, 40)).toBe(8)
  expect(AppView.boxWidth("2", 8, 40)).toBe(8)
  expect(AppView.boxWidth("a longer value here", 8, 40)).toBe(21)
  expect(AppView.boxWidth("x".repeat(60), 8, 40)).toBe(40)
  expect(AppView.boxWidth("x", 8, 0)).toBe(1)
})
test.each([false, true])(
  "question paging compact=%s preserves choices and reverses to its first line",
  async (compact) => {
    const changes: Array<[string, string]> = []
    const frame = await draw(
      <AppView.FlowFormView
        form={{
          ...form,
          ask: {
            question: Array.from({ length: 18 }, (_, index) => `Question line ${index + 1}`).join("\n"),
            options: ["sum", "plus"],
            choice: 0,
            armedAt: 0
          }
        }}
        height={12}
        width={80}
        compact={compact}
        onField={(name, value) => changes.push([name, value])}
      />
    )
    expect(frame).toContain("◆ Question line 1")
    expect(frame).not.toContain("Question line 18")
    for (let page = 0; page < 5; page++) {
      await act(async () => {
        setup!.renderer.stdin.emit("data", Buffer.from("\x1b[6~"))
      })
      await setup!.renderOnce()
    }
    expect(setup!.captureCharFrame()).toContain("Question line 18")
    expect(setup!.captureCharFrame()).toContain("> sum")
    expect(setup!.captureCharFrame()).toContain("  plus")
    expect(setup!.captureCharFrame()).toContain("  other…")
    for (let page = 0; page < 5; page++) {
      await act(async () => {
        setup!.renderer.stdin.emit("data", Buffer.from("\x1b[5~"))
      })
      await setup!.renderOnce()
    }
    expect(setup!.captureCharFrame()).toContain("◆ Question line 1")
    expect(setup!.captureCharFrame()).not.toContain("Question line 18")
    expect(changes).toEqual([])
  }
)

test.each([
  { outdated: false, irrelevant: false, context: "" },
  { outdated: true, irrelevant: false, context: "context: outdated · compact?  " },
  { outdated: false, irrelevant: true, context: "context: irrelevant · compact?  " },
  { outdated: true, irrelevant: true, context: "context: outdated + irrelevant · compact?  " }
])("meter preserves context warning combination $outdated/$irrelevant", ({ outdated, irrelevant, context }) => {
  const transcript: Transcript.Transcript = {
    ...Transcript.empty,
    usage: { input: 12, output: 4, cached: 0, context: 75, usd: 0 },
    contextAssessment: { scope: "run", frame: 1, outdated, irrelevant }
  }
  expect(AppView.meter(transcript, 100)).toEqual({
    percent: 75,
    context,
    usage: "↑12 ↓4",
    window: "  75.0%/100"
  })
})

test("meter has no percentage label without a known window and includes the cache share", () => {
  const transcript: Transcript.Transcript = {
    ...Transcript.empty,
    usage: { input: 12, output: 4, cached: 3, context: 75, usd: 0 }
  }
  expect(AppView.meter(transcript, 0)).toEqual({
    percent: 0,
    context: "",
    usage: "↑12 ↓4 R3",
    window: " cache 25%"
  })
  expect(AppView.meter(transcript, 100)).toEqual({
    percent: 75,
    context: "",
    usage: "↑12 ↓4 R3",
    window: "  75.0%/100 cache 25%"
  })
})

test("meter shows the USD of priced calls beside the tokens", () => {
  const transcript: Transcript.Transcript = {
    ...Transcript.empty,
    usage: { input: 12, output: 4, cached: 3, context: 75, usd: 1.5 }
  }
  expect(AppView.meter(transcript, 0).usage).toBe("↑12 ↓4 R3 $1.50")
  expect(AppView.meter({ ...transcript, usage: { ...transcript.usage, usd: 0.0042 } }, 0).usage).toBe(
    "↑12 ↓4 R3 $0.0042"
  )
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
