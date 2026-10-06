---
title: "TODO steering and amendments"
description: "The install's TODO feedback routes, transaction boundaries, delivery receipts and activation requirements."
---

## Availability

The install mounts both routes below. Steering and amendment execution remain
disabled by `MythicalService.todoSteering` until ordered input consumption and
pinned guest execution have passing acceptance evidence. A valid authorized
request currently returns `503 infra/todo_control_unavailable` without a
revision, activity event or delivery intent. Binding a launcher alone does not
enable either operation.

Activation requires T-STK-01/02/05/12, T-FLW-11, T-MCH-14, T-INS-02,
T-FLW-01, T-SEC-01, T-CAT-01 and T-ACC-03. Delegation also requires T-ACC-04;
delegated Amend requires T-APP-04. Repository code executes only in the
qualified guest, never on the host or as root through this admission path.

The API source is [todos.yaml](../../../docs/api/openapi/todos.yaml). The
generated Go and TypeScript clients expose `PatchAPITodosN` and
`patchApiTodosN` respectively. The routes are install-only.

## Requests and authority

Both routes require `Idempotency-Key` containing 1 to 256 bytes. The route
derives repository and member from authentication; JSON cannot select them.
The service rechecks current membership inside the product transaction,
including after acquiring the stack lock. A removed or suspended member
cannot admit or replay feedback.

| Operation              | Request body                                                                    | Successful admission                                  |
| ---------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `POST /api/todos/{n}`  | `{"steer":"Keep the public method name"}`                                       | `202 {"state":"accepted","attempt":1}`                |
| `PATCH /api/todos/{n}` | `{"prompt":"Add cancellation","acceptance":["Cancellation closes the worker"]}` | `202 {"state":"accepted","n":12,"rev":2,"attempt":1}` |

Numbers in these receipts are examples. `attempt` is omitted when zero. A
202 receipt establishes committed admission, not model consumption or run
completion. The app keeps progress open until the corresponding live TODO
receipt arrives.

An amendment accepts only `prompt` and optional `acceptance`, an array of
strings. The prompt must contain non-whitespace text. The prompt plus formatted
acceptance criteria must fit 24,576 UTF-8 bytes. The handler bounds JSON to
256 KiB and refuses unknown fields and multiple JSON documents. Draft-only
metadata such as title, placement and issue linkage is not a PATCH payload.

Active owners, maintainers and members may reach these operations with their
browser session. A stage-1 terminal credential may steer only its own branch's
TODO. Its amendment request returns `503 infra/confirmation_unavailable`
before any subject read or mutation. Other token, run and machine credentials
do not gain amendment authority. The shared confirmation provider must be
integrated before delegated amendments can execute.

## Committed feedback

`admitTodoFeedback` is the shared service path. Under the stack lock it saves
the input in `checks.Steers` and records `todo.steer_received` in the existing
product jobs store. An amendment also appends one entry to `revisions`, records
`todo.amended`, and invalidates affected later verification through the
existing prefix calculation. It allocates no TODO number, branch or PR.

The feedback entry links to the amendment's revision. Repeating an admitted
request with the same authenticated credential returns that revision without
another event or delivery. Reuse for another TODO, prompt, acceptance array or
operation returns `409 conflict/idempotency_mismatch`. Creation, Merge, Steer,
Amend, Retry, Drop and Move share the existing request lookup and repository
request lock.

A replacement browser session or terminal credential starts a separate
authorized request even for the same member and key. The server derives the
identity from the stored session or token and its binding; attribution headers
cannot change it. Historical feedback without a credential identity stays
readable, but replay of its key refuses rather than inferring authority from
its author. Confirmation creation and approval still need joint validation
with the shared confirmation provider.

For an already-launched, bound attempt, the same transaction calls
`flowdispatch.SteerInTx`. Its stable input ID becomes the runtime Message ID.
The existing jobs worker retries delivery after interruption or a lost
acknowledgment; it does not allocate a second input ID.

| State at admission or delivery       | Behavior                                                                       |
| ------------------------------------ | ------------------------------------------------------------------------------ |
| Live, attached attempt               | Deliver to its existing run and working copy.                                  |
| Open question                        | Keep the question open; feedback is a Message, not its answer.                 |
| Paused or still attaching            | Retain the intent; delivery waits for the lifecycle hold to clear.             |
| Merge fence                          | Hold Steer; refuse a new Amend with `409 merging`.                             |
| Merged or dropped                    | Refuse new admission with `409 todo_closed`; do not deliver retained feedback. |
| Queued or next attempt without a run | Persist feedback; ordered attachment handoff remains unqualified.              |

