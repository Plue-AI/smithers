# T-AGT-02 Session-owned transcript tail and branch ingestion

Stage S2 · Size L · Depends on T-AGT-01, T-TRM-07, T-TRM-01, T-COL-02, T-COL-06 · Unblocks T-AGT-03, T-REL-02 · Issue: [#3622](https://github.com/smithersai/smithers/issues/3622)
Spec: spec.md §7.2, §7.3, §8.7.2, §9.1.2, §9.6.6, §14.5.5 · Delta: delta.md §9 · Product: mvp.md M-38, M-34

## Goal

Tail the terminal owner's identified external-agent transcript and publish its parsed conversation live.

## Ownership

smithers-3f owns daemon and backend.

## Scope

In:
- Process-tree discovery, owner-uid reader, separate inotify tail, outbox, host normalization, attribution and read-only enforcement.

Out:
- Product surfaces beyond M-38.

## Changes

- Add broker discovery using T-TRM-07's registry. Verify agent executable, process lifetime, cgroup, uid and source linkage. Support both default roots and fixture-documented overrides. Import only the linked session source; do not scan unrelated history or other homes.
- Read through an owner-uid child with beneath-root, no-symlink regular-file checks. Add bounded record framing and partial-line buffering; document limits in the profile and report malformed/oversized records visibly.
- Add inotify tail plus 1 s reconciliation. Handle file replacement, truncation, overflow and reconnect with source generation/offset identity and §9.1.4 receipts.
- Host ingestion calls T-AGT-01 and persists normalized entries/events before conversation deltas. No model launch, delegated credential or executable run is created. Reserve new table ownership under §21.3 before migrations.
- Register an agent participant per process lifetime with for_member from the registry; reuse it in presence, terminal data and conversation. Stop reads on revocation while preserving shared history.
- Refuse imported-content mutations server-side. Provide no raw-transcript-file endpoint. Imported edit reports do not change §9.3 attribution.

## Tests

- C-AGT-02 uses real Linux inotify/cgroups, PostgreSQL and real agent sessions; covers isolation, latency, replay and lifecycle.

## Acceptance

- [C-AGT-02](../checks/C-AGT-02.md): C-AGT-02 daemon/backend assertions pass.

## Risks and notes

- Framing occurs in Rust; semantic normalization occurs in the host TypeScript library before live deltas. No S1 ticket depends on this work.
