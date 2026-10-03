# Identity, access, secrets, SSH — current state (main, 2026-10-02)

Paths are relative to `/Users/williamcory/smithers`; `B` = `packages/backend/internal`.

## Summary
- Self-host sign-in is NOT GitHub OAuth. It is a local password owner, claimed once with a bootstrap token (`B/services/local_identity.go:123`). GitHub OAuth in self-host only re-links to that owner; any other GitHub user gets 403 (`B/services/auth.go:599-621`).
- One DB row (`self_host_owners`, singleton) plus `SingleOwnerBoundary` (`B/identity/single_owner.go:40`) refuse every other principal on HTTP, SSE and git. `/api/orgs*`, `/api/admin/{orgs,users}*` are 404 (`B/middleware/single_owner.go:21`).
- Permission is a local ACL (repo owner, org owner, team perm, collaborator row; `B/services/repo_permissions.go:115`), never GitHub's role. GitHub is consulted only to prove push access (5 min TTL) and for maintainer checks on issue text. No collaborator add route exists.
- Person vs agent is enforced by `CredentialKind` (`B/middleware/run_credential.go`): system-issued tokens and bot/service accounts are agents. A person's PAT from `smthrs auth login` is classed `person`, so Claude Code holding it is indistinguishable from Ben. This is the main gap against §6.13/M-21.
- D-23 is implemented and tested: approvals count only if `reviewer_kind='human'` and match the change's current `seq` and `commit_id`; checked at queue, auto-land, list and in the worker.
- D-24 and secrets CRUD are built (AES-256-GCM, write-only, 100 per repo, 64 KiB, egress binding). No run-usage view exists.
- The SSH server (gliderlabs, :2222) is a library package nobody in the public repo constructs (`packages/backend/ssh/ssh.go:57`); self-host and Plue-private call it. Keys come only from `ssh_keys` (`smthrs ssh-key`/`POST /api/user/keys`); there is no GitHub-keys import. Workspace login user is `developer` or `root`; no per-person unix users.
- No terminal auto sign-in: the CLI reads `SMITHERS_TOKEN`, keyring, auth file only (`packages/smithers/src/internal/backend/Session.ts:151`); machines get workspace/agent-scoped tokens the CLI ignores.