Delivery rechecks the stored input, attempt, working copy, stack owner and
author's current membership before wake and again before sending. Releasing a
held input clears stale candidate verification and merge consent once, inside
the product transaction. Replayed delivery cannot repeatedly clear a newer
candidate. Person and delegated attribution travel separately from the
runtime's authenticated principal.

## Remaining acceptance work

The production gate must remain closed until all of these are proved through
the served routes and canonical command dispatcher:

- The shared catalog and confirmation path preserve authority, exact payload,
  request identity and the person's approval before a delegated amendment.
- Inputs received before run attachment join live Answer and Steer in one
  committed order, without duplicating initial launch feedback or losing text.
  The current launch payload aggregates historical feedback into a bounded
  string; that is not an ordered-consumption receipt.
- A real pinned guest with a scripted model consumes every input committed
  before dispatch at its next model call, including during a blocked step and
  an open question, on the same run and working copy.
- Missing providers, revocation, pause, merge fencing, restart and lost
  acknowledgment preserve the required refusal, hold and exactly-once effects.

Selected PostgreSQL, recording-host, route, app and generated-client tests
cover the implemented boundaries. They do not satisfy the guest journeys in
[T-STK-06](../../../.specs/engineering/tickets/T-STK-06.md) or establish that
the complete specification is implemented.

## Stop, Resume, Retry and Drop

T-STK-05 supplies the control boundary for `POST /api/todos/{n}`. The install
mounts and authorizes the route; each control dispatches to its own service.
Retry, Drop and Move have handlers. Stop, Resume and Retry with the current
flow return `503 infra/todo_control_unavailable` before effects because their
handlers are not registered.

The request carries `Idempotency-Key` and JSON `{op, steer?}`. `op` is `stop`,
`resume`, `retry`, `retry-current-flow` or `drop`. Only the two retries accept a
steer. The browser retains the request and its key until a committed projection
receipt arrives; HTTP acceptance alone never completes the toast.

Retry, Drop and Move recheck current authority after waiting for the repository
and stack locks. A repeated request from the same authenticated session returns
its original receipt; another operation, TODO, direction or Retry text with
that key returns `409 conflict/idempotency_mismatch`. A replacement session has
its own request scope. Replay identity, validated input and the original receipt
are private metadata on the existing product request, committed atomically
with the state change and activity. Activity events contain none of that replay
metadata. Historical controls without a recorded credential remain readable;
their keys cannot authorize replay.

Stop requires an executing run and no question or approval; branch waits do
not refuse Stop. Resume requires the committed pause fact. Both retries require
a blocked item, even when an independent wait makes the card show Needs you.
Terminal items refuse every control. The item's merge fence (`pending_op`
of kind `merge`) refuses every control with `409 merging`.

The historical `/mythical/items/{id}/retry` route and `history.retry` command
are removed. Old recorded cards remain decodable. The former CAS helper stays
private in the stack service for the durable-attempt migration; it is not a
served control. It accepts chat-origin items through the same version CAS and
person-only typed-stop guard. Re-applying the TODO label does not lift a failed
attempt's bounds. Legacy planner declines now block with `factory/no_proposal`
instead of settling the item as dropped; existing declined records still decode.
The PR-close primitive uses a narrowly scoped installation
token and must be called only through persisted outbound intent/recovery after
cancellation, final capture and the merge fence settle.

No root operation or host-process execution fallback is added. Completing
Stop/Resume and qualifying restored-input execution still requires their
production PostgreSQL/microVM boundary receipts.

## Place and Move

A TODO's place is `mythical_items.stack_position` among the items still on the
stack (not landed, dropped, rejected or declined). The stack admits queued
TODOs, builds each candidate on its prefix and merges in place order.

`POST /api/todos` with `place: {mode: "before", n}` takes TODO n's place: n
and every later item move one place later, in the filing transaction, under
the repository's placement lock (`pg_advisory_xact_lock` on the repository id,
the lock the numbering trigger takes). Before a TODO that is not on the stack
is `400 invalid_place`; Before a merging TODO is `409 merging`. The
`todo.created` fact names the place and the TODO it went before.

