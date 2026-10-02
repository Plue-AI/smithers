# C-SPK-07 Yjs keystroke latency into a VM from a second Mac

Proves: mvp.md §9 Live updates, J3.5, M-02 · spec.md §1.4, §7.4.1–7.4.2, §9.2.2, §16.3.2, §18 (keystroke budget); overview.md E-04, E-05 · Layer: spike · Stage: W0 · Tickets: T-COL-01, T-COL-11
Automation: `scripts/spikes/col-01/keystrokes.spec.ts` (new; `scripts/spikes/col-01/run.sh keystrokes`) · Runs in: reference host plus a second Mac on the same network

## Setup

- Reference host: the team's Mac mini, whatever its size. Record its host profile (spec §8.2.1). The spike's Go fan-out (`scripts/spikes/col-01/fanout/`) listens on loopback plus the host's LAN address, the way the install serves a configured bind address (§1.4).
- One microVM running the spike's Yrs document host (`scripts/spikes/col-01/dochost/`, `yrs =0.27.4`). It holds a 400-line seed file in the working copy and writes to disk with the §9.2.2 debounce.
- The fan-out reaches the VM over the transport C-SPK-03 chose.
- Second Mac on the same network: one Playwright process opens two Chromium pages, A and B, at the plain-HTTP LAN origin (`http://<host>.local:<port>`, an insecure context, §16.3.2). Each page has a `yjs 13.6.32` text bound to the document.
- One clock: the Playwright runner's monotonic clock (`process.hrtime.bigint()`) stamps both send and receipt.

## Steps

1. Page A types 1,000 printable characters at 10 per second at random positions in lines 1–200. Before each key, the runner records t_send.
2. Page B observes its document. Its `Y.Text` observer calls an exposed binding with the inserted character's sequence tag, and the runner records t_recv.
3. Repeat with A typing 1,000 characters at 30 per second.
4. Repeat steps 1–2 while B also types 1,000 characters in lines 201–400 at 10 per second (concurrent editors).
5. After each run, wait 1.5 s. Read the file from the VM, the text in A and the text in B.

## Pass when

- Keystroke latency t_recv − t_send has p95 < 1 s in every run, with n ≥ 1,000 keystrokes per run, measured on the runner's monotonic clock.
- After each run, A's text, B's text and the file on disk are byte-identical.
- No keystroke is missing or duplicated: every sequence tag arrives exactly once.
- The report attaches p50/p95/p99 per run, and the share of the p95 spent on the browser→host leg versus the host→VM leg, from host-side timestamps.

## Fail when

- Latency is measured inside one page, or from two pages on two machines with two clocks.
- The run uses `localhost` on the host instead of the LAN origin from the second Mac, which skips the network leg.
- The final texts differ, or the file on disk lags the document after the 1.5 s wait. That would mean the debounce never flushed.
- Fewer than 1,000 keystrokes are counted, or the slow first keystrokes (socket warm-up) are dropped without being reported.

## Evidence

`.artifacts/checks/C-SPK-07/<UTC timestamp>/`: `keystrokes.csv` (run, seq, t_send, t_recv, host_in, host_out), `summary.json`, the Playwright trace for each run, the final texts and disk file with their SHA-256, and `env.json` (commit, browser version, host profile, network link of each Mac, VM config).
