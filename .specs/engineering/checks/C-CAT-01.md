# C-CAT-01 Catalog doors, actors and roles equal Appendices A and B; every tag is in Appendix C and registers where it runs

Proves: mvp.md §2 rule 1, §6.4 "Commands", §6.14 (Advanced collapsed), M-21, Appendix A, Appendix B (B.1, B.2, B.4, B.6), Appendix C (`actions.md`) · spec.md §1.3, §6.1.1–§6.1.3 (incl. §6.1.2a–c), §14.2, §15.1.4, §15.1.5 · Layer: unit · Stage: S1 · Tickets: T-CAT-01, T-CAT-03, T-FLW-11
Automation: `apps/app/src/mainview/flows/catalog-allowlist.test.ts`, `packages/rpc/src/catalog/AppendixA.test.ts`, `AppendixB.test.ts` and `AppendixC.test.ts` (all new) · Runs in: CI

## Setup
- The source tree at the commit under test. No backend or network.
- Committed reviewed literal Appendix A/B/C fixtures; tests do not read spec or product Markdown.
- The real app registry built in-process from `flows/Flows.ts` with an empty repository-flow list, plus a second build with two fixture repository flows, `flows/release-notes/flow.ts` and `flows/lint-fix/flow.ts`.
- The CLI's backend command tree from `makeCli()` (`packages/smithers/src/Cli.ts`, the `Definitions.ts` commands).
- The built flow registry's tags: every `Flow.make`, `Action.make` and `AgentAction.make` in shipped flows and std tools. Two builds: the host flow runtime's registry and the coding host's registry.

## Steps
1. Load reviewed literal Appendix A/B/C fixtures, including explicit shorthand expansions (`.edit`, `*`, angle-bracket ids).
2. Map each Appendix A row and each B.4 control to exactly one descriptor by slash or id.
3. Regenerate `catalog.mvp.json` in memory and compare it byte for byte with the committed file.
4. From the first registry build, compute S (slash menu), P (palette), H (`/help`, with groups and collapsed state) and T (agent tools, `agentTools.ts`). From the CLI tree and the generated skill section, compute X (external-agent commands).
5. From the second build, compute S′, P′, H′ and T′ and their differences from step 4. Compare the differences with the `flows/*/flow.ts` fixtures, not with Appendix A.
6. For each row, compare actor eligibility, minimum role and `agent` with its Appendix B Who column: **A** or **A✓** → `app_agent`; **X** → `external_agent`; **A✓** → `confirm`, otherwise **A** or **X** → `run`, otherwise `never`; "Maintainer", "maintainer for Discard" and "Owner" → the minimum role.
7. Match every registered app flow id against B.1, B.2 and B.4, and every backend CLI command against B.6 and the Appendix A rows allowed to X.
8. Build the production host-flow and coding-host registries and compare tags and runtime placement with the literal Appendix C fixture. Inject each Replaced entry point in a negative fixture and assert rejection without executing repository code.
- Generate the S1 host reference from exported definitions after T-INS-08 registers the group.

## Pass when

- Committed reviewed literal fixtures encode product Appendices B and C. Runtime tests treat `catalog.mvp.json` as input and never parse spec or product Markdown or derive expected policy from implementation code.

- Step 2: each Appendix A row maps to one `core` or `advanced` descriptor, and each B.4 control to one `in-card` descriptor. No `core` or `advanced` descriptor lacks an Appendix A row, and no `in-card` descriptor lacks a B.1 or B.4 row.
- Step 3: the files are equal. Every row has slash, CLI path, journey, group, visibility (`core`, `advanced`, `in-card` or `hidden`), actor eligibility, minimum role and `agent` (`run`, `confirm` or `never`). The CLI path is `null` exactly for rows that don't list `external_agent`, the UI-only rows (⌘K, `/help`, `/stop`, `/theme`) among them.
- Step 4, with repository-flow doors excluded:
  - H = the Appendix A set, with `advanced` rows in one collapsed group and the rest grouped as in Appendix A;
  - S = P = the Appendix A set, with no `in-card` row;
  - T = every row that lists `app_agent` with `agent ≠ never`, `in-card` rows included;
  - X = the Appendix A rows that list `external_agent`, with no UI-only or `in-card` row.
- Step 5: each of S′, P′, H′ and T′ gains exactly `/release-notes` and `/lint-fix`, one per `flows/<name>/flow.ts`, and both are `run` in T′ (`flow.run` is **A**).
- Step 6: zero mismatches in actors, minimum role and `agent`. For example, `/todo.amend` is `confirm` (B.2), and `branch.discard-foreign` lists `app_agent`, is `confirm` and has minimum role `maintainer` (B.4). Person-only rows, `/sign-in` and `/sign-out` list `person` alone, are `never`, and are absent from T and X.
- Step 7: zero ids or commands absent from B.1, B.2, B.4 or B.6, and zero registered ids marked Cut there. The groups B.6 cuts from MVP docs (`admin`, `org`, …) are `hidden`, not failures. `smthrs host start|stop|status|upgrade|backup|restore` match B.6.
- Step 8: every tag has an Appendix C row; none is marked Cut, and none is marked Replaced once T-FLW-11 has landed. The host flow runtime registers only Install rows, and the coding host only Machine rows. Defer and Internal ops rows pass.
- Documented host start/stop/status exist in the real registry; ticket prose is never a registry or documentation-generation input.

## Fail when
- A Cut id (`chat.clear`, `tab.*`, `billing.*`, `change.split`) or a Cut Appendix C tag is registered, or a hidden id (`history.bootstrap`, `debug.*`) appears in S, P, H or T.
- A renamed command survives under its old name as an alias (`history.todo` alongside `todo.new`).
- An **A✓** command is `run`, so the agent executes it without the author's press, or an **A** command is `confirm` (§15.1.5).
- `discloseToAgent` leaks a hidden entry to T.
- A repository flow fails the Appendix A equality, or a `flows/<name>/flow.ts` yields no door or two.
- An `in-card` row appears in S, P, H or X, or a UI-only row appears in X.
- A Machine tag registers in the host flow runtime, or `coding/Request`, `coding/Vibe`, `coding/Verify` or `review/change` is still registered after T-FLW-11.
- A descriptor changes without regenerating `catalog.mvp.json`.

## Evidence
Written to `.artifacts/checks/C-CAT-01/<UTC timestamp>/`:
- `sets.json` (S, P, H and T, the repository-flow differences, and the expected sets);
- `appendix-b-expansion.json`, `appendix-c-report.json` and `allowlist-report.json`;
- `catalog.mvp.json`;
- `bun test` output;
- the commit SHA.
