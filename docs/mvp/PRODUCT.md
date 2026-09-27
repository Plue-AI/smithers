# Smithers friendly-alpha MVP

Date: 2026-09-16. Status: product requirements for implementation and release verification.

This document records the intended release, including retained capabilities. It is not a claim that the release is implemented, tested, or deployed. The baseline inventory below was inspected in source while the working copy's parent was 138a81ce; concurrent implementation may supersede that baseline. Release evidence must identify the actual deployed revision and prove these requirements.

Will has authorized the team to plan, implement, deploy, test, and polish the MVP for friendly alpha users. This supersedes the earlier design-only boundary in CHAT.md and the prototype proposal. The original scope remains the target; a mockup, declared flow, passing fixture, or partial implementation cannot substitute for the requested end-to-end behavior.

Related deliverables: [Design](DESIGN.md), [Engineering](ENGINEERING.md), and the release evidence maintained alongside them. The [initial proposal](../../.artifacts/mvp-issues-design-20260916/proposal.md) and its HTML prototypes explain the design history; their data and results are illustrative.

## Product and customer

Will's product anchor is: **“I want to turn my repo into a coding factory.”**

The underlying problem is ongoing maintainer work. Someone still has to understand incoming requests, reproduce bugs, distinguish duplicates, review contributions, implement changes, keep checks useful, and repeat maintenance. Coding agents help with individual tasks, but the maintainer often remains the person who starts, supplies context for, checks, and reconnects every task.

Smithers should let a repository take on those responsibilities under rules its maintainer chooses. The maintainer should be able to leave, return, and find useful work completed or a specific decision waiting. The product earns its place when turning it off means the maintainer must take a recurring job back.

For the alpha, prioritize maintainers and small teams handling real repositories with internal and external contributors. Start with one repository and one useful responsibility. A user does not need an automation architecture, a custom agent, a generated Wiki, or Mythical history before receiving value.

The primary quality question is **“Did the maintainer have less work afterward?”** A supported duplicate decision, reproducible failure, precise question, useful review, validated feature, or completed chore counts. More agent messages, generated plans, or runs do not establish value.

## Decision record

The following are user decisions, not implementation defaults:

