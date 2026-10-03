import { Schema } from "effect"
import { flow, NumberedTarget } from "./Declare"
import type { CommandActions } from "./Declare"
import type { FlowEntry, Namespace } from "../registry"

export const namespace: Namespace = { id: "issue", label: "Issue flows", summary: "Research, reproduce, and implement an issue" }

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
]
