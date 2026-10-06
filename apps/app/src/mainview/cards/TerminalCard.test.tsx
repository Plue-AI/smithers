import { expect, test } from "bun:test"
import { act } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { createRoot } from "./views/testDom"
import type { Card } from "@smthrs/rpc/Cards"
import type { AppController } from "../state/AppController"
import { ControllerTestProvider } from "../ControllerContext"
import { CARD_RENDERERS } from "./CardRenderers"
import { createDesignWorld } from "../state/seams/DesignWorld"
import { terminalSlot } from "./TerminalCard"
import { LiveChannel, type LiveSocket } from "../runtime/LiveChannel"
const actions = { onDecideApproval: () => {}, onConnectGitHub: () => {}, onRunWorkflow: () => {}, onStopRun: () => {}, onRetryRun: () => {}, onChooseWorkflowRepo: () => {}, worldDocuments: [], onChangeWorldDocument: () => {}, onRunCommand: () => {} }
const card: Extract<Card, { kind: "terminal" }> = { id: "terminal:term-retry-1", kind: "terminal", title: "Shell", status: "active", createdAt: 1, ordinal: 1, payload: { id: "term-retry-1" } }
const design = (enabled = true) => createDesignWorld({ enabled, timers: { set: () => 0, clear: () => {} } })
test("production registry preserves design terminals outside install hosts", () => {
  const controller = { design: design() } as unknown as AppController
  const html = renderToStaticMarkup(<ControllerTestProvider controller={controller}>{CARD_RENDERERS.terminal.render(card, actions)}</ControllerTestProvider>)
  expect(html).toContain('class="smithers-card terminal-view"')
  expect(html).toContain("Coding agent")
  expect(html).toContain("Watching")
})
test("disabled install seed cannot attach or grant input without a provider", () => {
  const controller = { design: design(false), cloudTerminal: { attach: () => { throw new Error("attach") }, input: () => { throw new Error("input") } } } as unknown as AppController
  expect(renderToStaticMarkup(<ControllerTestProvider controller={controller}>{CARD_RENDERERS.terminal.render(card, actions)}</ControllerTestProvider>)).toBe("")
})
test("watcher and frozen slots suppress both keyboard and geometry callbacks", () => {
  const owner = { kind: "person", login: "ben", name: "Ben", avatar_url: "https://github.com/ben.png", color_index: 0 } as const
  const base = { id: "term1", title: "Shell", branch: "b1", owner, agents: [], watchers: [], viewer_is_owner: true, frozen: false }
  const typed = () => { throw new Error("input") }
  const resize = () => { throw new Error("resize") }
  const writable = terminalSlot(base, undefined, typed, resize) as React.ReactElement<{ onData?: unknown; onResize?: unknown; readOnly: boolean }>
  expect(writable.props.onData).toBe(typed)
  expect(writable.props.onResize).toBe(resize)
  for (const patch of [{ viewer_is_owner: false }, { frozen: true }, { viewer_is_owner: false, frozen: true }]) {
    const slot = terminalSlot({ ...base, ...patch }, undefined, typed, resize) as typeof writable
    expect(slot.props.onData).toBeUndefined()
    expect(slot.props.onResize).toBeUndefined()
    expect(slot.props.readOnly).toBe(true)
  }
})

test("mounted registry takes live metadata over the seed and gates owner keys during rebase and watching", async () => {
  const frames: Array<{ t: string; id: number; topic?: string }> = []
  const socket: LiveSocket = { readyState: 1, onopen: null, onclose: null, onmessage: null,
    send: frame => { if (typeof frame === "string") frames.push(JSON.parse(frame)) }, close: () => {} }
  const live = new LiveChannel({ socket: () => socket })
  const inputs: string[] = [], attached: string[] = [], detached: string[] = []
  let viewer = "ben"
  const controller = { design: design(), live,
    terminalCards: { repo: "o/r", branch: () => "b1", available: () => true, viewer: () => viewer },
    commands: { submit: () => { throw new Error("live input must use the byte seam") } },
    // A byte transport double is required on this laptop, which has no machine runtime.
    // The registry, live decoder, binding, View and xterm adapter are production code.
    cloudTerminal: { attach: (_repo: string, id: string, attachment: { onOutput: (bytes: string) => void }) => {
      attached.push(id); attachment.onOutput("replay\r\nlive\r\n"); return () => detached.push(id)
    }, input: (_id: string, bytes: string) => inputs.push(bytes), resize: () => {} }
  } as unknown as AppController
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host)
  const owner = { kind: "person", login: "ben", name: "Ben", avatar_url: "https://github.com/ben.png", color_index: 0 }
  let cursor = 0
  const snapshot = async (frozen: boolean, id = card.payload.id) => {
    const sub = frames.find(frame => frame.t === "sub" && frame.topic === "branch:b1")!
    expect(sub).toBeDefined()
    await act(async () => socket.onmessage?.({ data: JSON.stringify({ t: "snap", id: sub.id, cursor: ++cursor,
      data: { terminals: [{ id, title: "Live shell", owner, agents: [], watchers: [], command: "pnpm check", frozen }] } }) }))
  }
  const render = async (id = card.payload.id) => act(async () => root.render(<ControllerTestProvider controller={controller}>
    {CARD_RENDERERS.terminal.render({ ...card, payload: { id } }, actions)}</ControllerTestProvider>))
  const input = async () => {
    const deadline = Date.now() + 4000
    while (!host.querySelector(".xterm-helper-textarea") && Date.now() < deadline) await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
    const field = host.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea")!
    expect(field).not.toBeNull()
    return field
  }
  try {
    await render()
    socket.onopen?.()
    await snapshot(false)
    expect(host.querySelector("h2")!.textContent).toBe("Live shell")
    expect(host.textContent).not.toContain("Coding agent")
    for (const [who, frozen, writable] of [["ben", false, true], ["ben", true, false], ["alice", false, false], ["alice", true, false], ["ben", false, true]] as const) {
      viewer = who
      await snapshot(frozen)
      const field = await input()
      expect(host.querySelector(".terminal-output > div")!.hasAttribute("inert")).toBe(!writable)
      inputs.length = 0
      await act(async () => field.dispatchEvent(new KeyboardEvent("keypress", { key: "a", charCode: 97, keyCode: 97, bubbles: true })))
      expect(inputs).toEqual(writable ? ["a"] : [])
      expect(host.textContent!.includes("Watching")).toBe(who === "alice")
      expect(host.textContent!.includes("Rebasing…")).toBe(frozen)
    }
    await snapshot(false, "term-next")
    await render("term-next")
    await input()
    expect(attached).toContain("term-next")
    expect(detached).toContain(card.payload.id)
  } finally {
    await act(async () => root.unmount()); host.remove(); live.dispose()
  }
  expect(detached).toContain("term-next")
})
