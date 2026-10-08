/** Retained hidden repository-history bootstrap; Home uses the shared home topic. */
import { Schema } from "effect"
import { flow } from "./Declare"
import type { FlowEntry, Namespace } from "../registry"
import type { CommandActions } from "./Declare"

/** The `history` namespace row: the slash tree lists it in registry.ts NAMESPACES order. */
export const namespace: Namespace = { id: "history", label: "History", summary: "The repository's history of changes" }

/** The `history` flows registered as one aggregator block. */
export const historyFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  flow({
    name: "history.bootstrap", visibility: "hidden",
    summary: "Create the history from main's commits",
    hidden: true,
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
