# T-CAT-02 CLI doors for Appendix A; skill generated from the catalog

Stage S1 · Size M · Depends on T-CAT-01 · Unblocks T-TRM-02 · Issue: to file
Spec: spec.md §5.4, §6.1.1–§6.1.3, §6.4, §15.3 · Delta: delta.md §9 (CLI mount consumes descriptors; skill generator) · Product: mvp.md §2 rule 1, §6.13 "Smithers skill", "CLI", §8 (CLI and skill: Keep), J6.3–J6.4, M-21, Appendix A, Appendix B.6

## Goal
`smthrs` has one command for every Appendix A row with a CLI path (§6.1.2). Each command's flags are its catalog payload schema, and each follows its row's `agent: run | confirm | never` value. The Smithers skill lists exactly those commands, so Claude Code and Codex see the same catalog and the same rules as the app agent (Appendix B.6).

## Scope
In:
- `Commands.ts:mount` builds one CLI command per catalog descriptor whose CLI path isn't `null`. UI-only rows (⌘K, `/help`, `/stop`, `/theme`) have none.
  - Positional arguments come from `Tn` (TODO ids), `#n` (issues and PRs), `<name>`, `<path>` and `<branch>`; options come from the rest of the payload.
  - One generic handler sends the payload to the descriptor's HTTP binding.
  - Missing required input gets a typed refusal naming the flag, since the CLI has no form card (§6.1.4 is the app's rule).
- Delete the `Definitions.ts` entries the catalog replaces: `history todo|land|retry|show` become `todo new`, `merge`, `todo retry` and `stack`, with no alias left behind. Also resolve each hidden app/CLI duplicate pair T-CAT-01 listed.
- Every request from these commands carries `Smithers-Via` (T-ACC-04). The CLI's credential is always `delegated` (§5.3.1), so each command follows its row's `agent` value through T-ACC-05 (§15.1.5): `run` executes; `confirm` prints `{confirmation, state: requested}` and exits 0 (`smthrs merge Tn` opens the member's **Review & merge**); `never` is refused with class `permission`.
- The Smithers skill's catalog section is generated from `catalog.mvp.json`, with a drift check. Each command line names its `agent` value, so an external agent knows which commands open a confirmation.
- `smthrs skills add` installs no skill for a hidden command group.
- MVP help and CLI docs list only Appendix A rows and the B.6 kept items (`login`, `ssh-key`, `workspace ssh|shell|exec|cp`, `api`, and `host start|stop|status|upgrade|backup|restore`, run by the owner on the Mac). An explicit hidden list in `Cli.ts` removes the other groups, since incur 0.5.1 has no hidden flag (§6.1.2). Those groups stay published and keep `--help` (§6.1.3, mvp.md §8).

Out:
- Server routes for `new` rows (their feature tickets). The CLI door exists, and an unserved route returns the server's typed refusal.
- The app side (T-CAT-01).
- TUI hiding (T-CUT-03).
- The `ssh` command's behavior (T-TRM-03).

## Changes
- `packages/smithers/src/internal/backend/Commands.ts:130` (`mount`): read `@smthrs/rpc/catalog`.
  - Map each zod payload to incur args and options.
  - `commandPath` remapping (`:105-118`) stays only for non-catalog commands.
- `packages/smithers/src/internal/backend/Definitions.ts:543-562`: delete the entries the catalog replaces, and the matching handlers in `History.ts`.
- `packages/smithers/src/internal/backend/Client.ts`: one `catalogRequest(descriptor, payload)` used by the generic handler.
- `packages/smithers/skills/smithers/SKILL.md`: a generated `## Commands` section between markers, written by `packages/rpc/src/catalog/generate.ts --skill` (new mode) and checked by `--check`.
- `packages/smithers/src/Cli.ts:118-121` (`sync.include`): limit generated per-command skills to Appendix A command groups, through the hidden list above.
- Docs: `packages/smithers/docs/` gets one generated "Commands" page from `catalog.mvp.json`. Run `pnpm docs:sync`, `pnpm docs:check` and `smthrs docs //packages/smithers:docs`.
- `packages/smithers/test/OneCli.test.ts`: group summaries for new groups (`todo`, `branch`, `members`, …), per its rule that every group has one.

## Tests
- Unit: `packages/smithers/test/CatalogCli.test.ts` (new) for C-CAT-02. For every Appendix A row with a non-null CLI path in `catalog.mvp.json`, the command resolves in `Cli.toCommands.get(makeCli())`. Its args and options equal the descriptor payload: keys, types, required-ness and enum values. The technique follows `test/McpDocs.test.ts` and `test/CommandFlagParity.test.ts`.
- Unit: `packages/smithers/test/CatalogSkill.test.ts` (new) for C-CAT-03. The generated SKILL.md section lists exactly the Appendix A CLI paths. `smthrs skills add` into a temporary directory installs no skill naming a hidden group. This test runs against source `makeCli()`, not the installed binary.
- Integration, against a real backend with PostgreSQL (once T-STK-01 and T-ACC-05 land): `smthrs todo steer T1 …` runs at once and records `via=cli`; `smthrs todo new --prompt …` prints a one-click confirmation id and creates no TODO until Ben presses it in his session; `smthrs merge T1` prints a `review_merge` confirmation id; `smthrs secrets set` is refused with class `permission`.
- Regression: `test/OneCli.test.ts`, `SkillsInstall.test.ts` and `UnifiedMcp.test.ts` stay green.

## Acceptance
- [C-CAT-02](../checks/C-CAT-02.md): every Appendix A row with a CLI path has flags equal to its payload schema; UI-only rows are `cli: null`.
- [C-CAT-03](../checks/C-CAT-03.md): the Smithers skill lists exactly the Appendix A catalog.

## Risks and notes
- **Hidden list drift.** The hidden list is ours because incur 0.5.1 has no hidden-command option (`rg hidden` over its `src/` finds only help internals). Observation that confirms drift: `smthrs skills add` into a temporary directory installs a skill for a group outside Appendix A. Per CLAUDE.md, an upstream incur flag is filed only if incur is ours to change.
- **Two-catalog residue.** Hidden CLI groups (`admin`, `org`, `history bootstrap`, …) keep their `Definitions.ts` form. They are not doors for a catalog command, so no behavior has two declarations. Falsified if T-CAT-01's duplicate list is non-empty after this ticket.
- The installed `smthrs` (rc.1) still lists `create-app` (research `cli-api-cuts.md`). Tests import source and never shell out to the installed binary.
