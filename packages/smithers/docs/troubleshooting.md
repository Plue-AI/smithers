---
title: "Troubleshooting"
description: "The refusals and surprises smthrs reports, what causes each one, and what to change."
---

Every entry below is a message the CLI actually prints, with the module that
owns it. A failure is one line on stderr and nothing on stdout, and the line
names the failure's class followed by its sentence.

## The command is refused

### `smthrs <verb> was removed in 1.0.0-rc.0`

**Symptom.** A verb that worked in Smithers 0.x exits 1 with one sentence and a
link into `https://smithers.sh/migration/1.0`.

**Cause.** The verb is in `Unsupported.removedVerbs`. rc.0 refuses a removed
spelling deliberately rather than answering with a parser error, so a script
learns what replaced it.

**Fix.** Follow the link. The sentence names the replacement: `steer`,
`signal`, `approve`, `deny`, `cancel`, and `run --resume` replace the control
verbs; `ps --status waiting-approval` replaces the human-request verbs;
`output` and `logs --json` replace the node-detail verbs; `smthrs migrate`
replaces `upgrade`.

### `smthrs up --serve` and the other removed flags

**Symptom.** A flag exits 1 rather than producing a usage error.

**Cause.** `Unsupported.removedFlags`. A removed flag is registered hidden on
the command that used to carry it, so the parser accepts the spelling and the
handler refuses it with the migration link.

**Fix.** The `up` UI-hosting flags (`--serve`, `--interactive`, `--supervise`,
`--herdr`, `--monitor`, `--report`) are replaced by `smthrs serve`. The
recovery flags (`--force`, `--steal-ownership`, and the four `--resume-*`
flags) are gone because the run driver's heartbeat sweep owns recovery.
`--max-concurrency` is gone because parallelism is declared by the flow and
bounded by plan admission.

### `system/<name> is not an rc.0 verb`

**Symptom.** `smthrs plan system/plan` or `smthrs up system/serve` exits 1.

**Cause.** `Unsupported.isReservedFlow`. The control catalog reserves
`system/*` ids for command-line verbs, and rc.0 ships a body for none of them,
so a launch would park with nothing to run.

**Fix.** Use the verb. `smthrs ls` never lists a reserved id.

### `unsupported_database: choose sqlite or postgres`

**Cause.** `SMITHERS_BACKEND` or `--backend` names an unsupported backend.

**Fix.** Use `sqlite` for local files, or `postgres` with
`SMITHERS_POSTGRES_URL` or `DATABASE_URL`. See the
[database configuration](../flows/database/docs/concepts/sqlite-only.md).

### `Refusing to bind 0.0.0.0: pass --listen ...`

**Symptom.** `smthrs serve` on a non-loopback host exits 1 before the server is
built.

**Cause.** `Serve.refuse`. Loopback needs no credential, but its ingress still
requires a loopback `Host` and, when present, a loopback browser `Origin`.
Anything else needs both an explicit `--listen` and a bearer token, because an unauthenticated control
plane on a LAN address can launch agents with your credentials and nothing
about that looks wrong from the outside.

**Fix.** Pass both: `smthrs serve --host 0.0.0.0 --listen` with `SMITHERS_API_KEY` exported.
`--credential` falls back to `SMITHERS_API_KEY`.

The missing-token message reads `without a Bearer [REDACTED_TOKEN]` rather than
`without a bearer token`: the redaction pass every stderr line takes rewrites
that phrase in the CLI's own sentence.

## The project is not the one you meant

### A command wrote to a `.flows/` you did not expect

**Symptom.** `smthrs ls` finds nothing, or two commands in one repository
disagree about which runs exist.

**Cause.** The upward root walk anchored somewhere else. `.flows/` anchors on
its own; a bare `flows/` anchors only beside a `package.json`, `.git`, or
`.jj`; and the walk stops at the repository root.

**Fix.** Run `smthrs doctor`, which prints the root it resolved and both
database paths. Pass `--root` to fix the answer for one invocation, or run
`smthrs init` in the directory you mean, which creates the `.flows/` that
anchors every later command.

### `Found Smithers 0.x state at <path>`

**Symptom.** A one-line stderr notice on every command in a project.

**Cause.** `Project.legacyState` found `.smithers` or `smithers.db` beside a
directory that has no `.flows/` yet. rc.0 does not load, resume, or migrate 0.x
run databases.

**Fix.** Finish, archive, or discard those runs with the 0.x CLI
(`bunx smthrs@0.35.0 ps`), then run `smthrs migrate` to convert the project
source. The notice stops as soon as the directory has a `.flows/` of its own.
`smthrs doctor` keeps reporting what the old database still holds, because that
question survives the notice.

## The run does not finish

### `Run <id> was accepted but no executor took it`

**Symptom.** `smthrs ps` shows the run at `accepted` with
`waitingReason: "executor"`, and it stays there. `smthrs status` opens with
`pending: accepted, and no executor took the run; nothing is driving it`, and a
detached launch wrote the same sentence to its log.

**Cause.** The flow is a module flow, or it belongs to another host's registry.
The CLI's agent host drives prompt flows; a flow whose body is a module
(`flow.ts`) is driven by the host program that registers its delegates. That is
a real wait for a real external executor, so the run does not time out.

**Fix.** Run the flow from the host program that registers it, or end the run
with `smthrs cancel <run-id>`. `smthrs status` prints that command on its
`Unblock` line.

### Exit 3, and the run is at `waiting-approval`

**Symptom.** A command exits 3 with a `Parked` receipt, or with an `Accepted`
receipt and a run that parked afterwards.

**Cause.** Two different parks. A `Parked` receipt means the plan itself
carries no grant. An `Accepted` receipt with exit 3 means the run started and
then parked on an in-run ask.

