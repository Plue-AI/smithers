# T-CUT-03 Hide deferred surfaces: billing, TUI, multi-repository, triggers; delete the TUI docs site

Stage S1 · Size M · Depends on T-CAT-01 · Unblocks T-MNT-01, T-REL-02 · Issue: [#3447](https://github.com/smithersai/smithers/issues/3447)
Spec: spec.md §0 ([D] list), §6.1.2, §6.1.3, §6.2.4, §11.7, §14.6 · Delta: delta.md §8 (Hide triggers), §10 (billing routes; TUI Defer) · Product: mvp.md §8 (Defer rows: hosting and billing, repository switching, TUI), Appendix B.2, §6.14, §14, §16, M-09

## Goal
A member of the install can't reach billing, the TUI, repository switching, triggers or any other spec §0 [D] surface from any door: palette, `/help`, agent tools, MVP CLI docs, the skill or the launch docs. Deferred code that Appendix B keeps still builds and its tests still run. The TUI's standalone docs site, `apps/tui-docs`, is deleted (M-35).

## Scope
In (app paths under `apps/app/src/mainview/`; backend paths under `packages/backend/internal/`):
- **Billing** (M-09):
  - mvp.md §8 (Smithers Cloud hosting, billing, balance, plans, checkout) and Appendix B.2 (`billing.*`, `cloud.*`) say **Defer**: hidden, code kept for Smithers Cloud. `flows/entries/billing.ts`, `cards/BillingCards.tsx`, `BillingPlans.test.tsx`, `cards/AnonymousCeilingCard.tsx`, the billing paths of `state/controller/auth-billing.ts` and `e2e/playwright/phone-paywall.spec.ts` stay in source with no member door, and their card kinds (`balance`, `billing-plans`, `anonymous-ceiling`) stay live ([card-kinds.md §3](../card-kinds.md)). delta.md §10's app delete row predates that product decision.
  - Backend billing routes stay for Plue. `compose/router.go:591,993-1023` mounts them only with `BillingCapabilities`, which are empty unless a commerce option is passed (`compose/main.go:448-456`), so the install serves none. Their OpenAPI rows carry `x-composition: plue` (§6.2.4).
- **TUI** (Defer from launch):
  - `smthrs tui` (`packages/smithers/src/Cli.ts:266`) is absent from the MVP CLI docs and the generated skill;
  - delete `apps/tui-docs`, the tui.smithers.sh playground and GIF recorder (ruling: tech lead, prompted by smithers-b8, under M-35: the standalone docs site is removed). Remove its references in the same change: the docs lane's three targets in `scripts/ci/cloud.sh:590-597` and their expectations in `scripts/ci/cloud.test.ts:84-86,557-604`; the `tui` journey in `apps/site/scripts/journeys/capture.mjs:18,120`; the pages it generates, `apps/site/src/content/docs/docs/tui/commands.mdx` and `keys.mdx`, unless T-DOC-01 has removed them; `apps/tui/docs/recordings/` and the recording sections of `apps/tui/docs/README.md` and `testing.md:130-135`, which only `apps/tui-docs` runs (`rg "docs/recordings" apps/tui` finds no other consumer); `CONTRIBUTING.md:55-57`; the FFmpeg note in `scripts/ci/environment-nix.test.ts:162-165`; `factory/wiki/pages/tui-docs.md`; and the lockfile entries (`pnpm install`). The TUI app stays deferred and keeps building. Owner: smithers-b8;
  - the TUI binaries (`packages/smithers/scripts/build-tui-binaries.mjs`) aren't part of the launch release gate; building continues (`packages/smithers/PACKAGE.ts:13-19`).
- **Multi-repository** (Defer):
  - mvp.md §8 (Repository switching and multi-repository management) and Appendix B.2 mark `repo.choose`, `repo.create`, `repo.select`, `repo.overview` and `repo.update` **Defer**: hidden, code kept. Their entries in `flows/entries/repo.ts`, `cards/RepositoryChoiceCard.*`, `cards/RepositoryUpdateCard.tsx` and `flow.create`'s repository choice (`workflow-repo`) stay with no member door; their card kinds stay live.
  - `repos.import*` is Hide: setup's mirror step uses it, with no member door. Its `repo-import` card is replaced by Setup's Source ready row (T-APP-03).
  - `smthrs org *` (18 `Definitions.ts` entries) stays out of the MVP docs and skill (B.5).
  - `/api/orgs*` stays 404 on the install through `RejectTenantProvisioning` (`middleware/single_owner.go:21`). Rename the file to `tenant_routes.go` when T-ACC-01 removes the single-owner wording.
- **Triggers** (§11.7 [D]): app `triggers.*` (`flows/entries/triggers.ts:76-186`) and `cards/TriggersCard.tsx` have no member door; `smthrs triggers` (`packages/smithers/src/operator/Triggers.ts`) stays out of the MVP docs and skill; the registrar and engine are untouched.
- **Hidden developer tools** (§8 Hide): `sync.ops.*` and its `sync-ops` card have no member door.
- **Other [D] rows with a door today** (Appendix B.2 Defer): `box.egress`, `box.services`, `box.images` and `egress.*` (the Machine view, whose `environment-images` card stays live); `runs.signal` (signals by hand); `prs.review` and `review.request|unrequest|since-mine|done|ack|reopen` (in-app review); `issue.repro|poc|add-flow|flows` (maintainer release, mvp.md §14). Each is `hidden`.
- `cuts.json` (T-CUT-01) gets a `deferred` section listing each hidden surface above. C-CUT-01 asserts that each is absent from every door and still present in source.

Out:
- Building triggers, the Machine view, signals by hand, agent permission/tool/budget editing, browser notifications or line comments (§0 [D]).
- The marketing site's `pricing.astro` and `refunds.md`.
- The org and team ACL in Plue's composition.

## Changes
- Visibility comes from T-CAT-01's allowlist: none of these ids is in Appendix A, so all are hidden. This ticket removes the remaining non-catalog doors:
  - `App.tsx` shell slots and toast actions that open billing or repository choice;
  - the shell slot that shows the anonymous-ceiling paywall (the card stays in source);
  - any triggers field on the Flow card (§14.3 lists none).
- `docs/api/openapi/*.yaml`: `x-composition: plue` on every `/api/billing*` row, then re-bundle with `scripts/openapi-bundle.mjs`.
- `packages/smithers/src/Cli.ts`: `tui`, `triggers` and `org` join the hidden list (mechanism from T-CAT-02), so skill sync and the generated MVP command page exclude them.
- `apps/app/e2e/real/coverage/deferrals/{billing,triggers,repo,repos}.ts`: mark the reason "deferred: mvp.md §8/§16" so the real-e2e gate expects no door.
- The `apps/tui-docs` deletion and its reference removals listed in Scope; `cuts.json` lists it as a `cut` entry with its docs paths.
- Docs: launch docs and the quickstart (T-DOC-01) link no TUI docs site and no billing. Run `pnpm docs:check`.

## Tests
- Unit: the deferred half of `packages/rpc/src/catalog/Cuts.test.ts`. Each deferred id is absent from the visible catalog, agent tools, `catalog.mvp.json`, the generated SKILL.md and the MVP command page, and still present in `FLOW_NAMES` or the CLI tree; each deferred card kind stays in `CurrentCardSchema`.
- Integration: `compose/billing_capabilities_test.go` (new). The install composition with no commerce option serves no `/api/billing*` route, and `/api/orgs` answers 404. The Plue composition with a commerce option serves every `x-composition: plue` billing row.
- Unit: `packages/smithers/test/Tui.test.ts` stays green, which shows the TUI still builds.
- Unit: `scripts/ci/cloud.test.ts` passes with the docs lane running no `//apps/tui-docs` target; outside `.specs/`, the `docs/mvp/implementation/` receipts and recorded fixtures (`flows/test/fixtures/*.jsonl`), `rg -l "tui-docs" --glob '!**/node_modules/**' .` finds nothing.

## Acceptance
- [C-CUT-01](../checks/C-CUT-01.md)

## Risks and notes
- **Billing decision.** overview.md's open question (hide vs delete) is answered by spec §6.2.4 and Appendix B.2: the routes stay for Plue, unmounted on the install; the app's billing entries are Defer (hidden, code kept, mvp.md §8), not Cut. Observation that confirms a mistake: Plue's hosted billing scripts (`~/plue/scripts/billing-test-mode-*.py`) or composition test (`~/plue/apps/backend/internal/composition/composition_integration_test.go`) fail against this change.
- If hiding misses a door, the real-e2e coverage gate (`e2e/real/coverage/gate.ts`) or C-CUT-01 shows a reachable deferred id. Both must run.
