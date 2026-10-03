/*
 * The `change` flows. One module per namespace: a lane that adds or edits a
 * flow here touches no other flow module, and Flows.ts registers each block in
 * the aggregator order.
 */
import { Schema } from "effect"
import { flow } from "./Declare"
import type { FlowEntry, Namespace } from "../registry"
import type { CommandActions } from "./Declare"

/** The `change` namespace row: the slash tree lists it in registry.ts NAMESPACES order. */
export const namespace: Namespace = { id: "change", label: "Changes", summary: "Changes and diffs — the change is the unit (ADR 0003)" }

/** The `change` flows registered as one aggregator block. */
export const changeFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  /*
   * Lane change (ADR 0003): the change is the unit. `change.view` renders
   * the change card (one card per change, five facets); `change.diff`
   * renders the from → to pair; the acts ride the one seam. The repo
   * resolves from the changes collection, else the app's target repo —
   * never a guess.
   */
  flow({
    name: "change.view",
    summary: "Open a change's card",
    runtime: ["cloud"],
    args: "<changeId> [rev]",
    requires: ["signed-in"],
    input: Schema.Struct({ changeId: Schema.String, rev: Schema.optional(Schema.Number) }),
    handler: ({ changeId, rev }) => actions.viewChange(changeId, rev)
  }),
  flow({
    name: "change.diff",
    summary: "Open a change's diff at two pins",
    runtime: ["cloud"],
    args: "<changeId> [from] [to] [path]",
    requires: ["signed-in"],
    input: Schema.Struct({
      changeId: Schema.String,
      from: Schema.optional(Schema.String),
      to: Schema.optional(Schema.String),
      path: Schema.optional(Schema.String)
    }),
    handler: ({ changeId, from, to, path }) => actions.diffChange(changeId, from, to, path)
  }),
  flow({
    name: "change.land",
    summary: "Land a change (its landing request, or its changeset atomically)",
    runtime: ["cloud"],
    /* The scope is the whole unit: a landing request lands 1 → N (its stack, from its top change), a changeset every member; the card's button and the seam's line name N. */
    confirm: "land the change — the whole landing request 1 → N, or the whole changeset",
    args: "<changeId>",
    requires: ["signed-in"],
    input: Schema.Struct({ changeId: Schema.String }),
    handler: ({ changeId }) => actions.landChange(changeId)
  }),
  flow({
    name: "change.resolve",
    summary: "Dispatch an agent to resolve a change's conflict",
    runtime: ["cloud"],
    confirm: "dispatch an agent to resolve the conflict",
    args: "<changeId> <path>",
    requires: ["signed-in"],
    input: Schema.Struct({ changeId: Schema.String, path: Schema.String }),
    handler: ({ changeId, path }) => actions.resolveChangeConflict(changeId, path)
  }),
  flow({
    /* The card's body tab: showing a facet is how the agent answers "show me the diff / the checks" (.specs/engineering/spec.md §6.1). */
    name: "change.facet",
    summary: "Switch a change card's facet",
    runtime: ["cloud"],
    args: "<changeId> <facet>",
    requires: ["signed-in"],
    input: Schema.Struct({
      changeId: Schema.String,
      facet: Schema.Literals(["walkthrough", "diff", "findings", "checks", "review", "history", "owners"])
    }),
    handler: ({ changeId, facet }) => actions.setChangeFacet(changeId, facet)
  }),
  /*
   * Lane L1 (ADR 0004, the live plue routes): the Diff facet's revision
   * pickers and the Checks facet's picker are the card's controls AND the
   * agent's answer to "show me the diff since rev 2" (.specs/engineering/spec.md §6.1); the
   * thread transitions, the since-my-review pin, and the two finding acts are
   * flows with the same slash, agent, and button path; opening a computer
   * from a revision's snapshot is an outbound act.
   */
  flow({
    name: "change.pins",
    summary: "Pin a change card's diff between two revisions (parent|<rev> → <rev>|current)",
    runtime: ["cloud"],
    args: "<changeId> <from> <to>",
    requires: ["signed-in"],
    input: Schema.Struct({ changeId: Schema.String, from: Schema.String, to: Schema.String }),
    handler: ({ changeId, from, to }) => actions.setChangePins(changeId, from, to)
  }),
  flow({
    name: "change.checks",
    summary: "Read a change's checks at one revision",
    runtime: ["cloud"],
    args: "<changeId> <seq>",
    requires: ["signed-in"],
    input: Schema.Struct({ changeId: Schema.String, seq: Schema.Number }),
    handler: ({ changeId, seq }) => actions.checksOfChangeAt(changeId, seq)
  }),
]
