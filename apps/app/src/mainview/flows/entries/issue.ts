import { Schema } from "effect"
import { flow, NumberedTarget } from "./Declare"
import type { CommandActions } from "./Declare"
import type { FlowEntry, Namespace } from "../registry"
import { flowArgs } from "../FlowArgs"
import { text } from "@smthrs/ui/flow-form"

export const namespace: Namespace = { id: "issue", label: "Issue flows", summary: "Research, reproduce, and implement an issue" }

/**
 * The repository `issue-sweep` will work: the one the invocation named, else
 * the selected one. Resolved at ASK time so the confirmation binds it.
 */
const sweepRepo = (actions: CommandActions, payload: Record<string, unknown>): string | undefined =>
  text(payload, "repo") ?? actions.activeRepository() ?? undefined

/** The optional fields the ask carried, without the repository. */
const sweepInput = (payload: Record<string, unknown>): { maxAgents?: number; placement?: "local" | "vm"; attempt?: number; landers?: number; cloudAgents?: number } => ({
  ...(typeof payload.maxAgents === "number" ? { maxAgents: payload.maxAgents } : {}),
  ...(payload.placement === "local" || payload.placement === "vm" ? { placement: payload.placement } : {}),
  ...(typeof payload.attempt === "number" ? { attempt: payload.attempt } : {}),
  ...(typeof payload.landers === "number" ? { landers: payload.landers } : {}),
  ...(typeof payload.cloudAgents === "number" ? { cloudAgents: payload.cloudAgents } : {})
})

export const issueFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  flow({ name: "issue.flows", summary: "Inspect the flows available for an issue", runtimeAny: ["cloud"], input: NumberedTarget,
    handler: ({ number, repo }) => actions.inspectIssueFlows(number, repo, true) }),
  flow({ name: "issue.repro", summary: "Research and reproduce an issue before implementation", runtimeAny: ["cloud"], input: NumberedTarget,
    handler: ({ number, repo }) => actions.runIssueFlow("repro", number, repo, true) }),
  flow({ name: "issue.poc", summary: "Build a proof of concept for an issue", runtimeAny: ["cloud"], input: NumberedTarget,
    confirm: "ask an agent to build a proof of concept", handler: ({ number, repo }) => actions.runIssueFlow("poc", number, repo, true) }),
  /*
   * The Fix an issue app (PRODUCT.md D-18): opened without a number it renders
   * its form — the issue picker and Fix — then the coding run's card. The
   * picker's rows are the repository's open issues (controller/forms.ts
   * `issues`); the repository is the active one, never asked.
   */
  flow({ name: "issue.implement", summary: "Plan and implement an issue with the workspace's coding flow", runtimeAny: ["cloud"], input: NumberedTarget,
    requires: ["signed-in"], workflow: "coding/request",
    form: { submitLabel: "Fix", fields: { number: { label: "Issue", optionsFrom: "issues", kind: "number" }, repo: { hidden: true } } },
    confirm: "research, plan, and implement the issue using the workspace's configured checks",
    handler: ({ number, repo }) => actions.runIssueImplementation(number, repo, true) }),
  flow({ name: "issue.add-flow", summary: "Add a flow to an issue", runtimeAny: ["cloud"],
    form: { args: payload => JSON.stringify(payload), fields: { description: { label: "What should this issue flow do?", placeholder: "Describe the flow to add" } } },
    input: Schema.Struct({ number: Schema.Number, repo: Schema.optional(Schema.String), description: Schema.String }),
    handler: ({ number, repo, description }) => actions.createWorkflow(`Create a flow under issue. for issue #${number}: ${description}`, repo) }),
  /*
   * The repository's issue burndown (flows/issue-sweep/flow.ts), declared
   * under its own leaf name so every door resolves this entry: its run card
   * is the burndown board (cards/BurndownCard.tsx). The input mirrors the
   * flow's schema: only the repository is required, and it binds to the
   * selected one, so a bare line runs with the flow's defaults (4 agents).
   * The width, placement, attempt, landers (landing checks at once) and
   * cloudAgents (overflow agents in Smithers Cloud) are optional; the form
   * asks only the width. It starts up to 32
   * agents, so the model may ask and the human confirms; the confirmation
   * binds the repository resolved at ask time (`confirmArgs`).
   */
  flow({ name: "issue-sweep", summary: "Work every open GitHub issue that no other machine holds", runtime: ["cloud"],
    requires: ["signed-in"], workflow: "issue-sweep",
    confirm: (payload) => `start agents on every open issue no other machine holds in ${sweepRepo(actions, payload) ?? "the selected repository"}`,
    confirmArgs: (payload) => {
      const repo = sweepRepo(actions, payload)
      return repo === undefined ? undefined : flowArgs("issue-sweep", { ...sweepInput(payload), repo })
    },
    args: "[agents] [local|vm] [attempt=<n>] [landers=<n>] [cloudAgents=<n>] [owner/repo]",
    form: { args: payload => JSON.stringify(payload), fields: { maxAgents: { label: "Agents", kind: "number" }, repo: { hidden: true } } },
    input: Schema.Struct({
      maxAgents: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(32))),
      placement: Schema.optional(Schema.Literals(["local", "vm"])),
      attempt: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
      landers: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(16))),
      cloudAgents: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
      repo: Schema.optional(Schema.String)
    }),
    handler: ({ maxAgents, placement, attempt, landers, cloudAgents, repo }) => actions.runIssueSweep({ maxAgents, placement, attempt, landers, cloudAgents }, repo, true) })
]
