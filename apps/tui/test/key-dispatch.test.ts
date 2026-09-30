import { KeyEvent, StdinParser } from "@opentui/core"
import * as AgentEvent from "@smthrs/harness/AgentEvent"
import * as Form from "@smthrs/ui/flow-form"
import { expect, test } from "bun:test"
import { Schema } from "effect"
import * as Activity from "../src/activity.ts"
import type { Completion } from "../src/complete.ts"
import { History } from "../src/editor.ts"
import * as Dispatch from "../src/key-dispatch.ts"
import * as Keys from "../src/keys.ts"
import type { Panel } from "../src/panels.ts"
import * as Panels from "../src/panels.ts"
import type { Tab } from "../src/workspace.ts"

const stdinKeys = (text: string, splitBytes: boolean): KeyEvent[] => {
  const parser = new StdinParser({ armTimeouts: false })
  const bytes = Buffer.from(text)
  const chunks = splitBytes ? Array.from(bytes, (byte) => Uint8Array.of(byte)) : [bytes]
  const events: KeyEvent[] = []
  const collect = () =>
    parser.drain((parsed) => {
      if (parsed.type !== "key") throw new Error("Expected a key event")
      events.push(new KeyEvent(parsed.key))
    })
  try {
    for (const chunk of chunks) {
      parser.push(chunk)
      collect()
    }
    parser.flushTimeout(Infinity)
    collect()
    return events
  } finally {
    parser.destroy()
  }
}

test.each(["😀", "e\u0301", "👨‍👩‍👧‍👦"])("real stdin bytes preserve dialog-filter Unicode %s", (text) => {
  for (const splitBytes of [false, true]) {
    const typed: string[] = []
    for (const event of stdinKeys(text, splitBytes)) {
      Dispatch.dialogKey(event, { kind: "models", selected: 0 }, { rows: 2, composerFocused: true }, {
        close: () => {
          throw new Error("Typing must not close the dialog")
        },
        select: () => {
          throw new Error("Typing must not move selection")
        },
        type: (value) => typed.push(value),
        pick: () => {
          throw new Error("Typing must not choose a model")
        }
      })
      expect(event.defaultPrevented).toBe(true)
    }
    expect(typed.join("")).toBe(text)
  }
})

test.each([["\u000c", false], ["\u001ba", false], ["\u001b", true]] as const)(
  "real stdin shortcuts do not become help text",
  (sequence, consumed) => {
    const events = stdinKeys(sequence, false)
    expect(events).toHaveLength(1)
    const calls: unknown[] = []
    const event = events[0]!
    expect(Dispatch.whichKeyKey(event, undefined, {
      close: () => calls.push("close"),
      type: (text) => calls.push(text),
      scroll: (step) => calls.push(step)
    })).toBe(consumed)
    expect(calls).toEqual(["close"])
    expect(event.defaultPrevented).toBe(consumed)
  }
)

test.each(["😀", "e\u0301", "👨‍👩‍👧‍👦"])("real stdin burst keeps a help-prefixed question %s", (text) => {
  for (const splitBytes of [false, true]) {
    let helpOpen = true
    let composer = ""
    for (const event of stdinKeys(text, splitBytes)) {
      if (helpOpen) {
        expect(Dispatch.whichKeyKey(event, undefined, {
          close: () => {
            helpOpen = false
          },
          type: (value) => {
            composer += value
          },
          scroll: () => {
            throw new Error("Typing must not scroll help")
          }
        })).toBe(true)
      }
      if (!event.defaultPrevented) composer += event.sequence
    }
    expect(helpOpen).toBe(false)
    expect(composer).toBe(`?${text}`)
  }
})

test.each([["keys", true], ["expand", false]] as const)(
  "help handles registered binding %s explicitly",
  (id, consumed) => {
    const calls: unknown[] = []
    const binding = Keys.registry.find((entry) => entry.id === id)
    expect(binding).toBeDefined()
    const event = id === "keys" ? key("?", { shift: true }, "?") : key("o", { ctrl: true }, "\u000f")
    expect(Dispatch.whichKeyKey(event, binding, {
      close: () => calls.push("close"),
      type: (value) => calls.push(value),
      scroll: (step) => calls.push(step)
    })).toBe(consumed)
    expect(calls).toEqual(["close"])
    expect(event.defaultPrevented).toBe(consumed)
  }
)

test.each(
  [
    ["up", {}, 0, 1],
    ["down", {}, 1, 0],
    ["p", { ctrl: true }, 0, 1],
    ["n", { ctrl: true }, 1, 0]
  ] as const
)("menu %s wraps its actual selection", (name, modifiers, initial, expected) => {
  let selected: number = initial
  const calls: unknown[] = []
  const event = key(name, modifiers)
  expect(Dispatch.menuKey(event, completion, {
    select: (update) => {
      selected = update(selected)
      calls.push(selected)
    },
    dismiss: () => calls.push("dismiss"),
    accept: () => calls.push("accept")
  })).toBe(true)
  expect(selected).toBe(expected)
  expect(calls).toEqual([expected])
  expect(event.defaultPrevented).toBe(true)
})

test.each(
  [
    ["up", false, "up"],
    ["down", false, "down"],
    ["left", false, "left"],
    ["right", false, "right"],
    ["tab", false, "next"],
    ["tab", true, "previous"]
  ] as const
)("card navigation %s shift=%s preserves focus", (name, shift, expected) => {
  const calls: unknown[] = []
  const event = key(name, { shift })
  expect(Dispatch.cardKey(event, {
    worker: undefined,
    move: (step) => calls.push(["move", step]),
    leave: () => calls.push("leave"),
    open: () => calls.push("open"),
    files: () => calls.push("files"),
    workerAction: () => calls.push("worker")
  })).toBe(true)
  expect(calls).toEqual([["move", expected]])
  expect(event.defaultPrevented).toBe(true)
})

