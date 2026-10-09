# Prerelease status

```
Updated       2026-10-08 17:50 PDT
main          dd4042aeeb when written

Publish       CANNOT PUBLISH YET. Dry run #7 failed in the smoke. Fix and #8 pending.
Real install  RUNNING on this MacBook, bundle built here from 3fc44ee1e8.
              All seven setup steps done 16:55 PDT. TODO T1 created 16:57 PDT.
              T1 never got a machine: every first machine start blocked itself
              in PostgreSQL for 15 minutes. Fixed on main, 2d1f60faf0 (17:37
              PDT). Not yet proven: the fix is going into the local bundle now.
              No TODO has reached a pull request on a real install.
Broken        1. A stalled machine start shows "Starting" on Home, with no Retry
                 for 15 minutes.
              2. During a machine start a chat view save can answer 503 and a
                 sign-in can wait (#3759).
              3. A machine start misses a workspace deleted meanwhile (#3759).
              4. The bundle README's setup-link format differs from start's output.
Fixed on main Unverified on a real install until a rebuilt bundle runs: the
              setup card hidden through the first four steps (c5120a5856), the
              stale sign-in cookie (9a218b7f68), the joined words in Model
              access and raw JSON on reopening /setup (88b768b019).
Real machine  The machine daemon works in a real VM on main (99a4356a1a).
Journeys      Last full pass, main 70d75088ef: 10 of 11 have no failed row, on
              Linux fixtures. Red: J10 row 6. On c5120a5856, J1 to J6 have no
              failed row; J7 failed four rows, then passed its second attempt.
              J7 and J10 are rerunning on current main since 17:44 PDT.
Doneish       No. It needs the install run to take a TODO to a merged PR, and
              all 11 journeys passing on one commit.
Dry runs      Version 1.0.0-rc.1. None is green. #7 37862357655 on 4556117406
              failed in the smoke at the CLI containment check, on the Linux
              runner only; every earlier check passed. The four installed-CLI
              jobs have not run in any Release run.
Tag push      Publishes npm under `next` and nothing else. No publish after a
              failed build, pack or smoke. Homebrew and installer signing are
              skipped. No GitHub Release. (smithers-8a read it at 86881fe0d0.)

Ships         npm packages under `next`. The Apple Silicon server bundle is an
              artifact of the tag's Release run. No Homebrew. No public download.
To try it     Apple Silicon Mac, macOS 15 or later, a GitHub login for `gh`, and
              44 GiB free on your home volume until the owner has signed in
              (refused at 39.19, started at 44.77). Commands: section 6.
No mini/Cloud The Mac mini is offline (Will, today). Cloud cannot run a TODO.

Needs Will    Now: nothing required. Optional: say yes to using your model keys
              if the install run should also run a TODO with a real model.
              When a dry run is green on the final cut: the tag push, section 6.
```

## 1. What works

**On a real install.** This MacBook, bundle built here from 3fc44ee1e8. Source: the install run's reports through 17:46 PDT.

- With 39.19 GiB free, `./bin/smthrs host start --bundle .` refuses once: `host_capacity_zero ... 44 GiB required`. No restart loop.
- With 44.77 GiB free it starts (16:18 PDT). `host status` reads ready and `/readyz` answers 200.
- All seven setup steps are done (16:55 PDT): address, GitHub App, owner sign-in, repository, models, source, machine.
- A TODO can be created (T1, 16:57 PDT). It did not get a machine (section 3).

**In a real VM.** At 99a4356a1a the machine daemon starts, admits its session and lands reads and writes, and the agent's git and jj work afterwards. A development run on this MacBook, no workarounds (Detail B).

**On Linux fixtures, full pass on main 70d75088ef.** Each journey suite walks one install through its public routes with real PostgreSQL, a GitHub fake, a scripted coding model, and the coding agent as a host process. No microVM. Pending means the row is written and not run. One line per journey: Detail A.

