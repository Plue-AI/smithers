# Release workflows

`release` and `release-content` replace the JSX workflows removed in
`2716e985` (the last originals are in `v0.35.0`). They use `Flow.make`,
`Action.make`, `AgentAction.make`, typed Effect schemas, `HumanTask`, and the
production SQLite `NodeRuntime.layerHost`.

The module descriptors are discoverable under `flows/`. Run them through the
commands below: the small host registers their actions and durable flow bodies.
The general CLI currently discovers module flows but requires an explicit host
to execute them. No GitHub workflow is dispatched or used as the orchestrator.
Discovery reports conservative authority warnings for these named delegates;
the host supplies their implementations and approval boundaries.

## Inspect without running

```sh
pnpm release:content --plan --input '{"version":"1.0.0-rc.0","from":"v0.35.0"}'
pnpm release:workflow --plan --input '{"version":"1.0.0-rc.0","phase":"publish"}'
```

`--plan` constructs the graph without models, registry requests, release writes,
or publication. A normal run defaults to `dryRun: true`: it does execute the
models or validation commands, but only produces local preview/candidate
artifacts. A dry run never asks for publication approval or publishes.

Use Node 26.4+, pnpm, Bun, and the repository's build prerequisites.
The live model uses the existing Smithers CLI seat resolver and its configured
credentials; `--model` defaults to `openai:gpt-6-sol`. `--max-tokens` defaults
to 250000 for the whole run. Credentials are not written into the run input.
Models receive evidence and return typed content; they have no publication or
shell tools.

## Release content

```sh
pnpm release:content --run rc-content --input-file release-content-input.json
```

Example input:

```json
{
  "version": "1.0.0-rc.0",
  "from": "v0.35.0",
  "dryRun": false,
  "publish": false,
  "postX": false,
  "channels": { "changelog": true, "blog": true, "thread": true, "media": true },
  "notes": "Explain the 0.x to 1.0 migration."
}
```

The graph collects git history and source/docs excerpts, builds a claim ledger,
selects a narrative, drafts the changelog and thread, outlines and drafts the
blog, then scores and revises the result. Deterministic checks independently
enforce claim sources, enabled channels, tweet lengths, and promotional-language
rules. `minScore` defaults to 0.86; `maxRevisions` defaults to 2 and is capped at
3. A failed quality gate stops before approval or publication.

Jev selects the narrative, and it is the only model that selects it. Which of
four write-ups a release calls for is a closed choice, so
[`jev-template.ts`](release-content/jev-template.ts) sends one state, the claim
ledger beside the commit subjects, changed paths and documentation excerpts it
was built from plus the operator's own notes, all clipped in proportion so the
state stays under 32 KiB, and asks one question: does this release call for a
feature deep dive, a migration guide, a reliability report or a release
roundup? Each criterion names the job that write-up does, and the answer is the
brief's narrative. `release-content/pick-template` is its only writer, so the
writer seat, which is now asked to outline the narrative it was handed rather
than to choose one, has no field to overwrite it with. An answer below 0.8
confidence is Jev saying the evidence does not point at one write-up: the step
fails with a typed `ReleaseError` naming the distribution, because announcing a
release as the wrong kind of thing is worse than not announcing it yet and a
house default would publish a claim about the release that nothing in the
evidence supports. Sharpen the evidence or say what the release is for in
`notes`, then run again. An evaluator that is unconfigured, unreachable,
refused, timed out or malformed fails the same step with the evaluator's own
code and message. The host uses the native subscription judge: connect a ChatGPT or Claude
subscription, directly or through the account pool. No provider API key or
gateway key is needed, and neither is a fallback.

Previews contain the drafts, review, proposed destination files, an optional
SVG release card, and any UI recording. They live in
`.flows/releases/content/<version>/<digest>/`. Inspect `bundle.json` and the
rendered files before answering.

`recording` is optional and defaults to `null`. To record a real local product
scenario before drafting, supply its running URL, a ready selector, and the
explicit interactions. For example:

```json
{
  "recording": {
    "url": "http://127.0.0.1:47399/",
    "readySelector": "[data-testid=composer-input]",
    "steps": [
      { "kind": "wait-text", "selector": "body", "value": "Smithers" }
    ]
  }
}
```

Steps support `click`, `fill`, and `wait-text`; selectors and assertions must
describe the scenario being recorded. The action uses a fresh Chromium context,
checks page errors, and saves start/middle/end frames plus WebM video. It does
not start, stop, mock, or reuse the user's existing gateway. Requests are limited
to loopback hosts. Playwright's Chromium and its ffmpeg binary must already be
installed: `pnpm exec playwright install chromium ffmpeg`. Chromium alone fails
at `browserContext.newPage`, because the recording context renders WebM with
ffmpeg. The approval
explicitly includes reviewing the frames/video; recording filenames alone are
not evidence for a feature claim.

With `dryRun: false`, the flow parks on a durable approval. `publish: false`
records approval only, producing the `contentArtifact` used by the release
workflow. With `publish: true`, approval also permits the exact proposed file
writes: the root changelog narrative, the site's versioned changelog, and the
optional release article. Existing canonical support-doc sources and their
generated projections are updated together. The root changelog's mechanical
commit block and older releases are preserved. Changed destination files refuse
the write instead of overwriting an intervening edit.

