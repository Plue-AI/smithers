# Lane `review` — the Review facet, turn, threads, verdicts, auto-land

Brief: `../decisions/0004-review.md`. Depends on lane `change`. Laws as
every lane; verdicts user-only; confidence is a word, never a number.

Scope, in order:
1. Header lines: `turn: <party>`, the three-row verdict strip (agent LGTM
   with confidence word, human approval with revision and revisions since,
   `owners · not available`), the `landing when green` state line, and the
   `Walkthrough` facet position rule (agent-made revision and >20 files).
2. Review facet: "since your review at rev N → rev M" default with "show
   all"; thread rows with states ○ open, ◐ done, ● resolved and one-click
   Done (author) / Ack (reviewer) / Reopen; stale and moved tokens; the
   Suggested-reviewers slot rendered empty with its reason.
3. Flows: `review.since-mine`, `review.done`, `review.ack`, `review.reopen`,
   `change.land-when-green` (confirm), `change.cancel-auto-land`,
   `findings.please-fix` (confirm), `findings.not-useful`,
   `change.walkthrough`; retire `findings.mute`. Slash payloads, registry
   and parity tests.
4. Land button reasons from `blocked_by`: threads open, missing agent LGTM
   or human approval, checks.
5. Walkthrough facet rendering review sections and diagrams from the walkthrough route; empty state when none exists.
Exit: card tests per thread state and per verdict row; seam tests with
doubles; T1 spec: comment, Done, Ack, Land button reason updates each time.
Never fake a route the backend lacks: render the ADR's empty wording.
