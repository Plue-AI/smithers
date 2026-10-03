# Permanent product interaction rules

## MVP scope (Will, 2026-10-02)

The product contract is [`.specs/product/overview.md`](.specs/product/overview.md)
and [`.specs/product/mvp.md`](.specs/product/mvp.md). They replace
`docs/mvp/PRODUCT.md`, which keeps only an index of the decision IDs code still
cites (M-12). A feature the spec doesn't name is a candidate to delete or defer,
decided one at a time.

- The MVP is a self-hosted, multiplayer coding factory: one install on one Apple
  Silicon Mac, for one team, wrapping one GitHub repository. Members reach it
  at the address the owner sets in Settings (M-28). Smithers Cloud, billing and plans come after the MVP (M-09).
- Everything is a flow. A button, slash command, agent action, CLI command and
  API call run the same typed flow, and the factory's process is a flow in the
  repository.
- TODOs replace the five maintenance jobs. Each TODO is one item on the
  repository's stack, worked on its own branch by the customizable TODO flow,
  and reaches `main` as one squash-merged GitHub pull request. People merge;
  agents never merge or move `main`.
- Build in the order of mvp.md §11 (walking skeleton first). Maintainers with
  outside contributors get their release one week after launch (§14); items in
  §16 are deferred with no promised release. Don't build either early.

### Superseded 2026-10-01 rulings ([#3385](https://github.com/smithersai/smithers/issues/3385))

- "Retain all five maintenance jobs" is replaced by TODOs and the customizable
  TODO flow (mvp.md §8). Keep the issue and review machinery (event admission,
  dispatch, reproduction, review, approvals) hidden but intact for the
  maintainer release, and enforce contributor trust rules from launch.
- "Smithers developing itself on Smithers Cloud" is replaced by M-31: once
  stage 1 passes J1 and J2, Smithers' own development moves onto the stack of
  the self-hosted install on Will's Mac mini. Cloud follows the MVP.
- "Remove Pair multiplayer" no longer covers shared branch access and presence,
  which return under M-17. The rest of Pair stays removed.

### Still in force (Will, 2026-10-01, [#3385](https://github.com/smithersai/smithers/issues/3385))

- Retain the build system, independent public library packages, and the wiki
  as the agent memory/source of truth, including runtime decisions stored
  outside source. Retain mirrors, Git/LFS/SSH needed by workers, jj, Mythical,
  native factory issue/landing data, and their security boundaries.
- Remove legacy forge-only customer controls, cloud desktop streaming,
  non-GitHub integrations, create-app, and Electrobun desktop distribution from
  the MVP. Preserve shared execution, headless browser/self-hosting, custom flow
  UI, and ordinary repository flow authoring when removing those surfaces.
- Remove user-facing historical fork/rewind controls, never core time-travel
  libraries or recovery/replay. Preserve decoding of existing persisted history.
- Remove TUI predictive estimates and the ordinary-user model laboratory.
  Preserve actual usage/budgets, monitors, custom UI/extensions, model APIs and
  host configuration/routing/credentials.
- Review is an ordinary `/review` flow using the shared runtime, host services
  and custom UI. It has no separate service, account, billing or model runtime;
  reviewer quizzes are out of scope. Preserve review quality and verification.
