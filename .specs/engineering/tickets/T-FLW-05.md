# T-FLW-05 `/flow.edit` with a seed patch

Stage S1 · Size M · Depends on T-FLW-03, T-STK-02, T-CAT-01, T-FLW-11 · Unblocks T-FLW-06, T-REL-02 · Issue: [#3513](https://github.com/smithersai/smithers/issues/3513)
Spec: spec.md §3 (`todo_revisions.seed_patch_blob`), §6.1.2, §6.1.4, §6.3 `POST /api/flows edit{name, request}`, §10.2, §10.4.1a, §11.1, §11.5, §11.5b, §15.1.5 · Delta: delta.md §8 (`/flow.edit` row) · Product: mvp.md J5.1–J5.3, §6.12 Change the factory, Appendix A `/flow.edit <name>`, Appendix B.2 (`flow.edit`), M-04, M-11, M-30

## Goal
A member asks the app agent to change a flow, sees the proposed diff on the Flow card, and makes it a TODO whose implement step applies that diff, so the change reaches `main` only through a merged PR.

## Scope
In:
- `/flow.edit <name> <request>` in the catalog and `POST /api/flows edit{name, request}`. A missing input opens a form card (§6.1.4). The command is `agent: confirm` in the catalog (A✓): the app agent posts a one-click confirmation that the prompt's author presses (§15.1.5).
- The app agent produces a patch against the current source of `<name>` at `main`: the repository's `flows/<name>/flow.ts` when it exists, otherwise the built-in composition (§10.4.1a), so the first edit creates `flows/<name>/flow.ts` that imports the steps it doesn't change.
- The Flow card shows the proposed diff first (J5.2). **Make TODO** (in-card, §6.1.2) creates a TODO with the patch as revision 1's `seed_patch`, placed by the usual rules (append by default).
- The `todo` flow (T-FLW-11) applies the seed patch in its implement step, then runs checks and opens the PR (§11.5). If the patch no longer applies when the run starts, the agent re-derives the change from the request and says so in the evidence.
- `/flow.source` on the Flow card (§11.5b) uses this path with an empty seed when no TODO proposes a change to the flow yet, so Source opens on that TODO's branch.
- System flow names are refused (T-FLW-01 catalog) with class `user` and the text "System flows can't be changed".

Out:
- Activation after merge (T-FLW-03); pinning, so the edit never runs its own change (T-FLW-04).
- The Flow card and its Source, Plan and Run doors (T-APP-05).
- Agent model choice, an owner setting (T-FLW-08, §11.5a).
- Learning proposals with seed patches (T-FLW-06), which reuse the seed-patch step.

## Changes
- `packages/backend/internal/services/flow_edit.go` (new) → resolve the base source from the mirror at `main` or from the packaged built-in composition text; ask the app agent (host, §15.1) for a unified diff; enforce that the diff touches only `flows/<name>/**`; store the patch as a blob; return the proposal for the Flow card. Built-in sources ship as data in the server bundle (T-INS-01), never loaded as code by the host.
- `POST /api/flows` (`edit`) → handler, typed errors (§6.2.3), `Idempotency-Key` (§6.2.1); OpenAPI row in `docs/api/openapi/`.
- Command `flow.edit` → registered in the one catalog (`packages/rpc/src/catalog/`, T-CAT-01) with slash `/flow.edit`, CLI path `smthrs flow edit`, group Flows, visibility `core`. **Make TODO** on the proposal is an `in-card` row.
- TODO create path (T-STK-02) → accepts `seed_patch` and writes `todo_revisions.seed_patch_blob`.
- The `todo` flow's implement step (T-FLW-11 composition, `flows/coding/implementation/flow.ts`) → apply the seed patch to the branch working copy before the agent's first turn, and record the result in branch activity attributed to the TODO's author. On a failed apply, give the agent the request and the failed hunks, and add "seed patch re-derived" to the attempt's evidence.

## Tests
- Unit, `packages/backend/internal/services/flow_edit_test.go` (new): with no override, the patch applied to an empty tree yields the built-in composition plus the change; with an override, the patch's base digest equals `main:flows/<name>/flow.ts`; a patch touching `src/` or `flows/other/` is refused; `merge` and `members` are refused with class `user`.
- Unit, `apps/app/src/mainview/flows/Commands.forms.test.ts` (extend): `/flow.edit` with no arguments opens a form card with `name` and `request`.
- Integration (real PostgreSQL, fake GitHub, test process runtime), `packages/backend/internal/services/flow_edit_integration_test.go` (new): edit → proposal → Make TODO → TODO revision 1 holds the seed patch; the run's implement step applies it; the branch head contains `flows/todo/flow.ts`; the run's pinned digest is the Active built-in.
- Integration, same file: an edit with an empty seed creates a TODO whose branch has `flows/todo/flow.ts` once the run starts, and `/flow.source` opens it there.
- Integration, same file: `main` changes `flows/todo/flow.ts` after the proposal, so the patch fails to apply; the run still produces the change and its evidence says the patch was re-derived.
- e2e: [C-J5-01](../checks/C-J5-01.md).

## Acceptance



- [C-J11-02](../checks/C-J11-02.md): S2, S3 qualification; does not block S1 completion.

- [C-J11-02](../checks/C-J11-02.md): Source opens the flow on the proposing TODO's branch, and a scratch-branch Run is a "draft version" that never proposes.

- [C-J5-01](../checks/C-J5-01.md): "Every TODO must run `pnpm test` and update the changelog" in chat produces a diff, a TODO and a PR that adds `flows/todo/flow.ts`.

## Risks and notes
- Risk: the copied composition imports step flows from the coding package, which the team's repository doesn't depend on. Confirmed when `flow-load` (T-FLW-03) marks the merged edit `failed` with an unresolved import. The import path in T-FLW-11's composition must resolve in any repository's machine.
- Risk: the app agent's patch edits a step's internals that the composition only imports. Observed as a refused diff outside `flows/<name>/**`. The prompt to the app agent includes the composition and the exported step names, so it adds or replaces a step instead.
