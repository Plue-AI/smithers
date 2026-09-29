---
title: Native review finalization
description: Finding scope, anchors, and completion status for native reviews.
---

`finalizeNativeReview` accepts a readonly array of `NativeReviewFileResult`.
Each entry pairs a prepared file with its agent output. Results are matched by
file ID; their array order does not assign files. Omitted or null outputs count
as failed file reviews.

A finding with an empty path inherits the reviewed file path. An explicit path
must match that file after trimming; a mismatch is dropped with a file-scoped
`out_of_scope_comment` warning. Anchors resolve against that file's diff.
Inside a hunk, `+++` and `---` prefixes are code lines, not file headers.

Code snippets that match only the old side remain unanchored, including when
the reviewer supplies a surviving line number. Finalization retains the finding
with zero line numbers; GitHub displays it in the review body without an
applicable suggestion. A unique new-side snippet can still resolve an inline
anchor and an applicable replacement.

| Agent status | Finalization |
| --- | --- |
| `success` | Retain findings and warnings. |
| `completed_with_warnings` | Also emit a file-scoped `subtask_warning` containing the status message. |
| `completed_with_errors` | Also emit a file-scoped `subtask_error` containing the status message. |
| `failed` | Count a failed file and emit a file-scoped `subtask_error`. |

Empty status messages receive a diagnostic fallback. The aggregate is `failed`
when every file review fails, `completed_with_warnings` when any warning exists,
and `success` otherwise. A review with warnings never gives a clean approval
message merely because it produced no findings.