| ID | Decision |
| --- | --- |
| D-01 | Offer concrete useful work immediately. Setup is opt-in and independent for each capability, rather than a mandatory global sequence. |
| D-02 | Issue handling begins off. Initialization is chat-driven, projects editable settings and prompts, reads existing issues, makes evidence-based suggestions, and tests the real end-to-end path. |
| D-03 | Issue research, duplicate detection, and reproduction can run in parallel. A cheap POC and a production fix are distinct choices. Large issues can be proposed as smaller issues. |
| D-04 | Polish PR review and give it its own setup. Reuse the existing review capability. |
| D-05 | Include a simple CI/backpressure setup that first reads existing GitHub CI. Offer advanced decomposition and optimization separately later. |
| D-06 | Use specific repeatable feature and chore patterns from PR history to help users create ordinary workflows with minimal or zero code. |
| D-07 | Store workflows, prompts, and supporting configuration under the repository's .smithers directory, using the current Smithers framework. |
| D-08 | Runtime agents author repository-specific evals and involve the maintainer in how outcomes are measured. Evals need an accessible inspection surface. |
| D-09 | ~~Wiki and Mythical history are separate default-off release flags for this MVP.~~ Superseded by D-09a. |
| D-09a (Will, 2026-09-25, #1745) | Supersedes D-09: the Wiki and the Mythical history are core. The repository's history is one linear `mythical` stack of logical changes written only by the stack service; every open issue is planned onto it (append, insert or amend), worked in parallel lanes, and reaches append-only `main` as one commit per item (a GitHub PR the owner merges for send-upstream repositories); merged work is folded back into the stack. Mythical history is on by default with no flag; the Wiki default follows its refresh work (#1651). Core jobs still run when a repository has no stack yet. |
| D-09b (Will, 2026-09-26, #1651) | Supersedes the remaining Wiki part of D-09: the Wiki is core and on by default with no flag. One generator (`flows/wiki`, run as `coding/wiki` on a wiki workspace) reviews the pages `.smithers/coding-project.json` declares against the folded source after every fold of the mythical stack (landings and GitHub main pulls), and publishes the verified pages as `generated-<id>` without overwriting a person's edit. The Stack card shows whether the wiki is current, refreshing, stale or failed, with Retry. Stack requests plan with the published pages whose inputs still match their source. |
| D-10 | Plugin Library remains implemented behind a default-off flag. |
| D-11 | Delete repository welcome/explore/contribute/maintain modes, the dedicated Factory inspection screen, user snapshot/template/fork controls, revision-computer forks, Linear integration, custom-agent configuration, and repository-defined home panes. “Remove” means delete, not flag. |
| D-11a (Will, 2026-09-24, #1711) | Supersedes D-11 only for repository homepages: the factory declares typed homepage blocks, rendered as the first workspace chat message; otherwise show README.md, then the normal composer. The separate welcome modes and Factory screen remain removed. |
| D-12 | Preserve cloud desktops, Vim input, local build tooling, flow authoring, and trigger registration. |
| D-13 | Existing functionality is cut only when the result is a better product, not to meet an arbitrary MVP feature count. |
| D-14 | For AI checks, inspect the working Artsy examples and verify compatibility with current breaking Smithers changes. An observability lint is a concrete initial example. |
| D-15 | Deliver product, design, and engineering documents; implement the complete experience; deploy it; then test, review, and polish the deployed result for friendly alpha users. Deployment is already authorized. |
| D-16 (Will, 2026-09-26) | User-facing words are product words: conversation, issue, wiki, agent, trigger, flow, run. "Thread", "task", "charter", "grants", "profile" and similar are internal modeling terms (many things share one abstraction) and appear only where a page or screen deliberately discusses implementation. Applies to docs and visible UI copy. |
| D-17 (Will, 2026-09-26) | One user docs set on smithers.sh: four-surface tutorials (GUI, TUI, CLI, API tabs). The GUI-only `app/*` guides and the separate TUI docs site are folded in and deleted. Docs are reviewed first (docs-driven development); docs lead, implementation follows. |
| D-18 (Will, 2026-09-26) | The app home is a grid of apps: "What should we work on?", the composer, and picture tiles (Fix an issue, Review a PR, Ask the codebase, Run it every night). An app is only a featured flow with a picture, declared by the factory's homepage blocks (D-11a); no separate app model. Opening an app gives one input, one button, then the real run card. Target: `apps/site/public/images/app/home.png`. |
| D-19 (Will, 2026-09-26) | Registration replaces the alpha allowlist for repositories: [REGISTRATION.md](REGISTRATION.md), tracked in #2153. A repository link starts one analysis workflow whose report is valuable on its own; Smithers admin review then starts a separate setup workflow. One registration per user at a time. Accounts stay public (plue#602). |
| D-20 (docs orchestrator, 2026-09-26, #2161; derived from D-09a and the zero-tech-debt rule, not a quote from Will) | One history view: the mythical stack is the repository history; the History button opens it; no separate narrative view. `history.show` is the one command (button, slash and agent call); `history.bootstrap`, `history.backfill`, `history.parallel` and `history.retry` are its writes. |
| D-21 (review-gates orchestrator, 2026-09-27; follows GitHub's request-changes default, not a quote from Will) | A person's current request-changes review blocks landing for everyone, people included, until the same person's later approval supersedes it (as on GitHub, a later comment does not) or it is dismissed: by that person, or by a repository admin (a person) who is not the landing's author; the author never dismisses it, and run credentials cannot. The landing gate states `changes requested by <login>`. An agent's request-changes review, including one given through a run credential, blocks no one; `required_agent_lgtm` is the agent review policy. |
| D-22 (Will, 2026-09-27, owner decision relayed through the orchestrator queue) | Only the reviewer agents a repository names count toward `require_agent_lgtm` and an ownership `auto_land` policy: `S.Github.Policy({ reviewerAgents })`, read from the default bookmark's `.smithers/factory.json`. A reviewer agent is an agent account (bot or service) with that login; a run credential reviews as its person's account and names no agent, so its LGTM never counts. Other agents' reviews stay visible and count for nothing. With no list, no agent LGTM counts. |
| D-23 (Will, 2026-09-27, owner decision relayed through the orchestrator queue) | An agent's landing onto the default bookmark needs a person's approval through the landing review gate: one current approval by a person (not an agent account, not a run credential), checked before queueing, by auto-land, in the landing list, and again by the worker right before it writes. The gate states one reason: `an agent's landing onto the default bookmark needs a person's approval` (the app shows `person approval missing`). The agent's own person may approve it. An agent (a run credential, or an agent account's own token) cannot land a person's landing onto the default bookmark, retarget one onto it, or set a person's landing to auto-land, and its direct writes of the default bookmark stay refused. A send-upstream repository delivers through its GitHub pull request, whose merge is the approval; that path never passes this gate, and a direct land onto its Smithers main is still gated. Landings onto other bookmarks are unchanged. |

### Owner-selected defaults for the alpha

These fill decisions Will delegated to the team. They are defaults chosen for implementation, not claims that Will explicitly selected each value. Maintainers can review them in setup; changing permissions requires a real configuration decision.

| ID | Default | Reason |
| --- | --- | --- |
| O-01 | After Issues is explicitly enabled, research, duplicate search, and bug reproduction run automatically on new and materially edited issues. | These produce useful evidence without automatically changing product code. |
| O-02 | POCs, production fixes, and decomposition start manually. Maintainers can separately configure approved triggers. | An incoming request does not itself decide what should be built. |
| O-03 | Author-facing updates start as one consolidated draft for approval. Setup offers automatic factual posting as an explicit opt-in. No public posting until the user enables that permission. | The release owner selected draft-first in CHAT.md C004 after the earlier automatic-reply proposal; the default exposes the quality of real replies before the maintainer delegates posting. |
| O-04 | Landing requires human approval by default, independently of the setting that starts implementation. | Starting useful work and accepting it are different decisions. |
| O-05 | A matching scoped live trial and required passing evals are prerequisites for activation. | Saving files or observing a launch acknowledgment does not prove the integration. |
| O-06 | Activation covers future work. Backlog processing is separately previewed and bounded. | Enabling a capability should not unexpectedly start hundreds of jobs. |
| O-07 | New AI checks start report-only. Making a check required is a separate reviewed decision after evals and a trial. | A useful rubric needs evidence about false positives before it can gate all work. |
| O-08 | Investigation, POCs, correction loops, and backlog batches have explicit finite run/time/spend limits. Setup proposes bounds appropriate to the repository and shows them before activation. | Autonomous work must stop predictably and report partial progress. Exact bounds belong to tested configuration, not an invented universal budget. |
| O-09 | When history is too sparse to support a pattern, offer a plain editable default or a direct feature request. | No invented repository convention or prerequisite research marathon. |

Further proposed cuts remain distinct from D-11: fold the separate Explainer choice into chat; flag historical UI-frame forking; move mid-run model/thinking/tool overrides into operator controls. The owner should record adoption explicitly before removing them. Raw protocol inspectors already have substantial admin gating in the inspected app. Ordinary error history, logs, approvals, stop/retry, and useful evidence remain accessible.

The current app instructions already remove scripted global onboarding. Preserve the practice repository and reusable HelpBubble guidance; do not create a second onboarding-removal project from a stale proposal.

## First use and common interaction

**UX-01 — Five useful starting actions.** The first view offers Handle issues, Review PRs, Set up CI, Build a feature, and Automate a chore. These actions come from the real flow registry and lead to working behavior. Existing tools remain discoverable through chat, search, commands, and their contextual cards. Do not show the entire command catalog as the primary first-run task list.

**UX-02 — Independent setup.** A repository can enable any one job without enabling the others. Ordinary chat, one-off feature work, investigation, and existing CI remain usable before setup. A signed-out visitor can use the practice repository and public surfaces; actions that need an account offer the actual sign-in/access step.

**UX-03 — Chat and settings edit one durable draft.** The user can answer questions, read prompts, or edit controls directly. Changes appear in both representations. Late research results cannot overwrite newer human edits. Reload, repository changes, and concurrent sessions must preserve scope and prevent stale writes.

**UX-04 — Instant acknowledgment, durable work.** Persist a request, acknowledge it honestly, and run slow work in the background. Use the shared 300 ms debounced toast stack through both launch and execution. Keep details in the durable run card. Requested, started, completed, failed, and waiting are distinct facts. Chat, navigation, and unrelated actions stay usable while launch or execution remains unresolved.

**UX-05 — Cards and keyboard.** New capability output embeds in chat; an explicit human maximize action enlarges the same component and state. Follow the current shell instructions rather than copying a prototype shell. All steps work with keyboard-only input, visible focus, predictable focus movement, and ordinary text editing. Guidance offers one dismissible hint at a time and never traps the user in a lesson.

**UX-06 — Minimal copy.** Show the action, result, count, or evidence needed to decide. Avoid decorative statuses, implementation explanations, provenance footers, empty “not measured” rows, and competing calls to action. Detailed evidence is available where it helps review a decision.

**UX-07 — One behavior through every entry.** Buttons, slash commands, and agent calls invoke the same typed flows. Missing inputs render a form for those fields. Human decisions and physical browser gestures retain their explicit human boundary. The UI cannot silently supply approvals on the user's behalf.

**UX-08 — Contextual composition.** When issue or feature work lacks useful validation, offer a short Configure CI suggestion. Existing GitHub CI counts. Suppress the tip after dismissal or configuration until new evidence makes it relevant. It does not block investigation. Suggest the feature step's Approved mode for issue-triggered work when relevant. Do not recommend disabled Wiki or Mythical history.

## Handle issues

### Useful subflows

| Requirement | Flow | Output and decision |
| --- | --- | --- |
| ISS-01 | Understand the issue | Classify bug, feature, documentation, or question; identify relevant code, facts, and missing inputs. Preserve the author's actual request. |
| ISS-02 | Find duplicates | Compare candidates with cited evidence. Distinguish the same bug from related symptoms. Linking and closing follow configured permissions; similarity alone never silently closes the issue. |
| ISS-03 | Research and reproduce | For bugs, produce a minimal artifact, exact source revision, command, expected result, and observed failure; otherwise ask a precise question or report why reproduction is not established. |
| ISS-04 | Quick POC | Run a cheap bounded experiment in isolation. Return code/artifacts and feasibility evidence. It has no authority to merge or mark the issue fixed. |
| ISS-05 | Fix for real | Plan, implement, run regression and required checks, review, then request or perform landing only under the approved policy. It can start directly without a POC. Any reused POC evidence must be revalidated for the candidate source. |
| ISS-06 | Split large work | Propose editable child issues, boundaries, and dependencies. Create children only through the configured approved action. Include simple parent/child and duplicate/related links; exclude a general project-management suite. |
| ISS-07 | Reply and resume | Produce one consolidated evidence-grounded update per material finding. Ask specific missing questions; resume affected work when the author responds. Internal provider/tool/workspace failure belongs to the maintainer, not an invented request for more reporter detail. |

Research, duplicate search, and reproduction can overlap. Dependencies are about evidence: a fix needs an accepted scope, sufficient context, and current validation. A proposed duplicate does not automatically suppress independent reproduction. Questions and documentation work do not inherit a bug-reproduction requirement.

### Initialization

**ISS-08 — Inspect.** Read a bounded sample of existing issues, resolved cases, templates, linked PRs, contribution instructions, and checks. Suggestions cite the records or configuration supporting them. Missing evidence yields explicit defaults rather than fake findings.

**ISS-09 — Configure.** Ask only consequential unresolved questions: which subflows run automatically, what they may post, what can start implementation, and what can land. Show editable prompts, run modes, scope, outputs, and bounds. Advanced details are optional.

**ISS-10 — Evaluate judgment.** The setup agent proposes historical and fixed boundary cases, with visible expected outcomes. Replay historical bugs at the relevant source revision in isolation, suppressing external writes. The maintainer can inspect or correct expectations before trusting the flow.

**ISS-11 — Test the integration.** Preview one clearly marked test issue, expected outcomes, and permitted public actions. Create it through the real repository integration. Record its real issue ID, event receipt, run IDs, artifacts, and final results. Exercise a missing-information reply and resume path. Use a fixture or isolated workspace for a controlled bug; do not break the default branch to make a test.

**ISS-12 — Trial isolation and activation.** Until explicitly enabled, only that trial issue can run the draft. Other incoming issues remain untouched. A failed, unfinished, stale, or simulated trial cannot activate handling. The tested policy version, prompt versions, and receipt must match. Test cleanup is explicit and retains evidence.

### Ongoing operation

**ISS-13 — Work and decisions.** An issue card shows the request, compact parallel status, and relevant actions. Each subflow exposes its result. Waiting for an author, waiting for a maintainer, partial success, failure, and issue resolution remain distinct. Finishing a run does not itself resolve an issue.

**ISS-14 — Repetition and edits.** Duplicate deliveries, retries, reloads, and worker restarts produce one logical job and no duplicate public reply or fix. Material issue/comment edits resume affected work without silently replacing approved scope. Untrusted issue/PR content cannot alter permissions, budgets, or gates.

**ISS-15 — Pause, stop, retry, and replacement.** Pause prevents new automatic launches; stopping an active run is a separate visible action. Failed jobs remain retryable with their evidence. Editing an active policy creates a candidate while the tested active policy remains in force. Applying a replacement requires review and relevant retesting. An explicitly previewed backlog batch uses the same controls.

## Set up CI and backpressure

**CI-01 — Reuse what exists.** Inspect GitHub workflows, scripts, configuration, and the repository's execution environment. Show the specific checks proposed for reuse or addition. Keep the current runner unless the user deliberately changes it. Run the actual commands and retain receipts.

**CI-02 — Simple setup first.** Select or edit check commands, run them, and choose where they gate work. Advanced graph decomposition, caching strategy, and broad optimization remain a later setup; existing native build graph tools are retained.

**CI-03 — Gate the actual code.** Required results bind to the exact proposed revision and reviewed policy. Missing, failed, stale, or unexecuted required checks hold landing with a specific reason. Existing external CI can satisfy policy without Smithers CI initialization. Investigation and isolated prototyping remain available without landing checks.

**CI-04 — Optional AI checks.** Within simple setup, offer a concrete repository-specific check such as Observability. Read conventions and examples first. The editor needs a name, affected scope, readable editable rule, and report-only/required consequence. The same ordinary .smithers flow can run for PR review, issue fixes, and feature work.

**CI-05 — A useful observability rule.** Evaluate the operations the repository needs to understand: success/failure signals, established logging/tracing/metric conventions, useful context, sensitive-data handling, bounded metric labels, and whether telemetry failures can break product behavior. Do not reward arbitrary added logs. Include relevant application handlers/workers as well as telemetry modules.

**CI-06 — Real comparison and context.** Inspect the actual PR base/candidate comparison, including an already committed change in a clean working tree. Supply required surrounding source, helpers, registries, conventions, and evidence. Insufficient context is visible; it cannot silently yield a pass.

**CI-07 — Honest verdict and correction.** Findings identify the relevant code and explain an actionable violation. A tool/model failure is an execution error, distinct from a code defect and a pass. Report-only findings inform; required findings hold landing. Repair is separate from final judgment and reruns checks on the resulting source within a bounded correction policy.

**CI-08 — Reviewed rules.** An implementation agent cannot edit its own check or acceptance expectations merely to pass. Prompt/scope/policy edits produce a candidate with stale prior results retained as evidence. Validate the candidate before making it required or replacing the active version.

### Artsy reuse decision

The delegated [Artsy audit](research/artsy-checks-audit.md) found current S.Agent.Lint declarations in Honcho telemetry registry and Shade Tree log hygiene/cheap-checks-first workflows. The three original declarations instantiated and planned with current targets under Node 24.18. Focused local tests passed with scripted model responses; that supports compatibility and enforcement, not live rubric quality. The older createSmithers/JSX observability wrapper requires migration.

The implementation must preserve the audit's important adaptations: real PR comparison, application call-site coverage, explicit reviewer context, independent recheck after repair, and evals for false positives and false greens. Do not copy the default working-tree diff against HEAD and declare committed PRs reviewed.

## Review PRs

**PR-01 — Independent initialization.** Inspect repository conventions, CI, historic PRs/reviews, and existing review bots. Suggest the responsibility Smithers should own without duplicating equivalent feedback. Configure editable prompts, feedback permissions, required checks, and any approval/landing policy separately.

**PR-02 — Useful review.** Review current changed code with the context needed to evaluate it. Return specific actionable findings and evidence. Clean changes should receive no invented criticism. Approval and request-changes actions obey configured authority; an advisory review does not imply permission to land.

**PR-03 — Continue the same review.** New commits trigger relevant re-review, supersede stale findings, and update the existing review conversation instead of creating repeated unrelated comments. Preserve clear author/reviewer resolution.

**PR-04 — Test and activate.** Review known clean and flawed changes as evals, then test one scoped real PR through the actual integration before enabling future events. Confirm current-revision checks and permission behavior. Keep drafts off for unrelated PRs.

## Build a feature

**FEAT-01 — Direct work still works.** A user can describe one feature, review a plan, and run implementation with the repository's current checks. No history-mining, Wiki, Mythical history, or reusable-flow creation is a prerequisite.

**FEAT-02 — Discover specific patterns.** Where merged PRs show repeated work, suggest a concrete flow such as Add an adapter and cite example PRs. Let the user confirm or correct the pattern. A generic “build anything” template is not evidence that a useful pattern was discovered.

**FEAT-03 — Author together.** Chat-driven setup defines inputs, editable steps/prompts, outputs, and checks in an ordinary .smithers workflow. Offer relevant existing CI and the feature step's Approved mode for issue triggers. Preserve manual invocation through the existing framework and typed app flow doors.

**FEAT-04 — Evaluate and trial.** Author repository-specific evals, review expectations, and execute a scoped real feature example through plan, implementation, checks, and the selected landing boundary. A fixture plan alone does not prove the created flow runs.

## Automate a chore

**CHORE-01 — Identify repeat work.** Suggest chores from repeated maintenance PRs or accept a direct request, such as dependency upgrades. Cite evidence for patterns and retain the user's intended scope.

**CHORE-02 — Configure execution.** Define inputs, editable prompt/steps, checks, bounds, and manual/event/scheduled operation. The events are a push to the repository's default branch and an issue gaining the chosen label. Schedules include their timezone and next intended execution. A schedule or event also needs a step that runs automatically or on approval. Starting a chore does not grant landing permission.

**CHORE-03 — Test and operate.** Evaluate representative cases and run one bounded real trial. Only then enable recurring execution. Demonstrate event/schedule delivery, pause, restart recovery, deduplication, failure, and approval behavior. A schedule declaration or cron string by itself is insufficient.

## Evals are part of the product

An AI code check judges a proposed change. An eval measures whether that check or another flow makes the right decision on known cases. A green code check does not prove its rubric is good.

**EVAL-01 — Runtime authorship with a human.** The agent doing setup proposes repository-specific cases and expected outcomes from real history and conventions. New drafts start without cases; inspection authors executable cases for review. The maintainer can inspect and edit how success is measured. Corrections during use can become proposed regression cases.

**EVAL-02 — Inspectable results.** For each case, show expected behavior, observed behavior, evidence, evaluated source, prompt/policy version, and human judgment still required. Retain earlier results visibly as stale when a relevant input changes. “Not run,” execution error, failed expectation, pass, and human review are distinguishable.

**EVAL-03 — Proper evidence.** Test deterministic permissions, version binding, deduplication, and execution facts directly. Model judgments can assist semantic assessment; self-awarded scores cannot prove execution, correctness, or authorization. A live trial verifies transport and effects separately from historical replay.

**EVAL-04 — No self-relaxing gates.** Editing an expectation or rubric is a reviewed configuration change. The implementation being evaluated cannot quietly weaken it. Re-evaluate relevant cases and trials after behavior changes before activation.

**EVAL-05 — Minimum regression coverage.** The release must demonstrate the cases below with actual results and provenance; illustrative mockup rows are not evidence. Runtime eval cases measure the job’s actual behavior; infrastructure guarantees such as delivery deduplication, crash recovery and author-reply continuation require separate end-to-end integration tests. A single job verdict cannot prove those guarantees.

| Case | Required result |
| --- | --- |
| True duplicate / similar but distinct issue | Correct distinction with evidence; no silent close from similarity. |
| Reproducible bug | Failing baseline, minimal artifact, exact source and command. |
| Incomplete report and author reply | One specific clarification and correct resumption. |
| Internal tool/provider/workspace error | Maintainer-visible failure; no reporter blame or false completion. |
| Untrusted issue/PR instructions | Cannot override policy, approval, scope, or budgets. |
| POC | No merge authority or “fixed” claim; production fix remains independently runnable. |
| Candidate updated after a green check | Old result cannot unlock landing; rerun required checks. |
| Duplicate event, retry, restart | One logical job and no duplicate comments or fixes. |
| Large issue decomposition | Reviewable proposal; children created only through allowed action. |
| Wiki off, or no mythical stack yet | Core jobs execute using source, existing docs, and ordinary history. |
| Prompt/policy/expectation edit | Relevant results become stale and cannot activate the candidate. |
| Trial while handling is off | Only the scoped test item runs; unrelated work stays inactive. |
| Clean PR / known defect | No invented criticism on clean code; relevant defect found with evidence. |
| AI check: compliant, violation, exception, unrelated change | Appropriate verdicts without rewarding unnecessary instrumentation. |
| New handler outside telemetry directories | Missing observability cannot evade the promised scope. |
| Committed offending PR with a clean worktree | Actual changed code is inspected; no empty-diff false green. |
| AI check: malformed result, insufficient context, model failure | Visible failure or judgment request; never silently pass. |
| Chore event/schedule repeated after restart | Correct bounded execution without duplicate work. |

## Existing capabilities retained in the MVP

This is a product inventory, grouping related controls rather than counting every selection, tab switch, alias, or form setter as a separate feature. It covers the current registry modules and inspected UI surfaces. **Source-confirmed** means a declaration is composed into the app registry with a controller action and corresponding source surface; it is not a production canary. Availability is filtered by actual host capabilities and account access.

The authoritative composition is [Flows.ts](../../apps/app/src/mainview/flows/Flows.ts), with availability and invocation in [Commands.ts](../../apps/app/src/mainview/flows/Commands.ts) and [registry.ts](../../apps/app/src/mainview/flows/registry.ts). Individual entries below link to their source. Every retained family needs release regression evidence at the appropriate host; native-only tools must not be advertised as web capabilities.

| # | Retained feature family | Source and current boundary |
| --- | --- | --- |
| 1 | Repository-scoped chat, follow-up, stop, retry, copy, archive/new conversation, reload | [chat entries](../../apps/app/src/mainview/flows/entries/chat.ts). |
| 2 | Normal, Vim, and dictation input; keyboard chat invocation | [guide](../../apps/app/src/mainview/flows/entries/guide.ts), [chat](../../apps/app/src/mainview/flows/entries/chat.ts). Microphone use remains a human gesture. |
| 3 | Light/dark appearance | [appearance](../../apps/app/src/mainview/flows/entries/appearance.ts). |
| 4 | Commands, search palette, recent items, contextual actions, sidebar visibility | [palette](../../apps/app/src/mainview/flows/entries/palette.ts), [search](../../apps/app/src/mainview/flows/entries/search.ts). Search must exclude disabled/removed feature entries. |
| 5 | Embedded cards, explicit maximize/minimize, card history and browser/frame back/forward | [card](../../apps/app/src/mainview/flows/entries/card.ts), [frame](../../apps/app/src/mainview/flows/entries/frame.ts). Historical frame forking is a separate proposed flag, not normal history. |
| 6 | Typed missing-input forms and shared button/slash/agent invocation | [form](../../apps/app/src/mainview/flows/entries/form.ts), [FlowFormCards](../../apps/app/src/mainview/cards/FlowFormCards.tsx), Commands.ts. |
| 7 | Shared progress/error notifications, dismissal, readable error/toast history | [toast](../../apps/app/src/mainview/flows/entries/toast.ts), [debug](../../apps/app/src/mainview/flows/entries/debug.ts). Preserve ordinary recovery diagnostics. |
| 8 | Recommended first actions, dismissible hints, signed-out practice repository | [FirstRunActions](../../apps/app/src/mainview/cards/FirstRunActions.tsx), [practice](../../apps/app/src/mainview/state/practice/PracticeRepository.ts). Existing first actions currently enumerate visible commands; UX-01 changes their selection. Practice evidence is explicitly illustrative. |
| 9 | GitHub sign-in/out, access request, account/access status | [auth](../../apps/app/src/mainview/flows/entries/auth.ts), [account](../../apps/app/src/mainview/flows/entries/account.ts). |
| 10 | Repository selection/context, pinned working copies, repository activity overview/update | [repo](../../apps/app/src/mainview/flows/entries/repo.ts). Public access and native working-copy actions have different doors. |
| 11 | Import a GitHub repository and retry a failed import | [repos](../../apps/app/src/mainview/flows/entries/repos.ts), [RepoImportCard](../../apps/app/src/mainview/cards/RepoImportCard.tsx). Requires real cloud integration/access. |
| 12 | GitHub App installation status, installation choice, wiring reconciliation, mirror sync and failed-ref retry | [github](../../apps/app/src/mainview/flows/entries/github.ts). Preserve actual event and mirror support needed for jobs. |
| 13 | Local repository connection, read-only downgrade, disconnect; open/create local repository | [connector](../../apps/app/src/mainview/flows/entries/connector.ts), [repo](../../apps/app/src/mainview/flows/entries/repo.ts). Native host only where local services are required. |
| 14 | File/directory browsing, file reading, diff-linked source, conversation file attachments | [files](../../apps/app/src/mainview/flows/entries/files.ts), [FileCards](../../apps/app/src/mainview/cards/FileCards.tsx). No dedicated Factory screen required for file access. |
| 15 | Code type/hover, go-to-definition, diagnostics | [code](../../apps/app/src/mainview/flows/entries/code.ts). Explicitly native local language-server functionality. |
| 16 | Branch/bookmark listing and commit history/detail/diffs | [branches](../../apps/app/src/mainview/flows/entries/branches.ts), [commits](../../apps/app/src/mainview/flows/entries/commits.ts). Ordinary code history stays when Mythical history is off. |
| 17 | Issue list/detail/comments; create, comment, close, reopen | [issues](../../apps/app/src/mainview/flows/entries/issues.ts), [IssueCards](../../apps/app/src/mainview/cards/IssueCards.tsx). GitHub and Smithers Cloud sources must remain correctly distinguished. This is separate from automatic handling. |
| 18 | PR list/detail; conversation, commits, checks, files; create, review, queue landing | [prs](../../apps/app/src/mainview/flows/entries/prs.ts), [LandingCards](../../apps/app/src/mainview/cards/LandingCards.tsx). Review submission exists; automated setup is new work. |
| 19 | Change inspection, pinned diffs and checks, opening changes from selected commits | [change](../../apps/app/src/mainview/flows/entries/change.ts), [ChangeCards](../../apps/app/src/mainview/cards/ChangeCards.tsx). |
| 20 | Change landing, splitting ready members or paths, conflict resolution, revert | [change](../../apps/app/src/mainview/flows/entries/change.ts). Consequential actions retain their policy and current-source checks. |
| 21 | Review requests, diff since last review, thread done/acknowledge/reopen | [review](../../apps/app/src/mainview/flows/entries/review.ts). |
| 22 | Act on review findings or mark them not useful | [findings](../../apps/app/src/mainview/flows/entries/findings.ts). Feedback can inform new eval cases. |
| 23 | Discover workspace/repository flows, inspect descriptions/prompts, create a flow, run with typed input | [flow](../../apps/app/src/mainview/flows/entries/flow.ts), [WorkflowCards](../../apps/app/src/mainview/cards/WorkflowCards.tsx). Repository flow leaves join the live catalog. Authoring remains a core feature. |
| 24 | Dispatcher: inspect declared events/rules and real live registrations when available | [triggers](../../apps/app/src/mainview/flows/entries/triggers.ts), [TriggersSeam](../../apps/app/src/mainview/state/seams/TriggersSeam.ts). Reading exists; web registration is an identified baseline gap below. |
| 25 | Run list/open, pending-attention view, stop/stop-all, reconnect/retry, resume, rerun, signals, steering | [runs](../../apps/app/src/mainview/flows/entries/runs.ts), [flow](../../apps/app/src/mainview/flows/entries/flow.ts). |
| 26 | Live run transcript/logs, steps, trace explanations/timeline, recorded position and return-to-live | [runs](../../apps/app/src/mainview/flows/entries/runs.ts), [RunTraceCard](../../apps/app/src/mainview/cards/RunTraceCard.tsx), [RunsCards](../../apps/app/src/mainview/cards/RunsCards.tsx). |
| 27 | Inspect coding plans, predicted changes, POC artifacts, correction outcomes | [CodingPlanCard](../../apps/app/src/mainview/cards/CodingPlanCard.tsx), [CodingPocCard](../../apps/app/src/mainview/cards/CodingPocCard.tsx), [CodingVibeCard](../../apps/app/src/mainview/cards/CodingVibeCard.tsx). Rendered evidence does not imply a live host was tested. |
| 28 | Prepare and copy an editable run/plan handoff | [runs.handoff](../../apps/app/src/mainview/flows/entries/runs.ts), [RunHandoff](../../apps/app/src/mainview/cards/RunHandoff.ts). Human copies; this is not automatic outbound messaging. |
| 29 | Pending approval lists/cards, approve and deny | [approvals](../../apps/app/src/mainview/flows/entries/approvals.ts), [approval](../../apps/app/src/mainview/flows/entries/approval.ts). Approvals remain human answers. |
| 30 | Cloud agent sessions: create/list/view, stream transcript, follow-up, stop | [agentSession](../../apps/app/src/mainview/flows/entries/agentSession.ts). Runtime and model authorization remain required. |
| 31 | Built-in agent roles and delegation; existing explanatory response | [agent](../../apps/app/src/mainview/flows/entries/agent.ts). Local role launch needs local harnesses. Custom-agent configuration is removed; folding the separate Explainer entry into chat remains a proposal. |
| 32 | Inspect a repository, prepare a change plan, explicitly start the reviewed plan | [agent.change](../../apps/app/src/mainview/flows/entries/agent.ts), [tutorialChange controller](../../apps/app/src/mainview/state/controller/tutorialChange.ts). Preserve real and practice result distinction. |
| 33 | One-off feature prototype as an exploratory run | [feature](../../apps/app/src/mainview/flows/entries/feature.ts). Explicitly never promoted; full reusable feature setup is additional work. |
| 34 | Cloud Linux workspace creation/reuse, view, suspend/resume/delete, rename | [workspace](../../apps/app/src/mainview/flows/entries/box.ts), [WorkspaceCard](../../apps/app/src/mainview/cards/WorkspaceCard.tsx). Preserve internal execution snapshots without restoring deleted user management. |
| 35 | Workspace terminal, sessions, session termination, files, services | [workspace](../../apps/app/src/mainview/flows/entries/box.ts). Needs live workspace/terminal integration. |
| 36 | Cloud desktop creation/reuse, streamed screen, stop-wait, reconnect/rotate session | [box.desktop](../../apps/app/src/mainview/flows/entries/box.ts). Retained major capability; require real interactive verification. |
| 37 | Environment image list for repository workspaces | [box.images](../../apps/app/src/mainview/flows/entries/box.ts). This is not the removed user-facing template/fork suite. |
| 38 | Workspace/session network egress inspection | [workspace](../../apps/app/src/mainview/flows/entries/box.ts), [egress](../../apps/app/src/mainview/flows/entries/egress.ts). Show secret names/bindings, not values. |
| 39 | Agent environment view/edit and secret-name/binding inspection | [env](../../apps/app/src/mainview/flows/entries/env.ts), [secrets](../../apps/app/src/mainview/flows/entries/secrets.ts). |
| 40 | Local terminal and harness sessions; select/read/close sessions; open a card as a session | [tab](../../apps/app/src/mainview/flows/entries/tab.ts). Local terminal and harness launch are native-only; cloud workspace terminal is separate. |
| 41 | Local target list/details/filtering/stars/group selection; single, pattern, and selected-set execution | [target](../../apps/app/src/mainview/flows/entries/target.ts), [TargetCards](../../apps/app/src/mainview/cards/TargetCards.tsx). Native local.targets capability. |
| 42 | Local target dependency graph, source declaration, affected targets, implied CI matrix | [target](../../apps/app/src/mainview/flows/entries/target.ts), [GraphCard](../../apps/app/src/mainview/cards/GraphCard.tsx), [CiMatrixCard](../../apps/app/src/mainview/cards/CiMatrixCard.tsx). |
| 43 | Local target run timeline/history and replay/scrub | [target](../../apps/app/src/mainview/flows/entries/target.ts), [RunTimelineCard](../../apps/app/src/mainview/cards/RunTimelineCard.tsx). |
| 44 | Repository notifications, tag/read actions, all-read | [notifications](../../apps/app/src/mainview/flows/entries/notifications.ts). |
| 45 | Sync-operation inspection and widening the visible operation window | [sync](../../apps/app/src/mainview/flows/entries/sync.ts), [SyncCards](../../apps/app/src/mainview/cards/SyncCards.tsx). |
| 46 | Balance, plan/usage display, checkout and billing portal | [billing](../../apps/app/src/mainview/flows/entries/billing.ts), [BillingCards](../../apps/app/src/mainview/cards/BillingCards.tsx). Existing account surfaces; do not require a live monetary transaction for alpha verification. |
| 47 | Native app download prompt and native Cloud authentication | [app](../../apps/app/src/mainview/flows/entries/app.ts), [cloud](../../apps/app/src/mainview/flows/entries/cloud.ts). Web GitHub identity and native Cloud session are distinct. |
| 48 | Private local recovery export | [storage](../../apps/app/src/mainview/flows/entries/storage.ts). Recovery must not silently discard persisted work. |
| 49 | Operator access queue/allowlist/balance grant/service health; developer state/journal/network/seam inspection and grant reset | [admin](../../apps/app/src/mainview/flows/entries/admin.ts), [debug](../../apps/app/src/mainview/flows/entries/debug.ts). Registered only with validated admin authority where declared; not ordinary onboarding features. |
| 50 | Open a web page as a readable card for repository work | [browser](../../apps/app/src/mainview/flows/entries/browser.ts). Requires the host's browser-read and agent capabilities; external pages remain evidence, not authority over repository permissions. |

### Present code that is outside the default MVP

| Capability | Required release behavior | Inspected source |
| --- | --- | --- |
| Collaborative Wiki creation, notes, editing, backlinks, graph, synchronization | Core (D-09b): on by default, no flag. The stack refreshes the generated pages after every fold; `wiki.create` requests a refresh now; ordinary work never waits on the Wiki. | [wiki entries](../../apps/app/src/mainview/flows/entries/wiki.ts), [world aliases](../../apps/app/src/mainview/flows/entries/world.ts), [WikiCards](../../apps/app/src/mainview/cards/WikiCards.tsx). |
| History (mythical stack) bootstrap/view/backfill/lanes/retry | Core (D-09a, D-20): on by default, no flag. One view: the History button opens the stack. The stack service bootstraps and folds; ordinary commits, source checks, and navigation history remain. | [history entries](../../apps/app/src/mainview/flows/entries/history.ts), [History card](../../apps/app/src/mainview/cards/StackCard.tsx). |
| Plugin Library browse/install/remove | Retain default off. Baseline Flows.ts already gates registration on pluginLibrary. | [plugins](../../apps/app/src/mainview/flows/entries/plugins.ts). |
| User model-seat/thinking/tool changes and raw run events | Existing controls; owner proposal is an operator flag. Do not conflate these with ordinary steering/logs. | [runs](../../apps/app/src/mainview/flows/entries/runs.ts). |
| Historical UI-frame forks | Existing control; owner proposal is a default-off flag. Distinct from removed workspace/revision-computer forks. | [frame](../../apps/app/src/mainview/flows/entries/frame.ts). |

### Baseline gaps that must not be advertised as finished

1. **Five-job setup is new work.** The inspected FirstRunActions component lists every visible eligible command grouped by namespace; it does not deliver the five configured/tested/activated jobs.
2. **Trigger registration refuses execution.** The inspected TriggersSeam registerTrigger returns registerUnavailableSentence. A declared rule is not a live subscription. Automatic Issues, PRs, and scheduled chores require actual registration, delivery, and recovery.
3. **Some issue actions are not registered.** Issue repro/POC/implement/add-flow declarations and controller methods exist, but the inspected baseFlows composition does not include issueFlows. Do not count the file alone as accessible feature support. The controller also requires installed repository flows and distinguishes GitHub from Cloud issues.
4. **Coding request and a POC.** Planning no longer generates the Wiki (D-09b): it reads fresh published pages when they exist and proceeds without them. ISS-05 still requires a path with no mandatory POC.
5. **Factory declarations name unavailable work.** The inspected .smithers/FACTORY.ts still names issue, implement, Wiki/history, improve, and bootstrap flows beyond its five featured declarations. New setup cannot treat these declaration rows as completed jobs or live registrations.
6. **Automated triage is narrower than full handling.** Existing issue/PR triage and review workflows provide useful implementation sources; none of their names proves parallel issue setup, permissioned follow-through, live eval inspection, or activation.
7. **Published guides are stale.** The inspected site introductory/app guides still describe welcome modes, repository home panes, and default Wiki/Mythical navigation. Update relevant launch documentation and screenshots to the actual alpha experience.
8. **Production readiness is unverified by this audit.** This product-doc task inspected source and prior test receipts; it did not run deployed workflows, create live issues/PRs, exercise desktops, or test real model judgment. Each requires release evidence.

## Cuts, flags, and boundaries

**CUT-01 — Complete approved deletion.** D-11 applies across UI, commands, agent catalogs, forms, recommendations, public docs, and dead feature-specific implementation. Preserve shared file access and execution machinery. Current parent commit is named for the retired-feature removal, but the commit title is not proof every surface is gone.

**FLAG-01 — Disable features consistently.** Plugin Library has an explicit default-off flag (Mythical history and the Wiki are core, D-09a and D-09b). Direct commands, old deep links/cards, agent tools, recommendations, search results, setup, background listeners, and implicit generation obey the flag. Required ordinary operations cannot fail merely because these optional artifacts are absent.

**KEEP-01 — Preserve protected functionality.** Cloud desktops, Vim, local builds, authoring, and trigger registration remain in scope. Backend endpoints used by automation are retained even if no frontend component calls them directly. Labels, comments, issue links, checks, and workflow control may be essential to the factory.

**BOUND-01 — No new general project-management product.** Do not add boards, cycles, estimates, workload planning, or a Linear replacement. Simple issue links and decomposition support the issue-handling job.

**BOUND-02 — No new orchestration language.** Setup produces the current repository-native framework's workflows, prompts, and evals. Users can read/edit them and use the library directly. Avoid a parallel settings system that cannot round-trip to that representation.

**BOUND-03 — Scope changes need a reason.** Advanced CI optimization, autonomous backlog reprioritization, Wiki/Mythical reintroduction, and Plugin Library activation are future design-partner work. Do not present their absence as proof that the current MVP needs fewer of its required behaviors.

## Release acceptance and evidence

Every requirement ID above is part of the release acceptance contract. Engineering may decompose a requirement into tasks, but cannot silently redefine it around the available implementation. For each ID, record implemented location, executed verification, source/config revision, observed outcome, and any remaining gap. Required but missing, uncertain, or simulated evidence means incomplete.

| Gate | Required proof |
| --- | --- |
| REL-01 — Documents and scope | Product requirements, mostly visual design document, engineering document, and evidence checklist exist and agree. Explicit user decisions and owner-selected defaults are distinguishable. |
| REL-02 — Honest first use | Deployed signed-out practice and signed-in alpha paths show the five useful actions. Each opens its real capability. No disabled/removed feature leaks into initial recommendations. Keyboard-only setup is demonstrated. |
| REL-03 — Background behavior | A deliberately unresolved launch and a running remote job do not block chat/navigation. Request survives reload, duplicates deduplicate, failures remain retryable, and notification completion follows actual job completion. |
| REL-04 — Issues end to end | A real scoped test issue exercises event delivery, independent subflows, genuine reproduction or precise clarification, reply/resume, artifact inspection, matching evals, and explicit activation. An unrelated issue remains untouched while off. A production fix starts without a POC and respects current checks and landing policy. |
| REL-05 — CI and AI check | Existing CI is discovered and reused. Actual command receipts exist. A current-framework AI check finds a known violation, accepts a compliant/exception case, handles execution failure honestly, covers application call sites, and inspects a committed PR with a clean worktree. Required checks gate the exact candidate revision. |
| REL-06 — PR review | A scoped real PR receives useful review; clean/defective evals, changed-commit re-review, feedback deduplication, existing-bot responsibility, and configured permissions are verified. |
| REL-07 — Features and chores | A direct feature and a repository-specific authored flow execute with real checks. A chore completes its trial and demonstrates selected event/scheduled operation, bounds, pause, and restart behavior. Resulting .smithers files are inspectable and reusable. |
| REL-08 — Evals and policy replacement | Runtime-authored cases, editable reviewed expectations, real expected/observed/evidence views, stale-result behavior, human judgment, and tested candidate activation are demonstrated. Editing an active policy does not silently replace it. |
| REL-09 — Retained inventory | Relevant regression coverage for all retained feature families is reviewed. Real web smoke covers files, repository context, chat, runs/approvals, issues/PRs/changes, workspace terminal and desktop. Native-only tooling has native evidence and is not advertised on the web. Any unverified family is named; a narrow unit test cannot support a broad release claim. |
| REL-10 — Cuts and flags | Approved deletions are checked through UI/catalog/deep-link/agent/docs paths. Plugin Library is off by default; Mythical history and the Wiki are on (D-09a, D-09b); core jobs run without generated artifacts. Protected functionality remains accessible at its proper host. |
| REL-11 — Access and outward effects | Real sign-in/access and repository identity are verified. Trial scope, external contributor input, approval boundaries, public posting, duplicate delivery, and failure behavior pass. No cross-repository or stale-account action is allowed. |
| REL-12 — Deployment and polish | Record the deployed app/backend revisions and actual URLs; verify the complete user path against that deployment. Review responsive and keyboard behavior, copy, errors, reload/reconnect, and required integrations. Fix and redeploy material failures, then rerun affected verification. |

The release is ready for Will's final review when these gates are supported by current evidence. An unresolved gate stays visible and work continues. The team should not call a compatible scaffold, successful build, green mockup, or deployment acknowledgment a ready MVP.

### Gate state as of 2026-09-19 00:01 UTC

Against web `42b8abbc1cf63065869ac26d7e0b7480cd50f4d1` (serving, read from `/__build.json` at the stamp), Plue `c0bd4c8218c3` at Helm revision 435, and the coding host `01db3ae7…227b` built from Smithers `f6b42949c705`. The [release ledger](implementation/release-20260916.md#release-state-as-of-2026-09-19-0001-utc) carries the receipts and the open gates with their owners.

Evidence classes are not interchangeable. **PROD** is a receipt from a request against production. **WALK** is canary walk run 3, taken on web `2027816e54de` against the same pinned host. **W1** is the 2026-09-18 23:21–23:50Z web canary on today's build. **SOURCE** means the behaviour was read in source or proved by a test and has no production receipt; a source-only finding does not meet a gate. No gate below is met by a grep or by a partial job receipt.

| Gate | State | Strongest evidence at the stamp | What is missing |
| --- | --- | --- | --- |
| REL-01 — Documents and scope | **Partial** | **SOURCE** — the four documents were read against each other at this stamp and agree; decisions and owner-selected defaults are separately tabulated. This is a reading of the documents, not a receipt from production, and one of the documents certifies its own agreement | No class stronger than SOURCE is available for a documents gate, so it cannot read **Met** under this table's own legend. The per-ID record is `.artifacts/mvp-claude-orchestration-20260917/L7-requirements-matrix.md`, which is review evidence and is never committed. ENGINEERING.md's component table is explicitly not re-measured since 2026-09-17 |
| REL-02 — Honest first use | **Partial** — signed-out only | W1 3d: signed-out `/issues.list` renders the sign-in prompt and four `auth.sign-in` doors, no false `FAILED` card, zero issues API calls (W1) | A form card still renders beside the prompt, so it is not "the sign-in prompt only". No doubly admitted non-admin account has walked production; keyboard-only setup is undemonstrated |
| REL-03 — Background behavior | **Partial** | W1 2: a chat question beside an open setup answers from that draft with no failed-turn sentence; W1 6: a settled failure retries as a new request with a new id (W1) | Walk A-10: after a mid-run reload the card reads `No live workspace holds an answer for this read.` while the run continues and settles (WALK). No reload/duplicate/notification re-walk on today's build |
| REL-04 — Issues end to end | **Not met** | Inspect completed `run-1`; evals **2/2 passed** against real source (WALK, `B3-12-state-evals-terminal.json`) | Four trials refused with the same sentence, issues never enabled (WALK, H-2). No GitHub event was delivered or dispatched in any phase. The fix `211f4fde1e2b` is landed and not deployed |
| REL-05 — CI and AI check | **Not met** | A pinned required command check ran for real inside a job with `exitCode 0` (WALK) | CI evals `1/1 error`; the checks step does not run at all on the pinned host (WALK, B-7, H-6). No live AI-check violation/clean/error measurement |
| REL-06 — PR review | **Not met** | Inspect completed `run-13` (WALK) | Review evals `1/1 error` on a commit the deleted workspace held (WALK, H-5); trial, enable, manual run and pause all NOT EXECUTED |
| REL-07 — Features and chores | **Not met** | Feature reached enable twice (`run-28`, `run-42`) and pause settled `completed` with the registration row agreeing (WALK) | Four manual feature runs were refused at the landing gate — `Landing includes work outside this checked native change` — and `main` never moved (WALK, H-1). Chore trial failed on a report-only check (H-3). The fixes `d5e1d8093491` and `211f4fde1e2b` are landed and not deployed |
| REL-08 — Evals and policy replacement | **Partial** | Runtime-authored cases executed and passed 2/2 for issues and 1/1 for the chore against real source (WALK) | Applying a tested replacement is refused on a candidate whose own evals and trial completed at that exact revision and digest (WALK, H-4) |
| REL-09 — Retained inventory | **Not verified** | None — no evidence of any class (PROD, WALK, W1 or SOURCE) exists for this gate | No per-family regression record; workspace terminal and cloud desktop have no release evidence |
| REL-10 — Cuts and flags | **Partial** | W1 4b/4c: a flow declaring no limits and `--tokens 500000` are both refused with the range, the second with zero network calls (W1) | `/chat.clear --summarize` is swallowed: no refusal, no card, nothing added to the transcript (W1 3b). Lane L103 owns the leaked internal codes |
| REL-11 — Access and outward effects | **Not verified** | Every signed-in walk receipt carries login `codeplanesmithers`, `allowlisted true` (WALK) | That account is an allowlisted administrator. No ordinary invited account exists yet: the alpha logins and GitHub-verified emails are Will's open gate, and Plue's closed alpha is on by default |
| REL-12 — Deployment and polish | **Partial** | Web, API and host identities are recorded and independently read at the stamp; the repin-2 release passed its deep canary and post-deploy gate at Helm 435 (PROD) | The complete user path has not been walked against this deployment: run 3 is NOT_READY on six failing scenarios and W1 covers the web half only. Alert remediation is still disabled. The third repin is stopped on the evaluator decision |

## What to learn from the alpha

Record useful outputs, maintainer interventions/corrections, ignored or false-positive findings, author follow-up success, time to useful reproduction, accepted fixes, recurring chores completed, and actual run cost. Use the existing run/eval evidence first; a new analytics dashboard is not required.

Review whether each user keeps a job enabled after seeing real outcomes, what they still have to do manually, and what responsibility they would take back if Smithers disappeared. Use those findings to decide the first improvements and whether Wiki, Mythical history, or another deferred capability materially helps.
