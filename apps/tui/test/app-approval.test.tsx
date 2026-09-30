import { type Renderable, TextareaRenderable } from "@opentui/core"
import { testRender } from "@opentui/react/test-utils"
import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setImmediate, setTimeout } from "node:timers/promises"
import { act } from "react"
import { App } from "../src/app.tsx"
import type * as Approvals from "../src/approvals.ts"
import type * as Host from "../src/host.ts"

// Headless component units over the public Host approval boundary; the store
// double controls replies. Actual native focus, timers, and session storage run.
let root = ""
let previousRoot: string | undefined
let setup: Awaited<ReturnType<typeof testRender>> | undefined
let gate: ReturnType<typeof Promise.withResolvers<Host.Outcome>>
let gates: Array<ReturnType<typeof Promise.withResolvers<Host.Outcome>>> = []
let runCap: number | undefined
let pending: ReadonlyArray<Approvals.Pending> = []
let replies: Array<{ request: Approvals.Pending; choice: Approvals.Choice }> = []
let answer: NonNullable<Host.Host["approvals"]>["reply"]
let readPending: NonNullable<Host.Host["approvals"]>["pending"]
let pendingReads = 0
let inputs: Host.TurnInput[] = []
const request: Approvals.Pending = {
  requestId: "owned-approval",
  flow: "bash",
  subject: "run checks",
  source: "chat",
  identity: "run-checks",
  action: "proc:spawn",
  resource: "bash",
  tier: "irreversible",
  always: true
}
const frame = () => setup!.captureCharFrame()
const textarea = (node: Renderable): TextareaRenderable | undefined => {
  if (node instanceof TextareaRenderable) return node
  for (const child of node.getChildren()) {
    const found = textarea(child)
    if (found !== undefined) return found
  }
  return undefined
}
const press = async (name: string, ctrl = false, meta = false) => {
  await act(async () => {
    setup!.mockInput.pressKey(name, { ctrl, meta })
    await setImmediate()
  })
  await setup!.renderOnce()
}
const type = async (text: string) => {
  await act(async () => {
    await setup!.mockInput.typeText(text)
  })
  await setup!.renderOnce()
}
const waitFor = async (condition: () => boolean) => {
  const deadline = Date.now() + 5000
  while (!condition() && Date.now() < deadline) {
    await act(async () => {
      await setTimeout(10)
    })
    await setup!.renderOnce()
  }
  if (!condition()) throw new Error(`Approval state did not settle:\n${frame()}`)
}
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "tui-app-approval-"))
  mkdirSync(join(root, "workspace"))
  previousRoot = process.env.SMITHERS_TUI_SESSION_DIR
  process.env.SMITHERS_TUI_SESSION_DIR = join(root, "sessions")
  gate = Promise.withResolvers<Host.Outcome>()
  gates = []
  runCap = 100
  pending = [request]
  pendingReads = 0
  inputs = []
  readPending = async () => pending
  replies = []
  answer = async () => {
    pending = []
    return undefined
  }
  const host: Host.Host = {
    cwd: join(root, "workspace"),
    judged: false,
    get runCap() {
      return runCap
    },
    run: (input) => {
      inputs.push(input)
      const turn = inputs.length === 1 ? gate : Promise.withResolvers<Host.Outcome>()
      gates.push(turn)
      return { done: turn.promise, cancel: () => turn.resolve({ _tag: "cancelled" }) }
    },
    dispose: async () => {},
    approvals: {
      mode: "ask",
      authorize: async () => {},
      pending: () => {
        pendingReads++
        return readPending()
      },
      reply: (request, choice) => {
        replies.push({ request, choice })
        return answer(request, choice)
      }
    }
  }
  await act(async () => {
    setup = await testRender(
      <App
        host={host}
        seat="replay:test"
        models={[{ seat: "replay:test", label: "Replay", provider: "Fixture" }]}
        contextWindow={() => 10000}
      />,
      { width: 100, height: 36, exitOnCtrlC: false }
    )
  })
  await type("Run checks")
  await press("RETURN")
})
afterEach(async () => {
  try {
    await act(async () => {
      for (const turn of gates) turn.resolve({ _tag: "cancelled" })
      await Promise.all(gates.map((turn) => turn.promise))
      await setImmediate()
      setup?.renderer.destroy()
    })
  } finally {
    setup = undefined
    if (previousRoot === undefined) delete process.env.SMITHERS_TUI_SESSION_DIR
    else process.env.SMITHERS_TUI_SESSION_DIR = previousRoot
    rmSync(root, { recursive: true, force: true })
  }
})