## Inventory
| Component | Path:line | What it does today | Spec row it serves |
| --- | --- | --- | --- |
| Self-host mode flag | `B/config/auth_mode.go:13` | `auth.mode=selfhost` selects single-owner topology | §6.2, M-17 |
| Owner table | `packages/backend/db/product/migrations/0004_single_owner_identity.sql:3` | `self_host_owners(singleton BOOLEAN PK CHECK, user_id UNIQUE)`, `local_credentials` (argon2) | §6.2 |
| Bootstrap | `B/services/local_identity.go:123`, `db/product/queries/local_identity.sql:18` | Needs `auth.bootstrap_token` (`SMITHERS_AUTH_BOOTSTRAP_TOKEN`); insert guarded by `WHERE NOT EXISTS (SELECT 1 FROM self_host_owners)`; later call returns 409 "already initialized" | #1667 |
| Startup guard | `B/services/local_identity.go:73` | Refuses boot without bootstrap token until an owner exists | #1667 |
| Local login/token/password | `B/compose/router.go:919-924`; `local_identity.go:155-230` | `/api/auth/local/{status,bootstrap,login,token,password}`; token excludes admin/org scopes; password change kills sessions | §6.2 |
| GitHub OAuth start/callback/CLI | `B/compose/router.go:931-934`; `B/routes/auth.go:235,296,482` | Browser sign-in and `smthrs auth login` loopback flow; CLI mints PAT `smithers-cli` | §6.13 |
| OAuth user resolve | `B/services/auth.go:560-640` | Multitenant: creates user for ANY GitHub login (no write-access check). Self-host: 403 unless account is linked to owner | §6.2 |
| Sessions | `B/services/auth.go:1085-1105`; `B/middleware/auth.go:290` | Random key, SHA-256 digest stored in `auth_sessions`; default 720h, refresh window 168h (`B/config/config.go:521`) | §6.2 |
| Single-owner boundary | `B/identity/single_owner.go:40`; wired `B/compose/router.go:140`, `B/middleware/auth.go:273`, `B/middleware/sse_ticket.go:80`, `B/services/git_http_proxy.go:328` | Any credential whose user is not the owner id gets 403 | §6.2, M-17 |
| Tenant surface block | `B/middleware/single_owner.go:21`; `B/compose/router.go:867` | 404 on org/admin routes in selfhost; `GET /api/user/orgs` returns empty | §6.15 "blocked" |
| Tables (unused by self-host) | `db/product/migrations/0001_product_baseline.sql`: `organizations` 4624, `org_members` 4524 (owner/member), `teams` 5765 (read/write/admin), `team_members` 5703, `team_repos` 5734, `collaborators` 2605 | Cloud ACL | §6.15 |
| Permission eval | `B/services/repo_permissions.go:115-205` | owner → org owner → highest(team, collaborator); `canAdminRepo` returns false for agents; `canLandRepo` | M-05 |
| GitHub push proof | `B/services/github_repo_push_access.go:18,70` | Live GitHub check with user's own token, 5 min cache | §6.3 |
| GitHub role lookup | `B/services/github_issue_text_writer.go:150-170` | `GET /repos/{r}/collaborators/{login}/permission`, admin or write = maintainer (TTL cached) | M-05 (role seed, inferred reusable) |
| Credential kinds | `B/middleware/run_credential.go:12-137` | person / run / sync / platform; bot+service accounts are agents | §6.13 |
| Person-only gate | `B/middleware/run_credential.go:145,168`; used `B/compose/router.go:758,1137,1278,1374` | `RequirePerson`, `RefuseRunCredentials` on approvals, statuses, workflow start, caches, job pause | §6.13 |
| Agent run token | `B/middleware/agent_token.go:30`; env `B/services/agent_dispatch.go:703` | Per-run `smithers_agent_*`, sha256, expiry, dies at terminal run status; injected as `SMITHERS_AGENT_TOKEN` | M-21 |
| Workspace token | `B/services/workspace_head.go:199,372` | `write:repository` + repo + workspace restriction scopes; env `SMITHERS_WORKSPACE_TOKEN`; rotates | §6.13 |
| `smthrs token mint` | `packages/smithers/src/cli/TokenCommands.ts:44` | Local gateway scoped token signed under `SMITHERS_TOKEN`; NOT a backend credential, no person/agent attribution | §6.13 (misnamed vs spec) |
| `smthrs auth login` | `packages/smithers/src/internal/backend/Auth.ts:100-170,232-270` | Browser loopback to `/api/auth/github/cli`, or `--with-token`, or local password → `/api/auth/local/token`; saved to keyring/auth file | §6.13, J1 |
| Landing person-approval gate | `B/services/landing.go:1697-1752,1438,1547,2282`; worker `B/services/landing_worker.go:723-740` | D-23 reason string; `agentLandingOntoDefault`; `requireAgentLandsAgentWork` | D-23, M-05 |
| Approval revision binding | `db/product/queries/landings.sql:393-410`; `B/services/landing.go:2556` | Counts DISTINCT human reviewers whose `change_revisions[change].seq/commit_id` equal current `changes.revision_seq/commit_id`; run credential review stored `reviewer_kind='agent'` | D-23, §6.10 |
| Secrets API | `B/compose/router.go:1241-1252,1745-1747`; `B/services/secret.go:137-370` | GET list (write), POST/PATCH/DELETE (admin); org secrets; names only on read | §6.15, M-25 |
| Secret storage | `B/webhook/secret_codec.go:17`; `secret.go:182` | AES-256-GCM under operator key with previous-key rotation; `repository_secrets` (0001:5361) | §6.15 |
| Main-only | `B/services/secret_injection.go:118,233`; `B/services/workflow_cache.go:1080` | Row dropped unless `mainTrusted`; trusted = person push/schedule/dispatch on exactly default bookmark | D-24 |
| Agent runs get no main-only | `B/services/agent.go:1345`, `secret_injection.go:81` | `RepositoryEnvironment` always `mainTrusted=false` (inferred for agent path) | D-24 |
| Egress binding | `B/services/secret.go:96-135`; `B/services/workspace_provisioning.go:389-480` | Bound secret only as placeholder swapped by egress proxy for listed hosts/headers; sent in create request, never baked | §6.15 |
| Machine env secrets | `B/compose/router.go:1251`; `B/services/agent_environment.go:20-40` | Separate "agent environment" secrets (100 entries, 64 KiB, 1 MiB setup) injected at provision | §6.15 |
| Secrets card | `apps/app/src/mainview/cards/SecretsCard.tsx`; `.../state/seams/SecretsSeam.ts` | UI over the API | §6.15 |
| SSH library | `packages/backend/ssh/ssh.go:57-103`; `B/ssh/server.go:340,526,1636 lines` | Git + workspace SSH on `:2222`; key fingerprint → `GetUserBySSHFingerprint`, else deploy key (git only; refused for workspace shell, `server.go:386`) | M-24 |
| Workspace login | `B/ssh/workspace_access.go:48-61` | Login `"<sandboxID>+<user>"` plus grant token (>=20 chars); bridge validates and proxies to guest sshd | M-24 |
| Grant minting | `B/services/workspace_ssh.go:18-75,233` | API wakes VM, mints grant bound to one guest user: `developer` (default) or `root` only | M-24 |
| SSH keys API | `B/compose/router.go:1591-1594`; `B/routes/ssh_keys.go`; CLI group `ssh-key` (`packages/smithers/src/internal/backend/Commands.ts:92`) | List/add/delete per user | M-24 |
| Revocation bus | `B/revocation/event.go:38-66`; `B/ssh/revocation.go:21`; `B/revocation/access_grants.go:20` | Kinds: token_revoked, user_disabled, collaborator_removed, org_member_removed, ssh_key_revoked, browser_session_revoked, workspace_share_removed; SSH registry closes live sessions; grants revoked per sandbox | §6.15 removal |
| Audit | `B/services/audit.go:49-72` | `ActorID`, `ActorName`; no agent-name field | M-21 |
| SSH self-host | `apps/backend/main.go`, `packages/backend/app/app.go` | No SSH references (only `apps/backend/shutdown_test.go`); config default `ssh.addr=:2222` (`B/config/config.go:506`) | M-24 |

