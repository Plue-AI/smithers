/*
 * The `flow` flows. One module per namespace: a lane that adds or edits a
 * flow here touches no other flow module, and Flows.ts registers each block in
 * the aggregator order.
 */
import { Schema } from "effect"
import { flow, NoPayload, CardTarget } from "./Declare"
import type { FlowEntry, Namespace } from "../registry"
import { flowPlanParts, flowRunParts, payloadFor } from "../SlashPayload"
import { line, text } from "@smthrs/ui/flow-form"
import type { RepositoryFlow } from "../../state/AppState"
import type { CommandActions } from "./Declare"

/** The `flow` namespace row: the slash tree lists it in registry.ts NAMESPACES order. */
export const namespace: Namespace = { id: "flow", label: "Flows", summary: "Create, list, and run flows" }

/** The bare `flows` surface switch, registered first with the other top-level surfaces. */
export const flowsSurfaceFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  flow({
    /*
     * Ask 5 (will, 2026-09-02): the fourth surface — the workspace's flows,
     * beside chat, connect and world. User-only: the model lists flows with
     * flow.list, whose answer is an embedded card (THE EMBED LAW), so opening
     * a pane stays the human's own act.
     */
    name: "flows",
    summary: "See the flows on your workspace",
    userOnly: true,
    userOnlyReason: "a surface switch; the model lists flows with flow.list, which answers as an embedded card",
    requires: ["signed-in"],
    input: NoPayload,
    handler: () => actions.showFlows()
  })
]

/** The `flow.*` flows: create, choose a repository, list, run, and the run controls. */
export const flowFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  flow({
    /*
     * Wave 11 — "make me a workflow". The agent invokes this with the user's
     * description; the run renders as an embedded run card tracked live from
     * the relay event stream (THE EMBED LAW).
     *
     * Wave 12 §2: a trailing `owner/repo` names the target. Without one and
     * with more than one loaded repository, the chooser-among-loaded asks —
     * the target is a genuine user choice, not a guess.
     */
    name: "flow.create",
    summary: "Create a Smithers flow from a description",
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
    /*
     * The answer to the which-repo question — one act, from the card.
     *
     * `userOnly` is load-bearing, not decoration. §2 exists because the target
     * is a GENUINE user choice and nothing may be provisioned on a guess; a
     * model that can execute this by name answers the human's question for
     * them and provisions on ITS guess. Hidden keeps it out of the catalog;
     * user-only keeps it un-executable even by a model that guesses the name.
     */
    name: "flow.repo.choose",
    summary: "Choose which loaded repository a flow belongs to",
    runtime: ["cloud"],
    hidden: true,
    userOnly: true,
    userOnlyReason: "the answer to the which-repository card is the human's choice; a model must not provision on its guess",
    args: "<owner/repo>",
    input: Schema.Struct({ repo: Schema.String }),
    handler: ({ repo }) => actions.chooseWorkflowRepo(repo)
  }),
  flow({
    /*
     * Wave 12 §3 — the acts a run that has gone quiet offers, bound to the
     * card's buttons. Hidden from the slash menu and the catalog. Stopping a
     * run is consequential (the cancel is durable), so the model may ASK but
     * never perform it: `confirm` turns an agent invocation into a
     * confirmation message whose button runs the stop as the user.
     */
    name: "flow.run.stop",
    summary: "Stop a run",
    runtime: ["cloud"],
    hidden: true,
    confirm: "stop the run",
    args: "<cardId> [reason]",
    input: Schema.Struct({
      cardId: Schema.String,
      reason: Schema.optional(Schema.String)
    }),
    handler: ({ cardId, reason }) => actions.stopWatchingRun(cardId, reason)
  }),
  flow({
    /* A retry spends (agent-parity.md): the model may ask, the human confirms. */
    name: "flow.run.retry",
    summary: "Check a run again",
    runtime: ["cloud"],
    hidden: true,
    confirm: "check the run again",
    args: "<cardId>",
    input: CardTarget,
    handler: ({ cardId }) => actions.retryRunWatch(cardId)
  }),
  flow({
    name: "flow.list",
    summary: "List the flows on your workspace",
    runtime: ["cloud"],
    requires: ["signed-in"],
    args: "[sourceCard=id] [owner/repo]",
    input: Schema.Struct({ repo: Schema.optional(Schema.String), sourceCard: Schema.optional(Schema.String) }),
    handler: ({ repo, sourceCard }) => actions.listWorkspaceWorkflows(repo, sourceCard)
  }),
  flow({
    name: "flow.run",
    form: {
      fields: { name: { label: "Flow" }, repo: { optionsFrom: "cloud-repos", kind: "text" }, input: { label: "Input JSON" } },
      partial: flowRunParts,
      args: (payload) => line(text(payload, "sourceCard") === undefined ? undefined : `sourceCard=${text(payload, "sourceCard")}`,
        text(payload, "name"), text(payload, "repo"),
        payload.input === undefined ? undefined : typeof payload.input === "string" ? text(payload, "input") : JSON.stringify(payload.input))
    },
    summary: "Run a flow on your workspace",
    runtime: ["cloud"],
    args: "[sourceCard=id] <name> [owner/repo] [JSON object]",
    requires: ["signed-in"],
    input: Schema.Struct({
      name: Schema.String,
      repo: Schema.optional(Schema.String),
      sourceCard: Schema.optional(Schema.String),
      input: Schema.optional(Schema.Record(Schema.String, Schema.Json))
    }),
    handler: ({ name, repo, input, sourceCard }) => actions.runWorkflow(name, repo, input, sourceCard)
  }),
  /*
   * The plan door (docs/flow-builder): the same address as a launch, stopping
   * at the plan.
   */
  flow({
    name: "flow.plan",
    form: {
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
    handler: ({ name, repo, input, sourceCard, against }) => actions.planFlow(name, repo, input, sourceCard, against)
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
  flows: ReadonlyArray<RepositoryFlow>
): ReadonlyArray<FlowEntry> =>
  flows.flatMap((row) => {
    const name = repositoryFlowName(row.id)
    if (!SLASH_NAME.test(name)) return []
    return [
      flow({
        name,
        summary: row.summary ?? firstLine(row.description),
        workflow: row.id,
        runtime: ["cloud"],
        requires: ["signed-in"],
        args: "[owner/repo] [JSON object]",
        grammar: (args) => payloadFor("flow.run", line(row.id, args)),
        form: { fields: { repo: { optionsFrom: "cloud-repos", kind: "text" } } },
        ...(row.modelInvocable
          ? {}
          : { userOnly: true, userOnlyReason: `${repo} declares ${row.id} is not for a model to start (.smithers/FACTORY.ts)` }),
        input: Schema.Struct({ repo: Schema.optional(Schema.String), input: Schema.optional(Schema.Record(Schema.String, Schema.Json)) }),
        handler: ({ repo: target, input }) => actions.runWorkflow(row.id, target ?? repo, input)
      })
    ]
  })

/** `flow.run.stop-all`, registered after the `runs.*` block it acts across. */
export const flowRunStopAllFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  flow({
    /* Stopping every run is consequential: agent invocations confirm first. */
    name: "flow.run.stop-all",
    summary: "Stop every live run on your workspace",
    runtime: ["cloud"],
    hidden: true,
    confirm: "stop every run",
    args: "[sourceCard=id] [owner/repo]",
    requires: ["signed-in"],
    input: Schema.Struct({ repo: Schema.optional(Schema.String), sourceCard: Schema.optional(Schema.String) }),
    handler: ({ repo, sourceCard }) => actions.stopAllRuns(repo, sourceCard)
  })
]
