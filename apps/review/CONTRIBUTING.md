# Contributing to smithers review

Internals, architecture, and development workflow for `apps/review`. For
what the tool does and how to set it up, read the [README](README.md).

Design notes live beside the code. [src/README.md](src/README.md) maps the
review and walkthrough pipeline, [src/server/README.md](src/server/README.md)
maps the hosted service, and [docs/](docs/) holds the service contracts:
[OIDC sessions](docs/oidc.md), [proxy budgets](docs/proxy-budget.md), and
[hosted walkthroughs](docs/walkthroughs.md).

## How it works

One durable Flow, in four stages. `Flow.to` ends a round and starts the next
one with its payload as real data, which is what lets round 2 fan out over a
file list round 1 discovers:

1. `PrepareReview` resolves the target and loads one snapshot, including
   review-excluded files. `Review` hands off. `ReviewFiles`
   then runs one `ReviewFile` cell per changed file, in `--concurrency`-wide
   batches, on the `review` seat with the prompt in
   `src/review/buildFileReviewPrompt.ts`. Each batch runs in its own durable round;
   `MergeFileBatch` records its outcomes before a handoff starts the next batch.
   `--concurrency` bounds the simultaneous file-review calls per run (default
   8). Completed batches survive a resume. `VerifyReview` adjudicates the
   findings on the `review-verify` seat when `--verify` is on.
2. `changesFromDiffs` builds walkthrough changes from that same snapshot,
   including files skipped by review filters.
3. `NarrateChanges` (an agent) writes the story as block streams: prose explanation
   (markdown), diff blocks that embed each file's diff at the right point in
   the narrative, and Mermaid diagrams wherever structure or flow changed.
   Chapters open with the central change and follow dependency order; prose
   between diffs carries the thread. `normalizeStory` enforces that every
   changed file appears in exactly one diff block; a deterministic fallback
   story covers agent failure and `--no-narrate`.
4. `RenderWalkthrough` renders self-contained HTML (inline CSS, no external assets)
   and writes it to `--out`. Diffs are rendered with `@pierre/diffs` (syntax
   highlighting, word-level diffs, line numbers, unified or `--split` view);
   diagrams render via an inlined Mermaid runtime (only included when the
   story has diagrams); the header shows a deterministic change-overview
   chart of additions/deletions by area, drawn as plain HTML bars.

Review findings never change the exit code; smithers review reports, humans
decide.

## Reviewing GitHub PRs

`--pr <number|url>` resolves the PR via the `gh` CLI, defaults the review
range to the immutable base and head commit IDs returned by GitHub. After the
run it posts one PR review: the narrative summary (headline, synopsis, reading order, walkthrough link
when `--publish` ran) as the body, and every anchorable finding as an inline
comment with a ` ```suggestion ` fence when replacement code exists. If
GitHub rejects the inline batch, the findings are folded into the body and
the review still posts. The CLI obtains missing PR commits before
loading the review snapshot and fails if the base commit is unavailable.
Local branch and remote-tracking refs never select the default PR comparison.

## CI

`.github/workflows/pr-review.yml` dogfoods the action in `action/` on this
repo. It is the README's workflow: it calls the reusable
`.github/workflows/review.yml` at `@main`, which runs the action at `@main`,
never `./apps/review/action`. The job holds the review identity and PR write,
so a pull request never runs its own action code there, and the service
accepts only a token from `review.yml@refs/heads/main`
(`src/server/sessions/trustedWorkflow.ts`). The reusable workflow takes no
inputs, so a caller cannot redirect the token or change what runs. The
repository is registered with the review service, so its reviews run on
metered inference and it passes no provider key. It stays on
`pull_request` and `issue_comment` (never `pull_request_target`) with
`id-token: write`, `contents: read`, and `pull-requests: write`.

`action/src/runAction.ts` runs these steps:

1. `action/src/gateEvent.ts` skips drafts, fork PRs, and comments other than
   `@smithers review` from a maintainer: an account whose permission is
   write, maintain, or admin (read with the job's `GITHUB_TOKEN`), never a bot
   or GitHub App. `../../docs/api/github-maintainer-comment.vectors.json` specifies
   the rule for the action and the backend alike; a read GitHub does not
   answer skips with a warning.
2. The job's GitHub OIDC token is exchanged for a review session at
   `/api/sessions` (`action/src/createSession.ts`). An unregistered repo, a
   spent monthly quota, or a `pull_request` event on a `comment`-mode
   registration ends the run with a notice, and the job passes.
3. `action/src/resolveInferenceEnv.ts` points inference at the service's
   metered proxy under the session token. The action forwards no provider
   key, and `action/src/materializeInferenceCredentials.ts` scrubs every
   provider key and seat override the job env carries before the review runs.
4. `action/src/runReview.ts` runs the CLI with `--pr <number> --publish` and
   publishes to the session's `publishUrl` under the session token, so no
   publish secret exists.
5. The CLI posts the review onto the PR, and
   `action/src/upsertStatusComment.ts` keeps one status comment current with
   the outcome, the walkthrough link, and the remaining quota.

The action declares no outputs and uploads no run artifact: the PR review, the
status comment, and the hosted walkthrough are the whole result. A session
error or a failed review fails the job.

## Self-hosted CI (your own credentials)

To run reviews in another repo's CI without the hosted service, bring your own
provider key and check out smithers next to the repo. This path runs the CLI
directly and never calls the action or the service: there is no OIDC session,
no quota, and no hosted walkthrough.

```yaml
name: PR review
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]

