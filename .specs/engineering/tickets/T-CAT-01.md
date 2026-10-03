# T-CAT-01 One command catalog source; `catalog.mvp.json`; allowlist test from mvp.md Appendix B

Stage S1 · Size L · Depends on T-UI-14, T-APP-19 · Unblocks T-ACC-03, T-ACC-05, T-APP-20, T-APP-21, T-CAT-02, T-CAT-03, T-CUT-03, T-FLW-05, T-MNT-01, T-REL-02 · Issue: [#3434](https://github.com/smithersai/smithers/issues/3434)
Spec: spec.md §6.1.1–§6.1.4 (incl. §6.1.2a–c), §14.2, §15.1.4, §15.1.5, §15.3 · Delta: delta.md §9 (Add one catalog source; Hide/Delete every command not in Appendix A) · Product: mvp.md §2 rule 1, §6.4 "Commands", §6.13, §6.14 (Advanced group), §8 (CLI and skill), §11 stage 1 item 8, M-21, Appendix A, Appendix B (B.1, B.2, B.4, B.6), Appendix C (`actions.md`)

## Goal
The palette, slash menu, `/help` and the app agent's tool list show exactly mvp.md Appendix A plus repository flows. Every command is declared once in a descriptor that the app, the CLI and the skill all read. A build that registers a command, control or flow tag absent from Appendix B or Appendix C, or marked Cut there, fails. Card copy passes one product-words lint.

## Ownership (Will, 2026-10-02)

Design (smithers-06) builds every visual component and its styles: the `/help` Commands card with its collapsed Advanced group. Engineering wires them: the catalog descriptors, `catalog.mvp.json` and the allowlist tests. The seam is the card's view-model schema (spec §14.2.1, T-APP-19). Design builds against it with fixture stories, and engineering doesn't edit components or CSS.

## Scope
In:
- The descriptor type and one descriptor per Appendix A command and per Appendix B.4 in-card control. Each descriptor, and each `catalog.mvp.json` row (§6.1.2), holds:
  - name, slash, payload zod schema and the HTTP binding when the command calls the API;
  - CLI path, `cli: null` for UI-only rows (⌘K, `/help`, `/stop`, `/theme`);
  - journey and group;
  - visibility: `core`, `advanced`, `in-card` or `hidden`;
  - actor eligibility (`person`, `app_agent`, `external_agent`), the minimum role (`member`, `maintainer`, `owner`) and `agent: run | confirm | never` (§6.1.2, §15.1.5).
- Actor eligibility, minimum role and `agent` come from Appendix B's Who column. **A** or **A✓** lists `app_agent`, **X** lists `external_agent`, and B.1 rows never list `external_agent`. **A✓** gives `confirm`; otherwise **A** or **X** gives `run`; neither gives `never`. "Maintainer", "maintainer for Discard" and "Owner" set the minimum role, so `todo.amend` is `confirm` (B.2) and `branch.discard-foreign` is `confirm` with minimum role `maintainer` (B.4). Person-only rows, `/sign-in` and `/sign-out` list `person` alone, are `never` and are absent from the agent's tools (§6.1.2, §15.1.4). Repository flows follow `flow.run` (**A**, **X**), so they are `run`.
- `in-card` commands: the B.4 controls with their stable ids (`todo.return-to-item`, `todo.keep-moved`, `branch.bring-in`, `branch.discard-foreign`, `file.restore`, `file.compare`, `file.restore-deleted`, `file.follow-rename`, `todo.retry-current-flow`, `branch.rebase-now`, `learning.accept`, `learning.dismiss`, `terminal.watch`, `notifications.allow`, `todo.takeover`, `merge.confirm`, `order.ok`, `background.retry`, `background.dismiss`), plus the B.1 card controls (`card.*`, `form.*`, `chat.filter.*`, `toast.dismiss`). They are card buttons, and agent tools where their Who column allows: no slash command, palette entry, `/help` row, CLI path or skill entry (§6.1.2a).
- The app registry reads descriptors. Old ids in the "was" column are renamed (for example `history.todo` → `todo.new`), with no alias left behind.
- Allowlist hiding: an app entry that isn't in Appendix A, isn't `in-card` and isn't a repository flow is `hidden` by construction. It's absent from the slash menu, palette, `/help` and the agent's tools (§6.1.3).
- The allowlist test (§6.1.2). It derives from B.1, B.2, B.4 and B.6, plus Appendix C:
  - App: every registered app flow id matches a B.1, B.2 or B.4 row (its current id, its Rename target or a "(new)" id), and no row marked Cut is registered.
  - CLI: every command in the backend command tree (`Definitions.ts`) matches a B.6 kept item (including `smthrs host start|stop|status|upgrade|backup|restore`) or an Appendix A row allowed to X. The groups B.6 cuts from MVP docs and acceptance (`admin`, `org`, `webhook`, …) are `hidden` and stay published (§6.1.3, mvp.md §8).
  - Flow tags: every `Flow.make`, `Action.make` and `AgentAction.make` tag registered in shipped flows and std tools has an Appendix C row (`.specs/product/actions.md`, 386 rows), and none is marked Cut. Defer and Internal ops rows pass. A ticket that adds a tag adds its row in the same change.
  - Placement: the host flow runtime's registry holds only tags whose Appendix C row runs on Install, and the coding host's registry only Machine rows (§1.3, §6.1.2c).
- Repository-flow doors are outside the Appendix A equality. They are asserted separately: each `flows/<name>/flow.ts` on `main` yields exactly one `/<name>` door in the slash menu, palette, `/help` and the agent's tools (C-CAT-01).
- `/help` lists the catalog by group, with Advanced collapsed (mvp.md §6.14).
- `catalog.mvp.json`, generated from the descriptors, with a freshness check.
- The product-words lint of §14.6b (C-UI-02): banned terms (workflow, thread, task, lane, box, workspace, mythical, sandbox, VM, seat, profile) in visible chrome text, at most 12 words per card body line, no explanatory sentences.
- The list of hidden app entries that duplicate a CLI command, so T-CAT-02 deletes one side.

Out:
- CLI doors, flags and the skill (T-CAT-02).
- The confirmation a `confirm` dispatch posts (T-ACC-05).
- Deleting cut surfaces (T-CUT-01, T-CUT-02) and deferred-surface doors (T-CUT-03).
- New commands' behavior. Each `new` row's handler lands with its feature ticket, such as T-STK-02 `/todo.amend` or T-FLW-05 `/flow.edit`. Here it gets its descriptor and a typed "not available yet" refusal (§6.2.3 class `infra`) that names nothing internal.

## Changes
- `packages/rpc/src/catalog/mvpAppendix.ts` (new): parses the Appendix A and B tables from `.specs/product/mvp.md` and the Appendix C tables from `.specs/product/actions.md`, the single sources. Declare both files as test inputs with `Smithers.file(...)` in `packages/rpc/PACKAGE.ts` (AGENTS.md "Cache contracts"). T-DOC-03 moves the paths if they move. T-FLW-07 reads the Appendix C renderings from the same parser.
- `packages/rpc/src/catalog/Command.ts`, `commands/*.ts` (one file per Appendix A group, plus `in-card.ts`) and `index.ts` (new).
- `packages/rpc/src/catalog/generate.ts` (new) writes `packages/rpc/src/catalog/catalog.mvp.json` (committed). `--check` fails on drift.
- `apps/app/src/mainview/flows/entries/Declare.ts` (`flow({...})`): a catalog command's entry takes name, summary, schema, visibility and `agent` from its descriptor.
- `apps/app/src/mainview/flows/FlowName.ts:17` (`FLOW_NAMES`): apply the renames.
- `apps/app/src/mainview/flows/registry.ts`: `NAMESPACES` (`:361`) follows Appendix A groups; `slashItems` (`:610`) and `disclosedToAgent` (`:544`) read catalog visibility and `agent`; `discloseToAgent` overrides are deleted.
- `apps/app/src/mainview/flows/agentTools.ts`: the agent's list is every row that lists `app_agent` with `agent ≠ never`, `in-card` rows included, plus repository flows. `modelInvocable` and `userOnlyReason` are replaced by `agent`.
- `apps/app/src/mainview/flows/entries/chat.ts` (`chat.commands`, `/help`): groups by descriptor group, Advanced collapsed, `in-card` rows omitted.
- `apps/app/src/mainview/cards/productWords.ts` (new): the §14.6b term list, shared with C-CAT-03.
- Update tests and specs that name renamed ids: `flows/{agent-parity,parity,parity-hosts,registry,namespaces}.test.ts`, `apps/app/e2e/playwright/*.spec.ts`, `apps/app/e2e/real/coverage/deferrals/*.ts` and `FormCardsAgainstMain.main.json`.

## Tests
- Unit `packages/rpc/src/catalog/AppendixA.test.ts` (new): one descriptor per Appendix A row and B.4 control; `catalog.mvp.json` freshness; every payload schema parses its own example; each row's actor eligibility, minimum role and `agent` equal its Appendix B Who column; `cli` is `null` exactly for rows that don't list `external_agent`.
- Unit `apps/app/src/mainview/flows/catalog-allowlist.test.ts` (new) for C-CAT-01. It builds the real registry and computes the slash, palette, `/help` and agent-tool sets. Without repository flows, the first three equal Appendix A exactly; the agent set equals the rows that list `app_agent` with `agent ≠ never`, `in-card` rows included. With fixture repository flows, each set gains exactly their doors.
- Unit `packages/rpc/src/catalog/AppendixB.test.ts` (new) for C-CAT-01: a registered app id or backend CLI command absent from B.1, B.2, B.4 or B.6, or marked Cut there, fails and names the row.
- Unit `packages/rpc/src/catalog/AppendixC.test.ts` (new) for C-CAT-01: every tag in the built flow registry has a non-Cut Appendix C row; a fixture tag with no row fails and names it. It builds the host flow runtime's registry and the coding host's registry separately and fails, naming the tag, when one registers a tag whose row names the other runtime.
- Unit `apps/app/src/mainview/cards/ProductWords.test.tsx` (new) for C-UI-02.
- Unit `flows/agent-parity.test.ts`: every person-only row is absent from the agent's tools (§15.1.4).
- e2e regression: run `apps/app/e2e/playwright` and `apps/app/e2e/real` before and after, and attach both reports. Each new failure ties back to a rename.

## Acceptance
- [C-CAT-01](../checks/C-CAT-01.md): the visible catalog equals Appendix A, excluding repository-flow doors (asserted against `flows/*/flow.ts`); every registered command, control and tag is in Appendix B or C, and none marked Cut is registered.
- [C-UI-02](../checks/C-UI-02.md): no banned terms or explanatory sentences in card chrome.
- [C-UI-13](../checks/C-UI-13.md): A Container's model from a real topic parses with its schema and its actions come from `cardActions`; at each stage exit every §14.3 row of the stage is wired and no View is orphaned
- [C-J1-04](../checks/C-J1-04.md): First TODO to merged PR, unassisted, within 60 minutes of starting the install

## Risks and notes
- **Overview risk:** the renames break the 116 Playwright specs. Migrate group by group behind the allowlist test. A suite that drops by more than the renamed specs means a lost door.
- **Appendix B shorthand.** Rows abbreviate ids (`chat.queue`, `.edit`; `runs.graph.*`). The parser expands a leading-dot name against the previous id's namespace and treats `*` as any suffix. Appendix C has runtime-built ids in angle brackets, matched by pattern. Observation that confirms a wrong rule: a kept id fails the allowlist. The test writes its expansion to the evidence for product to read.
- Resolved: the Cut-tag assertion turns on in the change that completes T-CUT-01's deletions (§6.1.2).
- Resolved: Appendix B.4 now has `order.ok`, `background.retry` and `background.dismiss`.
- Appendix B inventoried 304 app flows; `rg` counts 267 `name:` literals plus wiki operations from `packages/smithers/ui/src/app-operations/wiki.ts`. Generate the list from the built registry in the test, not with `rg`.
