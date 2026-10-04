---
title: "CLI reference"
description: "Target execution, durable flow control, operator commands, and compatibility spellings."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/docs/reference/cli/README.md"
---

## Canonical commands

`smithers` (`smthrs` is the same executable) combines backend commands, the target graph and durable control plane. A **target** is a
`PACKAGE.ts` declaration, a **flow** is a durable program built with
`Flow.make`, and a **run** is a persisted execution of a flow. `run` executes
run-kind targets; `flow start` starts durable flows.

| Command | Purpose |
| --- | --- |
| `build/test/lint/docs/review/ci/run <patterns...>` | Execute the union of the selected target kinds; `ci` combines build, test, lint, and docs. |
| `target <labels...>` or `//package:target` | Execute exact declarations using their own kinds. |
| `targets [pattern]` | List target labels and summaries. |
| `show target <label>`, `show workspace`, `info` | Inspect inputs, outputs, dependencies, toolchains, and configuration. |
| `query <expression>`, `graph [pattern]`, `owners <paths...>` | Query dependencies and ownership or render a target graph. |
| `affected <verb> [patterns...]` | Select changed targets and dependents; `--list` previews selection. |
| `watch <verb> [patterns...]` | Replan and rerun after workspace changes; `--once` runs one cycle. |
| `explain <label>` | Show the planned key and local cache state without running the target. |
| `flow list/show/plan/start/execute` | Discover flows, compile plans, start flows, or execute approved payloads. |
| `runs list/show/logs/output/cancel/cancel-all/resume/signal/steer` | Inspect and operate durable runs. |
| `runs inspect/replay/fork/rewind` | Read frames, branch history, or restore an earlier frame. |
| `approvals list/approve/deny` | List pending decisions and submit the exact approval payload or `@file`. |
| `init [name]`, `generate app/flow/package/ci` | Initialize a workspace or scaffold a declared resource. |
| `install`, `git-hooks [--write]` | Use the declared installation toolchain and Git hooks. |
| `cache status/prune/clear`, `clean [patterns...]`, `gc` | Maintain action results, declared cleanup targets, or terminal run history. |
| `environment add/list/view/remove/exec/shell/forward` | Save an execution location and run commands there. |
| `memory`, `credentials`, `triggers`, `integrations`, `eval` | Operate the persistent agent features described below. |
| `open [dir]`, `.` | Open the checkout's `owner/repo` in the Smithers app (`smithers://open/<owner>/<repo>`), the dev build inside a smithers checkout whose remote is on github.com or smithers.sh, or print its smithers.sh page. |
| `host start [--bundle <dir>]`, `host stop`, `host status` | Run a verified server bundle as an unprivileged macOS LaunchAgent, stop it, or inspect its health. |
| `serve`, `doctor`, `suggest`, `migrate`, `update`, `bug` | Host, diagnose, discover uses, migrate source, check versions, or submit a report. |
| `token mint` | Mint a scoped, expiring gateway token under `SMITHERS_TOKEN`. |

Target patterns include `//...`, `//package/...`, and `//package:target`.
Execution supports `--plan`, `--jobs`, and `--no-cache`. `affected` compares
`--base HEAD` to the working tree by default, including untracked files; use
`--head` or `--files` for explicit inputs. Changes to ambient configuration
conservatively select more work.

For scripts, target commands and `generate ci/package` document `--workspace`
in their schemas but the executable also accepts `--root` as an alias;
flow and operator commands use `--root`. Flow control, ordinary run management, and approvals select a host from
`SMITHERS_REMOTE` or `--remote` and authenticate with the saved login or `SMITHERS_TOKEN`.
The saved `smithers auth login` session is shared with repository commands; `SMITHERS_TOKEN` is the non-interactive override.
History, memory, triggers, credentials,
integrations, evaluations, and local maintenance reject remote access.

## Backend commands

