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