```
      pass fail pending  a person can
J1     21    0     0     install, set up, merge a first TODO, add members
J2     14    0     0     turn an issue into a TODO, answer it, merge its PR
J3     14    0     5     open a TODO's branch, answer or steer the agent
J4     23    0     2     answer, merge, move and retry from Home while chatting
J5     20    0     0     change the TODO flow through a merged TODO
J6      4    0    16     nothing yet: every terminal and own-agent row is pending
J7     19    0     2     insert, amend, fork and drop TODOs; conflicts
J8      6    0     3     co-edit a wiki page, sync it to Obsidian
J9     12    0     1     ask the repository, make a TODO, save to wiki
J10    35    1     4     work a TODO's PR from GitHub
J11    19    0     0     inspect a merged TODO's run
All   187    1    33
```

On c5120a5856 the board has J1 to J6 with the same counts. J7's first attempt failed rows 16, 18, 19 and 20: a rebase stayed pending after `main` moved. Its second attempt passed 19/0/2. J7 and J10 are rerunning on current main since 17:44 PDT.

## 2. Off

Two features ship switched off because of a known hole (ruled by smithers-8a).

| Feature | Switch | A person sees instead |
|---|---|---|
| File card code intelligence | `lspConfinementReceipt` is empty, `packages/backend/internal/compose/language_servers.go:19` | The File card shows the file's text. No hover, go to definition or diagnostics. |
| Live code co-editing | `LiveCodeDocuments` is unset, `packages/backend/internal/compose/main.go:199` | File cards are read-only. Edits come from a terminal, SSH or the coding agent. Wiki co-editing is on. |

## 3. Broken

### Real install

