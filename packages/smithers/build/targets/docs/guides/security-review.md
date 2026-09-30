---
title: "Security review"
description: "S.SecurityReview declares a package's security checks once and yields a cheap diff review and a manual full audit."
sidebar:
  order: 6
---

`S.SecurityReview` turns a package's security checks into two `LlmLint`
targets. Spread the result into the package's targets:

```ts
import { Smithers as S } from "@smthrs/targets"

const securityReview = S.SecurityReview({
  cwd: "packages/uploads",
  checks: [{
    id: "upload-path-traversal",
    title: "Upload paths stay inside the upload root",
    threat: "An authenticated user writes files outside their own upload directory.",
    lookFor: [
      "A request-supplied file name joined to the root without normalizing and prefix-checking it.",
      "A symlink inside the root followed on write."
    ],
    paths: ["src/upload/**"]
  }]
})

export const Package = S.Package({ targets: { ...securityReview } })
```

| Target          | Reviews                               | Selected by                                             |
| --------------- | ------------------------------------- | ------------------------------------------------------- |
| `security`      | included files changed against `base` | `smithers-build review '//...' --policy-revision <sha>` |
| `securityAudit` | every included file, changed or not   | a label or `//pkg/...:securityAudit`, never `//...`     |

Run a full audit of a package and every nested package with:

```sh
smithers-build review '//packages/uploads/...:securityAudit' --policy-revision <sha>
```

## Checks

Each check has a kebab-case `id`, a one-line `title`, a `threat` naming who
could do what to whose data, a `lookFor` list of concrete, falsifiable things to
inspect, and optional `paths`, package-relative globs the check focuses on. The
macro always appends the built-in `general` check, which sweeps for injection,
authorization gaps, secrets, path traversal, SSRF, unsafe deserialization,
command execution, crypto misuse, prompt injection, supply chain, denial of
service, and information leaks. The id `general` is reserved.

## Trust boundaries

Declare `boundaries` when a security decision crosses packages. `cwd` records
ownership; it does not limit the execution path. Each boundary requires a
unique kebab-case `id`, nonempty `actors`, `assets`, `entryPoints`,
`identityTransformations`, `enforcementPoints`, and `deploymentAssumptions`.
These are one-line descriptions, not file patterns. Each boundary adds a required
`boundary-<id>` check: a completed response must report its coverage as well
as the named checks and general sweep. An explicit check cannot reuse that id.

The boundary's `path` has four required nonempty lists of file globs:
`caller`, `authorization`, `service`, and `storageOrEgress`. Paths are relative
to `cwd`, or workspace-rooted with `//`. Every path is added to both `include`
and `context`: a backend-only change triggers its caller's boundary review,
and every batch sees the complete declared path even when only one file changed.
Missing paths fail declaration validation when the workspace root is known.
Declared deployment assumptions are outside the source review scope; they
are not missing context or proof of hosted enforcement. Missing evidence for
the declared source path must still make the review incomplete.
The existing file, context and prompt size limits still apply; declare focused
paths rather than whole package trees. List each file that makes a declared
enforcement decision, one call from the route composition; deeper
dependencies belong to their owning package's review.

The server declaration starts at the deployed edge entry and its HTTP transport,
then traces backend authentication, repository authorization, workflow admission
and storage. The backend owns browser identity; the edge forwards requests to
its configured backend origin and removes caller-supplied identity headers. The gateway traces control authentication into control operations
and execution. The sandbox traces flow execution into microVM policy,
provider operations and guest results. Named checks and the general sweep
apply across these paths; a package-local check is not proof of boundary
completeness.

### Hosted composition receipt

Public reviews run using this repository alone. They do not establish hosted
routing, credential injection, TLS or microVM deployment isolation.
In the private deployment repository, review the composition with the public
backend checked out at an exact full commit SHA. Record both repository
SHAs, the boundary declaration, reviewed files, review command and result,
and controlled tests for identity propagation, tenant authorization,
credential destinations and guest isolation. Include private ingress,
service wiring and deployment enforcement with the public caller-to-egress
path in that review. A floating branch, accepted launch or public-only review
is not hosted evidence. Keep the receipt and private paths in the private
repository; public checks must never require them.

## Findings

Each finding includes `file`, `line`, `message`, and structured `security`
fields: `checkId`, `impact` (`low`, `medium`, `high`, `critical`),
`verification`, `releaseRecommendation` (`allow`, `review`, `block`),
`attackerPreconditions`, `evidence`, and `nextConfirmationStep`.
The check id must belong to the declaration, including `general`.

Model output is always `suspected`; model-supplied reproduction claims cannot
confirm it. High or critical impact always sets `releaseRecommendation` to
`block`. Any blocking recommendation fails the review regardless of
verification. The display severity is derived from the recommendation:
`block` becomes `error`, `review` becomes `warning`, and `allow` becomes `info`.

