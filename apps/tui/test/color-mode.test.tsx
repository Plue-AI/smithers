import { type CapturedSpan, TextAttributes } from "@opentui/core"
import { testRender } from "@opentui/react/test-utils"
import { afterEach, describe, expect, it } from "bun:test"
import { act, type ReactNode } from "react"
import type * as Inbox from "../src/inbox.ts"
import { chat, Overview } from "../src/subagent-view.tsx"
import { TabStrip, WorkerList } from "../src/tabs-view.tsx"
import { applyColorMode, color, type ColorMode, colorModeOf, setTheme, themes } from "../src/theme.ts"
import * as View from "../src/view.tsx"
import type { Tab } from "../src/workspace.ts"

let setup: Awaited<ReturnType<typeof testRender>> | undefined
afterEach(async () => {
  await act(async () => {
    setup?.renderer.destroy()
    setup = undefined
  })
  applyColorMode({ addPostProcessFn: () => {} }, "truecolor")
  setTheme("purple")
})

const models = [
  { key: "sol", label: "GPT-6.1 Sol", hint: "OpenAI", detail: "openai:gpt-6.1-sol" },
  { key: "qwen", label: "Qwen 3.8", hint: "Cerebras", detail: "cerebras:qwen-3.8-27b", current: true },
  { key: "opus", label: "Claude Opus 5.5", hint: "Anthropic", detail: "anthropic:claude-opus-5-5" }
]

const draw = async (mode: ColorMode, node: ReactNode, width = 72, height = 6) => {
  // Views read the selected fill while rendering, so the mode is set before they mount.
  applyColorMode({ addPostProcessFn: () => {} }, mode)
  setup = await testRender(node, { width, height })
  applyColorMode(setup.renderer, mode)
  await setup.renderOnce()
  return setup.captureSpans().lines.map((line) => line.spans.filter((span) => span.text.trim() !== ""))
}

const spanOf = (lines: ReadonlyArray<ReadonlyArray<CapturedSpan>>, text: string): CapturedSpan => {
  const span = lines.flat().find((candidate) => candidate.text.includes(text))
  if (span === undefined) throw new Error(`no span contains ${text}`)
  return span
}
const has = (span: CapturedSpan, attribute: number) => (span.attributes & attribute) !== 0

const list = (selected: number) => (
  <View.List rows={models} selected={selected} height={3} background={color.surface} empty="None" />
)

describe("colorModeOf", () => {
  it.each(
    [
      [{ NO_COLOR: "1", TERM: "xterm-256color", COLORTERM: "truecolor" }, "none"],
      [{ NO_COLOR: "", TERM: "xterm-256color", COLORTERM: "truecolor" }, "truecolor"],
      [{ TERM: "xterm", COLORTERM: "truecolor" }, "ansi16"],
      [{ TERM: "linux" }, "ansi16"],
      [{ TERM: "xterm-256color" }, "ansi256"],
      [{ TERM: "tmux-256color", COLORTERM: "" }, "ansi256"],
      [{ TERM: "screen-256color", COLORTERM: "24bit" }, "truecolor"],
      [{ TERM: "xterm-256color", COLORTERM: "TrueColor" }, "truecolor"],
      [{ TERM: "xterm-kitty" }, "truecolor"],
      [{ TERM: "xterm-ghostty" }, "truecolor"],
      [{ TERM: "xterm-direct" }, "truecolor"],
      [{}, "truecolor"]
    ] as const
  )("%o is %s", (env, mode) => {
    expect(colorModeOf(env)).toBe(mode)
  })
})

