# T-FLW-08 Agent card and owner model configuration restored from `5b77095672`

Stage S1 · Size M · Depends on T-INS-06, T-ACC-03 · Unblocks — · Issue: to file
Spec: spec.md §3 (`flow_config`), §5.2 (install settings row), §6.1.2, §6.3 `/api/agents`, §7.2 `agents`, §11.5, §11.5a, §14.3, §14.5.3, §15.1, §15.1.4, §15.2, §16.2 step 4 · Delta: delta.md §1 (Restore model configuration row) · Product: mvp.md J11.4, §6.14 Configure an agent, §6.5 Models, M-23, Appendix A `/agents`, `/agent <name>`, Appendix B.2 (`agent.list`, `model.*`)

## Goal
The owner sets the three model roles in Settings, sees each factory agent's model, instructions and runs on the Agent card, and switches any agent's model as an owner setting that applies at once, with no TODO. Instructions are Markdown in the repository and change only through a TODO.

## Scope
In:
- Restore the owner-only model configuration from `5b77095672`: the Models card and the entries `model`, `model.list`, `model.new`, `model.edit`, `model.save`, `model.show`, `model.remove`, `model.test` and `model.assign`, with their controller.
- Keep the model laboratory deleted: `ModelCallCard.tsx`, `state/controller/modelCall.ts`, and the entries `model.compose`, `model.ask`, `model.recall`, `model.fixture`, `model.prompt`, `model.state`, `model.question` and `model.option`.
- Three model roles (§11.5a), set in Settings and asked for in setup (§16.2 step 4; T-INS-06 owns the step):
  - `fast` (Cerebras by default) for the app agent, preflight and timeline summaries;
  - `coding` for the coding agent;
  - `jev` through the AI Gateway for decisions.
- Fallback: without a fast-model key, the app agent and summaries use the `coding` model.
- The Agent card for each factory agent: planner (`coding/plan`), implementer (`coding/implement`), reviewer (`coding/review`) and the app agent. It shows the effective model and its source, a link to its instructions, and the runs it took part in. An agent with no pick of its own uses its role's model: the app agent `fast`, the others `coding`.
- A model choice, for a role or an agent, is an owner setting stored in `flow_config` as `agent:<role>` (source `owner`), never a TODO. It applies immediately: every run and turn admitted after the write uses it, and running runs keep the model they started with (§11.5a).
- Instructions (§11.5a) are repository Markdown: the TODO flow's prompts beside its source, and `.smithers/instructions/app.md` for the app agent. The install loads them as data from Active `main`, never as code (§1.3). With no repository file, the built-in instructions apply. They change through a TODO (`/flow.edit` or any TODO touching the file) and apply to work started after the merge activates.
- Tools and permissions change only through the overridable flow's source; editing them on the card is deferred ([D] §11.5a).
- Agent permissions (§15.1.5): model writes are install settings, so they are owner `session` only and `agent: never`. Members and maintainers read.

Out:
- Model access keys and the setup step (T-INS-06); the Settings card (T-APP-03).
- Loading flow versions on a merge (T-FLW-03); `/flow.edit` (T-FLW-05).
- The model laboratory (cut, mvp.md §8 via `4d455c697d`).

