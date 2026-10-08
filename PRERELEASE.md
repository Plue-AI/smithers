# Prerelease status

```
Updated       2026-10-08 14:06 PDT
main          992ca6aa8b when written

Real machine  The machine daemon starts, admits its session and lands writes in
              a real VM on main. Proven on this MacBook at 99a4356a1a. All
              eight defects found today are fixed.
Real install  NOT YET PROVEN. No TODO has run on a real install. The install
              run on this MacBook is building its bundle.
Journeys      7 of 11 have no failed row, on Linux fixtures, at d0b0c7b2f0.
              Red (pass/fail/pending): J4 22/1/2, J5 18/2/0, J7 11/4/6, J10 35/1/4.
              Those four are rerunning on main 4881e80270 since 14:02 PDT.
Doneish       No. It needs one real install that takes a TODO to a merged PR, and
              all 11 journeys passing on one commit. Neither exists.
Dry run       NOT GREEN. Version 1.0.0-rc.1, cut 4cac606955.
              #1 37837413419 failed: changelog gate, and the Mac bundle was
              never uploaded (hidden directory). Fixed on main, 86881fe0d0.
              #2 37842512795 and #3 37843714479 are running on the cut.
              #3 is the first that can deliver the bundle.
Tag push      Publishes npm under `next` and nothing else. It cannot publish
              after a failed build, pack or smoke. Homebrew and installer
              signing are skipped. No GitHub Release is created.
              (smithers-8a read the workflow at 86881fe0d0.)

Ships         npm packages under `next`. The Apple Silicon server bundle is an
              artifact of the tag's Release run. No Homebrew. No public download.
To try it     Apple Silicon Mac, macOS 15 or later, a GitHub login for `gh`, and
              44 GiB free on your home volume for one machine (76 for two)
              until the owner has signed in. With less, a fresh install
              refuses to start (`host_capacity_zero`). Commands: section 6.
No Mac mini   The Mac mini will not be online (Will, today).
No Cloud      Smithers Cloud cannot run a TODO.
Real run      One, on this MacBook: 37 GiB free now. It clears caches to hold
              44 for the first start.

Needs Will    Now: nothing.
              When the last dry run is green: the tag push under Publish.
```

## 1. What works

**In a real VM.** A development run on this MacBook at 99a4356a1a, with no workarounds: the agent initializes the repository, the daemon starts and admits its session, reads and compared writes land through it, nested and parallel writes land, and stop, reopen, restart and a cold snapshot fork pass. The agent edits a daemon-created file in place, and its git commit and jj work afterwards. This is the daemon path, not an install.

**On Linux fixtures.** Each journey suite walks one install through its public routes with real PostgreSQL, a GitHub fake, a scripted coding model, and the coding agent as a host process. No microVM. Pending means the row is written and not run. One line per journey on what a person can do: Detail A.

```
      pass fail pending  commit      a person can
J1     21    0     0     d0b0c7b2f0  install, set up, merge a first TODO, add members
J2     14    0     0     d0b0c7b2f0  turn an issue into a TODO, answer it, merge its PR
J3     14    0     5     d0b0c7b2f0  open a TODO's branch, answer or steer the agent
J4     22    1     2     d0b0c7b2f0  answer, merge and retry from Home while chatting
J5     18    2     0     d0b0c7b2f0  change the TODO flow through a merged TODO
J6      4    0    16     d0b0c7b2f0  nothing yet: every terminal and own-agent row is pending
J7     11    4     6     d0b0c7b2f0  insert, amend and drop TODOs
J8      6    0     3     d0b0c7b2f0  co-edit a wiki page, sync it to Obsidian
J9     12    0     1     d0b0c7b2f0  ask the repository, make a TODO, save to wiki
J10    35    1     4     d0b0c7b2f0  work a TODO's PR from GitHub
J11    19    0     0     d0b0c7b2f0  inspect a merged TODO's run
All   176    8    37
```

A full board pass on b74a68604e is running: J1 21/0/0 and J2 14/0/0 so far.

## 2. Off

Two features ship switched off because of a known hole (ruled by smithers-8a).

| Feature | Switch | A person sees instead |
|---|---|---|
| File card code intelligence | `lspConfinementReceipt` is empty, `packages/backend/internal/compose/language_servers.go:19` | The File card shows the file's text. No hover, go to definition or diagnostics. |
| Live code co-editing | `LiveCodeDocuments` is unset, `packages/backend/internal/compose/main.go:199` | File cards are read-only. Edits come from a terminal, SSH or the coding agent. Wiki co-editing is on. |

## 3. Broken

### Journey rows

Red on the board at d0b0c7b2f0. Every fix below landed after that commit and has not been rerun on the board.

