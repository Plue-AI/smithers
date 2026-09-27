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
    summary: "List a repository's issues and conversations, or only one kind",
    form: { args: payload => line(text(payload, "filter"), payload.kind === undefined || payload.kind === "all" ? undefined : flag(payload, "kind"), text(payload, "repo")) },
    runtimeAny: ["cloud"],
    args: "[open|closed|all] [--kind conversation|issue] [owner/repo]",
    requires: ["first-run-target", "repo-source"],
    input: Schema.Struct({
      filter: Schema.optional(Schema.Literals(["open", "closed", "all"])),
      kind: Schema.optional(Schema.Literals(["all", "conversation", "issue"])),
      repo: Schema.optional(Schema.String)
    }),
    prepare: ({ filter, repo, kind }) => actions.listIssues.preload?.(filter ?? "open", repo, kind),
    handler: ({ filter, repo, kind }) => actions.listIssues(filter ?? "open", repo, kind)
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
    form: { fields: { repo: { optionsFrom: "cloud-repos", kind: "text" } }, args: payload => line(text(payload, "title"), text(payload, "repo"), flag(payload, "kind")) },
    summary: "Create an issue, or a private conversation with --kind conversation",
    runtime: ["cloud"],
    args: "<title> [owner/repo] [--kind conversation]",
    requires: ["signed-in"],
    input: Schema.Struct({ title: Schema.String, repo: Schema.optional(Schema.String), kind: Schema.optional(Schema.Literals(["issue", "conversation"])) }),
    handler: ({ title, repo, kind }) => actions.createIssue(title, repo, kind === "conversation" ? "chat" : kind)
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
    name: "issues.fix",
    summary: "Mark an issue fixed; you become its fixer",
    runtimeAny: ["cloud"],
    args: "<number> [owner/repo]",
    requires: ["repo-read"],
    input: NumberedTarget,
    handler: ({ number, repo }) => actions.setIssueState(number, "fixed", repo)
  }),
  flow({
    name: "issues.verify",
    summary: "Verify a fixed issue; the verifier must differ from the fixer",
    runtimeAny: ["cloud"],
    args: "<number> [owner/repo]",
    requires: ["repo-read"],
    input: NumberedTarget,
    handler: ({ number, repo }) => actions.setIssueState(number, "verified", repo)
  }),
  flow({
    name: "issues.comment.react",
    form: { args: payload => JSON.stringify(payload) },
    summary: "Add or remove a reaction on a message",
    runtimeAny: ["cloud"],
    args: "<json {number, commentId, name, active, repo}>",
    requires: ["repo-read"],
    input: Schema.Struct({ number: Schema.Number, commentId: Schema.Number, name: Schema.String, active: Schema.Boolean, repo: Schema.optional(Schema.String) }),
    handler: ({ number, commentId, name, active, repo }) => actions.reactToIssueComment(number, commentId, name, active, repo)
  }),
  flow({
    name: "issues.comment.retry",
    form: { args: payload => JSON.stringify(payload) },
    hidden: true,
    summary: "Send a message again after it was not delivered",
    runtimeAny: ["cloud"],
    args: "<json {cardId, requestId}>",
    requires: ["signed-in"],
    input: Schema.Struct({ cardId: Schema.String, requestId: Schema.String }),
    handler: ({ cardId, requestId }) => actions.retryIssueComment(cardId, requestId)
  }),
  flow({
    name: "issues.set",
    form: { args: payload => JSON.stringify(payload) },
    summary: "Set an issue's owner, due date, priority or parent",
    runtimeAny: ["cloud"],
    args: "<json {number, field, value, repo}>",
    requires: ["repo-read"],
    input: Schema.Struct({
      number: Schema.Number,
      field: Schema.Literals(["owner", "due", "priority", "parent"]),
      value: Schema.String,
      repo: Schema.optional(Schema.String)
    }),
    handler: ({ number, field, value, repo }) => actions.setIssueTask(number, field, value, repo)
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

