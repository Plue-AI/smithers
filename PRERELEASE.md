# Prerelease status

```
Updated       2026-10-09 10:45 PDT
main          5ea0bf5b8f when written

Publish       NOTHING PUBLISHED. The v1.0.0-rc.1 tag run (37963844319) stopped
              in the npm publish preflight before any package: pnpm 11 answers
              a missing version of an existing name without a 404, and the
              preflight treated it as fatal. Fixed in 1618f9d9ce. The rc.1 tag
              stays as a failed attempt; npm never had 1.0.0-rc.1.
Next          1.0.0-rc.2, cut 5ea0bf5b8f (66 commits after rc.1, including the
              fix). Running on it: dry run #12 (37967228802), J1 to J11, then
              real install run 11 on #12's bundle. The tag follows when all
              three pass.
Doneish       YES on 8ab73f0c82 (rc.1). rc.2 is being proven.
Real install  Run 10 PASS on the rc.1 cut's own bundle (dry run #11), no patch: setup
              on the card, TODO T1 to PR canary-sandbox#151, merged with the
              TODO card's Merge at 07:13:10 PDT, squash 815abef03b.
              Runs 6 to 9 found these stops; all are fixed in the cut:
              6  setup card Sign in did nothing          e5a5b0fa87
              6  daemon wedged on the agent's first edit  c471b306ae
              6  msb lease stranded by a reconnect storm  5039aa9b94
              7  a repository with no check (by spec)     test repo got a check
              8  any outside write killed the TODO run    4653cacd08
              9  candidate tree read refused by git       f4381cd226
              8,9 daemon exited after agent jj in bwrap   8a6ac03825
Journeys      8ab73f0c82 (rc.1): no failed row. J5 passed on its second try.
              J1 21/0/0  J2 14/0/0  J3 14/0/5  J4 23/0/2  J5 21/0/0  J6 4/0/16
              J7 19/0/2  J8 6/0/3   J9 12/0/1  J10 36/0/4 J11 19/0/0
Dry run       #11 37934773000 on 8ab73f0c82: every blocking job green. Its
              gates lane is still running and reports only.
Broken in     A flow host bound during workspace initialization pins the wrong
the cut       revision and retries forever, holding one of two machine slots
              (wiki g2 on run 10). Fixed on main by aac3bf4993, after the cut.
Fixed, after  0b2667305e: a machine whose daemon is gone releases its slot.
the cut       aac3bf4993: the flow host waits for initialization. Both ship in
              the next prerelease.
Tag push      Publishes npm under `next` and nothing else. No publish after a
              failed build, pack or smoke. Homebrew and installer signing are
              skipped. No GitHub Release.

Ships         npm packages under `next`. The Apple Silicon server bundle is an
              artifact of the tag's Release run. No Homebrew. No public download.
To try it     Apple Silicon Mac, macOS 15 or later, a GitHub login for `gh`, and
              44 GiB free on your home volume until the owner has signed in
              (refused at 39.19, started at 44.77). Commands: section 6.
No mini/Cloud The Mac mini is offline (Will, 10-08). Cloud cannot run a TODO.

Needs Will    Nothing. Will asked for the publish (10-09 10:00); the rc.2 tag
              is pushed once its proof passes. Optional: say yes to using your
              model keys if an install run should also run a TODO with a real
              model.
```

## 1. What works

**On a real install, at the cut.** Run 10, this MacBook, the bundle from dry run #11 (37934773000) for 8ab73f0c824c94c08de47f9e6c4c560fb0b2af9a, 0 digest mismatches, no file patched. Source: `~/smithers-lanes/release/REAL-RUN.md`, run 10.

```
07:04:25 host start (production launcher) . 07:04:42 ready, buildSha 8ab73f0c82
07:05:20 Address . 07:05:26 GitHub App . 07:05:39 Sign in (card) . 07:06:29 Repository
07:06:44 Model access . 07:06:52 Source . 07:08:11 first machines running (79 s)
07:09:52 Machine . 07:09:58 T1 created . 07:10:09 T1 machine running
07:10:22 working: plan, edit, check `npm run test` passed, candidate saved
07:11:26 PR #151 opened . 07:12:57 Merge on the TODO card . 07:13:10 merged on GitHub
07:13:13 T1 merged; canary-sandbox main holds squash 815abef03b
```