Set `SMITHERS_API_ORIGIN` or run `smithers config set api_origin https://your-api-host`,
then `smithers auth login`. One saved login serves backend commands and remote
control-plane commands on that origin. `SMITHERS_TOKEN` overrides the saved login
for automation. `SMITHERS_TOKEN_FILE` reads a token from a fixed file path after
`SMITHERS_TOKEN` and before saved credentials. Missing or invalid files refuse
the command. A 401 clears only that file resolution; the next explicit command
rereads it without replaying the failed request. Managed terminal sign-in remains
unavailable pending issuer and security validation. Login reads the existing OS keyring, `~/.config/smithers/auth.json`,
and legacy config token; a new login removes the legacy token. Login and token
status never print credentials. Local owner installations use `auth local bootstrap`
and `auth local login`; `auth connect claude --api-key` connects an Anthropic
API key. Vendor subscriptions stay with their own CLIs. Sign into Codex on the
workspace with `codex login --device-auth`; `auth connect codex` refuses token
transfer.

| Commands | Backend behavior |
| --- | --- |
| `issue create/list/view/edit/close/reopen/comment` | Issues, cursor pagination (`--all`), additive labels and assignees. |
| `history show/watch/retry/todo/backfill/bootstrap/parallel` | The repository history: each issue's checks, lane (running time, account, seat, box), spend and pull request. `todo <title>` files a TODO for the factory; `watch <issue>` follows one issue until its pull request is open or it stops. |
| `wiki list/search/view/create/edit/delete/revisions/index/history` | Wiki pages, public/private selection and revision checks. |
| `repo create/list/view/clone/edit/archive/unarchive/delete` | Repository administration and cloning. |
| `repo home [OWNER/REPO]` | List remote homepage blocks in server order with the saved login. |
| `repo connect/disconnect/status/mirror-sync/push` | GitHub connection and lease-protected personal refs. |
| `workspace create/list/view/delete/fork/snapshots/watch/ssh/shell/exec/cp/issue` | Boxes, terminal sessions, durable API commands, file copies and issue runs. |
| `flow list/start --cloud`, `flow dispatch` | Repository flows; use `--repo OWNER/REPO` to select the repository. |
| `runs list/show/rerun/cancel/logs/watch --cloud` | Backend runs. `watch` waits for the real terminal result. |
| `change status/list/show/diff/files/conflicts`, `bookmark list/create/delete` | Local jj changes and bookmarks. |
| `land create/list/view/edit/review/comment/checks/conflicts/land` | Landing requests with commit-bound review and merge gates. |
| `stack submit/unsubmit/status/sync/land` | Linked GitHub requests, review and CI gates, and ordered landing. |
| `search repos/issues/code/users`, `label`, `notification` | Search, repository labels and notifications. |
| `secret`, `variable`, `ssh-key`, `org`, `webhook`, `extension linear`, `artifact` | Backend resources and integrations. |
| `cache cloud list/stats/clear`, `cache connect`, `cache token` | Backend caches. `cache status/prune/clear` retains local target-cache behavior. |
| `agent ask`, `agent session list/view/run/chat` | Cached documentation and backend conversations. |
| `admin` | Existing administrative APIs; destructive commands require confirmation or `--yes`. |
| `api <path>`, `config`, `completion bash/zsh/fish` | Raw API calls, configuration and completion scripts. |

`--repo OWNER/REPO` (or `-R`) also selects the backend for overlapping `flow` and
`runs` commands. Without `--repo` or `--cloud`, their existing local/control-plane
behavior remains. Backend commands detect the repository from git or jj when
`--repo` is omitted. Use `--json` for structured output and `--help` or `--schema`
for each command's complete arguments.

`smthrs repo home OWNER/REPO` reads the remote homepage on `main`. Omit the
argument to detect the repository as `repo view` does, or use `--repo OWNER/REPO`.
It prints each block's type and title/name in server order; `--json` preserves the
server response. Backend errors (including 400, 401, and 404) print the backend
message and exit non-zero. Local `smthrs ls` reads apps from the checkout's
`.smithers/home.json`; it does not request the remote homepage.

The Go executable is removed. Its `status` is now `change status`, `run view` is
`runs show --cloud`, other `run` operations are under `runs --cloud`, and
`workflow run` is `flow start --cloud`. `workflow watch` is `runs watch --cloud`.

