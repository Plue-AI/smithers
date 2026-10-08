/*
 * The `flow` flows. One module per namespace: a lane that adds or edits a
 * flow here touches no other flow module, and Flows.ts registers each block in
 * the aggregator order.
 */
import { Schema } from "effect"
import { flow } from "./Declare"
import type { FlowEntry, Namespace } from "../registry"
import { flowPlanParts, flowRunParts, payloadFor } from "../SlashPayload"
import { line, text } from "@smthrs/ui/flow-form"
import type { RepositoryFlow } from "../../state/AppState"
import type { CommandActions } from "./Declare"
import { todoOf } from "../../state/seams/DesignWorld"
import { flowTitle } from "../../state/seams/DesignWorld/run"
import { flowsUnavailable } from "../../state/seams/FlowsSeam"
import { fileCard, findFile } from "../../state/seams/DesignWorld/subjects"

/** The `flow` namespace row: the slash tree lists it in registry.ts NAMESPACES order. */
export const namespace: Namespace = { id: "flow", label: "Flows", summary: "Create, list, and run flows" }

const flowNameGrammar = (args: string | undefined) => {
  if (args?.trim().startsWith("{")) {
    try { return { payload: JSON.parse(args) } } catch { return { error: "Invalid flow input" } }
  }
  const input = (args ?? "").trimStart()
  const boundary = input.search(/\s/)
  const name = boundary < 0 ? input : input.slice(0, boundary)
  const request = boundary < 0 ? undefined : input.slice(boundary).trimStart()
  return { payload: { ...(name ? { name } : {}), ...(request ? { request } : {}) } }
}

import { flowEditPrompt, flowEditTodoInput } from "@smthrs/rpc/FlowEdit"
export { flowEditPrompt, flowEditTodoInput } from "@smthrs/rpc/FlowEdit"

/*
 * The versioned flow doors (T-APP-05, J5): the Flow card, a proposed edit as
 * a Draft through the TODO lane's newTodo (the `todo.new` handler), the source
 * on the branch of the TODO that proposes a change (spec §11.5b), and the list.
 * They read the install's GET /api/flows (actions.flowCards); off an install
 * the seeded design world answers (MOCK SEAM, state/seams/DesignWorld/run.ts).
 * Only a system flow refuses an edit: the built-in TODO flow is overridable.
 */
