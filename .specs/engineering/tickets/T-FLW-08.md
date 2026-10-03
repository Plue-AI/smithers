# T-FLW-08 Agent card and owner model configuration restored from `5b77095672`

Stage S1 · Size M · Depends on T-INS-06, T-ACC-03, T-UI-13, T-APP-19, T-APP-22, T-FLW-02, T-FLW-03, T-COL-02, T-CAT-01, T-CAT-02, T-STK-02 · Unblocks T-APP-05, T-APP-07, T-APP-17, T-APP-23, T-REL-02 · Issue: [#3454](https://github.com/smithersai/smithers/issues/3454)
Spec: spec.md §3 (`flow_config`), §5.2 (install settings row), §6.1.2, §6.3 `/api/agents`, §7.2 `agents`, §11.5, §11.5a, §14.3, §14.5.3, §15.1, §15.1.4, §15.2, §16.2 step 4 · Delta: delta.md §1 (Restore model configuration row) · Product: mvp.md J11.4, §6.14 Configure an agent, §6.5 Models, M-23, Appendix A `/agents`, `/agent <name>`, Appendix B.2 (`agent.list`, `model.*`)

## Goal
The owner sets the three model roles in Settings, sees each factory agent's model, instructions and runs on the Agent card, and switches any agent's model as an owner setting that applies at once, with no TODO. Instructions are Markdown in the repository and change only through a TODO.

## Ownership (Will, 2026-10-02)

Design (smithers-06) builds every visual component and its styles: `AgentCard` and the restored owner model-configuration views (`ModelCards.tsx` visuals). Engineering wires them: `/api/agents`, `flow_config`, the three model roles. The seam is the card's view-model schema (spec §14.2.1, T-APP-19). Design builds against it with fixture stories, and engineering doesn't edit components or CSS.

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
- A model choice, for a role or an agent, is an owner setting stored in `flow_config` as `agent:<role>` (source `owner`), never a TODO. It applies immediately: each model call started after the write uses the effective choice, including calls in runs already in progress. An in-flight call completes on its original model; flow digests stay unchanged (§11.5a).
- Instructions (§11.5a) are repository Markdown: the TODO flow's prompts beside its source, and `.smithers/instructions/app.md` for the app agent. The install loads them as data from Active `main`, never as code (§1.3). With no repository file, the built-in instructions apply. They change through a TODO (`/flow.edit` or any TODO touching the file) and apply to work started after the merge activates.
- Tools and permissions change only through the overridable flow's source; editing them on the card is deferred ([D] §11.5a).
- Agent permissions (§15.1.5): model writes are install settings, so they are owner `session` only and `agent: never`. Members and maintainers read.

Out:
- Model access keys and the setup step (T-INS-06); the Settings card (T-APP-03).
- Loading flow versions on a merge (T-FLW-03); `/flow.edit` (T-FLW-05).
- The model laboratory (cut, mvp.md §8 via `4d455c697d`).
- Views, CSS and visual restoration (T-UI-13), budget/tool/permission editors, a revived `models` card and provider keys in machines.

## Changes
- Restore the nonvisual `model.*` entries, `apps/app/src/mainview/state/controller/models.ts` controller, their tests and trimmed docs from the historical source identified by `5b77095672`. The removed entries, model docs and real model scenarios are restoration targets, not existing paths today. smithers-06 restores the visuals under T-UI-13; engineering consumes `AgentView` and builds `apps/app/src/mainview/cards/containers/AgentContainer.tsx` (new), the topic decoder and adapter. Use `packages/rpc/src/AgentCard.ts` and `packages/rpc/test/fixtures/Agent.ts` from T-APP-19 through a per-module subpath; no barrel.
- Keep Compose and model laboratory code absent from the restored commands/controller. Visual removal belongs to T-UI-13. `packages/rpc/src/Cards.ts:1789-1790` is today's `model-call` variant; T-APP-22 owns its tombstone decoder. This ticket does not revive a `models` card kind.
- Register the restored entries as `in-card` (§6.1.2), writes `agent: never` and person-only: absent from `/help`, and the writes absent from the agent's tools. Their doors are the Settings card's model roles and the Agent card's model picker; mvp.md Appendix B.2 lists them, so the allowlist test passes.
- `packages/backend/internal/compose/chat_routes.go:65-83` (`mountModelPublic`) → `POST /api/model/credential`, `PUT /api/model/default` and `POST /api/model/test` go through `Authorize(credential, install.settings, …)` (T-ACC-03): owner `session` only. `GET /api/model/catalog` and `GET /api/model/default` stay readable to members. Update `docs/api/openapi/model.yaml` with the 403 responses.
- `GET /api/agents` (roles, model, source, runs) and `PUT /api/agents/{role}/model` (owner session) (§6.3), writing `flow_config` `agent:<role>` for `fast`, `coding`, `jev` and each agent; the `agents` topic (§7.2). The coding host and the model host resolve the effective model for each call and record the model actually used on that call (§11.5a, §15.2).
- Instructions loader (host): read `.smithers/instructions/app.md` and the TODO flow's prompt files from the repository store at Active `main` as text, with the built-in versions as defaults. The app agent's built-in instructions become the default `app.md` shipped in the install bundle.
- Replace the data/action wiring currently mixed into `apps/app/src/mainview/cards/AgentCards.tsx` with `AgentContainer.tsx` and its adapter. The Container subscribes to `agents`, parses the topic with its decoder, builds actions with `cardActions` → `flowAction`, and renders T-UI-13's `AgentView`. Instructions open the File card and runs come from the served `GET /api/runs` filtered by role; engineering edits no View or CSS.
- `apps/app/src/mainview/flows/entries/agent.ts` → `agent.list` is `/agents`; add `agent.open` (`/agent <name>`) and the `in-card` `agent.model <role> <model>`.
- Docs: restored `MODELS.md` trimmed of the composer, plus the roles and instruction files; `pnpm docs:sync`, `pnpm docs:check`.

## Tests

- Landing integration: enter `/agents` and owner model actions through the production catalog dispatcher and served `/api/model/*` and `/api/agents/*` routes, then subscribe to the `agents` topic. At landing, use the existing model host with the resolver wired here for fallback/instructions cases; after T-APP-23 consumes that resolver, qualify the real host turn runner at S1 exit and the machine coding-host/model-proxy path for model calls before and after a write, including calls in an already running TODO. Checks: C-J11-03, C-UI-13.
- Define `packages/backend/internal/compose/model_roles_test.go` and `agent_instructions_test.go` as new tests mounted through the install composition. All role IDs, models A/B/F, instruction texts and expected envelopes are committed literal fixtures; replace runtime `AGENT_ROLES`-derived expectations in the extended real agents scenario. No test reads spec files or derives expected effective models from production routing.

- C-CUT-02: pinned `agents` rows decode live. Restored models render in Agent or Settings and never revive `models`; T-APP-22 owns the `model-call` tombstone.

- Unit, `apps/app/src/mainview/cards/containers/AgentContainer.test.tsx` (new): bind the real view-model schema and fixtures to role rows, last-test data and owner-only model actions. T-UI-13 owns tests for visual absence of Compose.
- Unit, `apps/app/src/mainview/flows/entries/model.test.ts` (restored): the composer entries aren't registered; every restored entry is absent from `/help`, and the writes from the agent's tool list.
- Integration (real PostgreSQL), `packages/backend/internal/compose/model_routes_owner_test.go` (new): exercise served model/agent routes. Owner sessions write; non-owner credentials return 403 class `permission`; eligible owner delegated credentials on person-only writes return 403 class `never`; run credentials have no settings authority. Reads succeed for members.
- Integration, same file: `PUT /api/agents/reviewer/model` changes the reviewer's next model call, including in an already running TODO. An in-flight call finishes on its old model; later calls use the new effective model and record it without changing the flow digest.
- Integration, `model_roles_test.go` (new): with no fast-model key, the app agent's turn and a timeline summary record the coding model; with one, they record the `fast` model.
- Integration, `agent_instructions_test.go` (new): with no `.smithers/instructions/app.md` the turn uses the built-in text; after a merge that adds the file activates, the next turn uses it; an unmerged edit on a TODO branch changes nothing.
- Unit, `apps/app/src/mainview/cards/containers/agentModel.test.ts` (new): four agents carry effective model, source, instruction reference and recent runs; an unpicked agent uses its role. Expected rows are literal fixtures, not derived from `AGENT_ROLES`.
- e2e, `apps/app/e2e/real/agents.spec.ts` (extend), for [C-J11-03](../checks/C-J11-03.md).

## Acceptance


- [C-J11-03](../checks/C-J11-03.md): the owner's model switch applies to the next run and turn with no TODO; instructions change through a merged TODO; non-owners can't change models.
- [C-UI-13](../checks/C-UI-13.md): A Container's model from a real topic parses with its schema and its actions come from `cardActions`; at each stage exit every §14.3 row of the stage is wired and no View is orphaned

## Risks and notes
- Risk: a repository `.smithers/coding-project.json` that declares `seats` wins field by field over install-stored config (§11.2), so it could override the owner's role model. Confirmed if a run records a model the Agent card doesn't show. The card shows the effective model and its source (`owner` or `repo`).

## Ready checklist
1. Dependencies: T-FLW-02 owns flow_config and precedence; T-FLW-03 owns activation for instruction data; T-COL-02 owns agents topics; T-CAT-01/T-CAT-02 own catalog/CLI doors; T-STK-02 supplies the normal TODO path for instruction edits; T-APP-23 consumes the model/instruction resolver from this ticket, so host-turn cutover is not a landing precondition; existing T-INS-06/T-ACC-03/T-UI-13/T-APP-19/T-APP-22 supply setup, authorization, Views, schemas and tombstones.
2. Exclusions: Out explicitly excludes visual restoration/CSS, the laboratory, budgets/tools/permissions editing, revived models cards and machine-side provider keys.
3. Boundary tests: production catalog and served model/agent APIs, agents topic, host turns and machine model proxy in C-J11-03/C-UI-13; literal role/model/text oracles, never runtime spec or production routing expectations.
4. Decisions: smithers-3f accepts credential policy, flow_config writes, per-call routing and Active-main instruction reads; smithers-38 accepts topic/model schemas and precedence; smithers-b8 signs off public routes, catalog and Container wiring; smithers-06 accepts the View seam. Will through smithers-8a decides changes to immediate model application.
5. Owner pre-review before start: smithers-3f: Are settings writes owner-session-only and later calls updated in running TODOs without exporting provider keys? smithers-38: Do AgentCard/topic schemas expose the effective model and source consistently? smithers-b8: Do Container actions and served routes use the same catalog policy? smithers-06: Does AgentContainer consume AgentView and the restored model-role visuals without engineering editing Views or CSS?
6. Security: instruction Markdown is host-read data, never evaluated or imported. Coding flows and repository instructions used during coding remain inside machines under T-INS-02/T-FLW-01; provider keys stay in the host model proxy. Authorize every write, not only UI visibility. smithers-3f reviews; served credential tests and C-SEC-02 qualify.

