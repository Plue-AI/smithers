import { act } from "react"
import { expect, test } from "bun:test"
import { createRoot } from "./views/testDom"
import { LiveChannel, type LiveSocket } from "../runtime/LiveChannel"
import { createDesignWorld } from "../state/seams/DesignWorld"
import type { AppController } from "../state/AppController"
import { ControllerTestProvider } from "../ControllerContext"
import { CARD_RENDERERS } from "./CardRenderers"
const actions = { onDecideApproval: () => {}, onConnectGitHub: () => {}, onRunWorkflow: () => {}, onStopRun: () => {}, onRetryRun: () => {}, onChooseWorkflowRepo: () => {}, worldDocuments: [], onChangeWorldDocument: () => {}, onRunCommand: () => {} }
test("registry reads the three real topics, never seed data, and clears a refused subscription", async () => {
  const frames: unknown[] = []
  const socket: LiveSocket = { readyState: 0, onopen: null, onclose: null, onmessage: null, send: frame => frames.push(JSON.parse(String(frame))), close: () => {} }
  const live = new LiveChannel({ socket: () => socket })
  const controller = { live, design: createDesignWorld({ timers: { set: () => 0, clear: () => {} } }) } as unknown as AppController
  const host = document.createElement("div"), root = createRoot(host)
  const card = { id: "branch:b-retry", kind: "branch", title: "Branch", status: "active", createdAt: 1, ordinal: 1, payload: { id: "b-retry" } } as const
  try {
    await act(async () => root.render(<ControllerTestProvider controller={controller}>{CARD_RENDERERS.branch.render(card, actions)}</ControllerTestProvider>))
    expect(host.textContent).toBe("")
    socket.readyState = 1; socket.onopen?.()
    expect(frames).toEqual([{ t: "sub", id: 1, topic: "branch:b-retry" }, { t: "sub", id: 2, topic: "branch:b-retry:activity" }, { t: "sub", id: 3, topic: "branch:b-retry:files" }])
    const snap = async (id: number, data: unknown) => act(async () => socket.onmessage?.({ data: JSON.stringify({ t: "snap", id, cursor: 1, data }) }))
    await snap(1, { id: "b-retry", name: "Captured live branch", machine: { state: "asleep" }, terminals: [], presence: [], ssh_line: "ssh -p 2222 live@localhost" })
    await snap(2, [])
    expect(host.textContent).toBe("")
    await snap(3, [])
    expect(host.textContent).toContain("Captured live branch")
    expect(host.textContent).toContain("Asleep")
    expect(host.textContent).not.toContain("Retry failed webhooks")
    expect(host.querySelector("[data-flow]")).toBeNull()
    await act(async () => socket.onmessage?.({ data: JSON.stringify({ t: "err", id: 1, code: "permission" }) }))
    expect(host.textContent).toBe("")
  } finally { await act(async () => root.unmount()); live.dispose() }
})