## Execution environments

Save a persistent location, then run ordinary commands there:

```bash
smthrs environment add dev --ssh developer@my-machine --directory /home/developer/workspace
smthrs environment exec dev --terminal -- codex login --device-auth
smthrs environment exec dev --terminal -- claude
smthrs environment exec dev -- smthrs flow start review
smthrs tui --environment dev
```

The tool's native login stays in the execution machine's home. CLI commands and the
TUI run the installed Smithers runtime there, using the same agents and sessions.
The machine needs the commands you invoke installed on its PATH. SSH uses your SSH
configuration and requires a known host key. Profiles select existing compute;
Cloud allocation and admission limits still apply.

Use `--local` for this machine, or `--workspace OWNER/REPO/ID` for an existing Cloud
workspace with the saved Smithers login. `--directory` is an absolute path on the
execution machine. `--home` optionally selects its persistent home. The registry is
`$XDG_CONFIG_HOME/smithers/environments.json`, defaulting to
`~/.config/smithers/environments.json`; it stores location settings only. Removing a
profile forgets the reference and does not delete compute or files.

```bash
smthrs environment shell dev
smthrs environment forward dev --local-port 1455 --remote-port 1455
```

Forwarding supports SSH profiles and binds loopback on both machines. Keep it
running while an application uses a local browser callback. Cloud workspace
profiles require the application's device or pasted-code login flow. `exec` preserves every argument after `--`; flags
before it belong to Smithers. It inherits terminal I/O and returns the command's
exit status. A disconnected SSH command fails; it has no durable execution receipt.
Use the existing flow and run commands for durable work.

## Pending human waits

`approvals list` includes roots whose execution tree is waiting for human input.
Each row carries `runId`, `flowId`, and, when available, `question` and `approval`.
`question` falls back to the prompt declared by a nested `HumanTask` when the
journal has no question. The optional `waits` array identifies each holding
execution by `runId`, with optional `flowId`, `name`, `attempt`, and `request`.

Answer a human task by signaling the listed root with the wait's name:

```bash
smthrs runs signal run-3 '{"name":"coding-clarification","payload":"the scheduler owns it"}'
```

The control plane routes the answer to the matching nested wait. Use the
declared request's kind, options, and schema to shape the answer.

## Operator commands

| Group | Commands and behavior |
| --- | --- |
| `memory` | `list/get/set/rm`, `recall`, `notes list/get/add/status/supersede`, `threads list/create/show/rm`, `messages list/add`, and `compact`. |
| `credentials` | `list/add/rotate/revoke`; encrypted secrets are supplied through `--secret-env` or `--secret-file`, and output contains references only. |
| `triggers` | `list/show/register/enable/disable/fire/serve`; registration accepts flags or `--file`, and `fire` queues an occurrence for the scheduler. |
| `integrations` | `list` and `doctor [--offline]`. |
| `eval` | `list/run/baseline/compare`; discover `evals/**/*.eval.ts` modules exporting `suite` and `executor`, and compare saved results with committed baselines. `run` also records score observations in the project's `.flows/engine.db` when it exists. |

Memory defaults to `--namespace user:cli` and accepts `kind:id` or a bare kind
with `--id`. Bare `memory` prints help. Missing fact arguments, such as
`memory get` without a key, return Incur validation errors (exit 1) without
opening the store. Invalid namespace identities are also rejected before
opening the store. Facts automatically decode valid JSON. Recall supports
`--method keyword` and `--method fts`; FTS is enabled for the requested
namespaces. Semantic recall remains a library binding that needs a configured
embedding provider. `compact` takes an explicit `--summary`, `--before`
timestamp, and retained-message count (`--keep`); `--dry-run` previews it.

