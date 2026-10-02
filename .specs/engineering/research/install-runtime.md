# Install, runtime, distribution — current state (main, 2026-10-02)

## Summary
- The runtime exists: `pnpm dev` (root) -> `apps/app` `bun src/bun/serve.ts` -> `startNativeBackend` spawns the Go `smithers-backend`, which starts bundled PostgreSQL 18, migrates, serves the SPA and API on `127.0.0.1:4000`.
- No Mac package exists. `39e43c0fe4` deleted the Electrobun app build (`build-native.ts`, `electrobun.config.ts`, `NativeApp.ts`, native e2e); nothing replaced it. `apps/app/bin/`, `apps/app/postgres/` are absent, so `serve.ts` cannot find its backend, PostgreSQL, Flow hosts, git, jj, FFI lib or model host outside a hand-assembled tree.
- Loopback is enforced twice: launcher `localOrigin()` rejects any non-loopback origin, and it sets `SMITHERS_SERVER_ADDR=127.0.0.1:4000`. LAN serving needs a deliberate change to a path that `apps/app/PACKAGE.ts` lists as a security invariant.
- microVMs work and are qualified (msb 0.6.16, libkrun-based per test comments), but the native launcher's env allowlist drops `SMITHERS_WORKSPACE_ISOLATION`, `SMITHERS_MICROSANDBOX_BIN`, `SMITHERS_PLATFORM_MODEL_KEYS_FILE`, `SMITHERS_AUTH_GITHUB_*` and `SMITHERS_FEATURE_FLAGS_*`. Native mode today cannot enable microVMs, platform model keys, GitHub sign-in or the ChatGPT pool.
- Upgrade: product migrations are a forward-only ledger that refuses a newer DB; native runs `Migrate` on every start. The "one owner command" (`upgrade.sh`) exists only for the Docker image with an external DB and a version manifest; nothing exists for a Mac install. No auto pre-upgrade backup on Mac.
- Self-host auth today is one owner with username+password and a bootstrap token. No GitHub-OAuth team sign-in, no setup card; model keys are file/env, not a UI.
- Capacity: default 3 running VMs, 8192 MiB, 4 CPUs, hard refusal at cap. No queue. M-06 sizing (2 on 24 GB) is not implemented; no measured memory-per-VM data in repo.
- `distribution/README.md` "Native application" section and `docs/architecture/self-host-implementation.md` still describe the deleted package (`build:native`, native-own acceptance); they are stale.

