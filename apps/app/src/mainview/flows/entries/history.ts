/*
 * The `history` flows: the repository's mythical stack (epic #1745), which
 * IS its history of logical changes (D-09a, D-20), served by
 * `@smthrs/rpc/Mythical`. `history.show` is dark: the
 * Home card replaced the History card (T-APP-01; `/stack`), and they stay
 * only as the seam's readers until StackSeam.ts goes with it. Bootstrap, retry and land are the writes the API
 * has, each acknowledged at once and finished in the shared toast stack.
 * One module per namespace: Flows.ts registers the block.
 */
import { Schema } from "effect"
import { flow, RepoTarget } from "./Declare"
import type { FlowEntry, Namespace } from "../registry"
import type { CommandActions } from "./Declare"

/** The `history` namespace row: the slash tree lists it in registry.ts NAMESPACES order. */
export const namespace: Namespace = { id: "history", label: "History", summary: "The repository's history of changes" }

/** The `history` flows registered as one aggregator block. */
export const historyFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  flow({
    name: "history.show",
    summary: "Show the history: every change, each issue's lane, checks and pull request",
    hidden: true,
    runtime: ["cloud"],
    args: "[owner/repo]",
    requires: ["signed-in"],
    input: RepoTarget,
    handler: ({ repo }) => actions.showStack(repo)
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
  })
]
