# T-CAT-01 One command catalog: descriptors, `catalog.mvp.json`, allowlist, CLI doors and skill, Replaced-tag rejection

Stage S1 · Size L · Depends on T-UI-14 · CLI phase:  · Tag phase: — · Unblocks T-ACC-03, T-AGT-04, T-APP-01, T-APP-04, T-APP-05, T-APP-06, T-APP-07, T-APP-10, T-APP-15, T-APP-16, T-APP-18, T-APP-20, T-APP-21, T-CUT-03, T-FLW-03, T-FLW-05, T-FLW-07, T-FLW-08, T-FLW-13, T-MCH-08, T-MNT-01, T-MNT-03, T-REL-02, T-STK-02, T-TRM-02 · Issue: [#3434](https://github.com/smithersai/smithers/issues/3434)
Spec: spec.md §5.4, §6.1.1–§6.1.4, §6.4, §14.2, §15.1.4, §15.1.5, §15.3 · Delta: delta.md §9 · Product: mvp.md §2 rule 1, §6.4, §6.13, §6.14, §8, §11 item 8, M-21, Appendix A, B, C

Rescoped by the minimal-code synthesis, 2026-10-03 (v2 ticket merges, CAT-01+02+03; v1 §6 two `Flow.make` shapes). Absorbs T-CAT-01 ([#3448](https://github.com/smithersai/smithers/issues/3448)) and T-CAT-01 ([#3505](https://github.com/smithersai/smithers/issues/3505)).

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

C-CAT-03 (folded steps and assertions):
1. Regenerate the SKILL.md `## Commands` section in memory from `catalog.mvp.json`, then diff it against the committed file.
2. Assert installed command paths, agent values and excluded groups against the committed literal CatalogCli.ts fixture via makeCli().serve([\"skills\", \"add\"]). Treat regeneration as a supplemental drift assertion, not the command-set oracle. Pin banned terms in the fixture instead of deriving expectations from production productWords.ts.
3. Record every skill directory and command written to the temporary target.
4. Compare installed paths, agent values and excluded groups with the literal fixture, without reading hidden groups from Cli.ts.

Pass when:
- Step 1: no diff.
- Installed command paths, agent values, confirmation descriptions and excluded groups equal the committed literal CatalogCli.ts fixture. Person card doors are excluded; read-only search and GitHub status remain included.
- Step 3: the installed skills name no command from step 4. The Smithers skill is present and contains the section from step 1.
- The section contains none of the banned terms pinned in the fixture. No runtime expectation is derived from productWords.ts, catalog.mvp.json or spec files.

Fail when:
- The skill still lists the authoring guide only.
- A generated `smthrs-admin`, `smthrs-tui` or `smthrs-org` skill is installed.
- The section was hand-edited and drifts from `catalog.mvp.json`.
- `/merge` is described as merging directly.


C-CAT-02 (folded steps and assertions):
6. Feed recording HTTP stubs literal allow, 202 confirmation/requested, 403 never/never, 403 permission/permission, 401 permission/unauthenticated and 503 infra/confirmation_unavailable responses. Record CLI stdout, stderr and exit codes.
1. Invoke makeCli().serve(argv) with committed literal CatalogCli.ts cases through parser and production dispatcher recording adapters.
2. Run CatalogCli.integration.test.ts through production install routes with real PostgreSQL, delegated authorization and confirmation approval.
3. Compare actual command paths and parsed payloads against literal fixtures.
4. Assert pinned paths, flags, payloads, attribution, invalid-input refusals and mutation-free person card doors; descriptors and catalog.mvp.json are supplemental parity inputs only.
5. List `Definitions.ts` entries whose HTTP method and path equal a descriptor's binding.
- Dispatch a confirmable command through the installed CLI and inspect its 202 result and printed state.

Pass when:
- Step 6 prints Waiting for <person> to confirm with id/pending state for 202, makes no follow-up execution call and exits with a code distinct from refusal. Refusals preserve exact class/code and never fabricate pending/success or completion. S1 terminal immediate append and S2 ordinary confirmation remain distinct server-issued profile outcomes.
- `/terminal` resolves through `workspace ssh`, `shell` and `exec`. `/search` and `/github` status expose read-only external-agent paths. GitHub App changes are Owner-only (C-ACC-01).
- Every Appendix A row that lists `external_agent` has a resolvable CLI action path. `/secrets`, `/members` and `/settings` have only person card doors: running them opens the app card and sends no mutation. UI-only rows ⌘K, `/help`, `/stop` and `/theme` have no CLI path (§6.1.2a, mvp.md B.6).
- For every literal external-agent action case, step 3 finds zero differences from the committed fixture.
- The recording adapter receives exactly one request per external-agent action fixture, with its literal method, path, body and Smithers-Via attribution.
- Step 5 returns an empty list, so no second CLI declaration exists for a catalog action.
- The CLI reports id/pending state and Waiting for <person> to confirm with its distinct exit code.

Fail when:
- A row's CLI door is an old name, such as `history todo` for `/todo.new`.
- A TODO argument takes `#n` instead of `Tn`.
- `smthrs merge Tn` with a delegated credential merges instead of returning a person confirmation (§5.4).
- A row whose Appendix B Who column has no X exposes an external-agent mutation path, such as `smthrs secrets set`.
- A flag is optional in the CLI but required in the payload, or the reverse.
- An enum is widened to string.
- The handler builds its own URL instead of the descriptor binding.
- A test passes only against the installed rc binary.


C-CAT-01 (folded steps and assertions):
1. Load reviewed literal Appendix A/B/C fixtures, including explicit shorthand expansions (`.edit`, `*`, angle-bracket ids).
2. Map each Appendix A row and each B.4 control to exactly one descriptor by slash or id.
3. Regenerate `catalog.mvp.json` in memory and compare it byte for byte with the committed file.
4. From the first registry build, compute S (slash menu), P (palette), H (`/help`, with groups and collapsed state) and T (agent tools, `agentTools.ts`). From the CLI tree and the generated skill section, compute X (external-agent commands).
5. From the second build, compute S′, P′, H′ and T′ and their differences from step 4. Compare the differences with the `flows/*/flow.ts` fixtures, not with Appendix A.
6. For each row, compare actor eligibility, minimum role and `agent` with its Appendix B Who column: **A** or **A✓** → `app_agent`; **X** → `external_agent`; **A✓** → `confirm`, otherwise **A** or **X** → `run`, otherwise `never`; "Maintainer", "maintainer for Discard" and "Owner" → the minimum role.
7. Match every registered app flow id against B.1, B.2 and B.4, and every backend CLI command against B.6 and the Appendix A rows allowed to X.
8. Build the production host-flow and coding-host registries and compare tags and runtime placement with the literal Appendix C fixture. Inject each Replaced entry point in a negative fixture and assert rejection without executing repository code.
- Generate the S1 host reference from exported definitions after T-INS-08 registers the group.

Pass when:
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

Fail when:
- A Cut id (`chat.clear`, `tab.*`, `billing.*`, `change.split`) or a Cut Appendix C tag is registered, or a hidden id (`history.bootstrap`, `debug.*`) appears in S, P, H or T.
- A renamed command survives under its old name as an alias (`history.todo` alongside `todo.new`).
- An **A✓** command is `run`, so the agent executes it without the author's press, or an **A** command is `confirm` (§15.1.5).
- `discloseToAgent` leaks a hidden entry to T.
- A repository flow fails the Appendix A equality, or a `flows/<name>/flow.ts` yields no door or two.
- An `in-card` row appears in S, P, H or X, or a UI-only row appears in X.
- A Machine tag registers in the host flow runtime, or `coding/Request`, `coding/Vibe`, `coding/Verify` or `review/change` is still registered after T-FLW-11.
- A descriptor changes without regenerating `catalog.mvp.json`.


C-UI-02 (folded steps and assertions):
1. Run `lintCopy` on each boundary fixture and compare with its expected result.
2. Render every View × fixture × {inline, maximized} × {light, dark}, and run `lintCopy` on each.
3. Collect the `lintText` results from the T-APP adapter tests.
4. Read the Settings View's host label from the Settings fixture.
5. Count the renders in step 2 against Views × fixtures × 4.

Pass when:
- Step 1: every boundary fixture gives its expected result.
- Steps 2 and 3: zero violations.
- Step 4: the detected host is labeled "This Mac" (§14.3).
- Step 5: the count equals Views × fixtures × 4; nothing is skipped.
- The same DOM gives the same result at every viewport width and in both themes.

Fail when:
- A View renders lazily or behind a flag and escapes step 2.
- A banned term hides in an `aria-label`, `title` or `placeholder`, which assistive technology reads aloud.
- Settings shows "host profile" or "VM" for the detected host.
- A rule's result depends on layout, so a wrapped label changes the outcome.
- Chrome copy is wrapped in `data-content` to dodge the lint. The lint can't see this; the copy review must reject it.

- Unit: one descriptor per Appendix A row and B.4 control; `catalog.mvp.json` and skill freshness; each row's role and `agent` equal its Who column.
- Unit (C-CAT-01): the real registry's slash, palette, `/help` and agent-tool sets equal Appendix A, plus exactly one door per fixture repository flow; an unlisted or Cut app id, CLI command or tag fails and names the row; host and coding registries hold only their runtime's tags.
- Unit (C-CAT-01 step 8): after T-FLW-11, `coding/Request`, `coding/Vibe`, `coding/Verify` and `review/change` are rejected by a reviewed literal policy over both registries; no constructor option or public API change.
- Unit (C-CAT-02, C-CAT-03): `makeCli().serve(argv)` against a recording HTTP server and pinned literal fixtures: paths, flags, required inputs, refusals before dispatch; `skills add` installs exactly the open rows.
- Integration: CLI against the install router and real PostgreSQL: `todo steer T1` runs; `todo new` and `merge T1` return 202 "Waiting for Ben to confirm" with no effect before approval; a delegated person-only call returns 403 `never`.
- Unit (C-UI-02): product-words lint; e2e suites before and after the renames.

## Acceptance
- [C-CAT-01](../checks/C-CAT-01.md), [C-CAT-02](../checks/C-CAT-02.md), [C-CAT-03](../checks/C-CAT-03.md), [C-UI-02](../checks/C-UI-02.md), [C-UI-13](../checks/C-UI-13.md), [C-ACC-02](../checks/C-ACC-02.md) (CLI confirmations), [C-SEC-05](../checks/C-SEC-05.md), [C-J1-04](../checks/C-J1-04.md).

## Risks and notes
- Activation with T-FLW-11: The composition registers with the existing operation catalog; gate activation on its consumer check. Missing providers refuse; joint acceptance gates enabling the path.
- Activation with T-STK-06: Steering is an operation consumer, not a catalog prerequisite. Missing providers refuse; joint acceptance gates enabling the path.
- Activation with T-STK-02: Placement is an operation consumer, not a catalog prerequisite. Missing providers refuse; joint acceptance gates enabling the path.
- Activation with T-STK-01: Register typed operation metadata before routes; absent handlers refuse. Missing providers refuse; joint acceptance gates enabling the path.
- Activation with T-APP-04: Catalog generation does not require the Confirm renderer or dispatcher consumer. Missing providers refuse; joint acceptance gates enabling the path.
- Activation with T-ACC-04: Descriptors precede delegated mint integration; unavailable actions refuse. Missing providers refuse; joint acceptance gates enabling the path.
- Risk: renames break the 116 Playwright specs. Migrate group by group; a drop larger than the renamed specs means a lost door.
- Risk: incur 0.5.1 has no hidden flag; a skill installed for a non-MVP group confirms drift.
- Appendix B shorthand (`.edit`, `runs.graph.*`) needs expansion; a kept id failing the allowlist confirms a wrong rule.
- smithers-38 signs off any public TypeScript API diff; smithers-b8 the CLI and skill contract.
