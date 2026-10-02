# C-CAT-01 The visible app catalog equals Appendix A, and every registered flow and action is in Appendix B

Proves: mvp.md §2 rule 1, §6.4 "Commands", §6.14 (Advanced collapsed), M-21, Appendix A, Appendix B (B.1, B.2, B.4, B.6), Appendix C (`actions.md`) · spec.md §6.1.1–§6.1.3, §14.2, §15.1.4, §15.1.5 · Layer: unit · Stage: S1 · Tickets: T-CAT-01
Automation: `apps/app/src/mainview/flows/catalog-allowlist.test.ts`, `packages/rpc/src/catalog/AppendixA.test.ts`, `AppendixB.test.ts` and `AppendixC.test.ts` (all new) · Runs in: CI

## Setup
- The source tree at the commit under test. No backend or network.
- `.specs/product/mvp.md` and `.specs/product/actions.md`, declared as test inputs in `packages/rpc/PACKAGE.ts` and parsed by `packages/rpc/src/catalog/mvpAppendix.ts`.
- The real app registry built in-process from `flows/Flows.ts` with an empty repository-flow list, plus a second build with two fixture repository flows, `flows/release-notes/flow.ts` and `flows/lint-fix/flow.ts`.
- The CLI's backend command tree from `makeCli()` (`packages/smithers/src/Cli.ts`, the `Definitions.ts` commands).
- The built flow registry's tags: every `Flow.make`, `Action.make` and `AgentAction.make` in shipped flows and std tools.

## Steps
1. Parse Appendix A, B.1, B.2, B.4, B.6 and Appendix C. Record the shorthand expansion (`.edit`, `*`, angle-bracket ids).
2. Map each Appendix A row and each B.4 control to exactly one descriptor by slash or id.
3. Regenerate `catalog.mvp.json` in memory and compare it byte for byte with the committed file.
4. From the first registry build, compute S (slash menu), P (palette), H (`/help`, with groups and collapsed state) and T (agent tools, `agentTools.ts`).
5. From the second build, compute S′, P′, H′ and T′ and their differences from step 4. Compare the differences with the `flows/*/flow.ts` fixtures, not with Appendix A.
6. For each row, compare `agent` with its Appendix B Who column (**A** → `run`, **A✓** → `confirm`, no A → `never`).
7. Match every registered app flow id against B.1, B.2 and B.4, and every backend CLI command against B.6 and the Appendix A rows allowed to X.
8. Match every registered tag against Appendix C.

## Pass when
- Step 2: each row maps to one descriptor; no `core` or `advanced` descriptor lacks an Appendix A row, and no `in-card` descriptor lacks a B.1 or B.4 row.
- Step 3: the files are equal. Every row has slash, CLI path, journey, group, visibility (`core`, `advanced`, `in-card` or `hidden`), `agent` (`run`, `confirm` or `never`) and person-only. The CLI path is `null` exactly for UI-only rows (⌘K, `/help`, `/stop`, `/theme`).
- Step 4, with repository-flow doors excluded:
  - H = the Appendix A set, with `advanced` rows in one collapsed group and the rest grouped as in Appendix A;
  - S = P = the Appendix A set plus the `in-card` rows;
  - T = every row with `agent ≠ never`.
- Step 5: each of S′, P′, H′ and T′ gains exactly `/release-notes` and `/lint-fix`, one per `flows/<name>/flow.ts`, and both are `run` in T′ (`flow.run` is **A**).
- Step 6: zero mismatches. Person-only rows, `/sign-in` and `/sign-out` are `never` and absent from T.
- Step 7: zero ids or commands absent from B.1, B.2, B.4 or B.6, and zero registered ids marked Cut there. The groups B.6 cuts from MVP docs (`admin`, `org`, …) are `hidden`, not failures. `smthrs host start|stop|status|upgrade|backup|restore` match B.6.
- Step 8: every tag has an Appendix C row, and none is marked Cut. Defer and Internal ops rows pass.

## Fail when
- A Cut id (`chat.clear`, `tab.*`, `billing.*`, `change.split`) or a Cut Appendix C tag is registered, or a hidden id (`history.bootstrap`, `debug.*`) appears in S, P, H or T.
- A renamed command survives under its old name as an alias (`history.todo` alongside `todo.new`).
- An **A✓** command is `run`, so the agent executes it without the author's press, or an **A** command is `confirm` (§15.1.5).
- `discloseToAgent` leaks a hidden entry to T.
- A repository flow fails the Appendix A equality, or a `flows/<name>/flow.ts` yields no door or two.
- A descriptor changes without regenerating `catalog.mvp.json`.

## Evidence
Written to `.artifacts/checks/C-CAT-01/<UTC timestamp>/`:
- `sets.json` (S, P, H and T, the repository-flow differences, and the expected sets);
- `appendix-b-expansion.json`, `appendix-c-report.json` and `allowlist-report.json`;
- `catalog.mvp.json`;
- `bun test` output;
- the commit SHA.
