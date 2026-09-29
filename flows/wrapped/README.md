# wrapped

Runs Claude Code on a task with the memory a native Smithers agent starts
with. The flow selects memory for the task, appends the shared Smithers brief,
the rules for the permission mode, and the memory block through
`--append-system-prompt`, and passes the task on stdin.

```
Memory -> Prompt -> Launch        (new launch)
Recall -> Launch                  (resume)
```

- **Memory** runs the frame-0 selection (`@smthrs/agent/Memory`, 32 KiB).
  When Jev is down, slow or not configured, the result carries `unjudged`.
- **Prompt** writes `.flows/wrapped/extra/<sha256>.md` (temporary name, then
  rename) and records `.flows/wrapped/sessions/<session>.json` before anything
  launches. The record names the prompt by digest only. A prompt with a NUL
  byte or over 131071 bytes fails `prompt_unsendable`.
- **Launch** runs `claude -p --session-id <uuid>` (or `--resume <uuid>`) in its
  own process group, with no MCP server (`--strict-mcp-config --mcp-config
  '{"mcpServers":{}}'`). It settles when the harness exits, even if a process
  it started still holds stdout. A timeout, oversized output, interruption or host
  SIGINT/SIGTERM/SIGHUP kills the whole group. The harness does not inherit
  `AI_GATEWAY_API_KEY`, `NODE_OPTIONS`, `NODE_PATH` or the build cache
  credentials.

Only Claude Code has an adapter.

## Usage

```sh
node --experimental-strip-types flows/wrapped/main.ts --harness claude-code \
  --cwd <dir> --task "<text>" [--session <id>] [--permission plan|acceptEdits] [--dry-run]
```

The command prints one JSON line per fact: the memory output, the argv, the
harness's stdout, then the result. `--dry-run` writes the prompt and prints the
argv, but records no session and spawns nothing. With `AI_GATEWAY_API_KEY`
set, memory asks Jev first.

## Permission modes

Every launch also passes `--strict-mcp-config --mcp-config '{"mcpServers":{}}'`,
so the user's MCP servers stay unloaded.

| Mode                    | Claude Code flags                                                 | The agent may                                        |
| ----------------------- | ----------------------------------------------------------------- | ---------------------------------------------------- |
| `acceptEdits` (default) | `--permission-mode acceptEdits --tools Read,Edit,Write,Glob,Grep` | read and edit files; no command tools, so no commits |
| `plan`                  | `--permission-mode plan --tools Read,Glob,Grep`                   | read files only                                      |

## Resume

Pass `--session <id>` from an earlier result. A resume runs no new memory
selection. It reads the session record and replays the same prompt bytes
under the recorded permission mode. A moved checkout resumes, because the
prompt's path follows from `--cwd` and the recorded digest. The resume fails with a typed error and
spawns nothing when:

- the session is unknown (`session_unknown`);
- the record is malformed (`session_malformed`);
- the prompt file changed or is gone (`extra_changed`);
- a different `--permission` is passed (`permission_changed`).
