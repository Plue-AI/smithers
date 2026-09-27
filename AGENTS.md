# Permanent product interaction rules

Task-specific maintenance guidance lives in
[the repository skill](.agents/skills/smithers-maintenance/SKILL.md): use it for
workspace graph changes, generated docs, benchmarks, and flow authoring.
Read the scoped `AGENTS.md` for app, server, or TUI files. Keep `AGENTS.md`
rules to behavior that applies throughout their directory trees.

## Maintainer workflow (Will, 2026-09-24)

- Keep communication brief; take ownership and ask only necessary questions.
  Persist durable decisions in instructions and track actionable work in issues.
- Prioritize the smallest reliable features that unblock Smithers developing
  itself on Smithers Cloud. Local agent work is transitional bootstrap/repair.
- Run the coding factory, CI/CD, and change automation on Smithers Cloud; keep
  GitHub synchronized with essential checks and issue updates. Do not build a
  parallel GitHub Actions factory.
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
- Ship small, tested MVPs of the 1.0.0 rewrite, npm packages, UI, TUI, Cloud, and
  self-hosting incrementally. Require actual release evidence; defer unreliable
  or undifferentiated features. Publish benchmark claims only with reproducible
  methods, artifacts, and limitations.

## Zero tech debt; one backend (Will, 2026-09-25)

No tech debt. Finish every migration in the same effort: delete the old path,
never leave two implementations of one behavior. The product backend is
`packages/backend` only; Plue composes it and adds private deployment ports.
Never add product code to Plue.

## One mythical stack; append-only main (Will, 2026-09-25)

A repository's history is one linear `mythical` stack of logical changes that
only the stack service writes (`packages/backend/internal/services/mythical*.go`).
Work is planned onto it (append, insert or amend) and reaches append-only `main`
only as one commit per item: a GitHub PR the owner merges for send-upstream
repositories. Never rewrite `main`; never write `mythical` by hand.

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

User-facing docs and visible UI labels say Chat or conversation, issue, flow, run, change, review comment, wiki, and request, never internal model terms such as thread, task, HumanTask, principal, grant set, or charter. Those terms belong only in type and module names and on pages deliberately about implementation (reference, concepts, package docs).
