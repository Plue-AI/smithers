---
title: "Shape a model's answer into typed output"
description: "Enforce a declared output schema on a model-backed step: the correction ladder, the repair slot, and the rejection record on the journal."
sidebar:
  order: 2
---

Every `AgentAction` declares an `output` schema. The schema is rendered into
the run's system teaching, and the original `ctx.done` value is decoded by it.
A string such as `"12"` keeps its type and whitespace; a string answer can
use JSON extraction when the schema expects another type. Older text-only
completion records retain text decoding. A downstream step reads typed fields;
nobody parses prose. This guide covers what happens when the answer misses the
schema.

## The correction ladder

A decode miss spends a correction slot. Three numbers decide how
hard a step tries to answer in shape, and each is declared where the person who
cares about it works:

| Where                     | What it says                                          |
| ------------------------- | ----------------------------------------------------- |
| `Options.corrections`     | This step's budget. Zero makes a first miss terminal. |
| `Host.defaultCorrections` | The composition's budget for steps that declare none. |
| `Options.repair`          | One bounded ask after the budget is spent.            |

Neither declared leaves the budget at one. The declaration always beats the
composition default, including when it is zero: a step that declared a first
miss terminal stays terminal under a generous host. Both numbers must be
non-negative safe integers; anything else raises `InvalidCorrectionBudget` at
declaration time rather than at the first decode miss.

The run is asked for the value itself, `ctx.done({ ... })`, not a JSON string.
Every `ctx.done` is decoded as it happens. A miss goes back to the same
session as a correction, journaled as the harness's `OutputDemanded`: the run
keeps its realm, its settled calls, and what its cell printed, so fixing the
shape repeats no work.

When the run has no frame left to answer in, or its last same-session
correction still misses, the step falls back to a fresh session: the task
repeated verbatim with the validation issues appended. Each fresh session is
a whole new cell run under its own session and prompt, so its model call is a
distinct sealed step with its own content key. A settled ladder replays whole
across a process restart and pays the provider nothing. Corrections of both
kinds spend the one budget.

`flows_agent_structured_output_rejections` counts every refused answer and
`flows_agent_structured_output_exhausted` every step that failed after its
budget and repair.

## The repair slot

A repair is not another rung of the ladder. It is the author's own prompt,
written from the failure, asked exactly once, and decoded by the same schema:

```ts
const Review = AgentAction.make("review/Diff", {
  payload: { diff: Schema.String },
  output: Schema.Struct({ approved: Schema.Boolean, issues: Schema.Array(Schema.String) }),
  seat: "anthropic:claude-sonnet-4-5",
  prompt: ({ diff }) => `Review this diff:\n${diff}`,
  corrections: 2,
  repair: {
    prompt: (failure) => `Return ONLY the JSON review. The last answer failed with: ${failure.issues.join("; ")}`
  }
})
```

The `failure` argument carries the declared schema's digest, the issues the
last candidate raised, and how many corrections were spent, so the prompt can
say what to fix without restating the schema. The repair runs on the step's own
seat with the step's own teaching unless the declaration says otherwise through
`repair.seat` and `repair.system`. A repair that misses too fails the action
with its own `StructuredOutputFailure`, which is the last evidence the boundary
has.

## The rejection record

Every rejection writes one `flows.agent.structured-output-rejected.v1` record
on the journal's lossy channel, carrying the action, the attempt, the budget,
the schema digest, and a digest of the issues. The record exists because the
final failure only describes the last candidate: a run that answered three
times says so in its own trail, and two runs that spent their budget the same
way are distinguishable without the answers themselves being journaled.

The record is evidence, not a decision. Nothing in the ladder reads it back,
compaction may drop it, and a composition without a journal, such as the
reference memory engine or a test, writes nothing and behaves the same
otherwise.

## Reading the ladder back

A session is key material and is hashed into the step key, so three distinct
keys say a ladder ran but not which call was the ask. `AgentAction` sets
`FlowEngineLike.Correction` around each rung and the port stamps the ordinal
onto that rung's own `RecordedModelStep`: a projection reading the run's sealed
steps gets `correction: 0` for the ask and, for each fresh-session rung, the
corrections already spent when it opened. The
field is optional: a model call outside a ladder has no ordinal, and a record
written before the field existed still decodes for a parked run resuming onto a
newer package.

## When the budget is spent

The step fails with `StructuredOutputFailure`, a member of
[`AgentAction.AgentFailure`](../api.md#agentactionagentfailure). Handle it at
the flow boundary like any other typed action failure. For a run that should
keep working through provider misbehavior rather than only through malformed
answers, see [Park on quota refusals and limit model admission](./quota-and-budgets.md).
