# T-APP-03 Setup and Settings cards

Stage S1 · Size M · Depends on T-INS-06, T-UI-02, T-APP-19 · Unblocks — · Issue: to file
Spec: spec.md §14.3 (Setup / Settings), §16.2, §16.3, §1.4, §5.1.0, §5.1.1, §6.3 (`/api/install`), §7.2 (`install`), §8.2.1, §10.3.1, §10.6.2, §12.1, §4.4, §17.5a, §19.3, §20.2 · Delta: delta.md §1 (Add [S1] setup card backend), §9, §10 · Product: mvp.md J1.2–J1.4, J1.8, §6.1 Reaching the install, §6.3 Sync status, M-11, M-28, Appendix A `/settings`

## Goal
From the setup link `smthrs host start` prints, on the Mac or a LAN laptop, the owner completes setup on one card (GitHub App, repository, owner sign-in, model access) and watches **Source ready** and **Machine ready** as separate steps; afterwards `/settings` shows the same install model with the address, host limits, capacity, parallel work and the laptop-agent line.

## Ownership (Will, 2026-10-02)

Design (smithers-06) builds every visual component and its styles: `SetupCard` and `SettingsCard` views: the eight setup steps with progress, Address, model roles, This Mac, the laptop line. Engineering wires them: the `install` topic container, setup step actions, settings writes. The seam is the card's view-model schema (spec §14.2.1, T-APP-19). Design builds against it with fixture stories, and engineering doesn't edit components or CSS.

## Scope
In:
- `setup` card on the `install` model, one row per §16.2 step in the order T-INS-06 reports, each with its one control and a check mark only when its event exists:
  - Opening: the card loads from a setup URL `smthrs host start` prints, one per listener, so the owner may finish setup on the Mac or from a LAN laptop (§5.1.0). Before an owner exists it reads `GET /api/install` with the setup token (§6.3); after the claim it subscribes to the `install` topic (§7.2);
  - GitHub: the repository first, because it decides a user- or organization-owned App (§12.1.1); Create the GitHub App (manifest flow), install it on the repository, sign in as owner (the claim). For an organization repository whose creator isn't an organization owner, the row says so and shows the URL to hand to one. "Enable squash merging on GitHub ↗" when `squash_allowed` is false (§10.6.2);
  - Model access: provider key, AI Gateway key, optional ChatGPT sign-in. Keys go to the API once and never come back; a refused key keeps its field open with the reason from the typed error (§6.2.3);
  - Source ready and Machine ready as two progress rows with `pct`; a failed image build keeps its reason and Retry;
  - the addresses the install listens on (loopback always, plus the bind address when set, §1.4) and "This Mac", the detected host profile with its derived limits (§8.2.1, §14.3), read-only.
- A step's control enables only when the step before it reports done; every row survives a reload mid-step (§16.2 "durable and resumable").
- `settings` card (`/settings`, owner only):
  - Address: bind address and public origins, editable, applied without a restart (§16.3.1); loopback stays bound either way (§1.4). An `http` origin other than localhost is marked "unencrypted" (§17.5a). When the App's callback URLs can't be updated through the API, the row shows the one-line fix (§16.3.3);
  - GitHub: App installed, squash allowed, sync health with its cause and fix when `refused` or `limited` (§4.4);
  - model access flags; "This Mac" with its derived limits; Machines stepper (capacity; lower only, never above the formula, §8.2.1); At once stepper (`parallel`, §10.3.1);
  - health: process health, PostgreSQL size, disk free and GitHub rate budget, as `smthrs host status` reports them (§20.2);
  - the copyable `smthrs login <origin>` line for each origin.
- Copy buttons use the `execCommand` fallback and IDs come from the `getRandomValues` helper, so both cards work on a plain-HTTP origin (§16.3.2, T-INS-04).
- Address, stepper and key controls run hidden owner-only card-control commands; the server authorizer enforces the owner (§5.2.1).

Out:
- Step execution, the setup token, the App manifest exchange, origin validation and the squash probe (T-INS-06, T-GH-01, T-INS-04).
- Agent models (`flow_config` `agent:<role>`, §11.5a; T-FLW-08); members (T-APP-06); secrets (T-APP-13).
- Any VPN or proxy check: HTTPS comes from whatever the team puts in front (§16.3.4). A LAN CA, `smthrs connect` and mDNS names are deferred and never built.
- The parallel clamp by measured capacity (T-STK-03, S2).

## Changes
- `apps/app/src/mainview/cards/SetupCard.tsx`, `SettingsCard.tsx` (new) with tests; spread into `cards/CardRenderers.tsx`.
- `packages/rpc/src/Cards.ts`: kinds `setup` and `settings`. `packages/rpc/src/Install.ts` (new): the `install` model, with a golden fixture shared with T-INS-06's projection test.
- `apps/app/src/mainview/flows/entries/settings.ts` (new): `/settings` and the hidden controls `settings.address`, `settings.capacity`, `settings.parallel`, `settings.model-key`.
- Delete the setup surfaces this card replaces, unless T-CUT-01 already has: `cards/SetupChecklist.tsx`, `cards/RepositorySetupCard.tsx`, `state/controller/repositorySetup.ts` (1,118 lines), `flows/entries/setup.ts` (research/app-shell.md "Cut surfaces").
- `apps/app/e2e/playwright/repository-setup.spec.ts`: replace with `apps/app/e2e/real/setup.spec.ts` (new).

## Tests
- Unit (`SetupCard.test.tsx`): every row for every state of its field; a later step's control is disabled until the earlier step is done; Source ready never renders before `source.state = ready`.
- Unit (`SettingsCard.test.tsx`): the Address row lists every origin with its scheme and marks `http` ones "unencrypted"; a refused origin shows the reason and is not listed as active.
- Unit: the capacity stepper's + is disabled at the formula value; the parallel stepper never exceeds capacity; a non-owner gets the typed `permission` refusal and no card.
- Unit: no key value is in the DOM or the card payload after save.
- Unit: both cards pass the C-UI-02 product-word and minimal-text lint.
- e2e: the C-J1-02 script, including a reload during the mirror.

## Acceptance
- [C-J1-02](../checks/C-J1-02.md): every setup step completes from the card, a failure links its fix, and Source ready and Machine ready are separate.
- [C-UI-13](../checks/C-UI-13.md): A Container's model from a real topic parses with its schema and its actions come from `cardActions`; at each stage exit every §14.3 row of the stage is wired and no View is orphaned

## Risks and notes
- Spec gap: §14.3 `install` has no field for a refused key's reason or a failed image build's error. The card shows the typed error from the response (§6.2.3) until the tech lead adds them to the model.
- The mock (`cards/Setup.tsx`, `journeys/j1.ts:84-96`) signs in before creating the App; §16.2 and §5.1.1 need the App first. The card renders the order the steps report.