export const flowVersionFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => {
  /** The named flow's card, or the refusal: an unserved catalog, or no such flow. */
  const named = async (name: string) => {
    const cards = await actions.flowCards(name)
    return cards === undefined ? flowsUnavailable : cards.find(card => card.name === name) ?? `No flow ${name}`
  }
  return [
    flow({ name: "flow",   slash: "/flow", cli: ["flow","show"], journey: ["J5"], group: "Flows", visibility: "core", actors: ["person","app_agent","external_agent"], minimumRole: "member", http: {"method":"GET","path":"/api/flows/{name}"}, summary: "Show a flow's steps and versions", args: "<name>",
      agent: "run", input: Schema.Struct({ name: Schema.NonEmptyString }), grammar: flowNameGrammar,
      handler: async ({ name }) => {
        const model = await named(name)
        return typeof model === "string" ? model : { value: await actions.presentFlow(name, flowTitle(name)) }
      } }),
    flow({ name: "flow.edit",   slash: "/flow.edit", cli: ["flow","edit"], journey: ["J5"], group: "Flows", visibility: "core", actors: ["person","app_agent","external_agent"], minimumRole: "member", http: {"method":"POST","path":"/api/flows/{name}/edit"}, summary: "Propose a change to a flow", args: "<name> <request>",
      agent: "confirm", input: Schema.Struct({ name: Schema.NonEmptyString, request: Schema.NonEmptyString, diff: Schema.optional(Schema.String) }),
      grammar: flowNameGrammar, confirm: payload => payload.diff === undefined ? "change this flow" : undefined,
      form: { requires: () => ["name", "request"], fields: { name: { label: "Flow" }, request: { label: "Request" }, diff: { hidden: true } },
        args: payload => payload.diff === undefined ? line(text(payload, "name"), text(payload, "request")) : JSON.stringify(payload) },
      handler: async ({ name, request, diff }) => {
        const model = await named(name)
        if (typeof model === "string") return model
        if (model.system) return `${flowTitle(name)} is built in`
        if (diff !== undefined) return { value: await actions.presentSubject({ id: `flow:${name}`, kind: "flow", title: flowTitle(name), payload: { name, proposal: { request, diff } } }) }
        return actions.newTodo(flowEditTodoInput(name, request))
      } }),
    flow({ name: "flow.source",   slash: "/flow.source", cli: ["flow","source"], journey: ["J11"], group: "Advanced", visibility: "advanced", actors: ["person","app_agent","external_agent"], minimumRole: "member", http: null, summary: "Co-edit a flow's source", args: "<name>",
      agent: "run", input: Schema.Struct({ name: Schema.NonEmptyString }), grammar: flowNameGrammar,
      handler: async ({ name }) => {
        const world = actions.design.world()
        const model = await named(name)
        if (typeof model === "string") return model
        if (model.system) return `${flowTitle(name)} is built in`
        const path = "path" in model.source ? model.source.path : `flows/${name}/flow.ts`
        const proposing = model.versions.find(each => each.state === "proposed" && each.todo !== undefined)
        if (!actions.design.enabled) return proposing?.todo === undefined ? actions.newFlowSourceTodo(flowEditTodoInput(name, "Edit the source"), path) : actions.readFlowSource(proposing.todo, path)
        if (proposing === undefined) {
          // Retain the design seed's source projection off an install.
          const seeded = findFile(world, path, "main")
          return seeded === undefined ? actions.newTodo({ text: flowEditPrompt(name, "Edit the source"), title: `Change the ${flowTitle(name)}` })
            : { value: await actions.presentSubject(fileCard(world.repo.repo, seeded.branch, seeded.path)) }
        }
        const branch = proposing?.todo === undefined ? undefined : todoOf(world, `T${proposing.todo}`)?.branch
        const file = branch === undefined ? undefined : findFile(world, path, branch)
        if (file === undefined) return `No source for ${flowTitle(name)}`
        return { value: await actions.presentSubject(fileCard(world.repo.repo, file.branch, file.path)) }
      } }),
    flow({ name: "flows",   slash: "/flows", cli: ["flows"], journey: ["J5"], group: "Flows", visibility: "core", actors: ["person","app_agent","external_agent"], minimumRole: "member", http: {"method":"GET","path":"/api/flows","query":{}}, summary: "List the repository's flows", agent: "run", requires: ["signed-in"],
      grammar: args => args?.trim().startsWith("{") ? (() => { try { return { payload: JSON.parse(args) } } catch { return { error: "Enter a JSON object" } } })() : payloadFor("flow.list", args),
      input: Schema.Struct({ operation: Schema.optional(Schema.Literals(["workspace"])), repo: Schema.optional(Schema.String), sourceCard: Schema.optional(Schema.String) }),
      form: { args: payload => JSON.stringify(payload), fields: { operation: { hidden: true }, sourceCard: { hidden: true }, repo: { optionsFrom: "cloud-repos", kind: "text" } } },
      handler: async ({ operation, repo, sourceCard }) => {
        if (operation === "workspace" || repo !== undefined || sourceCard !== undefined) return actions.listWorkspaceWorkflows(repo, sourceCard)
        if (actions.bootstrap?.capabilities.includes("install")) return actions.listRepositoryFlows()
        const cards = await actions.flowCards()
        if (cards === undefined) return flowsUnavailable
        for (const card of cards) await actions.presentFlow(card.name, flowTitle(card.name))
        return { value: `${cards.length} flows` }
      } })
  ]
}

