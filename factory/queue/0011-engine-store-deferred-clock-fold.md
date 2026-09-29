---
status: queued
issue: https://github.com/smithersai/smithers/issues/2054
priority: p1
---

# Fold deferred completions and clock deadlines into the journal

Implement the deferred/clock row in the fold table from the "Journal
Consensus" spec: `flows_deferred_completions` and
`flows_clock_deadlines` become rebuildable materializations of journal events.

- Keep `@smthrs/engine-store`'s durable deferred and clock behavior while
  moving the durable contract to journal events.
- The derived deadline/completion tables may remain as wakeup indexes, but a
  restart must be able to rebuild them from the journal.
- Preserve first-completion-wins deferred semantics, clock scheduling/cancel
  semantics, and existing resume scheduling behavior.
- Preserve `DurableWriter` savepoint atomicity between journal appends and the
  wakeup materialization updates.
- Add rebuild/conformance tests that compare the live indexes with a replayed
  fold across completion, duplicate completion, scheduled deadline, cancelled
  deadline, and restart recovery paths.