Credential encryption requires `SMITHERS_CREDENTIAL_KEY`, a base64-encoded
32-byte host key. Keep that key outside the database. Integrations read
`.smithers/integrations.json` (version 1 with an `integrations` array), or
discover configured provider environment variables; each entry names an `id`,
`provider`, and optional `tokenEnv` or `credentialId`. Workspace configuration
selects among host-authorized pairings rather than creating them: an entry may
name only its provider's own credential variables plus any listed in
`SMITHERS_INTEGRATION_TOKEN_ENV`, and only its provider's public API origin plus
the one named by `SMITHERS_GITHUB_API_BASE_URL`, `SMITHERS_LINEAR_API_BASE_URL`,
or `SMITHERS_TELEGRAM_API_BASE_URL`.

`serve` (also available as `gateway`) hosts the trigger scheduler; `triggers serve` runs it separately.
Scheduled and manual occurrences preserve approval requirements. Disabling a
trigger stops future dispatch without cancelling its active run.
`triggers show <id>` exposes the persisted `activePlan.plan.approval` payload;
submit that unchanged to `approvals approve '<payload>' --scope run`. The
scheduler retains the same plan across restarts and waits until it is approved
or denied. Both `approvals approve` and `approve` default to `--scope run`.
`approvals list` lists in-run requests, not these pre-run plans.
A launch attempt persists `launching` before calling Control. Cancellation
before the run ID is recorded remains `cancelling` while the scheduler
reconciles the durable launch key. Any accepted run is recorded and cancelled.
Recovery retries interrupted cancellation. An unresolved cancellation reports
an error so the scheduler retains the active handle for recovery. Cancelling
a waiting plan prevents its launch.

## Telemetry

With `OTEL_EXPORTER_OTLP_ENDPOINT` set, every `smthrs` process and `serve`
export traces, logs and metrics over OTLP/HTTP to that collector as service
`smthrs`, sending `OTEL_EXPORTER_OTLP_HEADERS` (comma-separated `key=value`,
percent-encoded values) with each request. Without an endpoint nothing is
exported. Spans follow the OpenTelemetry GenAI conventions: `invoke_agent`,
`chat <model>` and `execute_tool <flow>` under a `smithers.run` root carrying
`smithers.run_id`, `smithers.flow` and `gen_ai.conversation.id`. Every
attempt of a run shares one trace id, derived from the run id; `status <run>`
prints it as `Trace`.

## History and stored state

Control, memory, credentials, and triggers share `.flows/control.db`.
Execution history is in `.flows/engine.db`; `runs inspect/replay` read it
without executing actions. `runs list/count/show/logs` and `approvals list` never
create these stores: in a project without them they answer empty or unknown.
They open existing stores read-only, on SQLite or PostgreSQL: they migrate
nothing, start no recovery, and answer while another process is writing. `runs fork <run> --at <sequence>` requires an
eligible parked/terminal agent run, its approved plan, and `jj`, and retains
an isolated workspace under `.flows/forks/`. Resume the returned child run
with `runs resume`. `--step <digest> --result <json|@file>` edits one recorded
step result on the child: it replays the edited value and runs every step after
the frame again, while the parent keeps its own result.
SQLite read-only statements wait at most one second for a peer lock before failing; observing opens do not migrate or acquire a writer lock.

`runs show` reports confirmed lease lapses in `warnings`, with the execution,
unconfirmed duration, and recorded time. A `lease-reconfirmed` warning keeps
the run’s recorded status; only a released run requires resume.

A run records the execution digest of the flow that started it and the engine
version, both shown by `runs show`. A round or fork without its own record
inherits its same-flow ancestor's. The check rescans the flow's files on disk,
so an edit made while a host stays up counts. When the flow now has a different
digest, is gone, or the engine version changed, `runs show` and `status <run>` report
`codeDrift`: the `recorded` digest, the `current` one when the flow is still on
disk, and the engines' versions when they differ. `runs show` adds a `verdict`
that says whether a resume needs `--allow-code-drift` or cannot happen. Every path that would re-drive the run refuses with
`CodeDrift` and leaves it where it was: `runs resume`, `run --resume`, a node
approval decision, and a steer wake. Pass `--allow-code-drift` to resume it on
the changed code; the host loads that code before the resume is accepted, and
the run records it, so later approvals proceed and the executor runs it. A flow
that is gone, or whose new code the host cannot load, has nothing to adopt:
the resume refuses with `CodeDrift` and leaves the run where it was.