- Every setup step ran on the setup card, Sign in included.
- Model access, Source, Machine and the TODO ran under the test launcher with the scripted model. No real model key was entered.
- The first machines take 79 s once per install: the toolchain layer is built and cached. T1's machine then started in 9 s.
- The catalog machine retired; wiki g1 retired on its second try.

**On Linux fixtures, at the cut.** Each journey suite walks one install through its public routes with real PostgreSQL, a GitHub fake, a scripted coding model, and the coding agent as a host process. No microVM. Pending means the row is written and not run. One line per journey: Detail A.

```
      pass fail pending  a person can
J1     21    0     0     install, set up, merge a first TODO, add members
J2     14    0     0     turn an issue into a TODO, answer it, merge its PR
J3     14    0     5     open a TODO's branch, answer or steer the agent
J4     23    0     2     answer, merge, move and retry from Home while chatting
J5     21    0     0     change the TODO flow through a merged TODO
J6      4    0    16     nothing yet: every terminal and own-agent row is pending
J7     19    0     2     insert, amend, fork and drop TODOs; conflicts
J8      6    0     3     co-edit a wiki page, sync it to Obsidian
J9     12    0     1     ask the repository, make a TODO, save to wiki
J10    36    0     4     work a TODO's PR from GitHub
J11    19    0     0     inspect a merged TODO's run
All   189    0    33
```

J5's first try failed row 17, "Retry current flow adopts D2": the TODO was still working after 180 s, not in review. The second try passed (section 3). J6's 16 pending rows need a real guest broker and run only in `TestJ6MicroVMRehearsal`.

## 2. Off

Two features ship switched off because of a known hole (ruled by smithers-8a).

| Feature | Switch | A person sees instead |
|---|---|---|
| File card code intelligence | `lspConfinementReceipt` is empty, `packages/backend/internal/compose/language_servers.go:19` | The File card shows the file's text. No hover, go to definition or diagnostics. |
| Live code co-editing | `LiveCodeDocuments` is unset, `packages/backend/internal/compose/main.go:199` | File cards are read-only. Edits come from a terminal, SSH or the coding agent. Wiki co-editing is on. |

## 3. Broken

### Real install

Open on main:

| | Defect | State |
|---|---|---|
| 2 | The queued "Refresh wiki" row has no button unless it has failed. | Open |
| 5 | During a machine start, a chat view save can answer 503 and a sign-in can wait. Member rows stay locked for the whole start. | Open, [#3759](https://github.com/smithersai/smithers/issues/3759) |
| 6 | A machine start does not notice a workspace deleted while it is being admitted. | Open, [#3759](https://github.com/smithersai/smithers/issues/3759) |
| 7 | The bundle's README promises one JSON line of setup links. `host start` prints two bare lines. | Open |
| 15 | A Codex vendor process is orphaned when its supervisor is lost. | Open, [#3760](https://github.com/smithersai/smithers/issues/3760) |
| 16 | An exec stream never closes after its process exits. | Open, [#3761](https://github.com/smithersai/smithers/issues/3761) |
| 17 | Wiki g1's first retire on run 10 refused ("branch sleep requires verified capture, runtime binding and state publication"). The retry 31 s later retired it. | Open, not blocking |

Broken in the cut, fixed on main after it. Both ship in the next prerelease and await a real install built from main:

| | Defect | Fix |
|---|---|---|
| 14 | A flow host binding created while its workspace initialized pinned the partial git checkout, then refused every retry with `source_revision_mismatch` and held one of two machine slots forever. Run 10's wiki g2. On an install with one slot it would block every TODO. | aac3bf4993 waits for the initialization receipt and bounds failed starts at three. |
| 18 | A machine whose daemon stays gone kept its slot. | 0b2667305e |

Confirmed by run 10 on the cut, built with no local patch: 1 (the catalog machine retires), 8 (the agent is admitted to its branch machine), 9 (the setup card shows from the first step) and 10 (sign-in from the card). Fixed on main, not exercised on a real install yet:

| | Defect | Fix |
|---|---|---|
| 11 | A sign-in cookie left by an earlier install on the same address blocked the setup link with 401. | 9a218b7f68 |
| 12 | Model access read "Not signed incoding model". Reopening `/setup` after setup closed showed raw JSON. | 88b768b019 |
| 13 | A failed initial start kept the only machine; restart cloning used the machine account; an interrupted catalog release stayed stuck. | fr27 start recovery: named failure and durable reaping, person-bound repository token, release reconciliation, and existing TODO Retry. PostgreSQL/trusted-process proof; real microVM confirmation awaits the Mac. |

### Journey rows

- **J5 row 17, J7 and J10 pass, with a retry now and then.** On the cut, J5's first try failed row 17 "Retry current flow adopts D2" (state "working", expected "in_review" after 180 s); the second try passed. Both J7 defects are fixed on main: Branch Done kept across a failed repair (b096080ac1) and the capture/ingest lock order (25cb01da69).
- J10 row 6 is green on the board: 36/0/4 at c5120a5856, 2d1f60faf0 and 8ab73f0c82. Rows fixed 10-08: Detail G.

### Real VM

- One part of the real-VM conformance test failed at 99a4356a1a: `head`. The test expected plain-git head rules in a jj workspace. 992ca6aa8b changes that check. Real-VM rerun: not checked.

### Release

- Nothing that can block the release is red. Dry run #11 on the cut passed every blocking job: native helpers, build, pack, the installed-package smoke, the Mac bundle and the four installed-CLI jobs.
- Its gates report red and do not block a prerelease: workspace targets, script gates, repository flows and their lint, public export JSDoc, script lint, UI unit tests and conformance, the TUI suites, the mode matrix, server, site, factory projection drift, native FFI, the fault matrix, the flows_jj.wasm rebuild, the shared backend suite, and the API baseline for `@smthrs/cli`. Run 37843714479 lists them.
- The gates take more than 330 minutes on a hosted runner, the job's limit. Since aab381def5 the gates lane ends its gates at 290 minutes and reports the rest as failed. Step timeouts or parallel gates come after the prerelease.
- The smoke found a product bug: `smithers-build` (`@smthrs/build-cli`) could not start in any installed project since #3093. Fixed in 06209aa7b1.
- Fault tests case03 and case31 read a process ID from inside a PID namespace, as the smoke fixture did before 5e83665567. They cannot pass on Linux until changed the same way.

## 4. Unverified

- **A real model on the real install.** Run 10 took a TODO to a merged PR with the scripted model: Model access, Source, Machine and the TODO ran under the test launcher. A TODO with a real model under the production launcher needs Will's yes to using his keys. Not received.
- **A setup-time toast.** No toast was queued during run 10's setup, so whether one renders there is untested.
- **The fixes after the cut** (rows 14 and 18) have not run on a real install.
- **API baseline drift on `@smthrs/cli`** is unreviewed. The Release run reports it and does not block on it.
- **Not yet exercised in a real VM:** member terminals and wake from sleep. Run 10 ran the coding agent in a daemon session, captured its work and retired machines.
- **The real-machine fixes** (Detail B, and runs 6 to 9 in the status block) await smithers-3f's review.
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

**Not published.** The v1.0.0-rc.1 tag (on 8ab73f0c82) ran Release 37963844319 at 10:05 PDT. Its candidate passed build, pack and smoke, then the publish preflight stopped on `@smthrs/errors` before any upload: `pnpm view` answers `ERR_PNPM_PACKAGE_NOT_FOUND` with no 404 for a missing version of an existing name. 1618f9d9ce fixes it with the run's exact output as the regression test. A resume would check out the rc.1 tag and run the old script, so the next publish is 1.0.0-rc.2, cut 5ea0bf5b8fd3e45bd7c14c0cbb59ee21b0682ee2.

The rc.1 proof, kept for the record. On that commit: run 10 took a TODO to a merged PR, J1 to J11 have no failed row, and dry run #11 (37934773000) passed every blocking job: native helpers, build, pack, the installed-package smoke, the four installed-CLI jobs and the Mac bundle. The plan it printed: 1.0.0-rc.1 on the `next` dist-tag; publication skipped.

Every dry run and why it failed: Detail H.

### Before the tag

Done. The cut is `8ab73f0c82 🔖 release: 1.0.0-rc.1`; its changelog section is current for that commit. Commits after it go into rc.2 with a new cut (`~/smithers-lanes/release/final-cut.sh 1.0.0-rc.2`), its own dry run and its own real install run.

### What a tag push runs

| Job | On `v1.0.0-rc.1` | Proven by |
|---|---|---|
| Mac server bundle | Runs. Uploads `server-bundle-darwin-arm64`. | Dry runs #3, #4, #7 to #11; run 10 installed #11's |
| Native helpers, 4 platforms | Run. | Every dry run |
| Build, pack, smoke, publish | Runs. Publishes 49 packages to npm under `next`. `latest` stays 0.35.0. | Build, pack and smoke: #8 to #11. The publish step runs first on the tag. |
| Gates | Run for hours, report red, cannot fail the run. | #8 and #9 finished SUCCESS with the gates lane red. |
| Installed CLI, 4 platforms | Run when the build, pack and smoke lane is green. | #8 to #11, all four |
| Installer signing | Does not run for a suffixed version. | The job's condition |
| Homebrew bottle and tap | Does not run for a suffixed version. | The job's condition |

No GitHub Release is created. The bundle has no public download: it is the run's artifact.

### Known risks

1. The publish step has run once on a tag (rc.1) and stopped in its preflight; fixed in 1618f9d9ce. Its upload half has still never run. No dry run can run it.
2. 37 of the 49 npm names are new to npm. The `NPM_TOKEN` login is valid today (runs 37840712277, 37844231677). Whether it may create new `@smthrs/*` names could not be determined. If it may not, the publish stops at the first package, `@smthrs/canonical`, which is new, and nothing is published. Fix and resume: Detail F.
3. This MacBook's `gh` token cannot push workflow files. Whether it can push the tag: not checked. The first command below removes the doubt.

### Commands

Publish 1.0.0-rc.2:

```sh
cd ~/smithers
gh auth refresh -h github.com -s workflow   # once, 1 minute
SHA=5ea0bf5b8fd3e45bd7c14c0cbb59ee21b0682ee2   # the rc.2 cut, once its proof passes
git fetch origin main
git tag -a v1.0.0-rc.2 -m "🔖 release: 1.0.0-rc.2" "$SHA"
git push origin v1.0.0-rc.2                 # this publishes to npm under `next`, about 45 minutes later
npm view smthrs dist-tags                   # expect next = 1.0.0-rc.2, latest = 0.35.0
```

Try it, on a Mac with 44 GiB free. Use a macOS account with no Smithers state. Have GitHub repository admin access, a provider key and an AI Gateway key ready.

```sh
npm install -g smthrs@next                     # after the tag run publishes
RUN=<the tag's Release run id>                # today: 37934773000, dry run #11's bundle of the same commit
gh run download "$RUN" --repo smithersai/smithers -n server-bundle-darwin-arm64 -D ~/smithers-bundle/download
mkdir -p ~/smithers-bundle/1.0.0-rc.1
tar -xzf ~/smithers-bundle/download/smithers-server.tar.gz -C ~/smithers-bundle/1.0.0-rc.1
smthrs host start --bundle ~/smithers-bundle/1.0.0-rc.1   # prints the setup links, one per line
```

A dry run for a later cut:

```sh
GH_SHIM=off env -u GH_TOKEN -u GITHUB_TOKEN gh workflow run release.yml --repo smithersai/smithers \
  --ref main -f releaseTag=v1.0.0-rc.2 -f sourceRef="$SHA" -F dryRun=true
```

Keep the unpacked directory in place: the service runs from it. The bundle carries its own CLI, so `./bin/smthrs host start --bundle .` inside it works without npm. If the Release run fails after some packages published, do not re-run it. Resume it: Detail F.

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
| Branch card | T-APP-10 | Native terminal freeze/thaw facts are wired through the authenticated daemon connection; real-kernel timing and two-machine qualification remain unverified. Foreground executable names are wired from broker-held PTYs; full argv display and real-machine qualification remain unverified. Scratch Rebase/Done, requester-only waiting and Rebasing still need real-machine qualification. |
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

All are green on the full board pass at c5120a5856.

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
| 7 | 37862357655 | On 4556117406. Mac bundle and native helpers passed. The smoke failed at the CLI containment check on the Linux runner: a test bug, fixed in 5e83665567. |
| 8 | 37867965100 | On 5e83665567. Every blocking job green by 18:51 PDT: native helpers, build, pack ("clean"), the whole smoke ("49 tarballs install, import, and typecheck"), the four installed-CLI jobs, the Mac bundle (artifact 11590976234, 778 MB). Gates lane still running, red, report-only. |
| 9 | 37904154080 | On 8598789b91. Every blocking job green. |
| 10 | 37919566771 | On e51543369f. Every blocking job green. |
| 11 | 37934773000 | On the cut 8ab73f0c82. Every blocking job green by 06:59 PDT; run 10 installed its bundle (0 digest mismatches). Gates lane report-only. |