test.each([{ options: [] }, { options: [{ value: "blocked", label: "Blocked", disabled: true }] }])(
  "a select with no available choices cannot mutate the draft",
  ({ options }) => {
    const open: Dispatch.FlowForm = {
      ...flowForm(),
      focus: 0,
      fields: [{
        name: "mode",
        label: "Mode",
        kind: "select",
        required: true,
        options
      }]
    }
    const calls: unknown[] = []
    const event = key("right")
    Dispatch.formKey(event, open, {
      change: (next) => calls.push(next),
      schema: () => flowSchema,
      input: () => ({}),
      fill: () => calls.push("fill")
    })
    expect(calls).toEqual([])
    expect(open.draft).toEqual({ count: "3", enabled: false, mode: "one" })
    expect(event.defaultPrevented).toBe(true)
  }
)

test("panel navigation applies the updater to the latest selection in an ordered key burst", () => {
  let navigation = Panels.initial()
  const navigable: Panel = {
    ...panel,
    rows: [
      { id: "one", label: "One", details: [] },
      { id: "two", label: "Two", details: [] },
      { id: "three", label: "Three", details: [] }
    ]
  }
  const calls: unknown[] = []
  for (const name of ["down", "down", "up"]) {
    const event = key(name)
    Dispatch.panelKey(event, navigable, {
      surface: "ui:checks",
      navigation,
      worker: undefined,
      flow: { retry: false, continue: false, stop: false }
    }, {
      ...panelActs(calls),
      navigate: (update) => {
        navigation = update(navigation)
        calls.push(navigation.selected)
      }
    })
    expect(event.defaultPrevented).toBe(true)
  }
  expect(calls).toEqual([1, 2, 1])
  expect(navigation).toEqual({ selected: 1, expanded: new Set(), diff: false, split: false })
})

test.each(
  [
    ["left", false, 2, 1],
    ["right", false, 2, 3],
    ["right", true, 2, 4],
    ["left", true, 4, 4],
    ["]", false, 2, 4],
    ["home", false, 3, 1],
    ["end", false, 1, 4]
  ] as const
)("scrubber %s shift=%s selects the recorded frame or milestone", (name, shift, cursor, expected) => {
  let activity = Activity.empty
  for (const at of [100, 200, 300]) {
    activity = Activity.apply(
      activity,
      new AgentEvent.TurnOpened({
        eventType: "flows.harness.turn-opened.v1",
        seat: "test",
        modelParams: {},
        activeToolNames: [],
        contextDigest: "context"
      }),
      at
    )
  }
  activity = Activity.finish(activity, "failed", 400, "Provider unavailable")
  const calls: unknown[] = []
  const event = key(name, { shift })
  expect(Dispatch.scrubberKey(event, activity, cursor, {
    follow: () => calls.push("follow"),
    inspect: (seq) => calls.push(seq)
  })).toBe(true)
  expect(calls).toEqual([expected])
  expect(event.defaultPrevented).toBe(true)
})

const key = (
  name: string,
  modifiers: Partial<Pick<KeyEvent, "ctrl" | "meta" | "option" | "shift">> = {},
  sequence = name
) =>
  new KeyEvent({
    name,
    sequence,
    raw: sequence,
    ctrl: false,
    meta: false,
    option: false,
    shift: false,
    number: false,
    eventType: "press",
    source: "raw",
    ...modifiers
  })

const idleContext = {
  checklist: false,
  picker: false,
  review: false,
  inspecting: false,
  form: false,
  approvals: false,
  empty: true,
  panel: false,
  overview: false,
  completion: false,
  card: false,
  shell: false,
  turn: false
}

test.each(
  [
    [{ checklist: true, picker: true, review: true }, "checklist"],
    [{ picker: true, review: true, inspecting: true, form: true, panel: true }, "picker"],
    [{ review: true, inspecting: true, form: true, approvals: true, overview: true, panel: true }, "review"],
    [{ inspecting: true, form: true, approvals: true }, "selection"],
    [{ form: true, approvals: true, panel: true }, "form"],
    [{ approvals: true, overview: true, panel: true }, "approval"],
    [{ approvals: true, empty: false }, "composer"],
    [{ overview: true, panel: true, completion: true }, "overview"],
    [{ panel: true, completion: true, card: true }, "panel"],
    [{ completion: true, card: true, shell: true }, "completion"],
    [{ card: true, shell: true, turn: true }, "card"],
    [{ shell: true, turn: true }, "shell"],
    [{ turn: true }, "working"],
    [{}, "composer"]
  ] as const
)("context precedence selects %s", (state, expected) => {
  expect(Dispatch.context({ ...idleContext, ...state })).toBe(expected)
})

test.each([["pageup", -1], ["pagedown", 1]] as const)("help %s scrolls without closing", (name, direction) => {
  const calls: unknown[] = []
  const event = key(name)
  expect(Dispatch.whichKeyKey(event, undefined, {
    close: () => calls.push("close"),
    type: (text) => calls.push(text),
    scroll: (step) => calls.push(step)
  })).toBe(true)
  expect(calls).toEqual([direction])
  expect(event.defaultPrevented).toBe(true)
})

test.each(
  [
    ["escape", "", true, ["close"]],
    ["a", "a", true, ["close", "?a"]],
    ["space", " ", true, ["close", "? "]],
    ["up", "\u001b[A", false, ["close"]],
    ["backspace", "\u007f", false, ["close"]]
  ] as const
)("help preserves typing or releases %s", (name, sequence, consumed, expected) => {
  const calls: unknown[] = []
  const event = key(name, {}, sequence)
  expect(Dispatch.whichKeyKey(event, undefined, {
    close: () => calls.push("close"),
    type: (text) => calls.push(text),
    scroll: (step) => calls.push(step)
  })).toBe(consumed)
  expect<ReadonlyArray<unknown>>(calls).toEqual(expected)
  expect(event.defaultPrevented).toBe(consumed)
})

