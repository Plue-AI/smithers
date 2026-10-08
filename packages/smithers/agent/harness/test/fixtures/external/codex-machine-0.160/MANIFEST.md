# Codex 0.160.0 member-machine capture

CLI-written transcript from an authenticated Codex session in a disposable real
microVM on the reference Mac mini, 2026-10-06. `id -un` returned `agent`;
`uname -sm` returned `Linux aarch64`; `codex --version` returned
`codex-cli 0.160.0`. No CLI or repository code ran as root.

The capture has 46 records and 12 normalized entries, with two prompts, two
successful edits, one reported failed edit, a successful command and a command
exiting with status 7. CLI code-mode failures are `custom_tool_call_output`
reports, not completed native `FileChange` items. Their matching inert requests
and failure outputs must survive normalization. A failed edit's diff is empty
because the result reports a failed match, not an observed file change; the
complete requested patch remains in its correlated tool part's command.

## Procedure and receipts

1. Create a disposable machine with the existing `microsandbox.Runtime`, two
   CPUs, 2 GiB memory and its existing authenticated egress relay. The member
   file helper transfers official `rust-v0.160.0` Linux ARM64 archives for Codex
   and `codex-code-mode-host`; the member extracts and executes them.
2. Validate an existing subscription login. Give the member an access-only
   disposable auth copy with refresh disabled, so it cannot rotate the shared
   login. No credential values enter the transcript, golden output or logs.
3. In `/workspace/agt-capture`, run `codex exec -m gpt-6.1-sol
   --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox` with a prompt
   to create `sample.txt` containing `alpha`, patch it to `beta` and verify with
   `cat`. Resume the session with a prompt to deliberately patch a nonexistent
   `gamma` line, leave that failure unrepaired, then print `capture-error` and
   exit with status 7. Neither prompt permits inspecting other directories.
4. Export the CLI-written rollout, sanitize it and map expected output with an
   independent Python reader. Expected entries were not produced by the
   production decoder. Tests compare the committed output and every record
   boundary using serialized checkpoints.
5. Delete the machine and sweep only this runtime's owned resources.

Executed command: with `SMITHERS_MICROSANDBOX_BIN` set to the reference install,
`SMITHERS_REQUIRE_MICROVM_TESTS=1`, and the capture receipts directory selected,
`cd packages/backend && go test ./microsandbox -run '^TestAGTCodexCapture$'
-count=1 -timeout 10m -v`. Result: 1 passing, 0 failing; 76.761 seconds.

Receipt: `~/lanes/fr4b-t-agt-01.receipts/codex-capture-with-tools.log`, SHA-256
`c2d4002992b50100478e078e6dcc83082a16ba42cf3e1f3253fb75abebcb855f`.
The temporary capture test is retained alongside it as
`agt_codex_capture_with_tools_test.go`, SHA-256
`4fafa3d35c3eca14541ce4d6db6d4871c53fd2efd181dd7f75d468b589bbed20`.
Public builds/tests consume only the committed fixtures, never those private
capture prerequisites or credential files.

Raw capture SHA-256:
`567af812fc13118aaa3f0ad8f5be3b9514c3b78665ccfbd0c32059f6d73c24fa`.
Sanitized capture SHA-256:
`429ebead36d010baef837c0f0cad53a5cbb452a287e6f369bc619d10a330a1a1`.

## Redactions

All string leaves of session/context/world metadata are replaced, preserving
fields, nesting, arrays, types and nulls. Session ID, CLI release and session
cwd remain. Developer/system message text is replaced. Encrypted ciphertext
strings are replaced, preserving their structure. `/workspace/agt-capture`
becomes `/workspace/capture` in keys and values. Conversation and tool content,
IDs, timestamps, ordering, exit statuses and diff reports remain intact. A scan
for bearer values, API keys and JWTs found no matches after sanitization.

## Limits

This capture certifies the Codex process and member-machine boundary. It does
not certify Claude login, composed install ingestion, browser rendering, other
release lines or smithers-38's required post-hoc sign-off. It contains no
failure Codex reported at the end of a turn and no message between agents;
explicit script and command failures are real. Those two are recorded in
`../codex-signed-out-0.160` (row 11) and `../codex-0.160` (rows 98 and 100).
