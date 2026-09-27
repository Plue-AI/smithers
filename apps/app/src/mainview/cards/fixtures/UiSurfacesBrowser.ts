import { createElement } from "react"
import { createRoot } from "react-dom/client"
import { CardView } from "../../ChatCards"
import type { CardViewProps } from "../../ChatCards"
import { createAppStore } from "../../state/AppStore"
import { createAppController } from "../../state/AppController"
import { silentAgent } from "../../state/TestFixtures"
import type { FlowName } from "../../flows/FlowName"
import { SubagentBatch, SubagentFinished } from "../../SubagentGrid"
import { fixtureCards, fixtureSubagents } from "./UiSurfaces"

/*
 * The surfaces smithers-ui-DESIGN.md extends, mounted as the real card shell
 * over the real store and command registry on an isolated origin, for the
 * screenshot probe (e2e/probes/ui-surfaces.test.ts). `?theme=dark` renders
 * the dark theme; `?card=<id>` mounts one card alone.
 */
const params = new URLSearchParams(location.search)
document.documentElement.dataset.theme = params.get("theme") === "dark" ? "dark" : "light"
const only = params.get("card")

const store = await createAppStore({ kind: "localStorage", storage: localStorage })
// The store seeds a few cards of its own (the agents roster among them); the fixture's rows replace them.
for (const card of fixtureCards()) {
  await store.dispatch({ type: "card.upsert", actor: "system", card }).isPersisted.promise
}
store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "owner", allowlisted: true, admin: false, scopesPlain: null })
const seededAgents = JSON.stringify(store.collections.cards.get("agents")?.payload)
const controller = createAppController(store, silentAgent, {
  fetchImpl: async () => new Response("{}", { status: 404 }),
  cloudSocketUrl: () => undefined,
  cloudLspSocketUrl: () => undefined
})
const commands: Array<{ name: string; args?: string }> = []
const refusals: Array<{ name: string; args?: string; error: string }> = []
declare global {
  interface Window { uiSurfaces: { commands: typeof commands; refusals: typeof refusals; card: (id: string) => unknown; seededAgents: string } }
}
window.uiSurfaces = { commands, refusals, card: (id) => store.collections.cards.get(id), seededAgents }
const run = (name: FlowName, args?: string) => {
  commands.push({ name, args })
  void controller.commands.run(name, args).then(async (result) => {
    await store.settled?.()
    if (result.status === "failed") refusals.push({ name, args, error: result.error })
    render()
  })
}
const noop = () => {}
// The subagent grid (#2162) as the chat draws it: header, cards, and the finished row.
const subagents = fixtureSubagents(Date.now())
const root = createRoot(document.getElementById("fixture")!)
const render = () => {
  const cards = fixtureCards().map((seed) => store.collections.cards.get(seed.id) ?? seed).filter((card) => only === null || card.id === only)
  root.render(createElement("div", { className: "transcript", style: { display: "flex", flexDirection: "column", gap: "16px" } },
    ...cards.map((card) => createElement(CardView, {
      key: card.id, card, maximized: false, onMaximize: noop, onMinimize: noop, onOpenInTab: noop,
      onDecideApproval: (id: string, decision: string) => commands.push({ name: "approval.approve" as FlowName, args: `${id} ${decision}` }),
      onRunCommand: run, onConnectGitHub: noop, worldDocuments: [], signedOut: false, projectionStore: store
    } as unknown as CardViewProps)),
    ...(only === null || only === "subagents" ? [createElement("div", { key: "subagents", "data-testid": "subagents" },
      createElement(SubagentBatch, { items: subagents, onRunCommand: run }),
      createElement(SubagentFinished, { subagent: subagents[2]!.subagent, color: subagents[2]!.color }))] : [])))
}
render()
