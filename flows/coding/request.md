# A prompt through the existing native host

`coding/request` is a private repository declaration whose module IS the
`coding/Request` flow, so it names no delegate. It accepts
`{ prompt, feedback?, maxRounds?, planApproval? }`; the correction limit
defaults to three and admits one through eight passes. The first implementation
counts as a pass.

Optional `planApproval` is `"never"` (default), `"always"`, or `"timeout:Ns"`
for a positive integer number of seconds. After the last pre-implementation
feedback drain, the latter two modes ask a `coding-plan-approval` HumanTask
showing each predicted Change's rationale and atom reads/writes. Approval
unblocks implementation, denial produces a typed `declined` refusal, and
an unanswered timed question auto-proceeds. Replanning after feedback asks
about the newly predicted plan.

```ts
import { Request } from "./request.ts"

// In the configured Effect runtime, using its existing journal and database:
const result = yield* Request.execute({
  prompt: "Add the query using the current storage layer.",
  maxRounds: 3
})
// result.plan: the measured, prepared Plan
// result.outcome.status: validated | changes-requested | blocked
```

This is a new private flow entry and internal result shape, not a new public
Smithers package API. The gateway continues to use its existing plan, approval,
run and watch operations. There is no additional endpoint, database, queue or
executor. The host advertises `coding-request/v1` only when its operator has
provided the owning planning configuration and its verified declaration is
available in the catalog.

The composition prepares a plan from current source files, existing repository
documents and native JJ history. It admits the observed source before the
coordinator can enter bounded correction. `planning.wiki: true` explicitly adds
verified Wiki refresh and memory to preparation; Wiki is off by default. A
repository without generated knowledge can run the same implementation and
validation path. Queued messages cause fresh planning at the boundaries below.
Material planning questions use the existing durable HumanTask.

`coding/prototype` is a separate opt-in declaration whose module IS the
`coding/Prototype` flow.
It prepares and admits source, runs the disposable file-level POC, then checks
source again. It does not enter correction or landing. A real fix does not need
a prototype first. Both entries use ordinary native execution records. The
request's original `PrepareRequest` child preserves the source receipt needed
for finalization, including when feedback later produces a different plan.
The private planning feedback limit is 65,538 characters; the external request
feedback limit remains 32,768 characters.

The correction result's product status is distinct from the surrounding engine's
completion: `blocked` carries the actual failed execution ID and does not assert
validation. A discarded POC is `drafted-unvalidated`; its source preview is not
an executed browser, passing test, vibed state or delivery receipt.

`Options.planning` configures registered implementation/check names. Setting
`wiki: true` additionally requires public engineering Wiki pages, `wikiOutput`
and the `reviewer` policy. Optional
`planningModel`, `pocModel` and `wikiModel` select existing authorized provider
routes; each defaults to the explicitly selected `implementationModel`. This
allows a cheap prototype model without introducing another model client. The
wiki reuse identity includes the operator's reviewer policy, selected review
model and owning gateway. These are private operator options. The prompt cannot
select a different source directory, reviewer, check executable, model credential
or implementation digest.

The host builds its verified executable catalog before providing that exact
catalog to the planning and coding action layers. Declared source bytes are
loaded using the host filesystem during startup. Host-owned wiki generation and
memory verification also use that same injected filesystem for their configured
paths, retaining the wiki's canonical source/output checks and semantic checks.
The private wiki/memory recipes accept that filesystem explicitly at the operation
boundary: native action execution can override construction-time layer context.
These deterministic actions receive an operator-owned catalog; they do not offer
filesystem access to a model. Agent tools continue to use the existing guarded
filesystem and native file eligibility rules. The private native registration
type exposes the injected JJ, SQL and attempt-store services already present in
that runtime; it constructs neither another service nor connection. Wiki reuse
reads the native execution journal and attempt store, not the Control stores.

