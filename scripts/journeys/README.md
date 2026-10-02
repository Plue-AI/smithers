# Release journeys

T-REL-02. These are recorded live journeys, with an observer verifying receipts.
They do not replace the checks' unit or integration suites. No marketing capture
code or scripted model is used.

Offline planning needs only Node:

```sh
node scripts/journeys/run.mjs --dry-run
node scripts/journeys/run.mjs --dry-run --theme dark --journey J10 --origin http://mini.local:4000
node --test --test-concurrency=2 scripts/journeys/run.test.mjs
pnpm exec smthrs test '//scripts:journeys' --jobs 2
```

The default plan includes J1–J8, J10 and J11 in both themes. It resolves every
check file and expands the ticket's Acceptance ranges, refusing missing coverage
or malformed definitions. Planning writes no evidence and reports no passes.
J9 and C-REL-03's separate upgrade campaign are outside this ticket. The latter
still gates release under mvp.md §12.6.

## Provisioning

Ops supplies the canary organization, three dedicated personal GitHub accounts
with repository write access (owner has admin), released tap and reference Mac
mini. Publish the contents of `template/` as the GitHub template
`smithers-mvp-canary/template`, on `main`, with squash merging enabled. There
are no `.smithers/` files or third-party dependencies. Its test command is
`npm test` or `pnpm test`; `JOURNEY.md` fixes the prompts and wiki decision.

The helpers read only these actor tokens from the environment:

- `JOURNEY_OWNER_TOKEN`
- `JOURNEY_BEN_TOKEN`
- `JOURNEY_ALICE_TOKEN`

Optional `JOURNEY_OWNER_LOGIN`, `JOURNEY_BEN_LOGIN` and `JOURNEY_ALICE_LOGIN`
bind each token to its intended account. The helpers verify three distinct user
IDs and permission receipts. They never fall back to `gh`'s ambient account.
Every REST call logs actor, method, path, UTC timestamp, status and request ID;
credentials and request/error bodies are omitted. Authentication, 2FA and rate
limits fail the run; they are not retried during recording.

```sh
node scripts/journeys/canary-repo.mjs smithers-mvp-canary/2026-10-03-light-chromium
```

Creation is idempotent. An existing repository must have the exact template
provenance, `main` as its default branch and squash merging enabled. A same-name
unrelated repository is refused. Date names use UTC; optional suffixes permit a
fresh canary per theme/browser campaign. No helper can address another owner.

## Live campaigns

Run the CLI on the second Apple Silicon Mac, with Playwright and its Chromium
and WebKit binaries already available. The reference host comes from the
released tap; do not use a development server. The host recording starts before
the first install keystroke. During first activation, the person operating the
app follows only the released quickstart; the QA observer collects evidence and
does not answer their questions. Assistance fails C-J1-04.

Each live invocation selects one theme and one browser engine. Perform separate
fresh campaigns for light/Chromium, light/WebKit, dark/Chromium and dark/WebKit;
this prevents a second browser from repeating a setup claim or merge against
already changed state. A single campaign is not the entire release gate. Use
`--journey` only to repeat a prepared scenario; it does not certify omitted
journeys. J1 starts on an erased host and new canary.

`JOURNEY_CONFIG` names a local JSON file. It contains no tokens. Required fields:

| Field | Value |
| --- | --- |
| `repository` | A fresh `smithers-mvp-canary/<UTC date>-<suffix>` |
| `origin` | Exact owner-configured public origin; HTTP LAN and HTTPS are supported |
| `browser` | `chromium` or `webkit` |
| `installVersion`, `commit` | Released version and exact source commit |
| `macOSBuild`, `hostProfile` | Recorded OS build and detected memory/CPU/free-space/limits |
| `referenceHost`, `browserMachine` | Distinct recorded machine identities |
| `quickstart` | Released quickstart identity used by the unassisted person |
| `freshInstall` | `true` only before J1; a responding `/readyz` refuses this bypass |
| `modelConfigPaths` | Actual read-only API paths on this release, covering all model roles, routing and repository overrides |
| `installStatePath` | Read-only install state API; defaults to `/api/install` |
| `hostRecorder` | `{target, remotePath}` for the reference Mac's SSH screen recorder |
| `hostRecording` | Alternative: path to an externally recorded and finalized reference-host movie |
| `evidence` | Map of step ID to nonempty source receipt file paths |
| `credentialSoak` | Complete 24 h credential-soak JSON receipt described below |
| `activation` | `{pr, t0, clockOffsetStartMs, clockOffsetEndMs}` |