test.each([{ key: "y", choice: "once" }, { key: "n", choice: "deny" }, { key: "a", choice: "run" }] as const)(
  "armed $key sends exactly the displayed owned request with $choice",
  async ({ key, choice }) => {
    await waitFor(() => frame().includes("y Allow once"))
    expect(frame()).toContain("? run run checks")
    await press(key)
    expect(replies).toEqual([{ request, choice }])
    expect(replies[0]?.request).toBe(request)
    await waitFor(() => !frame().includes("? run run checks"))
    expect(frame()).not.toContain("y Allow once")
  },
  15000
)

test("a pending approval counts beside Summary until it is answered", async () => {
  await waitFor(() => frame().includes("y Allow once"))
  expect(frame()).toContain("Summary ◆1")
  await press("y")
  await waitFor(() => !frame().includes("◆1"))
}, 15000)

test("typing a draft disarms approval keys and clearing it re-arms the visible request", async () => {
  await waitFor(() => frame().includes("y Allow once"))
  await type("Draft")
  expect(frame()).not.toContain("y Allow once")
  await press("y")
  expect(replies).toEqual([])
  expect(frame()).toContain("Drafty")
  await press("c", true)
  await waitFor(() => frame().includes("y Allow once"))
  await press("y")
  expect(replies).toEqual([{ request, choice: "once" }])
}, 15000)

test(
  "unresolved reply and stale polling cannot answer an owned request twice or steal its replacement identity",
  async () => {
    const reply = Promise.withResolvers<Awaited<ReturnType<NonNullable<Host.Host["approvals"]>["reply"]>>>()
    const stale = Promise.withResolvers<ReadonlyArray<Approvals.Pending>>()
    const replacement: Approvals.Pending = { ...request, requestId: "replacement-approval", subject: "run formatter" }
    answer = () => reply.promise
    try {
      await waitFor(() => frame().includes("y Allow once"))
      const previousReads = pendingReads
      readPending = () => stale.promise
      await press("y")
      await waitFor(() => pendingReads > previousReads)
      await press("y")
      await press("n")
      await press("a")
      expect(replies).toEqual([{ request, choice: "once" }])
      await act(async () => {
        stale.resolve([request, replacement])
        await setImmediate()
      })
      await waitFor(() => frame().includes("? run run formatter"))
      expect(frame()).not.toContain("? run run checks")
      expect(frame()).not.toContain("y Allow once")
      expect(replies).toEqual([{ request, choice: "once" }])
      await press("c", true)
      await act(async () => {
        pending = [replacement]
        readPending = async () => pending
        reply.resolve(undefined)
        await reply.promise
        await setImmediate()
      })
      await waitFor(() => frame().includes("? run run formatter") && frame().includes("y Allow once"))
      answer = async () => {
        pending = []
        return undefined
      }
      await press("n")
      expect(replies).toEqual([{ request, choice: "once" }, { request: replacement, choice: "deny" }])
      expect(replies[1]?.request).toBe(replacement)
    } finally {
      await act(async () => {
        stale.resolve([])
        reply.resolve(undefined)
        await reply.promise
        await setImmediate()
      })
    }
  },
  15000
)

test("an edit's row shows its hunk, and the row and the footer offer the same keys", async () => {
  const edit: Approvals.Pending = {
    requestId: "edit-approval",
    flow: "edit",
    subject: "math.js",
    source: "chat",
    identity: "edit-math",
    preview: {
      added: 1,
      removed: 1,
      lines: ["-export function add(a, b) { return a - b; }", "+export function add(a, b) { return a + b; }"]
    },
    action: "fs:write",
    resource: join(root, "workspace", "math.js"),
    tier: "compensable",
    always: true
  }
  pending = [edit]
  await waitFor(() => frame().includes("? edit math.js  +1 −1"))
  await waitFor(() => frame().includes("y Allow once"))
  expect(frame()).toContain("- export function add(a, b) { return a - b; }")
  expect(frame()).toContain("+ export function add(a, b) { return a + b; }")
  expect(frame().split("y Allow once  n Deny change  a Allow edits this run")).toHaveLength(3)
  await press("n")
  expect(replies).toEqual([{ request: edit, choice: "deny" }])
}, 15000)

