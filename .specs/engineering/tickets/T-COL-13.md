# T-COL-13 Versioned on-disk outbox format: read or migrate the previous release, refuse the unknown

Stage R · Size S · Depends on T-COL-03a · Unblocks —
Spec: spec.md §9.1.4, §9.1.4a, §16.4 · Product: mvp.md §12 (in-place upgrade to the maintainer release)

Added 2026-10-07 by smithers-8a (98's follow-through on #3626: the wire protocol is exactly 5 with no negotiation, so the persisted outbox needs its own version for upgrades).

## Goal
A machine whose outbox was written by release N delivers every event after the install upgrades to N+1, and a daemon never misreads an outbox format it doesn't know.

## Scope
In: a format version in the outbox file header; reading or migrating release N's format in N+1, preserving order, `seq`, `event_id` and pending refs; refusing unknown or newer versions (no send, file untouched, `status()` reports `outbox_format_unsupported`); the version bump rule (any change to the persisted layout increments it).
Out: wire protocol changes (ADR 0004, exactly one version); downgrades; host-side journal migrations (T-INS-07).

## Changes
- Reshape `crates/smithers-machined` outbox storage (T-COL-03a's `outbox_store`) to write a versioned header; no second store.
- Keep a fixture outbox written by the current format under the crate's test data for the next release's migration test.

## Decisions and pre-review
- smithers-3f reviews the refusal path; smithers-8a accepts the version rule.

## Tests

C-DUR-05:
1. Write an outbox with N's format (committed fixture), start N+1's daemon: every event is sent once, in `seq` order, with the same `event_id`s, and pending refs survive.
2. Start the daemon on an outbox with version N+2 and on a corrupted header: no event is sent, the file is unchanged byte for byte, and `status()` reports `outbox_format_unsupported`.
3. Migrate, then crash mid-migration and restart: no event is lost or duplicated.

Pass when:
- Steps 1 to 3 hold with literal fixtures.

## Acceptance
- [C-DUR-05](../checks/C-DUR-05.md)

## Risks and notes
- The first release has no N-1 to read; the fixture written now becomes the next release's step-1 input.