## Changes
- Restore with `jj --ignore-working-copy file show -r 5b77095672 <path>`: `apps/app/src/mainview/cards/ModelCards.tsx` and `.test.tsx`, `apps/app/src/mainview/flows/entries/model.ts` and `.test.ts`, `apps/app/src/mainview/state/controller/models.ts` (replaces today's 25-line resolver) and `models.test.ts`, `state/ModelsBoot.test.ts`, `state/ModelsComposition.test.ts`, `state/controller/forms.models.test.ts`, `apps/app/docs/MODELS.md`, `apps/app/docs/models/CONTRACT.md`, `apps/app/e2e/real/models.spec.ts` and `models/ui.ts`.
- From the restored files, delete the Compose button, the `ModelCallCardBody`/`ObservedModelCall` code (`ModelCards.tsx:22,114,346-347` at `5b77095672`) and the composer entries. Delete the `model-call` card kind (`packages/rpc/src/Cards.ts:1790`) with a decoder fallback for persisted cards (Risks).
- Register the restored entries as `in-card` (§6.1.2), writes `agent: never` and person-only: absent from `/help`, and the writes absent from the agent's tools. Their doors are the Settings card's model roles and the Agent card's model picker; mvp.md Appendix B.2 lists them, so the allowlist test passes.
- `packages/backend/internal/compose/chat_routes.go:65-83` (`mountModelPublic`) → `POST /api/model/credential`, `PUT /api/model/default` and `POST /api/model/test` go through `Authorize(credential, install.settings, …)` (T-ACC-03): owner `session` only. `GET /api/model/catalog` and `GET /api/model/default` stay readable to members. Update `docs/api/openapi/model.yaml` with the 403 responses.
- `GET /api/agents` (roles, model, source, runs) and `PUT /api/agents/{role}/model` (owner session) (§6.3), writing `flow_config` `agent:<role>` for `fast`, `coding`, `jev` and each agent; the `agents` topic (§7.2). The coding host and the model host read the effective model at admission and record it on the run and the turn (§15.2).
- Instructions loader (host): read `.smithers/instructions/app.md` and the TODO flow's prompt files from the repository store at Active `main` as text, with the built-in versions as defaults. The app agent's built-in instructions become the default `app.md` shipped in the install bundle.
- `apps/app/src/mainview/cards/AgentCards.tsx` (card kind `agents`, `packages/rpc/src/Cards.ts:2699`) → the factory Agent card on the `agents` topic; the instructions link opens the Markdown in the File card; runs come from `GET /api/runs` filtered by role.
- `apps/app/src/mainview/flows/entries/agent.ts` → `agent.list` is `/agents`; add `agent.open` (`/agent <name>`) and the `in-card` `agent.model <role> <model>`.
- Docs: restored `MODELS.md` trimmed of the composer, plus the roles and instruction files; `pnpm docs:sync`, `pnpm docs:check`.

## Tests
- Unit, `apps/app/src/mainview/cards/ModelCards.test.tsx` (restored): no Compose button; role rows and the last test render; a non-owner sees no write buttons.
- Unit, `apps/app/src/mainview/flows/entries/model.test.ts` (restored): the composer entries aren't registered; every restored entry is absent from `/help`, and the writes from the agent's tool list.
- Integration (real PostgreSQL), `packages/backend/internal/compose/model_routes_owner_test.go` (new): owner session writes succeed; maintainer, member, `delegated` and `run` credentials get 403 class `permission`; reads succeed for members.
- Integration, same file: `PUT /api/agents/reviewer/model` changes the model of a review run admitted afterwards and not of one already running.
- Integration, `model_roles_test.go` (new): with no fast-model key, the app agent's turn and a timeline summary record the coding model; with one, they record the `fast` model.
- Integration, `agent_instructions_test.go` (new): with no `.smithers/instructions/app.md` the turn uses the built-in text; after a merge that adds the file activates, the next turn uses it; an unmerged edit on a TODO branch changes nothing.
- Unit, `apps/app/src/mainview/cards/AgentCards.test.tsx` (rewrite): four agents, each with model, source, instructions link and runs; an agent with no pick shows its role's model.
- e2e, `apps/app/e2e/real/agents.spec.ts` (extend), for [C-J11-03](../checks/C-J11-03.md).

## Acceptance
- [C-J11-03](../checks/C-J11-03.md): the owner's model switch applies to the next run and turn with no TODO; instructions change through a merged TODO; non-owners can't change models.

## Risks and notes
- Risk: removing `model-call` from `Cards.ts` breaks decoding of saved conversations that hold one (AGENTS.md: old sessions stay readable). Confirmed if a stored conversation fixture with a `model-call` card fails to load. Keep a read-only tombstone decoder.
- Risk: a repository `.smithers/coding-project.json` that declares `seats` wins field by field over install-stored config (§11.2), so it could override the owner's role model. Confirmed if a run records a model the Agent card doesn't show. The card shows the effective model and its source (`owner` or `repo`).
