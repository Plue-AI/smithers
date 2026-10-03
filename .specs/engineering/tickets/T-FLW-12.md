# T-FLW-12 Obsidian folder sync as a Settings control

Stage S2 · Size S · Depends on T-ACC-03, T-APP-03, T-UI-02, T-CAT-01 · Unblocks — · Issue: [#3463](https://github.com/smithersai/smithers/issues/3463)
Spec: spec.md §13.3, §14.3 (Settings) · Delta: delta.md §9 · Product: mvp.md §6.11 Obsidian (v2.5), J8
Ready: 2026-10-03 smithers-8a sha256:eaa1a2ee5b61

## Goal
The owner points the wiki at a folder on the install's Mac from Settings. Obsidian edits in that folder become page revisions, and app edits appear in the folder.

## Ownership (Will, 2026-10-02)
Reuse T-UI-02's landed Obsidian row in `SettingsView`; smithers-06 owns its action and props seam. This ticket builds no View. Reshape T-APP-03's existing Settings adapter and install snapshot, and add the hidden owner-only `settings.obsidian` control to T-CAT-01's catalog. Reuse `packages/rpc/src/SettingsCard.ts`'s existing optional `obsidian` model. smithers-b8 accepts the command and install API contract; smithers-38 signs off any public schema change under §21.1; smithers-3f accepts worker composition and path-security decisions. Owners review the questions in the Ready checklist; recorded owner answers stand and review is post hoc under Will's 2026-10-03 directive.

## Scope
In:
- An owner-only Settings control for the folder path.
- The worker reads `wiki_sync.obsidian` from `install_settings` instead of host config.
- Attribution of imported edits to the owner, with repository write access rechecked on every pass by the existing worker.
- Lands dark until T-ACC-03: refuse settings writes and start no sync pass without owner-session authorization; never fall back to repository permissions.
- Lands dark until T-APP-03: omit the action and start no sync pass without the persisted install setting, repository scope and Settings snapshot contract. Do not fall back to host config in the Mac composition.
- Lands dark until T-CAT-01: omit the control and refuse its route dispatch without the owner-only, person-only descriptor. Build against these specified contracts; C-J8-03 covers each unavailable-provider refusal before enabling it.

Out:
- Laptop access to the vault over git ([D], spec §13.3).
- Notion or any other adapter (cut).
- A second watcher, importer, Settings container or RPC schema; vault git publication, Obsidian plugins or scripts; host package installation or elevated filesystem access.
- S3 wiki live transport (T-COL-09). S2 imports use the existing revision conflict guards; this ticket does not build a Yjs bridge.

## Changes
- Reshape `packages/backend/internal/compose/main.go:1623` and `packages/backend/internal/services/wiki_sync_host.go:65` to load the current folder from `install_settings` (key `wiki_sync.obsidian`) on each pass and apply changes without restart. Reuse the existing sync loop and durable reconciliation. `packages/backend/internal/config/wiki_sync.go:15` retains the host-config folder list for Plue only (spec §6.2.4).
- Reuse `packages/backend/internal/services/wiki_sync_obsidian.go:27` (`NewObsidianSync`) unchanged as the only sync adapter (minimal-code synthesis, 2026-10-03, v2 reuse). Validate the canonical folder is a directory owned by the install user and outside canonical `$STATE` before persistence and each pass. Retain the adapter's symlink, hardlink, path-containment and content-limit refusals. Rejected settings do not replace the active folder. Check: C-J8-03.
- Enable the existing wiki by default in the Mac composition; retain `packages/backend/internal/config/wiki_sync.go:43`'s feature-flag validation for Plue. Refuse sync when wiki storage or authority is unavailable. Check: C-J8-03.
- Extend T-APP-03's specified `PUT /api/install` with settings key `wiki_sync.obsidian` and reshape `apps/app/src/mainview/flows/entries/settings.ts` for hidden `settings.obsidian` (Owner, person-only, `agent: never`, no CLI mutation door). Register its descriptor through T-CAT-01. The `install` snapshot gains `wiki_sync {obsidian?: {path, last_sync_at?, error?}}`. Reshape `apps/app/src/mainview/state/seams/InstallModel.ts:57` (`settingsCardModel`) and `apps/app/src/mainview/cards/SettingsContainer.tsx` to map it to the existing RPC `obsidian` field and bind the row through `cardActions`. smithers-06 accepts the row-action mapping before any View seam adjustment. No `toSettingsModel` function exists today. Check: C-J8-03.
- Docs: one quickstart paragraph, "Open the wiki in Obsidian".

## Tests
- C-J8-03: extend the planned `apps/app/e2e/real/wiki-obsidian.spec.ts` through the mounted Settings row, production command dispatcher, install router, real PostgreSQL and production sync worker. Pin literal Markdown, frontmatter and attachment bytes. Set a folder, import a disk edit as an owner-attributed revision within the default 60 s interval, and export an app edit without changing frontmatter or attachment bytes. Change folders through Settings without restart and prove the old folder stops syncing.
- C-J8-03 route cases: send `PUT /api/install` through the production install router as owner, non-owner and delegated agent. Only the owner session may persist the folder; refused callers create no setting or filesystem effect. Remove each dark provider in turn and assert no sync pass or mutation. Revoke the owner's repository write access and prove the next pass refuses.
- C-J8-03 path cases through the same route and worker: missing directory, foreign-owned directory, `$STATE`, a symlink alias into `$STATE`, replaced folder, symlink escape and shared hardlink. Refuse with a typed error, preserve the prior setting, and leave outside files unchanged. With malicious vault Git configuration, assert no repository helper executes on the host.
- Extend `apps/app/src/mainview/flows/entries/settings.test.ts` through `createAppController` and `commands.submit` for `settings.obsidian`: one literal `PUT /api/install` request from the owner row; absent non-owner action; delegated execution refused; path, last sync time and error reach the mounted row. Expectations are committed literals, never parsed from spec Markdown or derived from production code at runtime.
- C-J8-03 concurrency case: edit the same page in the app and folder during a pass; the existing expected-revision guard refuses a stale import without dropping the app edit. No direct adapter invocation substitutes for the route-to-worker acceptance path.

## Acceptance


- [C-J8-03](../checks/C-J8-03.md)
- [C-UI-13](../checks/C-UI-13.md): the existing Settings View remains reachable without duplicate rendering. C-J8-03 and this ticket's dispatcher tests prove Obsidian wiring and role gates; no spec-derived inventory test.

## Risks and notes
- smithers-3f accepts S2 conflict handling using existing revision guards. T-COL-09 owns S3 live reconciliation; its integration must preserve concurrent edits rather than replace a live document. No S3 dependency gates this S2 ticket.
- Security pre-review owner: smithers-3f. The shipped sync worker runs as the unprivileged install user and treats vault Markdown, frontmatter, attachments and local Git metadata as data. No step in this ticket runs as root, so there are no root-step inputs from main or a branch. Do not execute vault hooks, plugins, scripts or repository helpers on the host; repository code executes only in machines (§1.3, M-29). Review `packages/backend/internal/services/wiki_sync_git.go:81`'s existing provenance plumbing and retain its read-only, no-filter behavior and fsmonitor refusal. Any remaining repository-configured execution path blocks enablement until the C-J8-03 malicious-config case proves refusal. No host execution fallback.

## Ready checklist
1. Dependencies: T-ACC-03 supplies authorization, T-APP-03 the install settings/API and adapter contract, T-UI-02 the reused View/schema seam, and T-CAT-01 the called descriptor contract. Scope names fail-closed dark behavior for every unlanded integration; no enablement-only dependency is added.
2. Exclusions: laptop git access, other adapters, duplicate sync/UI/schema code, vault publication and plugins, host elevation, and S3 live transport are explicit.
3. Boundary tests: C-J8-03 uses Settings → production dispatcher → install router → worker with real PostgreSQL; settings.test.ts uses the production controller. Literal fixtures pin bytes, requests, roles and refusals; no runtime spec or implementation-derived oracle.
4. Decisions: smithers-b8 accepts command and HTTP contracts; smithers-38 approves public schema changes; smithers-06 accepts the View seam; smithers-3f accepts worker, path security and S2 conflict handling. T-COL-09 owns S3 reconciliation.
5. Owner pre-review questions (post hoc under Will's directive; recorded answers stand): smithers-06: does the existing row accept the settings.obsidian action mapping and show refusals? smithers-b8: does the hidden person-only command dispatch one authorized PUT and update the install snapshot? smithers-38: can the existing SettingsCard schema be reused without a public API change? smithers-3f: does each pass revalidate path and owner access, including folder replacement; can provenance plumbing execute any vault-configured host helper; do revision conflicts preserve the app edit?
6. Security: unprivileged shipped host code treats vault content as data; repository execution stays in machines. No root step or root input exists. smithers-3f reviews containment, authority and Git-plumbing execution refusals, proved through C-J8-03.

