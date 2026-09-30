/*
 * The `history` flows: the repository's mythical stack (epic #1745), which
 * IS its history of logical changes (D-09a, D-20), served by
 * `@smthrs/rpc/Mythical`. `history.show` embeds the live History card (the
 * chrome's History button, the slash and the agent call are its three
 * doors). Bootstrap, backfill, lane count and retry are the writes the API
 * has, each acknowledged at once and finished in the shared toast stack.
 * One module per namespace: Flows.ts registers the block.
 */
import { Schema } from "effect"
import { flow, RepoTarget } from "./Declare"
import type { FlowEntry, Namespace } from "../registry"
import type { CommandActions } from "./Declare"

/** The `history` namespace row: the slash tree lists it in registry.ts NAMESPACES order. */
export const namespace: Namespace = { id: "history", label: "History", summary: "The repository's history of changes" }

const RepoOptional = Schema.optional(Schema.String)

/** Retrying a blocked, rejected or declined issue is a person's decision (the retry route requires a person). */
export const HISTORY_RETRY_USER_ONLY_REASON = "retrying a blocked, rejected or declined issue is a person's decision"

/** The `history` flows registered as one aggregator block. */
export const historyFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  flow({
    name: "history.show",
    summary: "Show the history: every change, each issue's lane, checks and pull request",
    runtime: ["cloud"],
    args: "[owner/repo]",
    requires: ["signed-in"],
    input: RepoTarget,
    handler: ({ repo }) => actions.showStack(repo)
  }),
  flow({
    name: "history.view",
    summary: "Show the history as its issue list or its metrics",
    runtime: ["cloud"],
    args: "<issues|metrics> [owner/repo]",
    requires: ["signed-in"],
    input: Schema.Struct({ view: Schema.Literals(["issues", "metrics"]), repo: RepoOptional }),
    handler: ({ view, repo }) => actions.setStackView(view, repo)
  }),
  flow({
    name: "history.bootstrap",
    summary: "Create the history from main's commits",
    runtime: ["cloud"],
    args: "<owner/repo>",
    requires: ["signed-in"],
    confirm: "create the repository history",
    input: Schema.Struct({ repo: Schema.NonEmptyString }),
    /* Typed owner/repo, with the loaded repositories offered: the grammar reads only that shape. */
    form: { fields: { repo: { optionsFrom: "cloud-repos", kind: "text", label: "Repository" } } },
    /* The server's stack (#1760): acknowledged at once, its notice runs until the stack reads active. */
    handler: ({ repo }) => actions.bootstrapStack(repo)
  }),
  flow({
    name: "history.backfill",
    summary: "Admit every open issue to the history now",
    runtime: ["cloud"],
    args: "[owner/repo]",
    requires: ["signed-in"],
    confirm: "admit every open issue to the history",
    input: RepoTarget,
    handler: ({ repo }) => actions.backfillStack(repo)
  }),
  flow({
    name: "history.parallel",
    summary: "Set how many lanes work at once",
    runtime: ["cloud"],
    args: "<1-8> [owner/repo]",
    requires: ["signed-in"],
    confirm: "change how many lanes work at once",
    input: Schema.Struct({ value: Schema.Number, repo: RepoOptional }),
    handler: ({ value, repo }) => actions.setStackParallel(value, repo)
  }),
  /*
   * A TODO for the coding factory: the stack files it on the repository's
   * GitHub issues as the maintainer's own and queues it (POST
   * …/mythical/todos), acknowledged at once; its notice follows the factory
   * until its pull request opens, it lands, or it stops. Filing starts
   * credentialed work, so the agent's door confirms.
   */
  flow({
    name: "history.todo",
    summary: "File a TODO for the coding factory and follow it to its pull request",
    runtime: ["cloud"],
    args: "<title> [owner/repo]",
    requires: ["signed-in"],
    confirm: "file this TODO for the coding factory",
    input: Schema.Struct({ title: Schema.NonEmptyString, body: Schema.optional(Schema.String), repo: RepoOptional }),
    form: {
      args: (payload) => JSON.stringify(payload),
      submitLabel: "File",
      fields: { title: { label: "TODO" }, body: { label: "Details", kind: "textarea" }, repo: { hidden: true } }
    },
    handler: ({ title, body, repo }) => actions.fileTodo(title, body, repo)
  }),
  flow({
    name: "history.retry",
    summary: "Give a blocked, rejected or declined issue a fresh set of attempts",
    userOnly: true,
    userOnlyReason: HISTORY_RETRY_USER_ONLY_REASON,
    runtime: ["cloud"],
    args: "<item> [owner/repo]",
    requires: ["signed-in"],
    confirm: "retry this issue",
    input: Schema.Struct({ id: Schema.String, repo: RepoOptional }),
    handler: ({ id, repo }) => actions.retryStackItem(id, repo)
  })
]