describe("NO_COLOR frames", () => {
  it("draw no 24-bit or indexed color, anywhere in the frame", async () => {
    await draw("none", list(1))
    const spans = setup!.captureSpans().lines.flatMap((line) => line.spans)
    expect(spans.length).toBeGreaterThan(0)
    for (const span of spans) {
      expect(span.fg.intent).toBe("default")
      expect(span.bg.intent).toBe("default")
    }
  })

  it("show the selected row in reverse video and muted text dim", async () => {
    const lines = await draw("none", list(0))
    const selected = spanOf(lines, "GPT-6.1 Sol")
    expect(has(selected, TextAttributes.INVERSE)).toBe(true)
    expect(has(selected, TextAttributes.BOLD)).toBe(true)
    expect(has(spanOf(lines, "openai:gpt-6.1-sol"), TextAttributes.INVERSE)).toBe(true)
    expect(has(spanOf(lines, "openai:gpt-6.1-sol"), TextAttributes.DIM)).toBe(false)
    const other = spanOf(lines, "Claude Opus 5.5")
    expect(has(other, TextAttributes.INVERSE)).toBe(false)
    expect(has(other, TextAttributes.DIM)).toBe(false)
    expect(has(spanOf(lines, "Anthropic"), TextAttributes.DIM)).toBe(true)
    expect(has(spanOf(lines, "anthropic:claude-opus-5-5"), TextAttributes.DIM)).toBe(true)
  })

  it("moves reverse video with the selection", async () => {
    const lines = await draw("none", list(1))
    expect(has(spanOf(lines, "Qwen 3.8"), TextAttributes.INVERSE)).toBe(true)
    expect(has(spanOf(lines, "GPT-6.1 Sol"), TextAttributes.INVERSE)).toBe(false)
  })

  it("keeps reverse video after another accent is chosen", async () => {
    setTheme("green")
    const lines = await draw("none", list(2))
    expect(has(spanOf(lines, "Claude Opus 5.5"), TextAttributes.INVERSE)).toBe(true)
  })

  it("show the active tab in reverse video and the others dim", async () => {
    const chips = [{ id: "chat", label: "Chat" }, { id: "summary", label: "Summary" }]
    const lines = await draw("none", <TabStrip chips={chips} active="chat" width={40} onSelect={() => {}} />, 40, 1)
    const active = spanOf(lines, "Chat")
    expect(has(active, TextAttributes.INVERSE)).toBe(true)
    expect(has(active, TextAttributes.BOLD)).toBe(true)
    expect(has(spanOf(lines, "Summary"), TextAttributes.INVERSE)).toBe(false)
    expect(has(spanOf(lines, "Summary"), TextAttributes.DIM)).toBe(true)
  })

  it("show the Summary tree's selected row in reverse video while the tree has focus", async () => {
    const flow = (key: string, name: string): Inbox.Row => ({
      key,
      group: "working",
      level: 0,
      status: "running",
      name,
      seat: "fn",
      clock: "4s"
    })
    const sections = [{ group: "working" as const, rows: [flow("flow:build", "Build"), flow("flow:deploy", "Deploy")] }]
    const cards = {
      transcript: () => {
        throw new Error("no worker rows")
      },
      models: [],
      now: 0,
      lane: () => color.brand,
      focused: undefined,
      open: new Set<string>(),
      onOpen: () => {},
      onFiles: () => {},
      onAction: () => {}
    }
    const summary = (selected: string, pane: "tree" | "cards") => (
      <Overview
        sections={sections}
        selected={selected}
        pane={pane}
        width={80}
        cards={cards}
        tabs={[]}
        onSelect={() => {}}
        review={<text fg={color.text}>Review</text>}
      />
    )
    const reversed = (lines: ReadonlyArray<ReadonlyArray<CapturedSpan>>, text: string) =>
      lines.flat().some((span) => span.text.includes(text) && has(span, TextAttributes.INVERSE))

    let lines = await draw("none", summary(chat, "tree"), 80, 10)
    expect(reversed(lines, "Chat")).toBe(true)
    expect(reversed(lines, "Build")).toBe(false)
    await act(async () => setup!.renderer.destroy())
    lines = await draw("none", summary("flow:deploy", "tree"), 80, 10)
    expect(reversed(lines, "Deploy")).toBe(true)
    expect(reversed(lines, "Chat")).toBe(false)
    expect(reversed(lines, "Build")).toBe(false)
    await act(async () => setup!.renderer.destroy())
    lines = await draw("none", summary("flow:deploy", "cards"), 80, 10)
    expect(reversed(lines, "Deploy")).toBe(false)
  })

  it("show the selected worker in reverse video", async () => {
    const worker = (id: string) =>
      ({ id, title: `Worker ${id}`, seat: "openai:gpt-6.1-sol", status: "running", startedAt: 0 }) as Tab
    const lines = await draw(
      "none",
      <WorkerList
        tabs={[worker("a"), worker("b")]}
        active="tab:b"
        models={[]}
        now={0}
        onSelect={() => {}}
      />,
      24,
      8
    )
    expect(has(spanOf(lines, "Worker b"), TextAttributes.INVERSE)).toBe(true)
    expect(has(spanOf(lines, "Worker a"), TextAttributes.INVERSE)).toBe(false)
  })

  it("show the focused transcript card in reverse video", async () => {
    const card = (title: string, label: string) => ({
      id: title,
      title,
      summary: "1 row",
      rows: [{ id: label, label, status: "running" as const, details: [] }]
    })
    const lines = await draw(
      "none",
      (
        <box>
          <View.Card panel={card("Focused", "first")} focused />
          <View.Card panel={card("Other", "second")} />
        </box>
      ),
      40,
      6
    )
    expect(has(spanOf(lines, "Focused"), TextAttributes.INVERSE)).toBe(true)
    expect(has(spanOf(lines, "first"), TextAttributes.INVERSE)).toBe(true)
    expect(has(spanOf(lines, "Other"), TextAttributes.INVERSE)).toBe(false)
    expect(has(spanOf(lines, "second"), TextAttributes.INVERSE)).toBe(false)
  })

  it("shows the focused flow result in reverse video and other results plain", async () => {
    const run = {
      id: "build-1",
      flow: "build",
      by: "user" as const,
      input: {},
      requested: "{}",
      status: "done" as const,
      startedAt: 0,
      launchedAt: 0,
      endedAt: 40,
      answer: "5"
    }
    const lines = await draw(
      "none",
      (
        <box>
          <View.RunCard title="Focused run" run={run} now={40} focused />
          <View.RunCard title="Other run" run={run} now={40} />
        </box>
      ),
      40,
      4
    )
    expect(has(spanOf(lines, "Focused run"), TextAttributes.INVERSE)).toBe(true)
    expect(has(spanOf(lines, "Other run"), TextAttributes.INVERSE)).toBe(false)
    for (const span of lines.flat()) {
      expect(span.fg.intent).toBe("default")
      expect(span.bg.intent).toBe("default")
    }
  })

  it("leave filled panels that are not selected plain", async () => {
    const lines = await draw(
      "none",
      (
        <box backgroundColor={color.element}>
          <text fg={color.text}>Toast</text>
        </box>
      ),
      20,
      1
    )
    const toast = spanOf(lines, "Toast")
    expect(has(toast, TextAttributes.INVERSE)).toBe(false)
    expect(has(toast, TextAttributes.DIM)).toBe(false)
  })

  it("dim what a dialog covers", async () => {
    const lines = await draw(
      "none",
      (
        <box>
          <text fg={color.text}>Beneath</text>
          <View.Dialog title="Select model" width={30} height={10}>
            <text fg={color.text}>Inside</text>
          </View.Dialog>
        </box>
      ),
      40,
      10
    )
    expect(has(spanOf(lines, "Beneath"), TextAttributes.DIM)).toBe(true)
    expect(has(spanOf(lines, "Inside"), TextAttributes.DIM)).toBe(false)
  })
})

