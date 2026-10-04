import { numbered } from "./subjects"
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
  // Retained cards/history decode issue.implement; both names enter one dark
  // handler. Only todo.from-issue is offered for new commands.
  flow({ name: "issue.implement", hidden: true, summary: "Make TODO", input: NumberedTarget,
    confirm: "make a TODO from the issue", handler: ({ number, repo }) => actions.runIssueImplementation(number, repo, true) }),
  flow({ name: "todo.from-issue", summary: "Make TODO", args: "#n", input: NumberedTarget, grammar: numbered(),
    form: { args: payload => JSON.stringify(payload), fields: { number: { label: "Issue", placeholder: "#212" } } },
    confirm: "make a TODO from the issue", handler: ({ number, repo }) => actions.runIssueImplementation(number, repo, true) }),
  flow({ name: "issue.add-flow", summary: "Add a flow to an issue", runtimeAny: ["cloud"],
    form: { args: payload => JSON.stringify(payload), fields: { description: { label: "What should this issue flow do?", placeholder: "Describe the flow to add" } } },
    input: Schema.Struct({ number: Schema.Number, repo: Schema.optional(Schema.String), description: Schema.String }),
    handler: ({ number, repo, description }) => actions.createWorkflow(`Create a flow under issue. for issue #${number}: ${description}`, repo) }),
]
