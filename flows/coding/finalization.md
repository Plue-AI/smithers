# Vibing and appending to main

The public `coding/vibe` descriptor's module IS the `coding/Vibe` flow, which
composes three private children in order: `coding/AdmitVibe`,
`coding/CleanVibeHistory` and `coding/LandVibe`. `LandVibe` appends to main,
or, for a repository that sends changes upstream, opens a GitHub pull request. Each child leaves its own
source-qualified receipt for the existing cards. Shipment is separate and not
implemented. The existing request outcome stops at validated, changes-requested
or blocked.

The host registers `coding/vibe` when the prompt route's project configuration
is present together with a landing: the provisioned backend binding, or the
project's own `landing` (`"fast-forward"` or `"pull-request"`) for a host
without one; it then advertises the `coding-vibe/v1` capability. Without
either, the workspace stays local-only and the descriptor is absent from the
catalog. One `coding/Landing` is bound per host; `ReadLander` records which at
admission and again at landing, so a restart never switches an in-flight run.

## Reuse the recorded request

`VibeInput` accepts only `{ requestExecutionId }`. `ReadVibeRequest` reads the
completed native Request through the existing RunStore, checks its successful
domain outcome, and walks at most 1,024 retained executions to one completed
approved control wrapper in this host. The persisted `coding/request` registry
bridge must carry the same decoded input as both Request and the approved
control plan. `coding/request` IS its own flow, so its approved envelope names
no delegate and there is no separate delegate row. Ordinary
spawn edges and trampoline row parents use their existing meanings. A native
control fork remains eligible when it satisfies the same wrapper checks.

The current finalization owner is read from the per-handler ModuleOwner service;
an absent owner refuses. Layer construction never installs a dummy authority.
Before any snapshot, AdmitVibe calls the ordinary `coding/PublishVibeSource`
child with the original source. Its retained cloud acknowledgment must succeed;
an explicit local-only host or a missing/old publication capability refuses.
An original source already retained remotely remains eligible after later local
rewrites. An unretained source that already moved cannot be replaced with a newer
one. Only after that receipt does admission enter VerifyVibe.

`VerifyVibe` reuses ValidatePlan, FastGate and Assess rather than adding a weaker
policy. It rejects duplicate check IDs before those gates, then snapshots and
checks the native source, retaining a fresh operation fence for the first
mutation. Missing, collected, conflicting or ambiguous evidence refuses.

These are new private action values in `vibe-schema.ts`: `VibeEvidence` stores
existing request/control/approval/preparation identities, original source and the
RequestResult; `VibeAdmission` adds the current validated head. There is no new
database or public package service. Lookup is bounded to 16 MiB per retained
state and 32 MiB of decoded state in total, checked after RunStore reads; it
does not scan the global catalog. The unique preparation lookup uses a filtered
two-row page from the existing RunCatalogRead. Older executions retain the
existing POC evidence path. Admission is not cleanup or landing.

The same publication child accepts the cleaned source after final checks. Its
private `PublicationInput` is `{ source: Revision, phase: "original" | "cleaned" }`.
It delegates to NativeCoding.publishOriginalSource with a stable per-execution
request ID and returns the existing SourcePublication receipt. The existing guest
helper owns authorization, exact-source checks, native transport and ACK recovery.
No credential is part of either value. Native receipt schemas now live in the
pure `native-schema.ts` module so the browser can decode the same contracts;
`native.ts` re-exports its existing names and retains the Effect/process adapter.

The immutable source base is the source captured before this entire request,
including before any implementation which later steering revised. The final
Plan's observedHead can already contain an earlier implementation. It is not
sufficient proof of the request's starting tree. Read the unique completed
`PrepareRequest` child directly under Request, verify its parent edge and input
against the approved request, decode the completed Plan, and retain its observed
source. Malformed or ambiguous modern receipts refuse. For legacy executions
with no preparation child, the existing unique Poc child and matching
input/result source remain required. Both paths use existing RunCatalogRead and
RunStore receipts; no separate provenance ledger or POC prerequisite is needed.

## Clean the existing native history

