# T-TRM-05 The coding agent's `bash` runs in its own terminal session, shown in the Terminal card

Stage S2 · Size M · Depends on T-TRM-01, T-COL-03, T-TRM-07, T-FLW-01, T-APP-09, T-APP-12 · Unblocks T-APP-10, T-COL-08 · Issue: [#3577](https://github.com/smithersai/smithers/issues/3577)
Spec: spec.md §8.11.2a, §9.1.2, §9.3.1, §9.5.1–9.5.3, §9.6, §14.6a · Delta: delta.md §5 · Product: mvp.md §11 stage 2 item 10, §3.1 (one card per flow, whoever runs it)
Ready: 2026-10-03 smithers-8a sha256:5478290ac029

## Goal
Every command the coding agent runs appears live in a Terminal card on its branch, exactly as a person's command would.

## Scope

- Reuse T-APP-09’s participant adapter for terminal agents: id, kind, avatar, run/session and optional `for_member`. The broker registers agent process lifetime; ordinary terminal commands remain person-channel activity. Participant ids grant no authorization rights. Check: C-J3-10.

In:
- The agent's `bash` tool executes through a daemon PTY session owned by `agent` (uid 19999), registered to the run (`register_run`).
- One agent terminal per run, reused across its commands, titled after the TODO.
- Members watch it read-only. Output is returned to the agent as the tool result, bounded as today.
- Land dark against the specified contracts of every dependency above. Until T-FLW-01 supplies machine-only dispatch, T-COL-03 and T-TRM-07 supply authenticated run registration and PTY lifecycle, T-TRM-01 enforces input ownership, and T-APP-09, T-APP-10 and T-APP-12 supply participant and card integration, refuse this binding with a typed unavailable error. Never fall back to host execution, an unregistered session or the old spawn path. Enable only after C-J3-10 and C-COL-04 pass.

- Lands dark until T-APP-10 (rule 3; automatic cycle cut 2026-10-03): build against its spec'd contract; the dependent path refuses with a typed error until T-APP-10 lands.
Out:
- Typing into the agent's terminal: only its owner types, and the agent has no keyboard (§8.11.2).
- Ask to type ([D]).
- New terminal brokers, host replay buffers, SSH transport, member login provisioning and sudo. Reuse T-TRM-07 and T-TRM-01.
- External-agent transcript import (T-AGT-01–03), presence and activity adapters, line flags and co-editing. This ticket only wires their existing participant contract into terminals.
- New public Bash input/output schemas or interpreter/toolchain support.

## Changes
- Reshape `packages/smithers/agent/src/StandardFlows.ts:247–263` (`shell`) and `packages/smithers/agent/std/src/Bash.ts:473–521` (`run`): reuse planning, permission/envelope checks, timeout and bounded-output contracts; bind the production coding host to T-TRM-07’s agent PTY instead of direct `Exec.exec`. Delete the replaced coding-host spawn path at cutover. Add only the command/result adapter that these existing bindings lack; no second process supervisor.
- smithers-38 accepts the command framing and PTY merged-output mapping to the existing Bash result fields, including echo, ANSI, truncation, signals and cancellation; smithers-3f accepts the daemon seam. Record that contract before enabling. Command output must not forge completion by printing OSC 133 or wrapper-like status text. Check: C-J3-10.
- `smithers-machined` (T-TRM-07) → the coding host asks for its terminal with `open_session(pty)` on the agent-only local socket (§9.5.3). The broker places the PTY under the caller's registered run, so file writes attribute to the run (§9.3.1), and a run's end calls `kill_sessions(run)` (§9.6.3).
- Reuse `packages/backend/internal/routes/terminal_session_manager.go:93` (`getOrCreate`) for fanout and ring replay; wire the registered agent terminal into T-APP-10’s Branch card and T-APP-12’s Terminal card with owner "Agent". No second replay buffer.
- `terminals` rows → `owner_id` null with `run_id` set for agent terminals.

## Tests
- Coverage gate (library, ledger #3480): every `@smthrs/std` src file this ticket edits gets a per-file 100/100/100/100 gate in `packages/smithers/agent/std/vitest.config.ts`, as `src/Container.ts` already has.
- E2e, C-J3-10 (`apps/app/e2e/real/agent-terminal.spec.ts`, new): start a TODO through the production dispatcher, invoke its bound `bash` check step on a real microVM, and watch through the Branch and Terminal cards. Assert literal fixture command/output and exit status, output visible within 1 s, participant rendering and the dropped-input counter through the production terminal transport. Do not invoke a replacement test handler.
- Extend the same boundary suite: two sequential commands reuse one session; concurrent calls serialize without mixing results; cancellation and run end call `kill_sessions(run)` and leave no background child before acknowledgment. Missing each dependency provider returns unavailable without starting any process.
- Extend `packages/smithers/agent/std/test/Bash.test.ts`: literal success, failure, signal, no-final-newline, ANSI, echoed command, forged OSC/status marker, output overflow and timeout fixtures prove the accepted result contract. Expectations come from fixed fixtures, never spec parsing or production constants/functions.
- C-J3-10 integration cases `AgentPtyRootInputsValidated` and `AgentPtyDropsPrivilegesBeforePayload`: invoke the production bound tool/local socket with malformed identity, session id, size, signal and branch-selected argv/env/cwd; verify refusal before privileged use, no root payload execution, and a positive valid uid-19999 session. C-COL-04 proves registered caller, identity and confinement refusals.

## Acceptance


- [C-J3-10](../checks/C-J3-10.md): production-bound Bash, cards, result framing, dark refusal and root-input cases above.
- [C-COL-04](../checks/C-COL-04.md): authenticated run identity and machine confinement.

## Risks and notes
- Risk: interactive programs (pagers, prompts) hang a PTY where a pipe would have closed. Confirm with `git log` and `npm init` under the tool. Mitigation: set `PAGER=cat`, `GIT_PAGER=cat` and `CI=1` in the agent session environment.
- Risk: PTY output contains escape sequences the agent didn't see before. Confirm with the tool-result unit test. Strip ANSI in the tool result only, never in the card.
- smithers-38 signs off the Bash API compatibility and framing contract; smithers-3f signs off lifecycle and security; smithers-b8 accepts app wiring and smithers-06 accepts terminal participant rendering. No new ADR or public API is in scope.

## Security preconditions and root inputs

Repository code runs only inside a machine as `agent` (19999), with no sudo (M-29). The host transports bytes and never executes repository commands. Reuse the main/bundle-built T-TRM-07 broker; smithers-3f reviews these inputs. Branch-sourced data blocks activation until `AgentPtyRootInputsValidated` and `AgentPtyDropsPrivilegesBeforePayload` pass through the production binding. Branch-built executables, imports and shell startup files never execute as root.

- Root session creation consumes main/bundle broker and fixed shell/interpreter bytes, startup environment and trusted image account/group data; authenticated host run registration and daemon socketpair requests; kernel `SO_PEERCRED` uid and cgroup membership; main-generated session/cgroup ids, PTY descriptors and sizes. Validate identity, bounded sizes and ids against the registered run and fixed cgroup subtree. Retained guest paths and symlinks are branch/member-sourced and must not select root executable or filesystem targets.
- Command argv/script/stdin, cwd, environment, interpreter selection, repository files and shell startup state are branch/model/member-sourced. The broker drops supplementary groups, gid and uid before resolving or applying them. Only the unprivileged session consumes them.
- Root resize/signal/close/kill consumes main-generated registered session/run ids, authenticated lifecycle requests, branch/member-sourced dimensions and signal requests, and kernel process/cgroup state influenced by branch children. Validate sizes, the §9.6 signal allowlist and registry/subtree membership before acting; confirm `populated 0` before replying to run kill. No secrets provisioning or root installation step is added here.

## Ready checklist
1. Depends on names machine-only dispatch, daemon/run lifecycle, owner-only transport, participant adapter and Branch/Terminal card integration; Scope lands dark and refuses every unavailable provider.
2. Out explicitly excludes typing grants, brokers/buffers, SSH, provisioning/sudo, transcript import, presence/activity/line flags, co-editing and public schema/toolchain expansion.
3. C-J3-10 exercises the production TODO dispatcher, bound Bash, local socket and cards; fixed fixtures prove results, cancellation, dark refusal and root validation. C-COL-04 proves confinement.
4. smithers-38 decides Bash compatibility/framing; smithers-3f decides lifecycle/security; smithers-b8 accepts app wiring; smithers-06 accepts rendering. No new ADR or public API.
5. Owner pre-review, post hoc under the parallel-build directive: smithers-38: Does the PTY mapping preserve Bash’s public result and permission contracts? Can command output forge completion? smithers-3f: Are root inputs validated before use and payloads applied only after privilege drop? Does run end kill every child before acknowledgment? smithers-b8: Do production card subscriptions expose the same registered terminal without a second transport? smithers-06: Do terminal avatars and “for Ben” reuse the shared participant view and stay read-only? No owner answer is recorded here.
6. M-29 confines execution to non-root machine sessions; Security preconditions lists root steps and input sources, names both production validation tests and smithers-3f, and blocks branch-data activation until they pass.
