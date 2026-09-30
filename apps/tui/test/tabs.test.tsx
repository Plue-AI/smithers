import { rgbToHex } from "@opentui/core"
import { testRender } from "@opentui/react/test-utils"
import * as SubagentCard from "@smthrs/rpc/SubagentCard"
import { afterEach, describe, expect, it } from "bun:test"
import { act } from "react"
import * as Keys from "../src/keys.ts"
import * as Models from "../src/models.ts"
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
    seat: "openai:gpt-6.1-sol",
    file: `/tmp/${id}.jsonl`,
    status: status as Tab["status"],
    startedAt: 1_000,
    ...extra
  }) as Tab
const models = [{ seat: "openai:gpt-6.1-sol", label: "GPT-6.1 Sol", provider: "openai" }]

describe("worker status", () => {
  it("draws the shared subagent glyph in this palette", () => {
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
    for (const status of statuses) {
      expect(Tabs.style(status, 150).glyph).toBe(SubagentCard.glyph(status, 150).glyph)
    }
    expect(Tabs.style("running", 0).glyph).toBe("◐")
    expect(Tabs.style("running", 150).glyph).toBe("◓")
    expect(Tabs.style("running", 0).tone).toBe(color.info)
    expect(Tabs.style("queued", 0).tone).toBe(color.warning)
    expect(Tabs.style("parked", 0).tone).toBe(color.warning)
    expect(Tabs.style("waiting", 0).tone).toBe(color.warning)
    expect(Tabs.style("failed", 0)).toEqual({ glyph: "●", tone: color.danger })
    expect(Tabs.style("done", 0)).toEqual({ glyph: "●", tone: color.success })
    expect(Tabs.style("cancelled", 0)).toEqual({ glyph: "■", tone: color.faint })
  })

  it("names the model as the picker does: its label, then the seat catalog's, then its id", () => {
    expect(Models.labelOf("openai:gpt-6.1-sol", [])).toBe("GPT-6.1 Sol")
    expect(
      Models.labelOf("anthropic:claude-x", [{ seat: "anthropic:claude-x", label: "Claude X", provider: "anthropic" }])
    )
      .toBe("Claude X")
    // An alias, a delegate name and the seat they name read alike.
    expect(["openai:gpt-6-luna", "luna", "cerebras", "qwen"].map((seat) => Models.labelOf(seat, []))).toEqual([
      "GPT-6 Luna",
      "GPT-6 Luna",
      "Qwen 3.8",
      "Qwen 3.8"
    ])
    expect(Models.labelOf("test:worker", [])).toBe("worker")
    expect(Models.labelOf("replay:/tmp/sessions/fix-add.jsonl", [])).toBe("replay")
  })

  it("names every route to one Claude model alike", () => {
    const claude = [
      { seat: "anthropic:claude-opus-5-5", label: "Claude Opus 5.5", provider: "anthropic" },
      { seat: "claude-code:opus", label: "Claude Opus 5.5", provider: "claude-code" }
    ]
    for (const seat of ["anthropic:claude-opus-5-5", "claude-code:opus", "opus"]) {
      expect(Models.labelOf(seat, claude)).toBe("Claude Opus 5.5")
    }
    expect(Models.labelOf("claude-code:anthropic:claude-fable-5-1", [])).toBe("Claude Fable 5.1")
    expect(Models.labelOf(Models.delegateModels.cerebras, [])).toBe("Qwen 3.8")
    expect(Models.labelOf("cerebras", [])).toBe("Qwen 3.8")
  })

  it("counts elapsed time to the end once settled", () => {
    expect(Tabs.elapsed(tab("a", "running"), 4_000)).toBe(3_000)
    expect(Tabs.elapsed(tab("a", "done", { endedAt: 2_500 }), 9_000)).toBe(1_500)
  })
})

