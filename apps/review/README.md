# smithers review

Agent code review that reads like a story.

`smithers review` runs one review agent per changed file, then a narrator
agent writes a walkthrough of the whole change: chapters in logical reading
order, prose explaining why each group of files changed, diffs embedded at
the right point in the narrative, and Mermaid diagrams wherever structure
changed. The output is a single self-contained HTML file you can open,
share, or publish to a hosted URL.

Pointed at a GitHub pull request, it also posts the review onto the PR: the
narrative summary as the review body, and every finding as an inline comment
with a ` ```suggestion ` block when there is replacement code to apply.

Findings never fail the build. smithers review reports; humans decide.

## Add it to your repo

One workflow file. No secrets, no Anthropic account, no smithers checkout.
The service authenticates your repo through GitHub OIDC, runs the agents on
our metered inference, posts the review, and hosts the walkthrough.

1. **Register your repo.** v0 accounts are operator-issued while billing is
   built out (early repos are subsidized). Open an issue titled
   `review access: <org>/<repo>` on
   [smithersai/smithers](https://github.com/smithersai/smithers/issues) or
   contact the maintainers.

2. **Add `.github/workflows/smithers-review.yml`:**

```yaml
name: smithers review
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
  issue_comment:
    types: [created]

permissions: {}

concurrency:
  group: smithers-review-${{ github.event.pull_request.number || github.event.issue.number }}
  cancel-in-progress: true

jobs:
  review:
    permissions:
      id-token: write       # proves your repo's identity to the review service
      contents: read        # check out the PR
      pull-requests: write  # post the review
    uses: smithersai/smithers/.github/workflows/review.yml@main
```

Keep the workflow on `pull_request`. Never switch it to
`pull_request_target`. Review seats receive untrusted diffs and have no tools
or repository access. Keep the job on the less-privileged PR event.

The job calls smithers' reusable review workflow by name; it cannot run its
own steps. On `pull_request`, GitHub takes this file from the pull request, so
anyone who can push a branch could edit it. The service therefore accepts only
tokens whose `job_workflow_ref` is
`smithersai/smithers/.github/workflows/review.yml@refs/heads/main`, which a
job gets only by calling that workflow. A token from any other workflow is
refused with `403 oidc: untrusted workflow`. To trust a different workflow
(for example your own at your default branch, which only `issue_comment`
reviews carry), ask the operator to set your registration's
`allowedWorkflowRefs`.

3. **Trigger a review.** Comment on any PR:

```
@smithers review
```

Only accounts with write, maintain, or admin permission on the repository
can trigger reviews; comments posted by bots or through GitHub Apps never do.
The action reads the commenter's permission with the job's `GITHUB_TOKEN`
(no extra workflow permission) and skips with a warning if GitHub does not
answer. Only new comments trigger; editing a comment does not. Repos
registered in `auto` mode skip the comment and review every non-draft PR
push. Registration requires an explicit `auto` or `comment` mode. It is set on
your registration, so switching never touches your workflow file.

### Reviewer quiz

High-impact changes get a short comprehension quiz: 3–6 multiple-choice
questions a reviewer can answer only if they actually read and understood
the change. It is honor-system — nothing blocks a merge on the score.

The quiz auto-triggers when the assessed impact is **high** or
**critical** (security-sensitive paths, schema/migration changes, risky
added code, critical findings, sheer size, …); the specific reasons behind
the assessment are listed in the walkthrough. Force it with `--quiz on`,
disable it with `--quiz off` (CLI), or set the `quiz:` action input.
Quiz generation uses a model independently of `--no-review` and `--no-narrate`.
For offline use, pass all three: `--no-review --no-narrate --quiz off`.

After taking the quiz in the walkthrough, copy the attestation (your
score) into a PR comment so the author knows the review was earned.

### Plans and quota

Subscriptions meter reviewed PRs — a monthly per-repo PR allotment set on
your registration; the status comment shows remaining quota.
Re-reviewing a PR that already counted this month is free. When the quota
is spent, the action skips with a notice instead of failing your checks.

### Your own provider key (self-run only)

Provider keys are for self-run use; Smithers Cloud does not offer
bring-your-own-key. To pay a model provider directly, run the review yourself,
[from the terminal](#run-it-from-the-terminal) or in
[self-hosted CI](CONTRIBUTING.md#self-hosted-ci-your-own-credentials), where
the CLI reads the provider key from your own environment.

## Run it from the terminal

`review` is not a Smithers engine verb. This package ships its own bin,
`smithers-review`, which runs the same flow against any repo on your machine:

```sh
node apps/review/bin/smithers-review.mjs --help
```

```sh
# review the working tree of a repo, write .smithers-review/walkthrough.html
smithers-review /path/to/repo

# review a branch against main, open the walkthrough when done
smithers-review /path/to/repo --from main --to HEAD --open

# review one commit
smithers-review /path/to/repo --commit abc1234

# review GitHub PR #123 and post the review onto it (via gh)
smithers-review /path/to/repo --pr 123

# publish the walkthrough to the share service and print an unlisted URL
smithers-review /path/to/repo --pr 123 --publish

# no seats: deterministic story, no review findings (works offline)
smithers-review /path/to/repo --no-review --no-narrate --quiz off
```

See [review commands](docs/commands.md) for the comment trigger and offline flags.

The repo path defaults to the current directory. Seats are `provider:model`
strings, and the provider ahead of the colon decides which credential is read:

| Variable | What it sets |
| --- | --- |
| `SMITHERS_REVIEW_SEAT` | Reviewing and verifying seat. Default `anthropic:claude-sonnet-4-5`. |
| `SMITHERS_REVIEW_CHEAP_SEAT` | Narrating and quizzing seat. Default `anthropic:claude-haiku-4-5`. |
| `SMITHERS_REVIEW_VERIFY_SEAT` | Overrides the verifying seat alone. |
| `SMITHERS_REVIEW_NARRATE_SEAT` | Overrides the narrating seat alone. |
| `SMITHERS_REVIEW_QUIZ_SEAT` | Overrides the quizzing seat alone. |
| `ANTHROPIC_API_KEY` | Credential for `anthropic:` seats. |
| `OPENAI_API_KEY` | Credential for `openai:` seats. |
| `OPENROUTER_API_KEY` | Credential for `openrouter:` seats. |
| `ANTHROPIC_BASE_URL` | Sends `anthropic:` seats to a proxy origin instead of `api.anthropic.com`. |

`--publish` needs a publish service URL in `SMITHERS_REVIEW_PUBLISH_URL` and an
API key (`srk_…`, operator-issued) in `SMITHERS_REVIEW_PUBLISH_TOKEN`; both can
also be set in `~/.smithers-review.json`.

## The service

The hosted side is a Cloudflare Worker at `https://review.jjhub.tech`:
session minting from GitHub OIDC tokens, an Anthropic-compatible metered
inference proxy, walkthrough hosting on R2, and usage accounting in D1.
Design: [src/server/README.md](src/server/README.md).

Not built yet, tracked as issues: Stripe subscriptions, self-serve signup
and key management, the `review.smithers.sh` domain.

## Contributing

Architecture, the publish service, self-hosted CI setup with your own
credentials, diff rendering exports, and the test suites are documented in
[CONTRIBUTING.md](CONTRIBUTING.md).

See [proxy budget admission](docs/proxy-budget.md) for supported requests,
reservation limits and settlement recovery.
