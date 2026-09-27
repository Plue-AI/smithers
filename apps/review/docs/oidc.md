# OIDC session verification

`POST /api/sessions` verifies GitHub Actions RS256 tokens against the issuer's
JWKS. The token's `kid` must identify a trusted signing key. Claims are checked
only after the signature verifies.

Signature decoding failures return HTTP 401 with `{"error":"oidc: malformed"}`.
Forged signatures, payload tampering, and cryptographic verification errors
return HTTP 401 with `{"error":"oidc: bad-signature"}`. Rejected tokens create
neither a session nor a `reviewed_prs` quota row.

Each JWKS request has a five-second deadline covering fetch and JSON body
consumption. A timeout aborts the request, releases all callers awaiting that
refresh, and returns HTTP 503 with `{"error":"oidc: jwks-unavailable"}`.
Network, HTTP, and JSON parsing failures use the same unavailable outcome.

JWKS keys remain cached for ten minutes. Refreshes for a URL share one request.
Failures use the existing five-second cooldown measured from the refresh's
start time. Once that cooldown expires, a subsequent request may retry.
A timed-out request cannot replace cached keys if its body completes later.


Registration binds `repositoryId` and `ownerId` to GitHub's immutable numeric
IDs. Both are required on `POST /api/admin/repos`, alongside the plan fields.
OIDC sessions require matching `repository_id` and `repository_owner_id`
claims. A mismatch returns 403; missing identity claims return 401. A legacy
registration without IDs returns 503 until an operator backfills it. Refusals
consume neither quota nor sessions.

Apply migration `0002_repository_identity.sql` before the Worker update, then
backfill registrations with IDs verified through GitHub. Resolve any existing
case-duplicate names before creating the unique name index, preserving usage,
quota and reservation records. New names are lowercase; existing stored keys
remain unchanged so case variants cannot reset billing. Registration updates
cannot rebind an existing repository or owner ID. Repository renames/transfers
require an operator migration preserving accounting and revoking old sessions.

## Trusted workflow

On `pull_request`, GitHub runs a repository's workflow file from the pull
request's merge commit, so anyone who can push a branch can edit it. A valid,
correctly bound token therefore also needs its `job_workflow_ref` claim (the
workflow file that defines the job, signed by GitHub) to equal one of the
registration's allowed workflow refs. For a job that calls a reusable
workflow, GitHub sets `job_workflow_ref` to the reusable workflow at the ref
it was called at, on every event including `pull_request`. The default and
only allowed ref is
`smithersai/smithers/.github/workflows/review.yml@refs/heads/main`; the
`owner/repo` prefix compares ignoring case, the path and ref exactly. A
missing, malformed or different claim (a caller's own file at
`refs/pull/N/merge`, the trusted file on another branch, another file at
main) returns HTTP 403 with `{"error":"oidc: untrusted workflow"}`, the
claim, and the allowed refs, before any quota or session is spent.

`POST /api/admin/repos` takes `allowedWorkflowRefs`: omitted keeps the
stored list, `null` restores the default, and a non-empty list of
`owner/repo/.github/workflows/<file>@<refs/heads/…|refs/tags/…|40-hex SHA>`
replaces it. A pull request ref is never accepted. Register only a ref
nobody but maintainers can move: a protected branch, a protected tag, or a
commit SHA. A repository's own workflow at its default branch is such a ref,
but GitHub runs that file from the pull request on `pull_request`, so its
token names `@refs/heads/<default>` only on events that run the default
branch's file (`issue_comment`, `push`, `schedule`, `workflow_dispatch`);
trusting it fits a `comment`-mode registration, where every other event is
refused. Apply migration
`0003_allowed_workflow_refs.sql` before the Worker update.