test.each(["ctrl", "meta", "option"] as const)("help does not convert %s shortcuts into typed text", (modifier) => {
  const calls: unknown[] = []
  const event = key("a", { [modifier]: true })
  expect(Dispatch.whichKeyKey(event, undefined, {
    close: () => calls.push("close"),
    type: (text) => calls.push(text),
    scroll: (step) => calls.push(step)
  })).toBe(false)
  expect(calls).toEqual(["close"])
  expect(event.defaultPrevented).toBe(false)
})

test.each(["中", "é", "😀"])("help preserves a question beginning with Unicode %s", (text) => {
  const calls: unknown[] = []
  const event = key(text)
  expect(Dispatch.whichKeyKey(event, undefined, {
    close: () => calls.push("close"),
    type: (typed) => calls.push(typed),
    scroll: (step) => calls.push(step)
  })).toBe(true)
  expect(calls).toEqual(["close", `?${text}`])
  expect(event.defaultPrevented).toBe(true)
})

const flowSchema = Schema.Struct({
  count: Schema.Number,
  enabled: Schema.Boolean,
  mode: Schema.Literals(["one", "two"])
})
const flowForm = (): Dispatch.FlowForm => ({
  id: "request",
  flow: "check",
  fields: Form.formFieldsFor(flowSchema),
  draft: { count: "3", enabled: false, mode: "one" },
  focus: 0,
  error: "Old error"
})

test.each([["tab", false, 1], ["tab", true, 2], ["down", false, 1], ["up", false, 2]] as const)(
  "flow form %s shift=%s wraps the focused input",
  (name, shift, focus) => {
    let current: Dispatch.FlowForm | undefined = flowForm()
    const event = key(name, { shift })
    Dispatch.formKey(event, current, {
      change: (next) => {
        current = next
      },
      schema: () => flowSchema,
      input: () => ({}),
      fill: () => {
        throw new Error("Navigation must not submit")
      }
    })
    expect(current).toEqual({ ...flowForm(), focus })
    expect(event.defaultPrevented).toBe(true)
  }
)

test("boolean form input toggles and clears the prior error without submitting", () => {
  let current: Dispatch.FlowForm | undefined = { ...flowForm(), focus: 1 }
  const changes: Dispatch.FlowForm[] = []
  for (const value of [true, false]) {
    const event = key("space", {}, " ")
    Dispatch.formKey(event, current, {
      change: (next) => {
        current = next
        if (next !== undefined) changes.push(next)
      },
      schema: () => flowSchema,
      input: () => ({}),
      fill: () => {
        throw new Error("Toggle must not submit")
      }
    })
    expect(current?.draft.enabled).toBe(value)
    expect(current?.error).toBeUndefined()
    expect(event.defaultPrevented).toBe(true)
  }
  expect(changes).toHaveLength(2)
  expect(current?.draft).toEqual({ count: "3", enabled: false, mode: "one" })
})

test("select form navigation skips unavailable choices in both directions", () => {
  let current: Dispatch.FlowForm | undefined = {
    ...flowForm(),
    focus: 2,
    fields: [
      ...flowForm().fields.slice(0, 2),
      {
        name: "mode",
        label: "Mode",
        required: true,
        kind: "select",
        options: [{ value: "one", label: "One" }, { value: "blocked", label: "Blocked", disabled: true }, {
          value: "two",
          label: "Two"
        }]
      }
    ]
  }
  for (const [name, expected] of [["right", "two"], ["left", "one"], ["left", "two"]] as const) {
    const event = key(name)
    Dispatch.formKey(event, current, {
      change: (next) => {
        current = next
      },
      schema: () => flowSchema,
      input: () => ({}),
      fill: () => {
        throw new Error("Selection must not submit")
      }
    })
    expect(current?.draft.mode).toBe(expected)
    expect(current?.error).toBeUndefined()
    expect(event.defaultPrevented).toBe(true)
  }
})

test("invalid form input remains retryable; valid input closes before filling the captured request", () => {
  let current: Dispatch.FlowForm | undefined = {
    ...flowForm(),
    draft: { count: "Infinity", enabled: false, mode: "one" }
  }
  const calls: unknown[] = []
  const act = {
    change: (next: Dispatch.FlowForm | undefined) => {
      current = next
      calls.push(next === undefined ? "close" : "change")
    },
    schema: (id: string) => {
      expect(id).toBe("request")
      return flowSchema
    },
    input: (id: string) => {
      expect(id).toBe("request")
      return { routing: "captured" }
    },
    fill: (id: string, payload: Record<string, unknown>) => calls.push([id, payload])
  }
  Dispatch.formKey(key("return"), current, act)
  expect(current).toEqual({
    ...flowForm(),
    draft: { count: "Infinity", enabled: false, mode: "one" },
    error: "Count: not a number"
  })
  expect(calls).toEqual(["change"])
  current = { ...current!, draft: { count: "4", enabled: true, mode: "two" } }
  Dispatch.formKey(key("kpenter"), current, act)
  expect(current).toBeUndefined()
  expect(calls).toEqual(["change", "close", ["request", { routing: "captured", count: 4, enabled: true, mode: "two" }]])
})

test.each(["escape", "missing-schema", "missing-input"] as const)("form %s closes without launching", (reason) => {
  const calls: unknown[] = []
  const event = key(reason === "escape" ? "escape" : "return")
  Dispatch.formKey(event, flowForm(), {
    change: (next) => calls.push(next),
    schema: () => reason === "missing-schema" ? undefined : flowSchema,
    input: () => reason === "missing-input" ? undefined : {},
    fill: () => calls.push("fill")
  })
  expect(calls).toEqual([undefined])
  expect(event.defaultPrevented).toBe(true)
})

const worker = (status: Tab["status"]): Tab => ({
  id: "worker",
  title: "Review",
  depth: 0,
  prompt: "Review",
  seat: "test",
  file: "session",
  status,
  startedAt: 0
})

