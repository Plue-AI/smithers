---
title: "Attempts and replay"
description: "What the engine persists for each step attempt, how a restart replays a settled row instead of re-executing it, and which admission checks refuse an attempt outright."
sidebar:
  order: 2
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/engine-store/docs/concepts/attempts-and-replay.md"
---

An attempt is one execution of one step under one key. The engine writes a row
before the body runs and settles that row afterwards, so the record of what
happened outlives the process that made it. Replay is the consequence: a
restarted engine reads the row and reproduces its outcome instead of running
the body a second time.

## The step key is the address

Every dispatch is keyed. The key is a digest of the declaration and the
material the step consumes, and the engine stores it hashed: cache addresses
are the injected `Sha256` transformation of the step key, never the raw
`key1_...` value.

Two consequences follow. A declaration change produces a new key, so a step
whose code moved is never served the old answer. And two runs that declare the
same step under the same material land on the same address, which is what makes
a result shareable at all. Whether it is actually shared is a separate
question, answered in [Cache admission](/concepts/cache-admission/).

## What a replay does with each row state

| Persisted row | What a replay does                                                                                                              |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `succeeded`   | Returns the recorded result, and calls `StepBoundary.replayOutputs` first so the workspace holds the outputs the step produced. |
| `failed`      | Rethrows the persisted domain failure. It never re-admits the attempt.                                                          |
| `running`     | Recovers under the run fence and shared admission permit, honoring any recorded effect crossing.                                |
| `suspended`   | Continues the same attempt rather than burning a new one against the retry budget.                                              |

An admitted attempt remains authoritative when a matching shared cache row
exists; another run's cached success cannot replace its result or failure.
Failure values were schema-encoded before persistence, so a `_tag` survives
the JSON round trip and a `RetryPolicy`'s non-retryable matching still applies
on replay.

## Which columns are redacted

Attempt and run rows share a database with the journal, so failure text meets
the journal's redaction rules (`Redaction.defaultRules`) on write. Only text
that replay never classifies on is rewritten:

| Column                        | Redacted                                                                                                 |
| ----------------------------- | -------------------------------------------------------------------------------------------------------- |
| `flows_attempts.error_json`   | String `message` and `stack` members of each persisted reason. `_tag` and every other member stay exact. |
| `flows_runs.state_json`       | The `message` and `stack` text of an unencodable-settlement projection.                                  |
| `flows_attempts.outcome_json` | Never. It is the executable copy replay returns, byte for byte.                                          |

A redacted failure still replays as the same typed failure, because
`RetryPolicy` matches on `_tag`. A value that must never reach `outcome_json`
belongs in a `Redacted` field of the action's own success schema.

## Admission is exclusive per key

Each engine or plan scheduler shares admission permits across its dispatches.
A permit covers one run and step key through admission, execution, and
settlement. Concurrent same-key dispatches wait, then replay the settled
attempt instead of executing another body. Interruption releases the permit.

Holding the permit and the run fence permits recovery of a stranded `running`
attempt. A recorded successful effect crossing supplies the result directly;
an unresolved irreversible crossing requires an idempotency key before retry.
The durable owner and admission checks still refuse a superseded fence or a
conflicting attempt row.

## Attempt counters survive pruning

Two questions come up on a resume, and both are answered from the surviving
attempt rows rather than from a counter held in memory:

- Which attempt number is this? The engine resumes from the persisted
  sequence rather than restarting at 1.
- When did retrying start? `actionRetryOrigin` degrades to the earliest
  surviving attempt row when a retention pass pruned attempt 1.

`DurableEngineState.attemptSurvivors` answers both in one range read, returning
`{ earliestAttempt, earliestStartedAtMs, latest }`. It is optional on the
service: storage that cannot range-scan `flows_attempts` omits it, and the
engine falls back to per-attempt point reads against `AttemptStore`.

## The cache converges with the journal

A crash can land between `attempts.finish` and `cache.put`. The restarted
executor re-records the sealed completion, with fresh cache provenance, rather
than leaving the cache permanently behind the journal. If the row that was
already recorded disagrees with what this run produced, that divergence is not
resolved silently: it goes to the `Inconsistency` receiver, which is strict by
default and fails the dispatch.

## Corrupt evidence on a succeeded row is quarantined, not evicted

A shared cache row whose bytes no longer hash to their recorded digest is
evictable: the next dispatch re-executes and re-captures cleanly, and the
failure is reported as `CacheCorruptionDetected` so a failing disk stays
visible.

A succeeded attempt row is different. It records that this run's side effects
already ran, so evicting and re-executing would break exactly-once for an
irreversible action. Under the strict verdict the corrupt evidence is
quarantined instead: the driver parks the first detection in the `quarantine`
waiting state after `AttemptEvidenceQuarantined`. The engine's automatic polls,
discarded-execution followers, internal wakes, and fresh `execute` calls leave
that park intact. A waiting caller
continues under its `suspendedRetryPolicy`; exhausting that budget reports
`SuspendedResumeGaveUp` without clearing quarantine. Only an explicit
`Flow.resume(executionId)` or engine `resume` authorizes recovery, returning the
durable outcome without re-materializing the poisoned evidence or re-executing
the action.

## Every lifecycle write takes the durable channel

Run decisions, attempt started and finished, hard boundary violations, snapshot
identity, cache provenance, deferred completions, clock schedules, interruption
records, and the `Inconsistency` cache-conflict record all go through the
journal's `emitDurable` channel. A saturated lossy queue can never drop one.
Attempt lifecycle writes additionally pass the owner, so a reclaimed owner
fails with `fence_lost` and self-interrupts instead of appending.

## Typed history and execution authority

The shared [state and event authority contract](https://journal.smithers.sh/concepts/state-event-authority/)
defines additive versioned event families. Current attempt writers retain their
existing bytes. The engine's internal attempt lifecycle and projection adapters
do not change that writer contract or expose new public entrypoints.

Full history and retained snapshot plus suffix rebuild the disclosed attempt
projection. Redacted history does not prove recovery of arbitrary private
results or executable engine state. Keep the authoritative attempt and run
stores; a writer cutover requires complete lineage and encoded results in the
same state transaction, with an explicit migration for retained history.

## Related

- [Ownership and fencing](/concepts/ownership-and-fencing/): who is allowed to write
  an attempt row at all.
- [Step boundaries](/concepts/step-boundaries/): what `replayOutputs` reproduces, and
  where it gets the bytes.
- [Troubleshooting](/troubleshooting/): each of these failures with its
  cause and its fix.
