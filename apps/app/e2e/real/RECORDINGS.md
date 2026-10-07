# Activation recording retention

`j1-activation.spec.ts` observes an independently operated install. It does not
perform the fresh-user Homebrew installation or qualify T-REL-02 by itself.

Automatic Playwright trace, video and screenshot capture is off for this spec:
setup URLs, OAuth cookies and model-key entry must not enter test artifacts.
Keep the raw full-run capture outside the test artifact directory. After the
run, a person sanitizes it and reviews the entire resulting recording. Set
`SMITHERS_J1_RECORDING_REVIEW` before launching the spec to the path where they
will write this JSON before the test finishes:

```json
{
  "candidate": "<installed 40-character commit SHA>",
  "operator": "<same independent operator as the preconditions>",
  "reviewedBy": "<person who reviewed the sanitized recording>",
  "reviewedAt": "<UTC ISO timestamp>",
  "recording": "<separate sanitized full-run MP4 path>",
  "sha256": "<64-character SHA-256 of that MP4>",
  "fullRun": true,
  "credentialsRemoved": true
}
```

The completion hook retains only bytes matching that digest, on success or
failure. Missing review, candidate/operator mismatch, self-review (including whitespace
and case variations), blank reviewer, partial capture, raw-file
aliases, empty files and digest mismatch refuse retention. Existing evidence
is never overwritten. The raw capture is never copied and stays under the
operator's control. Incomplete failed runs also require a full capture of the
attempt and its failure; missing safe evidence leaves the attempt failed.

This review is a human attestation about retention, not an authenticated check
receipt or automated proof of redaction. It does not approve reference-host
mappings. Successful per-step traces/videos and complete journey recordings
remain required for release; this spec does not supply those automatically.

Keyboard evidence uses `installKeyboardOnly` before constructing locators and
`recordKeyboardFocus` after each app action and again after its asynchronous
card/live update settles. Finalize both logs with `assertKeyboardOnly` and
`assertKeyboardFocus`; catching an earlier refusal cannot clear it. Focus logs
contain only UTC time, element tag and computed ring properties, never field
values, labels or setup URLs. The focus helper's Chromium/WebKit DOM regression
tests are supplemental coverage; they do not complete C-UI-01 or any journey.

The exclusive `j1.spec.ts` entry runs the released tap install and per-user
`smthrs host start` on a non-root Apple Silicon Mac, then uses the same rendered
activation path. Declare the configured origin and candidate in the operator
preconditions before starting; the one-time setup URL is taken from launcher
stdout in memory. An existing formula, wrong version, wrong origin or ambiguous
launcher URL refuses the run. No launcher output is retained.

`keyboard-journeys.spec.ts` currently reuses the first-TODO/merge slice with
Tab traversal, physical key input, and focus observations after actions and
settled updates. It is **partial C-UI-01 coverage**: remaining J1 steps and
J2–J8/J10/J11, overlay restoration and both-browser reference recordings still
need completion on the real install. It cannot supply a whole-check receipt.
Setup credential entry remains independently operated; automatic secret-bearing
traces and video remain disabled. Both-theme per-card sanitized capture and
reviewed per-step traces/videos are still release requirements, not supplied by
these entries. Missing host, credentials, human review or approved mapping must
never be replaced with fixture evidence.

The prepared-install `withReference` journeys support
`SMITHERS_JOURNEY_KEYBOARD=1` and `SMITHERS_JOURNEY_THEME=light|dark`.
Run each owning spec separately against a fresh canary for each theme and browser;
these destructive journeys cannot replay into the same repository. J2 draft,
answer, evidence and merge, shared wiki editing/refresh, and the GitHub review
spec use the shared physical-input doors. Other direct pointer calls still refuse
under the guard. Per-member keyboard logs survive failed attempts. Focus is
observed again at HTTP readback and final completion, after live updates.
Theme capture retains every visible card at those checkpoints with actor and
theme in its attachment name. This is checkpoint capture, not proof that every
journey/card has been reached. Setup and credential-entry recordings continue
through the separately reviewed recording path above.

These additions do not complete C-UI-01: fresh setup and the remaining J1,
J3–J7, J10 and J11 steps still require real-install keyboard coverage and
reference-host execution. No Mac recording, live credential soak, microVM proof
or approved check receipt is produced by supplemental browser tests.