| | Rows | Error | Fix |
|---|---|---|---|
| J4 | 12 Move T4 above T3 | The move answers 409 "TODO moved; try again". | d9bdb772e2 |
| J5 | 15, 17 | A TODO that waited on an answer ends `failed`: `coding/NativeCodingError/source_refused`. Row 17 follows from it. | ba1a27bc91. Lane fr18-j5-source-refused is still running. |
| J7 | 9, 10, 11, 12 | T2 ends `failed` with the same error. Fork to a scratch branch then has nothing to fork. | ba1a27bc91 |
| J10 | 6 Network drop turns stale past 120 s, Retry | Sync still reads stale 10 s after Retry. | No lane found. Whether 9bb8cd3f9c covers it: not checked. |

Three more rows were red in an earlier pass or a lane rerun and are green on this board. Their fixes and lanes: Detail G.

### Real VM

- One part of the real-VM conformance test failed at 99a4356a1a: `head`. The test expected plain-git head rules in a jj workspace. 992ca6aa8b changes that check. Real-VM rerun: not checked.

### Release

- No Release run has produced the server bundle or reached build, pack and smoke. The fix (86881fe0d0) is unproven until dry run #3 finishes.

## 4. Unverified

- **A TODO on a real install: not yet run.** Nobody has gone install, start, sign in, connect the test repository, TODO, PR, merge on a real Mac. The bundle is building on this MacBook from 3fc44ee1e8 since 14:01 PDT. The MacBook has 37 GiB free and needs 44.
- **Not yet exercised in a real VM:** the coding agent started as a daemon session, member terminals, capture, sleep and wake. 3fc44ee1e8 landed after the proof at 99a4356a1a.
- **The real-machine fixes** await smithers-3f's review (Detail B). For `/run` on tmpfs (88e7f6521c), the 64 MiB size is not verified and machines created earlier keep the old flags.
- **Start refusal under the floor.** The fix that stops the restart loop is on main (aa7af43171; tests c3aece0daa). It has not run on a Mac: launchd behaviour is unverified.
- **Disk per machine.** Measured in a real VM: one running machine holding the Smithers repository uses 0.74 GiB of host disk, and a TODO-sized commit adds 7.4 MiB. A working machine with dependencies installed is estimated at about 15 GiB; not measured.
- **Waiting on smithers-3f** (Detail E): three questions on guest helper change b596ce787b; learning machine isolation (T-FLW-06), which also has no real-machine run; delta reviews of machine daemon wire protocols 7 to 12.
- **Mac mini and Cloud.** Nothing has run on the Mac mini. Smithers Cloud admits no TODO (`packages/backend/internal/compose/main.go:1370-1377`) and its Smithers pin is about 2,000 commits behind main.
- **80 tickets** have code on main and no real-machine run (Detail C). 37 journey rows are pending (Detail A).
- **Sign-offs.** None is done. They serve Done, not this prerelease: Will (T-DOC-02, T-DOC-03), smithers-06 copy reviews, smithers-3f security reviews, smithers-22 check mapping, smithers-8a, smithers-38.
- **Mac mini schedule.** 192 runs across 68 tickets, about 117 hours. Stopped. It serves Done, not this prerelease.

## 5. Not in this prerelease

- **Homebrew install.** The job does not run for a suffixed version. It needs check runs from the Mac mini, a `HOMEBREW_TAP_TOKEN` secret and a `homebrew-publish` environment. None exists.
- **A public bundle download.** The bundle is a GitHub Actions artifact. It needs a GitHub login and expires after 90 days.
- **A GitHub Release and installer archives.** Nothing publishes them.
- **Not started, after launch (11 tickets).** T-MNT-01 to 05: maintainers with outside contributors. T-AGT-04: the internal `/ceo` flow. T-RMT-01 to 05: machines on remote Linux hosts and Cloud boxes.
- **Still being built (25 tickets).** Detail D.

## 6. Publish

Do not publish yet. No dry run is green. Source: `~/smithers-lanes/release/STATE.md`, updated 14:05 PDT.

### Dry runs

| # | Run | Workflow | Result |
|---|---|---|---|
| 1 | 37837413419 | old | Failed. The changelog section was stale. The Mac bundle built for 40 minutes, then the upload found no files: the archive is in a hidden directory. |
| 2 | 37842512795 | old | Running on the cut. The changelog gate passed. Expected red: the bundle upload fails the same way and the first red gate stops the build. |
| 3 | 37843714479 | 86881fe0d0 | Running on the cut since 14:01 PDT. The first run that can go green. Bundle about 14:45, build, pack and smoke about 14:50. |

### Before the tag

1. Dry run #3 is green: build, pack, smoke, the bundle upload and the four installed-CLI jobs.
2. A final cut lands tonight on top of the real-machine, disk floor and install-run fixes. Every commit after a cut makes its changelog section stale.
3. One last dry run passes on that commit.
4. The tag goes on that commit.

### Known risks