After executing a controlled local reproduction, a trusted host can call
`confirmFinding` from `@smthrs/targets/SecurityReview` with the finding and a
receipt containing the full immutable commit `revision`, the executed
`command` or test invocation, and its `observedResult`. This API records the
host's attestation; it does not execute or independently verify the command.
The host must reproduce the finding against that revision in an isolated
checkout and retain the execution evidence. Never pass model output as a
trusted receipt. Confirmation preserves the impact and release recommendation.

Safe local regression tests with synthetic data are permitted. The reviewer
must not produce weaponized exploits or instructions to attack live systems.

## Options

| Option           | Default           | Meaning                                                       |
| ---------------- | ----------------- | ------------------------------------------------------------- |
| `cwd`            | required          | Workspace-relative package directory.                         |
| `checks`         | required          | The package's checks; `[]` leaves only `general`.             |
| `include`        | `["src/**"]`      | Reviewed files; strings or `S.glob`, `//` for workspace root. |
| `context`        | `[]`              | Files read into every batch whether or not they changed.      |
| `engine`         | `"claude"`        | `claude` or `codex`.                                          |
| `model`          | `claude-opus-5-5` | `gpt-6-sol` when `engine` is `codex`.                         |
| `base`           | `"origin/main"`   | The diff review's base revision.                              |
| `batchSize`      | `4`               | Changed files per model call in `security`.                   |
| `auditBatchSize` | `8`               | Changed files per model call in `securityAudit`.              |
| `contextTokens`  | `200000`          | The model's context window every call fits.                   |
| `required`       | `false`           | Empty selections and missing engines fail instead of passing. |
| `budget`         | none              | `modelCalls`, `promptTokens` and `wallMs` for the review.     |
| `deps`           | `[]`              | Targets that must run first.                                  |
| `summary`        | generated         | One-line summary of `security`.                               |

## Batching

Changed files that import each other, or share a Go package, go in the same
call whenever they fit. Each call also carries the unchanged included files
its changed files import or are imported by, dependencies first, then Go
package siblings, then importers. Related files that do not fit the budget
are named in the prompt as omitted. Context files are in every call.

Every call fits `contextTokens`, estimated at three bytes per token, after
reserving 16,384 output tokens. A changed file too large for one call is split
at top-level declarations, then at lines; each slice reports whole-file line
numbers. A finding on a file several calls saw is reported once per line and
check, keeping the most severe.

One invocation makes at most 64 calls. With a finding store, a larger review
persists the calls it made, fails as incomplete, and the next invocation over
the same policy and bytes resumes the remaining batches. Without a store, a
review over 64 calls is refused.

## Finding store

`smithers-build review` persists every run and finding in a private store,
`smithers/review-findings` in the repository's Git directory by default, or
`--findings-store <absolute path>`. The directory is owner-only and never
committed. Each batch's findings and attempts are written when the batch
completes, so a later failure keeps them. A failed or incomplete run resumes
from its completed batches; a completed run is never reused, and an unchanged
rerun reviews everything again.

Each finding has a stable fingerprint from its file, check and flagged line
text, so moving the line keeps it. A finding the same owner and policy no
longer reports after reviewing its file becomes `fixed-pending-retest`; it
closes only through `closeFinding` with a trusted host's receipt of the
reproduced fix, and reopens if reported again. The review receipt and console
show only `publicSummary` data: fingerprint, restricted reference, state,
severity, owner, check and impact, plus the file once the fix is closed. Keep
exploit details in private advisories and link public issues to the restricted
reference.

## Required reviews

An optional review with nothing selected passes with no files, and a missing
model executable skips it. A required review fails in both cases: an approval
gate cannot be satisfied by a review that reviewed nothing. Declare
`required: true`, or pass `--required` to `smithers-build review` to require
every selected review, policy reviews included. Refusals, incomplete coverage
and parse failures fail every security review.

`budget` bounds the whole review: `modelCalls` counts every attempt,
`promptTokens` sums the estimated tokens sent, and `wallMs` limits wall-clock
time, each call's timeout shrinking to what remains. A call that would exceed a
bound is not sent, is never retried, and fails the review. A budgeted report
includes its `usage`. Interrupting a review stops its model calls.

## Cost and CI

The aggregate `ci` verb never plans a review. The `review` verb plans
`security`, which reads only changed files. `securityAudit` is manual: a bare
wildcard skips it, so it runs only when someone names it. Missing provider
credentials fail the review. The CLI reads policy from the pinned commit and
reviews committed source without evaluating candidate declarations. See
[review isolation](review-isolation.md) for the trust and authentication contract.