`CleanVibeHistory` uses an evidence-only ReviewHistory action through the existing
`coding/implement` model role. Its private proposal contains one final summary
and `{ changeId, description }` for each of the request's validated atoms, in
order, up to 128. Every description and the summary need a clear one-line first
line of at most 160 characters; the instruction prefers an emoji conventional
subject such as `✨ feat(greet): add a greet function` but does not require it.
A refused proposal gets one repair turn, `coding/repair-final-history`, which
quotes the refusal back with the refused proposal; a second refusal fails the
cleanup `invalid_plan` with the reason (`coding/ProposeFinalHistory`). The model
cannot insert, remove or reorder atoms or edit source.

For each atom, PrepareDescription captures the exact native operation fence and
the existing flow-derived request ID. ApplyNative executes that recorded payload;
a lost acknowledgment retries the identical payload to recover the native JJ
receipt. ConfirmDescription checks the requested text and preserved source tree.
JJ adds a terminal newline, so confirmation uses the adapter's existing trailing
newline comparison. Neither rewritten commit IDs nor unchanged descriptions
produce replacement atomic identities.

RefreshHistory reads the native atoms in batches of at most 100 under one observed
head/operation, verifies every original atom tree and linear parent relationship,
and reconstructs the existing Implementation values. RecheckFinalHistory runs the
actual required fast and slow checks through RunCheck, FastGate and Assess. It
rechecks the full request even when all descriptions were already clean. A final
source fence must still equal the validated implementation tree. Failed checks
refuse finalization while retaining the completed rewrites and action receipts;
there is no rollback or claim of append success.

The private `VibeCleanup` receipt contains its admission, summary, refreshed Result
and native head. It proves description cleanup and revalidation only. Admission
already required original-source retention before any rewrite; `LandVibe`
retains the cleaned source next and continues through Plue's existing landing
policy. Cleanup never substitutes a newer main for the original source base.

Portable prompt, plan and implementation context in history still needs its
Plue-owned notes/provenance integration. Current local operation receipts report
cloud provenance as pending; finalization must not turn that into an
acknowledged publication merely because an operation returned successfully.

## One appended commit through existing landing policy

The new Plue public operation, landed at `fb56b0b53a08`, is:

```http
PUT /api/repos/{owner}/{repo}/landings/{number}/land/append
Content-Type: application/json

{
  "commit_id": "<immutable final mythical tip>",
  "expected_commit_id": "<fenced main commit>",
  "source_base_commit_id": "<immutable source before this request>",
  "description": "✨ feat: describe the validated product change"
}
```

This is a new public API. The existing LandingService authenticates and pins the
request, returning the existing 202 queued response. Its existing worker checks
every ownership, human/agent review and required status gate before mutation;
acceptance does not claim those gates passed. This keeps full-history inspection
inside the worker's existing budget. The matching native append creates exactly one commit whose sole
parent is expected main and whose tree equals the immutable source tip. Before
that write, the original source-base tree must equal the fenced main tree.
A mismatch requires reconciliation; it must not overwrite newer main changes.
The mythical source commits retain their native identities.

The landing stack must cover the entire request, including changes implemented
before later steering. Compare the original source-base and final source's
single-parent native histories to find their shared immutable prefix. Require
the landing's ordered change IDs to equal the complete current suffix after
that prefix, including every rewritten descendant. Checking only the latest
plan or final tip would omit earlier changes from existing review policy.
The previous source anchor must come from an authentic native append receipt
bound to expected main; caller-supplied source trees cannot erase earlier
owners. Without that mapping, the first independent history import includes
every source commit. Merge histories, incomplete suffixes, duplicate native
identities and ambiguous identity are refusals. Existing landing admission is
bounded to 1,024 changes; exceeding it refuses without truncation or mutation.

Older Go/Rust decoders ignore unknown fields. Therefore the public append route,
internal `/land/append` route and `smithers_land_append` ABI marker are distinct
from ordinary landing; none may fall back to the ordinary route. A specifically
typed missing-receipt response distinguishes a first attempt from a missing old
server route. Lost acknowledgements replay the exact existing operation receipt,
including after main has subsequently moved.

The existing landing task now has immutable `append_request` metadata and an
`append_pending` state. This is an addition to existing internal task data/state,
not a new queue or table. Its database constraint and claim/reaper rules
prevent older workers from treating an append task as ordinary landing. Deploy
the migration, new worker and repo-host together before enabling the route. Existing
ordinary task behavior and old native receipt serialization remain compatible.

