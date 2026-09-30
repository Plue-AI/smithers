# UI and flow issue evidence, 2026-09-30

Shared checkout: `/private/tmp/smithers-burndown-20260930`, based on `77c8b6af91`.
Node 26.5.0, Bun 1.4.2. No landing, release, deployment, hosted model run, or
aggregate release cohort is established by these checks. Source hashes are in
`source-sha256.txt`; Logs are retained as exact gzip-compressed bytes (`*.log.gz`); named installed
test results and the compressed prior review request are retained here.

## #3162: wrapped terminal ask

The current TUI uses `FlowFormView` for asks; the old `AskFormView` and `askHeight`
paths no longer exist. Its one-row, non-wrapping heading clipped a long question.
The regression in `3162-before.log` reproduces that defect at 80×24.

Ask headings now use OpenTUI's word wrapping and native cell-width measurement,
with the current pane width, before allocating rows to fields. The heading's
height is bounded to preserve the focused answer and error. Other flow headings
retain their previous layout. Tests cover a multi-row question, Unicode and
explicit newlines, an oversized question, error visibility, and real native
input callbacks. The production TUI's keyboard path answers wrapped questions
at both 80×24 and 80×12.

From `apps/tui`:

```sh
bun test test/app-view.test.tsx test/form.test.ts test/key-dispatch.test.ts
bun test e2e/help.test.ts
pnpm exec tsc -p tsconfig.json --noEmit
pnpm exec eslint src/app-view.tsx src/app.tsx --max-warnings=0
```

The broad three-file unit run had two existing composer-label failures: those
assertions expect lowercase `sol`, while the current model registry shows
`GPT-6 Sol`. A disposable copy of the unchanged HEAD view reproduces both
failures (`3162-unrelated-composer-baseline.log`). The final scoped run is
**202 passed, 2 filtered, 0 failed**; this is not a broad-suite pass. All four
production PTY scenarios pass, including the two pre-existing ask/cap cases.
Typecheck, scoped source ESLint, formatting and diff checks pass.

Historical Fable review attempts were blocked. `claude -p --model fable` returned
`Credit balance is too low`; the subscription route with the two Anthropic auth
variables unset returned `You've hit your session limit`. Both exact failures
are retained. The user removed the stale Fable requirement on 2026-09-30.
The orchestrator reviewed the change and executed evidence.

## #3136: installed default app template

Four missing changes from the reviewed candidate were restored: pinned
`happy-dom`, the public `@smthrs/create-app/ui` import, removal of the repository
UI alias, and the shipped dependency/import regression. The strict chat fixture
already matched the reviewed candidate and was left unchanged. All five source
hashes exactly match `template-final-source-sha256.txt`; the prior exact-source
Fable request/result and request-only recording diff are retained here.

From `packages/smithers/create-app`:

```sh
pnpm exec vitest run --config vitest.config.ts
pnpm exec tsc -p tsconfig.test.json --noEmit
node scripts/build.mjs
pnpm pack --pack-destination <candidate-directory>
```

The configured full suite passes **295 tests in 24 files**, with executed
100% statements (700/700), branches (321/321), functions (145/145), and lines
(627/627). Test typecheck and scoped formatting pass. These template/test paths
are ignored by source ESLint; no template ESLint pass is claimed.

A fresh current-source create-app pack was combined with 49 unchanged,
integrity-checked artifacts from the prior candidate. Every packed default
template file checked against the shared source is byte-identical
(`3136-shipped-source-hashes.json`). The retained installed-consumer helper
served those artifacts from a disposable registry and generated an app with
each manager. Both **npm and pnpm pass 17 tests in 5 files**, real routes lint,
and the shipped TypeScript 7.0.2 check. Named JSON receipts require the strict
chat replay and page render suites to execute successfully. The installed
dependency trees contain one Effect copy; the generated app uses their public
package exports, without source-checkout aliases or provider network calls.

This focused installed rehearsal does not certify the latest aggregate runtime
cohort, publication, or a deployed app. Those release receipts remain required.

## Existing fixes and remaining evidence

| Issue | Executed check                                                                                                                                        | Remaining acceptance                                                                                                                |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| #3102 | 227 app tests pass across flow planning, controller, Plan/Run cards and run forms, including typed-input admission and pinned workspace continuation. | Successful hosted Plan → plan-card Run; prior fresh-box readiness failure remains a blocker. Source already landed in `d4c55b279b`. |
| #3134 | 11 tests pass: fresh repository catalog, compiled host prompt inclusion and controlled invocation through its real cell loop.                         | Newly pinned deployed runtime and owner Review a PR result. Source already landed in `c0f8d89767`.                                  |
| #2552 | Real initial/schema-correction/citation-repair provider-request regression passes, 1 test. No prompt, classifier, threshold, schema or gate changes.  | Retain the existing frozen-source audit's terminal failure; no second audit was run.                                                |

The #2552 issue's retained normal audit `wiki-f277d85a-fe05-4fd1-9a3e-46a9d8921788`
used frozen `origin/main` `9f04f3f215` and failed the citation gate for
`runtime/section-2`. Two line-35 runtime re-export citations were judged
`unrelated` (NodeRuntime confidence 0.83, BunRuntime 0.8). That result is evidence
of failure, not wiki approval; the deterministic request test does not replace
it. Its issue comment dated 2026-09-30T06:15:01Z remains the terminal receipt.
