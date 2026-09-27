# @smthrs/cli

## [Unreleased]

### Removed

- The Jev harness is retired
  ([#1654](https://github.com/smithersai/smithers/issues/1654)). The
  `smithers opencode` verb, the `@smthrs/opencode` package it served through,
  and the `classify` standard flow with its `StandardFlows.classify` bindings
  are gone. Nothing of the verb shipped in a release, so no released spelling
  changes. The evaluator and classifier types, the completion brake and the
  `flows/` judges that use them are unaffected.
- **Breaking for MCP clients:** the retained `--mcp` server no longer serves
  the `cli_*` directory tools (`cli_up`, `cli_ls`, `cli_status`, ...) or reads
  `--surface raw|both`, and `McpServer.rawTools` and `McpServer.Surface` are
  gone (#2225). Those tools mirrored the shipped verb table, hidden transition
  spellings included; `smthrs --mcp` serves the canonical command tree itself.
- **Breaking:** the `@smthrs/cli/McpServer` subpath and the `McpServer`
  namespace export are removed (#2152). `smthrs --mcp` is the one MCP server;
  its discovery tools serve the canonical command tree. `--mcp` after a
  legacy verb (`smthrs ls --json --mcp`) exits 1 and names `smthrs --mcp` instead
  of serving the retired `list_flows`/`run_flow` tools.

### Fixed

- An unknown command's suggestion names a canonical command
  (`Did you mean: smthrs runs show?`) read from the command tree, never a
  hidden alias or the `smithers` program name (#2225).

- `smthrs tui` accepts and forwards `--approve all|ask|deny` (#2020).
- TUI shell output preserves split Unicode, redacts split credential values,
  and strips split terminal sequences; cancellation stops resistant process
  groups after a bounded grace period (#2018, #2019).
- TUI sessions save in deeply nested projects, and redirected interactive
  startup exits with a print-mode hint (#2012, #2015).
- Compiled TUI binaries resolve installed project flows and share one pinned
  Effect runtime with them, preserving encoded return values (#2006).
- The packaged Node TUI supports terminal width, external editors, and native
  flow execution without a Bun global (#1987).
- The native control plane takes over a run whose host process died mid-run
  (`isAlive: sameHostPidProbe`), so a restarted host finishes it instead of
  failing it with `ClaimLost`.
- Only a verb that can start or resume a run needs `AI_GATEWAY_API_KEY`. The
  judge requirement was checked for every local composition, so in a project
  with no gateway key `smithers ls`, `ps`, `status`, `logs`, `output`, `plan`,
  `runs list`, `approvals list`, `cancel`, `signal`, `steer` and `down` all
  exited 2 asking for a key none of them could ever spend. Only `doctor`,
  `gc`, `memory`, `update` and `init` survived, and only because they compose
  no control host at all. The five verbs that reach a completion still refuse
  before they open a store: `run`, `up`, `approve`, `deny` and `serve`, with
  their aliases and their canonical spellings (`flow start`, `flow execute`,
  `runs resume`, `approvals approve`, `approvals deny`), and so does the MCP
  server, whose tools include them. Everything else composes a host that
  observes runs and drives none: it reads the engine exactly as before, and
  its executor refuses a launch or a resume as a defect, so a verb
  misclassified as a read cannot admit a run that would die at its first
  completion.

- A run whose body finishes before its observation is registered still waits
  for its copied decision. `AgentSession.launch` releases the drive before it
  returns `accepted`, and `EngineJournalSupervisor` registered the run only
  after that, in a fiber forked once the caller's control transaction had
  committed, so a module flow with no provider call could reach its terminal
  write while `awaitSettled` had nothing to wait on. The journal then read
  `control.run.completed` ahead of `projection-started`, the copied
  `flows.engine.run-decision` and `projection-settled`, which is the fold that
  reports `completed` with no output. A launch, and a resume taken up through
  the executor port, now register the hold before the executor runs, release it
  when the acceptance is not `accepted`, when the call fails, when no
  observation is coming and when the host scope closes first, and the
  observation adopts it.

  The scope of the ordering, exactly: every terminal `completed` or `failed`
  that `AgentSession.settle` or `settleDriverFailure` writes waits for this
  run's `control.engine.projection-settled` for as long as this host holds the
  run, which now includes a run that settles before its observation is
  registered, bounded by a 30 second grace that records in the journal which
  wait gave up. Two terminal writes stay outside it: `reconcileTerminal` in
  `@smthrs/control`, which `Control.cancel` reaches on a run another process
  already completed without settling the control row, and a re-drive taken up
  by AgentSession's own resume bridge, which is how `Control.resume` reaches a
  host and which registers no hold, so a run resumed before this host's
  recovery has admitted it is not held. Ordering the first needs a
  `ControlExecutor` port, because the supervisor is internal to `@smthrs/cli`
  while `ControlLive` lives in `@smthrs/control` and can reach no observation
  from there.

- `smithers opencode` refuses to start on a directory another live server
  already serves, names that server, and exits 2, the way it refuses a missing
  `AI_GATEWAY_API_KEY`. Two servers over one directory came up with no refusal
  and no warning, sharing the directory's store while each held its own event
  hub. The claim is taken before the driver opens the store, and the banner is
  printed after it, so a server refused the directory never says it is serving
  it. A killed server's record is replaced by the
  next one, so a crash costs nobody their directory, and that record does not
  make `.smithers` read as Smithers 0.x state.

- `smithers opencode --max-frames` defaults to forty instead of one hundred:
  a prompt in the app is a person waiting, and the help says so.
- `smithers opencode` no longer prints the 0.x state notice for its own
  `.smithers/opencode.sqlite`: the guard samples the directory before the
  driver creates the database, and the database is not a 0.x marker.
- `smithers opencode` passes `--max-frames` to the server as well as the
  engine, so health evaluations and records report the budget the engine
  enforces, and passes the seat's price so the header's cost is not `$0.00`.
- A seat the provider refuses (a key with no credit, a bad key) is logged
  with the seat, the provider's message, and the hint to pass `--seat` or
  set `SMITHERS_SEAT`.

### Changed

- Breaking: `history/History` `reconcile` and `prepare`, `history/Workspace`
  `workspaceFor` and `canExecute`, and `cli/HistoryCommands`
  `reconcileHistory` and `prepareHistoryRun` return Promises. History reads
  and writes go through the injected SQL client, so PostgreSQL history works;
  await each call.
- Breaking: default MCP discovery and dispatch exclude approval/denial and
  auto-approving start tools. The compatibility MCP server stamps an agent
  identity and needs both explicit host exposure and independent Control
  approval delegation. Local CLI approval remains available to the operator.
- `NodeControl.engineDurable` and application configuration accept a host-owned
  `approvalAuthority`. A bearer gateway is not automatically an approver.

## [1.0.0-rc.0] - 2026-09-01

### Added

- Initial release: the `smithers` executable, the Effect CLI command tree
  behind it, and the Node composition roots that assemble Control, the run
  executor, deterministic output, and the served gateway.

- Added `NodeControl.rebuildableTransport`: the production executor now runs on an Undici agent it can replace. Each agent is acquired in a scope forked off the caller's and the previous one is closed the moment the next is in hand, so a run that keeps meeting dead sockets holds one connection pool rather than a queue of them. The dispatcher factory is a parameter so a test can hand it a scripted one.

- Added the `openrouter:` seat provider: `openrouter:vendor/model` routes through the OpenAI-compatible Responses surface at openrouter.ai with `OPENROUTER_API_KEY`.

- Rendered `smithers logs` as a turn-by-turn transcript and `smithers status <run-id>` as a diagnosis card (verdict, gating cause, refusal histogram, edit and token accounting) in human output; `--json` output is unchanged.

### Fixed

- Stamp every local control plane with this host's name and this process's id
  instead of the placeholder `{hostId: "local", pid: 0}`, so the durable fence
  can tell two processes on one host apart.

- Open `.flows/control.db` once per invocation. The root composition built the
  durable engine again for the memory store and a third time for `serve`, which
  ran two or three single-writer queues and migration passes against one file.

- Refuse an unknown `memory --namespace` kind instead of rewriting it to
  `user`, so `--namespace team:alice` can no longer read, overwrite, or delete
  the records `user:alice` owns.

- Decide the process exit status from control receipts alone. A stored memory
  fact shaped like a receipt set the exit code of `memory get`.

- Report `--remote` and `--mcp-config` mistakes as usage errors that name the
  flag, in place of the raw `TypeError: Invalid URL`, `ENOENT`, and
  `SyntaxError` the layer builder threw before the command tree parsed
  anything.

- Forward the invocation's globals to the `up -d` child, which was spawned
  without `--mcp-config`, so the same flow no longer gets a different tool
  catalog depending on `-d`.

- Validate MCP tool arguments against the schemas the server advertises, and
  refuse the reserved `system/*` flows at both MCP boundaries the way `up` and
  `ls` already do.

- Answer MCP failures with stable per-error codes and redacted messages instead
  of collapsing every one into `CONTROL_ERROR` with a stringified cause.

- Scrub `smithers bug` reports with the journal's redaction rules, the single
  rule set the rest of the CLI already applies, rather than a separate copy of
  the 0.x regexes.

- Escalate an admission-timeout termination to the process group and confirm it
  before reporting that the engine was terminated.

- Refuse to write over an agent configuration file that does not parse, and
  write valid ones through a temporary file and a rename.

- Resolve the documentation bundle directory under CommonJS, where the module
  URL the published `require` path defaulted to was undefined.

- Number mirror nodes run-wide, so a repeated flow call after the cursor
  reports its own output instead of the first call's.

- Quote every argument of the diagnosis card's copy-paste unblock line.

- Report the run that is missing instead of an empty diagnosis card, and derive
  signal and steer idempotency keys from a full-width digest rather than a
  32-bit hash and a millisecond timestamp.

- Ask real discovery what `smithers doctor` reports, so a nested flow or a
  `SKILL.md` is no longer diagnosed as nothing found.

- Validate the `smithers init` flow name, which could otherwise scaffold
  outside `flows/`.

- Bound CLI and MCP history reads, MCP protocol frames, and rendered output;
  refuse executable object shapes with typed code-and-path rendering errors.

- Serialize Codex token refresh across processes with a liveness-aware lock,
  a unique fsynced temporary, and one post-lock credential re-read.

- Validate every memory namespace through the public schema and reject control
  characters without changing Unicode identities.

### Changed

- `sideEffects` now names the entry points that execute at import instead of
  claiming the package has none.
