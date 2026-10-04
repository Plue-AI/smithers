---
title: "TODO steering and amendments"
description: "Transactional signal admission and the production activation boundary."
---

## Transactional admission

`flowdispatch.Service.SignalInTx` admits a signal through the existing jobs
store in the caller's PostgreSQL transaction. It shares validation, scope
binding, authorization context, reconciliation policy and request identity with
`Signal`. The caller commits or rolls back the product event, revision and
signal intent together. Admission performs no runtime resolution or delivery;
the existing jobs worker delivers committed intents and reconciles lost replies.

The dispatcher records intent; it does not authorize a TODO mutation, lock a
merge fence, settle a wait, append a revision or start an attempt. Those operations
must use the pinned TODO service and bound catalog authorization before admission.

## Activation boundary

TODO Message notifications currently refuse `notification_unavailable` before
queue admission. The pinned `todo` composition and its closure, notification
lineage and guest-host delivery contracts must pass their production checks
before replacing this refusal. Existing `coding/request` delivery is retained.

The public `POST /api/todos/{n} {steer}`, `PATCH /api/todos/{n}` and corresponding
catalog commands are not enabled by this dispatcher change. Their activation
requires T-STK-01/02/05/12, T-FLW-11, T-MCH-14, T-INS-02, T-FLW-01, T-SEC-01,
T-CAT-01 and T-ACC-03. Delegation also requires T-ACC-04; delegated Amend requires
T-APP-04. No branch-built artifact or repository code executes as root or on the
host through this admission seam.

## Stop, Resume, Retry and Drop

T-STK-05 supplies the control boundary for `POST /api/todos/{n}`. It is
unmounted until the shared install command dispatcher and its authorization,
confirmation and execution dependencies pass their joint checks. Direct
handler calls return `503` with `code: todo_control_unavailable`, `class: infra`;
they never acknowledge admission or mutate a TODO.

The request carries `Idempotency-Key` and JSON `{op, steer?}`. `op` is `stop`,
`resume`, `retry`, `retry-current-flow` or `drop`. Only the two retries accept a
steer. The browser retains the request and its key until a committed projection
receipt arrives; HTTP acceptance alone never completes the toast.

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

No root operation or host-process execution fallback is added. Full
Stop/Resume, attempt creation, Drop/fold/removal and restored-input execution
remain disabled pending their production PostgreSQL/microVM boundary receipts.

## Steer and Amend refusal boundary

The same unmounted control handler recognizes `POST /api/todos/{n}` with
`{steer}`; the unmounted Amend handler accepts `PATCH /api/todos/{n}` with
`{prompt, acceptance}`. Both reuse the existing control decoder, request size
limit, number validation, idempotency-key requirement and error envelope.
Valid direct requests return `503 infra/todo_control_unavailable` before subject
reads or effects, including repeated keys. Neither accepts actor or `via`
from JSON. Attribution must come from the shared bound authorization decision.

Amend cannot allocate a revision, create a confirmation or send a signal here.
Once the shared authority exists, delegated Amend must refuse
`503 infra/confirmation_unavailable` if its confirmation consumer is absent.
There is no local credential or confirmation substitute. Future activation
requires the served install router, catalog dispatcher and pinned guest-host
checks; these direct-handler refusal tests are supplemental evidence only.

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
`{reviewed_head_sha}` and share one service path. A TODO filed through
`POST /api/todos` merges like an issue TODO.

1. Credential, before any read: no credential is `401 unauthenticated`; a
   token, a run's or machine's credential and an agent account are
   `403 permission`. Only a person's browser session continues.
2. A malformed SHA is `400 invalid_reviewed_head_sha`; hexadecimal is
   lowercased.
3. One authority rule, applied here and again at dispatch: the browser
   session is live under its stored key (`401 unauthenticated` otherwise,
   including a session filed before keys were hashed at rest), its person is
   the install owner, and their GitHub account is one the policy names and
   GitHub counts a maintainer (`403 permission`). A press dispatch would
   refuse is never accepted.
4. `MergeReady`'s PostgreSQL rows refuse with `409`: `state` (not a TODO in
   review, PR closed, open wait, paused, foreign push), `order` (`Merges after
   Tn`), `merging` (a merge fence is set), `rechecking` (another GitHub write
   such as the PR push is pending, or no accepted head) and `stale_head` with
   `current_head_sha`, which never replaces the reviewed head.
5. Missing outbound guards or merge providers refuse `409 rechecking` before
   any approval is recorded.
6. One transaction locks the stack row, rechecks the rows and records
   `checks.Land {by, account, generation, session, head}` with the merge fence:
   `pending_op {kind: merge, target: <PR>, desired: <head>, precondition: open,
   state: intended}`. The answer is `202 {state: accepted}`. The same session
   pressing the same head again gets the same answer and no second fence.

The claimed stack worker settles the fence through the outbound providers.
`MergeDecision` rechecks the approval (a new generation voids it), the
approver under the press's authority rule, the PostgreSQL rows, then GitHub's
live head, required checks (first failing by name), required reviews
(GitHub's `reviewDecision`; unmet is `409 review_required`), draft state and
mergeability. While GitHub is still computing mergeability it reads the PR
once more after 2 s and evaluates every live row again. The App's send
sends the one squash merge with `sha` = the reviewed head. Its lookup settles
a lost answer without a second send. Its settlement lands the TODO only when
GitHub reports the merge and `main` contains the merge commit; until then the
fence stays.

A definitive refusal, from the recheck or GitHub's `405`, `409` or `422`,
clears the fence and stays on `checks.Land.refused` with GitHub's text
verbatim. The card's merge block shows it, and nothing retries it until the
person presses Merge again. The TODO card's `merge` is `done`, `merging`,
`blocked` with a refusal, `waiting` with the first failing row, or `ready`.
A refusal of the approving person (session ended, no longer a maintainer)
blocks no one else's press: the block stays `ready` with that refusal as its
`detail`.

Known gap: until T-GH-03 syncs GitHub's check and review facts, `ready` rests
on the PostgreSQL rows; a red required check or an unmet review shows only
after dispatch refuses it.

The install composition (`EnableTodoPublication`) installs the outbound
guards, `MergeDecision` and the merge kind of the App's lookup, send and
settlement together. A composition without them, such as Plue's, refuses the
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
shared authorization/catalog provider. Fresh TODO admission remains refused;
ordered runtime demands, holder release accounting and live queue positions
require the ordering, scheduler and machine-execution providers and C-STK-02.
No admission queue, root operation or host execution fallback is added.