- Second-round scope ([#3404](https://github.com/smithersai/smithers/issues/3404))
  removes Pair multiplayer (except what M-17 restores), the public marketplace,
  community repository nominations, third-party OAuth application hosting,
  separate Explainer mode, personal calendar-to-notes and public traction-metrics
  flows. Preserve ordinary teams, approvals, single-user prompt queues,
  first-party login/tokens, repository-owned flows/plugins/MCP, bug intake and
  shared notes/memory.
- Keep browser IDE code intelligence and the general webpage reader. Use the
  existing Paper palette with light/dark modes and accessibility; defer the
  theme collection. Old sessions and recorded events must remain readable.
- Future restoration is explicitly blocked pending Will's authorization:
  [Pair #3401](https://github.com/smithersai/smithers/issues/3401) (except the
  shared workspace access and presence M-17 restores),
  [marketplace #3402](https://github.com/smithersai/smithers/issues/3402), and
  [themes #3403](https://github.com/smithersai/smithers/issues/3403). These open
  recovery issues are not instructions to implement or merge the features.

Task-specific maintenance guidance lives in
[the repository skill](.agents/skills/smithers-maintenance/SKILL.md): use it for
workspace graph changes, generated docs, benchmarks, and flow authoring.
Read the scoped `AGENTS.md` for app, server, or TUI files. Keep `AGENTS.md`
rules to behavior that applies throughout their directory trees.

## Maintainer workflow (Will, 2026-09-24)

- Keep communication brief; take ownership and ask only necessary questions.
  Persist durable decisions in instructions and track actionable work in issues.
- Prioritize the smallest reliable features that let Smithers develop itself
  on its own stack, on the self-hosted install on Will's Mac mini (Will,
  2026-10-02; M-31). Local agent work outside the stack is transitional
  bootstrap/repair.
- Once stage 1 passes J1 and J2, run the coding factory and change automation
  on that install, and `issue-sweep` stops pushing straight to `main` (M-31).
  GitHub keeps `main`, issues, pull requests, reviews and checks (M-22). Do not
  build a parallel GitHub Actions factory.
- Land and push work on `main`. Temporary worktrees are for one change and are
  removed after landing; no permanent integration branches or history-rewrite lanes.
- Reuse or create a GitHub issue for every actionable TODO, bug, blocker, or
  deferred requirement. Reconcile stale issues against evidence; never close an
  issue merely because code exists or a launch request was accepted.
- Keep the repository wiki current through the existing app wiki workflows.
  Refresh on source changes, retain review/source receipts, and surface failures
  or staleness. Keep code, issues, and wiki aligned through the factory.
- Keep reusable product code, public docs, reproducible benchmark evidence, and
  self-hosting in this repository. Hosted deployment/IaC, private operations, and
  marketing planning/assets belong in the private deployment repository. Public
  builds and self-hosting must not depend on private files or services.
- Ship the MVP in small, tested increments in the mvp.md §11 order, with the
  npm packages; the TUI and Smithers Cloud follow the MVP. Require actual
  release evidence; defer unreliable or undifferentiated features. Publish
  benchmark claims only with reproducible methods, artifacts, and limitations.

## Claim an issue before working it (Will, 2026-09-29)

Every agent, session, machine, and Cloud worker claims an issue before starting
it, so work is never duplicated. Use `node scripts/issue-claim.mjs
check|claim|release|comment <repo>#<n> --by <agent/session>`.

- Claim: the `in-progress` label plus the comment `Claimed by <agent/session>
  on <host> at <UTC>; expires <UTC+6h>`. If another agent holds an unexpired
  claim, do not start; pick another issue (exit 2).
- Claim again before expiry to refresh. A claim under 1 h old is kept without
  a new comment. A claim over 6 h old without a refreshing comment may be
  taken over; the tool records the takeover.
- Release when done, failed, or abandoned: remove the label and record the
  landed commit or the reason. If you post a receipt or failure comment, fold
  the release into it with `comment --body-file <f> --release --note <commit |
  reason> [--close]`, one comment. Otherwise use `release --note`.
- Post issue comments, closes, and label changes through this tool: it
  throttles writes machine-wide and backs off on rate limits. Exit 75 means
  rate limited: nothing was lost; retry after `retry_at` and do not count it
  as a failed attempt.
- The tool runs as a GitHub App, not a person, when one is configured in
  `~/.config/issue-claim/app.json` (`{"app_id", "private_key_path"}`); each
  output line's `identity` says which. Without it, writes spend the `gh`
  user's rate limits.

## Zero tech debt; one backend (Will, 2026-09-25)

No tech debt. Finish every migration in the same effort: delete the old path,
never leave two implementations of one behavior. The product backend is
`packages/backend` only; Plue composes it and adds private deployment ports.
Never add product code to Plue.

## One mythical stack; append-only main (Will, 2026-09-25)

A repository's history is one linear `mythical` stack of logical changes that
only the stack service writes (`packages/backend/internal/services/mythical*.go`).
Work is planned onto it (append, insert or amend) and reaches append-only `main`
only as one commit per item: a squash-merged GitHub PR that a maintainer
merges (mvp.md M-05). Never rewrite `main`; never write `mythical` by hand.

## Instant chat; slow work runs in the background (Will, 2026-09-15)

Chat responses acknowledge an action immediately. Repository setup, research,
planning, implementation, tests, and other slow work run in the background.
This applies equally to normal use and every tutorial/onboarding lesson.

- Persist the request and return an honest acknowledgment without awaiting the
  network request or the job. “Requested” is not “started” or “completed.”
- Use the app's shared toast stack for background progress. Follow its existing
  300 ms debounce; keep the toast running through launch AND execution, then
  resolve it from the real completion or failure. A launch acknowledgment is
  not job completion. Keep detailed output in the durable embedded run card.
- Keep Chat, navigation, and unrelated actions usable throughout. Tutorial
  actions must not strand the user behind a disabled “Researching…” button;
  offer Chat while a prerequisite runs. Advance dependent lessons only after
  their real completion receipts exist.
- Deduplicate repeated launches, reconnect persisted requests after reload,
  and ignore stale responses from an earlier tutorial playthrough. Failures
  must remain visible and retryable without claiming successful completion.
- Test with a deliberately unresolved launch and a running remote job: the
  command must return before either finishes, chat must remain usable, and
  the toast must settle only with the job. Cover failure and duplicate input.

Reference implementation: `apps/app/src/mainview/state/controller/repositorySetup.ts`.
Shared notifications: `apps/app/src/mainview/state/controller/failures.ts`.
App-specific rules: `apps/app/AGENTS.md`.

## Flow layering

`@smthrs/flow` is the fundamental library; every other flow API is a thin wrapper over it. Never add a second node or graph model.

One shape, everywhere: a file flow lives at `flows/<name>/flow.ts` and its `export default` is `Flow.make("<tag>", { description, capabilities, effects, modelInvocable?, payload, success, error?, body })` from `@smthrs/flow`. The tag is the first argument and is required, so a flow is never anonymous; a file flow declares the name its path derives.

## ⚖️ MINIMAL TEXT (Will, 2026-09-15, permanent)

Cards, panes, toasts, and lessons carry the fewest words needed to act. No explanatory prose about how the product works, no provenance footers, no rows whose value is "not measured yet", no summary sentence beside a button. Show a button, a count, or a picture instead of a sentence. Unrequested buttons and unrequested copy are defects (NO INVENTION); delete them on sight.

## Product words (Will, 2026-09-26)

Docs and visible UI copy use product words, not internal modeling terms such as thread or task. [D-16](docs/mvp/PRODUCT.md#in-force) is the rule, and the [MVP vocabulary](.specs/product/mvp.md#3-vocabulary) lists the words.

## Testing quality (Will, 2026-09-27)

- Earn 100% coverage with meaningful behavioral assertions. Cover parameter
  combinations, boundaries, error cases, cancellation, recovery, and ordering;
  coverage is necessary, never sufficient. Do not lower thresholds or hide
  production code to make a test gate pass.
- Prioritize unit tests, then integration, end-to-end, fuzz, and benchmarks.
  Unit and integration suites must each provide confidence independently.
  Integration tests use real dependencies; any mock exception needs a concrete
  justification. Exercise the terminal, browser, HTTP API, and public authoring
  API through their user-facing boundaries.
- Retain reproducible fuzz counterexamples and benchmark methods, artifacts,
  correctness checks, and limitations. Distinguish executed coverage from
  configured thresholds, skipped cases, and platform-specific evidence.
- Sonnet agents author pepper tests that probe weak classes (Will, 2026-10-02);
  GPT-6.1 Sol agents, up to thirty-two when the session permits, implement
  durable suites and fix every discovered product bug, retaining its regression
  test and validation receipts. The orchestrator reviews both.
- Track the campaign and outstanding evidence in
  [#2290](https://github.com/smithersai/smithers/issues/2290).

## Execution environments

`smthrs environment` selects persistent local, SSH, or Cloud execution locations.
Tools manage their own login in the selected home; profiles contain location
settings only. `smthrs tui` is one CLI app consuming the same location and agents.
Use this shared capability instead of provider-specific login or remote harness
commands. See [#1757](https://github.com/smithersai/smithers/issues/1757).

## Cache contracts

Enable default caching only after the executed toolchain, declared environment,
dependency inputs, and produced outputs have complete content identities.
Action-backed tools need executable identity just as native argv rules do.
Keep mutating modes and incomplete contracts fail-closed; never weaken affected
selection to compensate for missing cache contracts. Nix alone grants no
cacheability.