The private source-admission action returns the existing plan fields with a
required observed head. Legacy plans remain readable elsewhere, but cannot enter
this composed request without a freshly observed source. Admission compares JJ
change/commit/tree/parent facts; the existing operation-level fences continue to
guard later mutations. An admission check is not a lock for the whole run.

Planning, owner-repair selection and review actions are composed with the
captured-evidence authority helper. They retain model routing, budget,
steering and observation, while receiving no tool authority. The existing
agent `unmovedCap: 0` option avoids demanding a code edit from a planning
answer. Actual implementation continues through native JJ, guarded agent
tools, fast gates and asynchronous immutable-source slow checks.

The configured-host acceptance fixture drives the actual gateway host's
Control API with scripted models, real QuickJS cells, Plue JJ, SQLite and
process checks. It covers both a default configuration that creates no Wiki
artifacts and an explicitly enabled Wiki configuration that generates and reuses
verified pages. Both retain steered user feedback and perform actual native
implementation without a POC. Evidence-only model steps cannot
write. Implementation uses Write/Edit/ApplyPatch; ignored files are refused.
The persisted request result identifies its final prepared source and the
validated native atom. The same source and bundle fixture selects either Node
or Bun platform services. Scripted output is not a live-provider quality
evaluation. Final commit cleanup, vibed state and delivery are later stages.

## Feedback at safe boundaries

The configured native host installs the private `routeMessages` decorator and
`feedbackLayer` over its existing control notification queue. The routing,
approved-owner proof and exact durable receipts are described in
[steering.md](steering.md). Every Message addressed to the approved request root
uses the coordinator lineage. Explicit leaf messages and model settings keep
their existing behavior. There is no separate feedback store or transport.

`ReceiveFeedback` runs after each prepared plan but before
implementation, and after each completed correction pass. A message delivered
before implementation causes another planning pass before any plan mutation.
A message delivered during implementation waits for `CorrectPlan` to settle,
then causes a new plan against freshly gathered source and enabled Wiki evidence. The
coordinator never edits an executing plan or interrupts a writer mid-operation.
The next plan can select existing JJ atoms under the usual ownership policy.

The Message receipt is an ordinary completed native Action result. Its exact
notification IDs, text and attribution remain available even if combining the
feedback exceeds the existing 65,538-character planning limit. Nothing is
silently truncated. Queue capacity refusal is returned through the existing
notification error. A receipt that says queued is not evidence that a revised
plan completed: the subsequent actual Plan child is that evidence.

## Bounded ordinary Flow state

A private `CoordinateRequest` cursor contains
`{prompt, feedback, maxRounds, revision, preparedPlan?}`. `maxRounds` is the existing
correction limit; `revision` counts planning passes. The original prepared plan
is reused for the first pass and discarded when feedback requires a new plan. The cursor
is ordinary durable Flow payload and uses the existing trampoline rather than
a second run loop or ledger. The result does not acquire a duplicated transcript,
POC artifact or collection of earlier plans.

There are at most eight planning passes. Repeated messages at that limit produce a typed refusal naming
the retained message IDs. A source admission failure also refuses before
implementation rather than silently updating the plan to a different source.
Existing native per-operation fences still govern every later mutation.

The empty final after-correction receipt is also the coordinator's durable
closed-for-feedback intent. Message admission checks that existing receipt in
the same control journal transaction as admission. If a message wins the race,
the final drain receives it and another planning pass follows. If the empty
drain wins, a new message is refused and the caller can start another request.
An exact retry of an earlier accepted message retains its original receipt.
No extra event, table or closure ledger is introduced. There is no claim of
preemptive steering or an implicit human wait after every plan.

## Verification

The coordinator regression suite uses the real Flow engine and interpreter with
explicitly scripted planning, prototype and correction children. It verifies
constraint and attribution retention, feedback before mutation, replanning from
the source left by correction, bounded continual steering, independent prototype
execution, stale source refusal before and after a prototype, and completed
execution replay. These tests do not measure model quality, native
JJ mutation or operating-system process containment. Those remain covered by
the separate native request, correction and notification host acceptance tests.