/** The `flow.*` flows: create, list, run, and the run controls. */
export const flowFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  flow({
    /*
     * Wave 11 — "make me a workflow". The agent invokes this with the user's
     * description; the run renders as an embedded run card tracked live from
     * the relay event stream (THE EMBED LAW).
     *
     * Wave 12 §2: a trailing `owner/repo` names the target. Without one and
     * with more than one loaded repository, the ordinary input form asks —
     * the target is a genuine user choice, not a guess.
     */
    name: "flow.new", slash: "/flow.new", cli: ["flow","new"], journey: [], group: "Flows", visibility: "core", actors: ["person","app_agent","external_agent"], minimumRole: "member", agent: "confirm", http: {"method":"POST","path":"/api/flows"},
    summary: "Create a new flow",
    runtime: ["cloud"],
    args: "<description> [owner/repo]",
    requires: ["signed-in"],
    input: Schema.Struct({
      description: Schema.String,
      repo: Schema.optional(Schema.String)
    }),
    handler: ({ description, repo }) => actions.createWorkflow(description, repo)
  }),
  flow({
    name: "flow.run", agent: "run",
    confirm: payload => payload.operation === "stop" ? "stop the run" : payload.operation === "retry" ? "check the run again" : payload.operation === "stop-all" ? "stop every run" : undefined,
    confirmArgs: payload => JSON.stringify(payload),
     slash: "/flow.run", cli: ["flow","run"], journey: [], group: "Flows", visibility: "core", actors: ["person","app_agent","external_agent"], minimumRole: "member", http: { method: "POST", path: "/api/flows/{name}/run", body: { workspaceId: "workspaceId", input: "input" } }, form: {
      fields: { name: { label: "Flow" }, repo: { optionsFrom: "cloud-repos", kind: "text" }, input: { label: "Input JSON" }, workspaceId: { hidden: true }, operation: { hidden: true }, cardId: { hidden: true } },
      requires: payload => payload.operation === "stop" || payload.operation === "retry" ? ["cardId"] : payload.operation === "stop-all" ? [] : undefined,
      partial: flowRunParts,
      args: (payload) => payload.operation !== undefined || payload.workspaceId !== undefined ? JSON.stringify(payload) : line(text(payload, "sourceCard") === undefined ? undefined : `sourceCard=${text(payload, "sourceCard")}`,
        text(payload, "name"), text(payload, "repo"),
        payload.input === undefined ? undefined : typeof payload.input === "string" ? text(payload, "input") : JSON.stringify(payload.input))
    },
    summary: "Run a flow with typed input",
    runtime: ["cloud"],
    args: "[sourceCard=id] <name> [owner/repo] [JSON object]",
    requires: ["signed-in"],
    input: Schema.Union([
      Schema.Struct({ name: Schema.String, repo: Schema.optional(Schema.String), sourceCard: Schema.optional(Schema.String), workspaceId: Schema.optional(Schema.String), input: Schema.optional(Schema.Record(Schema.String, Schema.Json)), operation: Schema.optional(Schema.Never), cardId: Schema.optional(Schema.Never), reason: Schema.optional(Schema.Never) }),
      Schema.Struct({ operation: Schema.Literals(["stop", "retry"]), cardId: Schema.String, reason: Schema.optional(Schema.String), name: Schema.optional(Schema.Never), repo: Schema.optional(Schema.Never), sourceCard: Schema.optional(Schema.Never), workspaceId: Schema.optional(Schema.Never), input: Schema.optional(Schema.Never) }),
      Schema.Struct({ operation: Schema.Literal("stop-all"), repo: Schema.optional(Schema.String), sourceCard: Schema.optional(Schema.String), name: Schema.optional(Schema.Never), cardId: Schema.optional(Schema.Never), reason: Schema.optional(Schema.Never), workspaceId: Schema.optional(Schema.Never), input: Schema.optional(Schema.Never) })
    ]),
    handler: ({ name, repo, input, sourceCard, workspaceId, operation, cardId, reason }) => {
      if (operation === "stop" || operation === "retry") return cardId === undefined ? "Choose a run" : operation === "stop" ? actions.stopWatchingRun(cardId, reason) : actions.retryRunWatch(cardId)
      if (operation === "stop-all") return actions.stopAllRuns(repo, sourceCard)
      return name === undefined ? "Choose a flow" : actions.runWorkflow(name, repo, input, sourceCard, true, workspaceId)
    }
  }),
  /*
   * The plan door (docs/flow-builder): the same address as a launch, stopping
   * at the plan.
   */
  flow({
    name: "flow.plan",
     slash: "/flow.plan", cli: ["flow","plan"], journey: ["J11"], group: "Advanced", visibility: "advanced", actors: ["person","app_agent","external_agent"], minimumRole: "member", http: null, form: {
      fields: { name: { label: "Flow" }, repo: { optionsFrom: "cloud-repos", kind: "text" }, input: { label: "Input JSON" } },
      partial: flowPlanParts,
      args: (payload) => line(text(payload, "sourceCard") === undefined ? undefined : `sourceCard=${text(payload, "sourceCard")}`,
        text(payload, "against") === undefined ? undefined : `against=${text(payload, "against")}`,
        text(payload, "name"), text(payload, "repo"),
        payload.input === undefined ? undefined : typeof payload.input === "string" ? text(payload, "input") : JSON.stringify(payload.input))
    },
    summary: "See what a flow would run",
    runtime: ["cloud"],
    args: "[sourceCard=id] [against=runId] <name> [owner/repo] [JSON object]",
    requires: ["signed-in"],
    input: Schema.Struct({
      name: Schema.String,
      repo: Schema.optional(Schema.String),
      sourceCard: Schema.optional(Schema.String),
      /* The run to compare this plan with: the re-key preview (D-030). */
      against: Schema.optional(Schema.String),
      input: Schema.optional(Schema.Record(Schema.String, Schema.Json))
    }),
    handler: ({ name, repo, input, sourceCard, against }) => actions.planFlow(name, repo, input, sourceCard, against, true)
  })
]

