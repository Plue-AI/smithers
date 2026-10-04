/*
 * The Terminal card (T-APP-12): the owner types and everyone else watches an
 * inert emulator; the stream replays the stored lines and then each line the
 * seed appends. Expected bytes and copy are literals.
 */
import { describe, expect, test } from "bun:test"
import { act, useReducer } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import type { Card } from "@smthrs/rpc/Cards"
import { ControllerTestProvider } from "../ControllerContext"
import type { AppController } from "../state/AppController"
import { ALICE, createDesignWorld, MAYA, type ActorId, type DesignTimers, type DesignWorld } from "../state/seams/DesignWorld"
import { CARD_RENDERERS } from "./CardRenderers"
import { designTerminalStream, ownerInput, useOwnerInput } from "./TerminalCard"
import { createRoot } from "./views/testDom"

const still: DesignTimers = { set: () => 0, clear: () => {} }
const make = (viewer: ActorId = MAYA): DesignWorld => createDesignWorld({ timers: still, viewer })
const owned = (design: DesignWorld, by: ActorId = MAYA): string => {
  const result = design.newTerminal("b-retry", by)
  if (!result.ok || result.id === undefined) throw new Error("terminal refused")
  return result.id
}

describe("owner input", () => {
  test("keys echo, backspace erases one, Enter clears the echoed line and sends the command", () => {
    const written: string[] = []
    const sent: string[] = []
    const type = ownerInput(() => data => written.push(String(data)), command => sent.push(command))
    type("pnpm tesx\x7f")
    type("t\r")
    expect(written).toEqual(["p", "n", "p", "m", " ", "t", "e", "s", "x", "\b \b", "t", "\r\x1b[2K"])
    expect(sent).toEqual(["pnpm test"])
  })

  test("backspace on an empty line writes nothing; Ctrl-C drops the line; control bytes never reach the buffer", () => {
    const written: string[] = []
    const sent: string[] = []
    const type = ownerInput(() => data => written.push(String(data)), command => sent.push(command))
    type("\x7f")
    type("ab\x03")
    type("\x1b[A")
    type("c\r")
    expect(written).toEqual(["a", "b", "^C\r\n", "[", "A", "c", "\r\x1b[2K"])
    expect(sent).toEqual(["[Ac"])
  })

  test("without a writer yet, typing still sends", () => {
    const sent: string[] = []
    ownerInput(() => undefined, command => sent.push(command))("ls\r")
    expect(sent).toEqual(["ls"])
  })

  test("a re-render mid-typing (a seed update) keeps the half-typed command", async () => {
    const sent: string[] = []
    let type!: (data: string) => void
    let rerender!: () => void
    const Probe = () => {
      const [, bump] = useReducer((n: number) => n + 1, 0)
      rerender = bump
      type = useOwnerInput(() => undefined, command => sent.push(command))
      return null
    }
    const host = document.body.appendChild(document.createElement("div"))
    const root = createRoot(host)
    try {
      await act(async () => root.render(<Probe />))
      const first = type
      type("pnpm te")
      await act(async () => rerender())
      expect(type).toBe(first)
      type("st\r")
      expect(sent).toEqual(["pnpm test"])
    } finally {
      await act(async () => root.unmount())
      host.remove()
    }
  })
})

describe("terminal stream", () => {
  test("replays the stored lines, then the prompt, then each line the owner's command appends", () => {
    const design = make()
    const id = owned(design)
    const written: string[] = []
    const stop = designTerminalStream(design, id, () => {})(data => written.push(String(data)))
    expect(written).toEqual(["maya@retry-webhooks $ "])
    design.typeTerminal(id, "pnpm test", MAYA)
    expect(written.slice(1)).toEqual([
      "\x1b[2mmaya@retry-webhooks $ pnpm test\x1b[0m\r\n",
      "\x1b[32m✓ 42 passed\x1b[0m\r\n",
      "maya@retry-webhooks $ "
    ])
    design.setBranch("b-log", { waitPosition: 2 })
    expect(written).toHaveLength(4)
    stop?.()
    design.typeTerminal(id, "ls", MAYA)
    expect(written).toHaveLength(4)
  })

  test("a seeded terminal replays every stored line before its prompt and hands the writer out", () => {
    const design = make()
    const stored = design.world().terminals.find(each => each.id === "term-retry-1")!.lines.length
    const written: string[] = []
    let writer: ((data: string | Uint8Array) => void) | undefined
    designTerminalStream(design, "term-retry-1", write => { writer = write })(data => written.push(String(data)))
    expect(stored).toBeGreaterThan(0)
    expect(written).toHaveLength(stored + 1)
    expect(written.at(-1)).toBe("agent@retry-webhooks $ ")
    expect(typeof writer).toBe("function")
  })

  test("a terminal the world does not hold writes nothing", () => {
    const written: string[] = []
    designTerminalStream(make(), "term-missing")(data => written.push(String(data)))
    expect(written).toEqual([])
  })
})

describe("terminal card mount", () => {
  const controller = (design: DesignWorld) => ({ design, commands: { submit: () => Promise.resolve({ status: "executed" }) } }) as unknown as AppController
  const card = (id: string): Extract<Card, { kind: "terminal" }> =>
    ({ id: `terminal:${id}`, kind: "terminal", title: id, status: "active", createdAt: 1, ordinal: 1, payload: { id } })
  const actions = { onDecideApproval: () => {}, onConnectGitHub: () => {}, onRunWorkflow: () => {}, onStopRun: () => {}, onRetryRun: () => {},
    onChooseWorkflowRepo: () => {}, worldDocuments: [], onChangeWorldDocument: () => {}, onRunCommand: () => {} }
  const render = (design: DesignWorld, id: string) => renderToStaticMarkup(<ControllerTestProvider controller={controller(design)}>
    {CARD_RENDERERS.terminal.render(card(id), actions)}
  </ControllerTestProvider>)

  test("the owner's terminal takes input; a watcher's and the coding agent's are inert and read Watching", () => {
    const design = make()
    const mine = render(design, owned(design))
    expect(mine).toContain('data-kind="terminal"')
    expect(mine).toContain("retry-webhooks")
    expect(mine).not.toContain("Watching")
    expect(mine).not.toContain("inert")
    const agents = render(design, "term-retry-1")
    expect(agents).toContain("Watching")
    expect(agents).toContain("inert")
    const asAlice = make(ALICE)
    const theirs = render(asAlice, owned(asAlice, MAYA))
    expect(theirs).toContain("Watching")
    expect(theirs).toContain("inert")
  })

  test("a terminal the world does not hold renders nothing", () => {
    expect(render(make(), "term-missing")).toBe("")
  })
})
