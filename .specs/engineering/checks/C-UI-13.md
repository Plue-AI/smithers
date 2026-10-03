# C-UI-13 Containers wire their cards, and every card of a stage is wired

Proves: spec.md §14.2.1, §14.3.0 (inventory, Stage column, retained cards), §7.2, §7.2.1 · Layer: integration · Stage: S1, S2, S3 · Tickets: T-APP-01, T-APP-02, T-APP-03, T-APP-04, T-APP-05, T-APP-06, T-APP-07, T-APP-09, T-APP-10, T-APP-11, T-APP-12, T-APP-13, T-APP-14, T-APP-15, T-APP-16, T-APP-17, T-APP-18, T-APP-20, T-APP-21, T-GH-08, T-STK-08, T-MCH-08, T-FLW-06, T-FLW-07, T-FLW-08, T-FLW-12, T-COL-05, T-CAT-01, T-APP-14a
Automation: part A `apps/app/src/mainview/cards/containers/<Card>Container.integration.test.ts` (new, one per card); part B `apps/app/src/mainview/Inventory.test.ts` (new, takes `--stage S1|S2|S3`) · Runs in: CI with a real backend and PostgreSQL and a fake GitHub server (part A); CI from each stage's exit onward (part B)

Owner action before PRC-03 activation: replace the reported unparsable Automation declaration with an explicit approved executable command and declared Runs in host. Do not infer a command from a path or prose. Until that mapping is approved and available, the runner refuses this check and ticket closure remains blocked. Check: C-PRC-03.

## Setup
- Part A: the backend at the commit under test, seeded so the card's topic holds one state from the card's fixture list. A wiring ticket adds its card's case in the same change as its Container.
- Part B: the app tree and a reviewed committed inventory fixture containing literal card identities, stage requirements and retained-card owners. Documentation parity runs separately; the acceptance test never loads spec Markdown or derives expected inventory from production code.

## Steps
A1. Mount the card's Container on its topic as a member, and wait for the snapshot.
A2. Parse the model the Container passes to its View with the card's schema.
A3. Read the `actions[]` and `gestures` it passes, including per-wait and row actions and bound args, with the catalog tag of each. Repeat A1–A3 as a member whose role lacks one role-gated command. For T-APP-04, approve/deny bindings carry subject/revision and never relaunch the initiating model.action tag. For T-APP-01, main.reset-to-github is absent for a non-owner. For T-FLW-08, Edit instructions opens a private Draft with prefilled text and creates no TODO until Commit; Change model requires an owner session. Check these effects through the production catalog/topic boundaries, not fixtures alone.
A4. Commit one change to the topic's source rows and wait for the next model. Persist and reload supplied shell view patches (selected_branch, selected_archive, toast_hidden, jump_to, on_screen, timeline_visible) and Monitor selected/at state per member. Replay projection sends no write. Other-viewer Confirm privacy remains a production C-ACC-02 obligation of T-APP-04.
A5. Press each role-gated control through the production View → Container → cardActions → flowAction → registered command dispatcher and production HTTP route. For /help, invoke the production chat.commands entry and inspect CommandsView. Do not call a handler or service directly. Wiring tickets supply committed literal input/output cases and assert the resulting rows or refusal envelope.
B1. At a stage's exit, the lead engineer (smithers-22) runs the inventory test with that stage and attaches the log. CI runs it with that stage on every later commit.

- Mount TodoContainer with literal Fork and Add to stack gestures and a pending 202 response.

## Pass when
- A2: the model parses, and its values equal the seeded rows (titles, states, actors).
- A3: every action and gesture comes from `cardActions` with a catalog tag (T-CAT-01) bound to `flowAction`. The second member gets no action for the role-gated command.
- A4: the next model reflects the change within 1 s (§7.2.1).
- A5: the literal expected route, payload and state change occur once for an eligible actor; the literal refusal occurs with no mutation for an ineligible actor. Expected values are not read from spec files, generated from the catalog or derived from implementation code at runtime. View fixtures alone do not prove command dispatch.
- B1: every committed inventory entry for the stage under test or earlier has its declared View, Container and schema; every View in cards/views/ matches an inventory card or shell entry; every retained card renders through its declared owner renderer.

- cardActions dispatches branch.fork with `{from: "T2"}` and branch.add-to-stack through flowAction; pending 202 renders T-APP-04’s private Confirm card without direct card pushes or early TODO creation.

## Fail when
- An approval relaunches its initiating command, a non-owner receives a reset/model-write action, Edit instructions commits a TODO before Commit, or a view patch writes outside its member scope.
- A Container passes a model that fails its schema, or an action that `cardActions` didn't build.
- At or after a stage's exit, a row of that stage lacks a View, a Container or a schema, or a View has no row.

## Evidence
Part A: the CI log per card. Part B: `.artifacts/checks/C-UI-13/<stage>/<UTC>/` with the inventory log and the commit.
