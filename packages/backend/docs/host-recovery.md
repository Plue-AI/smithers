---
title: "Coding host recovery"
description: "Recovery boundaries for a crashed coding host and a lost box."
---

## Process crash

The workspace runtime detects an exited managed host. On the next execution
request, the Flow resolver advances its persisted owner generation and starts
the host in the same box with the same binding-specific state directory.
Read-only resolution does not start a host. A failed health probe alone does
not authorize another owner while the original process may still be alive.

`TestWorkspaceResolverRecoversKilledHostWithoutReplacingBox` exercises this
path with a real PostgreSQL binding store and the process workspace adapter.
It sends SIGKILL to the host, checks the authenticated replacement generation,
retained state path and contents, unchanged box identity, stable reconnect, and
refusal to recreate an intentionally deleted workspace. Its HTTP child stands
in for the coding application; its state sentinel is not a Flow journal. This
qualifies the process lifecycle after an abrupt exit, not an actual OOM event,
microVM recovery, or approval replay.

Run from the repository root with a disposable PostgreSQL server URL:

```bash
SMITHERS_TEST_DATABASE_URL="$TEST_POSTGRES_URL" SMITHERS_REQUIRE_DATABASE_TESTS=1 \
  go test ./packages/backend/flowhost \
  -run '^TestWorkspaceResolverRecoversKilledHostWithoutReplacingBox$' -count=1 -v
```

The separate opt-in
`TestRealBundledHostAdmissionReconnectCompletionAndCancellation` builds the
packaged coding host, parks a plan on approval, stops the host, admits the
approval while offline, and checks completion after restart using the **same** state
directory. It uses a scripted model provider. It does not exercise missing-box
replacement or establish that an in-run approval survives lost storage.

## Queued approval during an outage

An authorized plan decision is admitted to the product queue without contacting
the host. Delivery retries retain its original approval token, authorization,
request identity and launch checkpoint. A duplicate request joins the same
decision. A restarted dispatch service can deliver that decision when the
retained runtime returns with the same artifact and source revision.

`TestQueuedPlanApprovalSurvivesHostOutageAndDispatchRestart` checks this boundary
with real PostgreSQL and a runtime protocol fixture. It checks approval admission
during and after an outage, retries while unavailable, persisted decision
identity, and one delivery after dispatch restart. The fixture does not qualify
Control journal replay, an executing run's approval, or cross-box recovery.

```bash
SMITHERS_TEST_DATABASE_URL="$TEST_POSTGRES_URL" SMITHERS_REQUIRE_DATABASE_TESTS=1 \
  go test ./packages/backend/flowdispatch \
  -run '^TestQueuedPlanApprovalSurvivesHostOutageAndDispatchRestart$' -count=1 -v
```

## Lost box

A box the runtime no longer has at all is replaced only when its coding hosts
keep their journals in PostgreSQL (`SMITHERS_FLOW_JOURNAL_POSTGRES_URL`,
[#2099](https://github.com/smithersai/smithers/issues/2099)). Parked runs and
their Control approval tokens live in the workspace's journal database, not in
the box, so replacement keeps them.

The next inspection of the host (every host call and every observation of a
progressing run inspects it) finds the box missing. The workspace service
then:

1. Checks that the product row is still held running. A box stopped,
   suspended or deleted on purpose is never recreated.
2. Rechecks the resume admission, as a restart of a stopped box does.
3. Ends every current session of the workspace's journal role
   (`PostgresJournals.Fence`). A workspace with no journal database has nothing
   to recover, so its box is not recreated.
4. Creates the box again under the same workspace ID and prepares it like a
   fresh start, including the repository checkout.

The resolver then starts the host at the next owner generation on the same
journal database, which holds the parked run and its approval token.

With journals in the box (SQLite in the state directory), a missing box stays
a refusal: `workspace runtime no longer exists; create a fresh workspace`. Do
not recreate an empty box and report recovery.

`TestRestartLostBoxReplacesAMissingBoxOnlyWithAJournal` and
`TestBoxHostLauncherRestartsALostBox` cover the decision.
`TestPostgresJournalsFenceEndsOnlyTheLostBoxsSessions` runs the fence on real
PostgreSQL:

```bash
SMITHERS_TEST_DATABASE_URL="$TEST_POSTGRES_URL" SMITHERS_REQUIRE_DATABASE_TESTS=1 \
  go test ./packages/backend/flowhost \
  -run '^TestPostgresJournalsFenceEndsOnlyTheLostBoxsSessions$' -count=1 -v
```

Limits tracked in [#1868](https://github.com/smithersai/smithers/issues/1868):

- The journal credential is derived per workspace and nothing in the journal
  checks the owner generation. The fence ends current sessions only; a
  partitioned host that is still alive can connect again and write.
- The replacement decision is serialized per process, not across backend
  replicas. A second replica that also saw the box missing can end the
  replacement host's current sessions.
- The replacement's repository is a fresh checkout of the target bookmark. The
  lost box's working-copy edits and the artifacts in its state directory are
  gone.
- Hosted (plue) placements are not replaced yet. Their `CreateWorkspace`
  returns the lost placement row, which still inspects as missing, so the
  replacement fails and the next inspection tries again. A microVM guest also
  needs a routable journal server address, which hosted deployments do not
  configure yet.
- No end-to-end run has yet parked an approval, lost its box, and completed on
  the replacement through the packaged host.
