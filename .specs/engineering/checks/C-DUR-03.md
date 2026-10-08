# C-DUR-03 One pending GitHub operation per item survives restart

Proves: mvp.md §6.1 "Restart", §9 "Durability", §12 item 1 (restart mid-run, recovery receipts) · spec.md §3 (`pending_op`), §12.4.1, §19.1, §19.2 · Layer: fault · Stage: S1, S2 · Tickets: T-GH-09, T-FLW-09, T-REL-04
Automation: `packages/backend/internal/compose/github_outbound_kill_test.go` · Runs in: reference host with the packaged native writer, real PostgreSQL and githubfake

## Setup
Use production install composition, literal expected item rows, a canonical App identity and a bare remote. Prepare one item for each kind: push, open PR, body, merge, close PR. Enter through composed `stack.propose`, `todo.drop` and the merge route. Historical Linux receipts qualify these HTTP boundaries and the restarted production worker with guest observations adapted over a real checked checkout. The current packaged writer requires the reference machine; those receipts do not qualify the reference port.

## Steps
1. For every kind, stop the backend process group with SIGKILL before send, after potentially-sent commit, after remote success and before local settlement.
2. Restart on the same database and remote; record lookup, any repeat, item facts and pending_op.
3. Hold an open-PR response, Drop, restart and release the response.
4. Hold body v1, request v2; also race a push against a foreign head and close against a person's later reopen.
5. Recover a merge with revoked authority, stale head, missing approval or competing fence; repeat with GitHub already reporting merged.
6. Supply matching event/comment markers from a person, another App and the canonical App. Attempt machine-proxy mutations.

## Pass when
- One pending_op per item; no later operation overwrites or passes an uncertain slot. Every uncertain repeat follows lookup. The expected fixture state settles within 60 s.
- One effective PR, merge and close; push preserves a foreign head and reports conflict. Body v2 follows settled v1. A person's reopen is not undone.
- Drop closes a late-created PR once. Merge repeats only with its bound head, current maintainer authority and shared readiness; already merged settles without another PUT.
- Canonical App identity is required for marker/event settlement. Machine proxy mutations issue no token and make no upstream call.
- Labels, unlabels, comments and issue-close remain best-effort; comment retries use the existing marker. These are not queued writes.
- Recovery receipt and literal expected item state agree; no fabricated success or approval.

## Fail when
Any duplicate effective operation, blind repeat, foreign overwrite, unauthorized send or lost Drop obligation occurs.

## Evidence
Record fixture identity, commit, write log, before/after pending_op, lookup result, item state and recovery receipt for each case.

## Harness cases

`TestGitHubOutboundKillProductionProposal` retains the five-kind kill matrix and
late-open Drop case. Its additional production-caller cases map to steps 4–6:

| Step | Cases | Literal assertions |
| --- | --- | --- |
| 4 | `body-order` | Retain v1's unknown slot; post `Review: approve`, then `Review: request-changes`; two body writes and two settlement facts. |
| 4 | `push-foreign` | No recovery push; preserve the person's remote head; served TODO is `needs_you` with `foreign_push`. |
| 4 | `close-reopen` | One effective close; the person's reopened remote PR remains open. |
| 5 | `merge-revoked`, `merge-stale-head`, `merge-missing-approval` | No send without current authority, bound head and approval; preserve unknown uncertainty or clear a definitive refusal. Applied merges settle with one total PUT. |
| 5 | `merge-competing-fence` | A live competing stack claim preserves the slot and prevents sends; after release, lookup precedes recovery. |
| 6 | `close-{person,other-app,canonical}-event` | Person/other-App events do not settle a close; only the canonical App event settles without a PATCH. |
| 6 | `close-{person,other-app,canonical}-marker` | Matching spoof markers cannot be edited; one canonical comment is created and recovery edits it once. |
| 6 | Every crossing | Proxy POST/PUT/PATCH/DELETE return 403 before and after SIGKILL; no token mint, upstream lookup/write or slot change. |

Each reached crossing records `outbound-recovery.json` in its rehearsal evidence
directory with commit, pass/fail status, before slot, final item, recovery request
order and fake GitHub write log. A compiled or skipped test is not a passing
receipt. Reference qualification requires `SMITHERS_GITHUB_OUTBOUND_KILL=1` and
`SMITHERS_FAULT_HOST=reference`, using the packaged writer and real microVM.

`SMITHERS_GITHUB_OUTBOUND_LINUX=1` explicitly selects the existing Linux
rehearsal's file-writer fixture for supplemental HTTP/worker diagnostics. It
does not qualify the packaged writer, guest execution or this reference-host
check. Reserved `stack.propose` replays in this diagnostic must return 503:
production live candidate observation requires sandboxed execution. The slot
under test is created by the TODO's production publication worker before the
restart; the diagnostic asserts replay refusal preserves it and creates no work.
Reference runs still require 202 admission. Startup failures before a crossing
produce no kill-point receipt.

Restarted workers reopen the retained runtime state and compose its machine
registry, final capture, branch admission and pinned host manifest. Drop uses
the production cancellation/capture path before close. The HTTP listener and
configured install address remain unchanged across the restart, so retained
checkout receipts keep their bound Git origin. Reference workers use the
approved installed bundle and microVM runtime; Linux workers use the explicitly
selected process diagnostic with native capture, never claim guest isolation.