describe("worker actions", () => {
  const keys = (status: Tabs.Status, failure?: Tab["failure"]) =>
    Tabs.actions({ status, ...(failure === undefined ? {} : { failure }) }).map((action) => action.keys[0])
  it("offers stop, resume, model, wait, steer and take over only when they apply", () => {
    expect(keys("running")).toEqual(["alt+x", "alt+s", "alt+t"])
    expect(keys("requested")).toEqual(["alt+x"])
    expect(keys("queued")).toEqual(["alt+x"])
    expect(keys("waiting")).toEqual(["alt+x"])
    expect(keys("parked")).toEqual(["alt+x"])
    expect(keys("failed")).toEqual(["alt+r", "alt+m"])
    expect(keys("failed", { headline: "Usage limit", fault: "wait", line: "", actions: ["resume", "wait"] } as never))
      .toEqual(["alt+r", "alt+m", "alt+w"])
    // No credit: another model first, and no wait for a reset that will not come.
    expect(
      keys("failed", {
        headline: "OpenAI quota exhausted",
        fault: "wait",
        line: "",
        actions: ["switch-model", "resume", "details"]
      })
    )
      .toEqual(["alt+m", "alt+r"])
    expect(
      keys("failed", {
        headline: "Model route unavailable",
        fault: "dependency",
        line: "",
        actions: ["switch-model", "resume", "details"]
      })
    )
      .toEqual(["alt+m", "alt+r"])
    expect(keys("cancelled")).toEqual(["alt+r"])
    expect(keys("done")).toEqual([])
    // While the person drives it, stop is the only button; ctrl+y releases.
    expect(Tabs.actions({ status: "running", driver: { by: "you", from: 0, messages: 0 } }).map((each) => each.id))
      .toEqual(["stop"])
  })
  it("resolves a key to the action it runs, never one the status forbids", () => {
    const run = (name: string, status: Tabs.Status) =>
      Tabs.actionFor(Keys.bindingFor({ name: name.slice(4), meta: true }, "panel")!.id, { status })?.id
    expect(run("alt+x", "running")).toBe("stop")
    expect(run("alt+r", "running")).toBeUndefined()
    expect(run("alt+r", "failed")).toBe("retry")
    expect(run("alt+s", "queued")).toBeUndefined()
    expect(run("alt+t", "running")).toBe("takeover")
    expect(run("alt+t", "waiting")).toBeUndefined()
    // `c` continues a parked flow run; it runs no worker action.
    expect(Keys.bindingFor({ name: "c" }, "panel")?.id).toBe("continue")
    expect(Tabs.actionFor("continue", { status: "parked" })).toBeUndefined()
  })
  it("takes every action's keys and label from a panel binding in the registry", () => {
    for (const action of Tabs.bindings) {
      const binding = Keys.bindingFor({ name: action.keys[0]!.slice(4), meta: true }, "panel")
      expect(binding?.context).toBe("panel")
      expect(binding?.keys).toEqual(action.keys)
      // Raise cap names what `a` does to a capped worker; every other button uses the key's own label.
      expect(action.id === "raise" ? "Raise cap" : binding?.label).toBe(action.label)
    }
    expect(Tabs.bindings.map((binding) => binding.id)).toEqual([
      "raise",
      "stop",
      "retry",
      "model",
      "wait",
      "steer",
      "takeover"
    ])
  })
})