test.each([["return", ["leave", "open"]], ["kpenter", ["leave", "open"]], ["escape", ["leave"]]] as const)(
  "card %s changes focus before acting",
  (name, expected) => {
    const calls: unknown[] = []
    const event = key(name)
    expect(Dispatch.cardKey(event, {
      worker: undefined,
      move: (step) => calls.push(step),
      leave: () => calls.push("leave"),
      open: () => calls.push("open"),
      files: () => calls.push("files"),
      workerAction: () => calls.push("worker")
    })).toBe(true)
    expect<ReadonlyArray<unknown>>(calls).toEqual(expected)
    expect(event.defaultPrevented).toBe(true)
  }
)

test.each(
  [
    ["requested", ["stop"]],
    ["queued", ["stop"]],
    ["running", ["stop"]],
    ["waiting", ["stop"]],
    ["parked", ["stop"]],
    ["done", []],
    ["failed", []],
    ["cancelled", []]
  ] as const
)("card stop respects %s eligibility", (status, expected) => {
  const calls: unknown[] = []
  const event = key("x")
  expect(Dispatch.cardKey(event, {
    worker: worker(status),
    move: (step) => calls.push(step),
    leave: () => calls.push("leave"),
    open: () => calls.push("open"),
    files: () => calls.push("files"),
    workerAction: (tab, action) => {
      expect(tab.id).toBe("worker")
      calls.push(action)
    }
  })).toBe(true)
  expect<ReadonlyArray<unknown>>(calls).toEqual(expected)
  expect(event.defaultPrevented).toBe(true)
})

test.each([["cancelled", ["retry"]], ["failed", ["retry"]], ["running", []], ["done", []]] as const)(
  "r on a focused %s card resumes only a worker that can resume",
  (status, expected) => {
    const calls: unknown[] = []
    const event = key("r")
    expect(Dispatch.cardKey(event, {
      worker: worker(status),
      move: (step) => calls.push(step),
      leave: () => calls.push("leave"),
      open: () => calls.push("open"),
      files: () => calls.push("files"),
      workerAction: (_tab, action) => calls.push(action)
    })).toBe(true)
    expect<ReadonlyArray<unknown>>(calls).toEqual(expected)
    expect(event.defaultPrevented).toBe(true)
  }
)

const panel: Panel = {
  id: "checks",
  title: "Checks",
  summary: "Ready",
  rows: [{
    id: "check",
    label: "Check",
    details: [],
    action: { label: "Request", prompt: "  !echo literal  " }
  }]
}
const panelActs = (calls: unknown[]): Parameters<typeof Dispatch.panelKey>[3] => ({
  close: () => calls.push("close"),
  release: () => calls.push("release"),
  retryRun: (id) => calls.push(["retry", id]),
  continueRun: (id) => calls.push(["continue", id]),
  cancelRun: (id) => calls.push(["cancel", id]),
  fillRun: (id) => calls.push(["fill", id]),
  answerWorker: (id) => calls.push(["answer", id]),
  undo: (row, tab) => calls.push(["undo", row?.id, tab]),
  diff: (tab) => calls.push(["diff", tab]),
  workerAction: (tab, action) => calls.push(["worker", tab.id, action]),
  scroll: (step) => calls.push(["scroll", step]),
  navigate: () => calls.push("navigate"),
  send: (prompt) => calls.push(["send", prompt]),
  perform: (action) => calls.push(action)
})

test.each(
  [
    ["r", true, false, [["retry", "run/a"]]],
    ["r", true, true, [["retry", "run/a"]]],
    ["r", false, true, ["navigate"]],
    ["r", false, false, ["navigate"]],
    ["x", false, true, [["cancel", "run/a"]]],
    ["x", true, true, [["cancel", "run/a"]]],
    ["x", true, false, ["navigate"]],
    ["x", false, false, ["navigate"]],
    ["a", false, false, [["fill", "run/a"]]]
  ] as const
)("flow panel %s honors retry=%s stop=%s", (name, retry, stop, expected) => {
  const calls: unknown[] = []
  const event = key(name)
  Dispatch.panelKey(event, panel, {
    surface: "flow:run/a",
    navigation: Panels.initial(),
    worker: undefined,
    flow: { retry, continue: false, stop }
  }, panelActs(calls))
  expect<ReadonlyArray<unknown>>(calls).toEqual(expected)
  expect(event.defaultPrevented).toBe(true)
})

test.each(
  [
    ["c", true, [["continue", "run/a"]]],
    ["c", false, ["navigate"]],
    ["r", true, ["navigate"]]
  ] as const
)("parked flow panel %s honors continue=%s", (name, allowed, expected) => {
  const calls: unknown[] = []
  const event = key(name)
  Dispatch.panelKey(event, panel, {
    surface: "flow:run/a",
    navigation: Panels.initial(),
    worker: undefined,
    flow: { retry: false, continue: allowed, stop: true }
  }, panelActs(calls))
  expect<ReadonlyArray<unknown>>(calls).toEqual(expected)
  expect(event.defaultPrevented).toBe(true)
})

test("a panel prompt releases focus and sends literal text instead of running shell syntax", () => {
  const calls: unknown[] = []
  Dispatch.panelKey(key("a"), panel, {
    surface: "ui:checks",
    navigation: Panels.initial(),
    worker: undefined,
    flow: { retry: false, continue: false, stop: false }
  }, panelActs(calls))
  expect(calls).toEqual(["release", ["send", "!echo literal"]])
})

test("a panel prompt spelling a factory command remains literal text", () => {
  const calls: unknown[] = []
  const literal: Panel = {
    ...panel,
    rows: [{ id: "literal", label: "Literal", details: [], action: { label: "Send", prompt: "/retry #3065" } }]
  }
  Dispatch.panelKey(key("a"), literal, {
    surface: "ui:checks",
    navigation: Panels.initial(),
    worker: undefined,
    flow: { retry: false, continue: false, stop: false }
  }, panelActs(calls))
  expect(calls).toEqual(["release", ["send", "/retry #3065"]])
})