`POST /api/todos/{n}` with `{op: "move", direction: "up" | "down"}` swaps n
with the nearest item still on the stack above or below it, failed items
included, and answers `202 {state: "accepted", place}`. It takes the
placement lock, then the stack's row, then every item row on the stack. The
first item moving up or the last moving down is `409 conflict`; a merging
TODO or neighbor is `409 merging`. The same `Idempotency-Key` answers the
same move again; one `todo.moved` fact records each move. Both placements
move the version of every item whose place changed, so a stack pass that read
the old order cannot launch or save over the new one.

A move changes which verified candidates form a later item's prefix. Each
item whose verified candidate was built on its old prefix and whose prefix
changed loses its verification in the move's transaction and waits in
`integrating` with reason `rebase_pending`; its candidate stays, and the
stack rebases it onto the new prefix. A new TODO filed Before has no
verified candidate, so it changes no prefix until it is verified.

## Questions and answers

A TODO's bound run asks a person through a HumanTask `ask` (for example
planning's `coding-clarification`). The control run summary reports the park in
`pendingWaits`; `ProjectFlowRuntime` opens one `question` wait per park in the
item's `checks.waits`, keyed by the parked execution and its durable token, and
the TODO shows Needs you. A question the run stops reporting, and every question
of a run that ended, is withdrawn unanswered. An in-run approval of the agent's
own `ask` has no wait point to signal and is not projected.

`POST /api/todos/{n}/answer` with `{wait, answer}` settles the question. Under
the stack row lock the first answer wins: it records the person, the answer and
a `todo.answered` fact, and admits `flowdispatch.SignalInTx` naming the wait
point with the answer as its payload, all in one transaction. The dispatcher
delivers it to the same run, which continues on the same working copy. The
same person's same answer again answers `202`; any other answer to a settled
question is `409` with `answered_by`. A steer never settles a question. The card
lists an open question with its `todo.answer` action and the latest answer as
`first_answer`.

## Pull requests

An install publishes a TODO's verified candidate through its own GitHub App.
The first publication records the TODO's branch, `smithers/<slug>`: the title's
letters and digits folded to ASCII, lowercased and joined by hyphens, at most
48 characters, with the TODO number appended when another TODO holds the slug.
The head is one commit on `main` with the candidate's tree. The host records
the push intent, reads the branch on GitHub, then pushes with a lease on the
recorded head, or on no branch for a first push. It pushes only to the TODO's
recorded branch, whatever a stored intent names: the App's token could write
any branch, `main` included. A lost push response is settled by reading the
branch, never by a second push.

The pull request targets `main`. Only the first unsettled TODO opens ready for
review. Later TODOs open as drafts on public repositories; on a private
repository they open ready, titled `[waits for Tn]` and labeled
`smithers:waiting`. A TODO shows In review only after GitHub returns its pull
request and, where it is due, the label is on it; a refused label write is
retried, and the pull request is never opened twice. The card's draft flag is
GitHub's as last read, and its `included_items` are the earlier TODOs the body
includes, then the TODO itself. Smithers opens pull requests; it never
approves or merges one.

Every write first checks the install's App and its installation on the
repository, the stack's lease, the installation's GitHub budget, the TODO
person's membership, the operation's authorization, and the TODO's current
version and verified candidate. A refusal records no intent and writes nothing
to GitHub. A branch head that is neither the recorded head nor the head being
published is a person's push, whether it is found before the push or while
settling one whose answer was lost: the intent settles as a conflict, the head
is kept as the TODO's foreign head, the TODO's issue, if it has one, is told
once, and publication stays held. A merge is authorized only by a person's
browser session (the one check `RequireMergeSession` also uses) or by the
merge request such a session recorded. Plue's composition publishes no TODO
pull requests.

## Browser-session Merge

`POST /api/todos/{n}/merge` (install) and
`POST /api/repos/{owner}/{repo}/mythical/items/{id}/merge` take
`{reviewed_head_sha}` and an `Idempotency-Key`, and share one service path in
one order. A TODO filed through `POST /api/todos` merges like an issue TODO.

