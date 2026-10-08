# Prerelease status

```
Updated      2026-10-08 13:22 PDT
main         bb646e6977 when written, 45 commits past the last journey run
Journeys     7 of 11 have no failed row. Red: J4, J5, J7, J10.
             Ran on d0b0c7b2f0 (J1 to J9) and df9c9e0476 (J10, J11). Not run on main.
Doneish      No. No commit has all 11 passing. Closest: df9c9e0476, 9 of 11.
Dry run      NOT GREEN. Run 37837413419 is in progress.
Ships        49 npm packages under `next`. No Homebrew install.
Needs Will   Now: nothing.
             When the dry run is green: the commands under Publish.
             For Done, later: approve T-DOC-02 and T-DOC-03.
```

**The release dry run is not green.** It blocks on:

1. Run 37837413419 has not finished. It started 13:10 PDT on bdb90db46d as `v1.0.0-rc.1`.
2. Its "Release changelog section" gate is expected to fail. The `1.0.0-rc.1` section is dated 2026-09-22.
3. The next version is not cut. Manifests on main read `1.0.0-rc.1`.
4. Gates other than build, install and start still block a suffixed version. The release-path agent is making them report-only.
5. The dry run skips the installer and Homebrew jobs (section 6).

Source: `~/smithers-lanes/release/STATE.md`, updated 13:14 PDT.

```
Tickets: 151, audited 2026-10-08 noon
Nothing left to do            22  ████
Person action left            13  ███
On main, no real-machine run  80  ████████████████
Being built                   25  █████
Not started, after launch     11  ██
```

## 1. What works

How this is known: each suite walks one install through its public routes on a Linux server with real PostgreSQL. GitHub is a fake. The coding model is a script. The coding agent runs as a host process, not in a microVM. These are not Mac mini runs.

Pending means the row is written and not run. Most pending rows need a real machine daemon.

| | Pass | Fail | Pending | Commit | A person can |
|---|---|---|---|---|---|
| J1 | 21 | 0 | 0 | d0b0c7b2f0 | Open the setup link, set the address, create the GitHub App, sign in as owner, pick the repository, set model access, ask about the code, file a first TODO, merge its PR, add members. |
| J2 | 14 | 0 | 0 | d0b0c7b2f0 | Turn a GitHub issue into a TODO with Make TODO or the `todo` label, answer its question, read the PR's evidence, merge it, see the issue close. |
| J3 | 14 | 0 | 5 | d0b0c7b2f0 | Open a TODO's branch from Needs you, see who is in a file, answer or steer the coding agent. Not run: own terminal, saves over SSH, two people typing in one file. |
| J4 | 22 | 1 | 2 | d0b0c7b2f0 | Read Home counts, answer and merge while chatting, retry a failed TODO with a steer. Red: moving a TODO up. |
| J5 | 18 | 2 | 0 | d0b0c7b2f0 | Ask the app agent to change the TODO flow, merge the edit as a TODO, see the new version Active. New TODOs use it. A broken flow keeps the previous version. Red: a TODO that waited on an answer fails when it resumes. |
| J6 | 4 | 0 | 16 | d0b0c7b2f0 | Nothing a person does in J6 has run. The 4 passing rows are the install, a TODO working and two refusals. Not run: a branch terminal, `claude` or `codex` signed in, the Smithers skill, "Claude Code for Ben". |
| J7 | 11 | 4 | 6 | d0b0c7b2f0 | Insert a TODO before another, amend a TODO's prompt, drop a TODO, see `main` move. Red: fork to a scratch branch. Not run: Add to stack, conflicts. |
| J8 | 6 | 0 | 3 | d0b0c7b2f0 | Merge a TODO and get a learning run admitted, co-edit a wiki page with a teammate, sync the wiki to an Obsidian folder. Not run: the learning run writing the decision page, the next plan citing the edited page. |
| J9 | 12 | 0 | 1 | d0b0c7b2f0 | Ask where code lives, get file and wiki cards, make a TODO from the answer, save the answer to the wiki. Not run: the two buttons shown on the answer. |
| J10 | 32 | 4 | 4 | df9c9e0476 | See a TODO's PR on GitHub with its prompt and evidence. A review comment becomes a steer. A teammate's push holds the agent, with Bring in and Discard. Merge or close on GitHub and the TODO follows. `/review` a teammate's PR. Red: the next TODO does not follow a merge. |
| J11 | 19 | 0 | 0 | df9c9e0476 | Open Inspect on a merged TODO's run: graph, each step's input, output and transcript, retries, the wait for an answer, tokens, time and cost per step. No rows exist for editing a flow's source, a test Run or switching a step's model. |
| All | 173 | 11 | 37 | | |