`runs verify <run>` says what such a resume would do before anything runs. It
copies the stores, resumes the copy with an engine that executes no action body,
and reports the recorded steps that replay, a recorded step that never finished
and would be re-entered (`resumes`), the first step that would execute
(`executes`), and the recorded steps nothing asked for (`notReplayed`). It exits
1 with `run_divergent` when a recorded step would be dropped or re-keyed. The
project's stores are only read: a SQLite store is copied with `VACUUM INTO`, a
PostgreSQL one into a scratch schema that is dropped afterwards.

Without a run, `runs verify` reports every run the store holds, one report per
run a resume can take, and lists the settled ones under `settled`; it exits 1
when any run diverges. `--against <engine.db>` verifies the store at that path,
with the `control.db` beside it, under the project's current flows: an old
snapshot, or another checkout's stores.

A fork can resume only after its retained workspace and public run identity
have both been reconciled. A workspace link left behind by an interrupted or
failed reconciliation does not permit the fork or its descendants to execute.
Resume retries reconciliation; a missing retained workspace or control database
is an error rather than permission to run in the parent workspace.

`runs rewind <run> --at <sequence> --preview` shows the suffix and effect
boundaries. `--yes` archives the suffix and restores the frame for a pending
or suspended engine run; use `fork` for terminal history. `--whole-repo` also
restores the frame's recorded jj operation, undoing bookmark moves, rebases,
descriptions, and abandons made after it. Active runs and
unsafe effect boundaries are refused. Evaluation artifacts live under
`.flows/evals/runs/`; baselines default to `evals/<encoded-suite>.baseline.json`
and require `--force` to overwrite. Evaluation comparison exits 1 for
regressions and 5 for inconclusive results. Cancellation interrupts evaluation
suite effects, cases, and scorers, waits for their finalizers, and prevents
publication of unfinished results. Embedded invocations pass `RuntimeConfig.signal`
and `RuntimeConfig.environment` to `createEvalCli`.

Evaluation, history, and operator commands share local project resolution.
Roots must be accessible directories. An empty `SMITHERS_REMOTE` is unset;
an explicit `--remote` option or nonempty environment value is refused.

Action-result caches use the workspace's cache directory, normally
`.flows/cache/`. `cache prune/clear` delete only local result files and require
`--yes`; `--dry-run` previews candidates. They do not remove run databases,
remote entries, or artifact blobs. `clean` executes declared `Clean` targets;
`gc --dry-run` previews terminal-run retention separately.

## Human and agent output

Presentation is automatic: verified harness markers select agent mode even in a
PTY; interactive terminals select human mode; CI and pipes use conservative
machine output. Override this with `--audience auto|human|agent` or
`SMITHERS_AUDIENCE`. Detection is a UX hint, never an approval or security boundary.

| Mode | Default experience |
| --- | --- |
| Human | Live Clack progress on standard error, task lifecycle/log feedback, readable summaries, and interactive prompts where supported. |
| Agent | Minimal structured Incur results, useful next commands, and no unsolicited progress; inspect stored logs when needed. |

`--silent` suppresses progress but retains results, errors, and exit status.
`--quiet` is retained where already supported, including legacy aliases whose
older output behavior is unchanged; use `--silent` across command groups.
`--verbose` enables plain progress for
an agent. Explicit log commands still return their requested logs. `--json` and
`--format` control standard output independently: a human can keep live progress
on standard error while writing JSON to a file. MCP always stays machine-clean.

Agent `runs logs` history pulls default to 100 events when `--follow` is absent.
Use `--limit 1..10000` to choose a page size and `--after <sequence>` to continue;
the result supplies a next-page command when a limit is reached. Agent log output
defaults to incremental JSONL. `--follow` streams new events without the default
100-event bound; an explicit `--limit` still bounds it.

```sh
smthrs flow start review --audience human
smthrs build '//...' --json > result.json
smthrs flow start review --silent
smthrs runs logs <run-id> --follow --format jsonl
```

