# T-CAT-01 One command catalog: descriptors, `catalog.mvp.json`, allowlist, CLI doors and skill, Replaced-tag rejection

Stage S1 · Size L · Depends on T-UI-14 · CLI phase: T-ACC-04, T-APP-04, T-STK-01, T-STK-02, T-STK-06 · Tag phase: T-FLW-11 · Unblocks T-ACC-03, T-APP-06, T-APP-15, T-APP-20, T-APP-21, T-APP-16, T-CUT-03, T-FLW-03, T-FLW-05, T-FLW-07, T-FLW-08, T-FLW-13, T-INS-08, T-MCH-08, T-MNT-01, T-TRM-02, T-REL-02 · Issue: [#3434](https://github.com/smithersai/smithers/issues/3434)
Spec: spec.md §5.4, §6.1.1–§6.1.4, §6.4, §14.2, §15.1.4, §15.1.5, §15.3 · Delta: delta.md §9 · Product: mvp.md §2 rule 1, §6.4, §6.13, §6.14, §8, §11 item 8, M-21, Appendix A, B, C

Rescoped by the minimal-code synthesis, 2026-10-03 (v2 ticket merges, CAT-01+02+03; v1 §6 two `Flow.make` shapes). Absorbs T-CAT-02 ([#3448](https://github.com/smithersai/smithers/issues/3448)) and T-CAT-03 ([#3505](https://github.com/smithersai/smithers/issues/3505)).

## Goal
The palette, slash menu, `/help`, the app agent's tools, `smthrs` and the Smithers skill show exactly mvp.md Appendix A plus repository flows, each command declared once. A build that registers a command, control or flow tag absent from Appendix B or C, or marked Cut or Replaced there, fails.

## Scope
In: one descriptor per Appendix A row and B.4 control (name, slash, payload schema, HTTP binding, CLI path, group, visibility `core | advanced | in-card | hidden`, actor eligibility, minimum role, `agent: run | confirm | never` from Appendix B's Who column); generated `catalog.mvp.json`; allowlist hiding; the allowlist test over app ids, CLI commands and flow tags; CLI doors and the generated skill section; Replaced-tag rejection once T-FLW-11 lands; the product-words lint (§14.6b).
Out: confirmation storage (T-APP-04); handlers for `new` rows (their feature tickets; here a typed "not available yet" refusal); deleting cut surfaces (T-CUT-01..03); TUI hiding (T-CUT-03).

## Changes
- Reshape `packages/smithers/ui/src/app-operations/index.ts`: the host-neutral `Operation` is the descriptor. Rename `modelInvocable` and `userOnlyReason` (`:93`, `:114`) to `agent` in place. Rejected: a new `packages/rpc/src/catalog/` descriptor package, which would be a second declaration of the same operations.
- Reshape `apps/app/src/mainview/flows/registry.ts` (`NAMESPACES`, `slashItems`, `disclosedToAgent`), `agentTools.ts`, `FlowName.ts` and `entries/chat.ts`: read visibility and `agent` from the descriptor; apply the Appendix B renames with no alias.
- Reshape `packages/smithers/src/internal/backend/Commands.ts:130` (`mount`): one CLI action per descriptor open to `external_agent`, one generic handler to its HTTP binding. incur already generates the CLI tree and skills from it. Person card doors for `/secrets`, `/members`, `/settings` open the app card and mutate nothing.
- Reshape `Definitions.ts:533-562` and `History.ts`: delete `history todo|land|retry|show`; they become `todo new`, `merge`, `todo retry`, `stack`. Hide non-MVP groups with an explicit list in `Cli.ts`; they stay published.
- Reshape `packages/smithers/skills/smithers/SKILL.md`: a generated `## Commands` section with each command's `agent` value, plus a drift check.
- Reshape, two `Flow.make` shapes → one: move the body-less callers of the deprecated object form (`packages/smithers/flows/core/src/Flow.ts:417`) to `@smthrs/flow`, so the tag allowlist reads one shape (38L).
- Delete the placeholder `packages/rpc/src/catalog/index.ts` (137 lines, "Temporary … replaced by T-CAT-01") in the change that lands `catalog.mvp.json`.
- New: `catalog.mvp.json` generator with `--check` and `--skill`, the allowlist test (about 250 lines) and `cards/productWords.ts`. Rejected reuse: no existing artifact lists the shipped catalog for CLI, skill and tests together.

## Tests
- Unit: one descriptor per Appendix A row and B.4 control; `catalog.mvp.json` and skill freshness; each row's role and `agent` equal its Who column.
- Unit (C-CAT-01): the real registry's slash, palette, `/help` and agent-tool sets equal Appendix A, plus exactly one door per fixture repository flow; an unlisted or Cut app id, CLI command or tag fails and names the row; host and coding registries hold only their runtime's tags.
- Unit (C-CAT-01 step 8): after T-FLW-11, `coding/Request`, `coding/Vibe`, `coding/Verify` and `review/change` are rejected by a reviewed literal policy over both registries; no constructor option or public API change.
- Unit (C-CAT-02, C-CAT-03): `makeCli().serve(argv)` against a recording HTTP server and pinned literal fixtures: paths, flags, required inputs, refusals before dispatch; `skills add` installs exactly the open rows.
- Integration: CLI against the install router and real PostgreSQL: `todo steer T1` runs; `todo new` and `merge T1` return 202 "Waiting for Ben to confirm" with no effect before approval; a delegated person-only call returns 403 `never`.
- Unit (C-UI-02): product-words lint; e2e suites before and after the renames.

## Acceptance
- [C-CAT-01](../checks/C-CAT-01.md), [C-CAT-02](../checks/C-CAT-02.md), [C-CAT-03](../checks/C-CAT-03.md), [C-UI-02](../checks/C-UI-02.md), [C-UI-13](../checks/C-UI-13.md), [C-ACC-02](../checks/C-ACC-02.md) (CLI confirmations), [C-SEC-05](../checks/C-SEC-05.md), [C-J1-04](../checks/C-J1-04.md).

## Risks and notes
- Risk: renames break the 116 Playwright specs. Migrate group by group; a drop larger than the renamed specs means a lost door.
- Risk: incur 0.5.1 has no hidden flag; a skill installed for a non-MVP group confirms drift.
- Appendix B shorthand (`.edit`, `runs.graph.*`) needs expansion; a kept id failing the allowlist confirms a wrong rule.
- smithers-38 signs off any public TypeScript API diff; smithers-b8 the CLI and skill contract.
