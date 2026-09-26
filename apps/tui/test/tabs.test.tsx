import { testRender } from "@opentui/react/test-utils"
import { afterEach, describe, expect, it } from "bun:test"
import { act } from "react"
import * as Keys from "../src/keys.ts"
import { TabStrip, WorkerList, WorkerView } from "../src/tabs-view.tsx"
import * as Tabs from "../src/tabs.ts"
import { color } from "../src/theme.ts"
import * as Transcript from "../src/transcript.ts"
import type { Tab } from "../src/workspace.ts"

let setup: Awaited<ReturnType<typeof testRender>> | undefined
afterEach(() => {
  const mounted = setup
  setup = undefined
  if (mounted !== undefined) act(() => mounted.renderer.destroy())
})
const mount = async (node: Parameters<typeof testRender>[0], width = 80, height = 12) => {
  const mounted = await act(() => testRender(node, { width, height }))
  setup = mounted
  await act(() => mounted.renderOnce())
  const click = (x: number, y: number) => act(() => mounted.mockMouse.click(x, y))
  return { ...mounted, mockMouse: { ...mounted.mockMouse, click } }
}
/** The first cell of `text` on screen, for a mouse press. */
const find = (frame: string, text: string): { x: number; y: number } => {
  const lines = frame.split("\n")
  const y = lines.findIndex((line) => line.includes(text))
  if (y < 0) throw new Error(`no "${text}" in:\n${frame}`)
  return { x: lines[y]!.indexOf(text), y }
}

const tab = (id: string, status: Tabs.Status, extra: Partial<Tab> = {}): Tab =>
  ({
    id,
    title: `Worker ${id}`,
    prompt: `Do ${id}.`,
    seat: "openai:gpt-6-sol",
    file: `/tmp/${id}.jsonl`,
    status: status as Tab["status"],
    startedAt: 1_000,
    ...extra
  }) as Tab
const models = [{ seat: "openai:gpt-6-sol", label: "GPT-6 Sol", provider: "openai" }]

describe("worker status", () => {
  it("gives every status its own glyph and color", () => {
    const statuses: ReadonlyArray<Tabs.Status> = [
      "requested",
      "queued",
      "running",
      "waiting",
      "parked",
      "done",
      "failed",
      "cancelled"
    ]
    const styles = statuses.map((status) => Tabs.style(status, "⠋"))
    expect(new Set(styles.map((each) => each.glyph)).size).toBe(statuses.length)
    expect(new Set(styles.map((each) => `${each.glyph}${each.tone}`)).size).toBe(statuses.length)
    expect(Tabs.style("queued", "⠋").tone).toBe(color.warning)
    expect(Tabs.style("parked", "⠋").tone).toBe(color.warning)
    expect(Tabs.style("running", "⠙").glyph).toBe("⠙")
    expect(Tabs.style("failed", "⠋").tone).toBe(color.danger)
    expect(Tabs.style("done", "⠋").tone).toBe(color.success)
  })

  it("names the model by its delegate alias, its label, then its id", () => {
    expect(Tabs.model("openai:gpt-6-sol", models)).toBe("sol")
    expect(Tabs.model("anthropic:claude-x", [{ seat: "anthropic:claude-x", label: "Claude X", provider: "anthropic" }]))
      .toBe("Claude X")
    expect(Tabs.model("test:worker", [])).toBe("worker")
    expect(Tabs.model("replay:/tmp/sessions/fix-add.jsonl", [])).toBe("replay")
  })

  it("counts elapsed time to the end once settled", () => {
    expect(Tabs.elapsed(tab("a", "running"), 4_000)).toBe(3_000)
    expect(Tabs.elapsed(tab("a", "done", { endedAt: 2_500 }), 9_000)).toBe(1_500)
  })
})

