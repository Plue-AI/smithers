# T-FLW-08 Restore owner model assignment (`ModelCards` slice); Agent card

Stage S1 · Size M · Depends on first merge: T-INS-06, T-ACC-01 · rest of S1: T-ACC-03, T-UI-13, T-FLW-02, T-FLW-03, T-COL-02, T-CAT-01, T-STK-02 · Unblocks T-APP-05, T-APP-07, T-APP-17, T-APP-16, T-REL-02 · Issue: [#3454](https://github.com/smithersai/smithers/issues/3454)
Spec: spec.md §5.2 (install settings row), §6.3 `/api/agents`, §7.2 `agents`, §11.5a, §14.3, §15.1.5, §16.2 step 4 · Delta: delta.md §1 (Restore model configuration row) · Product: mvp.md §11 item 3, J11.4, §6.14, §6.5 Models, M-23, Appendix A `/agents`, `/agent <name>`, Appendix B.2 (`agent.list`, `model.*`)

Rescoped by the minimal-code synthesis, 2026-10-03 (v2 ruling 5): restore the model-assignment slice and delete its duplicate.

## Goal
The owner sets the three model roles (`fast`, `coding`, `jev`) in Settings through the restored model configuration, and any agent's model as an owner setting that applies at once, with no TODO. The Agent card shows each factory agent's effective model, source, instructions and runs.

## Scope
First-merge phase (C-J1-04 needs a working model):
- Restore the model-assignment slice: the Models section and the entries `model`, `model.list`, `model.new`, `model.edit`, `model.save`, `model.show`, `model.remove`, `model.test`, `model.assign`, and their controller.
- Owner-session writes only; members read. Fallback: without a `fast` key, the app agent and summaries use `coding`.

Rest of S1:
- Agent card for planner, implementer, reviewer and app agent; `GET /api/agents`, `PUT /api/agents/{role}/model`, the `agents` topic.
- Instructions are repository Markdown read as data from Active `main` (`.smithers/instructions/app.md`, the TODO flow's prompts); they change only through a TODO.

Out:
- The model laboratory stays deleted: `ModelCallCard.tsx`, `state/controller/modelCall.ts`, `model.compose`, `model.ask`, `model.recall`, `model.fixture`, `model.prompt`, `model.state`, `model.question`, `model.option`.
- Model access keys and the setup step (T-INS-06 owns the one sealed key store); budget, tool and permission editors; a revived `models` card kind.

## Changes
Restore `39e43c0f^` (= `5b77095672`):
- `apps/app/src/mainview/cards/ModelCards.tsx` (365 lines) minus Compose and the composer (`:9-10`, `:114`, `:346-360`); `ModelCards.test.tsx`.
- `apps/app/src/mainview/flows/entries/model.ts` (209) minus the laboratory entries; `model.test.ts`.
- `apps/app/src/mainview/state/controller/models.ts` (473) and `models.test.ts`, minus laboratory paths.

Delete: `apps/app/src/mainview/cards/views/SettingsModels.tsx` (786f9ac5) and its import at `SettingsView.tsx:5,27`; Settings renders the restored Models section.

Reuse:
- `packages/backend/internal/compose/chat_routes.go:65-83` (`mountModelPublic`): `POST /api/model/credential`, `PUT /api/model/default`, `POST /api/model/test` become owner-session only; reads stay open to members. 403s in `docs/api/openapi/model.yaml`.
- `packages/backend/db/product/migrations/0104_install_settings.sql`: role and per-agent picks as keys `agent.<role>.model`, source `owner`. Rejected: a `flow_config` table (dropped from spec §3 by v2).
- `packages/backend/modelhost/owner_secrets.go`: the only key store.

Reshape:
- `apps/app/src/mainview/cards/AgentCards.tsx` → maps the `agents` topic to T-UI-13's `AgentView` props and is its only mount point (E-21). Rejected: a separate `AgentContainer.tsx`, one user.
- `apps/app/src/mainview/flows/entries/agent.ts` → `agent.list` is `/agents`; add `agent.open` and the `in-card` `agent.model <role> <model>`.

New:
- `GET /api/agents` and `PUT /api/agents/{role}/model`, and the host loader for instruction Markdown. Rejected: `/api/model/default` holds one default, not per-role or per-agent picks with source.

Register restored entries `in-card`, writes `agent: never`, absent from `/help` and from agent tools; mvp.md Appendix B.2 lists them. Docs: restored `MODELS.md` without the composer; `pnpm docs:sync`, `pnpm docs:check`.

## Tests
- Restored unit tests pass with laboratory entries absent and every write absent from `/help` and agent tools.
- Integration (real PostgreSQL), `model_routes_owner_test.go`: owner sessions write; non-owners get 403 `permission`; delegated credentials get 403 `never`; run credentials have no settings authority; members read.
- Integration: `PUT /api/agents/reviewer/model` changes the next call in an already running TODO; an in-flight call finishes on its old model; the flow digest is unchanged.
- Integration: no `fast` key records the `coding` model for app turns; no `app.md` uses built-in text; a merged `app.md` applies to the next turn; an unmerged edit changes nothing.
- Literal fixtures for roles, models and texts; nothing derived from `AGENT_ROLES` or production routing.
- e2e `apps/app/e2e/real/agents.spec.ts` for C-J11-03.

## Acceptance
- [C-J11-03](../checks/C-J11-03.md): the owner's model switch applies to the next run and turn with no TODO; instructions change through a merged TODO; non-owners can't change models.
- [C-J1-04](../checks/C-J1-04.md): first-merge phase, setup's model step lands on the restored roles.
- [C-UI-13](../checks/C-UI-13.md): the Agent card is mounted and `SettingsModels` is deleted.

## Risks and notes
- A repository `.smithers/coding-project.json` declaring `seats` wins field by field (§11.2) and can override the owner's pick. The card shows the effective model and its source.
- Instruction Markdown is host-read data, never evaluated; provider keys stay in the host model proxy.
