import { testRender } from "@opentui/react/test-utils"
import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setImmediate, setTimeout } from "node:timers/promises"
import { act } from "react"
import { App } from "../src/app.tsx"
import type * as Host from "../src/host.ts"

// Needs you from the chat: an ask a worker puts to the person shows beside Summary and on its card, and
// `a` answers it when it is the only one. Only Host execution is controlled; asks run through the real
// workspace and its runtime ports.
let root = ""
let previousRoot: string | undefined
let setup: Awaited<ReturnType<typeof testRender>> | undefined
let turns: Array<{ input: Host.TurnInput; done: ReturnType<typeof Promise.withResolvers<Host.Outcome>> }> = []
const frame = () => setup!.captureCharFrame()
const render = async () => {
  await setup!.renderOnce()
}
const type = async (text: string) => {
  await act(async () => {
    await setup!.mockInput.typeText(text)
  })
  await render()
}
const key = async (name: string) => {
  await act(async () => {
    setup!.mockInput.pressKey(name)
    await setImmediate()
  })
  await render()
}
const waitFor = async (condition: () => boolean) => {
  const deadline = Date.now() + 5000
  while (!condition() && Date.now() < deadline) {
    await act(async () => {
      await setTimeout(10)
    })
    await render()
  }
  if (!condition()) throw new Error(`Did not settle:\n${frame()}`)
}
/** Past the moment an ask, or its answer form, takes keys. */
const settle = async () => {
  await act(async () => {
    await setTimeout(450)
  })
  await render()
}
/** The chat delegates `ids`; each worker's turn is `turns[n]`. */
const delegate = async (...ids: ReadonlyArray<string>) => {
  await act(async () => {
    for (const id of ids) turns[0]!.input.runtime!.delegate!({ id, title: `Rename ${id}() in math.js`, prompt: id })
    turns[0]!.done.resolve({ _tag: "done", answer: "Requested." })
    await setImmediate()
  })
  await waitFor(() => turns.length === 1 + ids.length)
}
/** Worker `index` asks the person; the returned function reads the answer once given. */
const ask = async (index: number, question: string, options?: ReadonlyArray<string>) => {
  let answered: Promise<{ readonly answer: string }> | undefined
  await act(async () => {
    answered = turns[index]!.input.runtime!.ask!({ question, ...(options === undefined ? {} : { options }) })
    await setImmediate()
  })
  return () => answered!
}
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "tui-app-asks-"))
  mkdirSync(join(root, "workspace"))
  previousRoot = process.env.SMITHERS_TUI_SESSION_DIR
  process.env.SMITHERS_TUI_SESSION_DIR = join(root, "sessions")
  turns = []
  const host: Host.Host = {
    cwd: join(root, "workspace"),
    judged: false,
    dispose: async () => {},
    run: (input) => {
      const done = Promise.withResolvers<Host.Outcome>()
      turns.push({ input, done })
      return { done: done.promise, cancel: () => done.resolve({ _tag: "cancelled" }) }
    }
  }
  await act(async () => {
    setup = await testRender(
      <App
        host={host}
        seat="replay:chat"
        workerSeat="replay:worker"
        models={[{ seat: "replay:chat", label: "Replay", provider: "Fixture" }]}
        contextWindow={() => 10000}
      />,
      { width: 120, height: 36, exitOnCtrlC: false }
    )
  })
  await type("Rename add")
  await key("RETURN")
})
afterEach(async () => {
  try {
    await act(async () => {
      for (const turn of turns) turn.done.resolve({ _tag: "cancelled" })
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

test("shows the one ask beside Summary and on its card, and a answers it from the chat", async () => {
  await delegate("add")
  expect(frame()).not.toContain("◆1")
  const answered = await ask(1, "New name for add()?", ["sum", "plus"])
  await waitFor(() => frame().includes("Summary ◆1"))
  expect(frame()).toContain("◆ Rename add() in math.js · waiting 0:0")
  expect(frame()).toContain("New name for add()?  1 sum  2 plus")
  expect(frame()).toContain("a Answer  enter Open")
  expect(frame()).toContain("ctrl+s Summary  a Answer")
  await act(async () => {
    await setTimeout(450)
  })
  await render()
  await type("a")
  expect(frame()).toContain("◆ New name for add()?")
  expect(frame()).toContain("> sum")
  expect(frame()).toContain("  plus")
  expect(frame()).toContain("  other…")
  expect(frame()).toContain("enter Answer  esc Back")
  expect(frame()).not.toContain("enter Run")
  // The card above no longer offers what the form now does.
  expect(frame()).not.toContain("a Answer  enter Open")
  await key("ARROW_DOWN")
  expect(frame()).toContain("> plus")
  await key("RETURN")
  expect(await answered()).toMatchObject({ answer: "plus" })
  await waitFor(() => !frame().includes("◆1"))
})

test("takes a typed answer under other…, and keeps the ask open on esc", async () => {
  await delegate("add")
  const answered = await ask(1, "New name for add()?", ["sum"])
  await waitFor(() => frame().includes("Summary ◆1"))
  await act(async () => {
    await setTimeout(450)
  })
  await render()
  await type("a")
  await key("ESCAPE")
  await waitFor(() => !frame().includes("enter Answer"))
  expect(frame()).toContain("Summary ◆1")
  await type("a")
  await key("ARROW_DOWN")
  expect(frame()).toContain("> ")
  // Enter on a blank typed answer sends nothing.
  await key("RETURN")
  expect(frame()).toContain("enter Answer")
  await type("total")
  await key("RETURN")
  expect(await answered()).toMatchObject({ answer: "total" })
})

test("a free-text ask shows its whole question and answers with what was typed", async () => {
  await delegate("add")
  const question = "What should the new name for add() be, given that sum is already exported from utils.js?"
  const answered = await ask(1, question)
  await waitFor(() => frame().includes("Summary ◆1"))
  await act(async () => {
    await setTimeout(450)
  })
  await render()
  await type("a")
  expect(frame().replace(/[\s┃]+/g, "")).toContain(`◆${question}`.replace(/\s+/g, ""))
  await settle()
  await type("addAll")
  await key("RETURN")
  expect(await answered()).toMatchObject({ answer: "addAll" })
})

test("with two asks waiting, a types and the count shows both", async () => {
  await delegate("add", "sub")
  await ask(1, "New name for add()?", ["sum"])
  await ask(2, "New name for sub()?", ["minus"])
  await waitFor(() => frame().includes("Summary ◆2"))
  await act(async () => {
    await setTimeout(450)
  })
  await render()
  expect(frame()).not.toContain("a Answer")
  await type("a")
  expect(frame()).not.toContain("enter Answer")
})

test("a started message keeps its a", async () => {
  await delegate("add")
  await ask(1, "New name for add()?", ["sum"])
  await waitFor(() => frame().includes("Summary ◆1"))
  await act(async () => {
    await setTimeout(450)
  })
  await render()
  await type("Rename a")
  expect(frame()).not.toContain("enter Answer")
  expect(frame()).toContain("Rename a")
})

test("a chat message typed straight after a stays typed in the form and answers nothing", async () => {
  await delegate("add")
  const answered = await ask(1, "Session cookie or bearer header?", ["Session cookie", "Bearer header"])
  let settled = false
  void answered().then(() => {
    settled = true
  })
  await waitFor(() => frame().includes("Summary ◆1"))
  await settle()
  await type("and x")
  await key("RETURN")
  await setImmediate()
  expect(settled).toBe(false)
  expect(frame()).toContain("Summary ◆1")
  expect(frame()).toContain("> and x")
  expect(frame()).toContain("enter Answer  esc Back")
  // Once the person has seen it, enter sends what is typed.
  await settle()
  await key("RETURN")
  expect(await answered()).toMatchObject({ answer: "and x" })
})

test("a number picks its choice in the answer form", async () => {
  await delegate("add")
  const answered = await ask(1, "Session cookie or bearer header?", ["Session cookie", "Bearer header"])
  await waitFor(() => frame().includes("Summary ◆1"))
  await settle()
  await type("a")
  await settle()
  await type("2")
  expect(await answered()).toMatchObject({ answer: "Bearer header" })
  await waitFor(() => !frame().includes("◆1"))
})
