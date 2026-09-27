# @smthrs/patterns

Release candidate scope, host requirements and compatibility review are defined in the [library support policy](https://github.com/smithersai/smithers/blob/main/RELEASE_SUPPORT.md).

This package declares `effect` as an exact
`4.0.0-rc.115` peer dependency. Keep the application on that version so
all Smithers packages share one Effect runtime.

**Documentation:** https://smithers-patterns.smithers.sh

Higher-order flow patterns and decorators for flows: review loops, escalation
ladders, sagas, merge queues, check suites, and model-authored delegation. Every
pattern declares the work as a graph before any of it runs, so a budget, a
reviewer, or a scheduler can read the worst case in advance. It composes
`@smthrs/flow` and the one effect model in `@smthrs/plan/Effects`, and imports
no Node built-ins.

Not on npm yet; see [Installation](https://smithers.sh/docs/installation/#use-the-libraries).

The package
needs Node.js 26.4.0 or later and shares its `effect` peer with the host.

## Produce, review, revise

```ts
import { ReviewLoop } from "@smthrs/patterns"
import * as Effect from "effect/Effect"

interface Review {
  readonly approved: boolean
  readonly note: string
}

// Your own two model calls. Each returns an Effect.
declare const draft: (goal: string) => Effect.Effect<string>
declare const critique: (notes: string) => Effect.Effect<Review>

const result = await Effect.runPromise(
  ReviewLoop.run("Write the release notes for 1.0.", {
    maxRounds: 3,
    produce: draft,
    review: critique,
    revise: ({ output, review }) => draft(`${output}\n\nThe reviewer asked for: ${review.note}`)
  })
)
```

`run` returns the approved value, or
`{ output, review, approved: false, exhausted: true }` when every round is
spent. The same loop declared instead of executed, `ReviewLoop.make`, is a
graph of six calls you can count and cost before anything happens.

The full API reference lives at
[smithers-patterns.smithers.sh/reference/api](https://smithers-patterns.smithers.sh/reference/api/).

## Public API

The root entry point exports every public module as a namespace; each is also importable from its listed subpath.

| Module            | Import specifier                   | Summary                                                                                                                                                            | Public exports                                                                                                                                                                                                                           |
| ----------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PatternError`    | `@smthrs/patterns/PatternError`    | Stable failures shared by higher-order flow patterns.                                                                                                              | `PatternErrorCode`, `PatternError`                                                                                                                                                                                                       |
| `Pattern`         | `@smthrs/patterns/Pattern`         | Flow-valued slots and authority-narrowing decorators.                                                                                                              | `Slot`, `slot`, `bind`, `Decorator`, `Clipped`, `clipped`, `decorate`, `decorateAll`                                                                                                                                                     |
| `WithRetry`       | `@smthrs/patterns/WithRetry`       | Bounded retry helpers.                                                                                                                                             | `Backoff`, `Options`, `make`, `withRetry`, `retryEffect`                                                                                                                                                                                 |
| `WithCache`       | `@smthrs/patterns/WithCache`       | Engine step-key cache decoration.                                                                                                                                  | `Scope`, `Options`, `Policy`, `CachePolicyAnnotation`, `policyOf`, `make`, `withCache`                                                                                                                                                   |
| `WithApproval`    | `@smthrs/patterns/WithApproval`    | Run-local approval decoration.                                                                                                                                     | `Approved`, `Options`, `make`, `withApproval`                                                                                                                                                                                            |
| `Debate`          | `@smthrs/patterns/Debate`          | A bounded, alternating deliberation pattern.                                                                                                                       | `Turn`, `RuntimeTurn`, `RuntimeOptions`, `MakeOptions`, `make`, `run`                                                                                                                                                                    |
| `Panel`           | `@smthrs/patterns/Panel`           | A deterministic panel deliberation pattern.                                                                                                                        | `MakeOptions`, `RuntimeOptions`, `make`, `run`                                                                                                                                                                                           |
| `Escalation`      | `@smthrs/patterns/Escalation`      | Sequential escalation pattern.                                                                                                                                     | `Rung`, `MakeOptions`, `RuntimeRung`, `RuntimeOptions`, `Reached`, `Exhausted`, `accepted`, `defaultEscalate`, `make`, `run`                                                                                                             |
| `ReviewLoop`      | `@smthrs/patterns/ReviewLoop`      | Bounded produce-review-revise pattern.                                                                                                                             | `MakeOptions`, `RuntimeOptions`, `Exhausted`, `accepted`, `make`, `run`                                                                                                                                                                  |
| `MapReduce`       | `@smthrs/patterns/MapReduce`       | Deterministic map-reduce declaration pattern.                                                                                                                      | `OnEmpty`, `MakeOptions`, `RuntimeOptions`, `make`, `run`                                                                                                                                                                                |
| `Recursion`       | `@smthrs/patterns/Recursion`       | Trellis-style bounded recursive expansion declarations.                                                                                                            | `Envelope`, `RecurseOptions`, `Branch`, `recurse`                                                                                                                                                                                        |
| `Bounded`         | `@smthrs/patterns/Bounded`         | Bounded fan-out: a fixed set of members run at most `concurrency` at a time, highest priority first.                                                               | `AllOptions`, `RuntimeOptions`, `all`, `run`                                                                                                                                                                                             |
| `TryCatchFinally` | `@smthrs/patterns/TryCatchFinally` | Scoped error boundary: a protected body, a filtered recovery arm, and a finalizer that runs on every path.                                                         | `MakeOptions`, `RuntimeOptions`, `make`, `run`                                                                                                                                                                                           |
| `Quarantine`      | `@smthrs/patterns/Quarantine`      | Continue-on-failure fan-out.                                                                                                                                       | `Policy`, `Quarantined`, `Succeeded`, `Settled`, `AllOptions`, `RuntimeOptions`, `isQuarantined`, `isSucceeded`, `settle`                                                                                                                |
| `Saga`            | `@smthrs/patterns/Saga`            | Forward steps with compensations that unwind in reverse.                                                                                                           | `OnFailure`, `Step`, `MakeOptions`, `RuntimeStep`, `RuntimeOptions`, `Compensated`, `make`, `run`                                                                                                                                        |
| `Trellis`         | `@smthrs/patterns/Trellis`         | Model-authored bounded delegation plans.                                                                                                                           | `TrellisErrorCode`, `TrellisError`, `Envelope`, `Agent`, `Plan`, `Leaf`, `leaves`, `validate`, `CompileOptions`, `compile`, `MakeOptions`, `make`, `Authoring`, `Continuation`, `Round`, `RunResult`, `RuntimeOptions`, `execute`, `run` |
| `DelegationChain` | `@smthrs/patterns/DelegationChain` | The fixed delegation chain: refine, plan, derisk, execute, review, settle.                                                                                         | `DelegationErrorCode`, `DelegationError`, `Budget`, `Bounds`, `MakeOptions`, `Work`, `ReviewRequest`, `DeriskRequest`, `PlanRequest`, `Settlement`, `RuntimeOptions`, `accepted`, `bound`, `make`, `run`                                 |
| `CheckSuite`      | `@smthrs/patterns/CheckSuite`      | Check-suite pattern: run independent checks with bounded concurrency and reduce their rows to one verdict.                                                         | `Strategy`, `MakeOptions`, `CheckResult`, `Verdict`, `RuntimeOptions`, `passed`, `rows`, `verdict`, `make`, `run`                                                                                                                        |
| `DriftDetector`   | `@smthrs/patterns/DriftDetector`   | Capture the world, compare it to a baseline, and alert when it moved.                                                                                              | `MakeOptions`, `RuntimeOptions`, `Result`, `drifted`, `make`, `run`                                                                                                                                                                      |
| `Intervene`       | `@smthrs/patterns/Intervene`       | Intervene pattern: read a target, propose a change, apply it behind an optional approval, and report what happened.                                                | `MakeOptions`, `RuntimeOptions`, `make`, `run`                                                                                                                                                                                           |
| `Kanban`          | `@smthrs/patterns/Kanban`          | Kanban pattern: move every item through an ordered list of columns, with a concurrency bound applied inside each column.                                           | `Item`, `Column`, `MakeOptions`, `RuntimeColumn`, `Failure`, `Board`, `RuntimeOptions`, `make`, `run`                                                                                                                                    |
| `Loop`            | `@smthrs/patterns/Loop`            | Bounded repeat-until-predicate loops.                                                                                                                              | `OnMaxReached`, `MakeOptions`, `RalphOptions`, `RuntimeOptions`, `RalphRuntimeOptions`, `Result`, `done`, `make`, `ralph`, `run`, `runRalph`                                                                                             |
| `MergeQueue`      | `@smthrs/patterns/MergeQueue`      | Merge-queue pattern: land a set of members in one prioritized order, at a concurrency the queue owns rather than the members.                                      | `DefaultPriority`, `FailurePolicy`, `Member`, `MakeOptions`, `RuntimeMember`, `RuntimeOptions`, `Landed`, `Quarantined`, `Result`, `Position`, `ordered`, `make`, `run`                                                                  |
| `Optimizer`       | `@smthrs/patterns/Optimizer`       | Generate, evaluate, improve: a bounded search for a candidate that reaches a target score.                                                                         | `OnMaxReached`, `Attempt`, `Evaluation`, `MakeOptions`, `RuntimeOptions`, `Result`, `make`, `run`                                                                                                                                        |
| `Runbook`         | `@smthrs/patterns/Runbook`         | Runbook pattern: an ordered list of steps where a step's risk decides whether it is gated by an approval, and a denial either stops the runbook or skips the step. | `Risk`, `OnDeny`, `Step`, `MakeOptions`, `Request`, `RuntimeStep`, `RuntimeOptions`, `Result`, `gated`, `elevated`, `make`, `run`                                                                                                        |
| `ScanFixVerify`   | `@smthrs/patterns/ScanFixVerify`   | Scan for issues, fix them in parallel, verify, and repeat until clean.                                                                                             | `MakeOptions`, `RuntimeOptions`, `Report`, `resolved`, `make`, `run`                                                                                                                                                                     |
| `Sidecar`         | `@smthrs/patterns/Sidecar`         | Run a cheap shadow beside the primary and measure the gap.                                                                                                         | `MakeOptions`, `Scores`, `Delta`, `Shadow`, `Result`, `RuntimeOptions`, `delta`, `make`, `run`                                                                                                                                           |
| `Supervisor`      | `@smthrs/patterns/Supervisor`      | Supervisor pattern: one boss plans, workers execute in parallel, the boss reviews, and only the tasks the review calls retriable are re-delegated.                 | `Task`, `Plan`, `MakeOptions`, `Outcome`, `RuntimeOptions`, `Completed`, `Exhausted`, `make`, `run`                                                                                                                                      |

`@smthrs/patterns/package.json` is also exported. `internal/*` and nested
`*/index` subpaths are not public.

## Declaration size

Every `make` expands its declared bounds eagerly into graph nodes. The options
that expand or multiply topology are `Loop.maxIterations`,
`ReviewLoop.maxRounds`, `Debate.rounds`, `Recursion` envelope depth across
fanout, `ScanFixVerify.maxRetries` times `maxIssues` in concurrency-sized
batches, `Trellis` envelope fuel, and `DelegationChain.maxDepth` together with
`maxDeriskRounds`. These bounds are sized for tens to low hundreds of declared
calls. A very large bound builds a very large graph before anything runs. For
an unbounded loop, use the `run` half under an external scheduler instead of
unrolling it in `make`.

## Identity and ownership

Ids and names are compared by exact, case-sensitive string equality with no
Unicode normalization. Every `make`, `run`, and decorator factory snapshots
its options at the call, so a later edit to the caller's objects does not
change a declaration or a run. Flows, callbacks, inputs, and the values
callbacks return stay the caller's references. The full contract is in
[Identity and ownership](https://smithers-patterns.smithers.sh/reference/api/#identity-and-ownership).

## Where a `WithCache` policy takes effect

`WithCache` requires explicitly declared hermetic effects with a sealed or
omitted tier. `ttlMs` must be a positive safe integer; `version` must be a
nonblank string. Invalid declarations throw `PatternError` with code
`invalid_decorator` synchronously when applied.

The options enter declaration identity. `ttlMs` and `scope` also travel in the
flow's annotation bag, preserved through decorator composition. The
[`@smthrs/registry`](https://registry.smithers.sh) bridge lowers a module's
default-exported flow policy onto a dispatched action. Ordinary nested core
calls do not propagate the flow's bag. The durable engine reads the action
policy set by `CacheEnvironment.withCache(action, policy)` from
[`@smthrs/flow`](https://flow.smithers.sh).

See the [WithCache reference](https://smithers-patterns.smithers.sh/reference/api/#withcache)
for the options, host boundary, and a minimal hermetic flow example, and
[`@smthrs/step-cache`](https://step-cache.smithers.sh/reference/api/) for enforcement.
