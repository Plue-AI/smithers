# C-CUT-02 Old conversations stay readable after every card removal

Proves: AGENTS.md "Old sessions and recorded events must remain readable", "Preserve decoding of existing persisted history" · mvp.md §8 · spec.md §14.1.5, §14.2 · card-kinds.md §2 · Layer: unit+e2e · Stage: S1 · Tickets: T-APP-22, T-APP-23, T-CUT-04
Automation: `packages/rpc/test/cards/LegacyCards.test.ts` (unit) and `apps/app/e2e/playwright/legacy-archive.spec.ts` (new) · Runs in: CI (the e2e against the real backend, as C-UI-06 runs)

## Setup
- The pinned fixture `packages/rpc/test/fixtures/LegacyCards.ts` (T-APP-22): one row per card kind the app shipped when T-APP-22 landed (67), one per name in that day's `retiredKinds` (8), and the rows later tickets appended for kinds they added.
- `LEGACY_CARD_KINDS`, `CurrentCardSchema` and `CARD_RENDERERS` at the commit under test, and `packages/rpc/src/catalog/cuts.json` (C-CUT-01).
- e2e, after the T-APP-23 cutover: a browser profile whose store holds one legacy per-member conversation of Ben's with a prompt, an answer and one card entry per fixture row, and a server journal for Ben (`/api/agent/conversations`) holding the same rows as `card` frames. Members Ben and Alice. The fast model is a recording fake.

## Steps
1. Unit: parse every fixture row with `CardSchema`.
2. Unit: compare the fixture's kinds with `CurrentCardSchema`'s options, `LEGACY_CARD_KINDS`, `CARD_RENDERERS` and every card kind `cuts.json` lists.
3. e2e: Ben opens Earlier and opens the conversation from the browser store, then the one from the server journal.
4. e2e: Ben presses Tab through every entry and tries to maximize a tombstone with ⌘K.
5. e2e: Alice opens Earlier.
6. e2e: Ben prompts in `main`'s conversation, "what did my old conversations say?".

## Pass when
- Step 1: every row parses and none throws. Each row of a kind in `LEGACY_CARD_KINDS` yields `kind: "retired"` with `payload.was` equal to its kind, its stored title and no body. Each other row yields its own kind.
- Step 2: the fixture covers every option of `CurrentCardSchema` and every name in `LEGACY_CARD_KINDS`; the two sets are disjoint; `CARD_RENDERERS` has no legacy kind; every card kind in `cuts.json`'s `cut` entries is in `LEGACY_CARD_KINDS`.
- Step 3: both conversations open under Earlier, read-only (no composer, no actions); every prompt and answer shows its text; every tombstone shows its title alone; no entry fails to load, and the console has no decode error.
- Step 4: Tab reaches every row; no tombstone opens, maximizes or offers an action.
- Step 5: Alice sees none of Ben's archives.
- Step 6: the recorded model requests contain no archive entry's text.

## Fail when
- A row of a removed kind throws, or one bad row fails the whole conversation.
- A removed kind keeps a live schema or renderer beside its tombstone.
- A tombstone shows its old body or payload data, offers an action or reaches a model.
- A kind whose name was reused (`agents`, `diff`, `file`, `run-trace`, `secrets`) rejects its pinned row.

## Evidence
`.artifacts/checks/C-CUT-02/<UTC timestamp>/`: the unit output with one line per fixture row (kind → decoded kind), the Playwright trace and screenshots of both archives, the console log, the recorded model requests and the commit.
