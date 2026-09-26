# Bounded owner correction

`correction.ts` is an opt-in repository recipe. It exports `CorrectPlan`,
`correctionLayers`, `SelectRepair`, and its private `CorrectionResult` schema.
It does not change `coding/ImplementPlan`, register a gateway capability, or create a
coding ledger. A host must explicitly compose it with the existing coding,
agent, native JJ, executable catalog and check layers before advertising it.

```ts
const result = yield * CorrectPlan.execute({ plan, maxRounds: 3 })
```

## Bounds and durable rounds

`maxRounds` counts validation passes, including the first implementation pass,
and must be between one and eight. One means implement and assess once, with no
repair. A validated result stops immediately. At the bound, unresolved findings
return `changes-requested`; they never become approval, vibed status or delivery.
Each round uses the existing durable trampoline. Each pass is a recorded child
execution, and completed agent/JJ/check steps replay through the normal engine.
There is no process-local retry loop or parallel correction writer.

## Stall breaker

Every unvalidated pass before the last is folded into `@smthrs/flow`'s
`Stall` with three signals: every atom's JJ tree id, each failing check receipt
with its findings, and the findings the next repair would receive. The optional
`stall` input defaults to `{ rounds: 2, on: "park" }`: two passes in a row with
the same signal end the correction before its bound. A cursor recorded before
this option decodes with that default, and the pass execution id ignores the
stall fields, so an in-flight correction resumes on the same pass. `park` returns `blocked` on that pass, `stop`
returns `changes-requested`, and `escalate` fails `CodingError` `stalled`. The
result carries the typed `stalled` verdict. The implement agent's `EditAtom`
also sets `readOnlyCap: 12`: twelve frames without a workspace write demand an
edit, and twenty-four fail the pass with `read_only_cap`.

## Early actionable feedback

The first pass uses `ObservePlan`, an opt-in composition of the existing
implementation, fast-gate and check leaves. Each fast-gated implementation and
validated slow-check receipt is immediately recorded in the existing native
`DurableDeferred` store. The first valid actionable receipt wins a named durable
slot. Both that writer and the final implementation-ready writer check the
committed pair, so neither can miss the other's completion.
Once every planned native implementation exists and feedback is actionable, a
typed `EarlyFeedback` outcome stops the pass before unrelated slow checks finish.
An implementation or fast-gate failure ends the pass directly; there is no
separate all-IDs waiter that can be orphaned by that failure.

A malformed slow receipt is retained as the existing typed `CodingError` in one
private `coding/feedback/invalid-receipt` deferred slot. It is not an actionable
finding and never enters the validated receipt slots. Its recording action keeps
the original check output; returning that output does not validate it. The pass
waits until every implementation is fast-gated before raising the retained
refusal. The invalid slot takes priority over valid first feedback, so a valid
finding cannot hide a later malformed owner, source revision or input digest.
The native action input, typed failure and blocked pass ID remain available for
inspection. This adds no public API, store, receipt type or execution service.

The controller requests cancellation through the existing native flow runtime,
then uses the ordinary bounded `Poll` pattern and the engine's lineage/DAG reads
to require terminal states for the pass and all linked descendants. A cancellation
request alone is insufficient. Failure to acknowledge within 300 observations
100 ms apart returns blocked evidence, retaining the original pass and receipts.
That bounded poll has a stable execution ID. If it exhausts and the host restarts
before the round records its blocked outcome, replay retains the exhaustion even
if children have since stopped. Retrying that situation requires a new
`CorrectPlan` execution; the old cursor does not silently refresh its evidence.
This is a native terminal-state acknowledgement; it does not add a new lease,
process registry, cancellation service or history store. Immutable check processes
remain scoped to their existing check leaf. The native acceptance fixture also
checks the cancelled process and source export are gone before it accepts success.

Only then does correction choose the earliest owning Change among the completed
receipts. The implementation branch must have finished; actionable feedback and
receipt-validation refusals do not preempt a JJ edit midway through an atom or
replan uncreated atoms. An execution failure inside a check remains a separate
failure path and can interrupt parallel work. Repair passes
use the same feedback path. All originally completed receipts remain in their
original execution, including the typed early outcome and its trigger.

