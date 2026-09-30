# Worker final reports

Queue results come from the coding CLI's successful structured final assistant
report: Codex JSON events ending in a completed turn, or Claude's successful
JSON result. Tool output and stderr remain diagnostics, never queue results.
Quoted examples stay excluded until their matching Markdown fence closes.
A failed process exit cannot produce READY. Structured final quota errors return
limited even when the CLI exits zero; limit words in a successful report or tool
output do not override a successful final result.
Codex transient errors can recover when the same turn completes successfully;
a failed turn cannot recover without a new turn.

READY accepts full commit IDs in assigned issue order, or explicit
`READY #<issue> <commit>` mappings. Explicit mappings reserve their issues before
implicit lines are assigned. Repeats are deduplicated; unknown issues, conflicting
mappings, contradictory statuses for one issue, excess commits and inconsistent
repositories fail the bundle. READY for one issue can coexist with BLOCKED for
another assigned issue.

CLOSED text requires host verification and returns blocked without a closure
receipt. It cannot hide an open issue from selection.

Cloud READY means a prepared commit. Guest suites are not run; launcher Fable
review and host queue CI must pass before landing. Final product bug review
requires Fable; unavailable Fable blocks the candidate without an Opus fallback. The launcher holds claims on
its hostname. Author trailers follow the assignment's tool and model; Cloud
reconstruction must preserve that attribution.
