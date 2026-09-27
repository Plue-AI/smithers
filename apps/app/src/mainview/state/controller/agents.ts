import {
  AGENT_ROLES
} from "@smthrs/rpc/AgentRoles"
import type { AgentRole } from "@smthrs/rpc/AgentRoles"
import type { Harness } from "@smthrs/rpc/LocalApp"
import type { Card } from "../AppState"
import type { AppStore } from "../AppStore"
import type { ControllerContext } from "./context"

export const AGENTS_CARD_ID = "agents"

type AgentsCard = Extract<Card, { kind: "agents" }>

export type HarnessId = Harness["id"]

export interface AgentsController {
  /** `GET /api/agents` → app-agents. Silent where no server answers (the web, a test). */
  readonly loadAgents: () => Promise<void>
  /** The agents as the menus list them: the mirror, or the built-ins until it loads. */
  readonly agentRoles: () => ReadonlyArray<AgentRole>
  /** `agent.list`: the Agents card, at the transcript's tail. */
  readonly listAgents: () => Promise<string | void>

}

export interface AgentsControllerDependencies {
  readonly nextOrdinal: () => number
}

/** The agents in menu order from the store's mirror; the built-ins while it is empty. */
export const currentAgentRoles = (_store: Pick<AppStore, "collections">): ReadonlyArray<AgentRole> =>
  AGENT_ROLES

/** `GET /api/agents` into app-agents; usable before the controller exists (tabs.ts resolves a role on demand). */
export const loadAgents = async (ctx: Pick<ControllerContext, "store" | "baseUrl" | "boundedFetch">): Promise<void> => {
  ctx.store.dispatch({ type: "agents.loaded", actor: "system", agents: AGENT_ROLES })
}

export const createAgentsController = (ctx: ControllerContext, deps: AgentsControllerDependencies): AgentsController => {
  const { store } = ctx
  const { collections } = store

  const agentRoles: AgentsController["agentRoles"] = () => currentAgentRoles(store)

  const load: AgentsController["loadAgents"] = () => loadAgents(ctx)

  const agentsCard = (): AgentsCard | undefined => {
    const card = collections.cards.get(AGENTS_CARD_ID)
    return card?.kind === "agents" ? card : undefined
  }

  /*
   * The agent roles launch only through a harness session, which retired with
   * the local backend (docs/LOCAL-BACKEND-RETIREMENT.md). The card states
   * that the way the web host always has.
   */
  const agentsPayload = (): AgentsCard["payload"] => ({
    native: false,
    /*
     * The configured agent profiles (smithers-ui-DESIGN.md §3.3): label,
     * purpose, model, and the profile metadata — who it reports to, whether it
     * is a hired specialist — when the profile carries it. Launching stays
     * with the harnesses; a row's door is its recorded work (runs.list agent=).
     */
    agents: agentRoles().map((role) => ({
      id: role.id, label: role.label, purpose: role.purpose, harness: role.harness, harnessName: role.harness, model: role.model, builtin: role.builtin,
      ...(role.reportsTo === undefined ? {} : { reportsTo: role.reportsTo }), ...(role.kind === undefined ? {} : { kind: role.kind }),
      available: false, reason: "", account: ""
    }))
  })

  /** The Agents card: at the tail when the human (or the model) asked for it, in place when a mutation refreshes it. */
  const renderAgentsCard = (toTail: boolean, error?: string): void => {
    const existing = agentsCard()
    if (!toTail && existing === undefined) return
    store.dispatch({
      type: "card.upsert",
      actor: ctx.commandActor,
      card: {
        id: AGENTS_CARD_ID,
        kind: "agents",
        title: "Agents",
        status: "active",
        createdAt: existing?.createdAt ?? Date.now(),
        ordinal: toTail || existing === undefined ? deps.nextOrdinal() : existing.ordinal,
        payload: { ...agentsPayload(), ...(error === undefined ? {} : { error }) }
      }
    })
  }

  const listAgents: AgentsController["listAgents"] = async () => {
    renderAgentsCard(true)
  }


  return { loadAgents: load, agentRoles, listAgents }
}
