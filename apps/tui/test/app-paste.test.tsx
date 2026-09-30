import { type Renderable, TextareaRenderable } from "@opentui/core"
import { testRender } from "@opentui/react/test-utils"
import { afterEach, beforeEach, expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setImmediate } from "node:timers/promises"
import { act } from "react"
import { App } from "../src/app.tsx"
import type * as Host from "../src/host.ts"

// The real renderer parses terminal bytes and pastes into its native editor.
// Controlled Host turns keep workers running without provider/model calls.
let root = ""
let previousRoot: string | undefined
let setup: Awaited<ReturnType<typeof testRender>> | undefined
let turns: Array<{ input: Host.TurnInput; done: ReturnType<typeof Promise.withResolvers<Host.Outcome>> }> = []
let cancellations: Host.TurnInput[] = []
const descendant = <T extends Renderable>(node: Renderable, kind: new(...args: never[]) => T): T | undefined => {
  if (node instanceof kind) return node
  for (const child of node.getChildren()) {
    const found = descendant(child, kind)
    if (found !== undefined) return found
  }
  return undefined
}
const composer = () => descendant(setup!.renderer.root, TextareaRenderable)!
const key = async (name: string, modifiers: { ctrl?: boolean } = {}) => {
  await act(async () => {
    setup!.mockInput.pressKey(name, modifiers)
    await setImmediate()
  })
  await setup!.renderOnce()
}
const terminalWrite = async (bytes: string) => {
  await act(async () => {
    setup!.renderer.stdin.emit("data", Buffer.from(bytes))
    await setImmediate()
  })
  await setup!.renderOnce()
}
const inserts = (index: number) =>
  Effect.runSync(turns[index]!.input.steering!.drain({ boundary: "worker-cell", wouldIdle: false })).inserts
    .map((message) => message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join(""))

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "tui-app-paste-"))
  const cwd = join(root, "workspace")
  mkdirSync(cwd)
  previousRoot = process.env.SMITHERS_TUI_SESSION_DIR
  process.env.SMITHERS_TUI_SESSION_DIR = join(root, "sessions")
  turns = []
  cancellations = []
  const host: Host.Host = {
    cwd,
    judged: false,
    dispose: async () => {},
    run: (input) => {
      const done = Promise.withResolvers<Host.Outcome>()
      turns.push({ input, done })
      return {
        done: done.promise,
        cancel: () => {
          cancellations.push(input)
          done.resolve({ _tag: "cancelled" })
        }
      }
    }
  }
  await act(async () => {
    setup = await testRender(
      <App
        host={host}
        seat="replay:chat"
        models={[{ seat: "replay:chat", label: "Chat", provider: "Fixture" }]}
        contextWindow={() => 10000}
      />,
      { width: 80, height: 24, exitOnCtrlC: false, kittyKeyboard: true }
    )
    await setImmediate()
  })
  await terminalWrite("Coordinate both agents\r")
  expect(turns).toHaveLength(1)
  await act(async () => {
    turns[0]!.input.runtime!.delegate!({ id: "agent-a", title: "Agent A", prompt: "Work on A" })
    turns[0]!.input.runtime!.delegate!({ id: "agent-b", title: "Agent B", prompt: "Work on B" })
    await setImmediate()
  })
  await setup!.renderOnce()
  expect(turns).toHaveLength(3)
  for (let index = 0; index < 3; index++) await key("ARROW_RIGHT", { ctrl: true })
  expect(setup!.captureCharFrame()).toContain("Continue Agent B")
  expect(composer().focused).toBe(true)
})

afterEach(async () => {
  try {
    await act(async () => {
      setup?.renderer.destroy()
      for (const turn of turns) turn.done.resolve({ _tag: "cancelled" })
      await Promise.all(turns.map((turn) => turn.done.promise))
      await setImmediate()
    })
  } finally {
    setup = undefined
    if (previousRoot === undefined) delete process.env.SMITHERS_TUI_SESSION_DIR
    else process.env.SMITHERS_TUI_SESSION_DIR = previousRoot
    rmSync(root, { recursive: true, force: true })
  }
})

test.each([
  { rows: false, burst: false, text: "explain pasted message" },
  { rows: true, burst: false, text: "explain pasted message" },
  { rows: true, burst: true, text: "explain café 😀\nsecond line" }
])(
  "bracketed paste rows=$rows burst=$burst retains text and sends only to the shown agent",
  async ({ rows, burst, text }) => {
    if (rows && !burst) {
      await key("TAB")
      expect(composer().focused).toBe(false)
      expect(composer().plainText).toBe("")
    }
    const suffix = " continued"
    await terminalWrite(`${burst ? "\t" : ""}\u001b[200~${text}\u001b[201~${burst ? suffix : ""}`)
    expect(composer().focused).toBe(true)
    expect(composer().plainText).toBe(text + (burst ? suffix : ""))
    if (!burst) await terminalWrite(suffix)
    expect(composer().plainText).toBe(text + suffix)
    expect(setup!.captureCharFrame()).toContain("explain")
    expect(cancellations).toEqual([])
    expect(turns).toHaveLength(3)
    await key("RETURN")
    expect(composer().plainText).toBe("")
    expect(inserts(0)).toEqual([])
    expect(inserts(1)).toEqual([])
    expect(inserts(2)).toEqual([text + suffix])
    expect(cancellations).toEqual([])
  }
)
