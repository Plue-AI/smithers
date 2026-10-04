/*
 * The `prs` flows. One module per namespace: a lane that adds or edits a
 * flow here touches no other flow module, and Flows.ts registers each block in
 * the aggregator order.
 */
import { Schema } from "effect"
import { payloadFor } from "../SlashPayload"
import { line, text } from "@smthrs/ui/flow-form"
import { flow, RepoTarget, NumberedTarget } from "./Declare"
import type { FlowEntry, Namespace } from "../registry"
import type { CommandActions } from "./Declare"

/** The `prs` namespace row: the slash tree lists it in registry.ts NAMESPACES order. */
export const namespace: Namespace = { id: "prs", label: "Pull requests", summary: "GitHub pull requests" }

/** The `prs` flows registered as one aggregator block. */
export const prsFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  flow({
    name: "prs",
    hidden: true,
    grammar: args => payloadFor("prs.list", args),
    summary: "List a repository's pull requests",
    runtimeAny: ["cloud"],
    args: "[owner/repo]",
    requires: ["first-run-target", "repo-source"],
    input: RepoTarget,
    prepare: ({ repo }) => actions.listLandings.preload?.(repo),
    handler: ({ repo }) => actions.listLandings(repo)
  }),
  flow({
    name: "prs.list",
    summary: "List a repository's pull requests",
    runtimeAny: ["cloud"],
    args: "[owner/repo]",
    requires: ["first-run-target", "repo-source"],
    input: RepoTarget,
    prepare: ({ repo }) => actions.listLandings.preload?.(repo),
    handler: ({ repo }) => actions.listLandings(repo)
  }),
  flow({
    name: "prs.view",
    summary: "Open a pull request with reviews and checks",
    runtimeAny: ["cloud"],
    args: "<number> [owner/repo]",
    requires: ["repo-read"],
    input: NumberedTarget,
    prepare: ({ number, repo }) => actions.viewLanding.preload?.(number, repo),
    handler: ({ number, repo }) => actions.viewLanding(number, repo)
  }),
  flow({
    name: "prs.tab",
    summary: "Show a pull request's conversation, commits, checks, or files",
    args: "<cardId> conversation|commits|checks|files",
    input: Schema.Struct({ cardId: Schema.String, tab: Schema.Literals(["conversation", "commits", "checks", "files"]) }),
    handler: ({ cardId, tab }) => actions.setLandingTab(cardId, tab)
  }),
  flow({
    /*
     * Landing is consequential (it queues a merge), so the model may ASK for
     * it but never perform it: `confirm` turns an agent invocation into a
     * confirmation message whose button runs the land as the user.
     */
    name: "prs.land",
    summary: "Land a pull request (queues the merge)",
    runtime: ["cloud"],
    confirm: "land the pull request",
    args: "<number> [owner/repo]",
    requires: ["signed-in"],
    input: NumberedTarget,
    handler: ({ number, repo }) => actions.landLanding(number, repo)
  }),
  flow({
    // Retain the old button/form door for persisted cards; it shares /review's refusal.
    name: "prs.triage",
    hidden: true,
    summary: "Review a pull request",
    confirm: "review the pull request",
    args: "<number> [owner/repo]",
    form: { submitLabel: "Review", fields: { number: { label: "PR", optionsFrom: "pull-requests", kind: "number" }, repo: { hidden: true } } },
    input: NumberedTarget,
    handler: ({ number, repo }) => actions.triagePullRequest(number, repo, true)
  }),
  flow({
    name: "review", hidden: true, discloseToAgent: false,
    summary: "Review a pull request",
    confirm: "review the pull request",
    args: "<number> [owner/repo]",
    form: { submitLabel: "Review", fields: { number: { label: "PR", optionsFrom: "pull-requests", kind: "number" }, repo: { hidden: true } } },
    input: NumberedTarget,
    handler: ({ number, repo }) => actions.triagePullRequest(number, repo, true)
  }),
  flow({
    name: "prs.review", hidden: true, discloseToAgent: false,
    form: {
      fields: { text: { required: false }, repo: { optionsFrom: "cloud-repos", kind: "text" } },
      args: (payload) =>
        line(text(payload, "number"), text(payload, "verdict") === "request_changes" ? "request-changes" : text(payload, "verdict"), text(payload, "text"), text(payload, "repo"))
    },
    summary: "Review a pull request",
    runtime: ["cloud"],
    args: "<number> approve|request-changes|comment [text] [owner/repo]",
    requires: ["signed-in"],
    input: Schema.Struct({
      number: Schema.Number,
      verdict: Schema.Literals(["approve", "request_changes", "comment"]),
      text: Schema.String,
      repo: Schema.optional(Schema.String)
    }),
    handler: ({ number, verdict, text, repo }) => actions.reviewLanding(number, verdict, text, repo)
  })
]
