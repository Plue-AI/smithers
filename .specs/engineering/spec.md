# Smithers MVP engineering specification

Status: draft v0.4 by the engineering agent (smithers-8a), 2026-10-02. Implements [mvp.md v2.6](../product/mvp.md) (M-01..M-30, build stages §11, deferrals §16). It specifies the target system as if built from scratch. [delta.md](delta.md) maps today's `main` onto it, and [overview.md](overview.md) is the one-page version.

## 0. Stages and deferrals

mvp.md §11 builds the MVP in three stages, and every one ships at launch. Will confirmed live code co-editing (M-02) for the MVP on 2026-10-02. It is built in stage 3, but its contracts are fixed in stage 1 (§7.6) so stages 1 and 2 feed it instead of being retrofitted. Once stage 1 passes J1 and J2, Smithers' own development moves onto the stack on Will's Mac mini (M-31). Will's rulings of 2026-10-02 also apply throughout:
- Tailscale is not part of the product (§1.4, §16.3).
- Every limit derives from the detected host, never a Mac model (§8.2).
- Each branch has one shared conversation (§14.1).
- The app agent runs a context preflight before it answers (§15.1). Each section below is tagged with the stage that first needs it: **[S1]** skeleton (J1, J2, J4, J5, J6.1), **[S2]** multiplayer without co-editing (J3), **[S3]** live code co-editing and learning. **[D]** marks behavior deferred to the first release after the MVP (mvp.md §16). It is specified only so the MVP leaves room for it, and the MVP MUST NOT build it.