The existing reserved repository API credentials are
`SMITHERS_JJHUB_TOKEN` and `SMITHERS_JJHUB_API_URL`. `landing-config.ts` reads
them once at the executable boundary, together with the provisioned
`/etc/smithers/workspace-coding.json` binding (repository slug, ID, workspace ID
and this exact repository path), and deletes the token from `process.env` before
the host, model seats or any approved shell tool start. The token is an Effect
`Redacted` value inside the `coding/Landing` adapter only. The separate
`SMITHERS_AGENT_TOKEN` is the agent callback credential and must not be used for
repository API writes. Reuse the established scoped route/client; do not put
credentials in workflow payloads, notes or model context.

## Append through the landing adapter

`landing.ts` is an opinionated Effect adapter over the existing repository API,
constructed over the host's selected Node or Bun HttpClient with redirects
refused, a 90 second deadline, a 2 MiB bounded response body and no remote body
or credential in any error. `LandVibe` runs, in this order and only after the
cleaned-source retention receipt:

1. `PrepareAppend` reads the one unambiguous local `main` bookmark through the
   existing paginated bookmark route, then asks the native
   `landings/append/prepare` route for the ordered suffix between the immutable
   original source and the cleaned tip. This request's validated atoms must be
   that suffix's ordered tail; anything else refuses before creation.
2. `CreateLanding` PUTs the landing under the flow-derived request ID so a lost
   acknowledgement replays the identical immutable body. The title is the
   summary's first line; the body is the cleanup summary.
3. `QueueAppend` PUTs `landings/{number}/land/append` and records the 202
   task ID, preparation and exact request.
4. `AwaitVibeAppend` is a `Poll` of up to 90 durable 10 second rounds over the
   append observation route. Every observation must match the queued task,
   stack, source, base and description. A transport failure is an unsatisfied
   round, never a re-queue. A process restart resumes the wait.
5. `VerifyLanded` accepts only a `landed` observation whose landed count equals
   the prepared stack and whose retained cleaned source is the appended tip.
   `failed` is a typed policy refusal naming the landing; `pending` after the
   last round is `unavailable`: pending work, not a changed main.

The `VibeLanded` receipt carries the cleanup, the cleaned-source retention, the
landing identity, task ID, appended main commit and landed count.

## Send upstream as a GitHub pull request

A repository whose `.smithers/FACTORY.ts` declares
`S.Github.Policy({ mirror: "pull", changes: "send-upstream" })` does not append
to Smithers main. GitHub writes main: a maintainer merges the pull request on
GitHub and the Smithers mirror follows GitHub's main. `Github.Policy` refuses
`send-upstream` with `mirror: "push"`, and `land` without it, so a repository
never has two writers of main.

After the cleaned-source retention receipt, `LandVibe` still runs
`PrepareAppend` and `CreateLanding`; the landing is the Change's review record
in Smithers. `ReadDelivery` then reads `github.changes` from the checked-in
`.smithers/factory.json` on Smithers main (absent file or field: append) and
records it once, so a restart never switches an in-flight request to the other
delivery. For `send-upstream`, `OpenPull` calls:

```http
PUT /api/repos/{owner}/{repo}/landings/{number}/github/pull
Content-Type: application/json

{ "commit_id": "<cleaned tip>", "run_id": "<vibe execution id>" }
```

The backend resolves every credential at dispatch and persists none: the
repository's one GitHub destination (the same resolution as the mirror), the
caller's proven GitHub push access, the repository owner's GitHub App
installation token, and a disposable Smithers read token. It requires the
landing to be open with `commit_id` as its current tip, fetches that commit
through its `refs/smithers/workspaces/<id>/sources/<commit>` retention ref, and
pushes it unforced to the GitHub branch `smithers/landing-<number>`. It then
requires GitHub's `main...<tip>` comparison to be exactly the landing's stack,
so a pull request never proposes Smithers-only commits from diverged mains,
and opens the pull request with the landing's title and body.

The branch name is the idempotency key. A retry finds the existing pull request
(open, closed or merged) and returns it with `200`; a first open returns `201`.
A branch already at the tip is not pushed again, a branch that moved is a
`409`, and a concurrent open that GitHub rejects with `422` is found again.
Missing App installation, push access or App permissions are typed refusals
whose API error code the run shows; the durable action is retryable.

The `VibeProposed` receipt carries the cleanup, cleaned-source retention,
landing identity and the GitHub pull request. It is proposed work, not a
changed main. Merging happens on GitHub.

## Hand the result to the mythical stack

