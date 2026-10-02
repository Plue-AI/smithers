# C-PERF-04 Outside disk write reaches an open File card < 1 s

Proves: mvp.md §6.8 External changes and Live updates, §9 Live updates, M-27 · spec.md §9.2 (stage-2 reload rule), §9.3.4 (`file_written`), §18 · Layer: perf · Stage: S2 · Tickets: T-COL-04, T-APP-11
Automation: `scripts/perf/disk-write.mjs` (new) · Runs in: reference host plus a second Mac on the same network

## Setup
- Install at commit X on the reference host (the team's Mac mini, whatever its size), with a bind address and public origin set so the second Mac B reaches it (§16.3.1); one awake branch.
- On B: a Playwright Chromium context signed in as member A with the File card open on `src/a.ts`; member C's SSH session to the branch through a persistent control connection (`ssh -o ControlMaster=auto -o ControlPersist=10m -p 2222 <branch>@<host>`), host from the Branch card's SSH line.
- The card reloads on `file_written{path, actor, post_digest}`, which the daemon sends within 200 ms of each write (§9.3.4), not on the burst event.
- Writes are spaced 3 s apart, so each write is also its own burst (a burst closes after 1.5 s without events) and the activity count below is exact.

## Steps
1. For i in 1..200: t0 = B's clock just before `ssh … "printf '// m<i>\n' >> src/a.ts"` over the open control connection; t1 = B's clock when A's File card DOM shows `// m<i>`.
2. After the run, read the branch's activity entries for C.

## Pass when
- n = 200; nearest-rank p95(t1 − t0) < 1 s.
- Every write appears in the card exactly once, and each produced one activity entry "C via SSH changed 1 file".
- The card's `post_digest` after each reload equals the file's digest on the machine.
- Clock: B's clock for both ends; the interval includes SSH transit, so it bounds write-to-card from above.

## Fail when
- The SSH handshake is inside the measured interval (no persistent control connection).
- The card shows the new text only after a manual reload.
- The card reloads on the burst event instead of `file_written`: p95 of 1.5 s or more.
- An activity entry names the agent or "system" instead of C via SSH.

## Evidence
`.artifacts/perf/<date>/disk-write.json` (raw samples, summary, the detected host profile (§8.2.1), origin, commit, install version) and a copy with `summary.json` and the activity entries in `.artifacts/checks/C-PERF-04/<UTC timestamp>/`.