If several checks finish after implementation readiness, their early outcomes
can contain different subsets of completed slow receipts. The round's recorded
outcome pins the selected snapshot. A host crash between the pass failing and
that round record can select another recorded partial snapshot on recovery.
Every such result remains `changes-requested`; missing checks are rerun where
required and final validation still requires exact receipts. This recipe does
not claim one atomic snapshot across concurrent check completions.

## Native owner repair

An ordinary `AgentAction` selects one existing atom in that Change and a focused
repair intent. It uses the existing `coding/implement` seat and asks for no tool
calls. The deployment owns the model's actual capability envelope; the prompt
is not an authorization boundary. The configured native host wraps this action
with the existing `evidenceOnly` authority helper, which removes tool capabilities
while retaining its parent model, budget and steering. Standalone compositions
of these exported recipe layers must supply their own equivalent authority;
the `coding/implement` seat alone does not prevent mutation. A deterministic action rejects an unknown or
foreign atom before implementation. The normal implementation delegate edits
that atom in place, preserving its JJ change ID.

Before editing, the recipe re-reads the base and every known atom and refuses
changed code, missing IDs, ambiguity or conflicts. After editing, it re-reads
all IDs, verifies the selected atom and unchanged prefix, and requires one linear
native parent chain. JJ performs descendant restacking. The workflow restores
the working copy to the known mythical tip with a prepared native request; it
never substitutes an arbitrary current head. A concurrent native operation after
the repair's completed receipt refuses that restoration instead of refreshing
its fence silently. The host still owns exclusive coordination of editing work.

Each history observation includes its causal phase and preceding mutation receipt
in the ordinary action input. This distinguishes the before-edit, after-edit and
restored-tip reads during durable replay without adding a second cache.

Operation IDs describe a native read view. A newer read operation alone does
not invalidate an unchanged prefix: its change, commit, tree and parent commit
identities must still match, and its original complete implementation and
receipts are retained. A rewritten suffix receives fresh native revision
references. Only an exactly unchanged reconstructed implementation retains its
old receipts. Otherwise the existing `RunCheck` delegates measure that revision
again, and the normal input digest prevents stale results from validating it.
The recipe does not copy a passed flag onto a rewritten tree.

Fast checks still gate the next rechecked Change. Slow checks overlap subsequent
rechecks. An unchanged prefix keeps only exact individual receipts: missing
checks are run even when other checks for that Change already passed. Final
assessment still requires every configured receipt and validates source commits
and finding ownership. A partial early result is always `changes-requested`,
never `validated`, vibed or shipped.

## Outcomes and evidence

`CorrectionResult` is a private workflow output, not a new store:

```ts
type CorrectionResult = {
  status: "validated" | "changes-requested" | "blocked"
  rounds: number
  result: Result | null
  blocked: { executionId: string; message: string } | null
}
```

An execution failure, including a required fast failure, returns `blocked` and
the failed pass's native execution ID and a bounded error summary. Its actual check and failure evidence
remains in that child's existing journal and attempt store. The last assessment or explicitly partial changes-requested evidence is included
when one exists. The recipe never fabricates a partial
validated result after a fast failure or advances to another repair round.
The parent flow completes with this typed blocked outcome while the failed child
retains its native failed status. Consumers must inspect `CorrectionResult.status`: a
completed orchestration run alone does not mean the code is validated or deliverable.
Cancellation remains cancellation rather than blocked evidence.

The acceptance fixture uses real JJ, the existing Plue adapter, immutable source
exports, real check processes and SQLite. Planner/editor behavior and earlier
owner classification are scripted, so it proves correction, gates and replay,
not the quality of a live model's repair choice or a deployed host.

The configured `Request` composition prepares a plan (reading the published
wiki as memory only when `planning.wiki: true`), admits the observed
source, then runs a coordinator that drains queued feedback and invokes this
correction recipe; feedback before implementation or after correction replans
through the same coordinator. The disposable POC is a separate opt-in
`coding/Prototype` flow and never enters correction or landing. The underlying
memory flows, HumanTask, artifacts, native JJ operations and landing service
provide the relevant primitives; this recipe does not replace those facilities.
