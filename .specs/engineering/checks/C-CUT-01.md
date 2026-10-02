# C-CUT-01 Cut surfaces are absent from every door; deferred surfaces are hidden but still build

Proves: mvp.md §8, Appendix B (Cut and Defer rows), §12 release item 3, §6.4 "Commands" (debug and admin never reach members), M-09, M-17 (branch locks) · spec.md §0 ([D] list), §6.1.2, §6.1.3, §6.2.4 · Layer: unit+integration · Stage: S1, S2 · Tickets: T-CUT-01..03, T-MCH-05, T-CUT-02, T-CUT-03
Automation: `packages/rpc/src/catalog/Cuts.test.ts` (new, unit) and `packages/backend/internal/compose/cut_routes_test.go` (new, integration) · Runs in: CI

## Setup
- The source tree at the commit under test.
- `packages/rpc/src/catalog/cuts.json`. It has one entry per mvp.md §8 row and Appendix B Cut or Defer row, with decision `cut`, `deferred` or `hidden`, and lists the app flow ids, card kinds, CLI paths, route patterns (method plus path) and docs paths for that row.
- The backend router composed in-process twice, as `openapi_conformance_test.go:150` does: the install composition (`auth.mode=selfhost`, no commerce option) and the Plue composition (multitenant, with a commerce option).
- `docs/api/openapi.yaml`, freshly bundled by `scripts/openapi-bundle.mjs`.

## Steps
1. Unit, app: build the app registry. Collect `FLOW_NAMES` (`flows/FlowName.ts`), the card renderer kinds (`cards/CardRenderers.tsx`), the `Cards.ts` kinds, and the visible sets (slash, palette, `/help`, agent tools).
2. Unit, CLI: build `makeCli()`. Collect every command path, the generated SKILL.md section, and the generated MVP command docs page.
3. Unit, source: for each `cut` entry, `rg` its listed file paths and component names under `apps/app/src`.
4. Integration, routes: walk the served routes of both compositions. Read the documented operations and their `x-composition` from `openapi.yaml`.
5. For each `deferred` entry, check that its ids still exist in source and that its tests are present (`packages/smithers/test/Tui.test.ts`, `TriggersCard.test.tsx`).

## Pass when
- **`cut` entries** (including `billing.*`, `cloud.*` and `repo.choose|create|select|overview|update`):
  - absent from `FLOW_NAMES`, renderer kinds, `Cards.ts` kinds, every visible set, every CLI path, the skill and the MVP docs page;
  - step 3 finds 0 files;
  - a deleted route is absent from both routers and from `openapi.yaml`.
- **Plue-only routes** (`/api/admin/*`, `/api/billing*`): absent from the install router; served by the Plue router; documented with `x-composition: plue` (§6.2.4).
- **`deferred` entries** (TUI, triggers, the Machine view, signals by hand, in-app review, issue automation): absent from every visible set, the skill and the MVP docs page, and present in source with their tests still running.
- `/api/orgs` answers 404 on the install router.
- **`hidden` entries:** absent from every visible set, the skill and the MVP docs. Routes may still be served and documented.
- `TestOpenAPIDescribesEveryServedRoute` passes for each composition against its own rows.
- Branch-lock routes (`/api/repos/.../branch-locks*`) are absent from both routers and from `openapi.yaml` (T-MCH-05).

## Fail when
- A deleted card still renders through an old persisted card kind.
- A cut route is deleted from code but left in `docs/api/openapi/*.yaml`, or the reverse.
- An admin or billing route is deleted outright, and Plue's admin CLI or billing scripts break.
- A route the install serves carries `x-composition: plue`, or a Plue-only route lacks it.
- `/api/agent/turn*` is removed as an "agent session" route.
- A deferred surface is deleted instead of hidden.
- A hidden command reaches the agent through `discloseToAgent`.

## Evidence
Written to `.artifacts/checks/C-CUT-01/<UTC timestamp>/`:
- `report.json` (each `cuts.json` entry × each door: present or absent);
- `install-routes.txt` and `plue-routes.txt`;
- the `openapi.yaml` diff against `main`;
- `bun test` and `go test -json` outputs;
- the commit SHA.
