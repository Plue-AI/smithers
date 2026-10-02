# C-SPK-08 Daemon sessions carry VS Code Remote; revocation in 5 s

Proves: mvp.md §6.15 SSH into a branch (VS Code, Cursor and Zed remote editing; port forwarding), §6.8 Terminals, M-18, M-24 · spec.md §5.6, §8.10.3, §9.6 · Layer: spike · Stage: W0 · Tickets: T-TRM-06
Automation: `scripts/spikes/trm-06/run.sh` (new), plus a recorded VS Code session · Runs in: reference host, VS Code on a second Mac

## Setup

- The reference host, `msb` 0.6.16, one microVM booted from `DefaultImage` with users `ben` (20001) and `agent` (19999), no sshd, and the T-TRM-06 supervisor started by init as root. Record the host profile (§8.2.1).
- The T-TRM-06 gateway prototype listening on the reference host, reachable from the second Mac, with Ben's key.
- The second Mac has OpenSSH and VS Code with Remote-SSH.

## Steps

1. Exit status: `ssh … 'exit 7'; echo $?`. Then `ssh -vvv … 'kill -TERM $$'`.
2. Half-close: `ssh … 'wc -c' < onemib.bin`, and `ssh … cat < onemib.bin | shasum -a 256`.
3. Flow control: `ssh … 'head -c 1073741824 /dev/zero' | (sleep 10; wc -c)`. Sample the supervisor's RSS every 100 ms.
4. PTY: `ssh -t …`, run `stty size`, resize the window to 120×40, run `stty size` again; start `sleep 100` and press Ctrl-C.
5. Port forward: `ssh -L 3000:localhost:3000 … 'python3 -m http.server 3000'`, then `curl -s localhost:3000`.
6. VS Code: connect Remote-SSH, open `/workspace`, edit and save `a.ts`, open the integrated terminal and run `ls`, forward port 3000 from the Ports view, close the window, then reopen and reconnect.
7. Revocation, 10 runs: with VS Code connected and `nohup sleep 10000 &` started in its terminal, call `kill_sessions(ben)`. Record the time to the SSH disconnect and to `populated 0` on every Ben cgroup.
8. Supervisor restart: kill the supervisor; init restarts it. Run `pgrep -u ben`, then let VS Code reconnect.
9. Disconnect: during `ssh … 'seq 1 100000'`, cut the host↔guest stream for 10 s, then restore it within the 30 s grace.

## Pass when

- Step 1: `$?` is 7; the second run's `-vvv` log shows `exit-signal` `TERM`.
- Step 2: `1048576`, and the SHA-256 equals the local file's.
- Step 3: exactly 1,073,741,824 bytes arrive; the supervisor's RSS grows by less than 16 MiB.
- Step 4: `24 80`, then `40 120`; `sleep` ends within 1 s of Ctrl-C.
- Step 5: the directory listing arrives.
- Step 6: no "Could not establish connection" dialog; the saved bytes on the machine equal the editor's; the terminal and the forwarded port work; the reconnect needs no user action.
- Step 7: in 10 of 10 runs, the SSH session ends and every Ben cgroup reports `populated 0`, including the `nohup` process, within 5 s of the call (max reported).
- Step 8: `pgrep -u ben` is empty within 2 s of the supervisor's death; VS Code reconnects without user action after the restart.
- Step 9: all 100,000 lines arrive, in order, once each.

## Fail when

- VS Code needs an sshd, a setting change on the second Mac, or a manual retry to connect.
- Any Ben process survives step 7 or step 8.
- Output is lost or reordered in step 3 or 9, or memory grows with the stalled output.
- A number is reported without its raw samples, or the VS Code step is described instead of recorded.

## Evidence

`.artifacts/checks/C-SPK-08/<UTC timestamp>/`: ssh transcripts with `-vvv`, the VS Code screen recording, `revoke.csv` (run, disconnect ms, empty ms), `rss.csv`, `seq` output digests, the supervisor and gateway logs, and `env.json` (commit, `msb --version`, host profile, VS Code and OpenSSH versions).
