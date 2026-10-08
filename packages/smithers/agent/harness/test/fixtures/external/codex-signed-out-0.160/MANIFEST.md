# Codex CLI 0.160.1 signed-out rollout fixture

A sanitized copy of one whole rollout that Codex wrote for a headless run in an
empty temporary home, and the entries `ExternalTranscript.decodeCodex` must
produce from it.

| Field          | Value                                                                                        |
| -------------- | -------------------------------------------------------------------------------------------- |
| Agent          | Codex CLI, release `0.160.1` (`session_meta.cli_version`), originator `codex_exec`           |
| Format version | `codex-rollout/0.160`                                                                        |
| Session        | `01a119e7-51a2-7c83-86d2-3f125158d08b`, recorded 2026-10-08 on macOS (Apple Silicon)         |
| Files          | `rollout.jsonl` (11 rows, every row the CLI wrote), `expected.json` (final state, 2 entries) |

It is the recorded evidence for a failure Codex reports: Codex writes no
`error` event. The failure arrives on the turn's `task_complete` event as
`error: { message, codex_error_info }`. Local rollouts from 0.159 and 0.160
carry 123 such turns (usage limit, model at capacity, a refused request, a
workspace that failed to load).

## Capture procedure

1. Create two empty directories: a home and a working directory.
2. Run, with nothing else in the environment:
   `env -i HOME="$HOME" PATH="$PATH" CODEX_HOME=<home> codex exec --skip-git-repo-check "Create sample.txt containing the word alpha, then print it."`
   in the working directory. Codex retried, printed the 401 it received and
   wrote `<home>/sessions/2026/10/07/rollout-*.jsonl` itself. No login,
   credential or file of the maintainer's own Codex home was read or written.
3. Read each line with `json.loads`, apply the redactions below, write each row
   with `json.dumps(row, ensure_ascii=False, separators=(",", ":"))`. Row and key order are the CLI's.
4. `expected.json` was written by hand from rows 10 and 11. No decoder produced it.

Raw capture SHA-256 `3e0ff6f51fd7d6e4bf148bd922a6f262e3aba356ed085cb58d10c32e6373e039`;
sanitized `rollout.jsonl` SHA-256 `f717c26345738b6d4460199171724a3785f47f73b296ddd36803604c94553e53`.

## Rows

| Rows   | `type` / `payload.type`                       | Decoder                         |
| ------ | --------------------------------------------- | ------------------------------- |
| 1      | `session_meta`                                | Selects the profile and session |
| 2      | `event_msg` / `task_started`                  | Skipped by name                 |
| 3–6, 9 | `response_item` / `message` (developer, user) | Skipped: the model-facing copy  |
| 7, 8   | `world_state`, `turn_context`                 | Skipped by name                 |
| 10     | `event_msg` / `item_completed` `UserMessage`  | The owner's `prompt`            |
| 11     | `event_msg` / `task_complete` with `error`    | An `error` with Codex's message |

## Redactions

1. `session_meta`: dropped `base_instructions`.
2. Developer messages (rows 3–5): every text part became `[fixture: N chars redacted]`.
3. `world_state`: kept `full` and the scalar fields of `state`.
4. `turn_context`: every string inside an object or list field became
   `[fixture: N chars redacted]`; lists keep their first three items.
5. The temporary working directory is `/tmp/fixture-session/work` wherever it appeared.
6. Every other string over 400 characters keeps its first 400 followed by
   `…[fixture: N chars truncated]` (row 6, the environment context).
7. Secret scan for API keys, bearer tokens, JWTs, private keys, email addresses
   and IP addresses: no match. The error message keeps the Cloudflare ray and
   request ids Codex printed; they identify one refused request and are not credentials.

## Limits

One turn, no tool call and no edit. Logged-in sessions are `../codex-0.160`
(maintainer, interactive) and `../codex-machine-0.160` (member in a machine).