test("a row that cannot allow the run offers no a, in the row or the footer, and a is text", async () => {
  const outside: Approvals.Pending = {
    ...request,
    requestId: "outside-approval",
    flow: "write",
    subject: "/etc/hosts",
    action: "fs:write",
    resource: "/etc/hosts",
    always: false
  }
  pending = [outside]
  await waitFor(() => frame().includes("? write /etc/hosts") && frame().includes("y Allow once"))
  expect(frame().split("y Allow once  n Deny change")).toHaveLength(3)
  expect(frame()).not.toContain("a Allow")
  await press("a")
  expect(replies).toEqual([])
}, 15000)

test("a long changed line marks its omission at 80×24 while the composer and denial stay usable", async () => {
  await act(async () => {
    setup!.renderer.resize(80, 24)
  })
  const edit: Approvals.Pending = {
    ...request,
    requestId: "long-edit-approval",
    flow: "edit",
    subject: "math.js",
    action: "fs:write",
    resource: join(root, "workspace", "math.js"),
    preview: { added: 1, removed: 0, lines: [`+${"x".repeat(90)}; console.log(1)`] }
  }
  pending = [edit]
  await waitFor(() => frame().includes("? edit math.js  +1 −0") && frame().includes("n Deny change"))
  const changed = frame().split("\n").find((line) => line.includes("+ x"))
  expect(changed).toMatch(/\+ x+…\s*$/)
  await type("Draft")
  expect(frame()).toContain("Draft")
  expect(replies).toEqual([])
  await press("c", true)
  await waitFor(() => frame().includes("y Allow once"))
  await press("n")
  expect(replies).toEqual([{ request: edit, choice: "deny" }])
  await waitFor(() => !frame().includes("? edit math.js"))
}, 15000)

test.each(
  [
    { key: "y", choice: "once", rows: false },
    { key: "n", choice: "deny", rows: false },
    { key: "a", choice: "run", rows: false },
    { key: "a", choice: "run", rows: true }
  ] as const
)(
  "worker approval Alt+$key answers its owned request while printable keys remain a draft, rows=$rows",
  async ({ key, choice, rows }) => {
    const workerRequest: Approvals.Pending = { ...request, requestId: "worker-approval", source: "approval-worker" }
    await act(async () => {
      pending = [workerRequest]
      inputs[0]!.runtime!.delegate!({ id: "approval-worker", title: "Approval worker", prompt: "Run worker checks" })
      await setImmediate()
    })
    await press("ARROW_RIGHT", true)
    await press("ARROW_RIGHT", true)
    await waitFor(() => frame().includes("Subagent · Approval worker") && frame().includes("alt+y Allow once"))
    expect(frame()).toContain("alt+n Deny")
    expect(frame()).toContain("alt+a Allow commands this run")
    expect(frame()).not.toContain(" y Allow once")
    if (key === "y") {
      await press("?")
      expect(frame()).toContain("Approval")
      expect(frame()).toContain("Global")
      expect(frame()).toContain("alt+y")
      expect(frame()).toContain("alt+n")
      expect(frame()).toContain("alt+a")
      expect(replies).toEqual([])
      await press("?")
      await waitFor(() => frame().includes("alt+y Allow once"))
    }
    for (const printable of ["y", "n", "a"]) await press(printable)
    expect(replies).toEqual([])
    const composer = textarea(setup!.renderer.root)!
    expect(composer.plainText).toBe("yna")
    await press(key, false, true)
    expect(replies).toEqual([])
    expect(composer.plainText).toBe("yna")
    await press("c", true)
    await waitFor(() => frame().includes("alt+y Allow once"))
    if (rows) await press("TAB")
    await press(key, false, true)
    expect(replies).toEqual([{ request: workerRequest, choice }])
    expect(replies[0]!.request).toBe(workerRequest)
    await waitFor(() => !frame().includes("? bash run checks"))
  },
  15000
)

