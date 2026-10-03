# C-UI-08 Card schemas match §14.3, fixtures parse, and the seam rules hold

Proves: spec.md §14.2.1 (Will's ownership ruling, 2026-10-02), §14.3, §14.3.0 (inventory and retained cards) · Layer: unit · Stage: S1 · Tickets: T-APP-19, T-APP-19b, T-UI-07, T-UI-08
Automation: `packages/rpc/test/cards/<Card>Card.test.ts`, `packages/rpc/test/cards/RetainedCards.test.ts`, `packages/rpc/test/cards/CardContracts.test.ts` (new: shared action args, gestures, command inputs and view patches), the §14.3 field script `scripts/spec-card-fields.mjs` (CI only; no test reads `.specs/`), `apps/app/src/mainview/Architecture.test.ts` and `apps/app/src/mainview/flows/parity.test.ts` (View-seam and Container rules) · Runs in: CI

Owner action before PRC-03 activation: replace the reported unparsable Automation declaration with an explicit approved executable command and declared Runs in host. Do not infer a command from a path or prose. Until that mapping is approved and available, the runner refuses this check and ticket closure remains blocked. Check: C-PRC-03.

## Setup
The repository at the commit under test. No View or Container needs to exist: the seam rules run on every file that exists and on the seeded violations in `flows/fixtures/seam/`.

## Steps
1. For each §14.3 row and each shell part, parse every fixture in `packages/rpc/test/fixtures/<Card>.ts` with its schema. Parse a copy of each with one enum value changed to an unknown value. Import fixtures through `@smthrs/rpc/fixtures/<Card>` and schemas through their module subpaths; there is no rpc root export. Assert independent committed literal cases for every T-APP-19b gap. Reject current Confirm subjects secret, member and settings; receipt enums are done, cancelled and expired. Cover previous-version persisted fixtures only through explicit legacy decoding.
2. Run the field script: read the §14.3 table from spec.md and compare each row's field list, nested objects included, with its schema's field set. Compare enum sets, optionality and nested action/input/view fields against ui-components.md as well. Include archive_count, tombstone, github_url, per-wait and Home row actions, Action.args, gestures, ShellView and Monitor selected/at patches. No runtime unit test reads the spec.
3. Export the JSON Schema of each retained card kind (§14.3.0: `issue`, `pr`, `change` with `ChangeReviewSchema` and `ChangeFindingSchema`, `world`, `wiki-history`, `wiki-links`, `wiki-graph`, `flow-form`, `browser`, `flow-plan`, `run-list`, `search-results`, `approval`). Compare each with its committed snapshot.
4. Run the View-seam and forbidden-import rules on every `*View.tsx` under `apps/app/src/mainview/cards/views/` and `packages/smithers/ui/src/`, plus the production shared primitives `packages/smithers/ui/src/actor-chip.tsx` and `packages/smithers/ui/src/state-word.tsx`, and `apps/app/src/mainview/BranchTree.tsx`, `EntryRow.tsx`, `ContextLine.tsx`, `EarlierArchive.tsx`, `ToastStackView.tsx`, `EdgeMap.tsx` and `Timeline.tsx`. T-UI-07 and T-UI-08 extend both `apps/app/src/mainview/flows/parity.test.ts` and `apps/app/src/mainview/Architecture.test.ts` scopes in their own changes; remove these shell files from legacy handler pins. For every named shell file, seed a forbidden direct/transitive import, a fetch, a handler outside the three kinds, and an onAction control without data-flow; each must fail. Retain compliant seeds covering supplied actions, onView patches and local state/focus/copyText. Assert all seven real shell paths are selected when present. Never scan the live ToastStack.tsx as a props-only shell before T-APP-07 cuts over. Owner smithers-b8 pre-reviews this architecture/parity coverage; smithers-38 reviews shared primitive coverage. Shell exports remain outside the card inventory (§14.3.0).
5. Run the Container rule on every `*Container.tsx`, and on a seeded Container that builds `actions[]` without `cardActions`.

## Pass when
- Step 1: every fixture parses, every invalid enum and forbidden current Confirm subject fails, fixture subpath imports resolve, and every T-APP-19b gap has independent committed literal coverage. Prior persisted fixtures decode through the explicit legacy path; current forbidden subjects remain rejected.
- Step 2: every §14.3 field is in its schema, and every schema field is in §14.3. Enum literals, nested types and optionality match ui-components.md, including each shared action/input/view patch. Require github_url for binary/too_large content and archive_count for Earlier.
- Step 3: every retained schema equals its snapshot.
- Step 4: in every real View and named props-only shell file, each handler calls `onAction(action.tag, …)` from a control carrying `data-flow={action.tag}`, calls `onView(patch)`, or touches only React local state, DOM focus or the clipboard through `copyText` (ui-components.md Rules). No View imports state, store, topic, controller, flow, RPC client or command modules, or calls `fetch`. Each seeded violation fails, and the compliant View passes. Both scans select all seven named shell files. Each file-specific seeded violation fails and its compliant seed passes. Shared useClock is allowed; mainview useEffect imports are rejected.
- Step 5: every Container builds `actions[]` and `gestures` through `cardActions`, and the seeded Container fails.

## Fail when
- A T-APP-19b gap has no fixture, a fixture imports the rpc root, a forbidden current Confirm subject parses, or a previous-version persisted fixture loses its legacy decoder.
- A named props-only shell file is absent from either scan, remains under legacy handler pins, or passes its seeded authority/handler violation.
- A schema field is missing from §14.3, or a §14.3 field is missing from the schema.
- A fixture fails to parse, or an unknown enum value parses.
- A retained card's schema changed without a §14.3 row.
- A seam rule passes a seeded violation or fails a compliant file.

## Evidence
The CI test log and the commit.
