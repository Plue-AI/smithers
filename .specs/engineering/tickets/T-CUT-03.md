# T-CUT-03 Hide deferred surfaces: billing, TUI, multi-repository, triggers

Stage S1 · Size S · Depends on T-CAT-01 · Unblocks — · Issue: [#3447](https://github.com/smithersai/smithers/issues/3447)
Spec: spec.md §0 ([D] list), §6.1.2, §6.1.3, §6.2.4, §11.7, §14.6 · Delta: delta.md §8 (Hide triggers), §10 (billing routes; TUI Defer) · Product: mvp.md §8 (Defer rows: hosting and billing, repository switching, TUI), Appendix B.2, §6.14, §14, §16, M-09

## Goal
A member of the install can't reach billing, the TUI, repository switching, triggers or any other spec §0 [D] surface from any door: palette, `/help`, agent tools, MVP CLI docs, the skill or the launch docs. Deferred code that Appendix B keeps still builds and its tests still run.

## Scope
In (app paths under `apps/app/src/mainview/`; backend paths under `packages/backend/internal/`):
- **Billing** (M-09):
  - Appendix B.2 marks `billing.*` and `cloud.*` Cut, so T-CAT-01's allowlist forbids registering them. Delete `flows/entries/billing.ts`, `cards/BillingCards.tsx`, `BillingPlans.test.tsx`, `cards/AnonymousCeilingCard.tsx`, `state/controller/auth-billing.ts` and `e2e/playwright/phone-paywall.spec.ts` (delta.md §10 app row).
  - Backend billing routes stay for Plue. `compose/router.go:591,993-1023` mounts them only with `BillingCapabilities`, which are empty unless a commerce option is passed (`compose/main.go:448-456`), so the install serves none. Their OpenAPI rows carry `x-composition: plue` (§6.2.4).
- **TUI** (Defer from launch):
  - `smthrs tui` (`packages/smithers/src/Cli.ts:266`) is absent from the MVP CLI docs and the generated skill;
  - `apps/tui-docs` stays out of the launch docs and the quickstart;
  - the TUI binaries (`packages/smithers/scripts/build-tui-binaries.mjs`) aren't part of the launch release gate; building continues (`packages/smithers/PACKAGE.ts:13-19`).
- **Multi-repository** (Defer):
  - Appendix B.2 marks `repo.choose`, `repo.create`, `repo.select`, `repo.overview` and `repo.update` Cut: delete their entries in `flows/entries/repo.ts` and `cards/RepositoryChoiceCard.*`.
  - `repos.import*` and `cards/RepoImportCard.tsx` are Hide: setup's mirror step uses them, with no member door.
  - `smthrs org *` (18 `Definitions.ts` entries) stays out of the MVP docs and skill (B.5).
  - `/api/orgs*` stays 404 on the install through `RejectTenantProvisioning` (`middleware/single_owner.go:21`). Rename the file to `tenant_routes.go` when T-ACC-01 removes the single-owner wording.
- **Triggers** (§11.7 [D]): app `triggers.*` (`flows/entries/triggers.ts:76-186`) and `cards/TriggersCard.tsx` have no member door; `smthrs triggers` (`packages/smithers/src/operator/Triggers.ts`) stays out of the MVP docs and skill; the registrar and engine are untouched.
- **Other [D] rows with a door today** (Appendix B.2 Defer): `box.egress`, `box.services`, `box.images` and `egress.*` (the Machine view); `runs.signal` (signals by hand); `prs.review` and `review.request|unrequest|since-mine|done|ack|reopen` (in-app review); `issue.repro|poc|add-flow|flows` (maintainer release, mvp.md §14). Each is `hidden`.
- `cuts.json` (T-CUT-01) gets a `deferred` section listing each hidden surface above. C-CUT-01 asserts that each is absent from every door and still present in source.

Out:
- Building triggers, the Machine view, signals by hand, agent permission/tool/budget editing, browser notifications or line comments (§0 [D]).
- The marketing site's `pricing.astro` and `refunds.md`.
- The org and team ACL in Plue's composition.

## Changes
- Visibility comes from T-CAT-01's allowlist: none of these ids is in Appendix A, so all are hidden. This ticket removes the remaining non-catalog doors:
  - `App.tsx` shell slots and toast actions that open billing or repository choice;
  - the anonymous-ceiling paywall card;
  - any triggers field on the Flow card (§14.3 lists none).
- `docs/api/openapi/*.yaml`: `x-composition: plue` on every `/api/billing*` row, then re-bundle with `scripts/openapi-bundle.mjs`.
- `packages/smithers/src/Cli.ts`: `tui`, `triggers` and `org` join the hidden list (mechanism from T-CAT-02), so skill sync and the generated MVP command page exclude them.
- `apps/app/e2e/real/coverage/deferrals/{billing,triggers,repo,repos}.ts`: mark the reason "deferred: mvp.md §8/§16" so the real-e2e gate expects no door.
- Docs: launch docs and the quickstart (T-DOC-01) link neither `apps/tui-docs` nor billing. Run `pnpm docs:check`.

## Tests
- Unit: the deferred half of `packages/rpc/src/catalog/Cuts.test.ts`. Each deferred id is absent from the visible catalog, agent tools, `catalog.mvp.json`, the generated SKILL.md and the MVP command page, and still present in `FLOW_NAMES` or the CLI tree.
- Integration: `compose/billing_capabilities_test.go` (new). The install composition with no commerce option serves no `/api/billing*` route, and `/api/orgs` answers 404. The Plue composition with a commerce option serves every `x-composition: plue` billing row.
- Unit: `packages/smithers/test/Tui.test.ts` stays green, which shows the TUI still builds.

## Acceptance
- [C-CUT-01](../checks/C-CUT-01.md)

## Risks and notes
- **Billing decision.** overview.md's open question (hide vs delete) is answered by spec §6.2.4 and Appendix B.2: the routes stay for Plue, unmounted on the install; the app's billing entries are Cut. Observation that confirms a mistake: Plue's hosted billing scripts (`~/plue/scripts/billing-test-mode-*.py`) or composition test (`~/plue/apps/backend/internal/composition/composition_integration_test.go`) fail against this change.
- If hiding misses a door, the real-e2e coverage gate (`e2e/real/coverage/gate.ts`) or C-CUT-01 shows a reachable deferred id. Both must run.
