# Prerelease status

```
Updated       2026-10-08 14:03 PDT
main          4881e80270 when written

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

Ships         npm packages under `next`, plus the Apple Silicon server bundle
              as a download. No Homebrew.
To try it     Apple Silicon Mac, macOS 15 or later, and 44 GiB free on the state
              volume (your home volume) until the owner has signed in. With
              less, a fresh install refuses to start (`host_capacity_zero`).
              Unpack the bundle, then: ./bin/smthrs host start --bundle .
No Mac mini   The Mac mini will not be online (Will, today).
No Cloud      Smithers Cloud cannot run a TODO.
Real run      One, on this MacBook: 37 GiB free now. It clears caches to hold
              44 for the first start.

Needs Will    Now: nothing.
              When the last dry run is green: the tag push under Publish.
```

## 1. What works

On Linux fixtures only. Each suite walks one install through its public routes with real PostgreSQL, a GitHub fake, a scripted coding model, and the coding agent as a host process. No microVM. On a real machine a TODO does not run today (section 3).

Pending means the row is written and not run. Most pending rows need a real machine daemon. One line per journey on what a person can do: Detail A.

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
J10    32    4     4     df9c9e0476  work a TODO's PR from GitHub
J11    19    0     0     df9c9e0476  inspect a merged TODO's run
All   173   11    37
```

J10 is running on d0b0c7b2f0. No journey has run on main.

## 2. Off

Two features ship switched off because of a known hole (ruled by smithers-8a).

| Feature | Switch | A person sees instead |
|---|---|---|
| File card code intelligence | `lspConfinementReceipt` is empty, `packages/backend/internal/compose/language_servers.go:19` | The File card shows the file's text. No hover, go to definition or diagnostics. |
| Live code co-editing | `LiveCodeDocuments` is unset, `packages/backend/internal/compose/main.go:199` | File cards are read-only. Edits come from a terminal, SSH or the coding agent. Wiki co-editing is on. |

## 3. Broken

### Real machines

The machine daemon has never started in a real machine on main. A TODO needs it. Each defect was found in a real microVM on this MacBook. Each fix exposed the next, so the list can grow.

| # | Defect | State |
|---|---|---|
| 0 | The guest helper lost the read and write that egress secrets and managed hosts use. | Landed, b596ce787b |
| 1 | The guest helper refused the boot file the host writes, so the daemon never booted. | Landed, 0889378440 |
| 2 | The helper needs `/run` on tmpfs. The guest has none. | Open |
| 3 | The broker cannot enable `+cpu +pids`. The guest's root cgroup delegates no controllers. | Open |
| 4 | jj writes the repository 0600. The daemon's user cannot read what the agent's user created. | Fix landed, 42b5401381; Linux init/snapshot/checkout regression passes. Two-UID real-VM startup remains unverified. |
| 5 | The daemon's git refuses `/workspace` as dubious ownership. | Open |
| 7 | Daemon jj writes leave repository state inaccessible to the agent. | Linux fix: shared jj persistence, daemon umask 002, and group-writable loose Git objects. Two-UID real-VM proof remains unverified. |
| 8 | Daemon-created working files cannot be edited in place by the agent. | Linux fix: new files 0664, replacement modes retain executable bits and add group write. Two-UID real-VM proof remains unverified. |

Source: `~/smithers-lanes/release/REAL-RUN.md` lists 0 and 1. Defects 2 to 5 come from the real-VM agent's report to the lead and are not in that file yet. Failure 4's implementation is on main; its real-VM proof is still pending. None has smithers-3f's review.

### Journey rows

| | Rows | Error | Lane |
|---|---|---|---|
| J4 | 12 Move T4 above T3 | The move answers 409 "TODO moved; try again". | fr18-j4-move. Fix landed in d9bdb772e2. Not rerun on the board. |
| J4 | 17 T2 ready after T1 merges | T2's PR still contains T1's file. Seen in a lane rerun; green on the board. | fr19-j4-row17. Started 13:27 PDT. |
| J5 | 15, 17 | A TODO that waited on an answer ends `failed`: `coding/NativeCodingError/source_refused`. Row 17 follows from it. | fr18-j5-source-refused. Running, no report. |
| J7 | 9, 10, 11, 12 | T2 ends `failed` with the same error. Fork to a scratch branch then has nothing to fork. | same |
| J7 | 15 Drop T2 | A dropped TODO keeps its machine after 60 s. Seen in a lane rerun; green on the board. | fr19-j7-drop-machine. Started 13:27 PDT. |
| J10 | 5 (two rows), 6 (two rows) | The next TODO does not follow a merge within 8 minutes. Its PR stays a draft, GitHub answers 405, and sync reads stale. | fr18-j10-follow-merge. Cause found, no fix yet. |

## 4. Unverified

- **The real install run.** Not started. The bundle from the dry run is still building, and this MacBook has 20.6 GiB free of the 72 GiB a first start needs (`~/smithers-lanes/release/REAL-RUN.md`). Before the first start, the old desktop-app data in `~/Library/Application Support/Smithers` is renamed, not deleted.
- **Mac mini.** Nothing has run on it and it will not be online (Will, today).
- **Smithers Cloud.** The hosted composition admits no TODO (`packages/backend/internal/compose/main.go:1370-1377`). Its Smithers pin is 2,048 commits behind main.
- **80 tickets** have code on main and no real-machine run (Detail B). 37 journey rows are pending (Detail A).
- **Learning machine isolation** (T-FLW-06): no 3f review, no real-machine run.
- **Guest helper change** b596ce787b: three questions are open with smithers-3f.
- **Machine daemon wire protocols** 7 to 12 await smithers-3f's delta reviews.
- **Agent edits through the real machine daemon** have run only against a fixture on Linux. 14 of 17 real-VM tests pass on a MacBook.
- The full text of these four lines: Detail D.
- **Sign-offs.** None is done. They serve Done, not this prerelease: Will (T-DOC-02, T-DOC-03), smithers-06 copy reviews, smithers-3f security reviews, smithers-22 check mapping, smithers-8a, smithers-38.
- **Mac mini schedule.** 192 runs across 68 tickets, about 117 hours. Stopped. It serves Done, not this prerelease.

## 5. Not in this prerelease

- **Homebrew install.** The job needs check runs from the Mac mini, a `HOMEBREW_TAP_TOKEN` secret and a `homebrew-publish` environment. None exists.
- **Not started, after launch (11 tickets).** T-MNT-01 to 05: maintainers with outside contributors. T-AGT-04: the internal `/ceo` flow. T-RMT-01 to 05: machines on remote Linux hosts and Cloud boxes.
- **Still being built (25 tickets).** Detail C.

## 6. Publish

Do not publish yet.

### Dry run 37837413419

| Job | Result |
|---|---|
| Native helpers, 4 platforms | Passed |
| Validate, build and publish | Failed at "Release changelog section" and "Upload product deployment mode matrix receipt". 76 of 105 steps were skipped, among them build, pack and smoke-test. |
| Apple Silicon server bundle | Still running |
| Installed npm CLI; sign and publish installer archives | Skipped |

### Known risks

1. Dry run 1 did not reach build, pack or smoke-test. The cut is expected to clear the changelog gate (the `1.0.0-rc.1` section is dated 2026-09-22). The receipt upload failure: cause not checked.
2. The two installer jobs are skipped by every dry run of an untagged commit. They would run for the first time on the tag push, after npm publishes. `STATE.md` does not say how they will be proven.
3. 37 of the 49 npm names are new to npm. They publish with the `NPM_TOKEN` secret, set 2026-09-22. Whether it still works: not checked.
4. `smthrs` has no `1.0.0-rc` version on npm and `next` does not exist yet. `latest` is 0.35.0 and stays there.
5. The `npm-publish` environment has no required reviewers. The tag push publishes without a second approval.
6. The next version is not cut. Manifests on main read `1.0.0-rc.1`.

### Commands

`STATE.md` lists no publish or start commands yet (updated 13:14 PDT). The commands below come from the workflow and the bundle's README. None has been run for this prerelease.

Publish, after `STATE.md` shows a green dry run on the cut commit:

```sh
cd ~/smithers
V=1.0.0-rc.2                      # the version STATE.md names for the cut
SHA=<full SHA of the cut commit>  # the commit the green dry run tested
git fetch origin main
git tag -a "v$V" -m "🔖 release: $V" "$SHA"
git push origin "v$V"             # this publishes
npm view smthrs dist-tags         # expect next = $V, latest = 0.35.0
```

Try it (`apps/app/scripts/README.md`). Use a macOS account with no Smithers state. Have GitHub repository admin access, a provider key and an AI Gateway key ready. Where the bundle is downloaded from: not in `STATE.md` yet. Today it exists only as a Release run's `server-bundle-darwin-arm64` artifact. No real install has started yet, so how far setup gets is not checked. A TODO will not run until the defects in section 3 are fixed.

```sh
gh run download <Release run id> -R smithersai/smithers -n server-bundle-darwin-arm64
mkdir smithers-server && tar -xzf smithers-server.tar.gz -C smithers-server
cd smithers-server
./bin/smthrs host start --bundle .   # prints the setup link
./bin/smthrs host status
./bin/smthrs host stop
```

If the Release run fails after some packages published, do not re-run it. Resume it: Detail E.

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
| J10 | See a TODO's PR on GitHub with its prompt and evidence. A review comment becomes a steer. A teammate's push holds the agent, with Bring in and Discard. Merge or close on GitHub and the TODO follows. `/review` a teammate's PR. Red: the next TODO does not follow a merge. |
| J11 | Open Inspect on a merged TODO's run: graph, each step's input, output and transcript, retries, the wait for an answer, tokens, time and cost per step. No rows exist for editing a flow's source, a test Run or switching a step's model. |

### B. Code on main, no real-machine run (80 tickets)

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

### C. Still being built (25 tickets)

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

### D. Unverified lines in full

- Learning machine isolation (T-FLW-06): no 3f review, no reference-host run; relies on sandboxed isolation and no source publisher on the learning workspace.
- Guest helper change b596ce787b (`state-read`/`state-write`): three questions are open with smithers-3f. Which uid runs them, and can a repository-code uid write under `/var/lib/smithers/state`? Who creates `managed-hosts/<sha>/`, and with what mode? Does the read need `O_NOFOLLOW`? The host checks `binding.json` by ID, so a forged file only refuses its own machine.
- Machine daemon wire protocols 7 to 12 await smithers-3f's delta reviews.
- Agent edits through the real machine daemon have run only against a fixture on Linux. Real-VM development runs on a MacBook passed 14 of 17 bundle-less `TestRealMicroVM*` tests (3 after fixes b596ce787b and 5e1a8748b5). `TestRealMicroVMWorkspaceConformance` still fails for lack of a composed-daemon fixture.

### E. Resume a failed publish

From `scripts/release-resume.md`. A re-run of the failed run is refused.

```sh
RUN=<failed run id>
ART=$(gh api "repos/smithersai/smithers/actions/runs/$RUN/artifacts" \
  --jq ".artifacts[] | select(.name==\"release-candidate-$RUN\") | .id")
gh workflow run release.yml --ref main \
  -f releaseTag="v$V" -f candidateRunId="$RUN" -f candidateArtifactId="$ART" -F dryRun=false
```
