# ADR 0003 — The Change is the unit (2026-09-02)

Source: will's row-5 ask relayed by the plue backend session; backend facts
as stated there. Laws: EMBED LAW, NO INVENTION, frames, flows for every act.

## Position

A change is a document with revisions. The change id is the document; each
revision is a commit; everything else (checks, findings, comments, verdicts,
provenance) is pinned to a revision and goes stale by revision, never by
time. The UI therefore has one pin everywhere, `changeId#rev (commit)`, and
one verb for staleness, "at rev N". A branch is a stack of these documents; a
changeset is one document whose files span repositories.

Falsifiable: every question below is answered by a facet of one `change`
card plus one `stack` card and one `operations` card. No new frame kind, no
page. The falsifier is any interaction that needs a view the composer is not
mounted under.

## 1. The change card

Embedded, at a glance. Each line maps to one fact the brief names; nothing
else is rendered.

```
┌ qupxosqw · rev 5 of 5 · 2 of 3 on feature-x ──────────────── ○ OPEN ┐
│ Serve repository files through one bounded, confined route           │
│ smithersai/smithers  +312 −41    smithersai/plue  +18 −2              │
│ checks ✓ 5 ● 1 running   findings ▲ 2   review ✓ 1 approved · 1 pending│
│ conflict · apps/app/src/bun/server.ts · unresolved                     │
│ rev 5 · agent session a03f5f · snapshot s_8d1 · 2 min ago             │
│ Diff  Findings  Checks  Review  History                                │
│                                   Land   Request review   ⤢           │
└───────────────────────────────────────────────────────────────────────┘
```

Line by line: header = change id, revision N of M, stack position, landing
state pill. Description. Repos touched with stat (one entry per repo; one
repo is one entry, not a group header). Checks, findings, review as counts
at the CURRENT revision. Conflict line only when a conflict exists. Provenance
of the current revision: source (push, rebase, agent session), the session
and snapshot when present, age. Facet strip. Footer: Land (confirm; disabled
with the blocking reason), Request review, Revert (confirm; only on a landed
change), maximize.

Maximized: file list left, the active facet center, threads or history rail
right; composer stays mounted.

### Facets

- **Diff.** Header carries two revision pickers in mono:
  `parent ▾ → rev 5 ▾`. Default is change vs parent at the current revision,
  where "parent" is that revision's own recorded `parent_commit_id`, never
  the parent change's current commit. Picking `rev 3 → rev 5` is a jj
  INTERDIFF: rev 3 is rebased onto rev 5's parent before diffing, so a
  rebase between them contributes no files. `Show at rev 3` and Findings
  Open use the same base. Conflicted files lead the file
  list with an ember marker; a conflicted hunk shows the markers and one
  action, "Resolve with an agent" (confirm), which dispatches a run and
  renders the run card; the hunk reads "resolving · run r_…" until the next
  revision arrives.
- **Findings.** Grouped by analyzer; rows are severity, `path:line`, one
  sentence, and the revision they were raised at. A finding raised at an
  older revision than the current one reads `rev 3 · stale` in slate, stays
  visible, and clears only when analysis at the current revision does not
  raise it again. Actions: Open (diff at that line, pinned to the finding's
  revision), Fix (confirm; a run).
- **Checks.** Rows per check at a chosen revision (`rev 5 ▾` picker, default
  current): name, state, duration, Logs. A check that never ran at the
  current revision is `not run at rev 5`, never inherited from rev 4.
  Row 8 (CI) addition: each check row states its work, `12 affected · 4 ran
  · 8 cached · 12s`, so a fast green is legible as cache, not luck; a check
  that ran inside a workspace carries "Open the computer" (the same act as
  History) so a failure is inspected where it happened.
- **Review.** Verdict strip: each reviewer with the revision they judged,
  `will · approved at rev 4 · 1 revision since`. An approval at an older
  revision is still an approval; the "revisions since" count is the honesty.
  Threads: `path:line`, first comment, replies, open or resolved. A thread
  whose anchor no longer matches at the current revision reads
  `rev 3 · stale · Show at rev 3`; one whose line moved reads `moved`.
  Posting a comment pins it to the revision shown in the Diff facet, and
  so do Approve and Request changes: the verdict carries that revision's
  commit id, supplied by the client, never stamped by the server at
  processing time. The change card itself is LIVE (its header denominator
  is the newer-revision signal: `rev 5 of 6`); the `rev N exists · view`
  line belongs to snapshot cards (file, search, diff) only. The Land confirm
  names `changeId#rev · commit` and the server refuses a land whose commit
  no longer matches.
