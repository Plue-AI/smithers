# Claude Code 2.1.291 signed-out session fixture

A sanitized copy of one whole transcript that Claude Code wrote for a headless
run in an empty temporary home, and the entries
`ExternalTranscript.decodeClaude` must produce from it.

| Field          | Value                                                                                             |
| -------------- | ------------------------------------------------------------------------------------------------- |
| Agent          | Claude Code, release `2.1.291` (the `version` on every conversation record), entrypoint `sdk-cli` |
| Format version | `claude-code/2.1`                                                                                 |
| Session        | `889e416d-fda3-42c0-869a-56b3ced78a05`, recorded 2026-10-08 on macOS (Apple Silicon)              |
| Files          | `session.jsonl` (19 rows, every row the CLI wrote), `expected.json` (final state, 2 entries)      |

It covers what a member sees when Claude Code in their machine has no login:
the prompt they typed and the error Claude Code reported
(`isApiErrorMessage`, `error: "authentication_failed"`). It is the only
fixture from the `sdk-cli` entrypoint and from the newest local release.

## Capture procedure

1. Create two empty directories: a home and a working directory.
2. Run, with nothing else in the environment:
   `env -i HOME="$HOME" PATH="$PATH" CLAUDE_CONFIG_DIR=<home> claude -p "Create sample.txt containing the word alpha, then print it."`
   in the working directory. Claude Code printed `Not logged in · Please run /login`
   and wrote `<home>/projects/<encoded working directory>/<session>.jsonl` itself.
   No login, credential or file of the maintainer's own Claude Code home was read or written.
3. Read each line with `json.loads`, apply the redactions below, write each row
   with `json.dumps(row, ensure_ascii=False, separators=(",", ":"))`. Row and key order are the CLI's.
4. `expected.json` was written by hand from rows 3 and 16. No decoder produced it.

Raw capture SHA-256 `5180a64d0317b5b1515ebb615d548eacbb611fd70de619d206236b6212083abc`;
sanitized `session.jsonl` SHA-256 `689fda64a3f57435075f253c524c41cf28eba7dd74b4e26e5ab61172d30ee979`.

## Rows

| Rows        | `type`                                                                                                                                                                                                            | Decoder                                         |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| 1, 2        | `queue-operation`                                                                                                                                                                                                 | Skipped by name                                 |
| 3           | `user` (`promptSource: "sdk"`)                                                                                                                                                                                    | The owner's `prompt`                            |
| 4–10, 12–15 | `attachment`: `environment`, `model`, `deferred_tools_delta`, `agent_listing_delta`, `skill_listing`, `auto_mode`, `total_tokens_reminder`, `session_context`, `date`, `remote_session_change`, `prompt_snapshot` | Skipped by name                                 |
| 11, 18      | `atis-latch`                                                                                                                                                                                                      | Skipped by name                                 |
| 16          | `assistant` (`isApiErrorMessage: true`, model `<synthetic>`)                                                                                                                                                      | An `error`: "Not logged in · Please run /login" |
| 17, 19      | `last-prompt`, `cost-state`                                                                                                                                                                                       | Skipped by name                                 |

## Redactions

1. Every string inside an `attachment` and its `rendered`, except
   `attachment.type`, became `[fixture: N chars redacted]`, and every list there
   keeps its first three items. These carried the system prompt, tool, agent and
   skill listings, and the working directory.
2. The temporary working directory is `/tmp/fixture-session/work` wherever it appeared.
3. No string outside the attachments is longer than 400 characters, so none was truncated.
4. Secret scan for API keys, bearer tokens, JWTs, private keys, email addresses
   and IP addresses: no match.

## Limits

A signed-out run has one turn, no tool call and no edit. The logged-in session
with tools, edits, an interruption and compaction is `../claude-code-2.1`. A
member's Claude Code session captured inside a machine, as an unprivileged
member, is still pending on the reference Mac mini.
