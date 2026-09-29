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
SMITHERS_TEST_DATABASE_URL="$TEST_POSTGRES_URL" \
  go test ./packages/backend/flowhost \
  -run '^TestWorkspaceResolverRecoversKilledHostWithoutReplacingBox$' -count=1 -v
```

The separate opt-in
`TestRealBundledHostAdmissionReconnectCompletionAndCancellation` builds the
packaged coding host, parks a plan on approval, stops the host, admits the
approval while offline, and checks completion after restart using the **same** state
directory. It uses a scripted model provider. It does not exercise missing-box
replacement or establish that an in-run approval survives lost storage.

## Lost box

Cross-box recovery remains tracked in
[#1868](https://github.com/smithersai/smithers/issues/1868), dependent on the
trusted shared journal composition in
[#2099](https://github.com/smithersai/smithers/issues/2099). The repository host
currently opens local Control and engine stores. Product approval delivery is
durable in PostgreSQL, but its opaque decision cannot restore a lost Control
approval token, engine journal, or artifact.

Do not recreate an empty box and report recovery. Do not inject backend database
credentials into a repository-executing host; catalog validation refuses them.
Copying a local database and advancing a generation in the copy does not fence
the original database's owner.

The shared composition must retain both stores and referenced artifacts,
authorize the original approval, and fence the old executor before a replacement
becomes ready. Recovery must retain the original run identity and trace and
record a replacement receipt. Intentional deletion must remain distinct from
an unavailable placement.

The remaining acceptance crosses the canonical workspace runtime: park an
executing run on approval, lose its placement, durably admit the original
decision during the outage, and recover on a replacement. Assert the same run
and trace prefix, one completed post-approval effect, duplicate-decision
idempotency, old-owner refusal, and a durable recovery receipt. An explicit
recoverable failure is acceptable only with a successful one-action resume.
Repeat with intentional deletion and assert that no replacement is created.
