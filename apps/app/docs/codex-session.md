# Codex session viewer

`pnpm codex-session <id>` shows a Codex CLI session in the app's own components: the timeline rail (T-UI-08), the conversation's entry rows (T-UI-07) and the run monitor (T-FLW-07) with its replay scrubber.

```sh
cd apps/app
pnpm codex-session 01a10d62                 # writes ~/Desktop/codex-sessions/<id>.html and opens it
pnpm codex-session 01a10d62 --serve         # serves it on localhost and re-reads the session every 5 s
pnpm codex-session path/to/rollout.jsonl --out session.html --no-open
```

The id may be a unique prefix. The script searches `$CODEX_HOME/sessions`, `~/.codex/sessions` and every `~/.smithers/accounts/codex*/sessions`; when a session was copied into several homes it reads the copy written last.

## Mapping

`src/mainview/codexSession/CodexRollout.ts` reads the rollout JSONL and keeps only what the views show. Encrypted reasoning, instructions and rate limits are dropped; command output keeps its first 1,500 and last 2,500 characters.

| Codex rollout | App model |
| --- | --- |
| `UserMessage`, `thread_goal_updated` | prompt entry; a run step (graph node) per prompt, one shared `Goal` step for goal turns |
| turn (`task_started` … `task_complete`) | answer entry, timeline line, run phase |
| `AgentMessage` commentary / final answer | `think` cell / `answer` cell |
| `CommandExecution` | `read` cell when every parsed part is a read, search or listing; otherwise `run` |
| `FileChange` | `edit` cell with the diff |
| `ContextCompaction` | `context` cell |
| sub-agent activity, web search | `think` cell with the helper as actor; `read` cell |

A turn that ends without an answer because the next turn started is **Interrupted**. A turn where one command fails three times with no edit between is flagged with the spec's Thrashing rule. Every rollout row is a journal position; scrubbing re-projects the whole page at that position, read-only.
