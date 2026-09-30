# burndown

Burns down every open issue in a set of GitHub repositories with coding agents
that run on subscription logins, paced so each account ends each usage window
between 90% and 100% used, and lands each fix on `main` through a merge queue.

```sh
smthrs flow start burndown --data '{"repos":["smithersai/smithers","smithersai/plue"]}' -d
smthrs tui          # the run appears as a tab; it rechecks capacity while waiting for a reset
```

## Graph

```
burndown  (Flow.make, self-handoff each round: Round.to(next))            flow.ts
 │
 ├─ Observe      Action, nondeterministic                                     host.ts
 │                open issues (gh) + triage rows + claims, in-flight workers
 │                (Worker.poll), accounts (accounts.ts) with live usage
 ├─ Pace         AgentAction seat claude-code:opus, pinned by SeatResolver     pace.ts
 │                to the Claude account with the most headroom; answers
 │                launches, each clamped to computed slot ceilings (pacing.ts)
 ├─ Launch       Action: issue-claim.mjs claim (+rollback), Worker.ensure()   host.ts
 │                keyed by repository, issue, round and execution; repairs retain ownership
 ├─ Land         Action: MergeQueue.run over workers that finished "ready",   land.ts
 │                failurePolicy "quarantine"; member = rebase → checks →
 │                review → push main. Quarantined → relaunch as a fix.
 └─ Wait         Sleep until next tick; when work remains and every account
                  is at its ceiling: Sleep until the earliest reset or ten minutes, whichever comes
                  first, then re-read usage. Unknown capacity uses the normal tick.

burndown/worker  (Flow.make, one issue bundle ≤ 3 issues)                    worker/flow.ts
 └─ RunAgent     Action placed on a Sandbox.layerHost(provider, {session})
                  codex exec -m gpt-6.1-sol  |  claude -p --model claude-opus-5-5
                  env pins one account (CODEX_HOME / CLAUDE_CONFIG_DIR);
                  result {status: ready|blocked|limited|failed, commit, notes}
```

## Primitives and sources

| Node                | Primitive                                                                                                      | Source                                                                                     |
| ------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| rounds              | `Flow.make` + `Flow.to` self-handoff                                                                           | `packages/smithers/flows/flow/docs/concepts/trampoline-rounds.md`                          |
| detached workers    | `Flow.ensure(payload, {key})`, `Flow.poll`                                                                     | `packages/smithers/flows/flow/src/Flow/make.ts:152-162`                                    |
| observe/launch/land | `Action.make` + `toLayer`, `Interpreter.layerWithImplementations`                                              | `packages/smithers/flows/flow/README.md:81-95`                                             |
| pacing agent        | `AgentAction.make`, `SeatResolver.layer`                                                                       | `packages/smithers/agent/src/AgentAction.ts:605`, `src/internal/NativeEquipment.ts:110`    |
| landing             | `MergeQueue.run` quarantine                                                                                    | `packages/smithers/flows/patterns/src/MergeQueue.ts:427`                                   |
| waits               | `Sleep.action`                                                                                                 | `flows/flow/docs/guides/wait-for-a-deadline.md`                                            |
| placement           | `Sandbox.layerHost` + `CommandSandbox` (local prefix `[]`, Cloud prefix from `NodeControl.workspaceSshPrefix`) | `flows/sandbox/docs/guides/place-a-flow-body-on-a-machine.md`, `apps/tui/src/box.ts:35-79` |

## Pacing

`slots(account) = min over windows w of (95 − used_w) / (hours_to_reset_w × rate_w)`,
zero at 97% or more. `rate` starts at 2 points per Sol agent-hour of a weekly
window and is re-estimated each round from consecutive readings divided by the
agent-hours spent on that account. Opus chooses launches within the ceilings.

## Local disk

Each local worker gets `TMPDIR` in `~/Smithers-Ops/burndown/runs/<key>/tmp`.
The run script deletes it when the agent exits or is stopped by HUP, INT or
TERM; `brief.md` and `agent.log` stay. A SIGKILL or host crash leaves it in
place. All local workers share the host's Go build cache (`GOCACHE`, else Go's
default). Local launches wait while the home volume has less than
`BURNDOWN_MIN_FREE_GIB` (default 8) free; running workers continue.

## Accounts

Every directory `~/.smithers/accounts/{claude,codex}-*` with a login is an
account; `~/.codex` is `codex-default`. Accounts sharing an email share a limit
and count once. `BURNDOWN_EXCLUDE_EMAILS` lists logins the flow must never use
(for example the operator's own Claude session). A new login needs no code
change; a missing one is skipped.

Cloud placement, authentication, review, and commit handoff are described in
[Cloud workers](docs/cloud-execution.md).