- **History.** One row per revision: `rev 4 · b775d9 · rebase · will ·
  3h ago`, `rev 5 · a03f5f · agent session a03f5f · snapshot s_8d1 · 2m
  ago`. Row actions: Diff to current (opens Diff with `rev 4 → rev 5`), Open
  the computer (fork the snapshot into a workspace and render the workspace
  card; only when a snapshot exists), Operations (expands the jj operations
  that produced this revision; see §4).

### How stale reads

Everywhere the same three tokens, in mono, in slate: `rev N` names where it
was made; `stale` means the current revision no longer matches it; `moved`
means the anchor was found at a new line. A stale item is never hidden and
never restyled beyond those tokens; its Open action shows it at its own
revision.

## 2. The stack

`stack` card. Rows newest first, like `jj log`; landing goes bottom-up, so
the landable set is a prefix from the bottom. The footer states the prefix.

```
┌ stack feature-x → main · 3 changes ───────────────────── 2 ready ┐
│ 3  ronvznsk  Add owners facet         ● typecheck   ○ 0 of 1     │
│ 2  qupxosqw  Serve repository files   ✓ 5           ✓ approved   │
│              smithersai/smithers · smithersai/plue                │
│ 1  yyyrqlqw  Shared contracts         ✓ 3           ✓ approved   │
│    main @ b775d9                                                  │
│                                  Land 2 ready (1 → 2)        ⤢    │
└──────────────────────────────────────────────────────────────────┘
```

Row: position, change id, title, checks glyph and count, review glyph. A
changeset row carries a second line naming its repositories; it is ONE row
because it lands atomically. Land reads as the prefix: `Land 2 ready
(1 → 2)`. When the bottom change is blocked: `Land blocked · 1 waits on
typecheck (plue)`. No per-row Land. The change card's Land on a mid-stack change lands the
prefix up to and including it (the confirm says `lands 1 → 2`); on the
bottom change it lands that change alone. A changeset lands whole;
`/change.split` moves one change's named paths into a new change (#2902
removed "Split ready members").

## 3. Revision pins

- **Origin chip.** `[ smithersai/smithers ▾ ]  ~/smithers · qupxosqw#5`. The
  working copy's current change and revision, or `head @ b775d9` with no
  copy active. A local commit that matches no pushed revision has no `#seq`:
  the chip reads `qupxosqw · a03f5f` (change id, commit under it), and a
  card read from it pins `{ changeId, commitId }` per ADR 0001; `rev 6
  exists · view` compares commit ids, so an unpushed local commit never
  claims a server revision.
- **Card headers.** File, search, diff, findings: `qupxosqw#5 · a03f5f`
  (change id and revision for humans, commit under it). When a newer
  revision exists: one mono line `rev 6 exists · view`. Head comparison is
  by commit id (ADR 0001).
- **Diff facet header.** `parent ▾ → rev 5 ▾`; `rev 3 ▾ → rev 5 ▾`.

## 4. Provenance and undo

- **Dispatch an agent to resolve this conflict.** Diff facet, conflicted
  hunk, confirm flow `change.resolve <changeId> <path>`; a run card appears;
  the resolution arrives as the next revision with source `agent session`.
- **Revert this landed change.** Footer action, confirm flow
  `change.revert <changeId>`; a new change card appears (description
  "Revert qupxosqw", trailer preserved) with its own landing request.
