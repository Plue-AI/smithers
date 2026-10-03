# C-COL-02 Live channel resubscribes without gaps or duplicates

Proves: mvp.md §2 rule 5 (honest state) · spec.md §7.1.1, §7.2, §3.3 · Layer: fault · Stage: S1 · Tickets: T-COL-02
Automation: `packages/backend/internal/live/live_resubscribe_fault_test.go` (new) · Runs in: CI

## Setup
A client subscribed to `home` and `todo:T1` at cursors c1 and c2, while a writer commits 1,000 projection events.

## Steps

- Decode every committed Live frame and old record. Assert discriminator t and reserved presence/binary kinds produce err unsupported with the socket left open. Preserve subpath exports and assert no barrel export.
1. Drop the socket mid-stream, reconnect after 2 s with the cursors, and resubscribe.
2. Overflow the client's send budget to force a `gap`, then resubscribe without a cursor.
3. Reconnect with a cursor older than retention.

## Pass when

- The adopted owner contract passes: Decode every committed Live frame and old record. Assert discriminator t and reserved presence/binary kinds produce err unsupported with the socket left open. Preserve subpath exports and assert no barrel export.

- Add client unit coverage: two Containers on same and different topics share one socket; one sub per topic, unsub only on last departure, and reconnect one sub per topic with its cursor.
- After step 1, the deltas the client applied equal the committed events, with none missing and none duplicated (compared by seq).
- After step 2, the client receives a fresh `snap` and the state matches the database.
- After step 3, the client receives a `snap`, not a partial replay.

## Fail when
- Any seq is applied twice or skipped.
- The client shows a state no committed event produced.

## Evidence
`.artifacts/checks/C-COL-02/<ts>/`: the applied seq list against the committed seq list and the commit.