The keyboard entry also lists three prepared-install passes: branch/terminal,
stack/flow/monitor doors; outside saves; and backend restart. They are
reference-only scaffolding, not passing journey receipts. The branch pass needs
T2 “Retry webhooks” on `smithers/retry-webhooks`, a queued “Document webhook
retries”, a retryable failure, the repository-owned TODO flow, and Ben's live
Claude Code subscription. It covers traversal of these doors; the owning checks
still prove complete J5 activation/pinning and J10 synchronization behavior.

For outside saves, prepare the awake scratch branch `ben/outside-save` and the
owner's production SSH gateway in `SMITHERS_JOURNEY_OWNER_SSH_HOST` and
`SMITHERS_JOURNEY_OWNER_SSH_PORT`. The test writes only `outside-save.txt` in
that guest working copy. No agent session may be active. It checks both saved
editor lines against guest bytes, SSH attribution, an untouched-line merge,
an overlapping-line snapshot and both Compare views.

The restart pass observes Working T2 and its real engine journal. The owner
records killing their backend with signal 9 and its launcher restart; this test
never signals a process. `SMITHERS_JOURNEY_RESTART_EVIDENCE` names their JSON
with `signal: 9`, `pid`, `runId`, `candidate`, `operator`, `killedAt` (UTC ISO)
and `launcherRestarted: true`. The test must observe a backend outage and return,
retain the same candidate, preserve the journal prefix, observe an owner-loss
recovery decision and reach In review without rerunning completed steps. The
operator file alone supplies no authenticated manual receipt or passing check.

The shared wiki pass now replaces the decision through Ben's editor, files the
next TODO through the app, and compares its exact `{slug, revision, digest}`
citation and GitHub README bytes with checked-in expectations. The issue pass
sends two Enter activations, requires one browser launch, then replays the same
Idempotency-Key and requires the original HTTP status and result.

In keyboard mode, selected-theme card capture also runs after traversal and
before activation, then again after input. This retains transient cards that
are dismissed before HTTP readback. Unchanged card markup is deduplicated;
readback and completion still capture settled changes. The pre-input capture
starts only after theme selection, never during setup credential entry.

The keyboard helper now awaits a native event guard before setup/navigation.
It observes the independent headed operator as well as Playwright, blocks
pointer/wheel/touch activation in the app, and preserves each refusal in the
same final log. GitHub remains the explicit exclusion. Keyboard-generated
zero-detail clicks remain enabled. Native logs contain event kind, UTC time and
origin only; never key names, coordinates, text or setup-token queries.

`flow-activation.spec.ts` adds a prepared J5 continuation. On a fresh canary,
prepare T1 as the real factory edit adding `pnpm test` and a `changelog` step
that updates `CHANGELOG.md`; leave it In review and ready for human merge.
T2 must be Needs you with an open question in its original attempt. The pass
reviews T1's GitHub patch, merges from the TODO card, observes the new Active
version, verifies T2's identity stays pinned, and creates T3 to observe its new
pin and real PR/check evidence. It supports the same keyboard and theme settings.
This does not cover chat teaching, immutable closure retry, learning proposals,
or watchdog qualification; those portions of C-J5-01 remain outstanding.

The prepared keyboard continuation now checks Escape from Home's order menu
and from Chat restores focus to the initiating order button. Locator key
shortcuts (`locator.press`, `pressSequentially`, and `type`) are refused: only
`page.keyboard` can supply app input. Neither source collection nor supplemental
Chromium regression tests supply a reference-host C-UI-01 receipt.

`github-j10/merge-on-github.spec.ts` supplies the prepared J10.5 continuation:
all earlier items Merged, T7 and T8 In review from two real GitHub issues, T7
Fixes enabled and T8 disabled. It requires keyboard mode and an explicit theme.
The independent owner merges each verified head on GitHub. The pass observes
Home and TODO ordering, owner attribution, the new main commit, T8's rebase,
the App's issue closure/comment, the other issue staying open, and the absence
of an App merge call or Land approval. It consumes the production outbound
GitHub audit log. Source collection is not execution or qualification; stale
attention handling and the remaining J10 sync/push/network cases are separate.