const composerActs = (calls: unknown[]): Parameters<typeof Dispatch.composerKey>[2] => ({
  stopSteering: () => calls.push("steering"),
  setText: (text) => calls.push(["text", text]),
  quit: () => calls.push("quit"),
  submit: (followUp) => calls.push(["submit", followUp]),
  restoreQueued: () => calls.push("restore"),
  pickModel: () => calls.push("model"),
  cycleModel: (step) => calls.push(["cycle", step]),
  toggleExpanded: () => calls.push("expand"),
  externalEditor: () => calls.push("editor")
})

test.each(
  [
    [true, true, true, "!command", ["steering"]],
    [false, true, true, "!command", ["turn"]],
    [false, false, true, "!command", ["shell"]],
    [false, false, false, "!command", [["text", ""]]],
    [false, false, false, "draft", []]
  ] as const
)("escape preserves cancellation precedence", (steering, turn, shell, text, expected) => {
  const calls: unknown[] = []
  Dispatch.composerKey(key("escape"), {
    text,
    steering,
    turn: turn ? { stop: () => calls.push("turn") } : undefined,
    shell: shell ? { cancel: () => calls.push("shell") } : undefined,
    history: new History(),
    scroll: null
  }, composerActs(calls))
  expect<ReadonlyArray<unknown>>(calls).toEqual(expected)
})

test("composer history preserves a nonempty draft until browsing starts and restores it", () => {
  const calls: unknown[] = []
  const history = new History(["older", "latest"])
  let text = "draft"
  const act = {
    ...composerActs(calls),
    setText: (next: string) => {
      text = next
      calls.push(next)
    }
  }
  const dispatch = (name: string) =>
    Dispatch.composerKey(
      key(name),
      { text, steering: false, turn: undefined, shell: undefined, history, scroll: null },
      act
    )
  dispatch("up")
  expect(calls).toEqual([])
  expect(text).toBe("draft")
  text = ""
  dispatch("up")
  dispatch("up")
  dispatch("down")
  dispatch("down")
  expect(calls).toEqual(["latest", "older", "latest", ""])
  expect(history.browsing).toBe(false)
})

test.each(
  [
    ["return", {}, []],
    ["tab", {}, []],
    ["up", {}, []],
    ["escape", {}, ["dismiss"]]
  ] as const
)("an empty completion %s cannot accept a nonexistent item", (name, modifiers, expected) => {
  const calls: unknown[] = []
  const event = key(name, modifiers)
  const consumed = Dispatch.menuKey(event, { ...completion, items: [] }, {
    select: () => calls.push("select"),
    dismiss: () => calls.push("dismiss"),
    accept: () => calls.push("accept")
  })
  expect<ReadonlyArray<unknown>>(calls).toEqual(expected)
  expect(consumed).toBe(name === "up" || name === "escape")
  expect(event.defaultPrevented).toBe(consumed)
})

test.each([["escape", ["close"]], ["return", [["pick", 2]]], ["kpenter", [["pick", 2]]], ["up", []]] as const)(
  "dialog %s handles selection even when no rows remain",
  (name, expected) => {
    const calls: unknown[] = []
    Dispatch.dialogKey(key(name), { kind: "models", selected: 2 }, { rows: 0, composerFocused: false }, {
      close: () => calls.push("close"),
      select: () => calls.push("select"),
      type: () => calls.push("type"),
      pick: (index) => calls.push(["pick", index])
    })
    expect<ReadonlyArray<unknown>>(calls).toEqual(expected)
  }
)

test.each(
  [
    ["tree", "up", [["tree", -1]]],
    ["tree", "j", [["tree", 1]]],
    ["tree", "right", ["pane"]],
    ["tree", "left", []],
    ["tree", "f", []],
    ["cards", "h", [["card", "left"]]],
    ["cards", "down", [["card", "down"]]],
    ["cards", "f", ["files"]],
    ["cards", "return", ["open"]],
    ["tree", "escape", ["close"]],
    ["cards", "i", ["release"]],
    ["cards", "pageup", [["scroll", -1]]],
    ["tree", "pagedown", [["scroll", 1]]],
    ["tree", "space", ["peek"]],
    ["cards", "space", []],
    ["tree", "a", ["answer"]],
    ["cards", "a", []],
    ["tree", "g", ["graph"]],
    ["cards", "g", []]
  ] as const
)("overview %s %s routes only its active pane", (pane, name, expected) => {
  const calls: unknown[] = []
  const event = key(name)
  Dispatch.overviewKey(event, { pane, worker: undefined }, {
    close: () => calls.push("close"),
    release: () => calls.push("release"),
    pane: () => calls.push("pane"),
    tree: (step) => calls.push(["tree", step]),
    peek: () => calls.push("peek"),
    answer: () => calls.push("answer"),
    graph: () => calls.push("graph"),
    card: (step) => calls.push(["card", step]),
    open: () => calls.push("open"),
    files: () => calls.push("files"),
    scroll: (step) => calls.push(["scroll", step]),
    workerAction: () => calls.push("worker"),
    stopMonitor: (id) => calls.push(["monitor", id])
  })
  expect<ReadonlyArray<unknown>>(calls).toEqual(expected)
  expect(event.defaultPrevented).toBe(true)
})