/** The active repository's declared flows, as the controller reads them off the `repositoryFlows` collection. */
export interface RepositoryFlowCatalog {
  readonly repo: string
  readonly home?: import("../../state/AppState").RepositoryFlowsRow["home"]
  /** The projection's rows, featured first. */
  readonly flows: ReadonlyArray<RepositoryFlow>
  /** When the row landed: the registry's cache key beside `repo`. */
  readonly loadedAt: number
}

/** A projection id as a slash name: a `/` in the id is a namespace dot (`create-flow/clarify` lists under `/create-flow.`). */
export const repositoryFlowName = (id: string): string => id.replaceAll("/", ".")

/** The slash grammar every flow name obeys (registry.ts parseSubmit): an id outside it has no slash leaf. */
const SLASH_NAME = /^[a-z0-9_-]+(?:\.[a-z0-9_-]+)*$/

const firstLine = (text: string): string => text.split("\n")[0]?.trim() ?? ""

/**
 * One slash leaf per flow the repository declares (Factory design session
 * 2026-09-07 §4: "flows are slash commands, and the featured ones are the
 * repository's to declare"). The rows are `.smithers/factory.json`'s, read at
 * runtime (state/seams/RepositoryFlowsSeam.ts); nothing here names a flow.
 *
 * Every door is flow.run's: the same `signed-in` requirement (so a signed-out
 * `/review` parks and renders the sign-in step), the same cloud runtime, the
 * same launch claim, and the same controller call, so the workspace
 * provisioning and the run card are exactly what `/flow.run review` gets. The
 * leaf binds its repository: a bare `/review` runs THIS repository's review,
 * and a trailing `owner/repo` still retargets it as flow.run's does. A row the
 * repository marks not model-invocable is the human's alone here too.
 */
export const repositoryFlowLeaves = (
  actions: CommandActions,
  repo: string,
  flows: ReadonlyArray<RepositoryFlow>,
  builtins: ReadonlyArray<FlowEntry> = []
): ReadonlyArray<FlowEntry> =>
  flows.flatMap((row) => {
    const name = repositoryFlowName(row.id)
    if (!SLASH_NAME.test(name)) return []
    const policy = builtins.find(entry => entry.declaredName === name)?.metadata
    return [
      flow({
        name, visibility: "core", slash: `/${name}`, group: "Flows",
        agent: row.modelInvocable ? policy?.agent ?? "run" : "never",
        actors: row.modelInvocable ? policy?.actors ?? ["person", "app_agent"] : ["person"],
        minimumRole: policy?.minimumRole ?? "member",
        summary: row.summary ?? firstLine(row.description),
        workflow: row.id,
        runtime: ["cloud"],
        requires: ["signed-in"],
        args: "[owner/repo] [JSON object]",
        grammar: (args) => payloadFor("flow.run", line(row.id, args)),
        form: { fields: { repo: { optionsFrom: "cloud-repos", kind: "text" } } },
        ...(row.modelInvocable
          ? {}
          : { agent: "never" as const, agentReason: `${repo} declares ${row.id} is not for a model to start (.smithers/FACTORY.ts)` }),
        input: Schema.Struct({ repo: Schema.optional(Schema.String), input: Schema.optional(Schema.Record(Schema.String, Schema.Json)) }),
        handler: ({ repo: target, input }) => actions.runWorkflow(row.id, target ?? repo, input, undefined, true)
      })
    ]
  })