A repository whose backend runs a mythical stack (`GET /api/repos/{o}/{r}/mythical`
answers `state: "active"`) does not append or open its own pull request.
After the cleaned-source retention receipt, `LandVibe` records `ReadStack` once
and, for a stacked repository, `SubmitLane` hands the stack service
`{ workspaceId, base, source, requestRunId, summary }` with
`PUT …/mythical/lanes`: `base` is the stack tip the request started from (the
original source's parent) and `source` the retained cleaned tip. The service
integrates it onto the current tip, verifies a rebased candidate with
`coding/verify`, and proposes it; the `VibeSubmitted` receipt names the item
that now carries the result. A repository without an active stack keeps the
paths above.

A stack request starts on the tip: `coding/request` with
`base: { commitId, ref }` (the tip retained in this workspace's source ref)
imports that commit and creates an empty working change on it before planning
(`stack.ts`), so the plan's native history is the stack. `coding/verify`
(`verify/flow.ts`) imports one retained commit and runs the required checks on
its immutable export; it passes only when every required check passed. Its
payload's `writes` are the paths the rebased candidate changes on the tip, so
an affected check selects their targets; each receipt's input digest binds
them. The stack service keeps the receipts of the run that measured the
current candidate on its item, where the stack view shows them.

## Land without the backend

A self-hosted host on plain git or GitHub declares `"landing"` in
`.smithers/coding-project.json` (`local-landing.ts`). Its `coding/vibe` skips
cloud retention on both sides, because there is no backend to retain with:
`AdmitVibe` verifies the request directly, and `LandVibe` runs one of two
member sets after cleanup. Both begin with `PrepareCandidate`: the cleaned tip
merged onto the current `main` as ONE commit whose sole parent is main and
whose message is the cleanup summary, built with `jj new`/`jj restore` from
marked temporary commits that are abandoned again, without moving the working
copy. This request's validated atoms must all lie on the tip's line after
main. A merge conflict, or a tip that changes nothing, is a typed `evicted`
refusal naming the paths, and nothing is left behind.

`"fast-forward"`: every check the plan declared runs once on the candidate
through the ordinary `RunCheck` action (`coding/verify` checks a rebased stack
candidate the same way), bound to the candidate's exact commit and tree.
`FastForward` moves `main` to the candidate with `jj bookmark set`, which
refuses a sideways or backwards move, and answers `VibeFastForwarded` with the
new main and the receipts. A failed required check, or a main that moved after
the candidate was built, evicts: the candidate is abandoned and the run fails
with `evicted` and the reason, for the worker to redo.

`"pull-request"`: `OpenLocalPull` pushes the candidate unforced to
`smithers/landing-<request>` on `origin` and opens its pull request with
`gh pr create`, or finds it again by that branch (the idempotency key); a
branch that moved off the candidate is refused, never pushed over. It needs a
colocated Git repository and the operator's `gh auth login`.
`AwaitVibePullChecks` polls `gh pr checks --required` in durable 15 second
rounds for up to an hour; failed required checks evict (the pull request stays
open for its author), pending ones after the last round are `unavailable`.
`MergeLocalPull` then squash-merges with the summary and
`--match-head-commit`; GitHub's branch protection decides, and a refused merge
leaves the pull request open with GitHub's reason. `VibePullRequested` carries
the candidate, the pull request and the merge outcome.

The lander's `jj`, `git` and `gh` see only the selected environment
(`landingEnvironment`: the check environment plus the jj identity and `gh`
selection variables), never the reserved repository credential. The repository
automation jobs land only through the backend adapter and see no local lander.

## Separate product states

A validated request can begin vibing: final history and context cleanup, repeated
checks required by rewrites, then append according to the existing landing
policy. An accepted landing task is pending work, not proof that main changed.
Poll the existing landing state and verify its native result before calling it
landed. Optional delivery checks and canary workflows use the existing required
check receipts; only actual successful delivery evidence can mark work shipped.
The UI should expose each of these through the existing recursive cards and
source-qualified flow actions, not infer them from a green parent run.

When Wiki is explicitly enabled, its freshness participates in source
backpressure and final publication. A configured required slow Wiki check inspects the exact immutable implementation
export and return a normal Receipt/finding to the existing correction loop.
Running a live-root wiki while optimistic editing continues would race the
source identity. Publishing a verified final wiki requires a source fence and
must not publish a disposable check workspace as the repository's current wiki.