describe("TabStrip", () => {
  const chips = [
    { id: "chat", label: "Chat" },
    { id: "summary", label: "Summary", badge: "◆1" },
    ...["alpha", "bravo", "charlie", "delta", "echo"].map((id) => ({
      id: `tab:${id}`,
      label: `Run ${id} with a long title`,
      glyph: "✓",
      tone: color.success,
      detail: "58s"
    }))
  ]
  it.each([80, 40, 24])("pins Chat and Summary without any run chips in Chat at width %s", async (width) => {
    const { captureCharFrame } = await mount(
      <TabStrip
        chips={chips}
        active="chat"
        width={width}
        counts={{ working: 4, failed: 1 }}
        onSelect={() => {}}
      />,
      width
    )
    const frame = captureCharFrame()
    expect(frame).toContain("Chat")
    expect(frame).toContain("Summary")
    expect(frame).not.toContain("Run ")
    expect(frame).not.toMatch(/[‹›]/)
    if (width >= 40) {
      expect(frame).toContain("◆1")
      expect(frame).toContain("◐4")
      expect(frame).toContain("✗1")
    }
  })
  it("keeps an idle strip quiet without zero counters", async () => {
    const { captureCharFrame } = await mount(
      <TabStrip
        chips={chips.map((chip) => chip.id === "summary" ? { id: "summary", label: "Summary" } : chip)}
        active="summary"
        width={80}
        counts={{ working: 0, failed: 0 }}
        onSelect={() => {}}
      />
    )
    const frame = captureCharFrame()
    expect(frame).toContain("Chat")
    expect(frame).toContain("Summary")
    expect(frame).not.toMatch(/[◐◆✗]/)
    expect(frame).not.toContain("Run ")
  })
  it("shows only the focused run after the pinned navigation and counts", async () => {
    const { captureCharFrame } = await mount(
      <TabStrip
        chips={chips}
        active="tab:charlie"
        width={80}
        counts={{ working: 4, failed: 1 }}
        onSelect={() => {}}
      />
    )
    const frame = captureCharFrame()
    expect(frame).toContain("Run charlie with a long title")
    expect(frame).toContain("58s")
    expect(frame.indexOf("Chat")).toBeLessThan(frame.indexOf("Summary"))
    expect(frame.indexOf("Summary")).toBeLessThan(frame.indexOf("Run charlie"))
    for (const id of ["alpha", "bravo", "delta", "echo"]) expect(frame).not.toContain(`Run ${id}`)
    expect(frame).not.toMatch(/[‹›]/)
  })
  it("keeps home and Summary clickable from a focused run", async () => {
    const selected: string[] = []
    const { captureCharFrame, mockMouse } = await mount(
      <TabStrip chips={chips} active="tab:charlie" width={80} onSelect={(id) => selected.push(id)} />
    )
    for (const label of ["Chat", "Summary", "Run charlie"]) {
      const at = find(captureCharFrame(), label)
      await mockMouse.click(at.x + 1, at.y)
    }
    expect(selected).toEqual(["chat", "summary", "tab:charlie"])
  })
  it("adding six finished runs does not change the Chat strip", async () => {
    const counts = { working: 4, failed: 1 }
    const first = await mount(<TabStrip chips={chips} active="chat" width={80} counts={counts} onSelect={() => {}} />)
    const before = first.captureCharFrame()
    act(() => first.renderer.destroy())
    setup = undefined
    const after = await mount(
      <TabStrip
        chips={[...chips, ...Array.from({ length: 6 }, (_, i) => ({ id: `tab:done${i}`, label: `Finished ${i}` }))]}
        active="chat"
        width={80}
        counts={counts}
        onSelect={() => {}}
      />
    )
    expect(after.captureCharFrame()).toBe(before)
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
        onSelect={(id) => opened.push(id)}
      />,
      24,
      8
    )
    const frame = captureCharFrame()
    expect(frame).toContain(`${Tabs.style("running", 4_000).glyph} Worker a`)
    expect(frame).toContain("GPT-6.1 Sol · 3.0s")
    expect(frame).toContain(`${Tabs.style("queued", 4_000).glyph} Worker b`)
    const row = find(frame, "Worker b")
    await mockMouse.click(row.x, row.y)
    expect(opened).toEqual(["tab:b"])
  })
})

/** A worker's transcript through its settlement, as `Workspace` folds it. */
const settled = (end: (transcript: Transcript.Transcript) => Transcript.Transcript): Transcript.Transcript => {
  const identity = { session: "s", frame: 1, cell: 1, ordinal: 0 }
  const steps = [
    (value: Transcript.Transcript) => Transcript.apply(value, { _tag: "model-requested" } as never, 1_100),
    (value: Transcript.Transcript) =>
      Transcript.apply(
        value,
        { _tag: "model-delta", delta: { type: "text-delta", text: "```js\nx\n```" } } as never,
        1_200
      ),
    (value: Transcript.Transcript) =>
      Transcript.apply(value, {
        _tag: "cell-call-started",
        call: { flowName: "bash", input: { command: "npm test" }, identity }
      } as never, 1_300),
    (value: Transcript.Transcript) =>
      Transcript.apply(value, {
        _tag: "cell-call-settled",
        flowName: "bash",
        identity,
        result: { outcome: "success", value: { exitCode: 0 } }
      } as never, 1_400),
    // The command's receipt: its captured change to the tree.
    (value: Transcript.Transcript) =>
      Transcript.patched(value, {
        call: (value.items.find((item) => item.kind === "cell") as Extract<Transcript.Item, { kind: "cell" }>)
          .calls[0]!.identity!,
        patches: [{ path: "src/cart.js", patch: "@@ -1 +1 @@\n-a\n+b" }]
      }),
    end
  ]
  return steps.reduce((value, step) => step(value), Transcript.empty)
}

/** What WorkerView needs beyond its tab: the way back and its children's cards. */
const chrome = {
  onBack: () => {},
  onRelease: () => {},
  earlierOpen: false,
  onEarlier: () => {},
  tabs: [],
  cards: {
    transcript: () => Transcript.empty,
    models,
    now: 4_000,
    lane: () => color.info,
    focused: undefined,
    open: new Set<string>(),
    onOpen: () => {},
    onFiles: () => {},
    onAction: () => {}
  }
}