1. The publish step runs for the first time on the tag. No dry run can run it.
2. 37 of the 49 npm names are new to npm. The `NPM_TOKEN` login was proven today (run 37840712277). Its right to create the 37 names is proven only by the first publish.
3. The four installed-CLI jobs have never run in a dry run. #3 is the first.
4. The start commands below are read from source. They have not been run against a real artifact.
5. This MacBook's `gh` token cannot push workflow files; the lead pushes those from a server. Whether it can push the tag: not checked. `gh auth refresh -h github.com -s workflow` removes the doubt.
6. 104 release script tests fail on main (pack-release, release-gates, installer-release). Cause: not checked.

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
npm install -g smthrs@next
RUN=<the tag's Release run id>
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
| J4 | Read Home counts, answer and merge while chatting, retry a failed TODO with a steer. Red: moving a TODO up. |
| J5 | Ask the app agent to change the TODO flow, merge the edit as a TODO, see the new version Active. New TODOs use it. A broken flow keeps the previous version. Red: a TODO that waited on an answer fails when it resumes. |
| J6 | Nothing a person does in J6 has run. The 4 passing rows are the install, a TODO working and two refusals. Not run: a branch terminal, `claude` or `codex` signed in, the Smithers skill, "Claude Code for Ben". |
| J7 | Insert a TODO before another, amend a TODO's prompt, drop a TODO, see `main` move. Red: fork to a scratch branch. Not run: Add to stack, conflicts. |
| J8 | Merge a TODO and get a learning run admitted, co-edit a wiki page with a teammate, sync the wiki to an Obsidian folder. Not run: the learning run writing the decision page, the next plan citing the edited page. |
| J9 | Ask where code lives, get file and wiki cards, make a TODO from the answer, save the answer to the wiki. Not run: the two buttons shown on the answer. |
| J10 | See a TODO's PR on GitHub with its prompt and evidence. A review comment becomes a steer. A teammate's push holds the agent, with Bring in and Discard. Merge or close on GitHub and the TODO follows. The next TODO follows a merge. `/review` a teammate's PR. Red: sync stays stale after Retry. |
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
| Stack | T-STK-01, 04, 05, 06, 08, T-MCH-08 | Ordered multi-TODO merge with pre-approval. Stop, Resume and Retry counters. Scratch Rebase and Done. Fork, Drop and Add to stack on a live child. |
| Branch card | T-APP-10 | Scratch Rebase and Done. Waiting, rebasing and frozen states. |
| App | T-APP-21, T-CAT-01 | `/debug-api` on a real install. Command placement and unlisted commands. |
| Machines | T-MCH-06, T-COL-03 | Admission order and safe idle. The daemon on hosted machines. |
| Learning | T-FLW-06 | The lint proposal diff and its 3-of-5 evidence. |
| Install | T-INS-07, T-CUT-02, T-CUT-03 | `smthrs host upgrade`, `backup` and `restore`. Removal of the old health handler. Grants for hidden surfaces. |
| Release | T-REL-01, T-REL-03, T-PRC-01 | Install metrics always report unavailable. Alpha scorecard. Package-wide gate evidence. |
| Fast model | T-FM-02 | The Smithers fast-model gateway is not deployed. The quota is undecided. |

### E. Unverified lines in full

- Learning machine isolation (T-FLW-06): no 3f review, no reference-host run; relies on sandboxed isolation and no source publisher on the learning workspace.
- Guest helper change b596ce787b (`state-read`/`state-write`): three questions are open with smithers-3f. Which uid runs them, and can a repository-code uid write under `/var/lib/smithers/state`? Who creates `managed-hosts/<sha>/`, and with what mode? Does the read need `O_NOFOLLOW`? The host checks `binding.json` by ID, so a forged file only refuses its own machine.
- Machine daemon wire protocols 7 to 12 await smithers-3f's delta reviews.
- Disk per machine, measured in a real VM with a 32 GiB sparse root disk: a fresh running machine allocates 13.5 MiB; with the Smithers source tree committed, 739 MiB; a TODO-sized commit adds 7.4 MiB. The base image layers, 1.33 GiB, are shared once. Not in these numbers: full git history, environment layers, installed dependencies and build output.

### F. Resume a failed publish

From `scripts/release-resume.md`. A re-run of the failed run is refused.

```sh
RUN=<failed run id>
ART=$(gh api "repos/smithersai/smithers/actions/runs/$RUN/artifacts" \
  --jq ".artifacts[] | select(.name==\"release-candidate-$RUN\") | .id")
gh workflow run release.yml --ref main \
  -f releaseTag=v1.0.0-rc.1 -f candidateRunId="$RUN" -f candidateArtifactId="$ART" -F dryRun=false
```

### G. Rows red earlier, green on this board

| | Row | Error | Fix |
|---|---|---|---|
| J10 | 5 T2 follows T1's merge | The next TODO did not follow a merge within 8 minutes. | 9bb8cd3f9c |
| J7 | 15 Drop T2 | A dropped TODO kept its machine after 60 s. | 09e889efce |
| J4 | 17 T2 ready after T1 merges | T2's PR still contained T1's file. | Lane fr19-j4-row17 is running. A lane rerun on landed code passed J4 23/0/2. |