## 2. Off

Two features ship switched off because of a known hole (ruled by smithers-8a).

| Feature | Switch | A person sees instead |
|---|---|---|
| File card code intelligence | `lspConfinementReceipt` is empty, `packages/backend/internal/compose/language_servers.go:19` | The File card shows the file's text. No hover, go to definition or diagnostics. |
| Live code co-editing | `LiveCodeDocuments` is unset, `packages/backend/internal/compose/main.go:199` | File cards are read-only. Nobody types in a code file from the File card. Edits come from a terminal, SSH or the coding agent. Wiki co-editing is on. |

## 3. Broken

Every red row on the latest board.

| | Row | Error | Lane |
|---|---|---|---|
| J4 | 12 Move T4 above T3 | The move answers 409 "TODO moved; try again". | fr18-j4-move. Fix landed in d9bdb772e2. Not rerun on the board. |
| J5 | 15 TODO A keeps D1 | After its answer the TODO ends `failed`: `coding/NativeCodingError/source_refused`. | fr18-j5-source-refused. Running, no report. |
| J5 | 17 Retry current flow adopts D2 | "A has no reviewed predecessor head". Follows row 15. | same |
| J7 | 9 TN builds on T2's verified head | T2 ends `failed`: `coding/NativeCodingError/source_refused`. | same |
| J7 | 10 Fork T2 | T2 has no verified head to fork. Follows row 9. | same |
| J7 | 11 Scratch stays off GitHub | No scratch branch exists. Follows row 10. | same |
| J7 | 12 Edit on scratch | No Git token was minted. Follows row 11. | same |
| J10 | 5 T2 follows T1's merge | T2 did not follow T1's merge in 8 minutes. It stays queued and its PR stays a draft. | fr18-j10-follow-merge. Cause found, no fix yet. |
| J10 | 5 Merge T2 on GitHub | GitHub answers 405 "Pull request is not mergeable". Follows the row above. | same |
| J10 | 6 main reads synced | Sync reads stale. Last success was 12 minutes earlier. | same |
| J10 | 6 Network drop turns stale past 120 s, Retry | Stale 12 minutes after the last success. The limit is 120 s. | same |

J10's cause, from the lane: after T1 merges, T2 reaches its 12-run limit. The owner's Retry is accepted, then T2 stops with "the previous lane could not be retired".

Lane reruns on newer commits failed two rows the board shows green:

