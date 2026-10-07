import { actorSharedState } from "../ActorBindings"
import { randomUuid } from "../../runtime/RandomUuid"
import { assignInstallAgentModel } from "./models"
import { CardSchema } from "@smthrs/rpc/Cards"
import type { LiveChannel } from "../../runtime/LiveChannel"
import {
  AGENT_ROLES,
  knownModelLabel,
  MODEL_ID
} from "@smthrs/rpc/AgentRoles"
import type { AgentRole } from "@smthrs/rpc/AgentRoles"
import type { Card, RepositoryFlow } from "../AppState"
import type { AppStore } from "../AppStore"
import { resolveTargetRepo } from "../RepoContext"
import type { ControllerContext } from "./context"

export const AGENTS_CARD_ID = "agents"

type AgentsCard = Extract<Card, { kind: "agents" }>
/** One row of the Agents card: a built-in role or a repository agent flow. */
export type AgentProfileRow = Extract<AgentsCard["payload"], { native: boolean }>["agents"][number]

export interface AgentsController {
  /** The agents as the menus list them: the mirror, or the built-ins until it loads. */
  readonly agentRoles: () => ReadonlyArray<AgentRole>
  /** `agent.list`: the Agents card, at the transcript's tail. */
  readonly assignAgentModel: (role: string, model: string) => Promise<string | void>
  readonly listAgents: (role?: string, model?: string) => Promise<string | void>

}

export interface AgentsControllerDependencies {
  readonly refreshSettings?: () => Promise<unknown>
  readonly install?: boolean
  readonly live?: Pick<LiveChannel, "subscribe" | "getSnapshot">
  readonly nextOrdinal: () => number
}

/** The agents in menu order from the store's mirror; the built-ins while it is empty. */
export const currentAgentRoles = (_store: Pick<AppStore, "collections">): ReadonlyArray<AgentRole> =>
  AGENT_ROLES.filter(role => role.id !== "explainer")

/**
 * The model a flow declares, as its frontmatter wrote it: `provider:modelId`
 * or a bare seat name (`sol`). The row shows the display name the built-in
 * roles give that id ("GPT-6 Sol") when it is a known one, else the id as
 * written, never a label this app invented; a seat the harness could read
 * as a flag is no model.
 */
export const flowModelOf = (seat: string): AgentProfileRow["model"] | undefined => {
  const written = seat.trim()
  const colon = written.indexOf(":")
  const provider = colon === -1 ? "" : written.slice(0, colon)
  const id = colon === -1 ? written : written.slice(colon + 1)
  return MODEL_ID.test(id) ? { provider, id, label: knownModelLabel(id) ?? id } : undefined
}

/**
 * A flow with a model is an agent: its row, or none for a flow that names no
 * model. Its label is its id: neither `flow.mdx` frontmatter (description,
 * capabilities, model, flows, budget) nor the factory projection (id,
 * description, summary, featured) declares a title or name for a flow.
 */
export const agentProfileOf = (flow: RepositoryFlow): AgentProfileRow | undefined => {
  if (flow.model === null) return undefined
  const model = flowModelOf(flow.model)
  if (model === undefined) return undefined
  return { id: flow.id, label: flow.id, purpose: flow.description, model, builtin: false, available: false, reason: "", account: "" }
}

/**
 * The loaded repository's agents: its flow catalog rows that declare a model
 * (`flows/<name>/flow.mdx` with `model`), in catalog order. The catalog is
 * the one the slash leaves and the homepage read (seams/RepositoryFlowsSeam.ts);
 * no repository, or one whose catalog has not loaded, lists none.
 */
export const repositoryAgentProfiles = (store: AppStore): ReadonlyArray<AgentProfileRow> => {
  const target = resolveTargetRepo(store, undefined)
  if ("error" in target) return []
  return (store.collections.repositoryFlows.get(target.repo)?.flows ?? []).flatMap((flow) => {
    const row = agentProfileOf(flow)
    return row === undefined ? [] : [row]
  })
}

