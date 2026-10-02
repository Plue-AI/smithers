# Fable review: resolution (tech lead, 2026-10-02)

Each finding in [fable-core.md](fable-core.md), with what changed. Spec references are to spec.md v0.4.

| ID | Resolution |
| --- | --- |
| F-01 | Moot. Product v2.5 deferred exact kernel attribution. The watcher is inotify: writes through Smithers carry their exact author, and other bursts go to the only active session, else "changed outside Smithers" (§9.3.1). T-MCH-03 and C-SPK-01 are parked in `tickets/deferred/`, and #3436 is closed. |
| F-02 | Fixed. New S1 ticket T-MCH-14 keeps TODO workspaces until settled and wakes them before signals. New check C-STK-05 (a review steer 25 h later). T-FLW-11 depends on it. |
| F-03 | Fixed. Setup step 0 is Address (§16.2). The manifest redirect is the setup origin (§12.1.1). The API claim is deleted, and Settings shows the manual fix (§16.3.3). |
| F-04 | Fixed. App-agent turns, including dispatch, run on the host with a host-minted delegated credential. The browser gets only UI-only instructions, and the bearer rule is deleted (§15.1.4). |
| F-05 | Fixed. `wake_reconcile()` was added to §9.1.2. |
| F-06 | Fixed. Shared topics carry shared state only, and member topics are `confirmations:<member>` and `view:<member>:<branch>` (§7.2.2). |
| F-07 | Fixed. The thin path is INS-01 → INS-02 → ACC-01 (App credentials from env) → STK-01 → STK-04, about 2 calendar weeks with three lanes. T-ACC-01 starts on day 1. T-FLW-11 replaces the four-run path inside S1. |
| F-08 | Fixed. The daemon-context spike is in T-INS-03 (W0), and §16.1.2 states the one `sudo`. |
| F-09 | Forwarded to the lead engineer for the in-flight T-MCH-02 (#3437): two VMs sharing one home, plus `msb`'s mount capability. |
| F-10 | Fixed. The issue-events stream was added to §12.2. |
| F-11 | Fixed. The delta row now says "build". T-GH-05 owns it. |
| F-12 | Fixed. The S1 terminal token scope list is in §8.11.1. New check C-SEC-05. |
| F-13 | T-APP-15 is resized to L. |
| F-14 | Fixed. §7.6 names the S1 writer (the agent write tool), and the route is contract-only until S3. |
| F-15 | Superseded by M-33 (Bring in / Discard). Discard leases against the observed foreign SHA. |
| F-16 | Moot (inotify). Presence `where` uses the last write. |
| F-17 | Fixed. Summaries refresh only while someone has the timeline on screen (§14.5.3). |
| F-18 | Fixed (§10.7.1, and the §4.1 guard). |
| F-19 | Fixed. One reopen rule (§4.1, §12.3). |
| F-20 | Fixed. `/review` on a foreign PR uses a background ephemeral machine (§12.3). |
| F-21 | Fixed. A closure includes imported overridable flows (§11.3.0). |
| F-22 | Fixed. Check cadence after a merge is specified (§12.2.1a). The C-GH-08 scenario gets pending checks in the sweep. |
| F-23 | Fixed. T-REL-03 is "S1, S3", C-CUT-01 is "S1, S2", and T-COL-07 depends on T-COL-10. |
| F-24 | Fixed. T-GH-01a is folded into T-GH-01, and the README counts are refreshed. |
| F-25 | Fixed. Stale words removed. Sections reordered without renumbering, so citations stay valid. |
| F-26 | Fixed. Eight delta citations corrected. T-TRM-02 adds the `SMITHERS_TOKEN_FILE` reader. |
| F-27 | Goes to T-INS-06 in the sweep: enable the subscription pool behind the owner setting. |
| F-28 | Fixed. In-card Sleep and Wake on the Branch card (§14.3). |
| F-29 | Fixed. New checks C-SEC-04, C-STK-04 and C-COL-02. C-UI-01 → T-REL-02, and C-UI-02 → T-CAT-01. |
| F-30 | Fixed. C-STK-01 now tests the projection exhaustively plus the engine guards. |
| F-31 | Fixed. C-PERF-01's clock starts at submit. |
| F-32 | Fixed. The critical path is restated in overview and the index. |
| F-33 | Fixed. Presence is unknown for 30 s after a host start, with no releases in that window (§7.3.0). |
| F-34 | Fixed. The default `parallel` is `max(1, capacity − 1)` (§10.3.1). |
| F-35 | Fixed. Secrets with declared hosts stay egress-bound (§8.8.0). |
| F-36 | Fixed. The install key is in secrets.json, and sealed blobs are in PostgreSQL (§17.4). |
| F-37 | Fixed. Snapshot latency is measured in T-COL-01, with a weekly op-abandon policy (§9.1.2a). |
| F-38 | Fixed. Yrs state persists on the machine disk outside the working copy (§9.2.5). |
| F-39 | Fixed. T-ACC-01 starts on day 1 (see F-07). |
| F-40 | Fixed. C-CAT-01 excludes repository-flow doors. |