- **The operation log.** `operations` card: rows `op 3f2a · 2m ago · agent
  session a03f5f · rebase 3 changes onto main` with Undo (confirm) per row.
  Reached from a History row's Operations toggle (scoped to that revision)
  or `/change.ops <changeId>` (the whole change). Each op row names the
  workspace it ran in. Undo is disabled with `workspace gone` when that
  workspace no longer exists and `local operation · not undoable` for a
  `push` revision (a laptop's op log is not on the server). The confirm
  names the blast radius from a server dry run: `undo op 3f2a · affects 3
  changes · 2 later operations · conflicts: none`; a dry run that conflicts
  disables Undo with `would conflict`. Undo dispatches `change.undo <opId>`
  in the op's workspace, and every touched change's next revision reads
  `undo of op 3f2a`. Embedded, never full-screen.

## 5. Cards and frames

New cards: `change`, `diff`, `stack`, `operations`. `findings` exists as a
facet only.

Existing that change: `file` and `search-results` headers gain the revision
pin; `flow-run` gains a `producedRevision` line when a run pushes one;
`workspace` gains "forked from snapshot"; `issue` gains the change it
produced; the origin chip gains the change pin. No new frame kind; maximize
is the existing transition.

## Flows

| Flow | Args | Invokers | Confirm |
| --- | --- | --- | --- |
| `change.view` | `<changeId> [rev]` | user, agent | |
| `change.diff` | `<changeId> [from] [to] [path]` | user, agent | |
| `change.stack` | `[changeId\|bookmark]` | user, agent | |
| `change.land` | `<changeId\|stack>` | user, agent | yes |
| `change.resolve` | `<changeId> <path>` | user, agent | yes |
| `change.revert` | `<changeId>` | user, agent | yes |
| `change.ops` | `<changeId> [rev]` | user, agent | |
| `change.undo` | `<opId>` | user, agent | yes |
| `review.request` | `<changeId> [login]` | user, agent | |
| `findings.fix` | `<findingId>` | user, agent | yes (renamed `findings.please-fix` in ADR 0004) |
| `ci.logs` | `<changeId> <check> [rev]` | user, agent | |
| `change.history` | `<changeId>` | user, agent | |
| `review.*` | as ADR-WORKBENCH §3.3 | | verdicts user-only |
| `box.open --snapshot` | `<snapshotId>` | user, agent | yes (the History row button is the confirm's button) |

## Backend shapes needed beyond the stated facts

1. `GET /changes/{id}` with `revisions[]`: `{ seq, commit_id, source:
   push|rebase|agent|undo, agent_session_id?, workspace_snapshot_id?,
   operation_ids[], created_at }`, plus `current_seq`, `parent_change_id`,
   `conflicts[] { path, state }`, `stack { landing_request_id, position,
   size }`.
2. Interdiff: `GET /changes/{id}/diff?from=<seq|parent>&to=<seq>[&path=]`.
3. Landing request adds `landable_prefix` (count from the bottom) and per
   change `blocked_by { kind: check|review|conflict, name, repo }`.
4. Reviews and comments carry `commit_id`; threads carry `anchor_hash` and a
   server-computed `state: current|stale|moved` at the current revision.
5. Findings per revision: `GET /changes/{id}/findings?rev=`; the client
   marks stale by comparing seq.
6. `POST /changes/{id}/conflicts/resolve { path }` → agent session id.
7. `POST /changes/{id}/revert` → new change id + landing request id.
8. Operations: `GET /changes/{id}/operations[?rev=]` and
   `POST /workspaces/{id}/operations/{opId}/undo`.
9. Fork a workspace from a snapshot id (exists as fork + template; confirm
   one call does it).

## Filed (plue, 2026-09-02)

Epic #458: #450 revisions + change GET, #451 interdiff, #452 landable_prefix + blocked_by, #453 commit_id on reviews/comments + anchor state, #454 findings per revision + feedback, #455 conflict resolve via agent, #456 revert, #457 operations + undo. Shape 9 needs no new call: `POST …/workspaces` with `snapshot_id` forks from a snapshot.

## Changeset DTO (live in prod behind `feature_flags.changesets`, 2026-09-02)

Routes: `GET|POST /api/orgs/{org}/changesets`, `GET …/{id}`, `POST …/{id}/land`
(org membership; read:repository for GET, write:repository for create/land).

Changeset `{ id, organization, superproject, change_id, commit_id,
landed_commit_id, parent_change_ids[], target_bookmark, description,
state: pending|landing|landed|failed, failure_reason, created_at, landed_at,
members[] }`; member `{ repository_id, repository, path, change_id,
commit_id, target_bookmark, previous_commit_id, landed_commit_id }`. Create
`{ description, target_bookmark, parent_change_id?, members[] { repo,
change_id, target_bookmark? } }`. Land is synchronous: 200 with the landed
changeset; 409 on conflict or re-land with `failure_reason` on the row and
every member bookmark restored. No realtime event: poll GET.

UI consequences: the change card renders a changeset from its own state
until #452 lands. `failed` renders the ember line with `failure_reason`
verbatim under the header and a Retry land (confirm); `landing` disables
Land with "landing…". Member rows show `repository · path` (the path is the
mount under `/workspace/<org>/<repo>` in a materialized computer). Live
fixture: org `canary-changesets-e2e`, repos `cs-api`, `cs-web`.

## Until #450 lands (degraded rendering)

The change DTO today carries one `commit_id` and no revisions. Until
`revisions[]` exists: the header reads `qupxosqw · a03f5f` with no `rev N of
M`; the History facet lists the one known commit and reads `revision history
not recorded yet`; the Diff facet offers `parent → current` only; stale and
moved tokens do not render (nothing can be compared); verdicts and comments
show their commit id. Nothing is inferred from timestamps.

## Critique deltas (2026-09-02, adversarially verified)

Four confirmed findings folded in above: interdiff needs `parent_commit_id`
per revision and jj interdiff semantics; undo needs per-op `workspace_id`,
a server dry run, and blast-radius copy; a local working copy pins by
commit id, never by a server seq; forking a workspace from a snapshot is a
confirm act. Also folded: verdicts pin to the Diff facet's revision with a
client-supplied commit id; the change card is live and the header
denominator is its newer-revision signal; missing flows added (`review.
request`, `findings.fix`, `ci.logs`, `change.history`); Revert appears only
on a landed change; mid-stack Land and the Split action have a place.