1. Credential, before any read, and on the repository door before the
   repository is resolved, so both doors answer alike: no credential is
   `401 unauthenticated`; a request an in-app agent makes with the person's
   session (header `Smithers-Via`) is `403 never` ("Only a person can do
   this"); a token, a run's or machine's credential and an agent account are
   `403 permission`. Only a person's own browser session continues.
2. The person's standing, before the request's fields or the TODO are read:
   the session is live under its stored key (`401 unauthenticated`
   otherwise, including a session filed before keys were hashed at rest and a
   suspended, inactive or deleted person) and its person is the install owner
   or a maintainer on its roster (`403 permission`).
3. A malformed SHA is `400 invalid_reviewed_head_sha` (hexadecimal is
   lowercased); a missing key is `400 idempotency_key_required`. Then the TODO:
   `400 invalid_todo` for a malformed number or id, `404 todo_not_found` for
   none.
4. The whole authority rule, applied here and again at dispatch: the standing
   above, their GitHub account one the policy names and GitHub counts a
   maintainer, read from GitHub now and never remembered (`403 permission`),
   then the standing again. A press dispatch would refuse is never accepted.
5. The same key from the same session for the same TODO and head is the same
   request and records nothing: it answers `202` while its approval stands or
   after the merge, and `409` with the retained code, class and words once its
   approval was refused or expired. The key used for another head, another
   TODO or a filed TODO is `409 idempotency_mismatch`. A renewed approval needs a new key. The
   identities are kept on the TODO (`checks.mergeRequests`), the one record
   `POST /api/todos` uses too.
6. `MergeReady`'s PostgreSQL rows refuse with `409`: `state` (not a TODO in
   review, PR closed, open wait, paused, foreign push), `order` (`Merges after
   Tn`), `merging` (a merge fence is set), `rechecking` (another GitHub write
   such as the PR push is pending, or no accepted head) and `stale_head` with
   `current_head_sha`, which never replaces the reviewed head.
7. GitHub's pull request, read now: unreadable is `409 rechecking` ("Waiting
   for fresh GitHub merge facts"); closed, or based on anything but `main`,
   is `409 state`; a head GitHub moved is `409 stale_head` with GitHub's head.
8. One transaction takes the repository's request lock and the stack row,
   decides the repeat and the rows again, requires every outbound guard and
   the merge decision and transport (`409 rechecking` without them), and
   records `checks.Land {by, account, generation, session, head, at, request}` with the
   merge fence: `pending_op {kind: merge, target: <PR>, desired: <head>,
   precondition: open, state: intended}`. The answer is
   `202 {state: accepted}`.

The claimed stack worker settles the fence through the outbound providers.
`MergeDecision` rechecks the approval (a new generation voids it), the
PostgreSQL rows, then GitHub's live pull request (open, based on `main`, at
the reviewed head), required checks (first failing by name; a `main` without
classic protection, GitHub's `404 Branch not protected`, has none, and an
unreadable protection is never taken for none), required reviews (GitHub's
`reviewDecision`; unmet is `409 review_required`), draft state and
mergeability. While GitHub is still computing mergeability it reads the PR
once more after 2 s and evaluates every live row again. Then, after those
reads, it applies the authority rule again, so a demotion on GitHub or a
sign-out while GitHub was read sends nothing, and reads the pull request's
base and head once more. The App's send then resolves the merge's GitHub
destination and mints its token, so a failed lookup or mint records nothing as
sent.

The claim follows in one transaction. It first takes every lock it needs, in
the install's one lock order: the repository's row; the stack's row, then the
TODO's (every stack writer takes them in this order, the run projection
included); the `users` rows of the approver and of the repository's owner;
then each other row it reads in table-name order, the order account erasure
deletes in: the approver's session, the App's row, the repository's App
installation rows, its GitHub sources, the approver's linked GitHub accounts,
the owning organization and its members, the repository's GitHub connections,
and last the install owner. A repository's deletion takes its row first,
erasure takes the `users` row first, and every other writer of these rows
writes one of them. PostgreSQL ends any cycle a writer outside this order
makes by aborting one transaction: an aborted claim records nothing and sends
nothing, and the next pass decides again. Under those locks the claim reads
every local fact again: the TODO row (its save is a version check), the
session, the person, the install owner, the linked GitHub account against the
approval's account, and the repository's GitHub binding (destination,
installation, App, stack account) against the one the merge was prepared for.
It reads the factory's policy again from the repository host, which
PostgreSQL cannot lock. Only then does it read the time, for the approval's
age, the session's expiry and the age of GitHub's facts: GitHub's permission,
head, base, checks and reviews cannot be locked, so a claim more than 5 s
after the decision's last read of GitHub sends nothing, and the next pass
reads GitHub again. Then it records the slot `unknown`: a send is recorded
before the request leaves. A revocation, an expiry or a binding change that
comes before the claim sends nothing; a writer of a locked row after it waits
for the claim, and a row inserted after it orders after the claim.