test.each(
  [
    ["y", true, [["decide", "approve"]]],
    ["n", true, [["decide", "deny"]]],
    ["y", false, []],
    ["n", false, []]
  ] as const
)("a selected build target decides on %s when offered (%s)", (name, offered, expected) => {
  const calls: unknown[] = []
  const event = key(name)
  Dispatch.overviewKey(event, { pane: "tree", worker: undefined }, {
    close: () => calls.push("close"),
    release: () => calls.push("release"),
    pane: () => calls.push("pane"),
    tree: (step) => calls.push(["tree", step]),
    peek: () => calls.push("peek"),
    answer: () => calls.push("answer"),
    graph: () => calls.push("graph"),
    card: (step) => calls.push(["card", step]),
    open: () => calls.push("open"),
    files: () => calls.push("files"),
    scroll: (step) => calls.push(["scroll", step]),
    workerAction: () => calls.push("worker"),
    stopMonitor: (id) => calls.push(["monitor", id]),
    decideTarget: offered ? (decision) => calls.push(["decide", decision]) : undefined
  })
  expect<ReadonlyArray<unknown>>(calls).toEqual(expected)
  expect(event.defaultPrevented).toBe(true)
})

test.each(
  [
    ["x", [["monitor", "watch"]]],
    ["r", []],
    ["s", []],
    ["j", [["tree", 1]]],
    ["space", ["peek"]],
    ["escape", ["close"]]
  ] as const
)("a selected monitor stops only on x; %s", (name, expected) => {
  const calls: unknown[] = []
  const event = key(name)
  Dispatch.overviewKey(event, { pane: "tree", worker: undefined, monitor: "watch" }, {
    close: () => calls.push("close"),
    release: () => calls.push("release"),
    pane: () => calls.push("pane"),
    tree: (step) => calls.push(["tree", step]),
    peek: () => calls.push("peek"),
    answer: () => calls.push("answer"),
    graph: () => calls.push("graph"),
    card: (step) => calls.push(["card", step]),
    open: () => calls.push("open"),
    files: () => calls.push("files"),
    scroll: (step) => calls.push(["scroll", step]),
    workerAction: () => calls.push("worker"),
    stopMonitor: (id) => calls.push(["monitor", id])
  })
  expect<ReadonlyArray<unknown>>(calls).toEqual(expected)
  expect(event.defaultPrevented).toBe(true)
})

test.each(
  [
    ["tree", "d", true, ["diff"]],
    ["cards", "u", true, ["undo"]],
    ["tree", "d", false, []],
    ["cards", "u", false, []]
  ] as const
)("overview %s %s runs the selected worker's run action when offered (%s)", (pane, name, offered, expected) => {
  const calls: unknown[] = []
  const event = key(name)
  Dispatch.overviewKey(event, { pane, worker: worker("done") }, {
    close: () => calls.push("close"),
    release: () => calls.push("release"),
    pane: () => calls.push("pane"),
    tree: (step) => calls.push(["tree", step]),
    peek: () => calls.push("peek"),
    answer: () => calls.push("answer"),
    graph: () => calls.push("graph"),
    card: (step) => calls.push(["card", step]),
    open: () => calls.push("open"),
    files: () => calls.push("files"),
    scroll: (step) => calls.push(["scroll", step]),
    workerAction: () => calls.push("worker"),
    stopMonitor: () => calls.push("stopMonitor"),
    diff: offered ? () => calls.push("diff") : undefined,
    undo: offered ? () => calls.push("undo") : undefined
  })
  expect<ReadonlyArray<unknown>>(calls).toEqual(expected)
  expect(event.defaultPrevented).toBe(true)
})

test.each(["escape", "return"])("scrubber %s returns to live without inspecting future data", (name) => {
  const calls: unknown[] = []
  const event = key(name)
  expect(Dispatch.scrubberKey(event, Activity.empty, 0, {
    follow: () => calls.push("follow"),
    inspect: (seq) => calls.push(seq)
  })).toBe(true)
  expect(calls).toEqual(["follow"])
  expect(event.defaultPrevented).toBe(true)
})

test.each([["left", { ctrl: true }], ["right", { meta: true }], ["up", { option: true }], ["a", {}]] as const)(
  "scrubber leaves %s shortcuts and text to their owner",
  (name, modifiers) => {
    const calls: unknown[] = []
    const event = key(name, modifiers)
    expect(Dispatch.scrubberKey(event, Activity.empty, 0, {
      follow: () => calls.push("follow"),
      inspect: (seq) => calls.push(seq)
    })).toBe(false)
    expect(calls).toEqual([])
    expect(event.defaultPrevented).toBe(false)
  }
)

test("u on the Summary undoes the selected row's turn", () => {
  const calls: unknown[] = []
  Dispatch.panelKey(key("u"), panel, {
    surface: "summary",
    navigation: { ...Panels.initial(), selected: 10 },
    worker: undefined,
    flow: { retry: false, continue: false, stop: false }
  }, panelActs(calls))
  expect(calls).toEqual([["undo", "check", undefined]])
})

test.each([["u", [["undo", undefined, "worker"]]], ["d", [["diff", "worker"]]], ["j", []], ["down", []]] as const)(
  "%s in a worker tab acts on its whole run, never a row",
  (name, expected) => {
    const calls: unknown[] = []
    const event = key(name)
    Dispatch.panelKey(event, panel, {
      surface: "tab:worker",
      navigation: Panels.initial(),
      worker: worker("done"),
      flow: { retry: false, continue: false, stop: false }
    }, panelActs(calls))
    expect<ReadonlyArray<unknown>>(calls).toEqual(expected)
    expect(event.defaultPrevented).toBe(true)
  }
)

test.each(["d", "u"] as const)("%s on a flow or custom panel keeps its own meaning", (name) => {
  const calls: unknown[] = []
  Dispatch.panelKey(key(name), panel, {
    surface: "ui:checks",
    navigation: Panels.initial(),
    worker: undefined,
    flow: { retry: false, continue: false, stop: false }
  }, panelActs(calls))
  expect(calls).toEqual(["navigate"])
})

