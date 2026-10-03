# T-UI-02 Setup and Settings views

Stage S1 · Size S · Depends on T-UI-01, T-FLW-08 · Unblocks T-APP-03, T-FLW-12, T-REL-02 · Issue: [#3539](https://github.com/smithersai/smithers/issues/3539)
Spec: spec.md §14.2.1, §12.1.1, §14.3 (Setup / Settings), §8.2.1 · Delta: delta.md §9 · Product: mvp.md J1, §6.1 · Props: [ui-components.md § T-UI-02](../ui-components.md)

Landed (786f9ac54).

## Goal

`SetupView` and `SettingsView` render every setup and settings state from props, so T-APP-03 only binds data and actions.

## Ownership (Will, 2026-10-02)

Design (smithers-06) owns this ticket. Engineering wires it in T-APP-03.

## Scope

In:
- Landed: `SetupView` with the seven steps in §16.2 order (`address`, `app_manifest`, `sign_in`, `repository`, `models`, `source`, `machine`), each pending, running, done, blocked with its fix link, or failed with Retry; This Mac with "No machine fits", the limiting term and its fix on one line; the three model roles ("Fast model", "Coding model", "Decisions" with "AI Gateway key"). `SettingsView` adds the Machines and TODOs-at-once steppers, health, "Notifications need HTTPS ↗" and the Obsidian last sync. Copy uses `copyText` from `@smthrs/ui` with its `execCommand` fallback.
- Remaining:
  - SettingsView's model slot renders the model-assignment card restored by T-FLW-08. T-FLW-08 deletes `views/SettingsModels.tsx` as its duplicate (minimal-code synthesis v2 ruling 5).
  - Merge `apps/app/src/mainview/styles/views/setup.css` into `styles/cards.css`.

Out:
- Installation, manifest exchange, OAuth, key storage, toolchain detection, image builds, capacity, Obsidian sync and notification permission (T-APP-03, T-FLW-12).

## Changes

- `views/SettingsView.tsx`: replace the `SettingsModels` import with a model slot that `SettingsContainer.tsx` fills with the restored card (T-FLW-08).
- Move `styles/views/setup.css` into `styles/cards.css`; delete it and its import in `styles/views.css`.
- Mounting: T-APP-03 mounts both Views through the landed `cards/SetupContainer.tsx` and `cards/SettingsContainer.tsx` and deletes `AccountCard.tsx`, `EnvCard.tsx`, `RepoImportCard.tsx` and `RepositoryChoiceCard.tsx` (pair: SetupView, SettingsView; v1 §2).

## Tests

The Setup and Settings cases in `apps/app/src/mainview/cards/views/Views.test.tsx` cover:
- the literal seven-step order, a blocked step's fix URL, a failed step's Retry;
- zero capacity: "No machine fits", the limiting term and the fix link on one line at 390 px;
- the literal "Decisions" and "AI Gateway key" labels; masked keys submit only supplied fields;
- Copy with `navigator.clipboard` absent or refused reaches the `execCommand` fallback once, with no setup or key-storage effect;
- health values, the HTTPS notice and the Obsidian last sync;
- an absent action renders no control; a disabled one shows its reason and does not dispatch.

## Acceptance
- [C-UI-12](../checks/C-UI-12.md): passes for this ticket’s phase at its stated layer.

- The tests above pass in CI at the landed SHA. `views/SettingsModels.tsx` and `styles/views/setup.css` are gone.

## Risks and notes

- The model slot waits on T-FLW-08's restore. Until then SettingsView keeps `SettingsModels`.
