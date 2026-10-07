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
failure. Missing review, candidate/operator mismatch, partial capture, raw-file
aliases, empty files and digest mismatch refuse retention. Existing evidence
is never overwritten. The raw capture is never copied and stays under the
operator's control. Incomplete failed runs also require a full capture of the
attempt and its failure; missing safe evidence leaves the attempt failed.

This review is a human attestation about retention, not an authenticated check
receipt or automated proof of redaction. It does not approve reference-host
mappings. Successful per-step traces/videos and complete journey recordings
remain required for release; this spec does not supply those automatically.
