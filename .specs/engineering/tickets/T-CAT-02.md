# T-CAT-02 CLI doors for Appendix A; skill generated from the catalog

Stage S1 · Size M · Depends on T-CAT-01, T-ACC-04, T-ACC-05, T-APP-04, T-STK-01, T-STK-02, T-STK-06 · Unblocks T-APP-06, T-APP-23, T-CUT-03, T-FLW-05, T-FLW-07, T-FLW-08, T-FLW-13, T-REL-02, T-TRM-02 · Issue: [#3448](https://github.com/smithersai/smithers/issues/3448)
Spec: spec.md §5.4, §6.1.1–§6.1.3, §6.4, §15.3 · Delta: delta.md §9 (CLI mount consumes descriptors; skill generator) · Product: mvp.md §2 rule 1, §6.13 "Smithers skill", "CLI", §8 (CLI and skill: Keep), J6.3–J6.4, M-21, Appendix A, Appendix B.6

## Goal
`smthrs` has one command for every Appendix A row open to external agents, plus person card doors for `/secrets`, `/members` and `/settings` that expose no external-agent action (§6.1.2a, mvp.md B.6, C-CAT-02). Each command's flags are its catalog payload schema, and each follows its row's `agent: run | confirm | never` value. The Smithers skill lists exactly those commands, so Claude Code and Codex see the same catalog and the same rules as the app agent (Appendix B.6).

## Scope
Approved integration requirements (In):
- Render HTTP 202 as Waiting for <person> to confirm with confirmation id/pending state and an exit code distinct from refusal. Render exact never/permission/death/infra envelopes; no 202 executes a TODO or merge. Checks: C-CAT-02, C-ACC-02.
- A-27 CLI rulings: `/terminal` uses `workspace ssh`, `shell` and `exec`. `/search` and `/github` status carry X and use the same read-only skill as the app agent. `/secrets`, `/members` and `/settings` open the app card for the person, and delegated mutations are refused; GitHub App changes require the Owner's session. Checks: C-CAT-02, C-CAT-03, C-ACC-01.

In:
- `Commands.ts:mount` builds one CLI action command per descriptor that lists `external_agent`, and builds the person card doors separately from their catalog descriptors. UI-only rows (⌘K, `/help`, `/stop`, `/theme`) have none. `/secrets`, `/members` and `/settings` have person CLI doors that open the app card, with no external-agent action path. Checks: C-CAT-02, C-CAT-03.
  - Positional arguments come from `Tn` (TODO ids), `#n` (issues and PRs), `<name>`, `<path>` and `<branch>`; options come from the rest of the payload.
  - One generic handler sends the payload to the descriptor's HTTP binding.
  - Missing required input gets a typed refusal naming the flag, since the CLI has no form card (§6.1.4 is the app's rule).
- Delete the `Definitions.ts` entries the catalog replaces: `history todo|land|retry|show` become `todo new`, `merge`, `todo retry` and `stack`, with no alias left behind. Also resolve each hidden app/CLI duplicate pair T-CAT-01 listed.
- Every request from these commands carries `Smithers-Via` (T-ACC-04). The CLI's credential is always `delegated` (§5.3.1), so each command follows its row's `agent` value through T-ACC-05 (§15.1.5): `run` executes; `confirm` prints Waiting for <person> to confirm with id/pending state and exits with a code distinct from refusal (`smthrs merge Tn` opens the member's **Review & merge**); a `never` row has no external-agent CLI action, and eligible delegated smthrs api to its person-only route returns 403 never/never; scope/role and excluded multi-actor class failures return 403 permission/permission.
- The Smithers skill's catalog section is generated from `catalog.mvp.json`, with a drift check. Each command line names its `agent` value, so an external agent knows which commands open a confirmation.
- `smthrs skills add` installs no skill for a hidden command group.
- MVP help and CLI docs list only Appendix A rows and the B.6 kept items (`login`, `ssh-key`, `workspace ssh|shell|exec|cp`, `api`, and `host start|stop|status|upgrade|backup|restore`, run by the owner on the Mac). An explicit hidden list in `Cli.ts` removes the other groups, since incur 0.5.1 has no hidden flag (§6.1.2). Those groups stay published and keep `--help` (§6.1.3, mvp.md §8).

Out:
- Server routes for `new` rows (their feature tickets). The CLI door exists, and an unserved route returns the server's typed refusal.
- The app side (T-CAT-01).
- TUI hiding (T-CUT-03).
- The `ssh` command's behavior (T-TRM-03).
- Credential minting, authorization policy and confirmation storage (T-ACC-04/05); Confirm views and Containers (T-UI-05, T-APP-04); repository flow loading or local command execution. The CLI sends requests; repository code runs only in machines (§1.3, M-29/M-30), never through a host-process fallback. smithers-3f reviews this boundary before start (C-SEC-05).

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
- Literal source-CLI dispatcher stubs cover allow, 202 confirmation/requested, 403 never/never, 403 permission/permission, 401 permission/unauthenticated and 503 infra/confirmation_unavailable. Missing S1 delegated append card paths return 403 permission/confirm_in_app with no effect; with the listed consumer dependency, delegated append requires a private confirmation. A person-session direct append is the distinct allow case. Assert Waiting for <person> to confirm, id/state and an exit code distinct from refusal; no 202 fabricates TODO or merge completion (C-CAT-02, C-SEC-05).
- Unit: `packages/smithers/test/CatalogCli.test.ts` (new, C-CAT-02) invokes the production `makeCli().serve(argv)` parser and dispatcher, with a recording HTTP server and app-opener adapter. Pin Appendix A/B.6 command paths, flags, types, required inputs, enum values, method/path/body, attribution and expected refusals in `packages/smithers/test/fixtures/CatalogCli.ts` (new). Review those literals against product when authored; never derive expectations from descriptors, `catalog.mvp.json`, the CLI tree or spec files at runtime. Assert required-flag and invalid-enum failures before HTTP dispatch; person card doors open the pinned app destination and send no mutation.
- Unit: `packages/smithers/test/CatalogSkill.test.ts` (new, C-CAT-03) invokes `makeCli().serve(["skills", "add"])` into a temporary directory. Assert installed command paths and each `agent` value against the same pinned fixture, including literal excluded groups. Separately regenerate the skill section and check drift; regeneration is not the acceptance oracle.
- Integration: `packages/smithers/test/CatalogCli.integration.test.ts` (new), source CLI dispatcher against the install router and real PostgreSQL after the listed dependencies land. A seeded TODO receives `todo steer T1` with `via=cli`; `todo new --prompt …` and `merge T1` create one_click and review_merge confirmations and no TODO or merge before Ben's session approves. Assert HTTP 202, only `{confirmation, state: requested}`, "Waiting for Ben to confirm" and exit 0, distinct from nonzero refusals. Exercise the three person card doors and delegated `api PUT /api/secrets/X`: after valid role/scope checks, expect HTTP 403 with class `never`, no confirmation and no mutation (§5.2.1). Use literal request/result expectations, real authorization and the shipped confirmation routes, not direct handler calls. Any execution reached by approval or steer uses a branch machine, never host repository code (C-SEC-05).
- Regression: `test/OneCli.test.ts`, `SkillsInstall.test.ts` and `UnifiedMcp.test.ts` stay green; tree comparisons supplement the pinned dispatcher assertions.
## Acceptance

- [C-J1-04](../checks/C-J1-04.md): S1 part at its named layer.

- [C-CAT-02](../checks/C-CAT-02.md): every Appendix A row open to external agents has a CLI path with flags equal to its payload schema; person card doors for secrets, members and settings expose no external-agent action.
- [C-CAT-03](../checks/C-CAT-03.md): the Smithers skill lists exactly the Appendix A rows open to external agents.

## Risks and notes
- **Hidden list drift.** The hidden list is ours because incur 0.5.1 has no hidden-command option (`rg hidden` over its `src/` finds only help internals). Observation that confirms drift: `smthrs skills add` into a temporary directory installs a skill for a group outside Appendix A. Per CLAUDE.md, an upstream incur flag is filed only if incur is ours to change.
- **Two-catalog residue.** Hidden CLI groups (`admin`, `org`, `history bootstrap`, …) keep their `Definitions.ts` form. They are not doors for a catalog command, so no behavior has two declarations. Falsified if T-CAT-01's duplicate list is non-empty after this ticket.
- The installed `smthrs` (rc.1) still lists `create-app` (research `cli-api-cuts.md`). Tests import source and never shell out to the installed binary.
- Before start, smithers-b8 approves the CLI/skill public contract, hidden-group mechanism and person card doors; smithers-38 approves the catalog subpath and generator mode; smithers-3f approves credential, confirmation and execution seams. Will decides any product-policy change; smithers-8a resolves conflicts with the normative spec. This ticket does not change catalog policy.

## Ready checklist
1. Dependencies: T-CAT-01 supplies descriptors; T-ACC-04/05 supply attributed delegated dispatch and confirmations; T-APP-04 supplies the person approval consumer; T-STK-01/02/06 supply the TODO storage, creation and steer routes used in acceptance. Feature routes outside these tests remain feature-ticket work and fail closed while absent.
2. Exclusions: server feature routes, app catalog work, TUI hiding, SSH behavior, credentials/confirmation implementation and host execution are named under Out.
3. Tests: CatalogCli and CatalogSkill invoke the source CLI dispatcher; CatalogCli.integration invokes it against the install router. A committed literal fixture pins expectations independently of runtime code and spec files (C-CAT-02/03).
4. Decisions: smithers-b8 approves the CLI/skill contract; smithers-38 approves catalog/generator seams; smithers-3f approves backend security seams; Will decides product changes and smithers-8a resolves spec conflicts.
5. Owner pre-review before start: smithers-b8: Do person card doors perform no mutation? Does hiding preserve published non-MVP groups? Are confirmation output and exit codes compatible? smithers-38: Is the per-module catalog import stable? Does the generator mode preserve descriptor authority? smithers-3f: Does production dispatch enforce delegated role/scope policy? Can any CLI path execute repository code on the host?
6. Security: delegated credentials never approve; eligible person-only raw API calls receive 403 never, and insufficient role/scope receives permission. Repository execution remains machine-only with no host fallback; smithers-3f reviews these preconditions (C-SEC-05, C-ACC-01/02).
