---
title: "CLI reference"
description: "Target execution, durable flow control, operator commands, and compatibility spellings."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/docs/reference/cli/README.md"
---

## Canonical commands

`smthrs` combines the target graph and durable control plane. A **target** is a
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
| `memory`, `credentials`, `triggers`, `integrations`, `eval` | Operate the persistent agent features described below. |
| `open [dir]`, `.` | Open the checkout's `owner/repo` in the Smithers app (`smithers://open/<owner>/<repo>`), the dev build inside the smithers checkout, or print its smithers.sh page. |
| `serve`, `doctor`, `suggest`, `migrate`, `update`, `bug` | Host, diagnose, discover uses, migrate source, check versions, or submit a report. |

Target patterns include `//...`, `//package/...`, and `//package:target`.
Execution supports `--plan`, `--jobs`, and `--no-cache`. `affected` compares
`--base HEAD` to the working tree by default, including untracked files; use
`--head` or `--files` for explicit inputs. Changes to ambient configuration
conservatively select more work.

For scripts, target commands and `generate ci/package` document `--workspace`
in their schemas but the executable also accepts `--root` as an alias;
flow and operator commands use `--root`. Flow control, ordinary run management, and approvals select a host from
`SMITHERS_REMOTE` or `--remote` and authenticate with `SMITHERS_API_KEY`.
`--credential` is a compatibility flag that warns on stderr because process listings and shell history expose its value.
History, memory, triggers, credentials,
integrations, evaluations, and local maintenance reject remote access.

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
| `integrations` | `list`, `doctor [--offline]`, and `reconcile`; GitHub reconciliation plans by default and writes only with `--apply`. |
| `eval` | `list/run/baseline/compare`; discover `evals/**/*.eval.ts` modules exporting `suite` and `executor`, and compare saved results with committed baselines. |

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
or `SMITHERS_TELEGRAM_API_BASE_URL`. GitHub hook declarations live in
`.smithers/listeners.json`; deletion additionally requires `--allow-delete`.

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

## History and stored state

Control, memory, credentials, and triggers share `.flows/control.db`.
Execution history is in `.flows/engine.db`; `runs inspect/replay` read it
without executing actions. `runs fork <run> --at <sequence>` requires an
eligible parked/terminal agent run, its approved plan, and `jj`, and retains
an isolated workspace under `.flows/forks/`. Resume the returned child run
with `runs resume`.

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
