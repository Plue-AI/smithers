# MVP visual design

> Superseded (Will, 2026-10-02). This is the design of the five-job MVP, which the [MVP spec](../../.specs/product/mvp.md) cuts (§8). The current design is the working mock in [`.specs/design/`](../../.specs/design/README.md). These prototypes stay as history; don't build from them.

Sections 1–11 are **design prototypes with simulated data**, rendered from the tracked interactive documents below. They make no repository, model, or API calls. Section 12 contains actual local application captures with explicitly simulated backend responses. Neither is production execution evidence. Example evals in the prototypes illustrate result views; the real app starts with no cases and its inspection agent authors executable repository-specific cases for review. Infrastructure guarantees use separate integration tests. The [2026-09-16 requirements](https://github.com/smithersai/smithers/blob/d4d2eaccab9382205f4a47e789ce560fb016b388/docs/mvp/PRODUCT.md) were the requirements authority.

Open an interactive document in a browser to explore it. Its “Prototype scenarios” controls are review tools outside the depicted product. Capability output initially embeds in chat; the large layouts below represent the same card after the user maximizes it. They do not authorize a full-screen takeover or a replacement app shell.

## 1. Start with a useful job

[Explore all five setups](mockups/start.html) · UX-01, UX-02, UX-06

![Five recommended actions: Handle issues, Review PRs, Set up CI, Build a feature, Automate a chore.](mockups/figures/01-start.png)

Each action opens its own setup. Other capabilities stay available through chat and contextual controls. Wiki, Mythical history, and Plugin Library do not appear.

<details>
<summary>Mobile arrangement</summary>

<img src="mockups/figures/02-start-mobile.png" width="366" alt="The five actions stack vertically on a narrow screen.">

</details>

## 2. Chat and settings share a draft

[Explore issue setup](mockups/issues-setup.html) · UX-03, UX-05, ISS-08, ISS-09

![Issue setup with chat beside editable flow settings, draft-first author replies, manual fixes, and human approval to land.](mockups/figures/03-issues-flows.png)

The initial choices are automatic investigation after opt-in, draft replies, manual POCs/fixes/splitting, and human approval to land. The source links support the suggestions; editing a control and answering in chat change the same draft.

## 3. Read and edit the actual prompt

ISS-03, ISS-09, EVAL-01

![Reproduction prompt, expected result, and eval expectations in the same setup card.](mockups/figures/04-issues-prompts.png)

Each flow exposes a readable prompt and the output it must produce. Editing it creates a candidate that needs relevant retesting.

## 4. Prove the setup before enabling it

ISS-10, ISS-11, ISS-12, UX-04

```mermaid
flowchart LR
    A[Inspect repository] --> B[Edit draft]
    B --> C[Review eval expectations]
    C --> D[Run evals]
    C --> E[Run scoped live trial]
    D --> F{Matching results pass?}
    E --> F
    F -->|Yes| G[Enable reviewed version]
    F -->|No| B
```

**Preview the test issue and its permitted actions.**

![Test view previews the title, body, test-only scope, public actions, and separate eval and live-trial controls.](mockups/figures/05-issues-test-preview.png)

**Work continues in the background.** Chat stays available while the launch and job are unresolved.

![Trial requested while the user can still chat and edit configuration.](mockups/figures/06-issues-trial-running.png)

**Exercise the author-response path.**

![Trial waits for missing config and offers a response action to verify resumption.](mockups/figures/07-issues-needs-author.png)

**Actual matching results unlock activation.**

![Completed trial results and required evals enable the Enable handling action.](mockups/figures/08-issues-ready.png)

**Changed behavior makes earlier results stale.**

![The previous eval and trial evidence remain visible as stale, and activation is disabled for the changed candidate.](mockups/figures/09-issues-stale.png)

A saved draft is not an active policy. A created issue is not a completed trial. The prototype timers illustrate those states; release verification must use actual event and execution receipts.

## 5. Internal failure stays with the maintainer

ISS-07, ISS-13, ISS-15

![A worker failure leaves handling off, identifies the failed reproduction, and offers Retry trial.](mockups/figures/10-issues-worker-failure.png)

“Needs author” and “worker unavailable” have different owners. An internal failure must not produce a request for more information from the reporter.

## 6. Inspect parallel work on one issue

[Explore issue work](mockups/issue-work.html) · ISS-01–07, ISS-13

![An issue shows parallel Research, Duplicates, and Minimal repro lanes. The selected reproduction has a source revision, command, expected and actual behavior, and a minimal fixture.](mockups/figures/11-issue-repro.png)

Selecting a lane reveals its output, prompt, or evals. The related issue has comparison evidence; “related” does not silently become “duplicate.”

### Choose a POC or production fix independently

![Quick POC is an isolated experiment with a bounded time limit and no landing permission.](mockups/figures/12-issue-poc.png)

![Fix for real has its own reviewed implementation action, checks, and separate approval to land.](mockups/figures/12b-issue-fix.png)

### Split only when the request warrants it

![A large feature request offers editable child issue proposals and a specific action to create three linked issues.](mockups/figures/12c-issue-split.png)

The simple bug view omits Split issue. The large feature view does not require a bug reproduction.

## 7. PR review gets its own setup

[Explore PR setup](mockups/start.html) — choose Review PRs · PR-01–04

![PR setup reuses existing review and GitHub checks, enables re-review after new commits, and configures landing independently.](mockups/figures/13-pr-review.png)

![PR-specific eval examples cover clean changes, known regressions, updated revisions, external contributions, missing checks, and repeated feedback.](mockups/figures/13b-pr-evals.png)

The setup must resolve overlap with existing review bots. After new commits, the review continues the existing conversation. Approval, feedback, and landing are separately configured.

## 8. CI starts from the repository

[Explore CI setup](mockups/start.html) — choose Set up CI · CI-01–03

![CI setup identifies the existing workflow and scripts, exposes test commands, retains GitHub Actions, and selects where checks are required.](mockups/figures/14-ci.png)

Existing checks count. Investigation can continue while CI is being configured. A missing or stale required check holds landing for the candidate code.

### Add one useful AI check

CI-04–08

```mermaid
flowchart LR
    A[Read repo conventions] --> B[Observability rule]
    B --> C[Review affected scope]
    C --> D[Edit prompt]
    D --> E[Known violation and clean cases]
    E --> F[Trial on actual PR diff]
    F --> G[Report findings]
    G --> H[Optionally require before landing]
    F --> I[Tool failure: retry or review]
```

The rule reviews relevant handlers and workers as well as telemetry code. The PR comparison includes committed changes in a clean working tree. The same check can serve issue fixes, feature work, and PR review.

The [interactive AI-check prototype](mockups/ai-checks.html) uses illustrative data and runs offline. It covers the suggested observability rule, editable scope, report/required policy, eval expectations, a scoped PR trial and retained prior results. It is design evidence, not a deployed check or a model-quality result. The [capture record](mockups/ai-check-capture-results.json) verifies local interactions, keyboard disclosure, usable Chat during simulated work and 320px fit.

![Default-off observability check with editable rule, affected paths and report policy](mockups/figures/21-ai-check-rule.png)

![Eval cases compare expected findings with the check's observed result](mockups/figures/22-ai-check-evals.png)

An eval passes when the rule correctly catches a known violation. The scope regression below deliberately produces the wrong clean result because the handler lies outside the chosen telemetry path. Activation stays blocked.

![A newly added handler outside the selected scope produces an eval mismatch](mockups/figures/24-ai-check-scope-mismatch.png)

Editing the draft retains the applied policy and its prior evidence. A tool failure is distinct from a clean result and also blocks activation.

![Edited rule retains the active report policy and old eval and trial results](mockups/figures/23-ai-check-stale.png)

![Unavailable source prevents the PR trial from passing](mockups/figures/25-ai-check-unavailable.png)

[View the 320px layout](mockups/figures/26-ai-check-mobile.png). OpenCode's original artifact remains separate; the release owner completed this tracked prototype while that handoff was pending.

## 9. Turn recurring feature work into a flow

[Explore feature setup](mockups/start.html) — choose Build a feature · FEAT-01–04

![Feature setup proposes Add an adapter from example PRs, exposes the name and prompt, shows implementation/check/review steps, and offers the step's Approved mode for issue-triggered feature work.](mockups/figures/16-feature.png)

A direct feature request also works without a discovered pattern. The reusable flow has its own evals and trial; authoring it does not activate an issue trigger.

## 10. Give a repeated chore a tested routine

[Explore chore setup](mockups/start.html) — choose Automate a chore · CHORE-01–03

![Dependency-update chore setup derives a recurring task from prior PRs, exposes an editable prompt, and separates the schedule from landing permission.](mockups/figures/17-chore.png)

![Chore evals cover compatible updates, breaking upgrades, no-op updates, and duplicate schedules.](mockups/figures/17b-chore-evals.png)

The schedule exposes timezone and next run. A chore remains off until its trial and evals pass. Pause prevents future launches; active work has its own stop action.

## 11. Review what the flow is getting wrong

[Explore evals](mockups/evals.html) · EVAL-01–05

![Eval inspection separates expected behavior, observed behavior, and evidence. A worker-failure case shows an incorrect reporter-facing reply and blocks activation.](mockups/figures/18-evals-failure.png)

**Improve the prompt without rewriting the expectation to excuse the failure.**

![A proposed prompt change addresses the failed worker-handling behavior while retaining the eval evidence.](mockups/figures/19-evals-prompt.png)

**Keep the old result visible after editing.**

![The new candidate marks prior case results stale and still shows the observed failure and evidence from the previous run.](mockups/figures/20-evals-stale.png)

The runtime agent authors repository-specific cases. The maintainer can edit expectations deliberately; relevant changes require review and rerun. A model score does not prove that a command ran, a reply was posted, or permission was respected.

## 12. Implemented setup in the app

The actual bundled app, SQLite persistence and typed commands are exercised by [six browser scenarios](../../apps/app/e2e/playwright/repository-setup.spec.ts). Backend replies are fixtures; these captures verify UI behavior, not repository work. [Capture provenance](implementation/README.md).

**320px, after editing and reloading.** Selecting a repository closes the drawer and returns focus to its opener.

<img src="implementation/setup-preview-320.png" width="320" alt="Actual mobile issue setup with the prompt preserved after reload and no drawer covering the form.">

**Chat remains available over setup.** Cmd/Ctrl-K opens one top composer; Escape and outside presses close it.

![Actual app with the floating Chat composer over the setup card.](implementation/setup-composer.png)

**Run a configured step.** Source, issue number and prompt are separate from the tested policy. Setup and job execution have distinct observed run links.

![Actual enabled issue setup with Fix for real selected, Smithers issue 42, an editable work prompt, and separate Setup run and Job run links.](implementation/setup-manual-work.png)

**Pause requires testing a new revision.** Prior results remain inspectable; passing evals alone cannot re-enable the job.

![Actual paused setup with eval results visible and Enable issue handling disabled until the new draft completes its live trial.](implementation/setup-paused-evals.png)

**Select a PR before testing CI or review.** Both independent setups use a source and number; their trial stays disabled until a PR is selected.

![Actual CI trial with Smithers selected and PR number 42.](implementation/setup-ci-trial.png)

<details>
<summary>PR review uses the same selector</summary>

![Actual PR review trial with source and PR-number controls.](implementation/setup-review-trial.png)

</details>

## Implementation handoff

The mockups communicate behavior and hierarchy. Use the existing shell, shared card/state model, HelpBubble guidance, keyboard conventions, and progress stack in the application. Review-scenario controls above exported mockups never become product UI.

| Needs final visual treatment | Required behavior already specified |
| --- | --- |
| AI-check rule/scope/eval editor | CI-04–08; offline interactive prototype and six rendered states above. Actual integration and live rubric quality remain separate verification. |
| Active policy versus replacement draft | ISS-15, EVAL-04; retain active policy, show candidate version and stale evidence, test before Apply changes. |
| Pause/stop and selected backlog batch | ISS-15; prevent new launches separately from stopping active work; preview scope and bounds. |
| PR review after contributor updates | PR-03; show current revision and continuing feedback, with stale findings distinguished. |
| Direct feature request without history | FEAT-01; ordinary description → reviewed plan → real execution, without forcing reusable-flow creation. |
| Deployed keyboard and narrow-screen verification | UX-05; local six-scenario checks pass, including drawer focus and 320px setup. Repeat on the deployed site and finish the shared HelpBubble's narrow copy layout. |

These are visual follow-through items, not permission to omit the corresponding requirements. [Engineering](ENGINEERING.md) and release evidence must show the actual implemented paths.

Figure generation, source provenance, prototype-only checks, and offline opening instructions are in [mockups/README.md](mockups/README.md).
