# T-FLW-08 Restore owner model assignment (`ModelCards` slice); Agent card

Stage S1 · Size M · Depends on first merge: T-INS-06, T-ACC-01 · rest of S1: T-ACC-03, T-ACC-04, T-FLW-02, T-FLW-03, T-COL-02, T-CAT-01, T-STK-02, T-INS-02, T-FLW-01 · Unblocks T-APP-03, T-APP-05, T-APP-07, T-APP-16, T-APP-17, T-REL-02, T-UI-02 · Issue: [#3454](https://github.com/smithersai/smithers/issues/3454)
Spec: spec.md §5.2 (install settings row), §6.3 `/api/agents`, §7.2 `agents`, §11.5a, §14.3, §15.1.5, §16.2 step 5 · Delta: delta.md §1 (Restore model configuration row) · Product: mvp.md §11 item 3, J11.4, §6.14, §6.5 Models, M-23, Appendix A `/agents`, `/agent <name>`, Appendix B.2 (`agent.list`, `model.*`)
Ready: 2026-10-03 smithers-8a sha256:72d13fe4ab2d

Rescoped by the minimal-code synthesis, 2026-10-03 (v2 ruling 5): restore the model-assignment slice and delete its duplicate.

## Goal
The owner sets the three model roles (`fast`, `coding`, `jev`) in Settings through the restored model configuration, and any agent's model as an owner setting that applies at once, with no TODO. The Agent card shows each factory agent's effective model, source, instructions and runs.

## Scope
Land dark against every unlanded dependency contract. First merge: without T-INS-06 sealed access/settings or T-ACC-01 claimed-owner identity, disable assignment and refuse writes without persistence or provider calls; use T-INS-06's interim owner-session guard until T-ACC-03 lands. Rest of S1: without T-ACC-03/T-CAT-01, leave new Agent routes/commands unserved; without T-ACC-04, expose no delegated path. Without T-FLW-02, show no inferred effective seats; without T-FLW-03, use built-in instructions until verified Active-main data exists. Without T-COL-02, publish no agents deltas. Without T-STK-02/T-INS-02/T-FLW-01, disable instruction-change TODO dispatch and repository execution. Enable each integration after its boundary tests below pass. No host-process or legacy-credential fallback. Checks: C-J1-04, C-J11-03.

First-merge phase (C-J1-04 needs a working model):
- Restore the model-assignment slice: the Models section and the entries `model`, `model.list`, `model.new`, `model.edit`, `model.save`, `model.show`, `model.remove`, `model.test`, `model.assign`, and their controller.
- Owner-session writes only; members read. Fallback: without a `fast` key, the app agent and summaries use `coding`.

Rest of S1:
- Agent card for planner, implementer, reviewer and app agent; `GET /api/agents`, `PUT /api/agents/{role}/model`, the `agents` topic.
- Instructions are repository Markdown read as data from Active `main` (`.smithers/instructions/app.md`, the TODO flow's prompts); they change only through a TODO.

Out:
- The model laboratory stays deleted: `ModelCallCard.tsx`, `state/controller/modelCall.ts`, `model.compose`, `model.ask`, `model.recall`, `model.fixture`, `model.prompt`, `model.state`, `model.question`, `model.option`.
- Model access keys and the setup step (T-INS-06 owns the one sealed key store); budget, tool and permission editors; a revived `models` card kind.
- Custom-agent creation, Cloud sessions, model benchmarks, provider adapters, flow activation (T-FLW-03), TODO execution/merge machinery and duplicate key stores or card schemas.
- Root setup/artifact installation, host repository-code execution and evaluating instruction Markdown. This ticket adds no root step and supplies no input to one.

## Changes
- `AgentCards.tsx` renders the restored ModelCards assignment section; no second Agent view. Settings reuses that section with its role data. Keep `CardRenderers.tsx` as the card mount point and bind actions through `cardActions` → `flowAction`. Model roles reuse T-INS-06's `agent:fast`, `agent:coding` and `agent:jev` settings served by `GET/PUT /api/install`.
Restore `39e43c0f^` (= `5b77095672`):
- `apps/app/src/mainview/cards/ModelCards.tsx` (365 lines) minus Compose and the composer (`:9-10`, `:114`, `:346-360`); `ModelCards.test.tsx`.
- `apps/app/src/mainview/flows/entries/model.ts` (209) minus the laboratory entries; `model.test.ts`.
- Reshape current `apps/app/src/mainview/state/controller/models.ts:1-25` (`resolvedSeats`, `seatBinding`) with the deleted assignment-controller slice and restore `models.test.ts`, minus laboratory paths. Keep the current binding helpers; add no second controller.

ModelCards and model-entry files and their tests are absent today. The counts/removal ranges above describe the restoration source, not current files; restore only assignment.

Delete: `apps/app/src/mainview/cards/views/SettingsModels.tsx` (786f9ac5) and its import at `SettingsView.tsx:5,27`; Settings renders the restored Models section.

Reuse:
- `packages/backend/internal/compose/chat_routes.go:65-83` (`mountModelPublic`): `POST /api/model/credential`, `PUT /api/model/default`, `POST /api/model/test` become owner-session only; reads stay open to members. 403s in `docs/api/openapi/model.yaml`.
- `packages/backend/db/product/migrations/0104_install_settings.sql:1-8`: reuse the existing `install_settings` table and T-INS-06 role rows; per-agent picks use `agent:<role>` (§11.5a), source `owner`. Add no table or duplicate migration.
- `packages/backend/modelhost/owner_secrets.go`: the only key store.

Reshape:
- `apps/app/src/mainview/cards/AgentCards.tsx` → maps the `agents` topic to the restored Models section and is its only mount point (E-21). Rejected: a separate `AgentContainer.tsx`, one user.
- `apps/app/src/mainview/flows/entries/agent.ts` → `agent.list` is `/agents`; add `agent.open` and the `in-card` `agent.model <role> <model>`.

Reshape existing boundaries:
- Extend `packages/rpc/src/Cards.ts:2716-2750`'s agents schema with instructions, effective model/source and runs; no duplicate schema.
- Add `GET /api/agents` and `PUT /api/agents/{role}/model` using existing model/settings services and the shared authorizer. Rejected: `/api/model/default` holds one default, not per-role or per-agent picks with source. Resolve the effective pick before each model call, including calls within running TODOs, without changing the flow digest; keep the in-flight call's binding.
- Reshape instruction composition at `apps/app/src/mainview/state/controller/turns.ts:389-392` for the host turn runner. Add only the Markdown data read from verified Active-main revision content. The current function composes built-in text, not repository instructions. Never import repository modules or read unmerged working-copy files.

Register restored entries `in-card`, writes `agent: never`, absent from `/help` and from agent tools; mvp.md Appendix B.2 lists them. Docs: restored `MODELS.md` without the composer; `pnpm docs:sync`, `pnpm docs:check`.

## Tests
- Restored unit tests pass with laboratory entries absent and every write absent from `/help` and agent tools.
- Integration (real PostgreSQL), `packages/backend/internal/compose/model_routes_owner_test.go` (new): call production install-router model writes, `GET /api/agents`, `PUT /api/agents/{role}/model` and `GET/PUT /api/install`, not service methods. Owner sessions write; member/maintainer sessions and insufficient-role delegated callers get 403 `permission`; role/scope-eligible owner delegated callers get 403 `never`; run/machine credentials have no Agent-card/settings authority. Members read models. Refusals create no setting, confirmation or provider call. Exercise restored assignment through the production command dispatcher. Check: C-J11-03.
- Integration, same file: admit a TODO through the production dispatcher and T-INS-02/T-FLW-01 microVM launcher, then call `PUT /api/agents/reviewer/model`. Its next call uses the new model; an in-flight call finishes on the old one; the flow digest is unchanged. Observe actual proxy requests and run records. Test Active-main seats overriding only their declared fields. Check: C-J11-03.
- Integration, same file: submit turns through the served chat route/host turn dispatcher. No `fast` key records the `coding` model; absent `app.md` uses built-in text. Move main through production GitHub polling and T-FLW-03 activation: merged `app.md` applies to the next turn; unmerged edits and failed activation change nothing. Markdown code canaries remain data and execute nothing on the host. Exercise each unavailable dependency in Scope and prove refusal causes no write or execution. Checks: C-J11-03, C-SEC-02.
- Literal fixtures for roles, models, sources, errors and texts; no expectations from spec Markdown, `AGENT_ROLES` or production routing. Replace the existing `AGENT_ROLES`-derived oracle in `apps/app/e2e/real/agents.spec.ts:1-25` with committed literal values; drive `/agents` and the model picker through production dispatch.
- e2e `apps/app/e2e/real/agents.spec.ts` for C-J11-03.

## Acceptance
- [C-J11-03](../checks/C-J11-03.md): the owner's model switch applies to the next run and turn with no TODO; instructions change through a merged TODO; non-owners can't change models.
- [C-J1-04](../checks/C-J1-04.md): first-merge phase, setup's model step lands on the restored roles.
- [C-SEC-02](../checks/C-SEC-02.md): repository execution stays in machines; instruction Markdown remains data.
- [C-UI-13](../checks/C-UI-13.md): the Agent card is mounted and `SettingsModels` is deleted.

## Risks and notes
- A repository `.smithers/coding-project.json` declaring `seats` wins field by field (§11.2) and can override the owner's pick. The card shows the effective model and its source.
- Instruction Markdown is host-read data, never evaluated; provider keys stay in the host model proxy. Read verified Active-main revision bytes, not working-copy symlinks. Repository flow loading, instruction-change TODOs and checks run only in machines as `agent`, never root; unavailable isolation refuses execution (M-29, §1.3). smithers-3f reviews this boundary; C-SEC-02 and C-J11-03 prove it.
- Decisions: smithers-b8 approves commands/public APIs; smithers-3f approves authorization, persistence, per-call resolution and instruction-data security; smithers-38 approves RPC/coding-host contracts under §21.1; smithers-06 approves shared Models rendering and SettingsModels removal. smithers-8a resolves ownership overlaps; Will decides role-default, source-precedence or product-policy changes. No new ADR is required.

## Ready checklist
1. Dependencies: first merge names sealed access and owner identity; rest of S1 names authorization, delegated credentials, seats, activation, live topics, catalog, TODO dispatch and machine-only runtime. Scope states dark landing and refusal for each unavailable contract.
2. Exclusions: Out names the laboratory, keys/setup, editors, custom/Cloud agents, provider adapters, duplicate stores/schemas, activation/merge machinery, root steps and host repository execution.
3. Boundary tests: production install/model/Agent routes, command/turn dispatch, GitHub poll/activation and the microVM launcher; C-J1-04/C-J11-03/C-SEC-02 use literal fixtures and replace the current implementation-derived e2e oracle.
4. Decisions: smithers-b8 owns commands/API, smithers-3f persistence/security/runtime resolution, smithers-38 RPC/coding-host contracts, smithers-06 Views, smithers-8a ownership overlaps and Will product-policy changes; no new ADR.
5. Owner pre-review questions (record answers here; the parallel-build directive permits post hoc review): smithers-06: Can Settings and Agent reuse one Models section while deleting SettingsModels? smithers-b8: Do restored commands reach the same owner-session-only routes without a second dispatcher? smithers-3f: Does each next call resolve the effective model without changing the flow digest? Does the instruction read use verified Active-main data with no root input or host evaluation? smithers-38: Does the existing agents schema carry model source, instructions and runs without a duplicate schema? Does the coding host preserve per-field repository precedence?
6. Security: smithers-3f reviews machine-only repository execution, verified-main Markdown data reads and host-only provider keys; C-SEC-02/C-J11-03 prove the boundary. This ticket adds no root step, consumes no root-step inputs and sends no branch input to root; existing launcher root setup stays with T-INS-02/T-FLW-01.