permissions: {}

jobs:
  review:
    # Fork PRs have no secrets and a read-only token; drafts are not ready.
    if: github.event.pull_request.head.repo.full_name == github.repository && !github.event.pull_request.draft
    runs-on: ubuntu-latest
    timeout-minutes: 30
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2
        with:
          fetch-depth: 0 # merge-base needs history
      - uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2
        with:
          repository: smithersai/smithers
          ref: v1.0.0-rc.0
          path: .smithers-review-tool
      - uses: pnpm/action-setup@0e279bb959325dab635dd2c09392533439d90093 # v6.0.8
        with:
          version: 11.25.0
          run_install: false
      - uses: actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e # v6.4.0
        with:
          node-version: 26.4.0
      - run: pnpm -C .smithers-review-tool --filter @smthrs/review... install --frozen-lockfile
      - uses: taiki-e/install-action@e67fa11c4b9316fa714ddf0abed07a0c3143b95b # v2
        with:
          tool: jj-cli@0.39.0
      - name: Review the PR
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
        run: >
          node .smithers-review-tool/apps/review/bin/smithers-review.mjs .
          --pr ${{ github.event.pull_request.number }}
```

`OPENAI_API_KEY` works too; point `SMITHERS_REVIEW_SEAT` and
`SMITHERS_REVIEW_CHEAP_SEAT` at `openai:` seats when you use it. Never use
`pull_request_target` here.

## Rendering diffs anywhere else

The diff renderer is exported as `@smthrs/review/diffs`, so anything in this
workspace can embed the same diffs in any artifact (reports, custom workflow
UIs, dashboards). The package is private at rc.0, so the import resolves
through the workspace link, not a registry
install:

```ts
import { renderPierreFileDiff, extractDiffAssets } from "@smthrs/review/diffs";

const html = await renderPierreFileDiff({ diff: gitPatchForOneFile });
// embedding many diffs in one page? hoist the shared assets once:
const { sprite, styles, body } = extractDiffAssets(html);
```

The Pierre reference clone lives at `reference/pierre/` (gitignored).

## Publish service

`--publish` uploads the walkthrough to a Cloudflare Worker (R2-backed,
deployed with Alchemy from `alchemy.run.ts`) and prints an unlisted share
URL. The live endpoint is `https://review.jjhub.tech`; set
`SMITHERS_REVIEW_PUBLISH_URL` to the publish service endpoint before using
`--publish` ([hosted walkthroughs](docs/walkthroughs.md) covers the upload
contract). Credentials come from
`SMITHERS_REVIEW_PUBLISH_URL` / `SMITHERS_REVIEW_PUBLISH_TOKEN` or
`~/.smithers-review.json`.

Deploying needs `CLOUDFLARE_API_TOKEN`, `ALCHEMY_PASSWORD`,
`REVIEW_PUBLISH_TOKEN`, `REVIEW_ADMIN_TOKEN`, `REVIEW_METRICS_TOKEN`, and
`REVIEW_ANTHROPIC_API_KEY` from your secret store, never the command line.
Both commands run stage `prod` against the account's shared
`alchemy-state-store`. The first Alchemy 2 run adds `--adopt` to take over the
live Worker, bucket, and database; later runs drop it:

```sh
pnpm -C apps/review run plan --adopt
pnpm -C apps/review run deploy --adopt
SMITHERS_REVIEW_E2E=1 pnpm -C apps/review test   # includes live publish e2e
```

## Seats

The flow declares four logical seats, so a step identity stays put when the
model behind it changes: `review`, `review-verify`, `review-narrate`, and
`review-quiz`. `src/workflow/reviewSeats.ts` reads the policy off the
environment and `src/workflow/reviewSeatResolver.ts` turns each
`provider:model` string into a credentialed route. It is the only file in the
app that reads a credential.

| Variable | Seats it sets | Default |
| --- | --- | --- |
| `SMITHERS_REVIEW_SEAT` | reviewing and verifying | `anthropic:claude-sonnet-4-5` |
| `SMITHERS_REVIEW_CHEAP_SEAT` | narrating and quizzing | `anthropic:claude-haiku-4-5` |
| `SMITHERS_REVIEW_VERIFY_SEAT` | verifying only | `SMITHERS_REVIEW_SEAT` |
| `SMITHERS_REVIEW_NARRATE_SEAT` | narrating only | `SMITHERS_REVIEW_CHEAP_SEAT` |
| `SMITHERS_REVIEW_QUIZ_SEAT` | quizzing only | `SMITHERS_REVIEW_CHEAP_SEAT` |

