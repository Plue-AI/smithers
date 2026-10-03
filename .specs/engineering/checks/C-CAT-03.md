# C-CAT-03 The Smithers skill lists exactly the Appendix A rows open to external agents

Proves: mvp.md §6.13 "Smithers skill", §8 (CLI and skill: Keep; other groups left out of MVP docs), J6.3, M-21, Appendix A, Appendix B.5 · spec.md §6.1.2, §6.1.3, §14.6b, §15.3 · Layer: unit · Stage: S1 · Tickets: T-CAT-02
Automation: `packages/smithers/test/CatalogSkill.test.ts` (new) · Runs in: CI

## Setup
- The source tree at the commit under test.
- `packages/smithers/skills/smithers/SKILL.md` and `packages/rpc/src/catalog/catalog.mvp.json`.
- Literal excluded groups and banned terms pinned in the reviewed CatalogCli.ts fixture; productWords.ts is supplemental parity input only.
- A temporary directory used as the skills install target.

## Steps
1. Regenerate the SKILL.md `## Commands` section in memory from `catalog.mvp.json`, then diff it against the committed file.
2. Assert installed command paths, agent values and excluded groups against the committed literal CatalogCli.ts fixture via makeCli().serve([\"skills\", \"add\"]). Treat regeneration as a supplemental drift assertion, not the command-set oracle. Pin banned terms in the fixture instead of deriving expectations from production productWords.ts.
3. Record every skill directory and command written to the temporary target.
4. Compare installed paths, agent values and excluded groups with the literal fixture, without reading hidden groups from Cli.ts.

## Pass when
- Step 1: no diff.
- Installed command paths, agent values, confirmation descriptions and excluded groups equal the committed literal CatalogCli.ts fixture. Person card doors are excluded; read-only search and GitHub status remain included.
- Step 3: the installed skills name no command from step 4. The Smithers skill is present and contains the section from step 1.
- The section contains none of the banned terms pinned in the fixture. No runtime expectation is derived from productWords.ts, catalog.mvp.json or spec files.

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
