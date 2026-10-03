# T-TRM-05 The coding agent's `bash` runs in its own terminal session, shown in the Terminal card

Stage S2 · Size M · Depends on T-TRM-01, T-COL-03, T-TRM-07 · Unblocks T-REL-02 · Issue: [#3577](https://github.com/smithersai/smithers/issues/3577)
Spec: spec.md §8.11.2a, §9.1.2, §9.3.2 · Delta: delta.md §5 · Product: mvp.md §11 stage 2 item 10, §3.1 (one card per flow, whoever runs it)

## Goal
Every command the coding agent runs appears live in a Terminal card on its branch, exactly as a person's command would.

## Scope

- M-34 participants have id, agent kind, avatar, run/session and optional `for_member`. Smithers, Coding agent, Claude Code, Codex and Reviewer each have their own avatar and show for Ben. The broker registers agent process lifetime; ordinary terminal commands remain person-channel activity. Adapt historical `via` actors. Participant ids grant no authorization rights. Checks: C-J3-04, C-J3-10.

In:
- The agent's `bash` tool executes through a daemon PTY session owned by `agent` (uid 19999), registered to the run (`register_run`).
- One agent terminal per run, reused across its commands, titled after the TODO.
- Members watch it read-only. Output is returned to the agent as the tool result, bounded as today.

Out:
- Typing into the agent's terminal: only its owner types, and the agent has no keyboard (§8.11.2).
- Ask to type ([D]).

## Changes
- The coding host's `bash` tool binding (find with `rg -n "bash" flows/coding packages/smithers/agent/std/src`) → replace direct process spawn with `open_session(agent, pty)` plus command writes, reading exit status from the shell's prompt marker (OSC 133) or a wrapper that prints the status.
- `smithers-machined` (T-TRM-07) → the coding host asks for its terminal with `open_session(pty)` on the agent-only local socket (§9.5.3). The broker places the PTY under the caller's registered run, so file writes attribute to the run (§9.3.1), and a run's end calls `kill_sessions(run)` (§9.6.3).
- Host terminal manager (`packages/backend/internal/routes/terminal_session_manager.go`) → lists the agent terminal on the Branch card with owner "Agent".
- `terminals` rows → `owner_id` null with `run_id` set for agent terminals.

## Tests
- Coverage gate (library, ledger #3480): every `@smthrs/std` src file this ticket edits gets a per-file 100/100/100/100 gate in `packages/smithers/agent/std/vitest.config.ts`, as `src/Container.ts` already has.
- Integration (real microVM): a run executes `pnpm test`. The Terminal card stream shows the command and its output, the tool result equals the command's output and exit status, and a member's keystrokes to that terminal are dropped.
- Integration: two sequential commands reuse one terminal session. A run's cancellation closes the session.
- Unit: exit-status parsing for success, failure, a signal and output with no trailing newline.

## Acceptance


- [C-J3-10](../checks/C-J3-10.md)

## Risks and notes
- Risk: interactive programs (pagers, prompts) hang a PTY where a pipe would have closed. Confirm with `git log` and `npm init` under the tool. Mitigation: set `PAGER=cat`, `GIT_PAGER=cat` and `CI=1` in the agent session environment.
- Risk: PTY output contains escape sequences the agent didn't see before. Confirm with the tool-result unit test. Strip ANSI in the tool result only, never in the card.
