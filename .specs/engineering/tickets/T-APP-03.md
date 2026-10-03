# T-APP-03 Setup and Settings cards; Add to machine image

Stage S1 · Size M · Depends on first merge: T-INS-06; rest of S1: T-INS-08, T-UI-02, T-FLW-08, T-MCH-10, T-APP-22, T-APP-02, T-GH-01, T-GH-07 · Unblocks T-APP-24, T-FLW-12, T-MCH-01, T-REL-02 · Issue: [#3497](https://github.com/smithersai/smithers/issues/3497)
Spec: spec.md §14.3 (Setup / Settings), §8.6.1, §16.2, §16.3, §1.4, §5.1.0, §5.1.1, §6.3 (`/api/install`), §7.2 (`install`), §8.2.1, §10.3.1, §10.6.2, §12.1, §4.4, §17.6, §19.3, §20.2 · Product: mvp.md J1.2–J1.4, J1.8, §6.1 Reaching the install, §6.3 Sync status, M-11, M-28, Appendix A `/settings`
Ready: 2026-10-03 smithers-8a sha256:817d04ed2e3b

## Goal
From the setup link `smthrs host start` prints, on the Mac or a LAN laptop, the owner completes setup on one card (GitHub App, repository, owner sign-in, model access) and watches **Source ready** and **Machine ready** as separate steps; afterwards `/settings` shows the same install model with the address, host limits, capacity and the laptop-agent line.

## Scope
First merge: Mount SetupContainer through its card file over InstallSeam; keep existing question/file-card path. Settings waits for rest of S1. Check: C-J1-04. First merge retains browser-private Draft/landed refresh paths; shared-card persistence and Settings replacement activate only with their later providers. Check: C-J1-04.
Later dependency integrations land dark until their providers and phase checks pass.
In:
- `setup` card: one row per §16.2 step in the order T-INS-06 reports (`address`, `app_manifest`, `sign_in`, `repository`, `models`, `source`, `machine`), each with one control and a check mark only when its event exists. A step's control enables only when the step before it is done; every row survives a reload mid-step.
  - Exchange printed /setup token for the HttpOnly setup-session cookie and redirect without token. GET /api/install uses that cookie before claim, owner session afterwards. Reuse landed refresh/reconnect at first merge; /api/live binds later. Checks: C-J1-02, C-SEC-04.
  - GitHub: the owning account first (§12.1.1), then Create the GitHub App, sign in as owner, choose the repository and install the App. An organization repository whose creator isn't an organization owner shows the URL to hand to one. "Enable squash merging on GitHub ↗" when `squash_allowed` is false.
  - Model access: provider key, AI Gateway key, optional ChatGPT sign-in. Keys go to the API once and never come back; a refused key keeps its field open with the typed reason.
  - Source ready and Machine ready as two progress rows; a failed image build keeps its reason and Retry. The listen addresses and "This Mac" with its derived limits, read-only.
- `settings` card (`/settings`, owner only): Address (bind address and public origins, applied without restart; non-localhost `http` marked "unencrypted"; the one-line callback fix when the API can't update it); GitHub (App installed, squash allowed, sync health with cause and fix); model settings; "This Mac"; Machines stepper (lower only, never above the formula); health as `smthrs host status` reports it (§20.2); one `smthrs login <origin>` line per origin.
- The owner-only `todo_daily_admissions` setting (default 12, positive integer, §10.4.1b). A raise releases queued `daily_limit` work without bypassing other gates. Check: C-STK-06.
- **New TODOs start pre-approved**, owner-only, default off, bound to T-STK-04's field; affects only TODOs created after the change.
- **Add to machine image**: Settings binds its package-name field to T-APP-02's shared `image.add` command and `addImagePackage` helper. A refused name stays in the field with its literal reason.
- Copy buttons use the `execCommand` fallback and IDs come from `getRandomValues`, so both cards work on plain HTTP (§16.3.2).
- Settings controls are hidden owner-only, `agent: never` card controls; the server authorizer enforces the owner. `/settings` from the CLI opens the card and offers no mutation path.

Out: step execution, setup token, App manifest exchange, origin validation and squash probe (T-INS-06, T-GH-01, T-INS-04); agent models (T-FLW-08); members (T-APP-06); secrets (T-APP-13); VPN, proxy, LAN CA and mDNS (never built); S2 `parallel` control (T-STK-03), notification guidance and Obsidian (T-FLW-12); host package installation.

## Changes
- Mount landed SetupContainer/SetupView through CardRenderers over InstallSeam/InstallModel at first merge; Settings/replacement waits for its phase. Change seam/model/SetupContainer/settings.setup IDs, labels and literal fixtures to app_manifest end to end, deleting InstallModel.ts:55 remapping. Only transport chooses POST /api/install/setup/app. Checks: C-J1-02, C-UI-13.
- Model settings: the Settings model section is the restored model-assignment slice of `ModelCards.tsx` (ruling 5; T-FLW-08 restores the Models section), not `views/SettingsModels.tsx`.
- Delete the cards Setup and Settings replace, in this change (pair: SetupView and SettingsView ↔ the legacy setup cards; minimal-code synthesis v1 §2): `cards/AccountCard.tsx` and `AccountCard.test.tsx`; `cards/EnvCard.tsx` and `EnvCard.test.tsx`; `cards/RepoImportCard.tsx`; `cards/RepositoryChoiceCard.tsx`, `.css` and `.test.tsx`; the `provider-accounts` body `ProviderAccountsCardBody` (`cards/SecretsCard.tsx:83`) and `ProviderAccountsCard.test.tsx`; the `connector-setup` family (`cards/SyncCards.tsx:154,270`). Remove their producers in `state/controller/account.ts`, `state/seams/EnvironmentSeam.ts`, `SecretsSeam.ts`, `GitHubSeam.ts` and `RepoImportSeam.ts`, and their entries in `CardRenderers.tsx`. `account.show` folds into Settings; every member keeps `/sign-in` and `/sign-out`; `repos.import*` stays a hidden system flow.
- Use landed flows/cardActions.ts in App.tsx and both install card files. Current main has no cards/CardActions.ts or cards/InstallCardActions.ts; remove obsolete tests/references where present. Preserve cards/installKeyAction.ts transient write-only key handling. Check: C-UI-13.
- `packages/rpc/src/Cards.ts`: kinds `setup` and `settings`; `account`, `env`, `provider-accounts`, `connector-setup` and `repo-import` move to the legacy decoder (T-APP-22).
- `flows/entries/settings.ts`: `/settings` and the hidden controls `settings.address`, `settings.capacity`, `settings.model-key`, plus the daily-admissions and pre-approval controls, each writing an actor-attributed event. Transient key input is cleared after the write and never enters card state, view state, `/api/live` frames or request logs.
- apps/app/e2e/real/setup.spec.ts (new) tests mounted Setup. e2e/playwright/repository-setup.spec.ts is absent today, not a replacement target. Check: C-J1-02.

## Tests
- Unit (`InstallContainers.test.tsx`, landed): every T-INS-06 step id and state passes through, with `blocked` and `failed` keeping their fix; a later step's action is disabled until the earlier one is done; Source ready is done only at `source.state = ready`. Every origin is listed with its scheme; non-localhost `http` is unencrypted; a refused origin carries its reason; the capacity + action is disabled at the formula value; a non-owner gets the typed `permission` refusal. After a key save, no key value is in the props or the request log.
- Integration (real PostgreSQL, production dispatcher, composed `/api/install` and setup routes): non-owner writes get literal 403 `permission` and a delegated owner gets 403 `never`, with zero writes. A setup-only session can't use owner controls. A sentinel key reaches only the write-once API and the sealed store.
- Add to machine image (from C-APP-03): the repository has `.smithers/machine.json` `{"packages": ["jq"]}` and a check that runs `figlet ok` on a base image without `figlet`. Ben's T1 fails its check with a failure naming `figlet` and `.smithers/machine.json`, class `user`. Ben's **Add to machine image** opens a private Draft "Add figlet to the machine image" whose read-only seed changes only that file, to `{"packages": ["jq", "figlet"]}`; Maya's browser shows nothing. Maya enters `Fig Let` in Settings: refused in the field with the name rule's reason, no Draft. `figlet` opens the same Draft for Maya; she commits it as T2 and merges. T2's PR diff is exactly that change; `main`'s machine recipe digest changes; Ben's retried T1 passes its check. `GET /api/branches/{b}/files/{path}` returns the literal bytes and the absent-file status without waking a machine. The control is absent from the Terminal card.
- e2e (`setup.spec.ts`): start the built bundle through T-INS-08, open its printed link on loopback and a plain-HTTP LAN origin, and complete setup through the production dispatcher, `CardRenderers`, both card files and their Views. Cover a reload during mirror and build, the callback on its initiating origin, a refused key and squash-disabled Retry, with literal step, status and error expectations.

## Acceptance
- [C-APP-03](../checks/C-APP-03.md): passes for this ticket’s phase at its stated layer.
- [C-J1-04](../checks/C-J1-04.md): S1 part at its named layer.
- [C-J1-02](../checks/C-J1-02.md): every setup step completes from the card, a failure links its fix, and Source ready and Machine ready are separate.
- [C-UI-13](../checks/C-UI-13.md): `SetupView` and `SettingsView` are reachable from `CardRenderers`; `AccountCard.tsx`, `EnvCard.tsx`, `RepoImportCard.tsx`, `RepositoryChoiceCard.tsx`, `ProviderAccountsCardBody`, the `connector-setup` family, `CardActions.ts` and `InstallCardActions.ts` are deleted.

## Risks and notes
- Pass T-INS-06's states through; don't invent a second step or error protocol. A step-id disagreement goes to smithers-8a before implementation.
- Setup may build layers and run dependency installers only inside prepare or branch machines (T-INS-02, T-MCH-10; §17.3, M-29). Settings only drafts reviewed image changes. smithers-3f reviews setup-token scope, origins and sealed keys.

## Ready checklist
1. T-INS-06 steps/authority/models/qualified preparation; terminal localhost link and landed refresh suffice, Settings/service/live/LAN later.
2. Out of scope explicitly includes step/token/App/origin/squash execution, new Views/Agent UI/members/secrets/VPN/proxy/CA/mDNS/S2 parallel/notifications/Obsidian/host installs.
3. C-J1-04: terminal link/dispatcher/CardRenderers/Setup card/View/composed install; later LAN/Settings checks. Commit literal layout/step/state/SHA/status/error/UID/role/secret fixtures; independent hashes and external effect logs supply expectations, never runtime spec/production oracles. Later checks run only with their providers.
4. smithers-b8 accepts apps/CLI/API; smithers-38 accepts packages TypeScript/public schemas; smithers-3f accepts Go/infra/security; smithers-06 accepts touched View/navigation contracts; smithers-8a accepts shared/schema/Plue seams. Will decides product-policy exceptions.
5. smithers-b8: Are question/File cards retained and Settings deletion delayed? smithers-06: Are IDs/readiness/actions preserved? smithers-38: Does app_manifest pass without alias? smithers-3f: Are scope/Origin/CSRF/sealed keys and preparation gates enforced? Record #3497; no answers recorded.
6. Assembly/OAuth/cards introduce no root step. Host processes are unprivileged; no sudo lane plist. Execution consumers inherit the complete R1–R5 inventories and named production tests in T-INS-02/T-INS-06/T-STK-01; smithers-3f accepts receipts. M-29 confines code to unprivileged machines; unvalidated branch data blocks and branch-built root code is forbidden.