The provider is the half of the seat string ahead of the colon, and it alone
decides which credential is read: `ANTHROPIC_API_KEY` for `anthropic:` seats,
`OPENAI_API_KEY` for `openai:`, `OPENROUTER_API_KEY` for `openrouter:`. A seat
with no colon is a bare model id on the Anthropic route. `ANTHROPIC_BASE_URL`
moves the Anthropic route to another origin, which is how the action reaches
the metered proxy.

The action always runs on the metered proxy (`action/src/resolveInferenceEnv.ts`),
which mints a session-scoped key and points `ANTHROPIC_BASE_URL` at its own
origin. Provider keys apply only when you run the CLI yourself.

rc.0 runs no CLI subprocess, so there is no engine to select and no Codex or
Claude Code agent pool: a seat resolves to a provider route, and the table
above is the whole model policy. The 0.x variables that selected an engine and
its models are gone, and `tests/docsSeatConventions.test.ts` fails if this file
or the README starts documenting them again.

## Capabilities

`layerNode` runs the flow on the durable host, whose HTTP client is guarded by
the capability kernel: every model request is checked as `model:call` on
`<host>/<model id>`. `modelCallRules` in `reviewSeatResolver.ts` grants exactly
the origins the seats can dial, and `agentHost` declares the same patterns as
the run's capability envelope. Without the grant the first request parks on a
permission that an unattended run has nobody to answer, and the CLI dies with
"All fibers interrupted without error". Scripted seats build no HTTP request
and never meet the check, so `tests/workflow/reviewLayerNode.test.ts` drives a
real route against a local fixture provider to cover it.

The review host binds no completion judge. `agentHost` sets `claimCap: 0`
because its seats have no tools and no workspace: a finding that names a
failing command is a finding, not an invented claim. The run needs no
credential beyond the seats' own, and
`tests/action/binUnderActionEnv.test.ts` runs the bin under exactly the
environment the action passes.

## Documentation of exports

The workspace convention is JSDoc on every export, and the imported packages
follow it throughout. Here it is scoped to the published surface: the entry
points in `package.json`'s `exports` map (`./cli`, `./diffs`, `./workflow`,
and `./workflow/layer`) plus the modules the
diffs barrel re-exports. Those are the names another workspace project can
import, and `tests/publicApiDocs.test.ts` fails when one of them loses its doc
block.

Everything else under `src/` and `action/src/` is an internal seam between
files in this app. Document those where the reason is not obvious; a one-line
restatement of the signature is not required.

## Tests

```sh
pnpm -C apps/review test        # bun test: real git fixtures, real gh, real routes
pnpm -C apps/review typecheck
```

Suites that need a real backend go through `tests/support/liveSuite.ts`, which
prints one line naming what a skip did not prove. `tests/workflow/` covers the
flow on scripted seats; `tests/workflow/reviewLayerNode.test.ts` spawns Node
because the durable composition does not build under Bun.

Live GitHub checks are opt-in: run `pnpm -C apps/review test:live` with GitHub
credentials. Ordinary unit tests skip them even when `gh` is signed in.

### Service data lifecycle

Alchemy applies the versioned SQL in `src/server/migrations.ts` before updating
the Worker. SQL files are materialized under `.alchemy/review-migrations` for
Alchemy's migration ledger. Append a version; never edit an applied migration.
Before adopting the existing database, verify it has the baseline columns
(`repos.quiz`, `api_keys.spend_cap_usd`, `sessions.api_key_hash`, usage cache-token
columns, `usage_reservations.model`, and `walkthroughs.status`). The baseline
refuses missing columns; reconcile legacy schema before adoption. No request
runs DDL.

Hourly retention removes walkthroughs and raw usage older than 90 days,
expired sessions after a one-day grace period, and old monthly PR records.
Unsettled reservations, their sessions/events, and lifetime usage totals stay.
Each pass is bounded and retries failed R2 deletions before dropping their rows.
Watch `smithers-review: retention complete` / `retention failed` in Worker logs.
Audit pre-existing R2 objects without walkthrough rows separately during adoption.

Revoke a leaked key with authenticated `POST /api/admin/keys/:sha256/revoke`.
It immediately invalidates the key and sessions issued from it. Admin usage
accepts `?days=1..90` (default 30).

Review seats use their configured provider credentials, including verification.
`AI_GATEWAY_API_KEY` is not read by this app.

## Release checklist

The reusable workflow on main runs the action at `@main`. A consumer-facing
release is a `review-v<x.y.z>` tag (never `v*`, which publishes npm) on a
commit that pins the action to the tested revision.

1. Pick a tested main revision (green `//apps/review/...`).
2. `node apps/review/scripts/review-release.mjs <x.y.z> <sha>` tags the pinned
   release commit locally and changes nothing else.
3. `git push origin refs/tags/review-v<x.y.z>` (maintainer).
4. Add `smithersai/smithers/.github/workflows/review.yml@refs/tags/review-v<x.y.z>`
   to the registration's `allowedWorkflowRefs` (admin API).
5. Run the fixture repository's workflow at the tag and keep the run URL.
