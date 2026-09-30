---
title: "Landing verification"
description: "Exact candidate checks and final review before queue landing."
---

The host checks an archive of the prepared candidate before rebase, then checks
and reviews the final rebased candidate. A failed first check prevents rebase and
push. Export attributes cannot omit or substitute checked files. Both stages leave the shared checkout intact. Every changed path needs a verification route; empty
changes, empty affected selections, missing tools, and unknown ownership fail.

Smithers uses the candidate's local affected graph for non-Go changes, including
root scripts and documentation. It lists each path separately before executing
the combined CI selection without cached results. The candidate's Node and pnpm
pins must match; offline frozen installation links local packages in the archive.
Go changes run vet and tests from their nearest module. Module metadata and deleted Go packages select
the whole module. Helm changes run strict lint and template rendering from their
owning chart. Other repositories use owning package checks; unowned documentation
and executable files are quarantined rather than reported as checked.

Discovery, installation, and checks share a 15-minute deadline. Cancellation
kills the active process group. The landing runner owns a private snapshot parent
and removes it after forced cancellation, independently of inherited output pipes.
Process discovery and snapshot removal each have a five-second cleanup bound;
root process exit has a one-second bound.
Cleanup failures report the incomplete cleanup path; removal may finish later
after a timeout. Filesystem errors or a host crash can
leave snapshots for operator removal. Failures retain the last
4,000 bytes in the quarantine receipt and the full check log on the host.

A verified non-operator Claude subscription reviews the final rebased diff with
exact Fable (`claude-fable-5-1`) before push. Review discovers numeric
`claude-*` directories in `~/.smithers/accounts`, verifies OAuth identities,
and tries each distinct email once. Adding a subscription login needs no code change.
The operator email, `claude-4`, `claude-6`, default Claude directory, and directory
aliases are excluded. `BURNDOWN_EXCLUDE_EMAILS` and
`BURNDOWN_REVIEW_EXCLUDED_ACCOUNTS` add exclusions; `BURNDOWN_REVIEW_ACCOUNT`
selects an allowed discovered account to try first. Invalid preferences refuse review.
Structured CLI provider errors retry the next account within the same deadline;
Fable capacity is recorded separately from subscription and provider capacity.
Review text cannot trigger failover. Successful structured results must report only
the exact Fable model. User, project, and local settings are disabled for review. No model downgrade
or API-key fallback is allowed. Exhausted or unavailable accounts report `REVIEW_UNAVAILABLE` and block landing;
reset times are not inferred. Failed verdicts, malformed
identities, execution errors, and unrecognized output block landing.
The review receipt names the candidate SHA; the queue refuses
any SHA change after checks or review. Cloud artifact review alone is insufficient.
Review runs in an empty directory with a ten-minute deadline. Landing has a
45-minute overall deadline; cancellation stops the lock wrapper, shell, and
detached descendants before quarantine. The host freezes the process tree and
rescans until no new descendants appear before killing it; cleanup failures
remain in the failure receipt. Issue completion and release use the
fixed host claim tool. Every issue receipt is attempted; failures remain visible
even after push. Retries recognize commits already on main and retry receipts
without landing again. If the post-push fetch fails, the queue checks the remote
main reference directly before reporting success.

After a confirmed push, the queue rebases only the shared working copy onto the
landed main commit, preserving unrelated edits and existing long-lived bookmarks.
A failed realignment is retryable: replay recognizes the pushed bundle, repairs
the working copy, and retries receipts without a second push.

A working copy with bookmarks or descendants is refused before push rather than
rewriting those revisions. The queue requires an unbookmarked working-copy leaf; failed guard queries refuse landing.

Natural process exit drains output for at most one second and retains its exit
status even when an orphan holds the pipes. A descendant already reparented to
init can escape process discovery and survive; the runner bounds pipe settlement
but cannot guarantee termination of such a daemon.

The queue reconciles its managed main bookmark after fetch and rolls it back to
the tracking main after a rejected push. A later attempt can recover an
interrupted publication without moving other bookmarks. Verification and review
log tails go to stderr; full logs stay on disk. Only the host writes landing receipts to stdout.

Final review receives each current issue's title, body and all comments, the
worker report, both executed check logs, and the final diff. READY and historical
closure claims do not establish acceptance. The review emits a typed disposition
per issue: complete acceptance permits closure; a landed prerequisite stays open
with a concrete linked remaining condition. Missing, invented or contradictory
evidence cannot complete an issue. See [acceptance evidence](./acceptance.md).

Acceptance is saved atomically before push. The confirmed pushed bundle is saved
before checkout realignment or issue writes. Receipt failures retain the original
READY bundle for replay, including mixed completion dispositions, rather than
launching a coding repair. Replay verifies the current issue bodies and refuses
foreign claims before any issue mutation. Previously retained READY seeds need
no migration: their current issues are assessed when landing. An already-pushed
legacy bundle without acceptance evidence cannot close issues automatically.