- J4 row 17: after T1 merges, T2's PR still contains T1's file. Lane: fr18-j10-follow-merge (#3532).
- J7 row 15: a dropped TODO keeps its machine after 60 s. Lane: not checked.

## 4. Unverified

No ticket below has a Mac mini run. The Mac mini schedule lists 192 runs across 68 tickets, about 117 hours on one Mac. It is stopped until the prerelease is out (`~/smithers-lanes/mini-schedule/HOLD.md`).

Skipped: the 37 pending journey rows (section 1), and the installer and Homebrew jobs in the dry run (section 6).

### Code on main, no real-machine run (80 tickets)

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

### Sign-offs not done

| Who | Sign-off | Tickets |
|---|---|---|
| Will | Engineering spec approval. Approval of the specs that replace `docs/mvp/*`. | T-DOC-02, T-DOC-03 |
| smithers-06, design | Per-screen copy review. Co-editing visuals. | T-UI-16, 17, 18, 19, 20, 21, 22, T-FM-01 |
| smithers-3f, security | Provenance boundaries, outbox refusal paths, Homebrew signing, guest root boundary, secrets as files, Plue receipt. | T-PRC-03, T-COL-13, T-INS-03, T-SEC-01, T-MCH-16, T-APP-16 |
| smithers-22 | A real check mapping. None is approved. | T-PRC-03, T-COL-03r |
| smithers-8a | ADR acceptance, reference inventory, outbox version rule. | T-DOC-02, T-DOC-03, T-COL-13 |
| smithers-38 | Public exports and library review. | T-AGT-01 |
| Cloudflare token holder | Deploy the docs redirect. Retire the 48 site Workers. | T-DOC-04 |

### Specific lines

- Learning machine isolation (T-FLW-06): no 3f review, no reference-host run; relies on sandboxed isolation and no source publisher on the learning workspace.
- Guest helper change b596ce787b (`state-read`/`state-write`): three questions are open with smithers-3f.
  1. Which uid runs them, and can a repository-code uid write under `/var/lib/smithers/state`?
  2. Who creates `managed-hosts/<sha>/`, and with what mode?
  3. Does the read need `O_NOFOLLOW`?

  The host checks `binding.json` by ID, so a forged file only refuses its own machine.
- Machine daemon wire protocols 7 to 12 await smithers-3f's delta reviews.
- Agent edits through the real machine daemon have run only against a fixture on Linux. Real-VM development runs on a MacBook passed 14 of 17 bundle-less `TestRealMicroVM*` tests (3 after fixes b596ce787b and 5e1a8748b5). `TestRealMicroVMWorkspaceConformance` still fails for lack of a composed-daemon fixture.

## 5. Not in this prerelease

### Not started, after launch (11 tickets)

| Tickets | What |
|---|---|
| T-MNT-01 to 05 | Maintainers with outside contributors: incoming items, issue triage, approved author replies, outside PR review, the day-seven upgrade. |
| T-AGT-04 | The internal `/ceo` flow. |
| T-RMT-01 to 05 | Machines on remote Linux hosts and Cloud boxes. |

### Still being built (25 tickets)

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

## 6. Publish

Do not publish yet. The dry run is not green (top of this file).

### What a tag push publishes

Checked 13:15 PDT with `npm view` and `gh api`, against the workflow on main.

- 49 npm packages at one version under the `next` dist-tag. `latest` stays at 0.35.0.
- 37 of the 49 names are new to npm. 12 exist at 0.35.0.
- `smthrs` has no `1.0.0-rc` version on npm. `next` does not exist yet. Tag `v1.0.0-rc.0` exists on GitHub; `smthrs@1.0.0-rc.0` is not on npm.
- New names publish with the `NPM_TOKEN` repository secret, set 2026-09-22. Whether it still works: not checked.
- The `npm-publish` environment has no required reviewers. The tag push publishes without a second approval.
- The Homebrew bottle and tap formula will not publish. That job requires passing `C-REL-02`, `C-J1-01` and `C-J1-04` check runs on the tagged commit. All three are recorded Mac mini runs, and the Mac mini schedule is stopped. `RELEASE_QUALIFICATION_APP_ID` is not set, the `homebrew-publish` environment does not exist on GitHub, and no `HOMEBREW_TAP_TOKEN` repository secret is set.
- Expect the Release run to end red at the Homebrew job after npm publishes, unless the release-path agent changes that job first.
- Whether `npm install -g smthrs@next` alone starts an install on a Mac: not checked.

### Commands

Run these after `STATE.md` shows a green dry run on the cut commit.

```sh
cd ~/smithers
V=1.0.0-rc.2                      # the version STATE.md names for the cut
SHA=<full SHA of the cut commit>  # the commit the green dry run tested
git fetch origin main
git tag -a "v$V" -m "🔖 release: $V" "$SHA"
git push origin "v$V"             # this publishes
```

Check it:

```sh
gh run list --workflow release.yml -L 1
npm view smthrs dist-tags         # expect next = $V, latest = 0.35.0
npm install -g smthrs@next && smthrs --version
```

If the run fails after some packages published, do not re-run it. Resume it (`scripts/release-resume.md`):

```sh
RUN=<failed run id>
ART=$(gh api "repos/smithersai/smithers/actions/runs/$RUN/artifacts" \
  --jq ".artifacts[] | select(.name==\"release-candidate-$RUN\") | .id")
gh workflow run release.yml --ref main \
  -f releaseTag="v$V" -f candidateRunId="$RUN" -f candidateArtifactId="$ART" -F dryRun=false
```
