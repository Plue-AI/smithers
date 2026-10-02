# ADR 0004 — Review (Critique) on the change card (2026-09-02)

Source: will's row-6 ask relayed by plue-0c. Builds on ADR 0003. Review is
the Review facet of the `change` card plus three lines on its header; no new
card. Every act is a flow; verdicts are user-only for humans; the agent's
verdict is a review row, never a human's approval.

MVP amendment (2026-10-01, [#3388](https://github.com/smithersai/smithers/issues/3388)):
review executes as an ordinary flow in `flows/review`; the standalone service
and quizzes are retired. The shared run card renders custom flow results.

## Header additions

```
┌ qupxosqw · rev 5 of 5 · 2 of 3 on feature-x ──── ○ OPEN · turn: agent ┐
│ …                                                                       │
│ review  agent LGTM at rev 5 (low confidence) · will approved at rev 4   │
│         · 1 revision since · 2 threads open                             │
│ landing when green · waiting on: typecheck (plue), 2 open threads       │
│ Walkthrough  Diff  Findings  Checks  Review  History                     │
│                     Land   Land when green   Request review   ⤢         │
└─────────────────────────────────────────────────────────────────────────┘
```

- `turn: agent | will` on the header pill row. A human comment flips it to
  the agent author and dispatches; a new agent revision flips it back.
- The review line names the three bits as rows of one strip: agent LGTM
  (verdict word plus a confidence WORD, never a number: DESIGN.md forbids
  user-facing scores), human approval with its revision and revisions since,
  and `owners · not available` until OWNERS exists.
- `landing when green` is a state line, present only after the intent is
  set, listing exactly what it waits on.
- `Walkthrough` leads the facet strip when the current revision's source is
  an agent session and the change touches more than 20 files; otherwise it
  sits after History. It renders the review story (sections and diagrams) inside the card; maximize gives the full story.

## Review facet

```
│ since your review at rev 3 → rev 5   [ show all ▾ ]                     │
│ ─────────────────────────────────────────────────────────────────────── │
│ agent · LGTM at rev 5 · low confidence · "Bounded reads hold; see F-2"  │
│ will  · approved at rev 4 · 1 revision since                            │
│ owners · not available                                                  │
│ ─────────────────────────────────────────────────────────────────────── │
│ ○ apps/app/src/bun/RepoFiles.ts:92 · will · rev 4                        │
│   "error bodies leak the absolute path"          2 replies   [ Done ]   │
│ ◐ apps/app/src/bun/server.ts:208 · agent · rev 5 · done at rev 5         │
│   "strip the local session header"               1 reply    [ Ack ]    │
│ ● packages/rpc/src/LocalApp.ts:250 · will · rev 3 · stale                │
│   "cap the listing"                              resolved · Show at rev 3│
│ Suggested reviewers · none yet (ownership not available)               │
```

- **Diff since my last review.** The facet opens with the diff pinned
  `rev <last reviewed by you> → rev current` and says so in the first line;
  "show all" returns to `parent → current`. The same default applies to the
  agent reviewer's run input. `last_reviewed_seq` is a SERVER field per
  reviewer per change, because agents review too.
- **Thread states.** `○ open` (anyone may reply), `◐ done` (the author
  pressed Done; records `resolved_in_revision`), `● resolved` (the
  reviewer pressed Ack). Done and Ack are one click each; Ack is the
  reviewer's, Done the author's; Reopen is available to either. The landing
  gate refuses with open or done-but-unacked threads and the Land button
  says `2 threads open`.
- **Verdicts.** `review.approve` and `review.request-changes` are user-only
  flows; a person's current `request-changes` blocks landing for everyone
  until that person approves later or the review is dismissed (by that
  person, or a repository admin who is not the author)
  (D-21); an agent's does not. The agent's LGTM arrives
  from `review.ask` as a `reviewer_kind: agent` row with verdict, confidence
  word, and one sentence. The gate may require one agent LGTM plus one human
  approval; the Land button names the missing bit.
- **Suggested reviewers.** A slot at the foot of the facet and inside the
  Request review picker; empty with the stated reason until OWNERS and file
  familiarity exist. Nothing is guessed.

## Findings actions

Rows gain exactly two actions: `Please fix` (confirm; dispatches the agent on
that one finding, a run card follows) and `Not useful` (records feedback,
the row dims and reads `not useful`). `findings.mute` is retired.

## History additions

A landed change's History gains one row: `landed · rev 5 · approved by will
· landed by <actor> · <time>`. The non-author human reviewer is always
named there.

## Coverage

| Feature | Status |
| --- | --- |
| 1 Diff since last review | UI in this lane; needs #450, #451, `last_reviewed_seq` |
| 2 Turn tracking | UI wants it; needs `turn` on the landing request + dispatch-on-turn |
| 3 Blocking reviews, Done/Ack | UI in this lane; needs thread states + gate |
| 4 Three bits | Human approval exists; agent LGTM row + gate policy needed; owners slot empty |
| 5 Please fix / Not useful | UI relabel; Not useful needs #454 |
| 6 Land when green | UI in this lane; needs auto-land intent |
| 7 Reviewer suggestion | Slot only; backend later |
| 8 Non-author reviewer on landed change | UI in History; needs approver on the change GET |
| Walkthrough facet | UI in this lane; needs a walkthrough artifact route |

## Flows added or changed

`review.since-mine <changeId>` (opens the facet at the delta), `review.done
<threadId>`, `review.ack <threadId>`, `review.reopen <threadId>`,
`change.land-when-green <changeId>` (confirm) and `change.cancel-auto-land`,
`findings.please-fix <findingId>` (confirm), `findings.not-useful
<findingId>`, `change.walkthrough <changeId> [rev]`.

## Filed (plue, 2026-09-02)

Epic #466: #459 reviews[] with reviewer_kind, verdict, confidence_bucket, last_reviewed_seq; #460 turn + dispatch-on-turn; #461 thread states and gate; #462 agent LGTM + protected-bookmark policy; #463 auto-land intent; #464 landed provenance; #465 walkthrough artifact + SSE event.

## Row 10 — Owners (shapes from plue, 2026-09-02)

On the change GET: `owners { touched_paths[] { path, owners[] { login | team },
agent_policy: auto-land|human-approve|deny, satisfied_by? { login, seq } },
missing_approvals[] { path, candidates[] } }`; on the landing request
`blocked_by { kind: owner, path, candidates[] }`.

UI: the Owners facet replaces `owners · not available` once the field
exists. Rows per touched path: the rule's owners, the policy word, and
`approved by <login> at rev N` or `missing · ask <candidates>` with a
Request review action bound to `review.request <changeId> <login>`. The
header strip's third row reads `owners ✓` or `owners · 2 paths missing`. A
`deny` policy renders on the header as `owners · agent changes denied on
<path>` and on the Land button as the blocking reason. The Suggested
reviewers slot fills from `missing_approvals[].candidates`. Teams render
by name with no member expansion.
