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
let pending: ReadonlyArray<Approvals.Pending> = []
let replies: Array<{ request: Approvals.Pending; choice: Approvals.Choice }> = []
let answer: NonNullable<Host.Host["approvals"]>["reply"]
let readPending: NonNullable<Host.Host["approvals"]>["pending"]
let pendingReads = 0
const request: Approvals.Pending = {
  requestId: "owned-approval",
  flow: "bash",
  subject: "run checks",
  source: "chat",
  action: "proc:spawn",
  tier: "irreversible",
  always: true
}
const frame = () => setup!.captureCharFrame()
const press = async (name: string, ctrl = false) => {
  await act(async () => {
    setup!.mockInput.pressKey(name, { ctrl })
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
  pending = [request]
  pendingReads = 0
  readPending = async () => pending
  replies = []
  answer = async () => {
    pending = []
    return undefined
  }
  const host: Host.Host = {
    cwd: join(root, "workspace"),
    judged: false,
    run: () => ({ done: gate.promise, cancel: () => gate.resolve({ _tag: "cancelled" }) }),
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
      { width: 100, height: 30, exitOnCtrlC: false }
    )
  })
  await type("Run checks")
  await press("RETURN")
})
afterEach(async () => {
  try {
    await act(async () => {
      gate.resolve({ _tag: "cancelled" })
      await gate.promise
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
    await waitFor(() => frame().includes("y allow"))
    expect(frame()).toContain("? bash run checks")
    await press(key)
    expect(replies).toEqual([{ request, choice }])
    expect(replies[0]?.request).toBe(request)
    await waitFor(() => !frame().includes("? bash run checks"))
    expect(frame()).not.toContain("y allow")
  },
  15000
)

test("a pending approval counts beside Summary until it is answered", async () => {
  await waitFor(() => frame().includes("y allow"))
  expect(frame()).toContain("Summary ◆1")
  await press("y")
  await waitFor(() => !frame().includes("◆1"))
}, 15000)

test("typing a draft disarms approval keys and clearing it re-arms the visible request", async () => {
  await waitFor(() => frame().includes("y allow"))
  await type("Draft")
  expect(frame()).not.toContain("y allow")
  await press("y")
  expect(replies).toEqual([])
  expect(frame()).toContain("Drafty")
  await press("c", true)
  await waitFor(() => frame().includes("y allow"))
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
      await waitFor(() => frame().includes("y allow"))
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
      await waitFor(() => frame().includes("? bash run formatter"))
      expect(frame()).not.toContain("? bash run checks")
      expect(frame()).not.toContain("y allow")
      expect(replies).toEqual([{ request, choice: "once" }])
      await press("c", true)
      await act(async () => {
        pending = [replacement]
        readPending = async () => pending
        reply.resolve(undefined)
        await reply.promise
        await setImmediate()
      })
      await waitFor(() => frame().includes("? bash run formatter") && frame().includes("y allow"))
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