| | Defect | State |
|---|---|---|
| 1 | A machine start that stalls shows "Starting" on Home with no Retry until its 15-minute deadline. The queued "Refresh wiki" row has no button unless it has failed. | Open |
| 2 | During a machine start, a chat view save can answer 503 and a sign-in can wait. Member rows stay locked for the whole start. | Open, [#3759](https://github.com/smithersai/smithers/issues/3759) |
| 3 | A machine start does not notice a workspace deleted while it is being admitted. | Open, [#3759](https://github.com/smithersai/smithers/issues/3759) |
| 4 | The bundle's README promises one JSON line of setup links. `host start` prints two bare lines. | Open |

Fixed on main, unverified on a real install until a rebuilt bundle runs:

| | Defect | Fix |
|---|---|---|
| 5 | Every first machine start blocked itself in PostgreSQL for 15 minutes, so T1 never got a machine. | 2d1f60faf0 (17:37 PDT). Going into the local bundle now. |
| 6 | The setup card stayed hidden through the first four setup steps. | c5120a5856 |
| 7 | The app's sign-in path answered 404 on an install. | 9a218b7f68 |
| 8 | A sign-in cookie left by an earlier install on the same address blocked the setup link with 401. | 9a218b7f68 |
| 9 | Model access read "Not signed incoding model". Reopening `/setup` after setup closed showed raw JSON. | 88b768b019 |

### Journey rows

- **J10 row 6** was red on the last full board pass (70d75088ef): sync stayed stale 10 s after Retry. Lane fr18's Linux reruns pass J10 36/0/4 with be293254c0, 5e1bc3c020 and 50a1a5eb91. The board has not rerun J10 on current main yet.
- **J7** failed rows 16, 18, 19 and 20 on its first attempt at c5120a5856 and passed its second. Rerunning on current main.
- `source_refused` is fixed (f9d3b72e29, ba1a27bc91), and each refusal names its reason (7a2c228bfa, a64960b9c3). Rows fixed today: Detail G.

### Real VM

- One part of the real-VM conformance test failed at 99a4356a1a: `head`. The test expected plain-git head rules in a jj workspace. 992ca6aa8b changes that check. Real-VM rerun: not checked.

### Release

- No Release run has passed the installed-package smoke. Dry runs #3, #4 and #5 each failed on one stale fixture. Dry run #7 passed install, 49 imports, public API and history, then failed at the CLI containment check on the Linux runner: "Invalid fixture PID: 1", then a kill of PID 2 refused. Reading: the test records a process ID from inside the tool's own process namespace and treats it as a host ID. It is being reproduced on Linux.
- The smoke found a product bug: `smithers-build` (`@smthrs/build-cli`) could not start in any installed project since #3093. Fixed in 06209aa7b1.

## 4. Unverified

- **TODO to merged PR on the real install: not yet run.** No TODO has reached a pull request on a real install. Remaining:
  1. Run the install on a bundle rebuilt with 2d1f60faf0, then take a TODO to a merged PR with the scripted model.
  2. A TODO with a real model under the production launcher, only if Will says yes to using his keys. Not received.
- **API baseline drift on `@smthrs/cli`** is unreviewed. The Release run reports it and does not block on it.
- **The four installed-CLI jobs** have not run in any Release run.
- **Not yet exercised in a real VM:** the coding agent as a daemon session, member terminals, capture, sleep and wake.
- **The eight real-machine fixes** await smithers-3f's review (Detail B).
- **Disk per machine.** Measured: 0.74 GiB for a running machine holding the Smithers repository. A working machine with dependencies installed is estimated at about 15 GiB; not measured.
- **Waiting on smithers-3f** (Detail E): three guest-helper questions, learning machine isolation (T-FLW-06), and wire protocols 7 to 12.
- **Mac mini and Cloud.** Nothing has run on the Mac mini. Smithers Cloud admits no TODO (`packages/backend/internal/compose/main.go:1370-1377`).
- **80 tickets** have code on main and no real-machine run (Detail C). 33 journey rows are pending (Detail A).
- **Sign-offs and the Mac mini schedule** serve Done, not this prerelease. No sign-off is done and the schedule is stopped.

## 5. Not in this prerelease

- **Homebrew install.** The job does not run for a suffixed version. It needs check runs from the Mac mini, a `HOMEBREW_TAP_TOKEN` secret and a `homebrew-publish` environment. None exists.
- **A public bundle download.** The bundle is a GitHub Actions artifact. It needs a GitHub login and expires after 90 days.
- **A GitHub Release and installer archives.** Nothing publishes them.
- **Not started, after launch (11 tickets).** T-MNT-01 to 05: maintainers with outside contributors. T-AGT-04: the internal `/ceo` flow. T-RMT-01 to 05: machines on remote Linux hosts and Cloud boxes.
- **Still being built (25 tickets).** Detail D.

## 6. Publish

**Cannot publish yet.** No dry run is green. The fix for #7 and dry run #8 are pending. Sources: `~/smithers-lanes/release/STATE.md` (updated 17:02 PDT) and the lead's report at 17:46 PDT.

Every dry run and why it failed: Detail H.

### Before the tag

1. A dry run is green: build, pack, smoke, the bundle upload and the four installed-CLI jobs. #8 is the next that can be.
2. A final cut lands tonight on top of the real-machine, disk floor and install-run fixes. Every commit after a cut makes its changelog section stale.
3. One last dry run passes on that commit.
4. The tag goes on that commit.

### Known risks

1. The publish step runs for the first time on the tag. No dry run can run it.
2. 37 of the 49 npm names are new to npm. The `NPM_TOKEN` login is valid today (run 37840712277). Whether it may create the 37 new `@smthrs/*` names could not be determined (run 37844231677). If it may not, the publish stops at the first package, `@smthrs/canonical`, and nothing reaches `next`. The fix takes minutes and needs Will: Detail F.
3. The four installed-CLI jobs have not run in any Release run. Since 184c226a80 they start when the build, pack and smoke lane ends, about 55 minutes into a run, instead of after the report-only gates, which take hours.
4. The download commands below have not been run against a tag run's artifact.
5. This MacBook's `gh` token cannot push workflow files. Whether it can push the tag: not checked. `gh auth refresh -h github.com -s workflow` removes the doubt.

### Commands

Publish, after the last dry run is green:

```sh
cd ~/smithers
SHA=<full SHA of the final cut>   # STATE.md names it
git fetch origin main
git tag -a v1.0.0-rc.1 -m "🔖 release: 1.0.0-rc.1" "$SHA"
git push origin v1.0.0-rc.1       # this publishes to npm under `next`
npm view smthrs dist-tags         # expect next = 1.0.0-rc.1, latest = 0.35.0
```

Try it, on a Mac with 44 GiB free. Use a macOS account with no Smithers state. Have GitHub repository admin access, a provider key and an AI Gateway key ready.

```sh
npm install -g smthrs@next                     # after the tag run publishes
RUN=<the tag's Release run id>                # today: 37846701537, dry run #4's bundle
gh run download "$RUN" --repo smithersai/smithers -n server-bundle-darwin-arm64 -D ~/smithers-bundle/download
mkdir -p ~/smithers-bundle/1.0.0-rc.1
tar -xzf ~/smithers-bundle/download/smithers-server.tar.gz -C ~/smithers-bundle/1.0.0-rc.1
smthrs host start --bundle ~/smithers-bundle/1.0.0-rc.1   # prints the setup link
```

Keep the unpacked directory in place: the service runs from it. If the Release run fails after some packages published, do not re-run it. Resume it: Detail F.

## Detail

```
Tickets: 151, audited 2026-10-08 noon
Nothing left to do            22  ████
Person action left            13  ███
On main, no real-machine run  80  ████████████████
Being built                   25  █████
Not started, after launch     11  ██
```

### A. Journeys, one line each

| | A person can |
|---|---|
| J1 | Open the setup link, set the address, create the GitHub App, sign in as owner, pick the repository, set model access, ask about the code, file a first TODO, merge its PR, add members. |
| J2 | Turn a GitHub issue into a TODO with Make TODO or the `todo` label, answer its question, read the PR's evidence, merge it, see the issue close. |
| J3 | Open a TODO's branch from Needs you, see who is in a file, answer or steer the coding agent. Not run: own terminal, saves over SSH, two people typing in one file. |
| J4 | Read Home counts, answer and merge while chatting, move a ready TODO up, retry a failed TODO with a steer. |
| J5 | Ask the app agent to change the TODO flow, merge the edit as a TODO, see the new version Active. New TODOs use it. A broken flow keeps the previous version. A TODO that waited on an answer resumes on its own version. |
| J6 | Nothing a person does in J6 has run. The 4 passing rows are the install, a TODO working and two refusals. Not run: a branch terminal, `claude` or `codex` signed in, the Smithers skill, "Claude Code for Ben". |
| J7 | Insert a TODO before another, amend a TODO's prompt, fork to a scratch branch, drop a TODO, see `main` move, resolve a conflict. Not run: Add to stack after T2, the new TODO keeping T2's work. |
| J8 | Merge a TODO and get a learning run admitted, co-edit a wiki page with a teammate, sync the wiki to an Obsidian folder. Not run: the learning run writing the decision page, the next plan citing the edited page. |
| J9 | Ask where code lives, get file and wiki cards, make a TODO from the answer, save the answer to the wiki. Not run: the two buttons shown on the answer. |
| J10 | See a TODO's PR on GitHub with its prompt and evidence. A review comment becomes a steer. A teammate's push holds the agent, with Bring in and Discard. Merge or close on GitHub and the TODO follows. The next TODO follows a merge. `/review` a teammate's PR. Retry recovers after an outage. |
| J11 | Open Inspect on a merged TODO's run: graph, each step's input, output and transcript, retries, the wait for an answer, tokens, time and cost per step. No rows exist for editing a flow's source, a test Run or switching a step's model. |

### B. Real-machine fixes

Each was found in a real microVM on this MacBook. The daemon had never started in a real machine on main. Source: `~/smithers-lanes/release/REAL-RUN.md`, updated 14:02 PDT. None has smithers-3f's review.

| # | Defect | Fix |
|---|---|---|
| 1 | The guest helper lost the read and write that egress secrets and managed hosts use. | b596ce787b |
| 2 | The guest helper refused the boot file the host writes, so the daemon never booted. | 0889378440 |
| 3 | The helper needs `/run` on tmpfs. The guest had none. | 88e7f6521c |
| 4 | The broker enabled `+cpu +pids`. The guest's root cgroup delegates no controllers, so the broker exited. | 8bee21cb30 |
| 5 | jj wrote the repository 0600. The daemon's user and the agent's user could not read each other's writes. | 42b5401381 |
| 6 | The daemon's git refused `/workspace` as dubious ownership. | d194fd78bf |
| 7 | A write to a new file in a new directory failed. | 5b7d0ed4d5 |
| 8 | Files the daemon created were not writable by the agent. | 99a4356a1a |

Also landed: 5e1a8748b5 moved tests off the removed guest read and write. 3fc44ee1e8 (shared daemon repository and replacement writes) landed after the proof and has not run in a real VM.

### C. Code on main, no real-machine run (80 tickets)

| Area | Tickets | Not run on a real machine |
|---|---|---|
| Sign-in and members | T-ACC-01, 02, 04 | Owner claim through the packaged relay. Removing a member ends their sessions within 5 s. |
| Own agents | T-AGT-01 | A member's Claude Code session captured in a machine. |
| App cards | T-APP-01 to 07, 09, 11, 12, 14 to 17, 20, 24 | Every card on an installed app, from setup on an erased Mac to docs in WebKit. |
| Working together | T-COL-02, 03a, 04, 04a, 05, 06, 08 to 12 | Live updates timed with a second Mac. The machine daemon under freeze and kill. Presence over SSH and VS Code. |
| Flows | T-FLW-01 to 05, 07 to 13 | Flow load, pinning, activation and retry inside a microVM. Recovery at kill points. Review in a background machine. |
| GitHub | T-GH-01 to 04, 06, 07, 09 | Everything against GitHub.com. |
| Install | T-INS-01 to 06, 08 | Bundle assembly, Homebrew signing and bottle, launchd start and reboot, setup on a wiped Mac. |
| Machines | T-MCH-01, 04, 07, 09 to 12, 14, 16 | Sizing on 24 and 32 GB Macs, 60 joins to one machine, sleep, cleanup, member unix users, secrets. |
| Stack | T-STK-02, 03, 09, 12 | Placement, parallel admission and issue to TODO, in a microVM against GitHub.com. |
| Terminals and SSH | T-TRM-01, 03, 07 | Only the owner types. SSH shell, SFTP and port forwarding. VS Code on a second Mac. |
| Security and gates | T-SEC-01, T-PRC-02 | Guest root boundary. Migration gate under the generator user. |
| Release evidence | T-REL-02, T-REL-04 | Journey recordings on a fresh macOS account. Kill-point fault suite. 24-hour credential soak. |
| Removed surfaces, docs, visuals | T-CUT-01, T-DOC-01, T-UI-19 | Deferred doors on a fresh install. Quickstart on the mini. Co-editing visuals timing. |

### D. Still being built (25 tickets)

| Area | Tickets | Missing today |
|---|---|---|
| Access | T-ACC-03 | One permission check over every command. |
| Own agents and terminals | T-AGT-02, T-AGT-03, T-TRM-02, T-TRM-05, T-TRM-06 | A member's Claude Code or Codex session shown on the branch. Terminal sign-in and the Smithers skill. The coding agent's shell in the Terminal card. VS Code Remote. |
| Stack | T-STK-01, 04, 06, 08, T-MCH-08 | Ordered multi-TODO merge with pre-approval. Scratch Rebase and Done. Fork, Drop and Add to stack on a live child. |
| Branch card | T-APP-10 | Scratch Rebase and Done. Waiting, rebasing and frozen states. |
| App | T-APP-21, T-CAT-01 | `/debug-api` on a real install. Command placement and unlisted commands. |
| Machines | T-MCH-06, T-COL-03 | Admission order and safe idle. The daemon on hosted machines. |
| Learning | T-FLW-06 | The lint proposal diff and its 3-of-5 evidence. |
| Install | T-INS-07, T-CUT-02, T-CUT-03 | `smthrs host upgrade`, `backup` and `restore`. Removal of the old health handler. Grants for hidden surfaces. |
| Release | T-REL-01, T-REL-03, T-PRC-01 | Install metrics always report unavailable. Alpha scorecard. Package-wide gate evidence. |
| Fast model | T-FM-02 | The Smithers fast-model gateway is not deployed. The quota is undecided. |

### E. Unverified lines in full

- TODO controls (T-STK-05): Stop/Resume, both Retry pins, retained-capture Drop/recovery, Fork/Add/Drop and reopened-input restart pass the composed Linux install proofs on main. Drop acknowledges within 1 s and releases its machine within 60 s. Real microVM, Mac bundle/launchd, reference-host and owner qualification remain unverified; the process fixture proves orchestration only. J7 scratch rows 13/14 remain pending under T-MCH-08.

- Learning machine isolation (T-FLW-06): no 3f review, no reference-host run; relies on sandboxed isolation and no source publisher on the learning workspace.
- Guest helper change b596ce787b (`state-read`/`state-write`): three questions are open with smithers-3f. Which uid runs them, and can a repository-code uid write under `/var/lib/smithers/state`? Who creates `managed-hosts/<sha>/`, and with what mode? Does the read need `O_NOFOLLOW`? The host checks `binding.json` by ID, so a forged file only refuses its own machine.
- Machine daemon wire protocols 7 to 12 await smithers-3f's delta reviews.
- Disk per machine, measured in a real VM with a 32 GiB sparse root disk: a fresh running machine allocates 13.5 MiB; with the Smithers source tree committed, 739 MiB; a TODO-sized commit adds 7.4 MiB. The base image layers, 1.33 GiB, are shared once. Not in these numbers: full git history, environment layers, installed dependencies and build output.

### F. Resume a failed publish

If `NPM_TOKEN` may not create the new names: Will creates an npm token with read and write on the `@smthrs` scope and sets it with `gh secret set NPM_TOKEN --repo smithersai/smithers`. Then the same candidate is resumed. Do not re-run the failed run and do not push the tag again. From `scripts/release-resume.md` and `STATE.md`:

```sh
RUN=<failed run id>
ART=$(gh api "repos/smithersai/smithers/actions/runs/$RUN/artifacts" \
  --jq ".artifacts[] | select(.name==\"release-candidate-$RUN\") | .id")
gh workflow run release.yml --ref main \
  -f releaseTag=v1.0.0-rc.1 -f candidateRunId="$RUN" -f candidateArtifactId="$ART" -F dryRun=false
```

### G. Journey rows fixed today

Earlier rows are green on the full pass at 70d75088ef. The newer lane fr18 reruns above also verify J10 Retry and merge-following.

| | Rows | Error | Fix |
|---|---|---|---|
| J4 | 12 Move T4 above T3 | The move answered 409 "TODO moved; try again". | d9bdb772e2 |
| J5, J7, J3, J4 | every row after a TODO reached review | `coding/NativeCodingError/source_refused`. The server's real answer was 409 "stack operation request changed": PostgreSQL JSONB reorders a plan's nested keys and a byte comparison refused an identical plan. | f9d3b72e29, ba1a27bc91 |
| J10 | 5 T2 follows T1's merge | The next TODO did not follow a merge within 8 minutes. | 9bb8cd3f9c |
| J10 | 6 Retry after an outage | Sync stayed stale after Retry. | be293254c0, 5e1bc3c020; fresh 0 s after Retry in the lane rerun. |
| J7 | 15 Drop T2 | A dropped TODO kept its machine after 60 s. | 09e889efce |
| J4 | 17 T2 ready after T1 merges | T2's PR still contained T1's file. | Green on the board. Fix commit: not checked. |

### H. Dry runs

| # | Run | Result |
|---|---|---|
| 1, 2 | 37837413419, 37842512795 | Old workflow. Stale changelog section; the Mac bundle upload found no files (fixed in 86881fe0d0). |
| 3, 4, 5 | 37843714479, 37846701537, 37858229125 | Build and pack passed. Each failed the installed-package smoke on one stale fixture (fixed in 0489b1c08c, a3e6ac767e, 06209aa7b1). #3 and #4 delivered the first Mac bundle artifacts. |
| 6 | 37860903519 | Cancelled before its smoke; superseded. |
| 7 | 37862357655 | On 4556117406. Mac bundle and native helpers passed. The smoke failed at the CLI containment check, on the Linux runner only. |
| 8 | pending | Waits for the containment fix. |
