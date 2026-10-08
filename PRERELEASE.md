# Prerelease status

```
Updated       2026-10-08 16:59 PDT
main          4556117406 when written

Publish       CANNOT PUBLISH YET. Dry run #6 decides; smoke test about 17:10 PDT.
Real install  RUNNING on this MacBook since 16:18 PDT: production launcher, bundle
              built here from 3fc44ee1e8. Done: start, address, GitHub App, owner
              sign-in, repository connected (16:49 PDT). Model access reached,
              no key entered. Pending: models, source, machine. Next: restart
              under the test launcher with the scripted model, then a TODO.
              TODO to merged PR: NOT YET PROVEN.
Broken        On the install, each with a lane:
              1. The setup card's Model access line reads "Not signed incoding model".
              2. `GET /setup` shows raw JSON to a signed-in owner.
              3. The bundle README's setup-link format differs from what start prints.
Fixed on main Not yet proven on a real install; needs a bundle built after
              9a218b7f68: the missing setup card (c5120a5856), the sign-in path
              404 and the stale-cookie 401 (9a218b7f68).
Real machine  The machine daemon works in a real VM on main (99a4356a1a).
Journeys      Last full pass, main 70d75088ef: 10 of 11 have no failed row, on
              Linux fixtures. Red: J10 row 6, sync still stale 10 s after Retry.
              Pass running on c5120a5856: J1 to J4 so far, no failed row.
Doneish       No. It needs the install run to take a TODO to a merged PR, and
              all 11 journeys passing on one commit.
Dry runs      Version 1.0.0-rc.1. None is green. #6 37860903519 runs on
              06209aa7b1 since 16:42 PDT. #5 failed the installed-package smoke
              on a stale fixture; the fix also repairs `smithers-build`, which
              could not start in any installed project.
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

**On a real install.** This MacBook, production launcher, bundle built here from 3fc44ee1e8. Source: the install run's reports at 16:37 and 16:57 PDT.

- With 39.19 GiB free, `./bin/smthrs host start --bundle .` refuses once: `host_capacity_zero ... 44 GiB required`. No restart loop.
- With 44.77 GiB free it starts (16:18 PDT). `host status` reads ready and `/readyz` answers 200.
- Setup steps done: address, GitHub App on the test account, owner sign-in (16:34 PDT), repository (16:49 PDT; the App is on `codeplanesmithers/canary-sandbox` only).
- Model access is reached (16:50 PDT) with no key entered. Steps pending: models, source, machine.
- The setup card appears from Model access on. The first four steps were sent as the card's requests from the browser, because the card stayed hidden until an owner session existed.

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

## 2. Off

Two features ship switched off because of a known hole (ruled by smithers-8a).

| Feature | Switch | A person sees instead |
|---|---|---|
| File card code intelligence | `lspConfinementReceipt` is empty, `packages/backend/internal/compose/language_servers.go:19` | The File card shows the file's text. No hover, go to definition or diagnostics. |
| Live code co-editing | `LiveCodeDocuments` is unset, `packages/backend/internal/compose/main.go:199` | File cards are read-only. Edits come from a terminal, SSH or the coding agent. Wiki co-editing is on. |

## 3. Broken

### Real install

Found by the install run on this MacBook. Still broken, each with a lane:

| | Defect |
|---|---|
| 1 | The setup card's Model access line reads "Not signed incoding model". |
| 2 | `GET /setup` shows raw JSON to a signed-in owner. |
| 3 | The bundle's README promises one JSON line of setup links. `host start` prints two bare lines. |

Fixed on main, not yet proven on a real install. Each needs a bundle built after 9a218b7f68; the running install's bundle predates them.

| | Defect | Fix |
|---|---|---|
| 4 | A fresh install's setup link showed no setup card. A regression from c818f8df41. | c5120a5856 (16:31 PDT). Passes a Linux browser test. |
| 5 | The app's sign-in path `/api/auth/github/start` answered 404 on an install. `/api/auth/github` works. | 9a218b7f68 (16:43 PDT): app, setup and CLI use `/api/auth/github`. Passes on a Linux install. |
| 6 | A `smithers_session` cookie left by an earlier install on the same address blocked the setup link with 401. | 9a218b7f68: token exchange clears the member cookie. Passes on a Linux install. |

### Journey rows

| | Row | Error | Fix |
|---|---|---|---|
| J10 | 6 Network drop turns stale past 120 s, Retry | Sync still reads stale 10 s after Retry. | Lane fr18-j10. 5e1bc3c020 is on main and not yet on the board. |

A pass is running on c5120a5856: J1 21/0/0, J2 14/0/0, J3 14/0/5, J4 23/0/2 so far. `source_refused` is fixed (f9d3b72e29, ba1a27bc91), and each refusal now names its reason (7a2c228bfa, a64960b9c3). The rows fixed today: Detail G.

### Real VM

- One part of the real-VM conformance test failed at 99a4356a1a: `head`. The test expected plain-git head rules in a jj workspace. 992ca6aa8b changes that check. Real-VM rerun: not checked.

### Release

- No Release run has passed the installed-package smoke. That script could not load from 10-01 until today, so its fixed expectations went stale. Dry runs #3, #4 and #5 each failed on one (fixed in 0489b1c08c, a3e6ac767e and 06209aa7b1). The release agent now runs build, pack and smoke locally, in about 7 minutes, to find the rest before CI does.
- The smoke found a product bug: `smithers-build` (`@smthrs/build-cli`) could not start in any installed project since #3093. Fixed in 06209aa7b1.

## 4. Unverified

- **TODO to merged PR on the real install: not yet run.** The install has reached Model access. Remaining:
  1. Restart the same bundle and state under the test launcher with the scripted model, then take a TODO to a merged PR. The production launcher cannot reach the scripted model, by design.
  2. A TODO with a real model under the production launcher, only if Will says yes to using his keys. Not received.
- **Three install fixes on main** (the setup card, the sign-in path, the stale cookie) have not run on a Mac. They need a bundle built after 9a218b7f68.
- **Not yet exercised in a real VM:** the coding agent started as a daemon session, member terminals, capture, sleep and wake. 3fc44ee1e8 landed after the proof at 99a4356a1a.
- **The real-machine fixes** await smithers-3f's review (Detail B). For `/run` on tmpfs (88e7f6521c), the 64 MiB size is not verified and machines created earlier keep the old flags.
- **Disk per machine.** Measured in a real VM: one running machine holding the Smithers repository uses 0.74 GiB of host disk, and a TODO-sized commit adds 7.4 MiB. A working machine with dependencies installed is estimated at about 15 GiB; not measured.
- **Waiting on smithers-3f** (Detail E): three questions on guest helper change b596ce787b; learning machine isolation (T-FLW-06), which also has no real-machine run; delta reviews of machine daemon wire protocols 7 to 12.
- **Mac mini and Cloud.** Nothing has run on the Mac mini. Smithers Cloud admits no TODO (`packages/backend/internal/compose/main.go:1370-1377`) and its Smithers pin is about 2,000 commits behind main.
- **80 tickets** have code on main and no real-machine run (Detail C). 33 journey rows are pending (Detail A).
- **Sign-offs and the Mac mini schedule** serve Done, not this prerelease. No sign-off is done: Will (T-DOC-02, T-DOC-03), smithers-06, smithers-3f, smithers-22, smithers-8a, smithers-38. The schedule (192 runs, about 117 hours) is stopped.

## 5. Not in this prerelease

- **Homebrew install.** The job does not run for a suffixed version. It needs check runs from the Mac mini, a `HOMEBREW_TAP_TOKEN` secret and a `homebrew-publish` environment. None exists.
- **A public bundle download.** The bundle is a GitHub Actions artifact. It needs a GitHub login and expires after 90 days.
- **A GitHub Release and installer archives.** Nothing publishes them.
- **Not started, after launch (11 tickets).** T-MNT-01 to 05: maintainers with outside contributors. T-AGT-04: the internal `/ceo` flow. T-RMT-01 to 05: machines on remote Linux hosts and Cloud boxes.
- **Still being built (25 tickets).** Detail D.

## 6. Publish

**Cannot publish yet.** No dry run is green. Dry run #6 reaches the smoke test about 17:10 PDT. Source: `~/smithers-lanes/release/STATE.md`, updated 16:20 PDT.

### Dry runs

| # | Run | Result |
|---|---|---|
| 1 | 37837413419 | Failed. Stale changelog section. The Mac bundle built, then the upload found no files (hidden directory, fixed in 86881fe0d0). |
| 2 | 37842512795 | Old workflow. The bundle upload failed the same way. |
| 3 | 37843714479 | Build and pack passed. The installed-package smoke failed on a removed import (fixed in 0489b1c08c). Delivered the first Mac bundle artifact. |
| 4 | 37846701537 | Build and pack passed. The smoke failed one fixture further, on a stale migration list (fixed in a3e6ac767e). Delivered a Mac bundle artifact. |
| 5 | 37858229125 | The smoke failed at 16:39 PDT: a fixture imported `@effect/platform-node`, which installed projects no longer have (fixed in 06209aa7b1). |
| 6 | 37860903519 | Running on 06209aa7b1 since 16:42 PDT. Smoke test about 17:10 PDT. |

### Before the tag

1. A dry run is green: build, pack, smoke, the bundle upload and the four installed-CLI jobs. #6 is the next that can be.
2. A final cut lands tonight on top of the real-machine, disk floor and install-run fixes. Every commit after a cut makes its changelog section stale.
3. One last dry run passes on that commit.
4. The tag goes on that commit.

### Known risks

1. The publish step runs for the first time on the tag. No dry run can run it.
2. 37 of the 49 npm names are new to npm. The `NPM_TOKEN` login is valid today (run 37840712277). Whether it may create the 37 new `@smthrs/*` names could not be determined (run 37844231677). If it may not, the publish stops at the first package, `@smthrs/canonical`, and nothing reaches `next`. The fix takes minutes and needs Will: Detail F.
3. The four installed-CLI jobs have never run in a dry run. They run after the build, pack and smoke lane, which has not passed yet.
4. `host start --bundle` works on this MacBook with a bundle built here. The download commands below have not been run against a Release run's artifact.
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

All are green on the full pass at 70d75088ef.

| | Rows | Error | Fix |
|---|---|---|---|
| J4 | 12 Move T4 above T3 | The move answered 409 "TODO moved; try again". | d9bdb772e2 |
| J5, J7, J3, J4 | every row after a TODO reached review | `coding/NativeCodingError/source_refused`. The server's real answer was 409 "stack operation request changed": PostgreSQL JSONB reorders a plan's nested keys and a byte comparison refused an identical plan. | f9d3b72e29, ba1a27bc91 |
| J10 | 5 T2 follows T1's merge | The next TODO did not follow a merge within 8 minutes. | 9bb8cd3f9c |
| J7 | 15 Drop T2 | A dropped TODO kept its machine after 60 s. | 09e889efce |
| J4 | 17 T2 ready after T1 merges | T2's PR still contained T1's file. | Green on the board. Fix commit: not checked. |
