/*
 * The `review` flows. One module per namespace: a lane that adds or edits a
 * flow here touches no other flow module, and Flows.ts registers each block in
 * the aggregator order.
 */
import { Schema } from "effect"
import { flow } from "./Declare"
import type { FlowEntry, Namespace } from "../registry"
import type { CommandActions } from "./Declare"

/** The `review` namespace row: the slash tree lists it in registry.ts NAMESPACES order. */
export const namespace: Namespace = { id: "review", label: "Review", summary: "Review comments, requests, and the diff since your last one" }

/** The `review` flows registered as one aggregator block. */
export const reviewFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  flow({
    name: "review.since-mine",
    summary: "Open a change's diff since my last review",
    runtime: ["cloud"],
    args: "<changeId>",
    requires: ["signed-in"],
    input: Schema.Struct({ changeId: Schema.String }),
    handler: ({ changeId }) => actions.diffSinceMyReview(changeId)
  }),
  flow({
    name: "review.done",
    summary: "Mark a review comment done: the author addressed it at the current revision",
    runtime: ["cloud"],
    args: "<changeId> <commentId>",
    form: { fields: { threadId: { label: "Comment id" } } },
    requires: ["signed-in"],
    input: Schema.Struct({ changeId: Schema.String, threadId: Schema.Number }),
    handler: ({ changeId, threadId }) => actions.reviewThreadDone(changeId, threadId)
  }),
  flow({
    name: "review.ack",
    summary: "Acknowledge a done review comment: the reviewer accepts the author's work",
    runtime: ["cloud"],
    args: "<changeId> <commentId>",
    form: { fields: { threadId: { label: "Comment id" } } },
    requires: ["signed-in"],
    input: Schema.Struct({ changeId: Schema.String, threadId: Schema.Number }),
    handler: ({ changeId, threadId }) => actions.reviewThreadAck(changeId, threadId)
  }),
  flow({
    name: "review.reopen",
    summary: "Reopen a done or resolved review comment",
    runtime: ["cloud"],
    args: "<changeId> <commentId>",
    form: { fields: { threadId: { label: "Comment id" } } },
    requires: ["signed-in"],
    input: Schema.Struct({ changeId: Schema.String, threadId: Schema.Number }),
    handler: ({ changeId, threadId }) => actions.reviewThreadReopen(changeId, threadId)
  }),
  flow({
    /*
     * plue#488: a review request names EITHER a human login or an agent, so
     * `agent:<name>` is the one spelling that asks a named agent. Asking a
     * person to review is consequential — it notifies them and flips the
     * landing's turn — so the model may ask for it and only the human
     * performs it.
     */
    name: "review.request",
    form: { fields: { reviewer: { label: "Login or agent:name" } } },
    summary: "Ask someone to review a change",
    runtime: ["cloud"],
    confirm: "request a review of the change",
    args: "<changeId> <login|agent:name>",
    requires: ["signed-in"],
    input: Schema.Struct({ changeId: Schema.String, reviewer: Schema.String }),
    handler: ({ changeId, reviewer }) => actions.requestChangeReview(changeId, reviewer)
  }),
  flow({
    name: "review.unrequest",
    summary: "Dismiss a review request on a change",
    runtime: ["cloud"],
    confirm: "dismiss the review request",
    args: "<changeId> <requestId>",
    requires: ["signed-in"],
    input: Schema.Struct({ changeId: Schema.String, requestId: Schema.Number }),
    handler: ({ changeId, requestId }) => actions.unrequestChangeReview(changeId, requestId)
  })
]
