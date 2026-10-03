---
title: "TODOs"
description: "The TODO object: its states, routes, events, item branches and live topics."
---

A TODO is one item on the repository's stack: one change, one branch and one
pull request. Each TODO has a number `T<n>`, counted per repository from T1,
append-only prompt revisions and a stored state. GitHub's `#n` stays the name
of issues and pull requests.

## States

| State | Meaning |
| --- | --- |
| `queued` | Placed on the stack, waiting for a machine. |
| `starting` | A machine was granted; the runtime has not reported its first step. |
| `working` | The run is working. `step` names the phase. |
| `needs_you` | The run waits on a person: a question, an approval, a conflict, a moved-off file or an outside push. |
| `paused` | Stopped at a durable boundary; the run continues on Resume. |
| `failed` | The run failed. `failure` holds `{step, class, message, retryable}`. |
| `in_review` | The pull request is open with the verified change. |
| `merged` | GitHub merged the pull request and `main` contains it. |
| `dropped` | Dropped in Smithers, or the pull request closed unmerged. `state_reason` keeps the cause. |

One function, `Transition`, decides every state change against the transition
table of the spec. A change it refuses answers `409` with the code
`todo_transition_refused`. A change it allows appends one `todo_events` row
with its trigger, its actor and its cause, so every state shown has an event.
A merge or a drop records cancellation of every pending launch bound to the
TODO, settles every open wait and clears `needs_you`, `paused_at` and the merge fence `merging` in the
same transaction. The dispatcher delivers the cancellation to the runtime
after commit.

The stack engine's work record, `mythical_items`, projects onto the TODO state
in the same transaction as every item write. A terminal item state wins:
`landed` projects `merged`, and `cancelled`, `rejected` and `declined` project
`dropped`. Non-terminal item updates cannot reopen a merged TODO.

## Routes

An install serves one repository, so the routes name none. A server with
several stacks takes `repo=owner/name` on each route.

| Route | Effect |
| --- | --- |
| `POST /api/todos` | Places a TODO at the end of the stack for the signed-in member. Body `{title, prompt?, acceptance?, place?}`; `prompt` defaults to the title and `place` is `append`. Answers `202 {state: "requested", todo}`. |
| `GET /api/todos` | The TODOs in stack order: the unmerged ones with their `place`, then the merged and dropped ones. |
| `GET /api/todos/{n}` | One TODO with its prompt revisions. `{n}` is `12` or `T12`. |
| `GET /api/branches/{b}/activity` | The branch's newest 200 activity entries, oldest first. `{b}` is the branch id. |

`POST /api/todos` requires an `Idempotency-Key` header of 1 to 128 letters,
digits or `. _ : -`. The same key from the same member answers the TODO the
first request made. The same key with another body answers `409
idempotency_conflict`. Only a member of the install makes a TODO, and a TODO
made in Smithers opens no GitHub issue.

## Item branches

Each TODO has one item branch, `smithers/<slug>`. The slug comes from the
title: lowercase ASCII letters and digits joined by hyphens, at most 48
characters, with `-2`, `-3` and so on when the name is taken. The pull
request's GitHub branch is recorded once, in `todos.github_branch`.

## Live topics

Every TODO change writes a `projection_events` row for `todo:<n>` (the card,
with the events of the change) and one for `home` (the stack item) in the same
transaction, then a `NOTIFY live` hint containing `{repository_id, topic}` on commit. A rolled-back change
writes no row and sends no notification. Storage, reads and sequences are keyed by `(repository_id, topic)`; repository 0 holds install topics. Each topic's `seq` is gap-free and in
commit order. Retention keeps a topic's rows of the last 24 hours or its newest
10,000, whichever is larger.

An agent step the runtime reports appends a `step` entry to the branch's
activity and its `branch:<id>:activity` topic, once per journal event.
History writes keep the system `actor` and the member who requested the
change in `asked_by` separately.

`GET /api/todos/{n}` reads the TODO, revisions and event sequence in one
repeatable-read snapshot. List rows include their revision counts, event
sequences, branches and positions in one query.