describe("worker actions", () => {
  const keys = (status: Tabs.Status, failure?: Tab["failure"]) =>
    Tabs.actions({ status, ...(failure === undefined ? {} : { failure }) }).map((action) => action.keys[0])
  it("offers stop, resume, model, wait, steer and chat only when they apply", () => {
    expect(keys("running")).toEqual(["x", "s", "c"])
    expect(keys("requested")).toEqual(["x", "c"])
    expect(keys("queued")).toEqual(["x", "c"])
    expect(keys("waiting")).toEqual(["x", "c"])
    expect(keys("parked")).toEqual(["x", "c"])
    expect(keys("failed")).toEqual(["r", "m", "c"])
    expect(keys("failed", { headline: "Usage limit", fault: "wait", line: "", actions: ["resume", "wait"] } as never))
      .toEqual(["r", "m", "w", "c"])
    expect(keys("cancelled")).toEqual(["r", "c"])
    expect(keys("done")).toEqual(["c"])
  })
  it("resolves a key to the action it runs, never one the status forbids", () => {
    const run = (name: string, status: Tabs.Status) =>
      Tabs.actionFor(Keys.bindingFor({ name }, "panel")!.id, { status })?.id
    expect(run("x", "running")).toBe("stop")
    expect(run("r", "running")).toBeUndefined()
    expect(run("r", "failed")).toBe("retry")
    expect(run("s", "queued")).toBeUndefined()
    expect(run("c", "queued")).toBe("open-chat")
  })
  it("takes every action's keys and label from a panel binding in the registry", () => {
    for (const action of Tabs.bindings) {
      const binding = Keys.bindingFor({ name: action.keys[0]! }, "panel")
      expect(binding?.context).toBe("panel")
      expect(binding?.keys).toEqual(action.keys)
      expect(binding?.label).toBe(action.label)
    }
    expect(Tabs.bindings.map((binding) => binding.id)).toEqual(["stop", "retry", "model", "wait", "steer", "open-chat"])
  })
})

describe("tab strip window", () => {
  it("fits every tab when there is room", () => {
    expect(Tabs.fit([6, 9, 12], 0, 80)).toEqual({ first: 0, last: 3 })
  })
  it("keeps the active tab whole and scrolls instead of truncating", () => {
    const widths = [6, 9, 20, 20, 20, 20, 20]
    for (let active = 0; active < widths.length; active++) {
      const { first, last } = Tabs.fit(widths, active, 50)
      expect(first).toBeLessThanOrEqual(active)
      expect(last).toBeGreaterThan(active)
      const arrows = (first > 0 ? Tabs.arrow : 0) + (last < widths.length ? Tabs.arrow : 0)
      expect(widths.slice(first, last).reduce((sum, width) => sum + width, 0) + arrows).toBeLessThanOrEqual(50)
    }
  })
})

describe("TabStrip", () => {
  const chips = [
    { id: "chat", label: "Chat" },
    { id: "summary", label: "Summary" },
    ...["alpha", "bravo", "charlie", "delta", "echo"].map((id, index) => ({
      id: `tab:${id}`,
      label: `Worker ${id} with a long title`,
      glyph: "✓",
      tone: color.success,
      detail: `sol · ${index + 1}s`
    }))
  ]
  it("shows whole titles, the status detail and hidden counts on both sides", async () => {
    const { captureCharFrame } = await mount(
      <TabStrip chips={chips} active="tab:charlie" width={80} onSelect={() => {}} />
    )
    const frame = captureCharFrame()
    expect(frame).toContain("Worker charlie with a long title")
    expect(frame).toContain("sol · 3s")
    expect(frame).not.toContain("…")
    expect(frame).toMatch(/‹ ?\d/)
    expect(frame).toMatch(/\d ?›/)
  })
  it("selects a tab, or the next hidden tab through an arrow, on click", async () => {
    const selected: Array<string> = []
    const { captureCharFrame, mockMouse } = await mount(
      <TabStrip chips={chips} active="tab:charlie" width={80} onSelect={(id) => selected.push(id)} />
    )
    const frame = captureCharFrame()
    const title = find(frame, "Worker charlie")
    await mockMouse.click(title.x + 2, title.y)
    const right = find(frame, "›")
    await mockMouse.click(right.x, right.y)
    const left = find(frame, "‹")
    await mockMouse.click(left.x, left.y)
    expect(selected[0]).toBe("tab:charlie")
    expect(selected.slice(1)).toHaveLength(2)
    expect(chips.findIndex((chip) => chip.id === selected[1])).toBeGreaterThan(
      chips.findIndex((chip) => chip.id === "tab:charlie")
    )
    expect(chips.findIndex((chip) => chip.id === selected[2])).toBeLessThan(
      chips.findIndex((chip) => chip.id === "tab:charlie")
    )
  })
})