| Deferred [D] | Where it would live |
| --- | --- |
| In-app line comments; agent replies in GitHub review threads | §12.5.3 |
| Stacked PR bases and retargeting (PRs stay based on `main`) | §12.5 |
| Laptop pushes merged into the live working copy; Open on a machine | §12.3 |
| Ask to type in another member's terminal | §8.11.2 |
| Command name on change entries, per-entry Undo, replaced-edit flags | §9.3.2, §9.3.6, §9.3.7 |
| Email and phone notifications (#3423) | §14.6 |
| Triggers, the Machine view, sending signals by hand, agent permissions/tools/budget editing | §11.7, §6.14 of mvp.md |
| Obsidian over git from laptops | §13.3 |
| Replace a stack item's work with a scratch branch | §8.5.3 |
| Secret usage by run | §8.8.1 |
| Exact per-write kernel attribution (fanotify) | §9.3.1 |

Conventions. **MUST** and **MUST NOT** are requirements that a check in [checks/](checks/) verifies. **SHOULD** is a default the engineer may change with a recorded reason. Product words come from mvp.md §3, and internal names appear in `code` the first time they're used. Section numbers (§n.m) are stable: tickets and checks cite them.

---

## 1. Deployment topology

```
 Team laptops (browser, smthrs CLI, Claude Code / Codex with the Smithers skill)
        │ HTTP(S) to the install's public origin      │ SSH :2222 (same host)
        ▼                                             ▼
┌──────────────────────── Apple Silicon Mac (macOS 15+) ───────────────────────────┐
│ launchd ─▶ host launcher (`smthrs host`)                                       │
│              ├─ host service `smithers-backend` (Go)                             │
│              │    API · live hub · identity · GitHub sync · stack engine          │
│              │    admission scheduler · SSH gateway · flow dispatch · wiki docs   │
│              ├─ PostgreSQL 18 (bundled, loopback, private data dir)               │
│              └─ host flow runtime (packaged TS; system flows only)                │
│ Repository store: bare mirror + jj repo per install · blob store (filesystem)     │
│                                                                                   │
│  microVM per awake branch (libkrun via msb) ──────────────────────────────┐      │
│  │ working copy (jj, colocated git) · machine daemon `smithers-machined`   │      │
│  │ coding host (flow runtime for repository flows) · coding agent CLIs    │      │
│  │ daemon-owned sessions (member uids, no sshd) · services the team runs  │      │
│  └─────────────────────────────────────────────────────────────────────────┘      │
└───────────────────────────────────────────────────────────────────────────────────┘
        │ GitHub App (installation token): git + REST                ▲ optional webhooks
        ▼                                                             │
      GitHub: main · issues · pull requests · reviews · checks
```

1.1 One install serves one team and one repository (M-02 rule 2). The install is one macOS user account's data directory, `~/Library/Application Support/Smithers` (`$STATE`). Every durable byte lives under it.

1.2 Processes. launchd starts the host launcher, which supervises the host service and PostgreSQL. A crash of either restarts both under the existing supervisor contract. No Docker, Kubernetes, Electron or Electrobun process exists on the MVP install.

1.3 Execution boundary (M-29, M-30). Repository code MUST execute only inside a branch machine. Repository code means overridable flows, the coding agent, checks, terminals, SSH sessions and services. The host executes only code shipped in the install package. The install MUST refuse to start without working microVM isolation and MUST NOT fall back to host processes.

1.4 Network [S1]. The install is origin-agnostic:
- By default every listener binds loopback: HTTP on `127.0.0.1:4000`, SSH on `127.0.0.1:2222`, PostgreSQL.
- The owner may set a bind address (for example `0.0.0.0` or one interface) and the install's public origins (http or https, any host name) in Settings (§16.3), or at install time with `smthrs host start --bind <addr> --origin <url>`. HTTP and SSH listen on loopback always, plus the bind address when one is set; PostgreSQL stays on loopback.
- HTTPS, if any, comes from whatever the team puts in front, such as Tailscale serve or a reverse proxy. The docs show both, and no code depends on either.

A machine reaches the host only through the host-relay port and its own egress policy (§8.9).

---

## 2. Domain model

| Entity | Identity | Invariants |
| --- | --- | --- |
| Install | singleton | Exactly one repository, one owner. |
| Member | GitHub user id | Access = (owner ∨ added by a maintainer) ∧ live GitHub write access (M-05). Role ∈ {owner, maintainer, member}. Stable unix uid. |
| Credential | token id | Kind ∈ {session, delegated, run, machine}. Only `session` acts as a person for approvals (§5.4). |
| Stack | singleton per repository | Ordered list of unmerged TODOs. Item order = merge order. |
| TODO | `T<n>` (for example `T12`), sequential per install; GitHub's `#n` stays for issues and PRs | One stack item, one change, one branch, one PR. Prompt revisions are append-only. |
| Branch | name, unique per install | Kind ∈ {item, scratch}. An item branch belongs to exactly one TODO. |
| Machine | branch id (1:1) | At most one live VM per branch. Disk outlives the VM. |
| Run | run id | One durable execution of one pinned flow version. |
| Flow version | (flow name, digest) | Immutable. At most one Active version per overridable flow name. |
| Activity entry | id, per branch | Append-only. One entry per burst of writes or per agent step, steer, answer or GitHub event. |
| Presence | (branch, actor, session) | Ephemeral. Expires 30 s after its last heartbeat. |
| Terminal | id | Owner = one member. Runs as the owner's unix user. |
| Live document | (branch, path) or wiki page id | One Yjs document; one authoritative host (§7.4). |
| Secret | name | Value write-only. Scope ∈ {all-branches, main-only}. |
| Proposal | id | Produced by a learning run; becomes a TODO only by a member's action. |
| Conversation | branch id (1:1) | One per branch, shared by everyone on the branch. `main`'s conversation is the team's home and holds the stack. Prompts go to agents; there is no person-to-person chat (M-08). |
| Conversation entry | (conversation, entry) | Shared. A prompt, an answer, a card or an event. Has author, title, summary, tone, state and context (§14.5, §15.1). |
| Member view state | (member, conversation) | Private: scroll position, card view state, last seen entry, toast hiding. |

Actor notation used everywhere (events, activity, presence, audit): `{person: member id, via?: "smithers"|"claude-code"|"codex"|"ssh"|<agent>, session?: id}` for people and agents acting for them, and `{agent: "coding", run: run id, todo?: #n}` for the coding agent. Rendering: "Ben", "Ben via Claude Code", "Maya via SSH", "Agent".

---

## 3. Data model (PostgreSQL)

One schema, one forward-only migration ledger (existing). New or reshaped tables, with key columns only:

```
members(id, github_user_id UNIQUE, login, role, unix_uid UNIQUE, added_by, added_at,
        suspended_at, suspended_reason, removed_at, last_access_check_at)
credentials(id, member_id, kind, via, scopes[], token_digest, created_at, expires_at, revoked_at)
person_confirmations(id, member_id, kind[one_click|review_merge], action, subject, revision, requested_by_credential,
                     state[pending|approved|denied|expired], created_at, expires_at, decided_at)
install_settings(key PK, value jsonb, sealed bool, updated_by, updated_at)   -- bind, origins, setup token digest, budgets
github_app(id, slug, owner_login, owner_kind[user|org], client_id, pem_sealed, webhook_secret_sealed,
           client_secret_sealed, installation_id, created_at)

todos(id, number UNIQUE, title, state, state_reason, owner_id, issue_number NULL,
      fixes_issue bool, stack_position, branch_id, pr_number NULL, created_by_actor jsonb,
      flow_name, flow_digest NULL, needs_you jsonb NULL, failure jsonb NULL, queue jsonb NULL,
      current_step NULL, lessons int, merged_at, dropped_at, version)
todo_revisions(todo_id, rev, prompt, acceptance, seed_patch_blob NULL, author_actor jsonb,
               reason[create|amend|from-issue], issue_digest NULL, created_at)
todo_events(id, todo_id, seq, at, actor jsonb, kind, from_state, to_state, payload jsonb)
todo_attempts(todo_id, attempt, run_id, started_at, ended_at, outcome, evidence jsonb)
todo_approvals(todo_id, member_id, pr_head_sha, credential_id, at)

branches(id, name UNIQUE, kind[item|scratch], todo_id NULL, forked_from jsonb,
         github_branch NULL, rebase_pending jsonb NULL, moved_off jsonb NULL, created_at, archived_at)
machines(branch_id PK, workspace_id, state, vm_id NULL, disk_id, image_recipe_digest, last_activity_at,
         sleeping_since, wake_reason, head_change_id, head_commit_id, snapshot_tree_id)
machine_requests(id, branch_id, class[person|todo|background], requested_by jsonb, reason,
                 state[waiting|granted|cancelled], created_at, granted_at)

activity(id, branch_id, seq, at, actor jsonb, asked_by jsonb NULL,
         kind[step|steer|question|answer|edit|change|github|rebase|read|context],
         summary jsonb, burst_id NULL, snapshot_before NULL, snapshot_after NULL, files int, github bool)
         -- asked_by: the requester of a stack operation ("Maya asked · Rebased onto T8"); read/context per mvp.md B.3
burst_files(burst_id, path, change[added|modified|deleted|renamed], renamed_to NULL)
terminals(id, branch_id, owner_id NULL, run_id NULL, title, opened_at, closed_at)

flow_versions(id, flow_name, digest, source_commit, closure_blob, status[loaded|failed],
              load_error NULL, loaded_at)
flow_activations(flow_name, active_version_id, activated_at, previous_version_id)
proposals(id, learning_run_id, todo_from NULL, title, signature, evidence jsonb, refs jsonb,
          suggested_prompt, seed_patch_blob NULL, state[open|accepted|dismissed], todo_id NULL)
flow_config(scope[install|flow:<name>|agent:<role>], key, value jsonb, source[detected|owner|repo],
            updated_at)   -- install-stored defaults (§11.2) and agent models (§11.5a)
stack_attention(id, kind[order|force_push], payload jsonb, state[open|settled], created_at,
                settled_by jsonb NULL)
outbound_writes(key PK, kind, target jsonb, state[intended|done|unknown], github_ref NULL,
                created_at, done_at NULL)

github_sync(stream PK, last_attempt_at, last_success_at, etag, cursor, target_interval_s,
            last_error jsonb NULL)
secrets(name PK, scope, ciphertext, created_by, updated_at)

presence_sessions(id, branch_id, member_id, via, started_at, ended_at)   -- coarse: one row per continuous presence ≥ 2 min, for the scorecard (§20.4)
conversations(id, branch_id UNIQUE, created_at)
conversation_entries(conversation_id, entry_id, seq, kind[prompt|answer|card|event], author_actor jsonb,
                     title, summary, summary_rev, tone, state NULL, action jsonb NULL,
                     context jsonb NULL, run_id NULL, todo_id NULL, updated_at)
member_conversation_state(member_id, conversation_id, scroll_anchor_entry NULL, card_view jsonb,
                          last_seen_seq, toasts_hidden bool, updated_at)
projection_events(topic, seq, at, payload jsonb)   -- per-topic monotonic stream (§7.2)
```

3.0 The existing GitHub synced store (`github_synced_*` tables, `B/services/github_synced_repos.go`) is the cache of issues, PRs and comments. No second cache table is added. `github_sync` adds per-stream cursors, ETags and health on top of it.

3.1 Every mutation that changes a card writes its row change and one `projection_events` row in the same transaction. T-STK-01 owns the `projection_events` migration and writer; T-COL-02 builds the live transport on it. Then it runs `NOTIFY live, '<topic>'`.

3.2 `todos.state` is stored, not computed at read time. Every change appends a `todo_events` row with the actor and cause. Reads never infer a state that has no event (honest state, M-02 rule 5).

3.3 Retention: `projection_events` keeps 24 h or 10,000 rows per topic, whichever is larger. Older cursors get a snapshot (§7.2).

---

## 4. State machines

### 4.1 TODO

```
            place          machine granted          agent launched
 (draft) ─────────▶ queued ──────────────▶ starting ───────────────▶ working ◀──┐
                      │                                 │  │ ▲               │
                      │ drop                    ask/approval/conflict/       │answer
                      ▼                         moved-off │ │ steer          │resolve
                   dropped ◀──── drop ─────────────┐     ▼ │                │
                      ▲                            │  needs_you ─────────────┘
                      │ drop                       │
         ┌────────────┴─────────┐  stop            │
         │                      ▼                  │
         │  paused ◀── stop ── working ── run error ──▶ failed ── retry ──▶ queued
         │    └── resume ──▶ queued                          │
         │                     working ── PR opened ──▶ in_review ── merge ──▶ merged
         │                                                   │  ▲
         │                     changes requested / steer ────┘  │ checks/rebase
         └──────────────────── PR closed on GitHub ─────────────┘ (stays in_review)
```

| From → to | Trigger | Guard |
| --- | --- | --- |
| queued → starting | Admission grants the branch's machine | Machine `waking` or `awake`; flow version pinned at this moment (or reused on Resume, §11.4.2) |
| starting → working | The `todo` run's first step starts | Coding host up on the machine |
| starting → failed | The machine or the coding host fails to start | `failure.step = "start"` |
| working → needs_you | Run raises a durable wait of kind question, approval, conflict or moved-off | `needs_you = {kind, prompt, since, run_wait_id}` |
| needs_you → working | First accepted answer (§10.8) | Answer is from a member, or the coding agent resolves a conflict |
| working → paused | Stop | A durable pause signal; the run parks in a `paused` wait at its next boundary (it is not cancelled); the machine is released once safe-idle |
| paused → queued | Resume | Settles the pause wait; the same run continues from its last finished step once a machine is granted |
| working → failed | Run terminal `failed` or `uncertain` | `failure = {step, class, message, retryable}` |
| failed → queued | **Retry** (optionally with a steer) | A new attempt: a new run of the same pinned flow version from its first step; the earlier attempt and its evidence are kept. Re-running finished steps is intended here, unlike Resume (§19.1) |
| failed → queued | **Retry with the current flow** (`todo.retry-current-flow`, in-card) | As Retry, but the new attempt pins the currently Active flow version; same TODO identity and evidence |
| working → in_review | PR opened or updated for the verified revision | PR head = verified head |
| in_review → working | Changes requested, a review comment from a member, or a steer | Approvals for the old head are void |
| in_review → needs_you | An outside push to the TODO branch, or a rebase conflict the agent can't resolve | PR stays open |
| needs_you → queued | Answered after the machine was released (safe-idle) | The run resumes when admission grants the machine again |
| needs_you → working | Bring in (after an outside push) | The run rebases onto the pushed commit at its next checkpoint |
| needs_you → in_review | Discard (after an outside push), or another answer that needs no new work | The PR head is the verified candidate |
| in_review → merged | GitHub reports the PR merged and `main` contains the commit | none (merge on GitHub counts, M-22) |
| any unmerged → dropped | Drop, or the PR is closed on GitHub without merge | The PR is closed and later items are rebased |
| dropped → in_review | The PR is reopened on GitHub within 7 days | `smithers/<slug>` is recreated from the captured head in the repo store; machine cleanup doesn't matter (§12.3) |

4.1.0 The stack engine's work record (`mythical_items.state`, 15 values) projects onto the TODO state. `todos.state` is written by the engine in the same transaction as the item change:

| Item state | TODO state |
| --- | --- |
| `queued`, `skipped` (not yet admitted) | queued |
| launched, run not yet reporting its first step | starting |
| `running`, `delivering`, `integrating`, `verifying`, `proposing`, `waiting`, `retrying` | working (`current_step` names the phase) |
| `proposed` | in_review (stays in_review while the PR rebuilds after an earlier merge) |
| `landed` | merged |
| `blocked` | failed |
| `cancelled`, `rejected`, `declined` | dropped (`state_reason` keeps the cause) |
| any, with an open `needs_you` | needs_you |
| any, with `paused_at` set | paused |

4.1.1 `queued.queue = {reason: "waiting for a machine"|"merges after Tn"|"rebase pending", position}`. The position comes from §8.3.

4.1.2 `working.current_step` is the step id of the run's innermost active flow step. It is projected from runtime events within 1 s.

4.1.2a Stack-level attention (`order`, `force_push`) is not a TODO state. It lives in `stack_attention`, shows on the Home card for its audience (maintainers for `order`, the owner for `force_push`), and holds the stack's merges until settled.

4.1.3 Learning never changes `merged` (M-15). It increments `lessons` when its proposals and pages are written.

### 4.2 Machine

```
 none ──create──▶ provisioning ──▶ awake ◀──wake── asleep ◀──sleep── awake
                     │               │  ▲            │
                     │ fail          │  └─ waking ◀──┘ (granted)
                     ▼               ▼
                  failed          releasing ──▶ asleep          archived (TODO settled + captured)
```

Machine states shown in the product: awake, asleep, waking, waiting #n (= request queued), closed (= archived). `failed` shows as the failure with Retry.

### 4.3 Flow version

```
 proposed (open TODO touches flows/<name>/) ── merged on main ──▶ merged-syncing
 merged-syncing ── load ok ──▶ active (previous → previous)
 merged-syncing ── load fails ──▶ merged-failed (previous stays active)
```

### 4.4 GitHub sync health

`fresh` while the oldest required stream's `last_success_at` is ≤ 2 × target. Past that it is `stale`, which shows gold. It is `refused` when GitHub answered with a permission or not-installed error; that names the cause and links Settings. It is `limited` when rate-limited, with `retry_at`.

---

## 5. Identity, roles and credentials [S1; §5.5 S2]

### 5.1 Sign-in

5.1.0 First owner. `smthrs host start` prints a one-time setup URL for each listener (for example `http://localhost:4000/setup?token=…`); only the token's digest is stored. Opening it on any listener creates a token-backed setup session, so the owner may run setup from a laptop on the LAN (J1.1). That session can do only the setup steps (§16.2). GitHub sign-in needs the App, so the owner claim completes when the setup session's holder signs in with GitHub through the newly created App. That binds the owner identity and deletes the token. Nobody without the installer's terminal output can claim the install.

5.1.1 People sign in with GitHub through the install's GitHub App user authorization (OAuth web flow). The callback URLs registered on the App are the configured origins plus `http://localhost:4000` (§16.3.3).

5.1.2 On each sign-in the host service checks two things. The person must be the owner or have a `members` row that isn't removed. The person must also have `push` or higher permission on the repository, read with `GET /repos/{o}/{r}/collaborators/{login}/permission` using the installation token. If either fails, sign-in is refused with the reason, for example "needs access on GitHub ↗".

5.1.3 Hourly, and on any 401 or 403 from GitHub for that member, the service re-checks every active member. Losing write access sets `suspended_at` and publishes the revocation event (§5.6). Regaining it clears the suspension on the next check.

5.1.4 Role seeding: when a maintainer adds a person, the role defaults from GitHub. A person with only read access (or none) can't be added; the card shows "needs access on GitHub ↗". The owner can't be demoted or removed by anyone; owner transfer is deferred. Admin or maintain becomes Maintainer, and write becomes Member. A maintainer may change it.

### 5.2 Permission matrix

| Action | Owner | Maintainer | Member | Delegated (agent) | Coding agent (run) |
| --- | --- | --- | --- | --- | --- |
| Install settings: model access, capacity, GitHub App, upgrade | ✓ | | | | |
| Merge, approve a revision | ✓ | ✓ | | merge: `confirm` through Review & merge (a maintainer's session approves); approvals that gate a merge: `never` | |
| Members, roles, secrets write | ✓ | ✓ | | never (no confirmation path: secret values never pass through an agent or a pending confirmation) | |
| Merge flow/agent changes (same as Merge) | ✓ | ✓ | | confirmation only | |
| Create, place, amend, steer, answer, stop, resume, retry, drop TODOs | ✓ | ✓ | ✓ | ✓ as person | answer own conflicts only |
| Join branch, terminal, SSH, co-edit, fork, comment, run flows | ✓ | ✓ | ✓ | ✓ as person | within its own branch |
| Read secret values | | | | | |

A `machine` credential has no row: it can only report its own branch's events (§9.1) and read what that branch needs.

5.2.1 Every row is enforced in the host service by one authorizer, `Authorize(credential, action, subject)`. UI hiding is presentation only.

### 5.3 Credentials

| Kind | Issued to | How | Can approve/merge |
| --- | --- | --- | --- |
| `session` | Browser of a signed-in person | Sign-in cookie: HttpOnly, Secure, SameSite=Lax, 30-day TTL | Yes, for roles that allow it |
| `delegated` | An agent acting for a person: `smthrs login` (always), branch terminal auto sign-in, the app agent | Minted with `via` = the agent's name (claude-code, codex, smithers, terminal, cli) | No. It can request a person confirmation (§5.4) |
| `run` | One coding-agent run | Minted at run start, dies at the run's terminal state | No |
| `machine` | `smithers-machined` and the coding host on one machine | Minted per boot, scoped to that branch | No |

5.3.1 `smthrs login` MUST return a `delegated` credential, never a person-equivalent token, because the CLI can't know whether an agent will hold it. The `via` defaults to `cli`; `smthrs login --agent claude-code` sets it.

5.3.2 A branch terminal is signed in automatically. When a member's session starts on a machine, the host mints a `delegated(via=terminal)` credential for that member and branch. It writes the credential to `/run/smithers/<uid>/token` with mode 0600, owned by that uid, and sets `SMITHERS_TOKEN_FILE` and `SMITHERS_URL` in the session environment. A tool inside the terminal, such as Claude Code, inherits it and is attributed "Ben via Claude Code" through the skill's `via` header (§6.4).

### 5.4 Person confirmation

A delegated credential whose catalog row is `confirm` (§15.1.5; for example merge, commit or drop a TODO) may create a `person_confirmations` row (`POST /api/confirmations`). The app shows the confirmation to that member only, bound to the exact subject revision. Only a `session` credential can approve it. A confirmation expires after 24 h or when its subject's revision changes. Agents never receive the approve endpoint's response body beyond the row id and state. Pending confirmations publish on the `confirmations` topic for their member.

### 5.5 Unix identity on machines (M-18, M-29)

5.5.1 Each member has a stable `unix_uid` from 20000 upward and a login equal to the GitHub login, sanitized to `[a-z0-9_-]{1,32}`. The coding agent runs as `agent` (uid 19999). `smithers-machined` runs as root, and nothing else does.

5.5.2 No user on a machine has sudo, setuid helpers, file capabilities or membership in privileged groups. The image MUST NOT contain `sudo`. `su`, setuid/setgid binaries and binaries with file capabilities are removed or stripped. A sanitized login that collides with another gets a numeric suffix (`ben`, `ben2`), fixed at first assignment.

5.5.3 The working copy is owned `root:team` (gid 20000), with setgid directories and mode `g+rwX`. Every session has `umask 002`. Members and `agent` are in `team`.

5.5.4 Each member's home is `/home/<login>`, mode 0700, persisted per member across machines (§8.7) so tool logins carry from branch to branch. `agent` has no access to member homes.

### 5.6 Revocation

Removing or suspending a member deletes their sessions, revokes their delegated credentials and SSH grants, and closes their live sockets, terminals and SSH sessions within 5 s. Their TODOs keep their history; any maintainer can take one over with **Take over**, an in-card control on the TODO card (`todos.owner_id` change, audited).

---

## 6. Commands, API and the catalog

### 6.1 One catalog

6.1.1 Every member-facing action is a command with a typed payload schema. The command is the single source for four doors: the app's slash menu, palette and card buttons; the app agent's tool list; the `smthrs` CLI; and the Smithers skill (M-21).

6.1.2 The MVP catalog is a machine-readable file, `catalog.mvp.json`, generated from the command registry. Each row has the slash name, CLI path (`null` for UI-only rows such as ⌘K, `/help`, `/stop` and `/theme`), journey, group, visibility (`core`, `advanced`, `in-card` or `hidden`), `agent: run | confirm | never` (§15.1.5) and a person-only flag. `in-card` commands are controls inside a card: the three doors still apply, but they're absent from `/help` and Appendix A (for example Return to Tn, Keep for now, OK on order attention, Reset to GitHub main, Make TODO from a proposal, Dismiss, Retry a background run). Sign-in and sign-out are never agent-invocable. The CLI hides non-MVP groups from MVP help with an explicit hidden list where incur lacks a flag. A CI check fails when a registered command visible to members is absent from mvp.md Appendix A, or an Appendix A row has no command, CLI path or skill entry (check C-CAT-01). mvp.md Appendix B is the registry of every flow and action (app flows, coding-host tools, backend system flows and workers, CLI commands). The allowlist test derives from B.1, B.2, B.4 (in-card controls with stable ids, such as `todo.return-to-item`, `file.restore` and `merge.confirm`) and B.6, plus Appendix C (`.specs/product/actions.md`: every Flow, Action and AgentAction tag in shipped flows and std tools, 386 rows). A tag that is registered but has no Appendix C row, or whose row says Cut, fails the build. A ticket that adds a tag adds its Appendix C row in the same change. In short: anything registered but absent from B, or marked Cut there, fails the build.

6.1.3 Commands outside the MVP stay published as libraries or CLI groups but are `hidden`. They are absent from the palette, `/help`, the agent's tools and the MVP docs.

6.1.4 A missing required input opens a form card, never a usage sentence.

### 6.2 HTTP API conventions

6.2.1 Every mutating request carries `Idempotency-Key`. A repeat with the same key returns the original result.

6.2.2 Responses state progress honestly. `202 {state:"requested"}` means persisted. `{state:"accepted"}` means durable admission. Completion arrives only as a projection event. A transport success is never completion.

6.2.3 Errors use one typed envelope: `{code, class: user|permission|capacity|github|infra|conflict, message, retry_at?, fix?}`. The class drives the UI fault copy ("not your fault" for infra and capacity).

6.2.4 The OpenAPI document MUST describe every served route. Cut routes are deleted from both the code and the document in the same change. A route that Plue still serves but the Mac install must not (for example `/api/admin/*`) is unmounted in the install composition only, and the OpenAPI row carries `x-composition: plue`; the conformance test checks each composition against its own rows.

### 6.3 Resource surface (target)

```
/api/install            see below (status, settings, setup steps, quiesce, scorecard)
/api/members            GET · POST add · PATCH role · DELETE remove
/api/todos              GET list · POST create{prompt,title,acceptance?,place,issue?,fixes?,seed_patch?}
/api/todos/{n}          GET · PATCH amend · POST {stop|resume|retry|drop|steer|answer|move}
/api/todos/{n}/merge    POST (session only) {reviewed_head_sha}
/api/stack              GET (home card snapshot)
/api/branches           GET · POST fork{from: main|Tn|branch, name?}
/api/branches/{b}       GET · POST {rebase|add-to-stack} · /files · /diff · /activity
/api/conversations/{b}  GET entries · POST prompt · PUT view-state
/api/terminals          POST open{branch}
/api/flows              GET catalog with versions · POST edit{name, request} · POST run
/api/runs               GET · /{id} · /{id}/trace · POST signal
/api/proposals          GET · POST {id}/accept · POST {id}/dismiss
/api/secrets            GET names · PUT · DELETE
/api/github/sync        GET health · POST retry
/api/confirmations      GET mine · POST create (any credential) · POST {id}/approve|deny (session only)
/api/agents             GET (roles, model, runs) · PUT {role}/model (owner)
/api/install            GET status (with the setup token before an owner exists, owner afterwards) · PUT settings · POST setup/{step} · POST quiesce · GET scorecard (owner)
/api/live               WebSocket (§7)
/ssh :2222              SSH gateway (§8.10)
```

### 6.4 Attribution header

Every request from an agent carries `Smithers-Via: <agent>`. The CLI and skill set it from the environment: `CLAUDECODE=1` → `claude-code`, `CODEX_*` → `codex`, otherwise the `via` in the credential. The host records `via` from the credential kind and the header, credential first. A `session` credential ignores the header.

---

## 7. Live channel [S1; presence S2; documents S3]

### 7.1 Transport

One authenticated WebSocket per browser tab, `ws://` or `wss://` matching the page's origin, at `/api/live`, subprotocol `smithers.live.v1`. It is authenticated by the session cookie, or by a bearer token for the CLI. Frames:

```
text   {"t":"sub","id":7,"topic":"todo:12","cursor":1043}
text   {"t":"unsub","id":7}
text   {"t":"snap","id":7,"cursor":1050,"data":{…}}        server → client
text   {"t":"delta","id":7,"cursor":1051,"data":{…}}
text   {"t":"gap","id":7}                                    client must resubscribe without a cursor
text   {"t":"err","id":7,"code":"unknown_topic|forbidden|unsupported"}   subscription refused; socket stays open
text   {"t":"presence","id":9,"where":{…}}                   client → server heartbeat
binary [kind u8][sub id u32][payload]   kind: 1 yjs-sync, 2 yjs-awareness, 3 term-out, 4 term-in, 5 term-ctl
```

7.1.1 The server applies backpressure with a per-connection send budget of 2 MiB. On overflow, projection subscriptions receive `gap`, terminals drop to ring replay, and Yjs documents restart sync step 1.

7.1.2 Reconnects back off with jitter from 250 ms to 5 s. On reconnect the client resubscribes with its last cursors.

### 7.2 Projection topics

| Topic | Snapshot | Deltas from |
| --- | --- | --- |
| `home` | Stack, `main` row, counts, background runs, machines in use / capacity, sync health | todos, todo_events, machines, github_sync, runs |
| `todo:<n>` | TODO card model (§14.3) | todo_events, runs, activity, the GitHub synced store |
| `branch:<id>` | Branch card model: machine, presence, item, place, terminals | machines, presence, terminals |
| `branch:<id>:activity` | Last 200 activity entries | activity |
| `branch:<id>:files` | Changed files vs the item's base, plus per-file last writer | burst_files, live documents |
| `run:<id>` | Run summary and steps | runtime events (§11.6) |
| `members` / `secrets` / `flows` / `proposals` / `agents` | Card models | their tables |
| `install` | Setup and Settings model (§14.3) | install_settings, github_app, host profile |
| `confirmations:<member>` | That member's pending confirmations (member-only) | person_confirmations |
| `view:<member>:<branch>` | That member's view state for a conversation (member-only) | member_conversation_state |
| `conversation:<branch>` | Shared entries with author, title, summary, tone, state, context | conversation_entries |

7.2.1 A delta MUST arrive at subscribers within 1 s (p95) of the committing transaction on the reference host (check C-PERF-02).

7.2.2 Shared topics carry only shared state. Per-member data lives on member topics named with the member id: `confirmations:<member>`, `view:<member>:<branch>` (view state, `last_seen_seq`), and private entries (`audience_member_id`, §14.5.1). The client derives `merged_since_last_look` and the Home card's `attention[]` from shared rows plus the member's own `last_seen_seq` and role. `NOTIFY` fan-out needs no member filter.

### 7.3 Presence [S2]

7.3.1 Presence is in-memory in the host service, keyed `(branch, actor, session)`, with a 30 s TTL refreshed by heartbeats. Heartbeat sources:
- the browser, every 10 s and on every move, with where = `{file, line}`, `{terminal}`, `{run step}` or `{branch}`;
- `smithers-machined` for SSH, terminal and editor sessions, with where = the file last written by that session (§9.3);
- the runtime for the coding agent, with where = the current step and the file it last wrote.

7.3.0 For 30 s after the host starts, presence is unknown, and the scheduler releases no machine in that window (§8.3.3).

7.3.1a When a person's presence on a branch lasts at least 2 min, the host writes one coarse `presence_sessions` row (start, end) for the scorecard. Presence itself stays in memory.

7.3.2 Presence changes publish to `branch:<id>` as deltas, coalesced to at most 4 per second per branch, and reach subscribers within 1 s. Rows are kept per session and shown per person: one avatar per person, with a person's sessions listed on hover.

### 7.4 Live documents (Yjs) [S3]

7.4.1 One protocol: Yjs sync step 1 and 2, updates, and awareness, carried in binary frames on the live channel. One client provider serves both document kinds.

7.4.2 Two document hosts implement it:
- **Code files:** `smithers-machined` inside the branch machine owns the document and the file (§9.2). The host service relays frames over its machine connection. It doesn't parse them, but it authenticates each subscriber and tags its updates with the subscriber's actor.
- **Wiki pages:** the host service owns the document (Yrs). It persists the merged state and the rendered Markdown in PostgreSQL, one revision per idle period (2 s) rather than per update.

7.4.3 The wiki moves onto 7.4.1 in stage 3, together with code co-editing, and the earlier POST-update and SSE-refetch protocol is deleted then. There is one co-editing implementation.

7.4.4 Attribution of characters: each subscriber connection gets a Yjs client id that the host records as `client id → actor`. That map is stored in the document's own `Y.Map("authors")` so every host and reader resolves colours identically. Edits applied by `smithers-machined` for an outside writer use a client id allocated to that writer (§9.2.4).

7.4.5 Awareness carries `{actor, colour, line}` only; selections and carets are not shown (mvp.md §6.8 Cut). The card renders a gutter name flag per remote editor line.

### 7.5 Terminals on the channel

A terminal subscription streams the PTY [S2]. Kind 4 (input) is accepted only from the terminal owner. Input from anyone else is dropped, and the drop is counted (§8.11).

### 7.6 Co-editing contracts fixed in stage 1 [S1]

These hold from the first stage-1 commit, so stage 3 adds a document layer without changing any earlier interface. ADR 0003 (T-COL-10) records them.

| Contract | From | Why stage 3 needs it |
| --- | --- | --- |
| Every write to a branch's files carries an actor (§2) and a `base_digest` precondition; a stale write is refused with `409 stale`, never applied silently | S1: the coding agent's write tool checks it in the machine (T-COL-07); the HTTP route is contract-only until S3, proven by an API test (C-COL-01) | Disk→document reconcile and "no silent overwrite" |
| Topics `doc:code:<branch>:<path>` and `doc:wiki:<page>` and binary frame kinds 1–2 are reserved on the live channel | S1 | The Yjs sync protocol rides the existing channel (§7.4.1) |
| The File card renders with CodeMirror 6, the surface `y-codemirror.next` binds to. Code intelligence (hover, definition, diagnostics) moves from the Pierre file view onto CodeMirror extensions. Diffs stay on `@pierre/diffs` | S1 (T-APP-15 builds it read-only first) | One editor for view and co-edit; no second renderer |
| Presence `where` uses `{path, line}` in the document's line coordinates, the same shape Yjs awareness carries | S2 | Gutter name flags come from presence before co-editing exists |
| The daemon's host connection reserves a document stream kind; `capture()` has a flush phase (a no-op until S3) | S2 | Sleep, upgrade and rebase flush documents first (§8.4.3, §9.4) |
| Change events carry each file's post-write content digest | S2 | The document host tells its own writes from others' (§9.2.2–9.2.3) |
| One machine per branch, keyed by branch (§8.1) | S2 | The document host lives on the branch's one machine |
| The wiki keeps `Y.Text("markdown")` as its document shape | S1 | The wiki moves to the same transport in S3 without a data migration |

---

## 8. Branches and machines [S2; images §8.6 S1]

### 8.1 Identity

8.1.1 A branch is identified by its name. An item branch is named `smithers/<todo-slug>`, where the slug is derived from the TODO title, is ≤ 48 characters and is unique. A scratch branch is named `scratch/<member>/<name>`.

8.1.2 Every member and the coding agent who join a branch use its single machine. No per-person or per-agent copy of a branch exists (M-17). Branch locks do not exist.

### 8.2 Capacity

8.2.1 Every limit derives from the host the install detects at start (M-06). The install never assumes a Mac model. Host profile: `hw.memsize`, `hw.perflevel0.physicalcpu` (performance cores) plus `hw.physicalcpu`, free disk on the `$STATE` volume, the macOS version, and Hypervisor.framework availability.

| Limit | Formula | 24 GB / 8 P-cores / 200 GiB free | 32 GB / 10 / 400 | 64 GB / 12 / 1 TiB |
| --- | --- | --- | --- | --- |
| Machine memory | 8 GiB, or 6 GiB when host memory < 24 GiB | 8 | 8 | 8 |
| Machine vCPUs | `clamp(perf_cores / 2, 2, 4)` | 4 | 4 | 4 |
| Capacity | `max(1, min(floor((mem − reserve) / machine_mem), floor(perf_cores / 2), floor((free_disk − 40) / 32)))`, reserve = 8 GiB | 2 | 3 | 6 |
| Layer budget | `min(48 GiB, 25 % of free disk)` | 48 | 48 | 48 |

The owner may lower capacity but never raise it above the formula. The T-MCH-01 measurements calibrate the reserve and the per-machine memory, not the shape of the formula. Settings shows the detected profile and the resulting limits.

8.2.2 A background layer-prepare VM counts against capacity while it runs.

### 8.3 Admission

8.3.1 One queue, `machine_requests`, for every reason a machine must be awake. Classes in priority order: `person` (a member's terminal, SSH, edit, steer or answer that needs the machine), `todo` (a TODO run) and `background` (learning, flow load, wiki refresh).

8.3.2 Scheduler: event-driven, with a 1 s tick. While `awake + waking < capacity`, it grants the oldest request of the highest class. A position is the request's rank within the ordered waiting set, and it is shown as "waiting for a machine #2".

8.3.3 Preemption: none. A working coding agent is never paused to free a machine (M-13). When requests wait and capacity is full, the scheduler releases the longest-idle machine that is safe-idle (§8.4).

8.3.4 A granted request whose actor leaves before the wake finishes is cancelled, and the machine sleeps again if nothing else holds it.

### 8.4 Safe-idle and sleep

8.4.1 A machine is **safe-idle** when four things hold:
- no presence on its branch other than watchers of a finished run;
- no open terminal or SSH session;
- no running run step that needs the machine (a run waiting on a person, in review or paused doesn't count);
- no burst open, and every live document flushed.

8.4.2 Release order: first, waiting requests trigger release of the longest safe-idle machine. Otherwise a machine sleeps after 30 min safe-idle, or after 2 min safe-idle when its TODO is `in_review`, `needs_you` or `paused`.

8.4.3 Sleeping runs a final capture before the VM stops: flush documents, close bursts, jj snapshot, push the head ref to the host. The disk is kept.

8.4.4 Reading a sleeping branch never wakes it. Files, diff, activity and head come from the last captured snapshot in the host repository store (`refs/smithers/branches/<id>/head`). Only a person's work action or a TODO run wakes it: a terminal, SSH, an edit in a File card, a steer, an answer or a resume.

### 8.5 Fork, Add to stack, Rebase now [S1] (M-32)

8.5.0 Fork, Add to stack and Rebase now are system flows that any actor invokes. In stage 1 a fork's source is `main` or an item; forking a scratch branch waits for stage 2's capture. The stack service is the only writer of branch history (M-32): every fork, place, reorder, rebase and merge appears in branch activity as "Smithers", with the requester shown ("Smithers, for Ben"). Requesters include a person and the app agent, under §15.1.5 permissions (fork and rebase: `run`; add to stack: `confirm`). The buttons and the agent delegate to the stack service. Stage 1 implements them over today's workspaces: a fork starts from the item's last verified head or from `main`. Stage 2 adds capture first (§8.5.2).

8.5.1 A fork creates a scratch branch from a revision. Sources: `main` (its tip), an item (its last captured head) or any branch (its last captured head, after an on-demand capture if the branch is awake).

8.5.2 A fork MUST NOT stop the source machine. It starts from a revision, not a disk copy; uncommitted work is included only via the capture, which is a jj snapshot and therefore a revision.

8.5.2a **Rebase now** on a scratch branch rebases it onto the current head of what it was forked from: `main`'s tip, or the item's last verified head.

8.5.2b A Rebase now conflict on a scratch branch has no TODO to raise Needs you on. The Branch card shows the conflicted paths with Resolve, and the branch stays on its pre-rebase head until someone presses Done (§10.5.4).

8.5.3 **Add to stack** from a scratch branch creates a new TODO whose seed is the scratch change, placed like any other (default: after the item it was forked from). The scratch branch becomes that TODO's item branch: it is renamed `smithers/<slug>` and keeps its machine, working copy and the people on it. A scratch branch's Diff card compares against its fork revision. [D] **Replace Tn**, which would make the scratch head the new head of item #n's change, is deferred.

### 8.6 Images [S1]

8.6.1 A machine's root disk is built from a recipe. **Add to machine image** (an in-card control on Settings and on a failed step that names a missing tool) creates a TODO whose seed patch adds the package to `.smithers/machine.json`. The recipe is the pinned base image, the toolchain detected from the repository (§8.6.2), the declared image additions (`.smithers/machine.json` `packages[]`, reviewed like any change, M-29) and the dependency install for the head revision. The recipe digest keys a layer cache, so two branches with the same recipe share layers.

8.6.2 Toolchain detection reads these files and nothing else. The supported envelope is Node, Go, Rust and Python. A repository with none of them gets the base image only, and a run step that needs a missing tool fails, naming the file to add.

| File | Detected |
| --- | --- |
| `.node-version`, `.nvmrc`, `package.json#engines.node` | Node version |
| `package.json#packageManager`, lockfiles (`pnpm-lock.yaml`, `package-lock.json`, `yarn.lock`, `bun.lock[b]`) | Package manager + install command |
| `go.mod` (`go` and `toolchain` directives) | Go version, `go mod download` |
| `rust-toolchain.toml`, `Cargo.toml` | Rust toolchain, `cargo fetch` |
| `.python-version`, `pyproject.toml`, `uv.lock`, `requirements*.txt` | Python version, `uv sync` / `pip install` |

8.6.2a Detected tool versions resolve through a pinned toolchain manifest shipped in the install bundle (`toolchains.json`: version → download URL → SHA-256), updated each release. A version absent from the manifest resolves to the nearest pinned patch of the same minor version, or fails naming the file to change.

8.6.3 "Source ready" means the mirror holds `main`. "Machine ready" means the first recipe for `main` is built. They are separate setup steps (J1.4).

### 8.7 Homes and logins

8.7.1 Member homes live on the host under `$STATE/homes/<login>/`. Each member's home is a separate virtiofs mount at boot (`--mount-dir <host dir>:/home/<login>:uid=<uid>,gid=<uid>`), owned by that member's uid with mode 0700. This is layout B from spike T-MCH-02 (#3437): uid, gid and 0700 hold across reboot and across VMs, cross-member reads fail EACCES, and changes are visible between VMs at p95 645 ms (max 4.7 s). Members log in to a tool once per install. `msb` can't add a mount to a running VM, so a member added while a branch's machine is awake gets a machine-local home there until the next wake. Logins made in it don't carry over, and that member's terminal header shows "temporary home until next wake" (mvp.md §6.8). Per-person uids stay in every case.

8.7.2 Nothing in a home is readable by `agent`, by other members, or by the host service's flows.

### 8.8 Secrets

8.8.0 A secret that declares hosts stays egress-bound, as today: the relay substitutes its value only toward those hosts, and the value never enters the machine. Only secrets without declared hosts become environment variables (§8.8.1).

8.8.1 [S2] All-branches secrets without declared hosts are written to `/run/smithers/env` (root:team 0640) at boot, and rewritten by the daemon within 5 s of a change. New sessions and runs load the new values; running processes keep theirs. Any session on a machine can print these values: "nobody reads values back" applies to the API and the Secrets card, as with GitHub Actions secrets. [D] Recording each use by run is deferred.

8.8.2 Main-only secrets reach only trusted runs on `main`, in an ephemeral background machine: a person's schedule or a manual run by a maintainer. They never reach item or scratch branches, agent runs or outsider-triggered runs (D-24).

8.8.3 Provider model keys never enter a machine. The coding agent's model calls go through the host's model proxy with a `run` credential (§15.2).

### 8.9 Network

A machine's egress is open to the internet by default for package installs, through the host egress relay with per-run audit. Bound secrets are swapped in by the relay for their allowed hosts only. The host service is reachable from a machine only on the relay port.

### 8.10 SSH gateway

8.10.1 The host listens on port 2222 (§1.4). The username is the branch name or slug, for example `retry-webhooks`, which resolves `smithers/retry-webhooks` and then `scratch/*/retry-webhooks`. Ambiguity is an error that lists the candidates. The install composition uses branch-name usernames. Plue's composition keeps its `<sandbox>+<user>` login form.

8.10.2 Authentication: the public key must match one of the member's keys. Keys are the member's GitHub keys (`GET /users/{login}/keys`, refreshed at sign-in and hourly, cached) plus keys added with `smthrs ssh-key`.

8.10.3 The gateway admits a `person` wake request (§8.3) and then proxies the session into the machine as the member's unix user, in the working copy directory. Machines run no sshd. The gateway maps SSH channels onto the daemon's session primitives (§9.1.2):
- shell and exec become a PTY or process as the member's uid in a new session cgroup;
- `subsystem sftp` becomes `sftp-server` as the member;
- `direct-tcpip` becomes a TCP connect to the guest's loopback port.

That is what VS Code, Cursor and Zed remote need. SSH agent forwarding is not supported in the MVP.

8.10.4 Presence shows "Maya via SSH" while the session lives, with where = the file last written by that session.

8.10.5 The SSH host is the host name of the install's first public origin, or `localhost` when none is set. The Branch card copies `ssh -p 2222 <branch>@<host>`; `smthrs ssh <branch>` is the alternative.

### 8.11 Terminals

8.11.1 A terminal is a PTY session that the daemon starts as the owner's unix user, in the working copy, in its own session cgroup. The host's terminal manager attaches to it over the daemon connection and serves it on the live channel (§7.5), replacing today's separate terminal WebSocket. It is signed in to Smithers (§5.3.2). In stage 1, before the daemon exists, terminals keep today's `msb exec -t` path as the guest's single user. The stage-1 terminal token is therefore readable by the coding agent. It is minted only when a member opens a terminal, expires with the session, and is limited to: reads the member can do; `todo.answer` and `todo.steer` on that branch's TODO; `todo.new` (append only); and wiki reads. `Authorize` enforces the list (check C-SEC-05). No release ships stage 1 alone.

8.11.2 [S2] Any member on the branch may watch; their view is read-only, and only the owner types (M-18). [D] **Ask to type**, with Allow and revoke, is deferred.

8.11.2a [S2] The coding agent's `bash` tool runs in the agent's own terminal session on the branch: a daemon PTY owned by `agent`, attributed to the run. Its commands therefore render in the Terminal card like anyone's (one card per flow, whoever runs it), and members can watch it read-only. Command output still returns to the agent as the tool result.

8.11.3 A terminal survives browser reloads through the ring replay (512 KiB). It does not survive a machine sleep or an install restart. A terminal open on a branch prevents safe-idle (§8.4).

### 8.12 Cleanup

A machine's VM and disk are deleted only when four things hold: its TODO is merged or dropped (or its scratch branch is archived), a final capture succeeded and the head ref equals the captured head, no terminal or service is active, and 24 h have passed. Services still running on a settled branch are stopped after those 24 h. History, activity and evidence remain in PostgreSQL and the repository store.

---

## 9. The machine daemon (`smithers-machined`) [S2; documents S3]

A static Rust binary (linux-arm64, musl) that runs as root inside every machine and starts before any session. It is the only process that writes the working copy on behalf of live documents. It is the only observer of writes, and it is the machine's single connection to the host.

### 9.1 Connection

9.1.1 `smithers-machined` keeps one multiplexed connection to the host over the host-relay port. It authenticates with the boot's `machine` credential and reconnects with backoff. Streams on the connection: control RPC, change events, live-document frames and presence.

9.1.2 Control RPC:
- `capture()`: flush documents, snapshot, push head and snapshot commits;
- `read_file(path, at?)`;
- `write_file(path, base_digest | "absent", content, actor)`: the §7.6 compare-and-write;
- `open_session(member, kind: pty|exec|sftp, argv?)` and `tcp_connect(port)`: §8.10.3, §8.11;
- `register_run(run_id, cgroup)`: the coding host calls it at run start, so writes by the agent's processes resolve to that run;
- `rebase(onto)`: §9.4;
- `return_to_item()`: §9.3.8;
- `wake_reconcile()`: runs on every boot before any session starts. It fetches `refs/smithers/branches/<id>/head` from the host. If the host rebased the branch while it slept (§10.5.5), it moves or rebases `@` onto that head and emits "Rebased onto Tk". A conflict becomes `needs_you{conflict}` on wake;
- `status()`;
- [S3] `open_doc(path)` and `close_doc(path)`.

9.1.2a Each snapshot is one jj operation. The daemon abandons operations older than 7 days weekly (`jj op abandon`), keeping the ones activity entries reference. T-COL-01 measures snapshot latency on the smithers repository in a VM (target under 500 ms).

9.1.3 The guest's init supervises the daemon and restarts it on exit, with backoff. While a machine is awake, capture runs after every burst (coalesced to one per 5 s) and at least every 5 min.

### 9.2 Live code documents [S3]

Stage 2 has no co-editing. An open File card is read-only to everyone except through SSH, the terminal and the agent, and it reloads within 1 s of a change event (§9.3.4) that touches its path. Stage 3 adds everything below.

9.2.1 A document opens on the first subscriber. `smithers-machined` reads the file and seeds a Yrs document with a single `Y.Text("content")`. Only UTF-8 text files up to 1 MiB are live-editable. Larger or binary files open read-only, with a "too large to co-edit" state.

9.2.2 **Document → disk.** After each applied update, it writes the document text to disk 200 ms after the last update, with a 1 s maximum. Each completed save sends `{saved_digest, saved_at}` on the document stream, which drives the card's "Saved to the machine" state. The write goes to a temp file in the same directory, `fsync`, then `rename`, preserving the mode, owner and group of the replaced file. The written content's digest is recorded as `last_disk_digest`. Its own writes are recognized by path and the digest it just wrote (inotify carries no writer pid) and are excluded from watcher bursts. Document edits get their own activity entries instead: one per editor per idle period (2 s), for example "Alice edited retry.ts".

9.2.3 **Disk → document** (mvp.md §6.8 save and recovery). When the watcher (§9.3) sees an outside write to an open document's path, it reads the file. It merges three ways, with base = the content it last wrote (`last_disk_digest`), ours = the live document and theirs = the new file:
- **No overlap:** the outside changes apply to the document as one transaction attributed to the outside actor (§9.3.1), and card readers see them within 1 s (§18).
- **Overlap:** the live document wins on disk. The daemon first snapshots the outside version (a jj snapshot commit, so it is recoverable), then applies the non-overlapping outside hunks, rewrites the file from the document, and flags the file "Changed outside Smithers · Compare" (`file.compare` opens the snapshot against the document).

9.2.3a Saved means on disk (fsync'd) within 1 s of the keystroke and surviving a restart of the machine or the install. A restart never loses an acknowledged save.

9.2.4 Attribution of outside edits: each outside actor (a person's session, the coding agent or a terminal tool) gets a stable Yjs client id per document, recorded in `Y.Map("authors")`. The edit is produced in a scratch document with that client id, synced from the live state, and its update is applied to the live document. The cost is O(document size) per outside edit, which the 1 MiB limit bounds.

9.2.5 A document closes 60 s after its last subscriber leaves, after a final flush. Its Yrs state, including per-character authors, persists on the machine disk outside the working copy (`/var/lib/smithers/docs/<path digest>`), so authors survive reopening. It is discarded when the file on disk no longer matches it (an outside rewrite). The file on disk stays the truth.

9.2.6 **Delete and rename while open.** In stage 2 the File card shows the same states from `file_written` and burst events. Restore rewrites the content from the last snapshot before the delete, and Follow opens the new path. In stage 3: A delete marks the document `gone{kind: deleted, by}`, and editing pauses. **Restore** rewrites the last document text. A rename to a new path inside the working copy marks it `gone{kind: renamed, to, by}`, and **Follow** reopens the document at the new path.

### 9.3 Watching and attribution (M-27) [S2]

9.3.1 `smithers-machined` watches the working copy with inotify (recursive watches, re-armed on directory creation). Writes are attributed as follows (mvp.md §6.8, v2.5):
- **Writes through Smithers carry their exact author.** These are File card documents, the coding agent's write tool and app commands. Each reports `{path, digest, actor}` to the daemon before writing (§7.6), and the daemon matches the following inotify event by path and digest.
- **Other writes** (terminal tools, SSH editors, the agent's `bash`, hand-run `git`/`jj`) form bursts, attributed to the actor of the only session active on the branch during the burst. A session is active when any process in its cgroup used CPU during the burst window (`cpu.stat` `usage_usec` grew), so a shell idle at its prompt doesn't count. Sessions are the daemon's PTYs and processes: people's terminals and SSH sessions, and the agent's terminal. When more than one session is active, or none, the burst reads "changed outside Smithers" (actor `{outside: true}`).
- [D] Exact per-write kernel attribution (fanotify with writer pids) is deferred.

9.3.2 An inotify queue overflow (`IN_Q_OVERFLOW`) triggers a full jj snapshot, recorded as one burst "changed outside Smithers".

9.3.3 **Ignored paths** produce no activity. Ignored means everything `jj` ignores (`.gitignore`, `.jj/`, `.git/` internals except HEAD and refs), plus the dependency and build paths the toolchain detector names (`node_modules/`, `target/`, `.venv/`, `dist/` when gitignored). Events for ignored paths are dropped in the kernel where possible (ignore marks) and otherwise in user space.

9.3.4 **Bursts.** Events group into a burst keyed by the attributed actor (§9.3.1). A burst opens on the first event and closes after 1.5 s without events from that key, or 10 s after it opened, or when another key writes a file the burst touched. Two events leave the daemon:
- `file_written{path, actor, post_digest}`: sent within 200 ms of each write to a tracked path, so open cards reload in under 1 s (§18).
- The burst event, on close: the daemon runs a jj snapshot and sends `{burst_id, actor, files[{path, change, renamed_to?, post_digest}], snapshot_before, snapshot_after}`. The snapshot commits are pushed to the host repository store (`refs/smithers/branches/<id>/snapshots/<burst>`, coalesced), so a sleeping branch's activity and diffs never need the machine.

The host turns it into one activity entry, for example "Maya via SSH changed 12 files", which opens the diff between the two snapshots, plus one `burst_files` row per file. Open File and Diff cards whose paths changed reload. Every change is therefore recoverable from the branch's jj operation log ("recoverable from snapshots", M-27).

9.3.5 **Restore this file** (`file.restore`, in-card on an outside-change diff) writes one file back to its content at the burst's `snapshot_before` (`jj restore --from`). If the file changed again since that burst, it opens Compare instead of overwriting. The write is attributed to the person who pressed it. Each burst's end state is recoverable; states inside a burst are not guaranteed. [D] Per-entry Undo of a whole burst stays deferred.

9.3.6 [D] Command names on entries.

9.3.7 [D] Out-of-band stale-save flags ("Ben's save replaced Alice's edit · Restore"). Detection rule, for the record: let B be the content the writing session last opened, P the pre-image and W the new content. Flag when merge3(B, P, W) ≠ W and the merge has no conflict.

9.3.8 **Moved off the item.** After any burst that touches `.git/HEAD`, refs or `.jj/` operation heads, `smithers-machined` checks two conditions. The working-copy commit `@` must still descend from the branch's item change, and that change must still be present. If either fails, it emits `moved_off{by, item}`. The TODO enters `needs_you{kind: moved_off}`, and the coding agent stops writing. **Return to Tn** (`return_to_item`) runs `jj edit` back to the working-copy commit from before the move; anything written afterwards stays in its own commit and is recoverable. **Keep for now** records the move, and the TODO stays in Needs you until the working copy is back on the item. Both are in-card controls (§6.1.2). The coding agent's write tool refuses with `moved_off` while the branch is moved off. The stack keeps the item's last captured change throughout.

9.3.9 **Agent awareness.** Each change event not caused by the coding agent is appended to the coding agent's transcript as a system note before its next tool call: "Maya via SSH changed `retry.ts`, `deliver.ts`". The agent's file-write tool MUST re-read a file whose digest changed since the agent last read it before writing (`stale_read` refusal otherwise).

### 9.4 Rebase safety

9.4.1 Rebases of the branch's change (§10.5) run through `smithers-machined`, which first takes a capture. It then refuses to start while a burst is open or a document flush is pending, and holds new document writes for the rebase's duration (target under 2 s). Open documents reload from disk after the rebase as one transaction attributed to "Rebased onto #k".

---

## 10. Stack and TODO engine [S1; presence-aware rebase S2]

### 10.1 Ownership

The stack engine is a host service. It is the only writer of stack order, TODO states and the `mythical` history; `main` is never written (AGENTS.md). It reacts to commands, runtime events, `smithers-machined` events and GitHub events. Every transition goes through `todo_events` (§3.2).

### 10.2 Creation and placement

10.2.1 Doors: chat (`/todo.new`), an issue (`/todo.from-issue #n` for GitHub issue #n, drafted by the app agent from the issue thread and edited by the member before commit), and the `todo` label on GitHub applied by a member (the issue's current title and body at that event become revision 1 and the issue digest is recorded; later issue edits never change the TODO; a repeated delivery of the same label event is idempotent by `(issue, label event id)`). An issue has at most one unmerged TODO; labeling it again while one exists is a no-op. TODOs made from an issue default to `fixes_issue = true`. A label from a non-member is reverted with a comment (§17.5).

10.2.2 Placement: `append` (default), `before Tn` or `amend Tn`. Amend creates no TODO. It appends a `todo_revisions` row to Tn with reason `amend` (revision n+1, shown as "+1"; revision 1 is the original), and if Tn is working, delivers the amendment to the run as a steer.

10.2.3 Position is a dense ordering key (`stack_position`). Move up and Move down swap adjacent unmerged items, and Drop removes one. Every reorder rebases the affected later items (§10.5).

### 10.3 Parallel work

10.3.1 Up to `parallel` TODOs work at once (paused, needs_you and in_review TODOs whose machine is released don't count), each on its own branch and machine. The default is `max(1, capacity − 1)`, which leaves one machine for people and background runs. The owner may set it from 1 to 8, capped by capacity. Queued items admit in stack order.

10.3.2 Item N's work starts from item N−1's last verified head, or `main` for the first item. Its PR shows only its own change (§12.5).

### 10.4 The TODO run

10.4.1 A TODO's work is one run per attempt of the Active `todo` flow version, pinned when the TODO enters Starting (§11.4), executing on the TODO's branch machine. The run lives until the TODO is merged or dropped:

```
route → plan (cites wiki revisions) → implement → check → review (the overridable `review` flow)
      → package one commit → stack.propose ──▶ wait for a stack event:
            rebased onto a new tip        → check → stack.propose → wait
            steer / changes requested     → implement → check → review → stack.propose → wait
            merged | dropped              → end
```

`stack.propose` is a system operation: the stack engine integrates the candidate on the stack tip, opens or updates the PR, and later merges after a person's approval. None of those are flow steps, so an override can't skip them. This replaces today's four separately launched runs (`coding/request`, `coding/vibe`, `coding/verify` and `review/change`, launched at `mythical_items.go:1681`, `:1775`, `:1905` and through `mythicalReviewFlow`) with one run per attempt (T-FLW-11).

10.4.1a The built-in `todo` flow is a short composition file over step flows published from the coding package. Overriding it (§11.5) copies only that composition into `flows/todo/flow.ts`, which imports the steps it doesn't change.

10.4.2 The prompt the agent receives is revision 1, plus every later revision delivered as a steer, plus the acceptance text, plus the linked issue's discussion when the TODO came from an issue.

10.4.3 Evidence recorded per attempt: the diff stat, checks run on the machine (name, outcome, duration, log blob), the agent's review summary, GitHub checks, the token and time totals, and the flow version.

### 10.5 Rebase

10.5.1 When `main` or an earlier item publishes a new revision, every later item gets `rebase_pending{onto}`.

10.5.2 If only the coding agent is present on the branch, the rebase runs at the run's next durable boundary. If people are present, the branch shows "Rebase pending". The rebase then runs when presence drops to the agent alone, or when someone on the branch selects **Rebase now**.

10.5.3 The rebase follows §9.4. Afterwards it posts activity "Rebased onto #k", clears approvals (the head changed), and re-runs checks.

10.5.4 A conflict goes to the coding agent first. If the agent doesn't resolve it within its policy (one attempt by default), the TODO enters `needs_you{kind: conflict, paths}` with **Resolve**. In stage 1 Resolve opens the TODO card's conflict view (conflicted files, terminal and SSH line); from stage 2 it opens the Branch card. The wait settles when someone presses **Done** and the working copy has no conflict markers in those paths. An engine-raised conflict creates its own durable wait on the TODO.

10.5.5 Asleep branches rebase on the host against their captured head, without waking. A conflict wakes nothing; it becomes Needs you.

### 10.6 Merge [S1]

10.6.1 Merge is enabled for exactly the first unmerged item in stack order. Later items show "Merges after Tn". Smithers enforces the order. GitHub doesn't, because every PR is based on `main` (§12.5).

10.6.2 `POST /api/todos/{n}/merge {reviewed_head_sha}` requires a `session` credential with role owner or maintainer. It also requires `reviewed_head_sha` = the current PR head, required GitHub checks passing, and GitHub reporting the PR mergeable. The server records `todo_approvals`, then calls GitHub's merge API with `sha = reviewed_head_sha` and `merge_method = squash`, so each item is one commit on `main`. Setup refuses a repository that disallows squash merging and shows "Enable squash merging on GitHub ↗". A refusal surfaces GitHub's reason text verbatim, for example "1 approving review required on GitHub".

10.6.3 After the merge, later items rebase onto the new `main` (§10.5), and each open PR is force-updated with its new verified candidate. Its body then stops listing the merged item.

10.6.4 An out-of-order merge on GitHub happens when someone marks a later draft ready and merges it first. Because each PR is a verified candidate based on `main`, the later item's squash commit contains the earlier items' changes. The engine marks the merged item and every earlier unmerged item it contained as merged. It notes on each earlier one "T3 merged before T2; T2's change is in T3's commit" and closes each earlier item's open PR with the comment "Merged via #<n> (T3)". It then folds `main` and opens `stack_attention{kind: order}` for maintainers with that sentence, settled by **OK** (in-card). Later items rebase as after any merge.

### 10.7 Stop, resume, retry, drop, steer

10.7.1 Stop: send a durable pause signal; the run parks in a `paused` wait at its next durable boundary (an in-flight model call finishes first, ≤ 60 s), the TODO shows `paused`, and the machine is released when safe-idle. The run is not cancelled. Resume re-admits and continues the same run from its last finished step. Retry starts a new attempt of the pinned flow version; an optional steer becomes the first message.

10.7.2 Drop: confirm, cancel the run, close the PR with comment "Dropped in Smithers by @x", mark `dropped`, archive the branch, rebase later items.

10.7.2a The coding agent can ask a person mid-implementation. The `ask` tool is bound for the implementing seats (`coding/edit-atom`, `coding/dispatch-turn`), not only at flow-step boundaries. It raises `needs_you{kind: question}` as a durable wait and continues with the first answer (§10.8.2).

10.7.3 Steer: any member, or an agent acting for one. The text is delivered to the run as a durable signal. A steer to a queued TODO is held and delivered when its run starts; one to a paused TODO is delivered on resume; one to an in_review TODO moves it to working. The run's flow MUST accept steers at every step boundary, and inside the implement step between agent turns (≤ one model turn of latency). The steer appears in branch activity with its author's avatar.

### 10.8 Needs you

10.8.1 TODO kinds: `question` (the agent asked), `approval` (a flow step's human approval), `conflict` (§10.5.4), `moved_off` (§9.3.8), `foreign_push` (§12.3). Stack-level kinds, `order` (§10.6.4) and `force_push` (§12.3), live in `stack_attention` (§4.1.2a).

10.8.1a A planner that declines with questions (today's `declined` with questions) raises `needs_you{kind: question}` and waits, instead of ending the item.

10.8.2 First answer wins. Answers carry the wait id. The first committed answer settles the wait, and later submissions get `409 {answered_by}`. A late submitter's text stays in their draft with **Send as steer**.

10.8.3 Toasts go to the TODO's owner and, from stage 2, to anyone present on its branch (stage 1 has no presence). Everyone else sees it on the Home card (M-14).

---

## 11. Flows [S1]

### 11.1 Catalog

11.1.1 **System flows** are packaged with the install and never overridable: stack operations (including `stack.propose`), merge, members, settings, secrets, sync, admission, setup, `flow-load` and the summarizer (M-30). They run in the host flow runtime or as Go services exposed as commands.

11.1.2 **Overridable flows** are `todo`, `learning`, `review`, plus any repository flow at `flows/<name>/flow.ts`. Each has a built-in default version shipped with the install. A repository file of the same name, on `main`, overrides it once Active. Overridable flows always run inside a machine (§1.3).

11.1.3 Every flow is `Flow.make("<name>", {description, payload, success, error?, body, ...})` from `@smthrs/flow` (AGENTS.md "Flow layering").

### 11.2 Configuration without a commit (M-11)

The install generates and stores the configuration the default flows need in `flow_config`. Stored with it: the detected check commands (`package.json` scripts `test`/`lint`/`typecheck`/`build`; `go test ./...`; `cargo test`; `pytest`), the default wiki page declaration and model seats. All of it lives in PostgreSQL, not in the repository. A repository's own `.smithers/*` configuration, when present on `main`, takes precedence field by field. Planning needs at least one check. Today's two-check minimum (`flows/coding/planning.ts:38`) becomes one. A repository with no detected check runs a build-only check and says "no checks detected" in the PR evidence. The default wiki pages are an overview, an architecture page and one page per top-level package directory, at most 10.

### 11.3 Loading and activation

11.3.0 A flow's closure includes every overridable flow it imports, so a `todo` run's one digest also pins the `review` flow it calls (J5.4).

11.3.1 When the GitHub sync sees `main` move and the diff touches `flows/**` or `.smithers/**`, the engine admits a background `flow-load` run in an ephemeral machine at `main`'s new commit. The run loads every overridable flow, typechecks it, computes its execution digest and stores a content-addressed closure blob. It writes one `flow_versions` row per flow with status `loaded` or `failed{error}`.

11.3.2 Activation: a `loaded` version from a newer `main` commit replaces the Active one in `flow_activations`. A `failed` version leaves the previous Active version in place, and the Flow card shows "Merged · not active" with the error (§4.3).

11.3.3 The Flow card's "Proposed" version is any open TODO whose change touches `flows/<name>/`.

### 11.4 Pinning

11.4.1 A run records `(flow_name, digest)` when its TODO enters Starting. The coding host on the branch machine loads the pinned closure blob by digest. It never loads the branch working copy's `flows/` for a TODO run, so a TODO that edits a flow doesn't run its own edit.

11.4.2 Retries and resumes reuse the pinned digest. Two versions of one flow can run at once because each branch machine runs its own coding host.

11.4.3 A scratch branch may **Run** its working-copy version of a flow with a test input (J11.3). That run is labeled "draft version" and can't be a TODO run.

### 11.5 Changing the factory (J5)

`/flow.edit <name> <request>`: the app agent produces a patch against the current source of `<name>`. If no repository override exists, the patch creates `flows/<name>/flow.ts` from the built-in composition plus the change (§10.4.1a). The Flow card shows the proposed diff first (J5.2). **Make TODO** creates a TODO with that patch as its `seed_patch`. If the seed patch no longer applies when the run starts, the agent re-derives the change from the request and says so in the evidence. The TODO flow applies the seed patch in its implement step, runs checks and opens the PR. Merging and activation follow §10.6 and §11.3.

11.5b **Source** on the Flow card (`/flow.source`) opens the flow's file in the File card on the branch of the TODO that proposes the change. If none exists yet, it first creates that TODO through `/flow.edit`, with an empty seed.

### 11.5a Agent card [S1]

The Agent card shows each factory agent (planner, implementer, reviewer, app agent): its model, a link to its instructions (the flow source), and the runs it took part in. The owner picks the model from the install's model access. The choice is an owner setting stored in `flow_config` (`agent:<role>`), not a TODO, and applies to runs admitted afterwards. Three model roles are set in Settings and asked for in setup (J1):
- `fast` (Cerebras by default) for the app agent, preflight and timeline summaries;
- `coding` for the coding agent;
- `jev` through the AI Gateway for decisions.

Without a fast-model key, the app agent and summaries fall back to the coding model. The owner-only model configuration (`model.*` commands, `ModelCards.tsx`) is restored from `5b77095672` without the model laboratory (`ModelCallCard.tsx`, `controller/modelCall.ts` stay deleted). Instructions are Markdown in the repository: the TODO flow's prompts (beside its source) and `.smithers/instructions/app.md` for the app agent. The install loads them as data (never as code, §1.3) from Active `main`. They change through a TODO, and apply to work started afterwards. Tools and permissions change through the overridable flow's source. The model is an owner setting that applies immediately. [D] Editing permissions, tools and budgets is deferred.

### 11.6 Runtime events and the monitor

11.6.1 The flow runtime emits ordered events per run: step started, finished or failed (with input, output and token/time/cost usage), wait opened or settled (kind, since), attempt retried, agent transcript chunks, and steer received. The host projects them into `run:<id>`, `todo:<n>` and conversation-entry summaries.

11.6.2 The monitor reads the same events. Each step's label comes from its Appendix C row's Inspect rendering (for example "Planned the change", "Edited retry.ts"). Engine bookkeeping tags render under one collapsed "Engine" row per run. It also shows the run's raw event journal, and the flow's declared custom view (the descriptor's `presentation`) when one exists. It shows the graph with live step states, per-step input/output/transcript, timeline with attempts, durable waits with "since", tokens/time/cost per step, and a read-only replay scrubber. It has no fork or rewind control (AGENTS.md).

### 11.7 Triggers

[D] Triggers are deferred (mvp.md §16). The engine and registrar stay as they are; the MVP neither exposes nor extends them. For the record, a trigger binds a flow to a schedule or an event:
- **Schedule:** five-field cron, an IANA timezone, and the next run time shown.
- **Event:** `main` moved, an issue labeled `<label>`, or a PR opened.

Maintainers create, pause and resume triggers, and **Run now** fires one. Runs triggered on `main` by a person or a schedule are trusted for main-only secrets (§8.8.2); event triggers from non-members are not.

### 11.8 Learning (§6.12, J5.5) [S3]

11.8.1 After each merge, the engine admits a background `learning` run with input `{todo}`. The run reads that TODO's attempts, check failures, review comments and steers, and the outcomes of the last 20 merged TODOs. It writes two kinds of output:
- wiki pages recording decisions with their reasons, each citing the change link and the run ids;
- proposals, each with a title, evidence (counts, TODO refs, failure signatures), a suggested prompt and an optional seed patch to a flow.

11.8.2 A proposal becomes a TODO only by a member's **Make TODO** (an in-card control, `POST /api/proposals/{id}/accept`). Dismissed proposals are kept for 90 days so the same signature isn't proposed twice.

11.8.2a A proposal's `signature` names the failure pattern it addresses (for example `check:lint@review`). Learning runs never propose a signature that is open or was dismissed within 90 days.

11.8.3 The merged TODO's `lessons` counts the pages written plus proposals created by its learning run.

---

## 12. GitHub sync [S1]

### 12.1 The GitHub App

12.1.1 The App is created during install with GitHub's App manifest flow. The manifest's `redirect_url` is the origin the setup page is served from, whether `localhost` on the Mac or the address a LAN laptop used (§5.1.0). It's a browser redirect, so any origin the browser can reach works. Setup first asks for the repository, so it knows the owner. A user-owned repository gets an App owned by that user. An organization repository gets an App owned by the organization (`github.com/organizations/<org>/settings/apps/new`), which needs an organization owner. If the signed-in person isn't one, setup says so and shows the URL to hand to one. The browser on the owner's Mac posts the manifest to `github.com/settings/apps/new` (or the organization's equivalent). The browser redirect reaches `<setup origin>/setup/github/callback`. It is a browser redirect, not a server callback, so no public address is needed (spike within T-GH-01). The host exchanges the code (`POST /app-manifests/{code}/conversions`) and stores the App id, PEM, webhook secret and client id/secret, sealed in PostgreSQL under the install key.

12.1.2 Manifest permissions:
- contents: write
- workflows: write (agent changes may touch `.github/workflows/**`)
- pull_requests: write
- issues: write
- checks: read
- statuses: read
- administration: read (required checks in branch protection)
- metadata: read
- members: read

The webhook is created inactive (`hook_attributes.active = false`), because polling is the contract (§12.2). Callback URLs: the configured origins plus `http://localhost:4000` (§16.3.3).

12.1.3 The owner then installs the App on the one repository. The install records the installation id.

### 12.2 Polling (M-03)

| Stream | Request | Cadence | Cost/h (one repo) |
| --- | --- | --- | --- |
| refs | `git ls-remote` of `main` and `refs/heads/smithers/*` | 30 s | 0 REST |
| pulls | `GET /pulls?state=all&sort=updated&direction=desc&per_page=50`, conditional | 60 s | ≤ 60 |
| review comments | `GET /pulls/comments?sort=updated&direction=desc&since=…`, conditional | 60 s | ≤ 60 |
| conversation comments | `GET /issues/comments?since=…`, conditional | 60 s | ≤ 60 |
| reviews | `GET /pulls/{n}/reviews` only for TODO PRs whose `updated_at` changed | on change | ≤ 60 |
| checks | `GET /commits/{sha}/check-runs` + `/status` for TODO PR heads with pending or changed checks | 60 s while pending | ≤ 240 |
| issues | `GET /issues?state=all&since=…&sort=updated`, conditional | 120 s | ≤ 30 |
| issue events | `GET /issues/{n}/events` for issues whose `todo` label appeared since the last poll (who applied it, and the event id for idempotency) | on change | ≤ 1 per changed issue |
| members' permission | `GET /collaborators/{login}/permission` | hourly | ≤ 8 |

12.2.1 Every REST call is conditional (`If-None-Match` with the stored ETag). A 304 does not count against the primary rate limit. Installation tokens are cached until five minutes before expiry.

12.2.1a After a merge every open PR is force-updated, so all their checks are pending at once. Check-runs then poll every 60 s for the first item in order and every 120 s for the rest.

12.2.2 Budget: when `X-RateLimit-Remaining` falls below 20 % of the limit, cadences double until the reset. A 403 or 429 with `Retry-After` pauses that stream until `retry_at` and marks health `limited`.

12.2.3 Targets: PRs, checks and `main` within 60 s of the change on GitHub; issues within 5 min (§9 of mvp.md). Measured by check C-GH-07. Health (§4.4) uses the required streams (refs, pulls, checks) against a 60 s target. When several states hold, `refused` > `limited` > `stale` > `fresh`. Only `mirror: pull` is supported for the install's repository.

12.2.4 Webhooks are optional. When the install has a public URL (for example Tailscale Funnel), signed webhook deliveries trigger an immediate fetch of the affected stream, and the polling cadence stretches 5×. Webhook payloads are never trusted as the final state; the fetch is.

### 12.3 Inbound mapping

| GitHub change | Smithers effect |
| --- | --- |
| `main` moved (fast-forward) | Mirror updates. The home `main` row updates. Later items get `rebase_pending` (§10.5). Flow load if `flows/**` changed (§11.3). |
| `main` rewritten (not a fast-forward) | `stack_attention{kind: force_push}` for the owner. **Reset to GitHub main** (in-card) resets the mirror and rebases the stack onto the new `main`. Nothing changes before confirm. |
| Issue opened, edited or commented | The synced store updates (§3.0). The issue card updates. |
| Issue labeled `todo` by a member | TODO created (§10.2.1). Labels by non-members are reverted, with a comment. |
| Review with "changes requested", review comment or conversation comment on a TODO PR | Activity entry with the GitHub mark, attributed to the member whose GitHub login wrote it. From a member: delivered to the run as one steer per review submission (its comments batched, anchored to path:line) or per standalone comment; `in_review → working`. From a non-member: shown in activity as `{github: login}` and never delivered as a steer (§17.5). An edited comment updates its entry and is re-delivered only if the run hasn't consumed it; a deleted one hides its entry. |
| Review "approved" | Recorded on the PR card. Not a Smithers approval (§10.6). |
| Checks finished on a TODO PR head | Evidence updated. A failed required check names itself on the Merge control. |
| TODO PR merged | `merged` (§4.1). The linked issue closes with a link if `fixes_issue`. Later items rebase and their PRs are force-updated (§10.6.3). |
| TODO PR closed unmerged | `dropped` with "closed on GitHub by @x". Reopen within 7 days restores `in_review` at the TODO's previous stack position when it is still free (otherwise appended), with `smithers/<slug>` recreated from the last verified candidate. |
| Push to `smithers/<slug>` by anyone other than Smithers | `needs_you{kind: foreign_push, by, sha}`, whether the TODO is working or in review: "Alice pushed to `smithers/retry-webhooks` on GitHub", linking the commit. Smithers never overwrites a person's commit (M-33): the agent's next push is held while this is open. The answers are:
- **Bring in**: fetch the commit and rebase the item onto it at the run's next checkpoint (§9.4); the agent resolves conflicts, and the pushed change becomes part of the item's change, attributed in activity;
- **Discard**: explicit; the commit is kept in the host repository store (`refs/smithers/kept/<sha>`) and linked from activity, and the next verified push proceeds. [D] Merging such pushes into the working copy is deferred. |
| A teammate's own branch or PR | `/review` works on any PR: it admits a `background` ephemeral machine at the PR head, which counts against capacity and never holds a TODO's machine. [D] **Open on a machine** is deferred. |

### 12.4 Outbound writes

12.4.1 Every outbound write has an idempotency key, recorded in `outbound_writes` before the call: open PR (title = TODO title), update the PR body, merge, close a PR on Drop, close an issue on merge, add a label with the "Committed as Tn" comment, revert a non-member's label, comment and push. After a crash, reconciliation looks the object up on GitHub by key before repeating the write. For a PR the lookup is by head branch, and for a comment it is the marker `<!-- smithers:<key> -->`. This is the §19.2 reconcile rule for GitHub.

12.4.2 Writes are made as the App and attributed in the body ("Requested by @owner", "by @ben via Smithers").

### 12.5 Pull requests [S1]

12.5.1 A TODO's PR opens when its run reaches `in_review`. Head: `smithers/<slug>`. Base: `main`. Only the first item's PR is ready for review on GitHub; later items' PRs are opened as **drafts**. When an item merges, the next PR rebases onto the new `main`, holds only its own change and is marked ready (GraphQL `markPullRequestReadyForReview`). When an item stops being first (moved down, or an item placed before it), its PR returns to draft (`convertPullRequestToDraft`). GitHub offers draft PRs only on public repositories and on paid plans. Where drafts are unavailable, later PRs open ready, with the title prefix "[waits for Tn]" and the label `smithers:waiting`, and Smithers enforces the order. The head commit is the verified candidate for the item: `main` plus every earlier unmerged item plus this item. The body has the prompt (latest revision), acceptance, evidence (checks table, diff stat, review summary), the earlier stack items it includes ("Includes #3, #4 until they merge"), a link back and "Requested by @owner". The PR card in Smithers shows only the item's own change: the diff from the previous item's candidate to this one.

12.5.2 The branch reaches GitHub when the PR is proposed and on every later verified update (`--force-with-lease` against the recorded head).

12.5.3 [D] Stacked bases with retargeting, in-app line comments mirrored as review comments, and agent replies in review threads are deferred. In the MVP, the agent's response to a review shows as new commits and in the branch activity.

### 12.6 Health surface

`GET /api/github/sync` and the `home` topic expose `{state: fresh|stale|refused|limited, last_success_at, cause?, retry_at?}`. The client computes "synced N s ago" from `last_success_at`, so no delta is needed each second. **Retry** forces all streams now; any member may press it (`agent: run`).

---

## 13. Wiki [S1; citations and co-editing transport S3]

13.1 Storage: wiki pages and their revisions live in PostgreSQL plus the blob store. The Markdown with frontmatter is canonical, and attachments live in blobs.

13.2 Co-editing: §7.4 with the host as document owner. Backlinks and outline come from the existing navigation index.

13.3 [S2] Obsidian: the existing folder sync (`wiki_sync.obsidian`, `B/services/wiki_sync_obsidian.go`) becomes a Settings control on the install's Mac. The owner picks a folder, which the worker reads from `install_settings` instead of host config. The sync keeps bytes, frontmatter and attachments, and edits made in Obsidian import as page revisions attributed to the owner. [D] Laptop access to the vault over git stays deferred.

13.4 Planning reads the wiki through the API. It chooses pages with the same selector as the app agent's preflight (§15.1.2) restricted to wiki pages, using the TODO's prompt. A plan receipt records `{slug, revision, digest}` for every page it cited (J8.4).

13.5 Generated pages refresh after merges through the existing wiki flow, using the install-stored default declaration when the repository has none (§11.2).

---

## 14. The app [S1; Branch and File cards S2]

### 14.1 Shell and branch conversations

14.1.1 Each branch has one conversation, shared by everyone on the branch (M-08). `main`'s conversation is the team's home: it opens with the Home card (the stack) and is where most members start. A branch tree navigates between conversations, showing a branch, the branch it forked from, and its children. ⌘K opens the composer and palette in the current branch's conversation.

14.1.2 Entries are shared: prompts show their author, and cards are the same cards for everyone. Each member keeps their own scroll position, card view state (maximized, tab, filters) and last-seen entry in `member_conversation_state`. Opening a conversation restores that state.

14.1.3 There is no person-to-person chat. A prompt is always addressed to an agent. People coordinate through presence, live edits and branch activity.

14.1.4 UI-only flows (theme, open, maximize, navigate, palette, filters, input mode) affect only the screen of the person who ran them, even when that person's app agent ran them. They never write shared state.

14.1.5 Legacy per-member conversations stay readable. Each one becomes a read-only archived conversation that only its member can see, and it is listed under the branch tree's "Earlier" node. Nothing is migrated into a shared conversation (AGENTS.md: old sessions remain readable).

### 14.2 Cards are projections

Every card renders one live topic (§7.2) or a set of topics, and every card action runs one catalog command (§6.1). Cards hold no business state. The same component renders inline and maximized.

### 14.3 Card models

| Card | Topic | Model fields (all present in the projection) |
| --- | --- | --- |
| Home | `home` | `main {sha, title, last_success_at, health, cause?, retry_at?}`; `attention[]` (stack_attention for this viewer); items[] `{n, title, state, owner, place, queue?, step?, needs_you?, merge_block?, pr?, approval_cleared?, amendments, lessons}`; counts by state; merged_since_last_look (per member); machines `{in_use, capacity}`; parallel (owner only); per item also `{branch, present_count, elapsed}`; background_runs[] `{id, title, state, detail}` with Retry and Dismiss (in-card). "Last look" advances when the Home card has been on screen for 2 s |
| TODO | `todo:<n>` | Above, plus `merged_via` ("Merged · in T15's commit", §10.6.4), title, prompt revisions, acceptance, issue link, branch, flow steps with current, question + first answer, failure `{step, class, message, retryable}`, evidence per attempt, PR `{number, head, draft, draft_after ("Draft · merges after T8"), checks, reviews, included_items}`, merge control state |
| Branch | `branch:<id>` + `:activity` + `:files` | Machine `{state, wait_position?}` with in-card Sleep and Wake, item and place or "scratch", rebase_pending, moved_off, presence[] `{actor, where, watching?}`, terminals[], activity[], changed files |
| File | `branch:<id>:files` [S2]; live doc [S3] | [S2] text, last writer, reload on change, gone state, `outside` (the snapshot that Compare reads, §9.2.3). [S3] per-character authors; editors[] `{actor, line}`; saved state |
| Diff | `branch:<id>:files` | Hunks vs the previous item's candidate (§12.5.1) |
| Terminal | terminal stream + `branch:<id>` | Owner, watchers, running command, `temporary_home` (a machine-local home until the next wake, §8.7.1) |
| Flow | `flows` | Source label (built-in or `flows/<name>/flow.ts`), versions `{state: active|proposed|merged-syncing|merged-failed|previous, todo?, error?, steps[]}`; actions Source, Plan, Run, Edit; the agent of each step |
| Members / Secrets | `members` / `secrets` | Login, name, avatar, role, needs_access, suspended; secret name and scope (no Bind control in the MVP card) |
| Setup / Settings | `install` | Address `{bind, origins[]}`, per-step `{state, error?: {code, message, fix?}}`, "This Mac" (the detected host and its limits, §8.2.1), GitHub `{signed_in, app_installed, squash_allowed}`, repository, model access flags, source `{state, pct}`, machine `{state, pct}`; Settings adds capacity, parallel and the laptop-agent line `smthrs login <origin>` |
| Proposal | `proposals` | Title, evidence, refs, state |
| Review | `run:<id>` | Verdict, findings[] `{severity, path, line, text}` |
| Confirm | `confirmations` | Kind (`one_click` or `review_merge`), action, a one-line summary, subject and its revision, place in the stack, checks line |

### 14.4 Toasts

14.4.1 Notable events and anything that needs action pop as toasts with their one action: Needs you, an approval, a PR ready for review (in_review), a failure, a rebase conflict, and the merge of the viewer's own TODO. A toast goes to the people §10.8.3 names (the TODO's owner and those present on its branch) and to the prompter for their own runs. Every toast is also an entry in its conversation, and therefore a timeline line.

14.4.2 Each member can hide toasts (`member_conversation_state.toasts_hidden`, plus one global preference). Hiding never hides the entry, the edge map or the home card.

14.4.3 Background progress for a member's own commands uses the shared toast stack: 300 ms debounce, through launch and execution, settled only by the real terminal event, at most three plus "+N more". Actions are Open, Stop, Steer, Answer and Retry.

14.4.4 Live work in cards scrolled out of view shows on the left edge, top-left for above and bottom-left for below, each with its single action.

### 14.5 Conversation entries and the timeline

14.5.1 Every entry (a prompt, an answer, a card or an event) is a `conversation_entries` row in its branch's conversation. An entry without a run takes its title from its first line (prompt) or its card title, and has no summary. Entries are append-only; nobody deletes a prompt from a shared conversation. Two kinds are private to one member and carry `audience_member_id`: a Confirm card (§5.4), and a Draft card until its author commits it. Unsent composer text never leaves the author's browser. Each row has the author, title, summary, tone, state, context (§15.1.2) and a derived action.

14.5.2 **Tone** is derived deterministically: live while a run is active, attention for Needs you or In review, failed, done, quiet otherwise. **State** is the TODO state word when the entry is a TODO or its run, else null. **Action** is derived per viewer from state, `needs_you.kind` and the viewer's role, and is never stored per viewer:

| State / kind | Action |
| --- | --- |
| question or approval | Answer → `/todo.answer Tn` |
| conflict, moved_off | Resolve → `/branch Tn` |
| foreign_push, order, force_push | Review → `/todo Tn` (force_push: owner only; order: maintainers) |
| failed | Retry → `/todo.retry Tn` |
| in_review, first in order, viewer may merge | Merge → `/merge Tn` |
| otherwise | none |

14.5.3 **Summary** is one line written by the install's cheap fast model (`agent:fast`, §11.5a) from the entry's run events. It is shared by everyone who sees the entry. While at least one subscriber has the timeline on screen (the client renews a 30 s `timeline_visible_until` lease in its `view:<member>:<branch>` state) and the run is live, it is refreshed 5 s after the last event and at least every 30 s while events keep arriving. Otherwise it is written once per state change. A summarizer failure keeps the last summary. The summarizer never blocks or slows the run, and it uses no machine.

14.5.4 The timeline (desktop only) shows one line per entry with its title, summary and tone. A band marks the entries on screen, and clicking a line scrolls to it. On narrow screens each edge collapses to one pill. The timeline replaces `ChatRunTimeline`.

### 14.6 Browser notifications [S2]

When the tab is hidden, a Needs you, In review or Failed toast for that member (§14.4.1) also raises a browser notification. There is one permission ask, a toast with **Allow notifications** (`notifications.allow`, a person-only gesture, since `Notification.requestPermission()` needs one) at the member's first Needs you. A click focuses the tab and opens the card. Delivery is the live channel; no service worker, no push. The Notification API exists only in secure contexts (https or `localhost`). On a plain-HTTP origin the toast still appears and the Allow toast is not shown. The quickstart's HTTPS examples (§16.3.4) are how a team gets notifications. [D] Email and phone stay deferred (#3423).

### 14.6a Actor rendering

| Actor | Renders as |
| --- | --- |
| A person | "Ben" (avatar) |
| `via` smithers, claude-code, codex | "Ben via Smithers", "Ben via Claude Code", "Ben via Codex" (avatar with agent badge) |
| `via` ssh, terminal, cli | "Ben via SSH", "Ben's terminal", "Ben via CLI" |
| The coding agent | "Agent" (agent avatar, with the TODO when ambiguous) |
| System | "Smithers" |
| A non-member GitHub user | "@login" with the GitHub mark |

### 14.6b Copy rules

Visible copy uses product words (mvp.md §3). The conformance lint bans these internal terms in visible strings: workflow, thread, task, lane, box, workspace, mythical, sandbox, VM, seat, profile. A card body line holds at most 12 words, and explanatory sentences are not allowed (AGENTS.md MINIMAL TEXT). Check: C-UI-02.

### 14.7 Keyboard and input

Every P0 journey completes with the keyboard alone (§9 of mvp.md). Normal, Vim and dictation input are kept as built.

---

## 15. Agents [S1]

### 15.1 App agent

15.1.1 The app agent answers in a branch's conversation. Each prompt runs as a turn with a `delegated(via=smithers)` credential of the prompt's author, so "Ben via Smithers" has exactly Ben's non-person rights. Turns in one conversation run in order, one at a time per conversation. A member's `/stop` stops only their own turn, and their queued prompts stay editable until they start (the single-user prompt queue AGENTS.md keeps).

15.1.2 **Context preflight.** The conversation is not the context window. Every turn begins with a preflight step that chooses what to add to the model's context. Its inputs are the prompt, the author, the branch, the titles and summaries of the conversation's recent entries, and the branch's state. Its candidates are files, wiki pages, TODOs and runs. Its output is a list `context[] = {kind, ref, revision?, reason}` within a token budget (default 24k tokens, an owner setting). Only the selected items, the prompt and the last 3 entries' text enter the answer step. The list is stored on the answer entry, the answer shows a compact "Context" line, and Inspect shows preflight as the turn's first step. Jev picks the commands the answer may call (existing `POST /api/commands/select`). Preflight selection is a model call on the cheap fast model and is recorded like any step.

15.1.3 The app agent runs in the host's model host, outside every machine. It cannot run commands, open terminals or write files on a machine. "Run the webhook tests on retry-webhooks" becomes a request to that branch's coding agent (a steer, or a run on the branch), shown as "Ben via Smithers asked". It can call UI-only flows only on its author's own screen (§14.1.4). It cannot merge or approve. When asked to, it creates a person confirmation (§5.4) and renders the Confirm card for its author.

15.1.4 App-agent turns run entirely on the host, including command dispatch. Today's browser-side tool execution moves to the host turn runner, which calls each command through the same command→API mapping the CLI uses (§6.1). Its credential is a host-minted `delegated(via=smithers)` credential for the prompt's author, never sent to a browser. UI-only flows (§14.1.4) go to the author's own browser as instructions on the live channel. A turn therefore survives its author closing the tab and can be queued server-side. A person-only command from the agent becomes a person confirmation (§5.4), and person-only commands are absent from the agent's tool list (`agent-parity.test.ts`).

15.1.5 Agent permissions (mvp.md Appendix B legend and B.6). They apply to every delegated credential: the app agent, external agents through the CLI or skill, and terminal sessions. Each catalog row carries one of three values (§6.1.2):
- **run:** executes immediately with the person's rights. Reads, UI-only flows on the prompter's own screen, steer, answer, stop, resume, retry, rebase, fork, run a flow, wiki writes, open a terminal, and sleep or wake a machine.
- **confirm:** posts a one-click Confirm card (`person_confirmations`, kind `one_click`) to that person, and runs when they press it from their session. Commit or drop a TODO, add to stack, delete a wiki page, propose a flow or agent edit. The card's primary button is the command's verb (Drop, Commit, Add to stack, Delete page, Propose), with Cancel beside it. Other members see "Waiting for Ben", and once pressed the card becomes its receipt ("Dropped T11"). Merge also lands here, but opens the person's **Review & merge** card (kind `review_merge`) and stays maintainer-only.
- **never:** refused and absent from agent tools. Members, secrets, settings, and approvals that gate a merge.

### 15.2 Coding agent

The coding agent runs on the branch machine as `agent`, inside the pinned `todo` flow. Its model calls go through the host model proxy with its `run` credential. Provider keys never enter the machine, so the install's model access applies (provider keys, or the owner's ChatGPT subscription sign-in when enabled). Every run records the model access it used. A member's personal subscription is used only in that member's own terminal.

### 15.3 Your own agents

The Smithers skill is generated from `catalog.mvp.json` (§6.1.2). An agent that runs `smthrs` with a delegated credential has exactly the member's non-person rights.

---

## 16. Install, upgrade, backup [S1; upgrade before launch]

### 16.1 Package

16.1.0 The bundle includes the pinned guest base image as an OCI archive, so the first machine needs no registry pull. The Docker self-host image is deleted: no install path, Plue, CI consumer or published release uses it (#2481), and it can't host microVMs.

16.1.0a Release bottles for macOS arm64 are built by a macOS job added to the existing `.github/workflows/release.yml`, which already builds per-platform artifacts. No Smithers host can build macOS binaries, since machines are Linux. This is a release build, not a factory.

16.1.1 Distribution is a Homebrew tap (`brew install smithersai/tap/smithers`), which installs `smthrs` and the server bundle:
- `smithers-backend` (darwin-arm64);
- the PostgreSQL 18 bundle;
- packaged flow hosts;
- `msb` with libkrun/libkrunfw;
- the guest root filesystem image with `smithers-machined`, a linux-arm64 `smthrs` CLI and the Smithers skill (for terminal sign-in, §5.3.2);
- git and jj;
- the web app assets.

The formula ad-hoc signs binaries with `com.apple.security.hypervisor`. No Smithers account and no network service run by us is needed.

16.1.2 `smthrs host start` installs and starts a launchd daemon that runs as the installing user (`UserName` key), so the install runs before anyone logs in to the Mac. It prints the setup URLs. Installing a LaunchDaemon needs one `sudo` at `smthrs host start`; the quickstart says so. A W0 spike (T-INS-03) confirms Hypervisor.framework works from that daemon. The fallback is a launchd agent plus macOS automatic login (no sudo), documented. The choice is made before stage 1 ends. `smthrs host stop` stops it. `smthrs host status` reports the health of every process.

### 16.2 Setup (J1)

The setup card runs on whichever listener the owner opened with the setup link (§5.1.0). Steps, in order (mvp.md J1.2):
1. **Setup session:** the one-time link opens a token-backed setup session.
2. **Address:** This Mac only (loopback), or Network plus a public address (§16.3). It comes first because the GitHub App's callback URLs are registered to it.
3. **GitHub App:** created through the manifest flow (§12.1).
4. **Owner sign-in:** GitHub sign-in through the new App completes the owner claim (§5.1.0). Then the owner picks the repository and installs the App on it.
5. **Model access:** the three roles (§11.5a): a coding-model provider key, a fast-model key (Cerebras by default, optional), the AI Gateway key for Jev, and optionally a ChatGPT sign-in for coding.
6. **Squash-merge check** on the repository (§10.6.2).
7. **Mirror:** "Source ready" shows here, and questions work from this point.
8. **First machine image** ("Machine ready").

Each step is durable and resumable.

### 16.3 Reaching the install (M-28) [S1]

16.3.1 The install binds loopback by default. In Settings the owner can set a bind address and one or more public origins, for example `http://studio-mini.local:4000` or `https://smithers.example.ts.net`. Changes apply without a restart.

16.3.2 The app MUST work in a secure context (https or localhost) and an insecure one (plain HTTP on a LAN host). It therefore uses no secure-context-only browser API:
- UUIDs come from one `getRandomValues`-based helper, and `crypto.randomUUID` is banned by lint;
- the single `crypto.subtle` use is replaced;
- the clipboard falls back to `document.execCommand("copy")`;
- service workers and push are not used (notifications are deferred).

16.3.3 Cookies are `Secure` when the request's origin is https and not otherwise. CORS and WebSocket origin checks accept exactly the configured origins plus `localhost`. GitHub App callback URLs are the configured origins plus `http://localhost:4000` (§12.1.2). GitHub has no API to change an existing App's callback URLs. When the owner adds an origin later, Settings shows the one-line fix: the App settings URL and the exact URL to add.

16.3.4 HTTPS and remote access come from whatever the team puts in front, such as Tailscale serve or a reverse proxy. The quickstart documents Tailscale serve and Caddy. No code depends on either.

### 16.4 Upgrade (M-26)

`smthrs host upgrade`:
1. Refuse while a burst is open or a merge is in flight.
2. Capture every awake machine and sleep it.
3. Back up: `pg_dump` plus an APFS clone of `$STATE` (`cp -c`) into `$STATE/backups/<version>-<ts>/`.
4. Save the current bundle (the Cellar version) into the backup directory, then `brew upgrade smithers`.
5. Start and migrate, forward only. The database refuses an older binary.
6. Run the health check: every process ready, migrations at head, one machine wakes.
7. On failure, print the exact restore command.

An install made on launch day MUST upgrade to the maintainer release with no data loss (check C-REL-03).

### 16.5 Backup

`smthrs host backup` produces the same backup as upgrade step 3. `smthrs host restore <dir>` restores into a stopped install and reinstalls the saved bundle when the backup came from an upgrade. Quiesce is `POST /api/install/quiesce` (owner), which refuses while a burst is open or a merge is in flight.

---

## 17. Security model

17.1 Trust boundaries:
- the host service and packaged code are trusted;
- a machine is untrusted, since it runs repository code and agents steered by issue text;
- members are trusted with write access but not with each other's personal logins (M-18, M-29);
- GitHub content is untrusted input.

17.2 A machine holds only these credentials: its `machine` credential (branch-scoped), per-session `delegated` credentials (one member, one branch), and the `run` credential for the current run. None of them can merge, approve, change members or read secrets beyond §8.8.

17.3 The host service never executes repository code and never loads repository flows into its own process.

17.4 Provider keys and the GitHub App PEM stay on the host. The install key lives in `$STATE/config/secrets.json` (mode 0600). Sealed blobs (App PEM, client secret, provider keys) live in PostgreSQL, encrypted under that key.

17.5a A plain-HTTP public origin sends session cookies unencrypted on the network. This is a documented limitation of the team's chosen exposure, not of the install. The quickstart recommends HTTPS in front, and Settings marks an http origin with one word: "unencrypted".

17.5 Contributor trust rules are enforced from launch. An issue or PR from a non-member never starts credentialed work. Labels from non-members are reverted (mvp.md §14).

---

## 18. Performance budgets (reference host: the team's Mac mini; every artifact records the host profile, §8.2.1)

| Budget | Target (p95) | Measured by |
| --- | --- | --- |
| App agent first token (owner's default model, preflight included) | < 1.5 s | C-PERF-01 |
| Answer with cards (no machine) | < 8 s | C-PERF-01 |
| Projection delta to subscribers | < 1 s | C-PERF-02 |
| Keystroke to remote viewer (File card) | < 1 s | C-PERF-03 |
| Outside disk write to open File card | < 1 s | C-PERF-04 |
| Warm wake (asleep → awake) | < 5 s | C-PERF-05 |
| GitHub PR/checks/main freshness | < 60 s | C-GH-07 |
| Rebase with people present (hold on writes) | < 2 s | C-PERF-06 |

Each budget has a benchmark script that runs on the reference host and stores its artifact under `.artifacts/perf/<date>/`.

---

## 19. Durability and failure semantics

19.1 Killing the host service, PostgreSQL or a machine at any point re-runs no completed flow step. Every run then either resumes or shows as `interrupted` with Retry (C-DUR-01..04).

19.2 Interrupted external actions reconcile before retrying. A GitHub write is looked up by its key (§12.4.1). A model call is retried, since it has no outside effect. A shell step re-runs only when the step declares itself idempotent, and otherwise fails with "interrupted, retry?". A push is checked against the remote ref first.

19.3 No state is shown before its event exists. A command's toast stays running until the projection reports terminal.

19.4 Typed failures carry a fault class end to end (§6.2.3). Infra and capacity failures say they aren't the user's fault.

---

## 20. Observability

20.1 Structured logs with request id, actor, todo, branch and run on every line. Logs go to `$STATE/logs/`, rotated at 100 MiB × 10.

20.2 `smthrs host status` and the Settings card show process health, PostgreSQL size, disk free, machines and capacity, GitHub sync health and rate budget.

20.3 Metrics are kept in-process and exposed at `/api/install/metrics` (owner only). They cover the latencies in §18, queue depth, wake count and time, burst rate and live-channel connections.

20.4 Alpha scorecard (mvp.md §10). Computed from product tables, never from logs, at `GET /api/install/scorecard` (owner). Definitions:
- **accepted**: a TODO committed to the stack;
- **merged, dropped, failed**: TODO states (§4.1);
- **terminal edits**: bursts whose actor has `via` terminal or ssh;
- **second-member action**: an activity entry on a branch by a person other than the TODO's owner;
- **session**: one person's continuous presence on a branch for at least 2 min;
- **flow revisions**: activations (§11.3);
- **outside work**: commits that reached `main` without a TODO PR;
- **no person editing**: a merged TODO with no burst or document edit by a person;
- **measurably helps**: after a learning proposal merges, its failure signature's rate over the next 5 TODOs is lower than over the previous 5.

Install, first-answer and first-merge times come from `todo_events` and conversation entries.

---

## 21. Test strategy

| Layer | Scope | Where |
| --- | --- | --- |
| Unit | Pure rules: state machine transitions, capacity formula, placement, merge guard, permission matrix, burst grouping, catalog parity | Next to the code, `go test` / `bun test` / `cargo test` |
| Integration | Real PostgreSQL, real jj, real fanotify (in a microVM or a Linux CI runner), a fake GitHub server that speaks REST and ETags | `packages/backend/internal/...`, `crates/smithers-machined/tests` |
| End to end | Real app in a browser against a real install with microVMs and a scratch GitHub repository | `apps/app/e2e/real/` |
| Fault | Kill points across runs, merges, GitHub writes, bursts, rebases | `packages/smithers/test/faults/`, `packages/backend/...` |
| Performance | §18 budgets on the reference host | `scripts/perf/` |
| Journey | J1–J8, J10 and J11 on a fresh Mac mini, in both themes, recorded (mvp.md §12.1). The recording includes a restart mid-run, a duplicate launch, an outside save landing on a file two people are typing in, and a wiki decision edit that the next plan follows | `checks/` C-J* |

Every check in [checks/](checks/) names its layer and its automation path. Executed coverage, configured thresholds, skipped cases and platform-specific evidence are reported separately (AGENTS.md testing quality).
