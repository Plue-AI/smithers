# TUI completion repair, 2026-09-29

Owner: [#2937](https://github.com/smithersai/smithers/issues/2937).
Product evidence: give a maintainer the requested answer, and preserve an honest
failure as failed work they can retry.

## Reproduced failure

The source TUI was asked to read the actual `.smithers/FACTORY.ts` and name its
four home apps and flow IDs. Both bounded print attempts returned no answer:
8.686 seconds with a 10,000-token ceiling and 11.398 seconds with 20,000.
The product default budget is unbounded. These were deliberate audit ceilings.

A recorded diagnostic established that the model read the file and supplied
the correct answer. The unchanged-workspace guard discarded it before the
completion judge ran. Budget admission then refused the next estimated call.
The failure was a lost supported answer, with no workspace mutation required.

## Repair

The existing atomic completion classifier now also reads whether the reply
claims delivered file edits and whether it explicitly reports unfinished work.
A confidently supported answer can finish on an unchanged workspace. Claimed
edits retain their mutation evidence check. Other measured demands, invented
evidence refusal, and unavailable-judge failures retain their precedence.

Explicit unfinished work with a low completeness reading produces
`completion_incomplete`, carrying the bounded explanation. It persists as a
failed control run and a failed, retryable terminal worker. Print mode exits 1
and retains that explanation. Low completeness alone keeps its existing soft
demand policy, whose false-positive measurements are documented in the harness.

Generic scripted adapters conservatively answer the new facts; explicit tests
supply their intended verdicts. The migration includes wire fixtures, cache
identity notes, consumer checks, failure copy, and generated documentation.

## Real answer receipt

One repaired source run used an isolated exact copy of the factory, the detected
`openai:gpt-6-sol` subscription, approval `deny`, a 20,000 main-model token
ceiling, and a 90-second deadline. No gateway API key was present.

| Observation | Result |
| --- | --- |
| Answer | Fix an issue (`issue.implement`), Review a PR (`prs.triage`), Ask the codebase (`wiki.ask`), Run it every night (`triggers.register`) |
| Outcome | Exit 0; file unchanged |
| Calls | One real read; two admitted model calls; no third request |
| Elapsed | 25.839 seconds |
| Main-model tokens | 15,546 |
| Recorded evaluator tokens | 3,505; compaction usage absent |
| Completion judgment | 11.100 seconds; no demanded or refused completion |

Evaluator usage is outside the main-model ceiling. This is one live correctness
receipt, with incomplete total usage accounting. It is slow for the question;
[#2176](https://github.com/smithersai/smithers/issues/2176) retains the broader
usefulness work. The live receipt preceded the typed-failure addition; the
classifier and successful answer path were preserved. The final failure path
is verified separately through actual hosts and durable control storage.

## Validation and delivery

The audit began at `f5e23ba446da7cdd3d2ba457f56a22418762f162`. The isolated
repair was then applied to main `909d4e3ed4fd216893be03629eb9deacf1f1e6aa`.
Newer fault ownership, subscription routing, and wire identities were preserved.

On that main revision, terminal host, worker, reload, and source-print cases
pass: 128 cases, 596 assertions. Model tests pass: 796 cases, nine skipped,
100% measured statements, branches, functions, and lines. Terminal and model
test typechecks pass. Model/judge/HTTP responses in those deterministic cases
are controlled; filesystem, observer, budget, and host boundaries are real.

The latest-main harness gate passes 1,770 cases with 100% measured coverage;
one opt-in Workerd case is skipped. Changed agent contracts pass 159 cases,
the real durable failure/retry and usage checks pass three cases, wire and
scripted-adapter checks pass 36, and the registered flow owner passes eight.
The current native helper was built with the pinned toolchain from this main
revision; ten native memory cases pass. Harness and agent test typechecks pass.
The changed scripted adapter measures 100% coverage. The broader fault sweep
still finds the existing `AttemptTimedOut` registration failure.

An official declaration build compiled all 50 public packages. Compatibility
review regenerated only the owning agent and harness baseline records; their
export maps remain unchanged. The full declaration gate still reports the
existing CLI export/declaration drift. Its baseline record was preserved.

The older audit revision's agent suite passed 1,057 cases but failed its
aggregate 100% coverage gate in unchanged AgentSession/Budget regions. Its
changed scripted adapter measured 100%. The original newer-main agent suite
independently failed ten tests in nine files. The source hashes differ, so
these are separate receipts. [#2290](https://github.com/smithersai/smithers/issues/2290)
tracks the remaining campaign evidence and release blockers.

Astra owns production changes, Sol owns behavioral tests, and Fable review
findings are resolved against actual source and receipts. Detailed sanitized
evidence is retained in `.artifacts/product-audit-20260929/`.

Delivery requires the existing Cloud factory, owner merge, deployed validation,
and app wiki refresh. This session lacks sanctioned Cloud access. No release,
deployed completion, wiki publication, or customer retention is claimed.
