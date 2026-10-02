# C-UI-13 Containers wire their cards, and every card of a stage is wired

Proves: spec.md §14.2.1, §14.3.0 (inventory, Stage column, retained cards), §7.2, §7.2.1 · Layer: integration · Stage: S1, S2, S3 · Tickets: T-APP-01, T-APP-02, T-APP-03, T-APP-04, T-APP-05, T-APP-06, T-APP-07, T-APP-09, T-APP-10, T-APP-11, T-APP-12, T-APP-13, T-APP-14, T-APP-15, T-APP-16, T-APP-17, T-APP-18, T-APP-20, T-APP-21, T-GH-08, T-STK-08, T-MCH-08, T-FLW-06, T-FLW-07, T-FLW-08, T-FLW-12, T-COL-05, T-CAT-01
Automation: part A `apps/app/src/mainview/cards/containers/<Card>Container.integration.test.ts` (new, one per card); part B `apps/app/src/mainview/Inventory.test.ts` (new, takes `--stage S1|S2|S3`) · Runs in: CI with a real backend and PostgreSQL and a fake GitHub server (part A); CI from each stage's exit onward (part B)

## Setup
- Part A: the backend at the commit under test, seeded so the card's topic holds one state from the card's fixture list. A wiring ticket adds its card's case in the same change as its Container.
- Part B: the app tree and the §14.3 table's Stage column, read through C-UI-08's field script.

## Steps
A1. Mount the card's Container on its topic as a member, and wait for the snapshot.
A2. Parse the model the Container passes to its View with the card's schema.
A3. Read the `actions[]` and `gestures` it passes, with the catalog tag of each. Repeat A1–A3 as a member whose role lacks one of the card's role-gated commands.
A4. Commit one change to the topic's source rows and wait for the next model.
B1. At a stage's exit, the lead engineer (smithers-22) runs the inventory test with that stage and attaches the log. CI runs it with that stage on every later commit.

## Pass when
- A2: the model parses, and its values equal the seeded rows (titles, states, actors).
- A3: every action and gesture comes from `cardActions` with a catalog tag (T-CAT-01) bound to `flowAction`. The second member gets no action for the role-gated command.
- A4: the next model reflects the change within 1 s (§7.2.1).
- B1: every §14.3 row whose Stage is the stage under test or earlier has a View, a Container and a schema; every View in `cards/views/` renders a §14.3 row or a shell part; every retained card still renders through its owner's renderer (§14.3.0).

## Fail when
- A Container passes a model that fails its schema, or an action that `cardActions` didn't build.
- At or after a stage's exit, a row of that stage lacks a View, a Container or a schema, or a View has no row.

## Evidence
Part A: the CI log per card. Part B: `.artifacts/checks/C-UI-13/<stage>/<UTC>/` with the inventory log and the commit.
