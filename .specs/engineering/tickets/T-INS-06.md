# T-INS-06 Install setup backend: durable steps, model access API, squash check

Stage S1 · Size M · Depends on T-INS-04, T-GH-01, T-ACC-01, T-MCH-10 · Unblocks T-FLW-08, T-APP-03, T-REL-03, T-REL-01 · Issue: [#3455](https://github.com/smithersai/smithers/issues/3455)
Spec: spec.md §3 (`install_settings`, `github_app`), §3.1, §5.1.0, §6.2, §6.3 (`/api/install`), §7.2 (`install` topic), §8.6.3, §10.6.2, §11.5a, §12.1, §14.3 (Setup/Settings), §15.1, §15.2, §16.2, §17.4 · Delta: delta.md §1 (Add [S1] setup card backend) · Product: mvp.md J1.2–J1.5, §6.1, §6.5, §6.9 Model access, M-09, M-11

## Goal
An owner completes setup steps 0 to 6 from any known origin (`http://localhost:4000` on the Mac, or a configured public origin from a LAN laptop), each persisted and resumable across a restart. Address comes first, so the GitHub App is created with the right callback URLs. Model access covers the three roles, and Source ready and Machine ready are separate steps.

## Scope
In:
- `GET /api/install`: every step with state, progress and error, plus the §14.3 Setup model (Address `{bind, origins[]}`, "This Mac" with its limits, GitHub `{signed_in, app_installed, squash_allowed}`, repository, model access flags, source `{state, pct}`, machine `{state, pct}`). Before the claim it answers only to a setup session (§5.1.0), on any known origin (§16.3.3); afterwards only to the owner.
- `POST /api/install/setup/{step}` for each step's action and Retry, under the same rule. Starting a step is a compare-and-set from `pending`, `failed` or `blocked` to `running`, so two setup sessions never run one step twice (§5.1.0). Quiesce (T-INS-07) and the scorecard (T-REL-03) share the resource. States: `pending`, `running`, `done`, `blocked{line, fix_url}`, `failed{class, message}` (§6.2.3 envelope).
- Steps (§16.2):
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
- Credits and metering (M-09 defers billing). The five-job setup (`packages/backend/internal/services/repository_setup.go`, `apps/app/src/mainview/flows/entries/setup.ts`) is deleted by T-CUT-01 and T-CUT-02, not reused.

## Changes
- `packages/backend/internal/services/install_setup.go` (new): the step machine, steps 0 to 6. Step state lives in `install_settings` under `setup.<step>` keys, since spec §3 lists no separate setup table; queries in `packages/backend/db/product/queries/install.sql` (new); `sqlc generate`. Step 1 is refused until step 0 is done.
- `packages/backend/internal/routes/install.go` (from T-INS-04) → setup steps; wired in `packages/backend/internal/compose/router.go`; rows in `docs/api/openapi/install.yaml`; regenerate `packages/backend/apiclient/client.gen.go`.
- Model access: reuse `POST /api/model/credential` (`packages/backend/internal/compose/chat_routes.go:78`) and `packages/backend/modelhost/owner_secrets.go`, with `CEREBRAS_API_KEY` (`modelhost/owner_models.go:40`) as the default fast provider. `apps/backend/main.go:136-152` builds the Jev recommender from the sealed Gateway key. For the Mac install, delete the `SMITHERS_PLATFORM_MODEL_KEYS_FILE` path (`packages/backend/modelproxy/keys.go:172-173`, `apps/backend/main.go:228-241`) and the `AI_GATEWAY_API_KEY` env path. The Docker image that used them is deleted (T-INS-05).
- ChatGPT subscription: an owner setting in `install_settings` replaces `SMITHERS_FEATURE_FLAGS_SUBSCRIPTION_CONNECTIONS` (`packages/backend/internal/config/config.go:172-182`) on the Mac install and turns the subscription pool on for the model proxy.
- Step 5: the install's repository mirrors with `mirror: pull` as its default (`packages/backend/internal/services/github_main_pull.go:477`).

## Tests
- Unit `install_setup_test.go`: allowed step transitions; step 1 refused before step 0; Retry only from `failed` or `blocked`; a repeated POST with the same `Idempotency-Key` returns the first result (§6.2.1).
- Integration (real PostgreSQL, fake GitHub): kill the host between steps 4 and 5; after restart `GET` shows the same states and step 5 resumes, not step 1. Squash disabled → `blocked` with the fix link; enabled → Retry → `done`. Model keys never appear in `GET`, logs or projection payloads. Step 5 `done` while step 6 `running` → `source.state = ready`, `machine.state = running`.
- Integration: step 4 with all three keys stores `agent:fast`, `agent:coding` and `agent:jev`; without a fast key, `agent:fast` resolves to the coding model.
- Integration: with the subscription setting off, a coding run never uses the ChatGPT pool; with it on and a sign-in present, a run records the subscription as its model access.
- Integration: before the claim, a request without a setup session gets 403 on every known origin, and one with a setup session succeeds on a configured LAN origin too; two setup sessions that start the same step at once run it once; after the claim, a member's request gets 403.
- e2e: C-J1-02, C-J1-03.

## Acceptance
- [C-J1-02](../checks/C-J1-02.md): every setup step, Address first, durable and resumable; three model roles; Source ready and Machine ready separate; squash check blocks with its fix link.
- [C-J1-03](../checks/C-J1-03.md): a question is answered with file cards after Source ready and before Machine ready.
- [C-SEC-04](../checks/C-SEC-04.md), with T-ACC-01: concurrent setup sessions run each step once.

## Risks and notes
- Step 6 on a repository without a target index needs T-MCH-10, because layers refuse today (`packages/backend/microsandbox/layers.go:565`). Observation: C-J1-02 fails on the scratch repository until it lands.
- The keys-file path meters every call in the credit ledger (`apps/backend/main.go:228-230`). Observation that confirms a leak of that behavior: a credits row per call made with the owner's sealed keys.
- Step state lives in `install_settings`, which keeps spec §3's table list. Observation that it's too small: a step needs its own history to resume.