## Gaps vs mvp.md
1. §6.2 Team sign-in / M-17 / §6.15 Members: self-host admits one owner -> allow N members signing in with GitHub; admit only if GitHub write access (reuse `github_issue_text_writer.go:150` lookup or push proof), role from GitHub (admin/maintain -> Maintainer, write -> Member). Change: `services/auth.go:599-621` (drop the owner-link refusal in favor of a membership check), `identity/single_owner.go` (replace with a repo-member authorizer), `middleware/auth.go:273`, `ssh`/git callers, plus a members table migration. Size L.
2. §6.15 Members card, add by username, "needs access on GitHub", remove: no members API and `collaborators`/`teams` have no add route (`AddCollaborator` is declared at `services/repo.go:80` but unused). Add `/api/repos/{o}/{r}/members` handlers on a new `repo_members` table (or reuse `collaborators`), app Members card. Size M-L.
3. §6.15 Roles (Owner/Maintainer/Member): ACL has read/write/admin and org owner/member only. Map Owner=self_host_owners, Maintainer=admin, Member=write; gate secrets (`secret.go:582`), merge (`canLandRepo`), triggers, install settings. Size M.
4. §6.13 delegated credentials with agent attribution: a CLI PAT is `person`. Need a token field (agent name) plus a kind `delegated` that is `IsAgent()` for approve/merge/main but acts as the person elsewhere. Change: `access_tokens` migration (agent label), `TokenCredentialKind` (`run_credential.go:62`), `/api/auth/github/cli` and `/auth/local/token` (`routes/auth.go:498`, `local_identity.go:195`) to accept `agent=claude-code`. Size M.
5. §6.13 / M-21 attribution "Ben via Claude Code": audit has only actor id/name; landing review stores `reviewer_kind` only. Add `via_agent` to `AuditEvent`, journal/events and presence. Size M. Needs grep of the TS journal actor fields (not found in this pass).
6. §6.13 "confirmation in the app that agent processes can't reach": today an agent just gets a 403 (`landing.go:1443`); no app confirmation path was found for CLI-initiated approvals. Add a pending-approval record and an app-session-only decide route (session cookie, not PAT). Size M.
7. §6.13 terminal sign-in: add to machine provisioning an env/credential file for a delegated token (person + "branch terminal"), and make `Session.resolve` read it. Change: `services/workspace_head.go:377` (extra token, kind delegated) and `packages/smithers/src/internal/backend/Session.ts:151`. Per-person: must be minted per connecting person, so depends on gap 8. Size M.
8. M-18 / §6.15 SSH: per-person homes. Workspace offers only `developer`/`root` (`workspace_ssh.go:29`). Add per-member users via `setup` (`packages/backend/microsandbox/guest/smithers-guest.py`) at join/SSH time, map SSH key -> person -> unix user, "Ask to type" and terminal ownership. Size L.
9. M-24 SSH on self-host: construct `ssh.New` with a `WorkspaceBridge` in `apps/backend` composition and expose the port; implement a bridge for the process/microvm adapters (the only bridge in the tree is Plue's, not public; inferred, verify with `rg WorkspaceBridge` showing only interfaces and tests). Document. Size L.
10. M-24 GitHub keys: no fetch of `github.com/<user>.keys`; `publicKeyHandler` consults only `ssh_keys` (`server.go:526`). Add import at sign-in or lazy lookup with cache, keyed to the member. Size S-M.
11. §6.15 Removing someone ends sessions/terminals/SSH: pieces exist (`KindOrgMemberRemoved`, `KindCollaboratorRemoved`, SSH registry, `DeleteUserSessions`) but no self-host member-removal path publishes them. Wire the new removal to `publishCollaboratorsRemoved` and delete `auth_sessions` + PATs. Size S after gap 2.
12. §6.15 Secrets run usage: no table or API records which run used which secret name (only `payload.secret_names` at `workflow_run.go:948`). Add `run_secret_uses(run_id, name)` written at injection (`secret_injection.go:118`), card query. Open #3285 is adjacent. Size M.
13. §6.15 "available to every branch's machine as env var": repo secrets go to workflow runs and agent sandboxes; the workspace (branch machine) path receives only egress-bound secrets and "agent environment" secrets (`workspace_provisioning.go:389-480`). Confirm a plain secret reaches a branch machine; otherwise add. Size S-M.
14. §6.15 Owner-only secrets role: `SetSecret` needs repo admin (`secret.go:582`), but Maintainer is not yet a role (gap 3). Size S after gap 3.
15. M-05 first sign-in role mapping: no code reads GitHub role at sign-in. Size S with gap 1.

## Existing tests
- Single owner: `B/identity/single_owner_test.go:25,37`; `B/services/local_identity_test.go`, `local_identity_integration_test.go`; `B/middleware/auth_test.go`.
- Person vs agent: `B/middleware/run_credential_test.go:14,35,57`; `B/compose/run_credential_landing_gates_integration_test.go:206`, `router_run_credential_test.go`, `run_credential_{repository_admin,review,outsider_conversation}_integration_test.go`, `workflow_run_credential_trigger_integration_test.go`.
- D-23: `B/services/landing_agent_approval_test.go:35` (worker re-check), `B/compose/repository_policy_gates_integration_test.go`, `changes_requested_landing_gate_integration_test.go`.
- Secrets: `B/services/secret_main_only_test.go`, `secret_injection_test.go`, `secret_host_binding_test.go`, `secret_integration_test.go`, `secret_cap_race_test.go`.
- SSH: `B/ssh/server_test.go`, `workspace_session_test.go`, `workspace_access_test.go`, `revocation_test.go`, `auth_outage_test.go`; `B/services/workspace_ssh_test.go`, `ssh_key_revocation_test.go`.
- Revocation bus: `B/revocation/*_test.go`.
- CLI: `packages/smithers/test/BackendClientCredentials.test.ts` (inferred relevant; not opened).
- Not found: any test for multi-member self-host, per-person unix users, GitHub-key import, agent attribution on a PAT.

## Configured/measured numbers
- Session: 720h duration, 168h refresh (`B/config/config.go:521-522`); cookie `smithers_session`.
- Local password: argon2 64 MiB, 3 iterations, parallelism 2, max 2 concurrent hashes; password 12-1024 bytes (`local_identity.go:25-34`).
- Secrets: 100 per repo, 100 per org, 64 KiB value (`secret.go:23-25`); injected env cap 1000 entries, 1 MiB (`secret_injection.go:30-33`); agent environment 100 entries, 1 MiB setup.
- GitHub push proof TTL 5 min (`github_repo_push_access.go:18`).
- SSH: addr `:2222`, max conns 100, 10 per IP, receive-pack 500 MiB, 10m timeout, 20 auth attempts/min default, 10 sessions per conn, 2h git cap (`config.go:506-518`); workspace connection lives until idle deadline or `WorkspaceMaxTimeout`; keepalive via `keepalive@openssh.com`.
- Workspace SSH host default `ssh.smithers.sh` (`config.go:505`); default guest user `developer` (`services/workspace.go:33`).
- Workspace head token TTL: `workspaceHeadTokenTTL` (value not read).

## Related GitHub issues (open, smithersai/smithers)
- #1667 [Architecture 12/17] one-machine distribution with backup and recovery: open, size:easy; spec cites it as the single-owner source (ledger step 12; the owner model itself is step 05, #1660).
- #1660 shared identity and single-owner bootstrap: not in the open list (inferred done).
- #1668 release gates for clean-room self-host: open, size:hard.
- #1776 Epic: confine agent tools and enforce approval authority: open epic, relevant to D-23 and gaps 4 and 6.
- #3285 Run secrets drawer reads CI metadata instead of proxy-bound agent secrets: open, relates to gaps 12 and 13.
- #3333 Qualify missing real scenarios for egress.allow, history.land and secrets.bind: open, in-progress.
- #3301 Flows have no sanctioned way to use operator credentials from a confined child: open, in-progress.
- #3042 TUI: Approvals show the change and stay denied: open, in-progress (approval binding in TUI).
- #3250 Accepted human approval does not resume the real graph run: open bug.
- #2125 Bind TUI/GUI/CLI/API to shared operation registry: open, in-progress.
- #3401 Pair restoration: do-not-implement; M-17 supersedes only for shared workspace access and presence.
- No open issue found for: multi-member self-host, Members card, roles, GitHub-keys SSH, per-person homes, terminal auto sign-in, "via agent" attribution. (Searches: "members roles maintainers", "delegated credential agent", "SSH workspace", "terminal sign in".)

## Risks and unknowns (falsifiable)
1. Claim: a `smthrs auth login` PAT can approve a landing as a person. Confirm: mint via `/api/auth/github/cli`, call `POST .../reviews` type approve; expect `reviewer_kind='human'` and `CountCurrentApprovedLandingRequestReviews` = 1 (`landing.go:2556` has no PAT branch). Falsified if `TokenCredentialKind` marks it run/agent.
2. Claim: nothing in the public repo constructs `ssh.New`. Confirm: `rg "ssh\.New\(" --glob '*.go'` outside tests returns none (this pass: none). A Plue-only bridge would make gap 9 larger than M.
3. Claim: dropping `AuthorizeOwner` is not sufficient for multi-member; callers also assume `ownerID` (`git_http_proxy.go:328`, SSE, middleware). Confirm: grep shows 5 call sites (above); each needs the member check.
4. Claim: plain (unbound) repo secrets do not reach a branch machine. Confirm: provision a workspace with one unbound secret and `printenv` in a terminal. Mismatch with §6.15 "Built" if absent.
5. Claim: GitHub write access is not checked on first sign-in in multitenant (any GitHub user is created, `auth.go:621-640`). Safe today in self-host only because sign-in is refused; once multi-member opens, this is an open door unless gap 1 adds the check. Confirm by reading the CreateUser branch (done) and a test with a non-collaborator login.
6. Claim: session revocation on member removal covers sessions, SSH and terminals via the bus. Unverified end to end for self-host because no removal route exists; confirm by publishing `KindCollaboratorRemoved` in an integration test and asserting `auth_sessions` rows are deleted (revocation events close SSH and sockets; DB session deletion is separate: `DeleteUserSessions`, `local_identity.go:50`).
7. Unknown: where the TS flow journal records actors (attribution gap 5); not searched. Confirm with `rg "actor" packages/smithers/src --glob '!*.test.*'`.
8. Unknown: how the app reaches a person-only confirmation (§6.13 last sentence). Confirm by searching `apps/app/src` for the approvals decide call and checking its auth (session vs PAT).
9. Risk: spec says self-host "OAuth exists"; in fact self-host sign-in is local password. A GitHub-only sign-in for multi-member needs a GitHub App/OAuth client configured on the install (`auth.github_*`), which the one-container distribution may not set. Confirm in `distribution/entrypoint.sh` and `config.go` defaults.
