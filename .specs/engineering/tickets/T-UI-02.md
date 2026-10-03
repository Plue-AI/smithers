# T-UI-02 Setup and Settings views

Stage S1 · Size S · Depends on T-UI-01, T-FLW-08 · Unblocks T-APP-03, T-FLW-12 · Issue: [#3539](https://github.com/smithersai/smithers/issues/3539)
Spec: spec.md §14.2.1, §12.1.1, §14.3 (Setup / Settings), §8.2.1 · Delta: delta.md §9 · Product: mvp.md J1, §6.1 · Props: [ui-components.md § T-UI-02](../ui-components.md)
Ready: 2026-10-03 smithers-8a sha256:98958518d6ba

Landed (786f9ac54).

## Goal

`SetupView` and `SettingsView` render every setup and settings state from props, so T-APP-03 only binds data and actions.

## Ownership (Will, 2026-10-02)

Design (smithers-06) owns presentation and CSS decisions. smithers-b8 accepts the app-local model-slot seam and its T-FLW-08/T-APP-03 cutover. smithers-8a decides changes to the documented props or scope; this ticket adds no public library API. Engineering wires it in T-APP-03. Owner review follows the parallel-build directive; record answers in #3539, without treating unlanded dependencies as a Ready blocker.

## Scope

In:
- Landed: `SetupView` with the seven steps in §16.2 order (`address`, `app_manifest`, `sign_in`, `repository`, `models`, `source`, `machine`), each pending, running, done, blocked with its fix link, or failed with Retry; This Mac with "No machine fits", the limiting term and its fix on one line; the three model roles ("Fast model", "Coding model", "Decisions" with "AI Gateway key"). `SettingsView` adds the Machines and TODOs-at-once steppers, health, "Notifications need HTTPS ↗" and the Obsidian last sync. Copy uses `copyText` from `@smthrs/ui` with its `execCommand` fallback.
- Remaining:
  - Reshape the existing SettingsView to take an optional app-local React model slot. Reuse T-FLW-08's restored model-assignment card; do not build another model editor. Coordinate deletion of `views/SettingsModels.tsx` with T-FLW-08 at the slot cutover (minimal-code synthesis v2 ruling 5).
  - The CSS move is complete: setup rules are in `apps/app/src/mainview/styles/cards.css`; `styles/views/setup.css` and `styles/views.css` are absent. Reuse these rules.
  - Land dark against the T-UI-01 and T-FLW-08 contracts when either dependency is unavailable: no new production mount or action binding in this ticket; an absent model slot renders no model controls and never falls back to SettingsModels. Exclude model-assignment actions from the unassigned-action fallback. T-APP-03 supplies the restored slot only when T-FLW-08's owner-session guards and checks pass. C-UI-12 covers the empty slot and zero dispatch; T-APP-03 owns production reachability.

Out:
- Installation, manifest exchange, OAuth, key storage, toolchain detection, image builds, capacity calculation and enforcement, Obsidian sync and notification permission (T-APP-03, T-FLW-12).
- Production mounts, subscriptions, catalog registration, authorization and container wiring (T-APP-03); model-card restoration and model writes (T-FLW-08); model laboratory, provider calls, public library APIs and RPC schema changes.
- Enabling S2 controls in S1: TODOs at once, Obsidian actions and the HTTPS docs action remain absent until their wiring tickets supply them. This ticket only renders supplied props.

## Changes

- `apps/app/src/mainview/cards/views/SettingsView.tsx`: replace the `SettingsModels` import and renderer with an optional React slot declared in app-local props, outside serialized models. Remove model-assignment actions from the fallback renderer. Delete `apps/app/src/mainview/cards/views/SettingsModels.tsx` at this cutover, coordinating with T-FLW-08. T-APP-03 fills the slot through `SettingsContainer.tsx` with the restored card.
- Reuse `apps/app/src/mainview/styles/cards.css` and `@smthrs/ui/copy`; no new stylesheet, clipboard helper, container or model editor.
- Mounting: T-APP-03 mounts both Views through the landed `cards/SetupContainer.tsx` and `cards/SettingsContainer.tsx` and deletes `AccountCard.tsx`, `EnvCard.tsx`, `RepoImportCard.tsx` and `RepositoryChoiceCard.tsx` (pair: SetupView, SettingsView; v1 §2).

## Tests

C-UI-12 exercises the production `SetupView` and `SettingsView` exports through rendered DOM events and their supplied callbacks in `apps/app/src/mainview/cards/views/Views.test.tsx`. Extend the existing cases, including named cases "Settings without a model slot renders no model controls or dispatch" and "Settings renders the supplied model slot once without duplicate actions". Expectations are hand-written literals, never loaded from spec files or computed from production enums, schemas, action routing or renderers. These are View-boundary tests; production dispatcher, routes, CardRenderers mounts and owner authorization are T-APP-03/T-FLW-08 tests, not bypassed or claimed by this ticket. Cases cover:
- the literal seven-step order, a blocked step's fix URL, a failed step's Retry;
- zero capacity: "No machine fits", the limiting term and the fix link on one line at 390 px;
- the literal "Decisions" and "AI Gateway key" labels; masked keys submit only supplied fields;
- Copy with `navigator.clipboard` absent or refused reaches the `execCommand` fallback once, with no setup or key-storage effect;
- health values, the HTTPS notice and the Obsidian last sync;
- an absent action renders no control; a disabled one shows its reason and does not dispatch; an absent model slot remains empty even when model-assignment actions are supplied; a supplied slot renders once;
- hostile repository text renders as text, with zero fetch, script evaluation or command execution.

Reuse `apps/app/e2e/playwright/view-stories.spec.ts` for the existing Setup/Settings browser cases and clipboard fallback cases. At 390 px, measure the production View with `styles/cards.css`: the capacity line stays on one line without horizontal overflow. Keep browser expectations literal; the story page proves presentation and clipboard behavior only, not production dispatch.

## Acceptance
- [C-UI-12](../checks/C-UI-12.md): passes for this ticket’s phase at its stated layer.

- The tests above pass in CI at the landed SHA, including empty-slot zero dispatch and the 390 px browser assertion. `views/SettingsModels.tsx` remains deleted after cutover; `styles/views/setup.css` stays absent. No second model editor or clipboard implementation remains.

## Risks and notes

- Do not retain SettingsModels while waiting for T-FLW-08. The empty slot is the dark integration state, not completion of model assignment.
- smithers-b8 reviews the props-only boundary and key masking. No step in this ticket executes repository code, launches a machine, installs packages or runs as root; root inputs and their main/branch sources are therefore none. Supplied repository text is data, never evaluated. M-29 execution and any root-input validation belong to T-APP-03's machine integrations, reviewed by smithers-3f before those integrations enable. Check: C-UI-12 for inert text and zero effects.

## Ready checklist

1. Dependencies: T-UI-01 and T-FLW-08 cover primitives and restored model assignment; Scope names the dark behavior for each unavailable dependency. T-APP-03 remains downstream and owns runtime wiring; no new dependency or index edge is needed.
2. Exclusions: Scope excludes execution, authorization, mounts, model restoration/writes, the laboratory, public APIs and early S2 activation. Existing CSS and clipboard code are reused.
3. Tests: C-UI-12 uses production View exports, DOM events and literal assertions; the existing browser suite proves layout and Copy. Named empty/supplied-slot cases prove dark behavior. T-APP-03/T-FLW-08 own dispatcher/route acceptance.
4. Decisions: smithers-06 accepts presentation/CSS, smithers-b8 accepts the app-local slot and coordinated cutover, and smithers-8a accepts props/scope changes. No ADR or public API is introduced.
5. Owner pre-review: smithers-06 answers: Does the slot preserve Settings layout at 390 px? Are absent and disabled controls correct? smithers-b8 answers: Is the slot app-local and outside serialized models? Does cutover delete SettingsModels without duplicate model actions? Does an unavailable provider leave zero model dispatch? Record answers in #3539; owner review follows the parallel-build directive.
6. Security: smithers-b8 reviews inert text, masking and the props-only boundary (C-UI-12). No repository execution or root step is in scope, so there are no root inputs. T-APP-03's later execution integrations require machine isolation and smithers-3f review under M-29.
