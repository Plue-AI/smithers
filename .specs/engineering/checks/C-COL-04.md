# C-COL-04 Daemon confinement: paths, special files and identity

Proves: mvp.md M-18, M-29, §9 Isolation, §6.8 Terminals ("tool credentials" stay the member's) · spec.md §5.5, §8.7.2, §9.5.1–9.5.3, §9.6.1 · Layer: integration · Stage: S2 · Tickets: T-COL-03, T-TRM-07, T-MCH-15, T-MCH-11, T-COL-03a
Automation: `crates/smithers-machined/tests/confinement.rs` (new), `packages/backend/internal/machined/confinement_integration_test.go` (new) · Runs in: reference-host microVM (real users and cgroups) and CI on a Linux runner

## Setup

- A machine with `ben` (20001), `alice` (20002) and `agent` (19999). Ben's home holds the five credential files (§8.7.3). Alice's token is at `/run/smithers/20002/token`. A sentinel file `/etc/smithers-sentinel` (root, 0600) holds a random value.
- A coding run registered with `register_run`, and an `agent` process outside it.

## Steps

1. Paths through `read_file` and `write_file`: `../etc/passwd`, `/etc/passwd`, `src/../../etc/smithers-sentinel`, a symlink `l → /home/alice` read as `l/x`, a write to a symlink leaf `s → /etc/passwd`, and 10,000 writes to `d/f` while another thread swaps `d` between a directory and a symlink to `/etc`.
2. Special files: a FIFO, a unix socket and a directory in the working copy, each through `read_file` and `write_file`.
3. Credential paths: Ben replaces `~/.codex/auth.json` with a symlink to `/run/smithers/20002/token`, and `~/.claude/.credentials.json` with a FIFO. Trigger the credential watcher, then `seed_credentials` for Ben.
4. Identity:
   - an `agent` process in the registered run calls `write_file` on the local socket with a payload naming Ben as actor;
   - Ben's process connects to `/run/smithers/machined.sock`;
   - the unregistered `agent` process calls `write_file`;
   - a guest process connects to the daemon's relay port without the per-boot secret and sends `open_session(ben)`;
   - the host sends `open_session` as uid 0, as uid 19999 with login `ben`, as uid 20001 with login `alice`, and with login `../x`.
5. Privilege: read the `Uid:` line of `/proc/<pid>/status` for the daemon and the broker, list every root process in the guest, and `ptrace`-attach to the daemon from an `agent` process.

## Pass when

- Step 1: every escaping path and the symlink leaf are refused with a typed error; the sentinel value never appears in any response, and nothing under `/etc` or `/home` changes across the 10,000 swaps.
- Step 2: each call is refused with a typed error within 100 ms, and none blocks.
- Step 3: no byte of Alice's token reaches the store or any event; the FIFO blocks nothing; seeding never writes through the symlink to Alice's file.
- Step 4: the write is attributed `{agent: coding, run}` whatever the payload says; Ben's connection is refused by the socket's mode; the unregistered caller is refused; the relay connection is closed with no session started; all four `open_session` variants are refused.
- Step 5: the daemon runs as `machined` (19998), the broker as root, and no other root process exists besides init and kernel threads; the `ptrace` attach fails.

## Fail when

- Any path resolves outside `/workspace` for the daemon, or outside the member's home for the broker's child.
- A payload field chooses an actor or a uid.
- The daemon runs as root, or a member or `agent` can signal or trace it.

## Evidence

`.artifacts/checks/C-COL-04/<UTC timestamp>/`: per case the request, the response and the error code; the sentinel check; the store rows (ciphertext only) and events for step 3; the process table with uids; `env.json` (commit, guest kernel version).
