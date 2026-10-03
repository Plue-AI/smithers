# T-APP-03 Setup and Settings cards; Add to machine image

Stage S1 · Size L · Depends on T-INS-06, T-UI-02, T-APP-19, T-MCH-10, T-APP-22 · Unblocks T-FLW-12, T-REL-02 · Issue: [#3497](https://github.com/smithersai/smithers/issues/3497)
Spec: spec.md §14.3 (Setup / Settings), §8.6.1, §16.2, §16.3, §1.4, §5.1.0, §5.1.1, §6.3 (`/api/install`), §7.2 (`install`), §8.2.1, §10.3.1, §10.6.2, §12.1, §4.4, §17.6, §19.3, §20.2 · Delta: delta.md §1 (Add [S1] setup card backend), §9, §10 · Product: mvp.md J1.2–J1.4, J1.8, §6.1 Reaching the install, §6.3 Sync status, M-11, M-28, Appendix A `/settings`

## Goal
From the setup link `smthrs host start` prints, on the Mac or a LAN laptop, the owner completes setup on one card (GitHub App, repository, owner sign-in, model access) and watches **Source ready** and **Machine ready** as separate steps; afterwards `/settings` shows the same install model with the address, host limits, capacity, parallel work and the laptop-agent line.

## Ownership (Will, 2026-10-02)

Design (smithers-06) builds the `SetupView` and the `SettingsView`, with the CSS, in T-UI-02. This ticket builds no View, CSS or editor presentation. It owns the topic decoder and golden fixture, the adapter, the Container and the commands in Changes ([card-kinds.md §1](../card-kinds.md)). The seam is the view model from T-APP-19 (spec §14.2.1).

## Scope

- From S2, Settings on plain HTTP outside localhost shows `notifications_need_https`, “Notifications need HTTPS ↗” and `docs {page: "quickstart#put-https-in-front"}`. Check: C-UI-09 step 3.

In:
- `setup` card on the `install` model, one row per §16.2 step in the order T-INS-06 reports, each with its one control and a check mark only when its event exists:
  - Opening: the card loads from a setup URL `smthrs host start` prints, one per listener, so the owner may finish setup on the Mac or from a LAN laptop (§5.1.0). Before an owner exists it reads `GET /api/install` with the setup token (§6.3); after the claim it subscribes to the `install` topic (§7.2);
  - GitHub: the account that owns the repository first, because it decides a user- or organization-owned App (§12.1.1); Create the GitHub App (manifest flow, step `app`), sign in as owner (step `sign_in`, the claim), then choose the repository and install the App on it (step `repository`). For an organization repository whose creator isn't an organization owner, the row says so and shows the URL to hand to one. "Enable squash merging on GitHub ↗" when `squash_allowed` is false (§10.6.2);
  - Model access: provider key, AI Gateway key, optional ChatGPT sign-in. Keys go to the API once and never come back; a refused key keeps its field open with the reason from the typed error (§6.2.3);
  - Source ready and Machine ready as two progress rows with `pct`; a failed image build keeps its reason and Retry;
  - the addresses the install listens on (loopback always, plus the bind address when set, §1.4) and "This Mac", the detected host profile with its derived limits (§8.2.1, §14.3), read-only.
- A step's control enables only when the step before it reports done; every row survives a reload mid-step (§16.2 "durable and resumable").
- `settings` card (`/settings`, owner only):
  - Address: bind address and public origins, editable, applied without a restart (§16.3.1); loopback stays bound either way (§1.4). An `http` origin other than localhost is marked "unencrypted" (§17.6). When the App's callback URLs can't be updated through the API, the row shows the one-line fix (§16.3.3);
  - GitHub: App installed, squash allowed, sync health with its cause and fix when `refused` or `limited` (§4.4);
  - model access flags; "This Mac" with its derived limits; Machines stepper (capacity; lower only, never above the formula, §8.2.1); At once stepper (`parallel`, §10.3.1);
  - health: process health, PostgreSQL size, disk free and GitHub rate budget, as `smthrs host status` reports them (§20.2);
  - the copyable `smthrs login <origin>` line for each origin.
- Copy buttons use the `execCommand` fallback and IDs come from the `getRandomValues` helper, so both cards work on a plain-HTTP origin (§16.3.2, T-INS-04).
- Address, stepper and key controls run hidden owner-only card-control commands; the server authorizer enforces the owner (§5.2.1).
- **Add to machine image** (`image.add`, in-card on Settings and on a failed step, §8.6.1): a package name field. The command reads `main:.smithers/machine.json` through `GET /api/branches/main/files/.smithers/machine.json` (absent means `{"packages": []}`), adds the name with `addImagePackage` (T-MCH-10's rule: `^[a-z0-9][a-z0-9+.-]{0,127}$`, at most 64 names, no duplicate), builds the unified diff, and opens a private Draft card (T-APP-02) titled "Add <name> to the machine image" with the diff as its read-only seed. Commit places it like any TODO. A refused name stays in the field with the rule's reason. Who: P, A, since it only opens a Draft and Commit stays `confirm` for agents (pending its Appendix B.4 row). Check: C-APP-03.
- Replaced cards (card-kinds.md §3): `account.show` folds into Settings for the owner, and every member keeps `/sign-in` and `/sign-out`; model access replaces the `env` and `provider-accounts` cards, including the ChatGPT sign-in; Setup's GitHub rows replace `connector-setup`; Setup's Source ready row replaces `repo-import`, and `repos.import*` stays a hidden system flow (Appendix B.2).

Out:
- Step execution, the setup token, the App manifest exchange, origin validation and the squash probe (T-INS-06, T-GH-01, T-INS-04).
- Agent models (`flow_config` `agent:<role>`, §11.5a; T-FLW-08); members (T-APP-06); secrets (T-APP-13).
- Any VPN or proxy check: HTTPS comes from whatever the team puts in front (§16.3.4). A LAN CA, `smthrs connect` and mDNS names are deferred and never built.
- The parallel clamp by measured capacity (T-STK-03, S2).

## Changes
- `packages/rpc/src/topics/Install.ts` (new): the `install` decoder. `packages/rpc/test/fixtures/topics/install.json` (new): the golden snapshot, which `packages/backend/internal/services/install_topic_golden_test.go` (new) compares with T-INS-06's builder on a seeded install.
- `apps/app/src/mainview/cards/containers/setupModel.ts` (new): `toSetupModel(install)`. T-INS-06 reports the seven step ids and the states the view model uses (`address`, `app`, `sign_in`, `repository`, `models`, `source`, `machine`; `pending`, `running`, `done`, `blocked{line, fix_url}`, `failed{class, message}`), so the adapter passes them through, keeping `blocked` and `failed` with their fix. It builds a step's action only when the step before it is done, and Retry on a failed step.
- `apps/app/src/mainview/cards/containers/settingsModel.ts` (new): `toSettingsModel(install, viewer)`: each origin with its scheme and an `unencrypted` flag for a non-localhost `http` origin, a refused origin with its reason and not active; the capacity action disabled at the formula value; parallel capped by capacity; health as `smthrs host status` reports it (§20.2); one laptop line per origin; `image.add`. A non-owner gets no model, and the Container shows the typed `permission` refusal.
- `apps/app/src/mainview/cards/containers/SetupContainer.tsx` and `SettingsContainer.tsx` (new): before an owner exists, read `GET /api/install` with the setup token (§5.1.0); afterwards subscribe `install`; render `SetupView` and `SettingsView` (T-UI-02).
- `packages/rpc/src/Cards.ts`: kinds `setup` and `settings` (the install is the subject). Move `account`, `env`, `provider-accounts`, `connector-setup` and `repo-import` to `LEGACY_CARD_KINDS` (card-kinds.md §2).
- `apps/app/src/mainview/flows/entries/settings.ts` (new): `/settings` and the hidden owner-only card controls `settings.address`, `settings.capacity`, `settings.parallel` and `settings.model-key`. Keys go to the API once and never enter a model or the DOM after save. `flows/entries/image.ts` (new): the in-card `image.add`.
- `packages/rpc/src/MachineJson.ts` (new): `addImagePackage(current, name) → {next, diff}`. `packages/rpc/test/fixtures/machineJson.json` (new): accepted and refused names, which the Go validator's test (`machine_json_test.go`, in T-MCH-10's follow-up; T-MCH-10 is frozen) also reads, so the two validators can't drift.
- Delete the producers card-kinds.md §3 assigns here: `cards/AccountCard.tsx` and the card path of `state/controller/account.ts`; `cards/EnvCard.tsx` and the card path of `state/seams/EnvironmentSeam.ts`; the `provider-accounts` family in `cards/SecretsCard.tsx` and `ACCOUNTS_CARD` in `state/seams/SecretsSeam.ts`; the `connector-setup` family in `cards/SyncCards.tsx` and its producer in `state/seams/GitHubSeam.ts`; `cards/RepoImportCard.tsx` and the `repo-import` card in `state/seams/RepoImportSeam.ts`. The `env.*` and `secrets.connect*` flows become Settings controls; `repos.import*` stays hidden.
- `apps/app/e2e/real/setup.spec.ts` (new) replaces `e2e/playwright/repository-setup.spec.ts`; T-CUT-01 deletes the old setup surfaces.

## Tests
- Unit (`setupModel.test.ts`): every T-INS-06 step id and state passes through unchanged, with `blocked` and `failed` keeping their fix; a later step's action is disabled until the earlier step is done; Source ready is done only when `source.state = ready`.
- Unit (`settingsModel.test.ts`): every origin is listed with its scheme, and non-localhost `http` ones are marked unencrypted; a refused origin carries its reason and isn't active; the capacity + action is disabled at the formula value; parallel never exceeds capacity; a non-owner gets no model.
- Unit: after a key save, no key value is in the model, the topic payload or the Container's request log.
- Unit (`MachineJson.test.ts`): `addImagePackage` adds one name and keeps existing names and their order; it refuses a duplicate, a 65th name and each refused name in `machineJson.json`; it creates the file when absent; the diff touches only `.smithers/machine.json`.
- Unit: every `Action.label` and `disabled.reason` the adapter emits passes C-UI-02's `lintText` (engineering's copy; the View's copy is its T-UI ticket's).
- Integration (real backend with PostgreSQL): `install_topic_golden_test.go` equals the golden; a maintainer's `settings.*` write gets 403 `permission`; `image.add` opens a private Draft whose seed equals the computed diff.
- e2e: the C-J1-02 script, including a reload during the mirror, and C-APP-03's Settings half, through `SetupView` and `SettingsView`.
- Rendering of rows, "This Mac" and the "unencrypted" mark is T-UI-02's.

## Acceptance

- [C-J1-04](../checks/C-J1-04.md): S1 part at its named layer.



- [C-J1-02](../checks/C-J1-02.md): every setup step completes from the card, a failure links its fix, and Source ready and Machine ready are separate.
- [C-UI-13](../checks/C-UI-13.md): A Container's model from a real topic parses with its schema and its actions come from `cardActions`; at each stage exit every §14.3 row of the stage is wired and no View is orphaned
- [C-APP-03](../checks/C-APP-03.md) (Settings half): Add to machine image from Settings drafts a TODO whose seed adds the package.

## Risks and notes
- Resolved: §14.3 Setup carries per-step `error {code, message, fix?}`, which holds a refused key's reason and a failed image build's error.
- The mock (`cards/Setup.tsx`, `journeys/j1.ts:118-131`) signs in before creating the App and choosing the repository; §16.2 and §5.1.1 need the repository and the App first. The adapter follows the order the steps report.
- The view's seven step ids are T-INS-06's (ui-components.md § T-UI-02). The adapter test fails on any id or state the view model lacks.