Only the request follows the claim. It sends the one squash merge
with `sha` = the reviewed head, a token holding only `contents:write`, and a
commit title and message rendered from the TODO Smithers holds
(`<title> (#<PR>)`, `TODO T<n>, reviewed at <head>.`), never the pull
request's title or body as edited on GitHub; closing keywords and CI-skip
directives (`[skip ci]`, `[ci skip]`, `[no ci]`, `[skip actions]`,
`[actions skip]`, `skip-checks: true`) in the title are made plain. GitHub
answering 405 because the pull request is already merged is no refusal.

A sent merge is never sent again, nor is one whose claim committed before the
worker stopped. Lookup alone settles it: merged into `main`, it lands once
`main` contains the merge commit; closed, or at another head the sha-bound
request can no longer merge, its fence clears with that refusal; still open at
the reviewed head, it stays `merging`, whatever the approval's age or its
approver's standing, until GitHub shows one of those. Closing the pull request
or pushing to it on GitHub is how a person ends one that never completes.

A definitive refusal clears the fence and stays on `checks.Land.refused`: a
recheck's, or GitHub refusing the merge (`401`, `403`, `404`, `405`, `409`,
`422`, its text verbatim) once GitHub reports the PR not merged. Before any
send, a guard or GitHub failure that settles nothing clears the fence at once
when the approver's standing is gone; otherwise it waits for the next pass,
and a merge never sent is not sent once 10 minutes have passed since its
approval, checked against the time at the claim: the fence clears with "The
merge did not complete within 10 minutes; press Merge again". The card's merge block shows each refusal, and
nothing retries it until the person presses Merge again. The TODO card's
`merge` is `done`, `merging`, `blocked` with a refusal, `waiting` with the
first failing row, or `ready`. A refusal of the approving person (session
ended, no longer a maintainer) blocks no one else's press: the block stays
`ready` with that refusal as its `detail`.

Retarget race, an accepted residual risk (lead's ruling, spec §10.6.2b):
GitHub's merge API takes a head precondition (`sha`) and no base
precondition, so no client check can close the window between the last base
read and the merge request. Retargeting requires write access to the
repository, and a person with that access can already put the same commit on
that branch directly; a protected target branch enforces its own rules on the
App's merge; `main` is never affected, and the TODO is never shown Merged
without `main` containing the commit. The race is bounded: the base is read
at the press and again immediately before the claim (one round trip); a sent
merge GitHub reports merged into another branch clears its fence with the
receipt "GitHub merged the pull request into <branch>, not main", the TODO
closes as a pull request closed on GitHub does (never Merged, and later TODOs
are not held behind it); and the owner's log records `mythical.merge_off_main`
with the branch.

Known gap: until T-GH-03 syncs GitHub's check and review facts, `ready` rests
on the PostgreSQL rows; a red required check or an unmet review shows only
after dispatch refuses it.

The install composition (`EnableTodoPublication`) installs the outbound
guards, `MergeDecision`, the merge's preparation (`PrepareMerge`) and the
merge kind of the App's lookup and settlement together. A composition without them, such as Plue's, refuses the
route `409 rechecking` before any approval. C-J1-04 remains incomplete.

## Parallel setting (dark)

`install_settings.parallel` stores the owner's requested integer, 1–8. The
capacity service projects requested and effective values separately; effective
is `min(requested, capacity)`, including zero. Only an absent saved value uses
`max(1, capacity − 1)`. The forward migration preserves a single legacy stack's
value and never overwrites an install value. Multiple legacy stacks are not a
single-repository install and are not arbitrarily selected by the migration.

Settings retains the request even above capacity; Home can represent effective
zero. The old repository config write and `history.parallel` door are removed.
The install write remains unmounted, and the service refuses writes without the
shared authorization/catalog provider. On an install a fresh TODO attempt
launches `coding/request` on its own lane (`EnableTodoAdmission`); hosted
composition refuses it. Ordered runtime demands, holder release accounting and
live queue positions require the ordering, scheduler and machine-execution
providers and C-STK-02.
No admission queue, root operation or host execution fallback is added.
