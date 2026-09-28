# Review commands

Comment `@smithers review` on an open pull request to trigger the action.
The commenter needs write, maintain, or admin permission on the repository;
comments from bots or GitHub Apps never trigger.

For a local walkthrough without model calls:

```sh
smithers-review /path/to/repo --no-review --no-narrate --quiz off
```

`--no-review` skips review agents. `--no-narrate` uses deterministic story order.
`--quiz` is independent of both flags and defaults to `auto`, which calls a
model for high or critical impact changes. Set `--quiz off` alongside both
flags for offline use. `--quiz on` forces quiz generation.

`--timeout <min>` sets a deadline for each file review, verification, narration,
and quiz action. The default is 10 minutes; values must be finite and at least
1 minute. Each action gets its own deadline, including model retries and schema
corrections. Expiry interrupts the call. A timed-out file becomes a
`subtask_error` warning; verification leaves findings unverified, narration uses
the deterministic story, and quiz generation returns no quiz.

The terminal and JSON run summary include each review warning. A failed
verification promotes an otherwise successful review to
`completed_with_warnings`, retains its findings, and identifies the verifier
seat and failure reason. The findings remain unverified.

The standalone HTML includes review status, warnings, and per-file coverage.
Failed, skipped, and partial reviews do not present zero findings as a clean
result. Files excluded from review or carrying file-review errors are marked
`not reviewed`; a file with errors may have been only partially reviewed.

`--out` (default `.smithers-review/walkthrough.html`) is replaced atomically.
Each render also retains an independent HTML file in `.smithers-review-artifacts/`
beside the output. The workflow returns that file as `walkthrough.artifactPath`;
`--publish` uploads it, so concurrent runs cannot swap published content.
The JSON summary exposes it as `walkthroughArtifactPath`. Retain these files
while a run may resume or publish; remove them manually when no longer needed.
Older recorded results without an artifact path must be rerun before publishing.
A render inside the reviewed repository refuses to write through a symbolic
link there, so a checked-out `.smithers-review` link cannot redirect the output.
`--publish` sends its token only to an `https:` URL; `http:` is accepted for
`localhost`, `127.0.0.1`, and `[::1]`.

A review leaves its own files out of the change set it reviews: `.smithers-review/`,
the `--out` file, its `.smithers-review-artifacts/` directory, and the `--db` file
with its SQLite sidecars.

`--execution-id <id>` selects a durable review in `--db <file>` (default:
`<repo>/.smithers-review/review.db`). An unused ID starts a review. Without this
option, every invocation generates a fresh ID. The CLI prints the ID at startup
and on execution failure.

To recover after a crash, repeat the original command with its printed ID,
the same database and review options:

```sh
smithers-review /path/to/repo --db /path/to/review.db --execution-id review-recovery
```

The engine rejects an existing ID if the decoded review input differs,
including the repository, target, background, output, database, and review switches.
Keep the original seat configuration for unfinished model work. A settled
preparation preserves the original diff even when the working tree changes.
Settled file batches reuse their findings without another provider call;
in-flight calls may repeat. Before preparation settles, recovery can still
read the current tree. A completed execution returns its recorded result.
Use a fresh ID to review new changes. `--publish` and `--pr` reporting run
again after recovery when supplied; these external effects are outside the
durable review flow.


File-review progress includes the path and that file's turn count. The final
stderr line and JSON `tokens: { input, output, total }` report model usage
observed during this CLI invocation. A fully replayed action emits no new
usage; replayed events from an unfinished action may be observed again. These
counts are diagnostics, not billing totals. Agent-written token totals are
ignored; unmeasured review-summary usage is `null`.

Narrator and quiz failures remain visible as `narrator_error` and `quiz_error`
warnings in terminal output, the JSON summary, PR output, and the walkthrough.
Findings remain available; narration uses its deterministic fallback and a
failed quiz is omitted. A successful review becomes `completed_with_warnings`.