export const createAgentsController = (ctx: ControllerContext, deps: AgentsControllerDependencies): AgentsController => {
  const { store } = ctx
  const { collections } = store

  const agentRoles: AgentsController["agentRoles"] = () => currentAgentRoles(store)

  const agentsCard = (): AgentsCard | undefined => {
    const card = collections.cards.get(AGENTS_CARD_ID)
    return card?.kind === "agents" ? card : undefined
  }

  /*
   * The agent roles launch only through a harness session, which retired with
   * the local backend (docs/LOCAL-BACKEND-RETIREMENT.md). The card states
   * that the way the web host always has.
   */
  const shared = actorSharedState(ctx, "agents", () => ({
    served: undefined as AgentsCard["payload"] | undefined, stopLive: undefined as (() => void) | undefined,
    selectedAgent: undefined as string | undefined, selectedModel: undefined as string | undefined, generation: 0, pending: new Set<string>(), assignmentTail: Promise.resolve() as Promise<unknown>
  }))
  const agentsPayload = (): AgentsCard["payload"] => shared.served ?? (deps.install ? { native: false, install: true, agents: [] } : {
    native: false,
    /*
     * The built-in roles, then the loaded repository's agent flows: label,
     * purpose, model, and its kind when the profile carries one. Launching
     * stays with the harnesses; a row's door is its recorded work
     * (runs.list flow=<id>), which the card renders for every row.
     */
    agents: [
      ...agentRoles().map((role): AgentProfileRow => ({
        id: role.id, label: role.label, purpose: role.purpose, harness: role.harness, harnessName: role.harness, model: role.model, builtin: role.builtin,
        ...(role.kind === undefined ? {} : { kind: role.kind }),
        available: false, reason: "", account: ""
      })),
      ...repositoryAgentProfiles(store)
    ]
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
        payload: { ...agentsPayload(), ...(existing && "agents" in existing.payload && existing.payload.testing ? { testing: existing.payload.testing } : {}), ...(existing && "agents" in existing.payload && existing.payload.testRequests ? { testRequests: existing.payload.testRequests } : {}), ...(shared.selectedAgent ? { selectedAgent: shared.selectedAgent } : {}), ...(shared.selectedModel ? { selectedModel: shared.selectedModel } : {}), ...(error === undefined ? {} : { error }) }
      }
    })
  }

  /*
   * An open card follows the repository: its catalog loads after the card
   * was asked for, or the target changes, and the rows would go stale. The
   * check runs after each committed batch (like the flows seam's target
   * read) and rewrites the card only when its rows differ, so the rewrite
   * itself settles it.
   */
  const rows = (payload: AgentsCard["payload"]): string => JSON.stringify("agents" in payload ? payload.agents : [])
  const subscription = collections.transitions.subscribeChanges((changes) => {
    if (!changes.some((change) => change.type === "insert")) return
    queueMicrotask(() => {
      if (ctx.disposed) return
      const existing = agentsCard()
      if (existing === undefined || "cloud" in existing.payload) return
      if (rows(existing.payload) !== rows(agentsPayload())) renderAgentsCard(false, existing.payload.error)
    })
  })
  void ctx.onDispose(() => { subscription.unsubscribe() })

  const accept = (payload: unknown, tail: boolean) => {
    const parsed = CardSchema.safeParse({ id: AGENTS_CARD_ID, kind: "agents", title: "Agents", status: "active", createdAt: Date.now(), ordinal: 0, payload })
    if (!parsed.success || parsed.data.kind !== "agents") throw new Error("Invalid agents response")
    shared.served = parsed.data.payload
    renderAgentsCard(tail)
  }
  const listAgents: AgentsController["listAgents"] = async (role, model) => {
    shared.selectedAgent = role
    shared.selectedModel = model
    renderAgentsCard(true)
    if (!deps.install) return
    const request = ++shared.generation
    const epoch = ctx.accountEpoch
    void (async () => {
      try {
        const response = await ctx.http(`${ctx.baseUrl.replace(/\/$/, "")}/api/agents`, { credentials: "same-origin" })
        if (!response.ok) throw new Error(await ctx.errorMessageOf(response, "Could not read agents"))
        const body: unknown = await response.json()
        if (ctx.disposed || epoch !== ctx.accountEpoch || request !== shared.generation) return
        const assignment = shared.served && "agents" in shared.served ? shared.served.assignment : undefined
        accept({ ...body as object, ...(assignment ? { assignment } : {}) }, false)
        if (!shared.stopLive && deps.live) shared.stopLive = deps.live.subscribe("agents", () => {
          if (ctx.disposed || epoch !== ctx.accountEpoch) return
          const snapshot = deps.live?.getSnapshot("agents")
          if (snapshot?.data !== undefined) {
            try { accept({ ...snapshot.data as object, ...(shared.served && "agents" in shared.served && shared.served.assignment ? { assignment: shared.served.assignment } : {}), canAssign: shared.served && "canAssign" in shared.served ? shared.served.canAssign : false }, false) } catch { renderAgentsCard(false, "Could not read agents") }
          }
        })
      } catch (error) { if (!ctx.disposed && request === shared.generation) renderAgentsCard(false, error instanceof Error ? error.message : "Could not read agents") }
    })()
  }
  const launchAssignment = (request: { id: string; role: string; model: string; state: "requested" | "failed" }, reserved = false) => {
    const key = `${request.role}:${request.model}`
    if (!reserved && shared.pending.has(key)) return
    shared.pending.add(key)
    const epoch = ctx.accountEpoch
    const prior = shared.assignmentTail
    let release!: () => void
    shared.assignmentTail = new Promise<void>(done => { release = done })
    void ctx.withToast(`agent.model.${request.id}`, "Saving model", "Model saved", async () => {
      try {
        await prior
        if (ctx.disposed || epoch !== ctx.accountEpoch) return true
        const body = await assignInstallAgentModel(ctx, request.role, request.model)
        if (!ctx.disposed && epoch === ctx.accountEpoch && shared.served && "agents" in shared.served && shared.served.assignment?.id === request.id) accept(body, false)
        if (!ctx.disposed && epoch === ctx.accountEpoch) void deps.refreshSettings?.()
        return true
      } catch (error) {
        const message = error instanceof Error ? error.message : "Could not save model"
        if (!ctx.disposed && epoch === ctx.accountEpoch && shared.served && "agents" in shared.served && shared.served.assignment?.id === request.id) {
          shared.served = { ...shared.served, assignment: { ...request, state: "failed" } }
          renderAgentsCard(false, message)
        }
        return message
      } finally { shared.pending.delete(key); release() }
    }, false, () => !ctx.disposed, AGENTS_CARD_ID)
  }
  const assignAgentModel: AgentsController["assignAgentModel"] = async (role, model) => {
    if (ctx.commandActor !== "user" || !deps.install) return "Owner access required"
    const key = `${role}:${model}`
    if (shared.pending.has(key)) return
    if (!shared.served) {
      shared.served = { native: false, agents: [] }
      renderAgentsCard(true)
    }
    if (!("agents" in shared.served)) return "Agents unavailable"
    const request = { id: randomUuid(), role, model, state: "requested" as const }
    shared.pending.add(key)
    shared.served = { ...shared.served, assignment: request }
    renderAgentsCard(false)
    await store.settled?.()
    launchAssignment(request, true)
  }
  const recovered = agentsCard()?.payload
  if (deps.install && recovered && "agents" in recovered && recovered.assignment?.state === "requested") {
    shared.served = recovered
    shared.selectedAgent = recovered.selectedAgent
    shared.selectedModel = recovered.selectedModel
    queueMicrotask(() => { if (!ctx.disposed && ctx.commandActor === "user") launchAssignment(recovered.assignment!) })
  }

  const stopAccount = ctx.onAccountChange?.(() => {
    shared.generation++; shared.stopLive?.(); shared.stopLive = undefined; shared.served = undefined; shared.selectedAgent = undefined; shared.selectedModel = undefined
    renderAgentsCard(false)
  })
  void ctx.onDispose(() => { stopAccount?.(); shared.generation++; shared.stopLive?.() })


  return { agentRoles, listAgents, assignAgentModel }
}