test.each(
  [
    ["d", true, true, ["leave", "diff"], true],
    ["u", true, true, ["leave", "undo"], true],
    // Not offered: the letter leaves the card for the composer.
    ["d", false, false, ["leave"], false],
    ["u", true, false, ["leave"], false]
  ] as const
)("card %s with diff=%s undo=%s", (name, diff, undo, expected, consumed) => {
  const calls: unknown[] = []
  const event = key(name)
  expect(Dispatch.cardKey(event, {
    worker: worker("done"),
    move: (step) => calls.push(step),
    leave: () => calls.push("leave"),
    open: () => calls.push("open"),
    files: () => calls.push("files"),
    workerAction: () => calls.push("worker"),
    diff: diff ? () => calls.push("diff") : undefined,
    undo: undo ? () => calls.push("undo") : undefined
  })).toBe(consumed)
  expect<ReadonlyArray<unknown>>(calls).toEqual(expected)
  expect(event.defaultPrevented).toBe(consumed)
})

test.each(
  [
    ["escape", true, ["close"]],
    ["u", true, ["undo"]],
    ["u", false, []],
    ["up", true, [[-1, false]]],
    ["k", true, [[-1, false]]],
    ["down", true, [[1, false]]],
    ["j", true, [[1, false]]],
    ["pageup", true, [[-1, true]]],
    ["pagedown", true, [[1, true]]],
    ["x", true, []]
  ] as const
)("review %s (undo offered: %s)", (name, undo, expected) => {
  const calls: unknown[] = []
  const event = key(name)
  Dispatch.reviewKey(event, {
    undo: undo ? () => calls.push("undo") : undefined,
    close: () => calls.push("close"),
    scroll: (by, page) => calls.push([by, page])
  })
  expect<ReadonlyArray<unknown>>(calls).toEqual(expected)
  expect(event.defaultPrevented).toBe(true)
})

test.each(
  [
    ["escape", 0, ["close"]],
    ["up", 0, [2]],
    ["down", 2, [0]],
    ["space", 1, ["toggle"]],
    ["return", 1, ["undo"]],
    ["kpenter", 1, ["undo"]],
    ["a", 1, []]
  ] as const
)("checklist %s from row %s", (name, selected, expected) => {
  const calls: unknown[] = []
  const event = key(name)
  Dispatch.checklistKey(event, { rows: 3 }, {
    close: () => calls.push("close"),
    select: (update) => calls.push(update(selected)),
    toggle: () => calls.push("toggle"),
    undo: () => calls.push("undo")
  })
  expect<ReadonlyArray<unknown>>(calls).toEqual(expected)
  expect(event.defaultPrevented).toBe(true)
})

test("a declared panel action executes only after the action key, without sending chat text", () => {
  const calls: unknown[] = []
  const actionPanel: Panel = {
    ...panel,
    rows: [{
      id: "run",
      label: "Run",
      details: [],
      action: { label: "Open", action: { kind: "open", surface: "flow:run" } }
    }]
  }
  Dispatch.panelKey(key("a"), actionPanel, {
    surface: "ui:checks",
    navigation: Panels.initial(),
    worker: undefined,
    flow: { retry: false, continue: false, stop: false }
  }, panelActs(calls))
  expect(calls).toEqual([{ kind: "open", surface: "flow:run" }])
})

test.each(
  [
    ["return", { meta: true }, [["submit", true]]],
    ["enter", { option: true }, [["submit", true]]],
    ["up", { meta: true }, ["restore"]],
    ["up", { option: true }, ["restore"]],
    ["l", { ctrl: true }, ["model"]],
    ["p", { ctrl: true }, [["cycle", 1]]],
    ["p", { ctrl: true, shift: true }, [["cycle", -1]]],
    ["o", { ctrl: true }, ["expand"]],
    ["g", { ctrl: true }, ["editor"]],
    ["a", {}, []]
  ] as const
)("composer %s routes its explicit shortcut", (name, modifiers, expected) => {
  const calls: unknown[] = []
  Dispatch.composerKey(key(name, modifiers), {
    text: "draft",
    steering: false,
    turn: undefined,
    shell: undefined,
    history: new History(),
    scroll: null
  }, composerActs(calls))
  expect<ReadonlyArray<unknown>>(calls).toEqual(expected)
})

test.each([["", ["quit"], true], ["draft", [], false]] as const)(
  "Ctrl+D quits only an empty composer",
  (text, expected, prevented) => {
    const calls: unknown[] = []
    const event = key("d", { ctrl: true })
    Dispatch.composerKey(event, {
      text,
      steering: false,
      turn: undefined,
      shell: undefined,
      history: new History(),
      scroll: null
    }, composerActs(calls))
    expect<ReadonlyArray<unknown>>(calls).toEqual(expected)
    expect(event.defaultPrevented).toBe(prevented)
  }
)

test("a dialog takes ordered typing before its input mounts, preserving the composer draft", () => {
  const calls: unknown[] = []
  for (const event of [key("h"), key("i")]) {
    Dispatch.dialogKey(event, { kind: "models", selected: 0 }, { rows: 2, composerFocused: true }, {
      close: () => calls.push("close"),
      select: () => calls.push("select"),
      type: (text) => calls.push(["type", text]),
      pick: () => calls.push("pick")
    })
    expect(event.defaultPrevented).toBe(true)
  }
  expect(calls).toEqual([["type", "h"], ["type", "i"]])
})

test.each(["中", "é", "😀"])("an unmounted dialog filter captures Unicode %s", (text) => {
  const calls: unknown[] = []
  const event = key(text)
  Dispatch.dialogKey(event, { kind: "models", selected: 0 }, { rows: 2, composerFocused: true }, {
    close: () => calls.push("close"),
    select: () => calls.push("select"),
    type: (typed) => calls.push(["type", typed]),
    pick: () => calls.push("pick")
  })
  expect(calls).toEqual([["type", text]])
  expect(event.defaultPrevented).toBe(true)
})

test.each([["models", false]] as const)(
  "%s does not intercept ordinary mounted typing",
  (kind, composerFocused) => {
    const calls: string[] = []
    const event = key("a")
    Dispatch.dialogKey(event, { kind, selected: 0 }, { rows: 2, composerFocused }, {
      close: () => calls.push("close"),
      select: () => calls.push("select"),
      type: () => calls.push("type"),
      pick: () => calls.push("pick")
    })
    expect(calls).toEqual([])
    expect(event.defaultPrevented).toBe(false)
  }
)