describe("WorkerView", () => {
  it("shows the owning worker's body refusal, back and resume in expanded details", async () => {
    const { captureCharFrame } = await mount(
      <WorkerView
        tab={tab("review", "failed", {
          code: "unreadable",
          message: "Body unavailable",
          failure: { headline: "Body unavailable", fault: "user", line: "", actions: ["resume", "details"] }
        })}
        transcript={Transcript.empty}
        models={models}
        now={4_000}
        tick="⠋"
        tone={color.danger}
        width={90}
        expanded
        onAction={() => {}}
        {...chrome}
      />,
      90,
      24
    )
    const frame = captureCharFrame()
    expect(frame).toContain("Back (ctrl+y)")
    expect(frame).toContain("r Resume")
    expect(frame).toContain("Body unavailable")
    expect(frame).not.toContain("private stack")
  })

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

  it("heads the transcript with two rows and renders cells as the chat does, program hidden", async () => {
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
        {...chrome}
      />,
      90,
      24
    )
    const frame = captureCharFrame()
    expect(frame).toContain(`${Tabs.style("running", 4_000).glyph} Worker a`)
    expect(frame).toContain("GPT-6.1 Sol · 3.0s")
    expect(frame).toContain("3.0s")
    expect(frame).not.toContain("↑18k ↓2.3k")
    expect(frame.split("\n").findIndex((row) => row.includes("Audit the auth middleware."))).toBeLessThanOrEqual(4)
    expect(frame).toContain("Audit the auth middleware.")
    // A cell the model is still writing shows as work, its program behind ctrl+o.
    expect(frame).toContain("⠋ working")
    expect(frame).not.toContain("ctx.call(\"read\")")
    for (const label of ["x Stop", "s Steer"]) expect(frame).toContain(label)
    expect(frame).not.toContain("Open in chat")
    expect(frame).not.toContain("r Resume")
  })

  it("keeps Back in the first header row and follows a click", async () => {
    const back: Array<string> = []
    const actions: Array<string> = []
    const { captureCharFrame, mockMouse } = await mount(
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
        {...chrome}
        onBack={() => back.push("back")}
        onRelease={() => actions.push("release")}
      />,
      90,
      24
    )
    const frame = captureCharFrame()
    const lines = frame.split("\n")
    expect(lines[0]).toContain("Worker a")
    expect(lines[0]).toContain("Back (ctrl+y)")
    expect(lines[1]).toContain("GPT-6.1 Sol · 3.0s")
    expect(lines.findIndex((row) => row.includes("Audit the auth middleware."))).toBeLessThanOrEqual(4)
    const crumb = find(frame, "Back (ctrl+y)")
    await mockMouse.click(crumb.x + 1, crumb.y)
    expect(back).toEqual(["back"])
    expect(actions).toEqual([])
    expect(frame).not.toContain("Release (ctrl+y)")
  })

  it("labels a driven worker Release and releases without navigating back", async () => {
    const events: Array<string> = []
    const { captureCharFrame, mockMouse } = await mount(
      <WorkerView
        tab={tab("a", "running", { driver: { by: "you", from: 2_000, messages: 0 } })}
        transcript={transcript}
        models={models}
        now={4_000}
        tick="⠋"
        tone={color.info}
        width={90}
        expanded={false}
        onAction={() => {}}
        {...chrome}
        onBack={() => events.push("back")}
        onRelease={() => events.push("release")}
      />,
      90,
      24
    )
    const frame = captureCharFrame()
    expect(frame.split("\n")[0]).toContain("Release (ctrl+y)")
    expect(frame).not.toContain("Back (ctrl+y)")
    const release = find(frame, "Release (ctrl+y)")
    await mockMouse.click(release.x + 1, release.y)
    expect(events).toEqual(["release"])
  })

  it("draws its own children as a card grid at the call that delegated them", async () => {
    const delegated = [
      (value: Transcript.Transcript) => Transcript.user(value, "Split the review.", false, 1_000),
      (value: Transcript.Transcript) => Transcript.apply(value, { _tag: "model-requested" } as never, 1_100),
      (value: Transcript.Transcript) =>
        Transcript.apply(value, { _tag: "cell-produced", cell: { text: "x" } } as never, 1_200),
      (value: Transcript.Transcript) =>
        Transcript.apply(value, {
          _tag: "cell-call-started",
          call: { flowName: "agent.delegate", input: { id: "c", title: "Check docs", prompt: "Check." } }
        } as never, 1_300),
      (value: Transcript.Transcript) =>
        Transcript.apply(value, {
          _tag: "cell-call-settled",
          flowName: "agent.delegate",
          result: { outcome: "success", value: {} }
        } as never, 1_400),
      (value: Transcript.Transcript) =>
        Transcript.apply(value, { _tag: "cell-settled", outcome: { _tag: "settled" } } as never, 1_500)
    ].reduce((value, step) => step(value), Transcript.empty)
    const child = tab("a/c", "done", { parent: "a", title: "Check docs", startedAt: 1_350, endedAt: 3_350 })
    const { captureCharFrame } = await mount(
      <WorkerView
        tab={tab("a", "waiting")}
        transcript={delegated}
        models={models}
        now={4_000}
        tick="⠋"
        tone={color.info}
        width={90}
        expanded={false}
        onAction={() => {}}
        {...chrome}
        tabs={[tab("a", "waiting"), child]}
      />,
      90,
      30
    )
    const frame = captureCharFrame()
    expect(frame).toContain("✓ Check docs · done at 2s")
    expect(frame).toContain("● Check docs")
    expect(frame).toContain("Done 2s · GPT-6.1 Sol")
    expect(frame).toContain("◉ Check docs done")
    expect(frame.indexOf("Split the review.")).toBeLessThan(frame.indexOf("✓ Check docs · done"))
    expect(frame.indexOf("✓ Check docs · done")).toBeLessThan(frame.indexOf("◉ Check docs done"))
  })

  it("shows a run no judge could check as done · unchecked with its evidence, and nothing red", async () => {
    const { captureCharFrame, captureSpans } = await mount(
      <WorkerView
        tab={tab("a", "done", { title: "Fix the failing test", endedAt: 39_000, unchecked: true, answer: "Fixed." })}
        transcript={settled((value) => Transcript.unchecked(value, "Fixed the cart total.", 39_000))}
        models={models}
        now={99_000}
        tick="⠋"
        tone={color.info}
        width={100}
        expanded={false}
        onAction={() => {}}
        {...chrome}
      />,
      100,
      30
    )
    const frame = captureCharFrame()
    expect(frame).toContain("● Fix the failing test")
    // `unchecked` once, on the evidence line.
    expect(frame.match(/unchecked/g)).toHaveLength(1)
    expect(frame).toContain("✓ npm test  exit 0")
    expect(frame).toContain("✓ Fix the failing test · 38s · src/cart.js +1 −1 · npm test exit 0 · unchecked")
    for (const word of ["Failed", "failed", "could not be checked", "AI_GATEWAY_API_KEY", "r Resume"]) {
      expect(frame).not.toContain(word)
    }
    // `unchecked` is dim, never the danger color.
    const unchecked = captureSpans().lines.flatMap((line) => line.spans).filter((span) =>
      span.text.includes("unchecked")
    )
    expect(unchecked.length).toBeGreaterThan(0)
    for (const span of unchecked) expect(rgbToHex(span.fg)).not.toBe(color.danger)
  })

  it("shows a stopped run as stopped, never as a failure", async () => {
    const { captureCharFrame } = await mount(
      <WorkerView
        tab={tab("a", "cancelled", { endedAt: 7_000 })}
        transcript={settled((value) => Transcript.stopped(value, 7_000))}
        models={models}
        now={99_000}
        tick="⠋"
        tone={color.info}
        width={90}
        expanded={false}
        onAction={() => {}}
        {...chrome}
      />,
      90,
      24
    )
    const frame = captureCharFrame()
    expect(frame).toContain("■ Worker a")
    expect(frame).toContain("■ stopped")
    expect(frame).toContain("r Resume")
    expect(frame).not.toContain("✗")
    expect(frame).not.toContain("failed")
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
        {...chrome}
      />,
      90,
      24
    )
    const frame = captureCharFrame()
    expect(frame).toContain("● Worker a")
    expect(frame).toContain("failed: Seat quota exhausted")
    expect(frame).not.toContain("not your fault")
    expect(frame).toContain("1.0s")
    const retry = find(frame, "r Resume")
    await mockMouse.click(retry.x + 2, retry.y)
    const model = find(frame, "m Switch model")
    await mockMouse.click(model.x + 1, model.y)
    expect(actions).toEqual(["retry", "model"])
  })
})

describe("seat names", () => {
  it("names a wrapped worker by its vendor and any other by its model", () => {
    const base = { seat: "openai:gpt-6.1-sol" }
    expect(Models.seatName(base, [])).toBe("GPT-6.1 Sol")
    expect(Models.seatName({ ...base, harness: { vendor: "claude" } }, [])).toBe("claude")
    expect(Models.seatName({ ...base, activeSeat: "openai:gpt-6-luna" }, [])).toBe("GPT-6 Luna")
  })
})