## Inventory
| Component | Path:line | What it does today | Spec row it serves |
| --- | --- | --- | --- |
| Root dev script | `package.json:43` (`dev` -> `smithers-app run start`); `apps/app/package.json:7` (`start` = `bun src/bun/serve.ts`) | There is no root `pnpm start`; `pnpm dev` runs the headless server | 6.1 Install on a Mac |
| Headless entry | `apps/app/src/bun/serve.ts:1-45` | State dir = `$SMITHERS_LOCAL_STATE_DIR` or `~/Library/Application Support/Smithers/headless`; starts backend; prints `SMITHERS_LOCAL_ORIGIN=`; SIGINT/SIGTERM stop | 6.1 |
| State dir | `apps/app/src/bun/NativeState.ts:5-7` | darwin: `~/Library/Application Support/Smithers`; else XDG | M-26 data dir |
| Backend supervisor | `apps/app/src/bun/NativeBackendProcess.ts:290-440` | Verifies binaries (X_OK, sha256 for coding host, model host, jj-export), spawns `smithers-backend` with an allowlisted env, polls `/readyz` (1 s probe, 50 ms sleep, 30 s deadline), stop = SIGTERM then SIGKILL after 10 s | 6.1, 6.1 Restart |
| Loopback bind | `NativeBackendProcess.ts:74-90` (`localOrigin`), `:353-354` (default `http://127.0.0.1:4000`, knob `SMITHERS_OWNED_BACKEND_ORIGIN`), `:375` (`SMITHERS_SERVER_ADDR = host`) | Rejects any host except 127.0.0.1/localhost/[::1] | 6.1 "LAN" (gap) |
| Go listen address | `packages/backend/internal/config/config.go:470-471` (default `:4000`, `http://localhost:4000`), `:650-651`; `runtime_helpers.go:475` | Docker default binds all interfaces; native narrows via env | 6.1 |
| LAN CORS | `config.go:244-251` (`SMITHERS_SERVER_ALLOWED_ORIGINS`) | LAN and non-loopback origins must be listed exactly; empty = public origin only | 6.1 LAN/Tailscale |
| Env allowlist | `NativeBackendProcess.ts:62-72`, `:359-395` | Only HOME, USER, TMPDIR, locale, XDG_*, proxy vars, SSL_CERT_*; everything else dropped. Sets `SMITHERS_AUTH_MODE=selfhost`, bootstrap token, `SMITHERS_NATIVE_POSTGRES_BIN/MAJOR=18`, `SMITHERS_DATA_ROOT`, `SMITHERS_WEB_ROOT`, host/jj/git/FFI paths | 6.1, 9 Isolation |
| Bootstrap token | `NativeBackendProcess.ts:268-290`; `packages/backend/localbootstrap/bootstrap.go:24-35,100-190` | Reads/creates `<state>/config/secrets.json` (0600, version 1): bootstrap token, operator key, session secret etc. | J1 step 1-2 |
| Native compose | `packages/backend/native/native.go:20-77` | Start PostgreSQL, set `SMITHERS_DATABASE_URL`, `app.Migrate`, run app; 15 s PG stop timeout; app/PG death tears down both | 6.1 Restart |
| Bundled PostgreSQL | `packages/backend/postgres/postgres.go:286-292` | Random free port on `tcp4 127.0.0.1`, `-k ""` (no unix socket), `max_connections=60`, 30 s startup timeout, private password file, `postmaster.pid` verification | 6.1 |
| PG major guard | `postgres.go:183-200` | Data dir `PG_VERSION` != 18 -> "explicit upgrade required"; nonempty dir without PG_VERSION preserved | M-26 |
| PG bundle | `apps/app/scripts/bundle-postgres.ts` (bundle.json v1, tools postgres/initdb/pg_isready/psql/pg_dump/pg_restore) | Copies a PG18 install (`SMITHERS_POSTGRES_BUNDLE_DIR`) into the package. Still present, no caller | 6.1 package |
| Git/jj bundle check | `apps/app/scripts/validate-git-bundle.ts` | Validates relocatable git; no producer left | 6.1 package |
| Backend entry | `apps/backend/main.go:38-190` | `migrate`, operator, `microvm doctor`, `credits`, `keys` subcommands; native branch at `:169`; external DB branch requires bootstrap token (`:212`) | 6.1, M-26 |
| Migrations | `packages/backend/db/product/migrate.go:25` (`ErrUnsupportedVersion`), `:235-290`; 103 SQL files under `db/product/migrations` (last `0103_retire_chat_provider_dispatch.sql`) | Ledger rejects changed SQL and older binary on newer DB; advisory lock; 5 s lock timeout, 5 attempts, backoff 1 s doubling | M-26 |
| Docker distribution | `distribution/Dockerfile`, `entrypoint.sh`, `version.env` (`1.0.0-rc.1`, schema 3, PG 18), `README.md` | One app container + external PG 18, port 4000 | web-selfhost (not the MVP Mac path) |
| Backup/restore/upgrade | `distribution/backup.sh`, `restore.sh`, `upgrade.sh`, `lib.sh:76-93` | Docker only: `pg_dump` + `files.tar` + MANIFEST; `upgrade.sh BACKUP` checks backup matches state, refuses PG major change and schema downgrade, writes `.upgrade-incomplete` marker, runs `migrate apply`, writes `<data>/version.env` | M-26 (Docker only) |
| Upgrade recovery doc | `packages/backend/docs/upgrade-recovery.md` | Restore pre-upgrade backup into clean DB+volume | M-26 |
| Native backup (manual) | `distribution/README.md:121` | Quit app, copy `~/Library/Application Support/Smithers` | M-26 |
| MicroVM runtime | `packages/backend/microsandbox/runtime.go`, `cli.go:19` (`RequiredVersion = "0.6.16"`), `layers.go`, `guest/smithers-guest.py`, `README.md` | One `msb` microVM per workspace; guest helper; egress relay; APFS-clone layers | 9 Isolation, 6.7 |
| Isolation switch | `apps/backend/isolation.go:90-97,100-190` | `SMITHERS_WORKSPACE_ISOLATION=process\|microvm`; microvm refuses to start without msb, helper, fixed port; no fallback | 9 Isolation |
| VM defaults | `microsandbox/runtime.go:57,225-240`; `isolation.go:170-186` | Image `node@sha256:71fed097...`; 4 CPUs (README), 8192 MiB, 32768 MiB disk, `MaxRunningVMs` 3, cmd timeout 60 min | M-06, 6.7 |
| Running cap | `runtime.go:533-541` | Error "microVM capacity reached ... stop one first" | 6.7 Capacity (Missing) |
| Egress relay | `isolation.go:50-100`; `SMITHERS_EGRESS_RELAY_PORT` default backend+1 | Loopback relay; guests reach host only on backend port and relay port | 9 Isolation |
| Platform model keys | `distribution/README.md` "Platform model keys"; `modelproxy/keys.go:173` (`SMITHERS_PLATFORM_MODEL_KEYS_FILE`); `apps/backend/main.go:232-240` | JSON file provider->key (anthropic, openai, cerebras, openrouter, vercel); must be 0600; Vercel key = AI Gateway key for Jev; `AI_GATEWAY_API_KEY` env rejected when keys file set | J1 step 2 model access |
| Jev wiring | `apps/backend/main.go:138-151` | Recommender uses keys-file `vercel` or `AI_GATEWAY_API_KEY`; endpoint `/v4/ai/evaluation-model` | J1, 6.5 |
| Owner model credentials | `packages/backend/modelhost/owner_secrets.go`, `apps/app/src/bun/ModelCredentials.ts:21` | Owner secrets in DB sealed with operator key; macOS keychain vault is read-only ("app no longer enrolls keys") | J1 |
| ChatGPT pool flag | `config.go:172-182`; `router.go:174,613,1554`; README "Subscription connections" | `SMITHERS_FEATURE_FLAGS_SUBSCRIPTION_CONNECTIONS=true` enables per-user ChatGPT connections; Claude subscription never stored | J1 optional ChatGPT |
| Owner auth | `packages/backend/internal/config/auth_mode.go`; `services/local_identity.go:120-230`; `apps/app/src/mainview/LocalAuthPanel.tsx` | Single owner: username+password, bootstrap token required until owner exists | 6.2 (#1667) |
| GitHub OAuth config | `config.go:685-688` (`SMITHERS_AUTH_GITHUB_CLIENT_ID/SECRET/REDIRECT_URL`), `:716` (`SMITHERS_WEBHOOK_GITHUB_APP_SECRET`); `routes/repo_connection.go` (GitHub App status) | Env-only; no in-app setup | 6.2, 6.3, J1 step 2 |
| Setup UI | `apps/app/src/mainview/flows/entries/setup.ts` | "Repository setup" = per-job configuration (issues, review, ci, chores). Not the J1 install card | J1 (Missing) |
| SSH | `config.go:506` default `:2222` | Git/SSH server default addr; whether native enables it is unverified | 6.15 SSH |
| Release CI | `.github/workflows/release.yml:49-56` | Builds only `smithers-jj-export` per platform; no macOS app job (comment at `:520` still says "macOS job gates the native pair") | 12.5 |

## Gaps vs mvp.md
| Spec ref | Missing | Where the change goes | Size |
| --- | --- | --- | --- |
| 6.1 / 12.5 installable Mac package | A producer for the tree `NativeBackendProcess` expects: `bin/smithers-backend` (darwin arm64 Go build), `flow-hosts.json` + coding host + `node` + `smithers-model-host` (+ `.sha256`), `jj`, `git` + `libexec/git-core` + templates, `libsmithers_ffi.dylib`, `bin/linux-arm64/smithers-jj-export`, `postgres/` bundle, SPA `dist/`. `bundle-postgres.ts`, `validate-git-bundle.ts`, `flow-host-manifest.mjs` survive; the assembler and signing/notarization do not | New build target under `apps/app` or a new `apps/install` (a `pkg`/tarball plus launchd plist or a `smithers` launcher); reuse `distribution/build-cli.mjs` pieces | L |
| 6.1 "no Smithers account" / 12.5 | Public artifact host and install command (curl script, Homebrew tap, or signed pkg). #2481 (ghcr image) and #2845 (signed installer archives) are the nearest issues | release workflow + `distribution/install-cli.mjs` | M |
| 6.1 LAN or Tailscale | Launcher rejects non-loopback (`NativeBackendProcess.ts:74`); `SMITHERS_PUBLIC_URL` and `SMITHERS_SERVER_ALLOWED_ORIGINS` must name the LAN/Tailscale origin; `PACKAGE.ts:259-266` lists non-loopback origin as a defect to catch | Add an explicit owner setting (bind addr + public origin + allowed origins) passed through the launcher; keep session auth; update the `backend-child-env` security entry and tests in `NativeBackendProcess.test.ts` | M |
| 9 Isolation / 6.7 microVM on Mac | Launcher drops `SMITHERS_WORKSPACE_ISOLATION`, `SMITHERS_MICROSANDBOX_BIN`, `SMITHERS_MICROVM_*` | Add to launcher env (set from owner config, not shell). Bundle or pin `msb` 0.6.16 (today npm global install, README `microvm`) | M |
| J1 setup card (GitHub, repo, model access) | No single card; GitHub OAuth/App, keys-file, Gateway key and flag are env/file only and not passable through the launcher | New setup flow writing owner config + sealed secrets; backend endpoints to set platform keys without file edits; launcher reads owner config | L |
| 6.2 team sign-in (M-17) | Single-owner password model (`IsSingleOwner`, `BootstrapSelfHostOwner` singleton) | Identity service: GitHub sign-in in selfhost mode, members from repo write access; supersedes #1667 single-owner | L |
| M-06 capacity | Static cap 3 x 8 GiB regardless of host RAM; no queue; refusal error at `runtime.go:538` | Derive `MaxRunningVMs`/memory from host RAM (2 x 8 GiB at 24 GB, 3 at >=32 GB); queue in admission (6.7) | M (cap) / L (queue) |
| M-26 upgrade in place | No Mac owner command. Docker `upgrade.sh` needs external DB, a manifest and a backup arg; native has no version manifest, no pre-upgrade backup of PG data, and migrates on start without a stop-and-snapshot | `smithers-backend upgrade` (or launcher subcommand): quiesce, `pg_dump` + copy of state dir to `<state>/backups/<ts>`, swap binaries, migrate, write manifest, rollback instructions; reuse `lib.sh` checks | M |
| M-26 version check | Schema newer-than-binary refusal exists (`ErrUnsupportedVersion`); native has no check for PG major beyond `PG_VERSION`, no state `version.env` | Write `version.env` at native first boot; check on start | S |
| 6.1 Restart | Engine replay built; no Mac restart receipt through J1 | e2e test: kill backend mid-run, restart, assert no re-run | M |
| Docs | README "Native application" and `self-host-implementation.md` native rows describe deleted `build:native` and native-own | Update both in the same change (AGENTS.md rule); run docs gates | S |

## Existing tests
| Path | Proves |
| --- | --- |
| `apps/app/src/bun/NativeBackendProcess.test.ts`, `NativeBackendConfig.test.ts`, `NativeState.test.ts`, `ServeEntrypoint.test.ts` | Supervisor with fake spawn/fetch: env allowlist, checksum refusal, loopback-only origin, readiness timeout, stop escalation, state dir |
| `packages/backend/postgres/postgres_test.go` | Real PG: `TestRealLifecyclePersistsAndRefusesUpgrade` (data survives, major mismatch refused), credential recovery refusals, crash observable, orphan recovery after supervisor SIGKILL, partial data preserved |
| `packages/backend/localbootstrap/*_test.go` | secrets.json creation, operator-key rotation, credential restore |
| `apps/backend/main_test.go`, `isolation_test.go`, `shutdown_test.go` | External DB URL, bootstrap-token requirement, platform keys file, isolation mode validation, microvm refuses without msb/helper, stable relay port, clean shutdown |
| `distribution/distribution_test.go`, `upgrade_recovery_test.go`, `test-image.sh` | Image contract, backup/restore of durable classes, link-escape refusal, failed upgrade leaves marker, real PG backup/restore |
| `packages/backend/microsandbox/*_test.go` (unit) and `real_vm_test.go`, `real_layers_test.go` (need `SMITHERS_MICROSANDBOX_BIN`) | Workspace conformance, guest facts, cancellation, services/preview/restart, terminal and managed host, lost machine refuses without host fallback, layers |
| `apps/app/scripts/mode-matrix/local-own.ts`, `docker-web-selfhost.ts` | Local-own and web-selfhost mode matrix; native modes were deleted |

No test covers: Mac package install, upgrade of a native install across versions, LAN origin, or 3 concurrent VMs against a 24 GB host.

## Configured/measured numbers
| Item | Value | Source |
| --- | --- | --- |
| Backend address | `127.0.0.1:4000` (native); `:4000` all interfaces (Docker/default) | `NativeBackendProcess.ts:354`; `config.go:470` |
| Public URL default | `http://127.0.0.1:<port>`; config default `http://localhost:4000` | `bootstrap.go:200`; `config.go:471` |
| Egress relay port | backend port + 1 (4001) unless `SMITHERS_EGRESS_RELAY_PORT` | `isolation.go` `egressRelayPort` |
| PostgreSQL | `127.0.0.1`, random port, no unix socket, `max_connections=60`, major 18 | `postgres.go:286-292` |
| Timeouts | backend ready 30 s; probe 1 s; SIGTERM->SIGKILL 10 s; PG startup 30 s; PG stop 15 s (native) / 5 s | `NativeBackendProcess.ts`; `postgres.go:26`; `native.go:75` |
| Migration lock | 5 s lock timeout, 5 attempts, 1 s doubling backoff | `migrate.go:239-242` |
| VM per-instance | 4 CPUs, 8192 MiB RAM, 32768 MiB disk | README microVM; `runtime.go:225-230` |
| VM cap | 3 running | `runtime.go:235` |
| Layer budget / free floor | 48 GiB / 40 GiB | README; `isolation.go:185-186` |
| Disk reclaim | stopped workspace disk reclaimed after 24 h | README |
| Boot | "first workspace a few minutes; later about two seconds" (documented, no receipt in repo) | README |
| msb | pinned 0.6.16; local `msb --version` prints 0.6.16 | `cli.go:19` |
| Backup | none automatic on Mac | n/a |
| Measured: 3 x 8 GiB on 24 GB / 32 GB host | none found. #3365 asks for a 24/48/72-agent x 1-4/VM measurement | #3365 |

## Related GitHub issues
| # | Status (open unless noted) |
| --- | --- |
| #1667 | Architecture 12/17: one-machine distribution with backup and recovery. Open, `sweep:no-change` (triage 2026-10-02: needs evidence); last sweep claim failed on a network error 2026-10-01. Brief is single-owner Docker; spec M-17 supersedes its single-owner model |
| #1655 | Epic: one open-source Smithers app, Plue as its deployment. Open |
| #1668 | Architecture 16/17: release gate on clean-room self-hosting. Open |
| #1666 | Architecture 11/17: one deployment-neutral API for app and CLI. Open |
| #2481 | ghcr.io/smithersai/smithers image is not published; README pull fails; Distribution workflow red. Open |
| #2845 | Publish signed installer archives from the npm CLI. Open, severity high |
| #1839 / #1735 | Release 1.0.0-rc.1 epic / dry run on green main. Open |
| #3071 | Main CI: 9 of 14 ci.yml jobs red. Open |
| #3282, #1969 | Native app relaunch / cold launch by deep link. Open, `do-not-implement` (native cut) |
| #3252 | Microsandbox runtime follows guest links in `/.msb` share (security). Open |
| #3111 | Box with stale workspace helper loops on provision instead of refreshing. Open (relevant to upgrade of the guest helper) |
| #2274 | Prove ChatGPT account-pool calls from a microVM coding host. Open |
| #2802 | Main sandbox + up to 128 cloned children. Open (Cloud direction, not Mac) |
| #3365 / #3410 / #3328 / #3417 | Local issue-sweep microVM: agentsPerVm and 24/48/72 matrix; qualification smoke + 2 h run (in progress); park bug (in progress); git index lock recovery (in progress). These are the only local-microVM measurements planned |
| #2130 | Workspace commands past the 30 s request timeout. Open |
| #2099 | Flow: PostgreSQL journals for backend-run orgs. Open |
| #3400 | Cloud coding image Bun 1.3.9 cannot validate repo requiring Bun >=1.4.0. Open |
| #3382 | Shared workspace bases. `do-not-implement` |
| #3385 | MVP cut that removed the Mac package (commit `39e43c0fe4`) |

## Risks and unknowns
1. Claim: `pnpm dev` fails on a clean checkout because `apps/app/bin/smithers-backend` and `apps/app/postgres/` do not exist. Confirm: run it in a fresh clone (not executed here; read-only task). Inferred from the `fromDir/../bin` default at `NativeBackendProcess.ts:313-318` and `ls apps/app`.
2. Claim: the native launcher cannot enable microVMs today. Confirm: set `SMITHERS_WORKSPACE_ISOLATION=microvm` in the shell, run `pnpm dev`, check the logged `owned backend env:` names; the variable is absent from `LAUNCHER_PASSTHROUGH` and from the set block.
3. Claim: loopback-only is enforced at the launcher, not only in Go config. Confirm: `SMITHERS_OWNED_BACKEND_ORIGIN=http://192.168.1.5:4000` throws "must be an absolute loopback HTTP origin" (`NativeBackendProcess.test.ts` should assert it).
4. Claim: three 8 GiB VMs on a 24 GB Mac degrade the host (M-06 rationale). No measurement in repo. Confirm: #3365's matrix with host load, memory and swap recorded, or a 3-VM run on a 24 GB Mac mini.
5. Claim: a native upgrade across a schema change loses nothing because migrations are forward-only, but a failed migration leaves PG data half-migrated with no automatic snapshot. Confirm: run a native install on version N, install N+1 with a failing migration, observe state; `native.go:23-27` migrates before serving with no backup step.
6. Claim: "KVM/Mac microVM" uses libkrun with Hypervisor.framework. Evidence is indirect: test comments cite `hv_vm_create` refusal reported by libkrun (`RealMicrosandbox.integration.test.ts:48-59`) and `libkrunfw` beside `msb` (`flows/issue-sweep/vm.ts:54`). Confirm: `msb doctor` output or Microsandbox 0.6.16 docs.
7. Claim: SSH git server may bind `:2222` on all interfaces in native mode. Unverified: `config.go:506` default is `:2222`; the launcher sets only `SMITHERS_SERVER_ADDR`. Confirm: `lsof -iTCP -sTCP:LISTEN` while a native backend runs.
8. Claim: M-26's "one owner command" cannot reuse `upgrade.sh` as is, since it requires `smithers_pg_url` from `DATABASE_URL`, a Docker data root at `/var/lib/smithers` and a `version.env` the native path never writes. Confirm: read `distribution/lib.sh:load_database_url` and run `upgrade.sh` against a native state dir.
9. Claim: the model-key path for a Mac install has no UI. `ModelCredentials.ts` says the app no longer enrolls keys; platform keys need a 0600 JSON file plus env. Confirm: search `apps/app/src/mainview` for a keys form (none found).
10. Claim: the Docker image and a Mac package would drift into two implementations, which AGENTS.md "zero tech debt" forbids. Decision needed on whether the Docker `upgrade.sh`/`backup.sh` path remains in the MVP or is replaced by the Mac command.