test.each(
  [
    ["up", {}, 0, 3, 2],
    ["down", {}, 2, 3, 0],
    ["p", { ctrl: true }, 0, 3, 2],
    ["n", { ctrl: true }, 2, 3, 0],
    ["pageup", {}, 15, 30, 5],
    ["pagedown", {}, 25, 30, 29]
  ] as const
)("dialog %s navigates the current selection", (name, modifiers, initial, rows, expected) => {
  let selected = initial as number
  const calls: string[] = []
  const event = key(name, modifiers)
  Dispatch.dialogKey(event, { kind: "models", selected }, { rows, composerFocused: false }, {
    close: () => calls.push("close"),
    select: (update) => {
      selected = update(selected)
      calls.push("select")
    },
    type: () => calls.push("type"),
    pick: () => calls.push("pick")
  })
  expect(selected).toBe(expected)
  expect(calls).toEqual(["select"])
  expect(event.defaultPrevented).toBe(true)
})

const completion: Completion = {
  kind: "command",
  query: "he",
  start: 0,
  end: 3,
  items: [{ label: "help", insert: "/help", submit: true }, { label: "hotkeys", insert: "/hotkeys", submit: true }]
}

test.each(
  [
    ["tab", {}, false],
    ["return", {}, true],
    ["kpenter", {}, true]
  ] as const
)("completion %s explicitly accepts run=%s", (name, modifiers, run) => {
  const calls: unknown[] = []
  const event = key(name, modifiers)
  expect(Dispatch.menuKey(event, completion, {
    select: () => calls.push("select"),
    dismiss: () => calls.push("dismiss"),
    accept: (value) => calls.push(value)
  })).toBe(true)
  expect(calls).toEqual([run])
  expect(event.defaultPrevented).toBe(true)
})

test.each(
  [
    ["return", { shift: true }],
    ["return", { meta: true }],
    ["return", { option: true }],
    ["tab", { shift: true }],
    ["a", {}]
  ] as const
)("completion leaves modified or typing %s for its owner", (name, modifiers) => {
  const calls: string[] = []
  const event = key(name, modifiers)
  expect(Dispatch.menuKey(event, completion, {
    select: () => calls.push("select"),
    dismiss: () => calls.push("dismiss"),
    accept: () => calls.push("accept")
  })).toBe(false)
  expect(calls).toEqual([])
  expect(event.defaultPrevented).toBe(false)
})

test("a in a worker tab opens the form for that worker's ask", () => {
  const calls: unknown[] = []
  Dispatch.panelKey(key("a"), panel, {
    surface: "tab:worker",
    navigation: Panels.initial(),
    worker: worker("running"),
    flow: { retry: false, continue: false, stop: false }
  }, panelActs(calls))
  expect(calls).toEqual([["answer", "worker"]])
})

const askForm = (
  choice: number,
  options: ReadonlyArray<string> = ["sum", "plus"],
  answer?: string
): Dispatch.FlowForm & { readonly ask: Dispatch.AskChoices } => ({
  id: "ask:1",
  flow: "Rename add()",
  fields: [],
  draft: answer === undefined ? {} : { answer },
  focus: 0,
  ask: { question: "New name for add()?", options, choice }
})
const askAct = () => {
  const seen: { changed: Array<Dispatch.FlowForm | undefined>; filled: Array<Record<string, unknown>> } = {
    changed: [],
    filled: []
  }
  return {
    seen,
    act: {
      change: (next: Dispatch.FlowForm | undefined) => void seen.changed.push(next),
      schema: () => {
        throw new Error("An ask has no schema")
      },
      input: () => ({}),
      fill: (_: string, payload: Record<string, unknown>) => void seen.filled.push(payload)
    }
  }
}

test.each(
  [
    ["down", false, 0, 1],
    ["tab", false, 1, 2],
    ["down", false, 2, 2],
    ["up", false, 1, 0],
    ["tab", true, 0, 0]
  ] as const
)("ask form %s shift=%s moves the cursor from %i to %i without wrapping", (name, shift, from, to) => {
  const { seen, act } = askAct()
  const event = key(name, { shift })
  Dispatch.formKey(event, askForm(from), act)
  expect(seen.changed.map((form) => form?.ask?.choice)).toEqual([to])
  expect(seen.filled).toEqual([])
  expect(event.defaultPrevented).toBe(true)
})

test("an ask form answers the chosen option, a typed other…, and nothing blank; esc keeps the ask", () => {
  const cases: ReadonlyArray<[Dispatch.FlowForm, Array<Record<string, unknown>>]> = [
    [askForm(1), [{ answer: "plus" }]],
    [askForm(2, ["sum", "plus"], "  total "), [{ answer: "total" }]],
    [askForm(2, ["sum", "plus"], "   "), []],
    [askForm(0, [], "addAll"), [{ answer: "addAll" }]],
    [askForm(0, []), []]
  ]
  for (const [form, filled] of cases) {
    const { seen, act } = askAct()
    Dispatch.formKey(key("return"), form, act)
    expect(seen.filled).toEqual(filled)
    expect(seen.changed).toEqual(filled.length === 0 ? [] : [undefined])
  }
  const { seen, act } = askAct()
  Dispatch.formKey(key("escape"), askForm(0), act)
  expect(seen).toEqual({ changed: [undefined], filled: [] })
  // A free-text ask has no cursor to move: arrows leave it as it is.
  const free = askAct()
  Dispatch.formKey(key("down"), askForm(0, []), free.act)
  expect(free.seen).toEqual({ changed: [], filled: [] })
  expect(Dispatch.choices(askForm(0).ask)).toEqual(["sum", "plus", "other…"])
  expect(Dispatch.choices(askForm(0, []).ask)).toEqual([])
})
