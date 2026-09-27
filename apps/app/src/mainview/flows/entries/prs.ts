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
    name: "prs.create",
    form: {
      fields: { from: { optionsFrom: "bookmarks", kind: "text", label: "From bookmark" }, repo: { optionsFrom: "cloud-repos", kind: "text" } },
      args: (payload) => line(text(payload, "title"), text(payload, "from") === undefined ? undefined : `from:${text(payload, "from")}`, text(payload, "repo"))
    },
    summary: "Open a pull request",
    runtime: ["cloud"],
    args: "<title> [from:<bookmark>] [owner/repo]",
    requires: ["signed-in"],
    input: Schema.Struct({
      title: Schema.String,
      from: Schema.optional(Schema.String),
      repo: Schema.optional(Schema.String)
    }),
    handler: ({ title, from, repo }) => actions.createLanding(title, repo, from)
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
    /*
     * The Review a PR app (PRODUCT.md D-18): opened without a number it
     * renders its form — the pull request picker and Review — then the run
     * card of the repository's `pr-triage` flow, which answers a verdict with
     * its notes. The pull request's title, description, commits and patches
     * ride as the flow's context, the way `issue.implement` carries the issue.
     * A review spends, so the model may ask and the human confirms.
     */
    name: "prs.triage",
    summary: "Review a pull request with the repository's pr-triage flow",
    runtime: ["cloud"],
    requires: ["signed-in"],
    workflow: "pr-triage",
    confirm: "review the pull request with the repository's pr-triage flow",
    args: "<number> [owner/repo]",
    form: { submitLabel: "Review", fields: { number: { label: "PR", optionsFrom: "pull-requests", kind: "number" }, repo: { hidden: true } } },
    input: NumberedTarget,
    handler: ({ number, repo }) => actions.triagePullRequest(number, repo)
  }),
  flow({
    name: "prs.review",
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
