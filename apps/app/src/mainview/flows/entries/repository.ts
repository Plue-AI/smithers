/*
 * The `repository` flows: registering a repository with Smithers
 * (docs/mvp/REGISTRATION.md). One module per namespace.
 */
import { Schema } from "effect"
import { flow } from "./Declare"
import type { FlowEntry, Namespace } from "../registry"
import type { CommandActions } from "./Declare"

/** The `repository` namespace row. */
export const namespace: Namespace = { id: "repository", label: "Repository", summary: "Register a repository with Smithers" }

/** The `repository` flows registered as one aggregator block. */
export const repositoryFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  flow({
    /*
     * One freeform link, the flow's only input: without it the Form Law's
     * form asks for it; with it the analysis starts in the background and
     * the command answers at once.
     */
    name: "repository.register",
    form: { submitLabel: "Register repository", fields: { link: { label: "Repository link" } } },
    summary: "Register a repository: Smithers analyzes it, then we review it",
    runtime: ["cloud"],
    args: "<repository link>",
    requires: ["signed-in"],
    input: Schema.Struct({ link: Schema.String }),
    handler: ({ link }) => actions.registerRepository(link)
  })
]