describe("WorkerList", () => {
  it("lists each worker with its glyph, model and elapsed time, and opens one on click", async () => {
    const opened: Array<string> = []
    const { captureCharFrame, mockMouse } = await mount(
      <WorkerList
        tabs={[tab("a", "running"), tab("b", "queued")]}
        active="tab:a"
        models={models}
        now={4_000}
        tick="⠋"
        eta={() => ""}
        onSelect={(id) => opened.push(id)}
      />,
      24,
      8
    )
    const frame = captureCharFrame()
    expect(frame).toContain("⠋ Worker a")
    expect(frame).toContain("sol · 3.0s")
    expect(frame).toContain(`${Tabs.style("queued", "⠋").glyph} Worker b`)
    const row = find(frame, "Worker b")
    await mockMouse.click(row.x, row.y)
    expect(opened).toEqual(["tab:b"])
  })
})

describe("WorkerView", () => {
  const transcript = [
    (value: Transcript.Transcript) => Transcript.user(value, "Audit the auth middleware.", false, 1_000),
    (value: Transcript.Transcript) => Transcript.apply(value, { _tag: "model-requested" } as never, 1_100),
    (value: Transcript.Transcript) =>
      Transcript.apply(
        value,
        {
          _tag: "model-delta",
          delta: { type: "text-delta", text: "Read the middleware.\n```js\nawait ctx.call(\"read\")\n```" }
        } as never,
        1_200
      ),
    (value: Transcript.Transcript) =>
      Transcript.apply(value, {
        _tag: "model-settled",
        usage: { inputTokens: 18_400, outputTokens: 2_300 },
        message: { role: "assistant", content: [] }
      } as never, 1_300)
  ].reduce((value, step) => step(value), Transcript.empty)

  it("heads the transcript with status, model, elapsed and tokens, and renders cells as the chat does", async () => {
    const { captureCharFrame } = await mount(
      <WorkerView
        tab={tab("a", "running")}
        transcript={transcript}
        models={models}
        now={4_000}
        tick="⠋"
        tone={color.info}
        width={90}
        expanded={false}
        onAction={() => {}}
      />,
      90,
      24
    )
    const frame = captureCharFrame()
    expect(frame).toContain("⠋ Worker a")
    expect(frame).toContain("sol · 3.0s")
    expect(frame).toContain("3.0s")
    expect(frame).toContain("↑18k ↓2.3k")
    expect(frame).toContain("Audit the auth middleware.")
    expect(frame).toContain("Read the middleware.")
    expect(frame).toContain("ctx.call(\"read\")")
    for (const label of ["x Stop", "s Steer", "c Open in chat"]) expect(frame).toContain(label)
    expect(frame).not.toContain("r Resume")
  })

  it("marks the row u undoes", async () => {
    const cell = transcript.items.find((item) => item.kind === "cell")!
    const { captureCharFrame } = await mount(
      <WorkerView
        tab={tab("a", "done", { endedAt: 2_000 })}
        transcript={transcript}
        models={models}
        now={4_000}
        tick="⠋"
        tone={color.info}
        width={90}
        expanded={false}
        onAction={() => {}}
        selected={cell.id}
      />,
      90,
      24
    )
    const marked = captureCharFrame().split("\n").filter((line) => line.includes("›"))
    expect(marked).toHaveLength(1)
    expect(marked[0]).toContain("Read the middleware.")
  })

  it("shows a failure and runs an action from its button", async () => {
    const actions: Array<string> = []
    const { captureCharFrame, mockMouse } = await mount(
      <WorkerView
        tab={tab("a", "failed", {
          endedAt: 2_000,
          message: "Seat quota exhausted",
          failure: {
            headline: "Seat quota exhausted",
            fault: "infra",
            line: "The seat ran out.",
            actions: ["resume", "switch-model"]
          } as never
        })}
        transcript={transcript}
        models={models}
        now={9_000}
        tick="⠋"
        tone={color.info}
        width={90}
        expanded={false}
        onAction={(action) => actions.push(action)}
      />,
      90,
      24
    )
    const frame = captureCharFrame()
    expect(frame).toContain("✗ Worker a")
    expect(frame).toContain("Seat quota exhausted")
    expect(frame).toContain("1.0s")
    const retry = find(frame, "r Resume")
    await mockMouse.click(retry.x + 2, retry.y)
    const chat = find(frame, "c Open in chat")
    await mockMouse.click(chat.x + 1, chat.y)
    expect(actions).toEqual(["retry", "open-chat"])
  })
})
