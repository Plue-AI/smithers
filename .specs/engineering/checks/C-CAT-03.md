# C-CAT-03 The Smithers skill lists exactly the Appendix A rows open to external agents

Proves: mvp.md §6.13 "Smithers skill", §8 (CLI and skill: Keep; other groups left out of MVP docs), J6.3, M-21, Appendix A, Appendix B.5 · spec.md §6.1.2, §6.1.3, §14.6b, §15.3 · Layer: unit · Stage: S1 · Tickets: T-CAT-02
Automation: `packages/smithers/test/CatalogSkill.test.ts` (new) · Runs in: CI

## Setup
- The source tree at the commit under test.
- `packages/smithers/skills/smithers/SKILL.md` and `packages/rpc/src/catalog/catalog.mvp.json`.
- The banned-term list from C-UI-02 (`apps/app/src/mainview/cards/productWords.ts`).
- A temporary directory used as the skills install target.

## Steps
1. Regenerate the SKILL.md `## Commands` section in memory from `catalog.mvp.json`, then diff it against the committed file.
2. Parse the committed section into rows (CLI path, summary, person-only marker).
3. Run the source CLI's `skills add` (`makeCli()` from `packages/smithers/src/Cli.ts`) into the temporary directory. List every skill directory it writes and every command each skill names.
4. Collect the hidden groups from the `Cli.ts` hidden list: the B.5 groups cut from MVP docs (`admin`, `org`, `webhook`, `variable`, `cache`, `artifact`, `label`, `notification`, `workflow`, `stack`, `workspace children`, `egress`), plus `tui`, `triggers` and `history bootstrap|backfill`.

## Pass when
- Step 1: no diff.
- Step 2: the set of CLI paths in the section equals the external-agent action paths of the `core` and `advanced` rows in `catalog.mvp.json`, with no extra rows and none missing. Person card doors for secrets, members and settings are excluded; search and GitHub status are included as read-only commands. `confirm` rows, such as `/merge` and `/todo.amend`, say they open a confirmation in the app.
- Step 3: the installed skills name no command from step 4. The Smithers skill is present and contains the section from step 1.
- The section contains none of the §14.6b banned terms (workflow, thread, task, lane, box, workspace, mythical, sandbox, VM, seat, profile), read from the C-UI-02 list rather than a second copy.

## Fail when
- The skill still lists the authoring guide only.
- A generated `smthrs-admin`, `smthrs-tui` or `smthrs-org` skill is installed.
- The section was hand-edited and drifts from `catalog.mvp.json`.
- `/merge` is described as merging directly.

## Evidence
Written to `.artifacts/checks/C-CAT-03/<UTC timestamp>/`:
- `skill-section.md`;
- `installed-skills.txt` (directory listing plus the commands each names);
- `diff.txt`;
- `bun test` output;
- the commit SHA.
