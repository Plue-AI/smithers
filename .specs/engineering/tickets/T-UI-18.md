# T-UI-18 Secrets view

Stage S2 · Size S · Depends on T-UI-01 · Unblocks T-APP-13 · Issue: [#3582](https://github.com/smithersai/smithers/issues/3582)
Spec: spec.md §14.2.1, §8.8, §8.9, §14.3 (Secrets), §14.6b · Delta: delta.md §9 · Product: mvp.md J1.8, §6.15 Secrets, M-29 · Props: reuse or reshape `packages/rpc/src/SecretsCard.ts`; update ui-components.md at S2
Ready: 2026-10-03 smithers-8a sha256:3829ce3a3d81

## Goal

`SecretsView` exists as a props-only View matching the design mock, so the wiring ticket only binds data and actions.

## Ownership (Will, 2026-10-02)

Design (smithers-06) owns visual and copy approval. smithers-b8 reviews the app handler seam; smithers-38 reviews the private rpc props contract. Engineering wires it in T-APP-13. smithers-8a accepts spec and prop changes; Will decides product changes. These owners pre-review the questions in the Ready checklist before implementation; recorded answers stand, with implementation review post hoc under Will's 2026-10-03 directive. Private rpc card types need no public-API sign-off (ui-components.md Rules); a new public API is outside this ticket.

## Scope

In:
- `SecretsView`: names, scope ("all branches" or "main only") and the optional Hosts field in Add and Replace.
- Reuse or reshape the existing TypeScript props in `packages/rpc/src/SecretsCard.ts`; restore that file only if the S1 cut removed it. Add its ui-components.md section at S2; zod only where data crosses HTTP or storage.
- Stories for every state the props allow, light and dark, desktop and 390 px.
- Land dark against the T-UI-01 contract if its remaining cleanup is unlanded: the View is reachable only in the existing story/test harness, with no production mount or command registration. Missing actions render no controls; disabled actions cannot call a handler. T-APP-13 alone enables the production card after its dependencies and checks pass. C-UI-12 tests these refusals; T-APP-13 owns C-UI-13 at cutover.

Out:
- Topic subscriptions, command registration, permission enforcement, production card mounting and legacy-markup deletion (T-APP-13).
- Secret storage, API reads/writes, machine delivery, main-only trust enforcement and egress substitution (T-MCH-12 and T-APP-13).
- Host counts, separate Bind or scope-toggle doors, secret values in projections, usage-by-run counts, provider-account connections and model keys.
- New public APIs, a second container, fixture or golden layer, and changes to shared UI primitives. Product copy changes require Will; design reviews copy against §14.6b.

## Changes

- Reuse the table and controls in `apps/app/src/mainview/cards/SecretsCard.tsx` as the presentation source, the existing rpc props, and `@smthrs/ui` primitives. Extract and reshape the presentation as `apps/app/src/mainview/cards/views/SecretsView.tsx`; the legacy body stays until T-APP-13 replaces it atomically. No separate container or duplicate production renderer.
- Extend `apps/app/src/mainview/styles/cards.css` and the existing `views/Views.test.tsx` and story harness. A Secrets story module is needed because none exists; reuse the existing harness and literal secret examples instead of adding a fixture framework.
- Render names, scope words and optional hosts; render supplied Add, Replace and Delete actions only. Every handler follows ui-components.md Rules: `onAction` with the supplied action and `data-flow`, `onView`, or transient local state. No state/flow/RPC-client imports or fetch. Values entered in transient form inputs are write-only, clear on submit or cancel, and never enter model props, story callback logs or screenshots; test callbacks redact values before logging.

## Tests

- C-UI-12 unit cases in `apps/app/src/mainview/cards/views/Views.test.tsx` mount the actual SecretsView. Named cases: empty list; both scope words; optional Hosts; member with no actions; missing and disabled actions; Add and Replace form inputs; cancel and submit clear Value; hostile names and hosts render as text. Assert literal labels, action tags and payloads declared in the test, including exactly one callback per submit and none on cancel or disabled input. Inspect a callback in memory to assert its literal write value, then discard it without logging. No expectations come from `.specs/`, production schemas or story `expect`/action arrays at runtime.
- C-UI-12 browser cases in `apps/app/e2e/playwright/view-stories.spec.ts` use `/view-stories.html?story=SecretsView/<case>` to mount the same View. Click and keyboard-activate its real controls; assert the literal callback payloads above, no mutation when actions are absent, no overflow at 390 px, and no serious or critical axe-core violation in light and dark at 1,440 px and 390 px. Never call a callback directly to simulate a control.
- Check View imports and handlers through the existing `apps/app/src/mainview/flows/parity.test.ts` scan. Run the existing View copy assertions with literal forbidden terms and body limits; no test reads `.specs/`. Backend routes and production dispatch are exercised by T-APP-13, not bypassed by this View ticket.

## Acceptance
- [C-UI-12](../checks/C-UI-12.md): passes for this ticket’s phase at its stated layer.

- Copy review: smithers-06 reads every story screenshot at 1,440 px and 390 px, light and dark, against spec §14.6b, and records approve or fix per screen in this ticket’s issue. Use synthetic metadata only. The wiring ticket's own checks prove the card end to end.

## Risks and notes

- A prop the mock needs but spec §14.3 lacks is a spec change: smithers-8a accepts it before implementation; Will decides any product scope change.
- Security review: smithers-b8 reviews the passive View and write-only input handling; smithers-38 reviews the value-free props. This ticket executes no repository flows, commands or guest operations and adds no root step. Root inputs: none. Repository build/test code runs only in a branch machine as a non-root user (M-29); do not run branch code on the host or use sudo. Machine delivery and root-owned environment-file inputs remain T-MCH-12's responsibility. The named C-UI-12 value and hostile-text cases and parity scan verify this ticket's boundary.

## Ready checklist

1. Dependencies: T-UI-01 supplies the reused primitives; it is recorded as landed. Scope states dark landing and fail-closed missing/disabled actions if its remaining cleanup is absent. T-APP-13 is the later production-wiring consumer, not a dependency.
2. Exclusions: Scope names backend authority, machine delivery, production wiring, root operations, Bind, host counts, usage counts, provider accounts, model keys and new public APIs.
3. Tests: named C-UI-12 cases exercise the actual View controls through DOM and browser boundaries with literal independent oracles; T-APP-13 owns production-route and dispatcher evidence.
4. Decisions: smithers-06 approves visuals/copy; smithers-b8 accepts app handlers; smithers-38 accepts private rpc props; smithers-8a accepts spec changes; Will decides product changes. No ADR or public API is introduced.
5. Owner pre-review: smithers-06: do the screens contain only specified fields and actions, and does copy pass §14.6b? smithers-b8: do handlers use only supplied actions and clear write-only inputs, and does the View stay dark until T-APP-13? smithers-38: does the existing private props type suffice, and are values absent from projections? Recorded answers stand; owners review implementation post hoc.
6. Security: smithers-b8 and smithers-38 review the passive View and value-free seam. Branch build/test execution stays non-root inside a machine; no root step consumes inputs. C-UI-12 and parity cases cover write-only values, hostile text and prohibited execution imports.
