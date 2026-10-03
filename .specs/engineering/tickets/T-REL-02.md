# T-REL-02 Journey recordings J1–J8, J10 and J11 on a fresh Mac mini (mvp.md §12 item 1)

Stage R · Size M · Depends on T-ACC-01, T-ACC-02, T-ACC-03, T-ACC-04, T-ACC-05, T-ACC-06, T-ACC-07, T-AGT-01, T-AGT-02, T-AGT-03, T-APP-01, T-APP-02, T-APP-03, T-APP-04, T-APP-05, T-APP-06, T-APP-07, T-APP-08, T-APP-09, T-APP-10, T-APP-11, T-APP-12, T-APP-13, T-APP-14, T-APP-14a, T-APP-15, T-APP-16, T-APP-17, T-APP-18, T-APP-19, T-APP-20, T-APP-21, T-APP-22, T-APP-23, T-CAT-01, T-CAT-02, T-CAT-03, T-COL-02, T-COL-03, T-COL-03a, T-COL-03f, T-COL-03r, T-COL-04, T-COL-04a, T-COL-05, T-COL-06, T-COL-07, T-COL-08, T-COL-08a, T-COL-08b, T-COL-09, T-COL-10, T-COL-12, T-CUT-01, T-CUT-02, T-CUT-03, T-CUT-04, T-DOC-02, T-DOC-04, T-FLW-01, T-FLW-02, T-FLW-03, T-FLW-04, T-FLW-05, T-FLW-06, T-FLW-07, T-FLW-08, T-FLW-09, T-FLW-10, T-FLW-11, T-FLW-12, T-FLW-13, T-GH-01, T-GH-02, T-GH-03, T-GH-04, T-GH-05, T-GH-06, T-GH-07, T-GH-08, T-GH-09, T-GH-10, T-GH-11, T-GH-12, T-GH-13, T-GH-14, T-INS-01, T-INS-02, T-INS-04, T-INS-06, T-INS-08, T-INS-09, T-MCH-01, T-MCH-04, T-MCH-05, T-MCH-06, T-MCH-07, T-MCH-08, T-MCH-09, T-MCH-10, T-MCH-11, T-MCH-12, T-MCH-14, T-MCH-15, T-PRC-01, T-PRC-02, T-PRC-03, T-REL-03, T-REL-04, T-STK-01, T-STK-02, T-STK-03, T-STK-04, T-STK-05, T-STK-06, T-STK-07, T-STK-08, T-STK-09, T-STK-10, T-STK-11, T-STK-12, T-STK-13, T-STK-14, T-STK-15, T-TRM-01, T-TRM-02, T-TRM-03, T-TRM-04, T-TRM-05, T-TRM-07, T-UI-01, T-UI-02, T-UI-03, T-UI-04, T-UI-05, T-UI-06, T-UI-07, T-UI-08, T-UI-09, T-UI-10, T-UI-11, T-UI-12, T-UI-13, T-UI-14, T-UI-15, T-UI-16, T-UI-17, T-UI-18, T-UI-19, T-UI-20, T-UI-21, T-UI-22, T-UI-23 · Unblocks — · Issue: [#3445](https://github.com/smithersai/smithers/issues/3445)
Spec: spec.md §1.2, §6.2.1, §7.6, §9.2, §9.3.4, §16, §16.3.1, §19, §21 (Journey row) · Delta: none (release) · Product: mvp.md §12.1, §5 J1–J8, J10 and J11, §10 Activation

## Goal
A recording on an erased Mac mini plays J1 to J8, J10 and J11 end to end, in both themes, against a fresh `smithers-mvp-canary/<date>` repository (§21, mvp.md §12.1). It includes a restart mid-run, a duplicate launch, an outside save landing on a file two people are typing in, a wiki decision edit that the next plan follows, and recovery receipts. It is the release gate.

## Scope
In:
- The 24 h credential soak (C-REL-05) with Ben's live Claude Code, Codex and `gh` logins on two machines, run on the same host before the recordings.
- A harness that prepares the run: the scratch repository from a template, three GitHub accounts (owner, Ben as Maintainer, Alice as Member), and a step log with UTC timestamps.
- Teammate actions on GitHub through the API as those accounts: a review comment (J10.2), a laptop push to a TODO branch (J10.3), an unrelated merge (J10.4), a merge on GitHub (J10.5), a network drop for the sync row (J10.6).
- The §21 extras:
  - restart mid-run: `kill -9` of the backend while a TODO is working; the launcher restarts it (§1.2), and the recording shows no completed step re-run and the run's recovery receipt (§19.1);
  - duplicate launch: the same command sent twice with one `Idempotency-Key`, and a double activation of one button; one TODO or run results, and the repeat returns the original result (§6.2.1);
  - outside save: Ben and Alice type in one file's File card while the owner's SSH session saves to the same file twice, once on lines neither is typing and once on a line they are. No agent session is active. The first save merges into the document attributed to the owner via SSH, the only active session (§9.3.1); the second leaves the document's text on disk, snapshots the outside version, and flags the file "Changed outside Smithers · Compare", and Compare shows that version (§9.2.3). Both typists' acknowledged saves survive (§9.2.3a);
  - wiki decision: a member edits a wiki page to record a decision; the next TODO's plan cites that page revision (`{slug, revision, digest}`, §13.4) and its change follows the decision.
- Both themes: J1–J8, J10 and J11 each runs once in light and once in dark; screenshots of every card the journey touches in both.
- Screen recording of the host and the browser Mac, Playwright video and trace per browser step, and every receipt in the evidence directory of the check it proves.
- The install comes from the released tap with `smthrs host start` (C-REL-02 setup) and is reached from a second laptop at a public origin the owner set in Settings (§16.3.1; any host, http or https); the run records which origin.
- Keyboard-only passes of the P0 journeys supply the evidence for C-UI-01, which this ticket owns.

Out:
- J9 (P1, its own check). The alpha teams (mvp.md §10). Fixture-backed or scripted-model runs: they do not pass a journey check (checks/README.md).

## Changes
- `scripts/journeys/run.mjs`, `scripts/journeys/canary-repo.mjs`, `scripts/journeys/github-actors.mjs`, `scripts/journeys/record.mjs`, `scripts/journeys/outside-save.mjs` (new). `run.mjs` takes `--theme light|dark`.
- Template repository `smithers-mvp-canary/template` (new): a small project with a test command the toolchain detector finds and no `.smithers/` files, plus `JOURNEY.md` holding the fixed prompts and the wiki decision text.
- No product code. `apps/site/scripts/journeys/` (marketing captures with a scripted model) is not reused.

## Tests
- Unit `scripts/journeys/run.test.mjs`: repository naming, step log format, both themes scheduled for every journey, refusal to run against an install that has a scripted model configured.
- The journeys themselves are the checks below.

## Acceptance




- [C-J1-01](../checks/C-J1-01.md): Homebrew install to the setup card on the erased Mac, recorded.
- [C-J1-04](../checks/C-J1-04.md): first TODO to a merged PR, unassisted, within 60 minutes, recorded.
- The other checks of J1 to J8, J10 and J11 re-run on this install in both themes, with their evidence linked from this recording: C-J1-02, C-J1-03, C-J1-05, C-J1-06, C-J2-01 to C-J2-05, C-J3-01 to C-J3-06, C-J3-08 to C-J3-10, C-J4-01 to C-J4-03, C-J5-01 to C-J5-03, C-J6-01, C-J6-02, C-J7-01 to C-J7-03, C-J8-01 to C-J8-06, C-J10-01 to C-J10-09, C-J11-01 to C-J11-04.
- [C-UI-01](../checks/C-UI-01.md): every P0 journey completes keyboard-only.
- [C-REL-05](../checks/C-REL-05.md): 24 h soak with live Claude Code, Codex and `gh` logins on two machines: no login prompt

## Risks and notes
- Replaced-edit flags are deferred (§9.3.7), so the recording shows no "Ben's save replaced Alice's edit" line. Observation that fails the run: an outside save over a newer edit that no snapshot can restore.
- Three GitHub accounts with write access to `smithers-mvp-canary` are needed. Observation that blocks the run: a 2FA or rate-limit prompt mid-recording. Use dedicated test accounts with stored tokens.
- Erasing a Mac mini per run takes time, and both themes double the journey time. Observation: setup time dominates the schedule. Erase All Content and Settings is the minimum; record the macOS build.