`JOURNEY_INSTALL_TOKEN` supplies an owner credential for **read-only** model and
install-state probes, and for the explicitly configured duplicate launch. The
model probe reads the real install, rather than trusting a local configuration
file. Missing, unreadable or unrecognizable configuration blocks the run. Any
scripted, fixture, mock or replay adapter/model blocks it, including nested
routing and provider records. The install's repository must also match the
canary. The first model probe on a fresh J1 occurs after setup and before the
first question; later steps recheck it. Supply only API paths that expose
configuration without secret values. The paths depend on the released version;
the harness does not add a product endpoint.

```sh
node scripts/journeys/run.mjs --theme light --origin http://mini.local:4000
```

The observer completes the check's live scenario, compares each Pass/Fail
criterion, and explicitly records its observed verdict. A successful launch,
missing receipt or unfinished recording cannot pass a check. Browser actions
are keyboard-only on the install; GitHub-hosted consent, terminals and SSH are
logged exclusions. Each step opens independent owner, Ben and Alice contexts,
records video and trace, and carries their authentication state to the next
step in memory. Tab/Enter/Escape checkpoints capture touched cards. Do not type
credentials into the observer's verdict prompt. Scan evidence for credentials
before sharing it; raw authentication storage state is never an artifact.

`evidence[stepId]` names the factual receipts the observer exports during the
step: projections, snapshots, timing samples, PR/approval rows, tool output and
recovery receipts required by that check. Receipt files can be created while
the step is running. Browser recordings supplement these files. Each check
directory contains the source criteria, UTC JSONL step log, copied receipts,
and links to the host/browser Mac recordings and run summary. Abort and cleanup
failures preserve evidence and leave unfinished checks unpassed.

## Teammates and fault steps

`actions[stepId]` is an array of `{actor, action, input}`. The observer triggers
each at its coordinated checkpoint. Allowed actions are declared in that
step's data. Alternatively invoke the same logged helper independently:

```sh
node scripts/journeys/github-actors.mjs smithers-mvp-canary/2026-10-03-light-chromium ben reviewComment action.json
```

| Action | Input |
| --- | --- |
| `reviewComment` | `{pr, commitSha, path, line, body}` |
| `pushTodo` | `{branch, path, content, message, expectedHead}` |
| `unrelatedMerge` | `{branch:"journey/<unique name>", content, message}` |
| `mergePr` | `{pr, expectedHead}` |
| `setPrState` | `{pr, state:"closed"|"open"}` |

PRs must be wholly inside the canary and based on `main`. TODO pushes use the
Git data API, preserve the current parent, and update refs with `force:false`.
Merges are head-bound squash merges and require GitHub's `merged:true` receipt.
Use separate action inputs for repeated/aged PR cases. Record wall-clock aging
for the seven-day close/reopen boundary; do not fake a live install's clock.

`outsideSave` contains `{target, root, path, untouchedLine, typedLine,
untouchedText, typedText}`. `root` is the branch machine's working copy from its
SSH card, not a host source checkout. The live install guard establishes the
canary identity; the SSH helper additionally checks realpath containment and
refuses unsafe paths. Two explicit SAVE gates synchronize the typists with the
outside writes. It records base/saved digests and both outside versions; the
product must supply its merge/snapshot and acknowledged-save recovery receipts.
There is no artificial typing delay that pretends to establish a race.

`restart` contains `{target, pid, executable}` for the reference backend. The
harness verifies the executable at the PID before SIGKILL; launchd must recover
it. Killing is only a request: the observer must supply the real recovery
receipt proving completed steps did not rerun. `duplicateLaunch` contains
`{path, payload, key}` for a declared mutating API command. The harness sends it
twice with the same Idempotency-Key and compares the original durable result;
the observer also exercises double button activation and verifies one launch.

Network loss and the deliberate external canary-main rewrite use the
observer's reference-host/GitHub controls. They never target the Smithers
source repository. They require their own captured before/after receipts.

## Numeric evidence

Activation uses the recording's UTC `t0`, both measured clock offsets
(host UTC minus reference UTC, milliseconds), and GitHub's current `merged_at`.
An elapsed time over 60 minutes fails, including a run that otherwise merged.

The soak receipt has `startedAt`, `finishedAt`, `installVersion`, `commit`,
`machines:[A,B]`, `calls`, `wakes` and `credentialChanges`. All times are UTC ISO
strings. Calls contain `{machine,tool:"claude"|"codex"|"gh",cycle:0..144,
timestamp,exitCode:0,loginPrompt:false}`: 145 ten-minute cycles per tool and
machine, allowing at most one minute of scheduler delay. Wakes contain
`{machine:B,cycle:24|48|72|96|120|144,sleptAt,wokeAt,firstCallSucceeded:true}`.
Credential events contain `{machine,receivedMachine,written_at,receivedAt}`;
each refresh must reach the other machine before its next call. Missing calls,
failed authentication, prompts, missed wakes, late refreshes and wrong releases
fail. This validator consumes actual exported logs; unit examples are not soak
evidence. Retain the raw redacted call and credential event logs too.
