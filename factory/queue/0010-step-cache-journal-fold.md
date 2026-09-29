---
status: queued
issue: https://github.com/smithersai/smithers/issues/2053
priority: p1
---

# Fold the step cache into the journal

Implement the step-cache row in the fold table from the "Journal Consensus"
spec: `flows_step_cache` becomes a
rebuildable materialization of sealed step-result journal events.

- Keep `@smthrs/step-cache`'s public `CacheStore` API while moving the durable
  contract to journal events carrying cache provenance.
- Preserve first-writer-wins admission, payload limits, and step-key
  staleness semantics.
- Eviction remains a checkpoint/compaction concern; a materialized cache row
  may be dropped and rebuilt from the retained journal history.
- Preserve `DurableWriter` savepoint atomicity between cache admissions,
  evictions, and their journal records.
- Add rebuild/conformance tests that compare the live cache materialization
  with a replayed fold across insert, duplicate, conflict, eviction, and
  provenance paths.