The shared `Audience` utility resolves the policy once; renderers consume that
policy instead of making their own harness guesses. See the
[evidence registry](https://github.com/smithersai/smithers/blob/main/packages/smithers/build/build-cli/docs/reference/agent-detection.md)
for supported markers, source links, and known detection gaps. An unrecognized
harness can select `--audience agent` without waiting for a registry update.

## Formatting and compatibility

The public parser is Incur with Zod schemas; Effect supplies the runtime and
Clack supplies human progress and interactive prompts. Use live `--help` and `--schema` output
for exact arguments. Canonical commands use Incur's `--json`/`--format`
contract, with `--format jsonl` for streams. Flat aliases retain their prior
output; do not assume that an old alias and a canonical command return the
same document shape.

`up`, `ls`, `ps`, `status`, `logs`, `output`, `cancel`, `signal`, `steer`,
`down`, `plan`, `approve`, `deny`, and older synonyms remain hidden transition
aliases. JSON approval payloads passed to `run`, and `run --resume`, still
route to the old handler. Prefer `flow execute` and `runs resume` in new
scripts. The Claude mirror protocol is hidden as `internal claude`.

## Command pages

Every canonical command has a page generated from its `--help` at
[smithers.sh/docs/reference/cli](https://smithers.sh/docs/reference/cli/), with
the hidden-alias table.

## Other reference

- [The API reference](/reference/api/): every public export of the package.
- [The command surface](/concepts/command-surface/): how the shipped
  and removed verb lists are both kept closed.

### Workspace commands

`smthrs workspace create --ref NAME` checks out one of your pushed refs
(`smthrs repo push --name NAME`) in a new workspace without starting a run.

`smthrs workspace exec BOX --repo OWNER/REPO --command 'pnpm test' --exec-id tests-1`
admits a command and polls its durable receipt. Reuse the same ID and inputs to
reattach after a disconnect. Reusing the ID with different inputs fails.
`--detach` returns the receipt as soon as the command is admitted and leaves it
running; run the same command with the same `--exec-id` to reattach.
Output is available at completion and is bounded; `output_truncated` reports
truncation. Nonzero exit codes propagate to the CLI.

`--timeout SECONDS` requests cancellation when the limit expires; Ctrl-C also
requests cancellation and waits for confirmation. The default has no client
timeout; the backend stops commands after 60 minutes. A lost execution lease
produces an unknown outcome and never automatically reruns the command.
Use `workspace ssh` or `workspace shell` for interactive input and guest-user
selection. The former SSH log-file runner and its `--stdin`/`--user` exec options
are removed.

`smthrs workspace create --repo OWNER/REPO --name sized --cpus 4 --memory 8192 --disk 40`
requests 4 vCPUs, 8192 MiB memory and 40 GiB writable disk. The server persists
this size for recovery and fork and returns `workspace_resources_exceeded`
when a requested resource exceeds its configured cap.

## macOS host service

Build the stage-1 server bundle with `smthrs build //apps/app:serverBundle`,
then run `smthrs host start --bundle <output-directory>` in your macOS login
session. Start verifies every manifest digest before registering the service.
Without `--bundle`, it uses `/opt/homebrew/opt/smithers/libexec`.

Start waits up to 60 seconds for `http://127.0.0.1:4000/readyz` and prints the
setup links. Open one to set up the owner. The links come from backend memory
through the user-owned, mode-0600 `run/host.sock`; they never enter service logs
or a token file. Repeating start leaves the running service and token intact.
Changing bundles restarts once; a restart before owner claim rotates the token.

`host start` exits 0 with `setup_ready`, 3 with `setup_closed` (Already set up.),
or 4 with `setup_mint_failed`. Readiness and socket failures exit 1.
`host status` reports launchd, readiness, bundled microVM doctor, bundle and
version. `host stop` unloads the agent and retains all data under
`~/Library/Application Support/Smithers`. The agent starts at login and
restarts after a crash. These commands require an unprivileged macOS user;
never run them with sudo.
