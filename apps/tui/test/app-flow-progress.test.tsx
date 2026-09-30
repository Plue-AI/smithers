import { testRender } from "@opentui/react/test-utils"
import { afterEach, beforeEach, expect, test } from "bun:test"
import { Schema } from "effect"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setImmediate, setTimeout } from "node:timers/promises"
import { act } from "react"
import { App } from "../src/app.tsx"
import { FlowError, type Port, type Settled } from "../src/flows.ts"
import type * as Host from "../src/host.ts"
import * as Session from "../src/session.ts"
import * as Theme from "../src/theme.ts"

// Component units: native App rendering and real storage over controlled public
// Host/FlowPort boundaries. Debounce and clock timers run without replacement.
let root = ""
let cwd = ""
let previousRoot: string | undefined
let previousTheme = Theme.activeTheme()
let setup: Awaited<ReturnType<typeof testRender>> | undefined
let launch: ReturnType<typeof Promise.withResolvers<string>>
let remote: ReturnType<typeof Promise.withResolvers<Settled>>
let chat: ReturnType<typeof Promise.withResolvers<Host.Outcome>>
let chats: string[] = []
let watches: string[] = []
const frame = () => setup!.captureCharFrame()
const records = () => Session.list(cwd).flatMap((summary) => Session.load(summary.file))
const waitFor = async (condition: () => boolean) => {
  const deadline = Date.now() + 5000
  while (!condition() && Date.now() < deadline) {
    await act(async () => {
      await setTimeout(10)
    })
    await setup!.renderOnce()
  }
  if (!condition()) throw new Error(`App progress did not settle:\n${frame()}`)
}
const submit = async (text: string) => {
  await act(async () => {
    await setup!.mockInput.typeText(text)
    await setup!.mockInput.pressKeys(["RETURN"])
  })
  await setup!.renderOnce()
}
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "tui-app-progress-"))
  cwd = join(root, "workspace")
  mkdirSync(cwd)
  previousRoot = process.env.SMITHERS_TUI_SESSION_DIR
  previousTheme = Theme.activeTheme()
  process.env.SMITHERS_TUI_SESSION_DIR = join(root, "sessions")
  launch = Promise.withResolvers<string>()
  remote = Promise.withResolvers<Settled>()
  chat = Promise.withResolvers<Host.Outcome>()
  chats = []
  watches = []
  const host: Host.Host = {
    cwd,
    judged: false,
    run: (input) => {
      chats.push(input.prompt)
      return { done: chat.promise, cancel: () => chat.resolve({ _tag: "cancelled" }) }
    },
    dispose: async () => {}
  }
  const port: Port = {
    discover: async () => [{
      name: "review",
      description: "Review",
      kind: "module",
      modelInvocable: true,
      flows: [],
      capabilities: [],
      path: join(cwd, "flows/review/flow.ts")
    }],
    input: async () => Schema.Struct({}),
    body: async () => {
      throw new FlowError("refused", "Module flow")
    },
    plan: async () => ({ raw: {} }),
    start: () => launch.promise,
    resume: async (runId) => ({ runId }),
    watch: (runId) => {
      watches.push(runId)
      return { done: remote.promise, close: () => {} }
    },
    events: async () => [],
    cancel: async () => {},
    dispose: async () => {}
  }
  await act(async () => {
    setup = await testRender(
      <App
        host={host}
        flows={port}
        seat="replay:test"
        models={[{ seat: "replay:test", label: "Replay", provider: "Fixture" }]}
        contextWindow={() => 10000}
      />,
      { width: 100, height: 30, exitOnCtrlC: false }
    )
    await setImmediate()
  })
  await submit("/flow review")
})
afterEach(async () => {
  try {
    await act(async () => {
      // Release fixture gates before unmount; cleanup does not assert /quit.
      launch.resolve("owned-review")
      remote.resolve({ kind: "cancelled" })
      chat.resolve({ _tag: "cancelled" })
      await setImmediate()
      setup?.renderer.destroy()
    })
  } finally {
    setup = undefined
    Theme.setTheme(previousTheme)
    if (previousRoot === undefined) delete process.env.SMITHERS_TUI_SESSION_DIR
    else process.env.SMITHERS_TUI_SESSION_DIR = previousRoot
    rmSync(root, { recursive: true, force: true })
  }
})

test.each([
  {
    status: "done",
    head: /✓ review · \d+ms → Review finished/,
    outcome: { kind: "done", answer: "Review finished" } satisfies Settled
  },
  {
    status: "failed",
    head: /✗ review · failed: Review refused/,
    outcome: { kind: "failed", message: "Review refused" } satisfies Settled
  },
  { status: "cancelled", head: /■ review · stopped/, outcome: { kind: "cancelled" } satisfies Settled }
])(
  "the chat card stays pending through launch and execution, then shows real $status",
  async ({ status, head, outcome }) => {
    // Waiting on rendered public state exercises the real 300 ms debounce;
    // it asserts no wall-time performance bound and patches no clock.
    await waitFor(() => frame().includes("review · requested"))
    expect(watches).toEqual([])
    expect(frame()).not.toMatch(head)
    await submit("Chat during launch")
    expect(chats).toEqual(["Chat during launch"])
    expect(frame()).toContain("review · requested")
    await act(async () => {
      launch.resolve("owned-review")
      await setImmediate()
    })
    await waitFor(() => frame().includes("review · running"))
    expect(watches).toEqual(["owned-review"])
    expect(records().filter((record) => record.type === "flow").at(-1)?.run.status).toBe("running")
    expect(frame()).not.toMatch(head)
    await act(async () => {
      await setup!.mockInput.typeText("Still usable")
    })
    await setup!.renderOnce()
    expect(frame()).toContain("Still usable")
    expect(frame()).toContain("review · running")
    await act(async () => {
      remote.resolve(outcome)
      await setImmediate()
    })
    await waitFor(() => head.test(frame()))
    expect(frame()).not.toContain("review · running")
    // The card is the only report: no toast repeats it.
    expect(frame().match(/review ·/g)).toHaveLength(1)
    expect(records().filter((record) => record.type === "flow").at(-1)?.run.status).toBe(status)
    expect(frame()).toContain("Still usable")
  },
  15000
)
