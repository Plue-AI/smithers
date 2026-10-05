import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { Card } from "@smthrs/rpc/Cards"
import type { AppController } from "../state/AppController"
import { ControllerTestProvider } from "../ControllerContext"
import { CARD_RENDERERS } from "./CardRenderers"
import { createDesignWorld } from "../state/seams/DesignWorld"
import { terminalSlot } from "./TerminalCard"
const actions = { onDecideApproval: () => {}, onConnectGitHub: () => {}, onRunWorkflow: () => {}, onStopRun: () => {}, onRetryRun: () => {}, onChooseWorkflowRepo: () => {}, worldDocuments: [], onChangeWorldDocument: () => {}, onRunCommand: () => {} }
const card: Extract<Card, { kind: "terminal" }> = { id: "terminal:term-retry-1", kind: "terminal", title: "Shell", status: "active", createdAt: 1, ordinal: 1, payload: { id: "term-retry-1" } }
test("production registry refuses unavailable scope even when the design seed has a terminal", () => {
  const controller = { design: createDesignWorld({ timers: { set: () => 0, clear: () => {} } }), cloudTerminal: { attach: () => { throw new Error("attach") }, input: () => { throw new Error("input") } } } as unknown as AppController
  expect(renderToStaticMarkup(<ControllerTestProvider controller={controller}>{CARD_RENDERERS.terminal.render(card, actions)}</ControllerTestProvider>)).toBe("")
})
test("watcher and frozen slots have no keyboard callback", () => {
  const owner = { kind: "person", login: "ben", name: "Ben", avatar_url: "https://github.com/ben.png", color_index: 0 } as const
  const base = { id: "term1", title: "Shell", branch: "b1", owner, agents: [], watchers: [], viewer_is_owner: true, frozen: false }
  const typed = () => { throw new Error("input") }
  const writable = terminalSlot(base, undefined, typed) as React.ReactElement<{ onData?: unknown; readOnly: boolean }>
  expect(writable.props.onData).toBe(typed)
  for (const patch of [{ viewer_is_owner: false }, { frozen: true }]) {
    const slot = terminalSlot({ ...base, ...patch }, undefined, typed) as React.ReactElement<{ onData?: unknown; readOnly: boolean }>
    expect(slot.props.onData).toBeUndefined()
    expect(slot.props.readOnly).toBe(true)
  }
})
