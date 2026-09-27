# Lane `stack-ops` — the stack card, operations, provenance

Brief: `../decisions/0003-change-unit.md` §2, §4. Depends on lane `change`.

Scope:
1. `stack` card: rows newest first, changeset rows as one row with a repo
   line, footer `Land N ready (a → b)` or `Land blocked · …` from the
   landing request's `landable_prefix` and `blocked_by`; flow
   `change.stack`, `change.land <stack>` (confirm).
2. `operations` card and flows `change.ops`, `change.undo` (confirm);
   History-row Operations toggle renders it inline.
3. History-row "Open the computer": `box.open --snapshot <id>`; the
   workspace card's facts line reads "forked from snapshot <id>".
4. Diff conflict hunk action `change.resolve` (confirm) rendering the run
   card; Revert footer action `change.revert` (confirm) rendering the new
   change card.
Exit: card tests for ready / blocked / changeset rows; seam tests; T1 spec
that undoes one operation on a fixture workspace.
