import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { createDesignWorld } from "../state/seams/DesignWorld"
import { ControllerTestProvider } from "../ControllerContext"
import type { AppController } from "../state/AppController"
import { CARD_RENDERERS } from "./CardRenderers"
const actions = { onDecideApproval: () => {}, onConnectGitHub: () => {}, onRunWorkflow: () => {}, onStopRun: () => {}, onRetryRun: () => {}, onChooseWorkflowRepo: () => {}, worldDocuments: [], onChangeWorldDocument: () => {}, onRunCommand: () => {} }
test("Members stays empty with seeded roster while production dependencies are unavailable", () => {
  const design = createDesignWorld({ timers: { set: () => 0, clear: () => {} } })
  const controller = { design, commands: { submit: () => { throw new Error("dispatch") } } } as unknown as AppController
  const card = { id: "members", kind: "members", title: "Members", status: "active", createdAt: 1, ordinal: 1, payload: {} } as const
  expect(renderToStaticMarkup(<ControllerTestProvider controller={controller}>{CARD_RENDERERS.members.render(card, actions)}</ControllerTestProvider>)).toBe("")
})