describe("indexed frames", () => {
  const slots = (lines: ReadonlyArray<ReadonlyArray<CapturedSpan>>) =>
    lines.flat().flatMap((span) => [span.fg, span.bg]).filter((rgba) => rgba.intent !== "default")

  it("draw 16 colors where TERM names no more, keeping hues and text over muted", async () => {
    const lines = await draw("ansi16", list(1))
    for (const rgba of slots(lines)) {
      expect(rgba.intent).toBe("indexed")
      expect(rgba.slot).toBeLessThan(16)
    }
    expect(spanOf(lines, "Claude Opus 5.5").fg.slot).toBe(15)
    expect(spanOf(lines, "Anthropic").fg.slot).toBe(7)
    expect(spanOf(lines, "anthropic:claude-opus-5-5").fg.slot).toBe(8)
    expect(spanOf(lines, "Qwen 3.8").bg.slot).toBe(13)
  })

  it("draw the accent chosen after load in its 16-color hue", async () => {
    setTheme("blue")
    const lines = await draw("ansi16", list(1))
    expect(spanOf(lines, "Qwen 3.8").bg.slot).toBe(12)
  })

  it("draw the 256-color cube and ramp where TERM names 256 colors", async () => {
    const lines = await draw("ansi256", list(1))
    const drawn = slots(lines)
    expect(drawn.length).toBeGreaterThan(0)
    for (const rgba of drawn) {
      expect(rgba.intent).toBe("indexed")
      expect(rgba.slot).toBeGreaterThanOrEqual(16)
    }
    expect(spanOf(lines, "Qwen 3.8").bg.slot).toBe(176)
  })

  it("leave 24-bit frames untouched", async () => {
    const lines = await draw("truecolor", list(1))
    expect(spanOf(lines, "Qwen 3.8").bg.intent).toBe("rgb")
    expect(spanOf(lines, "Claude Opus 5.5").fg.intent).toBe("rgb")
    expect(color.selected).toBe(color.element)
  })

  it("fill the selection with the brand color only under NO_COLOR", () => {
    applyColorMode({ addPostProcessFn: () => {} }, "none")
    expect(color.selected).toBe(themes.purple)
    setTheme("orange")
    expect(color.selected).toBe(themes.orange)
    applyColorMode({ addPostProcessFn: () => {} }, "ansi16")
    expect(color.selected).toBe(color.element)
  })
})
