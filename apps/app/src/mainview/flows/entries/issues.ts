/*
 * The `issues` flows. One module per namespace: a lane that adds or edits a
 * flow here touches no other flow module, and Flows.ts registers each block in
 * the aggregator order.
 */
import { Schema } from "effect"
import { issueFlows } from "./issue"
import { issueViewParts, payloadFor } from "../SlashPayload"
import { flag, line, text } from "@smthrs/ui/flow-form"
import { flow, NumberedTarget } from "./Declare"
import type { FlowEntry, Namespace } from "../registry"
import type { CommandActions } from "./Declare"

/** The `issues` namespace row: the slash tree lists it in registry.ts NAMESPACES order. */
export const namespace: Namespace = { id: "issues", label: "Issues", summary: "GitHub issues" }

/** The `issues.*` flows: GitHub issues. */
export const issuesFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  ...issueFlows(actions),
  flow({
    name: "issues",
    hidden: true,
    grammar: args => payloadFor("issues.list", args),
    summary: "List a repository's issues",
    runtimeAny: ["cloud"],
    args: "[open|closed|all] [owner/repo]",
    requires: ["first-run-target", "repo-source"],
    input: Schema.Struct({
      filter: Schema.optional(Schema.Literals(["open", "closed", "all"])),
      repo: Schema.optional(Schema.String)
    }),
    prepare: ({ filter, repo }) => actions.listIssues.preload?.(filter ?? "open", repo),
    handler: ({ filter, repo }) => actions.listIssues(filter ?? "open", repo)
  }),
  flow({
    name: "issues.list",
    summary: "List a repository's issues",
    runtimeAny: ["cloud"],
    args: "[open|closed|all] [owner/repo]",
    requires: ["first-run-target", "repo-source"],
    input: Schema.Struct({
      filter: Schema.optional(Schema.Literals(["open", "closed", "all"])),
      repo: Schema.optional(Schema.String)
    }),
    prepare: ({ filter, repo }) => actions.listIssues.preload?.(filter ?? "open", repo),
    handler: ({ filter, repo }) => actions.listIssues(filter ?? "open", repo)
  }),
  flow({
    name: "issues.view",
    summary: "Open an issue with its comments; use source github for GitHub rows",
    form: { partial: issueViewParts, args: payload => line(text(payload, "number"), text(payload, "repo"), flag(payload, "source")) },
    runtimeAny: ["cloud"],
    args: "<number> [owner/repo] [--source github|smithers-cloud]",
    requires: ["repo-read"],
    input: Schema.Struct({
      ...NumberedTarget.fields,
      source: Schema.optional(Schema.Literals(["smithers-cloud", "github"]))
    }),
    prepare: ({ number, repo, source }) => actions.viewIssue.preload?.(number, repo, source),
    handler: ({ number, repo, source }) => actions.viewIssue(number, repo, source)
  }),
  flow({
    name: "issues.create",
    form: { fields: { repo: { optionsFrom: "cloud-repos", kind: "text" } } },
    summary: "Create an issue",
    runtime: ["cloud"],
    args: "<title> [owner/repo]",
    requires: ["signed-in"],
    input: Schema.Struct({ title: Schema.String, repo: Schema.optional(Schema.String) }),
    handler: ({ title, repo }) => actions.createIssue(title, repo)
  }),
  flow({
    name: "issues.close",
    summary: "Close an issue",
    runtimeAny: ["cloud"],
    args: "<number> [owner/repo]",
    requires: ["repo-read"],
    input: NumberedTarget,
    handler: ({ number, repo }) => actions.setIssueState(number, "closed", repo)
  }),
  flow({
    name: "issues.reopen",
    summary: "Reopen a closed issue",
    runtimeAny: ["cloud"],
    args: "<number> [owner/repo]",
    requires: ["repo-read"],
    input: NumberedTarget,
    handler: ({ number, repo }) => actions.setIssueState(number, "open", repo)
  }),
  flow({
    name: "issues.comment",
    form: { fields: { repo: { optionsFrom: "cloud-repos", kind: "text" } } },
    summary: "Comment on an issue",
    runtimeAny: ["cloud"],
    args: "<number> <text> [owner/repo]",
    requires: ["repo-read"],
    input: Schema.Struct({
      number: Schema.Number,
      text: Schema.String,
      repo: Schema.optional(Schema.String)
    }),
    handler: ({ number, text, repo }) => actions.commentOnIssue(number, text, repo)
  })
]