**Fix.** A Plan approval records the grant without launching a run. Approve
and then execute the same payload you submitted:

```bash
smthrs approvals approve "$approval" --scope run --json
smthrs flow execute "$approval" --json
```

For an in-run Node approval, read the `control.approval.requested` event's
`payload` member and approve that payload. This resumes the existing run;
do not submit a new plan. If no executor took up the approved run, retry with
`smthrs runs resume <run-id>`. `smthrs status <run-id>` prints the approval and
resume commands, already quoted. See [Script the CLI](./guides/script-the-cli.md).

### A command against `--remote` prints the receipt and returns immediately

**Symptom.** `smthrs run` exits 0 while the run is still going.

**Cause.** `ExecutorOwnership` is `false` for a remote composition, because the
run is another process's to drive. A verb that waited here would hang on work
this process never performs.

**Fix.** Follow the run explicitly with `smthrs --remote <url> logs <run-id>
--follow`, or run against the local project.

### `smthrs memory` refuses under `--remote`

**Symptom.** A memory read or write fails against a remote control plane.

**Cause.** The control plane owns memory. Building a local store here would
create a `.flows/control.db` beside your shell and write facts the server never
reads, which is worse than a refusal because it looks like it worked.

**Fix.** Run the memory command against the project the control plane serves.

### `up -d` is refused with `--remote`

**Symptom.** Exit 1 before anything launches.

**Cause.** A detached launch spawns a local executor, which a remote
composition does not have.

**Fix.** Drop `-d`, or drop `--remote`.

### A detached launch never returns a run id

**Symptom.** `smthrs up -d` exits 1 saying the child never reached admission.

**Cause.** The child died before the run row was durable, or it was still
silent past `SMITHERS_DETACHED_ADMISSION_TIMEOUT_MS` (30000 by default) and
then past four times that window.

**Fix.** Read the file named by `Log:` in the failure report. The CLI retains
`.flows/logs/pending-<nonce>.log` after a failed launch and includes the last
32 KiB in the report. Remove the file manually when it is no longer needed.
Raise the timeout for a slow first start, when the engine database still has
to be created and migrated.

Interrupting the admission wait waits for child cleanup before the CLI exits.
On POSIX, cleanup targets its process group; on Windows, it targets the child
handle. The pending log is retained. After admission succeeds, the child owns
the run and outlives the launcher.

## The output is not what you expected

### `Cannot render $["..."]: ...`

**Symptom.** A command exits 1 with a rendering error naming a code and a path.

**Cause.** `Output` admits inert plain data only. `proxy`, `callable`,
`accessor`, and `to_json` mean the value was executable; `cycle`,
`depth_limit`, `member_limit`, and `byte_limit` mean it exceeded a bound;
`unsupported` means a class instance, a symbol-named member, a sparse array, or
a non-enumerable member.

**Fix.** The bounds are 128 levels, 10,000 members, and 4 MiB. Narrow the read:
`smthrs output <run-id> <node-id>` instead of every node, or
`smthrs logs <run-id> --follow` instead of the whole history.

### `... exceeds the 50000-events resource limit`

**Symptom.** A history read fails instead of printing.

**Cause.** A finite read retains at most 50,000 events and 16 MiB, with a 1 MiB
cap per event. Truncating silently would be worse: a caller cannot tell a
partial history from a complete one.

**Fix.** Use `--follow`, which applies the per-event cap without retaining
history, or run `smthrs gc` so the history is bounded going forward.

### `--json --quiet` still printed a document

**Symptom.** stdout contains JSON even though `--quiet` was passed.

**Cause.** `--quiet` suppresses banners and progress on stderr, never the
command's stdout document.

**Fix.** Redirect stdout when the document is unwanted. Scripts may safely
parse `smthrs --json --quiet ps`.

### The interactive rendering did not appear

**Symptom.** `smthrs doctor` prints plain lines with no symbols, and
`smthrs suggest` asks nothing.

**Cause.** `Ui.isInteractive` is false. It requires both stdout and stdin to be
terminals, `CI` to be anything but `"true"`, and `TERM` to be anything but
`dumb`. Every method has a plain-line fallback, and `pickSuggestion` answers
`None` rather than blocking.

**Fix.** This is the intended behaviour in a pipe or a CI job. Run in a
terminal, or unset `CI`, if you want the prompts.

## The installation is wrong

### `v<version> is unsupported; use Node 26.4+`

**Symptom.** `smthrs doctor` reports a `fail` on the `node` check, and exits 1.

**Cause.** The running Node does not satisfy `Doctor.supportedNodeRange`.
This includes Node 22, Node 24, and Node 26.0 through 26.3.

**Fix.** Install Node 26.4.0 or later. The CLI's shebang pins Node for every
installation path, so this is about the Node on your `PATH`, not about the
runner you typed.

### `Could not register the MCP server`

**Symptom.** `smthrs mcp add` exits 1 and prints manual instructions.

**Cause.** Every target failed. The usual reasons are an `mcpServers` member
that is not an object, an unreadable configuration file, or a lock file beside
it that another Smithers process still holds.

**Fix.** The printed reason names the file. Fix it and run the command again;
`addMcp` writes through a temp file and a rename, so nothing was half-written.
A lock records the process that took it. One left behind by a process that has
since died is reclaimed on the next run. One that is still held is reported
with its owner's pid and its own path, so it can be deleted by hand once that
process is gone.

## See also

- [Diagnose a run](./guides/diagnose-a-run.md): the four commands that answer
  four different questions.
- [Output and exit codes](./concepts/output-and-exit-codes.md): the status
  vocabulary behind every code above.
- [The Smithers troubleshooting guide](/docs/troubleshooting/): problems that
  are not the command line's.
