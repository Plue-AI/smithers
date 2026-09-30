# Worker final reports

Queue results come from the coding CLI's successful structured final assistant
report: Codex JSON events ending in a completed turn, or Claude's successful
JSON result. Tool output and stderr remain diagnostics, never queue results.
A failed process exit cannot produce READY.

READY accepts full commit IDs in assigned issue order, or explicit
`READY #<issue> <commit>` mappings. Explicit mappings reserve their issues before
implicit lines are assigned. Repeats are deduplicated; unknown issues, conflicting
mappings, excess commits and inconsistent repositories fail the bundle.

CLOSED text requires host verification and returns blocked without a closure
receipt. It cannot hide an open issue from selection.

Cloud READY means a prepared commit. Guest suites are not run; launcher Fable
review and host queue CI must pass before landing. The launcher holds claims on
its hostname. Author trailers follow the assignment's tool and model; Cloud
reconstruction must preserve that attribution.