`postX: true` additionally requests posting the thread and is explicit in the
approval prompt. It requires the old workflow's `X_API_KEY`, `X_API_SECRET`,
`X_ACCESS_TOKEN`, and `X_ACCESS_SECRET` variables. The publisher uses X's
[create-post API](https://docs.x.com/x-api/posts/create-post) and
[OAuth 1.0a authorization](https://docs.x.com/fundamentals/authentication/oauth-1-0a/authorizing-a-request).
A receipt is recorded after each tweet. An uncertain acknowledgement leaves a
pending entry and stops; it is never retried blindly. Reconcile that entry
against the account before a new attempt. No X request is made in tests.

`autoCommit: true` optionally commits only the approved files on `main`, and is
shown in the approval prompt. It defaults to `false`, requires `publish: true`,
refuses an already-staged index, and verifies every file before committing.
Unrelated unstaged changes are excluded. Tags, pushes, and deployment remain
separate operator actions. After approved content writes, regenerate derived
documentation with
`pnpm --filter @smithers/site sync:docs`, review the diff, and commit on `main`.

## Prepare and publish packages

Preparation audits feature and migration documentation, checks the content
approval when required, and previews a version/changelog preparation plan.
After approval it runs the existing version setter and changelog generator,
refreshes both lockfiles, and verifies coherence. It leaves the changes ready
for review and commit on `main`. Use an explicit `version`, including for
prereleases; the private root package's `0.0.0` is never the release version.
The old `bump: "patch" | "minor" | "major"` option is also accepted instead of
`version`, and resolves from the public CLI version before the run is persisted.

```sh
pnpm release:workflow --run rc-prepare --input '{"version":"1.0.0-rc.0","from":"v0.35.0","phase":"prepare","dryRun":false,"contentArtifact":".flows/releases/content/1.0.0-rc.0/<digest>"}'
```

Publication requires the requested version already committed on a clean `main`.
It runs the Smithers package/example/site/docs targets and release helper tests,
builds from clean artifacts, packs the declared 49-package train in dependency
order, and smoke-tests the same tarballs on Node 26.4.0 with npm
11.16.0. Each stage is recorded by Smithers. The smoke receipt and every
tarball must match the candidate manifest before the human approval is offered.

```sh
pnpm release:workflow --run rc-npm-preview --input '{"version":"1.0.0-rc.0","from":"v0.35.0","phase":"publish","contentArtifact":".flows/releases/content/1.0.0-rc.0/<digest>"}'
```

To request actual npm publication, use a new run with `dryRun: false`. It parks
after validation and shows the source SHA, exact candidate integrity, package
count, npm channel, and provenance setting. Prereleases use `next`; stable
versions use `latest`. The publisher rechecks source, approvals, both runtime
receipts, the complete roster, and local/registry integrity after the wait.
An already-published matching tarball is skipped; any registry mismatch blocks
the remaining train before publishing another package.

`provenance` defaults to `true`; the execution host must support the requested
npm provenance mode and have publication credentials. A host without provenance
must explicitly request `provenance: false`, which is shown in the approval.
`requireContentApproval` defaults to `true`; an explicit `false` opts out of that
separate marketing-content prerequisite, not the final publication approval.
Documentation audit failures must be fixed before preparation or publication
can continue.

`from: "auto"` asks npm for the last published `smthrs` version and resolves its
git tag. Registry failure or a missing tag fails the collection step. An explicit
`from` makes the range reproducible without that lookup. No release command
creates or pushes a tag: the existing tag-triggered GitHub publisher has not
been changed by this port.

## Approval and resume

```sh
pnpm release:status rc-content
pnpm release:answer rc-content true
pnpm release:answer rc-content false
pnpm release:content --resume rc-content
pnpm release:workflow --resume rc-prepare
```

Answer only once: `true` continues and `false` completes as declined. The answer
command uses the currently persisted token; it refuses a run that is not waiting
for approval. Status reads storage without starting the engine and shows the
review prompt. Each run has its own database under `.flows/releases/runs/<id>/`
and retains its input, model setting and budget. `--resume` reuses those settings;
changing them requires a new run. Keep `.flows/` to retain approvals and history.

A failed run retains its failure; `--resume` is not a reset of failed checks or
an uncertain external action. Correct the cause and start a new run. During a
repeat npm attempt, the registry's exact integrity determines which packages
still need publication. No secret, npm write, tag, deployment, or social post
is needed to run the test suite.

Preparation invokes the version, changelog, and lockfile tools in sequence. If
one fails after an earlier tool wrote files, inspect those partial changes
before starting another run; the workflow does not reset the working tree.

## Verification

```sh
pnpm --filter @smithers/release-workflows run check
pnpm --filter @smithers/release-workflows test
```

Tests run the production agent/QuickJS loop with a scripted model transport and
real SQLite storage. They cover approval and denial, bounded revision failure,
disabled channels, dry runs, source/artifact checks, and process restart without
redrafting. Publishing tests substitute external commands and provider calls.
The optional recorder is tested against a local HTML fixture in real Chromium.
Type checking and workflow tests are registered as `//flows:check` and
`//flows:suite`; the browser test is `//flows:recording` and requires Playwright's
Chromium and ffmpeg (`pnpm exec playwright install chromium ffmpeg`).
