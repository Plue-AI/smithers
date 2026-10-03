# T-INS-06 Install setup backend: durable steps, model access API, squash check

Stage S1 · Size M · Depends on T-INS-04, T-GH-01, T-ACC-01, T-MCH-10, T-ACC-03, T-GH-12, T-GH-13, T-CUT-02, T-FLW-01 · Unblocks T-APP-03, T-APP-08, T-APP-17, T-FLW-02, T-FLW-08, T-MCH-01, T-REL-01, T-REL-02, T-REL-03 · Issue: [#3455](https://github.com/smithersai/smithers/issues/3455)
Spec: spec.md §3 (`install_settings`, `github_app`), §3.1, §5.1.0, §6.2, §6.3 (`/api/install`), §7.2 (`install` topic), §8.6.3, §10.6.2, §11.5a, §12.1, §14.3 (Setup/Settings), §15.1, §15.2, §16.2, §17.4 · Delta: delta.md §1 (Add [S1] setup card backend) · Product: mvp.md J1.2–J1.5, §6.1, §6.5, §6.9 Model access, M-09, M-11

## Goal
An owner completes setup steps 0 to 6 from any known origin (`http://localhost:4000` on the Mac, or a configured public origin from a LAN laptop), each persisted and resumable across a restart. Address comes first, so the GitHub App is created with the right callback URLs. Model access covers the three roles, and Source ready and Machine ready are separate steps.

## Scope

- Persist a stable operation id, validated inputs, external target identity and execution fence with each running setup step. Recovery inspects running steps, claims a new fence for the same operation and reconciles its external effect before resuming; it never resets running to pending and blindly repeats an App creation, mirror or image effect. Completion compares the operation id and fence and commits step state plus projection atomically. A stale worker cannot complete or overwrite the recovered step. Unknown external outcomes remain running or blocked with a retry explanation until reconciled. Checks: C-J1-02, C-SEC-04.
In:
- `GET /api/install`: every step with state, progress and error, plus the §14.3 Setup model (address, `steps[]` with ids, states and `pct`, This Mac, GitHub, repository, models[] per role with key state, and the ChatGPT flag). Before the claim it answers only to a setup session (§5.1.0), on any known origin (§16.3.3); afterwards only to the owner.
- `POST /api/install/setup/{step}` for each step's action and Retry. A setup session reaches only address, app_manifest and sign_in. Repository through machine require the provisional owner's person session; setup-session requests return HTTP 403, class and code `permission`. App setup uses only `POST /api/install/setup/app`, mapped by the handler to stored id `app_manifest`, with no `github_app` alias. Starting a step is a compare-and-set from `pending`, `failed` or `blocked` to `running`, so two setup sessions never run one step twice (§5.1.0). Quiesce (T-INS-07) and the scorecard (T-REL-03) share the resource. States: `pending`, `running`, `done`, `blocked{line, fix_url}`, `failed{class, message}` (§6.2.3 envelope).
- Steps (§16.2): store and report each step by id: 0 `address`, 1 `app_manifest`, 2 `sign_in`, 3 `repository`, 4 `models`, 5 `source`, 6 `machine` (`setup.<id>` keys).
  0. Address: confirm the bind address and public origins (T-INS-04's settings), because the App's callback URLs are fixed at creation (§16.3.3).
  1. Create the GitHub App (T-GH-01).
  2. Owner sign-in and the claim (T-ACC-01).
  3. Choose the repository and install the App on it; the host reads the installation with the App's JWT and verifies the owner (§5.1.0, T-ACC-01).
  4. Model access for the three roles (§11.5a): a coding-model provider key, a fast-model key (Cerebras by default, optional), the AI Gateway key for Jev, and optionally a ChatGPT sign-in for coding.
  5. Mirror, then Source ready; questions work from here.
  6. First image for `main`, then Machine ready (§8.6.3).
- Squash check at step 3 and on every Retry: `GET /repos/{o}/{r}` `allow_squash_merge`; when false, block with "Enable squash merging on GitHub ↗" (§10.6.2).
- Model access: keys sealed as owner secrets; default models per role in `flow_config` (`agent:fast`, `agent:coding`, `agent:jev`, §11.5a); Jev reads the sealed Gateway key. Without a fast key the step records the coding-model fallback. `GET` returns names and flags, never values.
- ChatGPT subscription (F-27, §15.2): enable the subscription pool on the Mac install behind the owner setting set in step 4 or Settings. Off by default; when on, coding runs may use the owner's ChatGPT sign-in, and each run records which model access it used.
- Each step change writes its state and a `projection_events` row on the `install` topic in one transaction (§3.1, §7.2).

Out:
- Bind address and public origins as settings, and their serving (T-INS-04). This ticket only sequences step 0.
- The setup token and the owner claim (T-ACC-01); App manifest internals (T-GH-01); Setup and Settings cards (T-APP-03); toolchain detection and the image recipe (T-MCH-10); the Agent card and owner model configuration (T-FLW-08); capacity and `parallel` (T-MCH-01, T-STK-03).
- New language detection (including Ruby), new image recipes, host execution of dependency installs, model laboratory screens, personal subscription pooling across members and new secret-reveal endpoints.
- Credits and metering (M-09 defers billing). The five-job setup (`packages/backend/internal/services/repository_setup.go`, `apps/app/src/mainview/flows/entries/setup.ts`) is deleted by T-CUT-01 and T-CUT-02, not reused.

## Changes

- Adopt GH-12’s App handler only at POST /api/install/setup/app under the existing {step} route. Register no github_app alias or second handler. Check: C-GH-01.

- Step 4 uses `POST /api/install/setup/models`; declare its request and refusal schemas in `docs/api/openapi/install.yaml`. Literal seven-step fixtures store and return ordered ids `address`, `app_manifest`, `sign_in`, `repository`, `models`, `source`, `machine`. Preserve blocked fix links and the repository squash check. Check: C-J1-02.

- `install_setup.go`: store operation identity and fence in the existing setup step record, claim recovery by compare-and-set and reconcile the dependency’s durable external operation. Commit fenced completion and install projection together. Image recovery uses T-MCH-10’s isolated preparation and retained operation identity; repository recipes never run on the host and provider/App secrets never enter the machine. Checks: C-J1-02, C-SEC-04.
- `packages/backend/internal/services/install_setup.go` (new): the step machine, steps 0 to 6. Step state lives in `install_settings` under `setup.<step>` keys, since spec §3 lists no separate setup table; queries in `packages/backend/db/product/queries/install.sql` (new); `sqlc generate`. Step 1 is refused until step 0 is done.
- `packages/backend/internal/routes/install.go` (from T-INS-04) → setup steps; wired in `packages/backend/internal/compose/router.go`; rows in `docs/api/openapi/install.yaml`; regenerate `packages/backend/apiclient/client.gen.go`.
- Model access: reuse `POST /api/model/credential` and `packages/backend/modelhost/owner_secrets.go`. Replace the Mac install’s Jev composition in `apps/backend/main.go:147` and its platform-key or env-key constructors with sealed owner Gateway access resolved through `agent:jev`. Main currently passes platformKeys to NewJevRecommender at `apps/backend/main.go:155` and the env key at `:161`; it does not use sealed access. Remove the Mac install’s SMITHERS_PLATFORM_MODEL_KEYS_FILE helper (`apps/backend/main.go:240`) and AI_GATEWAY_API_KEY path only after that replacement is wired. No platform-key, env-key or credit-meter fallback remains for owner Jev calls. Keys stay sealed on the host; GET returns names and flags only. Check: C-J1-02.
- ChatGPT subscription: an owner setting in `install_settings` replaces `SMITHERS_FEATURE_FLAGS_SUBSCRIPTION_CONNECTIONS` (`packages/backend/internal/config/config.go:172-182`) on the Mac install and turns the subscription pool on for the model proxy.
- Step 5: the install's repository mirrors with `mirror: pull` as its default. Today `readGitHubMirrorPolicy` returns undeclared when no policy is present (`packages/backend/internal/services/github_main_pull.go:782-807`); set the install default explicitly without changing Plue policy. C-J1-02 checks a repository with no declared policy.

## Tests

- C-J1-02 asserts the literal ordered stored ids through GET, including `app_manifest`; no View maps it to `app`. POST App setup uses `/api/install/setup/app` only, and `/api/install/setup/github_app` is unserved.

- Composed install integration (C-J1-02, C-SEC-04), real PostgreSQL and compiled-host restart: kill after running admission and after each external effect succeeds but before completion commits. Restart with the same operation id; assert one effective App/mirror/image operation, durable reconciliation and one completion projection. Release the old worker after recovery and assert its stale fence cannot update the record. Interrupted image preparation resumes only inside isolation with no host recipe execution and no provider/App key in guest files, environment, logs or projection payloads.
- Model integration (C-J1-02): configure sealed agent:jev Gateway access via the production credential route, restart and make a Jev call through the installed recommender. The fake Gateway receives one call under the sealed owner credential and no credit-ledger row. Hostile platform-file and env values cannot override it; missing sealed access refuses instead of falling back.
- Boundary: `packages/backend/internal/compose/install_setup_integration_test.go` (new) exercises `GET /api/install`, `POST /api/install/setup/{step}` and `POST /api/model/credential` through the composed install router, with real PostgreSQL and restart of the compiled host for recovery. Literal step ids, role names, error envelopes, fix URLs and secret-redaction predicates are committed test fixtures. No expectation comes from spec Markdown or implementation code at runtime. C-J1-02 uses the real setup card; C-J1-03 remains the later first-answer integration with T-APP-23/T-APP-15, not a prerequisite for these routes.
- Unit `install_setup_test.go`: allowed step transitions; step 1 refused before step 0; Retry only from `failed` or `blocked`; a repeated POST with the same `Idempotency-Key` returns the first result (§6.2.1).
- Integration (real PostgreSQL, fake GitHub): kill the host between steps 4 and 5; after restart `GET` shows the same states and step 5 resumes, not step 1. Squash disabled → `blocked` with the fix link; enabled → Retry → `done`. Model keys never appear in `GET`, logs or projection payloads. Step `source` done while `machine` runs → `GET` shows `source` done and `machine` running with its `pct`.
- Integration: step 4 with all three keys stores `agent:fast`, `agent:coding` and `agent:jev`; without a fast key, `agent:fast` resolves to the coding model.
- Integration: with the subscription setting off, a coding run never uses the ChatGPT pool; with it on and a sign-in present, a run records the subscription as its model access.
- Integration: no credential returns HTTP 401, class `permission`, code `unauthenticated` on each known origin. A setup session completes address, app_manifest and sign_in on the configured LAN origin; `POST /api/install/setup/models` with that session returns `403 permission/permission`. A provisional owner session completes repository through machine; a non-owner member returns `403 permission/permission`. Concurrent eligible requests start one operation. Check: C-J1-02.
- e2e: C-J1-02, C-J1-03.

## Acceptance

- [C-J1-04](../checks/C-J1-04.md): S1 part at its named layer.





- [C-J1-02](../checks/C-J1-02.md): every setup step, Address first, durable and resumable; three model roles; Source ready and Machine ready separate; squash check blocks with its fix link.
- [C-J1-03](../checks/C-J1-03.md): a question is answered with file cards after Source ready and before Machine ready.
- [C-SEC-04](../checks/C-SEC-04.md), with T-ACC-01: concurrent setup sessions run each step once.

## Risks and notes
- Decisions before start: smithers-3f approves step persistence, secret storage and the setup-to-image seam; smithers-b8 approves install/model API contracts; smithers-38 approves packaged model-host integration. smithers-8a accepts the shared step and `flow_config` schema ownership before work; this ticket supplies the role-setting persistence required by setup and records any new table in `ownership.csv` (C-PRC-02), rather than depending on downstream T-FLW-08. Will decides provider-default or subscription-policy changes.
- Security precondition: T-INS-02’s launcher, T-FLW-01’s guest-only flow dispatch and T-MCH-10’s isolated image preparation must be available. Source mirroring reads repository data only. Dependency installs, recipe commands, coding agents and test coding runs execute only in machines (§1.3, M-29), never on the host; provider/App keys remain sealed on the host. smithers-3f reviews this seam and C-J1-02/C-SEC-02 prove it.
- Step 6 on a repository without a target index needs T-MCH-10, because layers refuse today (`packages/backend/microsandbox/layers.go:565`). Observation: C-J1-02 fails on the scratch repository until it lands.
- Main’s platformModelKeys helper meters file-key calls (`apps/backend/main.go:240`). The Mac install replacement must prove sealed owner Jev calls produce no credit-ledger row. Check: C-J1-02.
- Step state lives in `install_settings`, which keeps spec §3's table list. Observation that it's too small: a step needs its own history to resume.

## Ready checklist
1. Dependencies: T-INS-04 supplies serving and projections transitively, T-ACC-01 setup identity, T-ACC-03 owner authorization, T-GH-01/T-GH-12/T-GH-13 durable App setup/fallback, T-MCH-10 image readiness, T-CUT-02 legacy route removal and T-FLW-01 isolated coding dispatch.
2. Exclusions: setup identity/App internals, views, image detection/recipes including Ruby, host dependency execution, Agent configuration UI, personal subscription sharing, model laboratory, billing and capacity are explicit.
3. Tests: composed install/model/setup routes, real PostgreSQL and compiled-host restart use fixed fixtures; C-J1-02 drives the Setup card. C-J1-03 runs when its answer/File-card consumers land; it cannot be replaced by direct service calls.
4. Decisions: smithers-3f approves persistence/security/image seams, smithers-b8 public API, smithers-38 model-host integration, smithers-8a shared schema ownership; Will decides model/subscription policy exceptions.
5. Owner pre-review before start: smithers-3f: Are steps and projections atomic and restart-safe? Do image installs run only in machines and sealed keys stay on the host? smithers-b8: Are setup-session versus owner gates and API models complete? smithers-38: Does role configuration work with the packaged model host without env-key fallback? smithers-3f: answered, BLOCKING edits applied (tech lead adopts). smithers-b8: answered, BLOCKING edits applied (tech lead adopts). smithers-38: answered 19:4x, ok.
6. Security: isolated launcher, flow dispatch and image preparation must land before setup runs code; §1.3/M-29 confines repository code to machines. smithers-3f reviews the seam; C-J1-02, C-SEC-04 and C-SEC-02 cover execution, secret redaction and claim concurrency.