test.each(
  [
    { action: "cap", rows: false, draft: "", key: "y", choice: "once" },
    { action: "cap", rows: true, draft: "Keep this draft", key: "n", choice: "deny" },
    { action: "disabled-cap", rows: true, draft: "", key: "n", choice: "deny" },
    { action: "ask", rows: false, draft: "Keep this draft", key: "n", choice: "deny" },
    { action: "ask", rows: true, draft: "", key: "y", choice: "once" }
  ] as const
)(
  "Alt+A opens the current worker's $action without approving another worker, rows=$rows, draft=$draft",
  async ({ action, rows, draft, key, choice }) => {
    const workerRequest: Approvals.Pending = {
      ...request,
      requestId: "other-worker-edit",
      source: "writing-worker",
      flow: "write",
      subject: "update src/app.ts",
      action: "fs:write"
    }
    await act(async () => {
      pending = [workerRequest]
      inputs[0]!.runtime!.delegate!({ id: "answer-worker", title: "Answer worker", prompt: "Check the cap" })
      inputs[0]!.runtime!.delegate!({ id: "writing-worker", title: "Writing worker", prompt: "Update src/app.ts" })
      await setImmediate()
      if (action !== "ask") {
        gates[1]!.resolve({
          _tag: "failed",
          message: "cap",
          detail: "",
          error: { _tag: "flows/agent/BudgetExceeded", scope: "tokens", used: 100, max: 100 }
        })
        if (action === "disabled-cap") runCap = undefined
      } else {
        void inputs[1]!.runtime!.ask!({ question: "Which path?", to: "person" })
      }
      await setImmediate()
    })
    await press("ARROW_RIGHT", true)
    await press("ARROW_RIGHT", true)
    await waitFor(() => frame().includes("Subagent · Answer worker") && frame().includes("alt+y Allow once"))
    expect(frame()).toContain(action !== "ask" ? "alt+a Raise cap" : "Which path?")
    expect(frame()).toContain("alt+n Deny change")
    expect(frame()).not.toContain("alt+a Allow edits this run")
    await press("?")
    expect(frame()).not.toContain("Allow this run")
    expect(frame()).toContain("alt+y")
    expect(frame()).toContain("alt+n")
    await press("?")
    if (draft !== "") await type(draft)
    const editor = textarea(setup!.renderer.root)!
    if (draft !== "") {
      await press("HOME")
      await press("ARROW_RIGHT")
    }
    const cursor = editor.cursorOffset
    if (rows) await press("TAB")
    await press("a", false, true)
    expect(replies).toEqual([])
    if (action === "disabled-cap") {
      expect(frame()).not.toContain("tab Next")
      await press(key, false, true)
      expect(replies).toEqual([{ request: workerRequest, choice }])
      expect(inputs).toHaveLength(3)
      return
    }
    // The cap form steps through its fields; a free-text ask answers with Enter.
    const formKeys = action === "cap" ? "tab Next" : "enter Answer"
    expect(frame()).toContain(formKeys)
    if (action === "cap") expect(frame()).toMatch(/Cap\s+100/)
    else expect(frame()).toContain("Which path?")
    await act(async () => {
      await setTimeout(300)
    })
    await setup!.renderOnce()
    expect(frame()).toContain(formKeys)
    expect(frame()).not.toContain("alt+y Allow once")
    expect(replies).toEqual([])
    await press("ESCAPE")
    await waitFor(() => !frame().includes(formKeys))
    expect(textarea(setup!.renderer.root)).toBe(editor)
    expect(editor.plainText).toBe(draft)
    expect(editor.cursorOffset).toBe(cursor)
    if (draft !== "") {
      await type("X")
      expect(editor.plainText).toBe(`${draft.slice(0, cursor)}X${draft.slice(cursor)}`)
      await press("c", true)
    }
    await waitFor(() => frame().includes("alt+y Allow once"))
    await press(key, false, true)
    expect(replies).toEqual([{ request: workerRequest, choice }])
    expect(inputs).toHaveLength(3)
  },
  15000
)

test.each([[80, 24], [60, 18]])(
  "oversized approval preserves decision keys, composer and footer at %sx%s",
  async (width, height) => {
    pending = [{
      ...request,
      requestId: "oversized",
      subject: "node /repository/a-very-long-directory/check.mjs ".repeat(100) + "FINAL_ARGUMENT"
    }]
    await act(async () => setup!.renderer.resize(width!, height!))
    await waitFor(() => frame().includes("very-long-directory") && frame().includes("y Allow once"))
    const screen = frame()
    expect(screen).toContain("y Allow once  n Deny")
    expect(screen).toContain("Steer, or alt+enter to queue")
    expect(screen.split("\n")[height! - 2]).toContain("Replay")
    expect(screen.split("\n")[height! - 1]).toContain("y Allow")
    expect(screen).not.toContain("FINAL_ARGUMENT")
    const subjectRow = screen.split("\n").findIndex((row) => row.includes("very-long-directory"))
    await act(async () => {
      for (let i = 0; i < 120; i++) await setup!.mockMouse.scroll(20, subjectRow + 1, "down")
      await setTimeout(100)
    })
    await setup!.renderOnce()
    expect(frame()).toContain("FINAL_ARGUMENT")
    expect(frame()).toContain("y Allow once  n Deny")
    await type("Still usable")
    expect(frame()).toContain("Still usable")
    expect(replies).toEqual([])
  }
)
