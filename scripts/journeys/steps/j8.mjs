import { journey } from "./define.mjs"
export default journey("J8", "Memory", [
  ["learning", "C-J8-01", "After a real merge, learning writes the decision and reason to wiki with the change link. Retain completed learning and page revision receipts."],
  ["coedit", "C-J8-02", "Ben and Alice co-edit the decision page live, including concurrent typing on one line. Apply JOURNEY.md's fixed wiki decision and retain identical text, attribution and exact revision digest."],
  ["folder", "C-J8-03", "Set the wiki folder in Settings; edit the decision from Obsidian on the host and verify an attributed imported revision. An app edit appears in the folder; record both directions and sync failures."],
  ["citation", "C-J8-04", "Place the related TODO from JOURNEY.md. Its real plan cites the edited {slug,revision,digest}, matches the stored Markdown SHA-256 and follows that decision in its change. Edit again and retry: old receipt stays pinned, new attempt cites the new revision, stale pages are excluded."],
  ["follows-decision", "C-J8-05", "Edit the decision page to a rule incompatible with the old one, with a before-edit control TODO. The next related TODO's plan cites the new revision and its change applies the new rule, not the old."],
  ["generated-pages", "C-J8-06", "After the first merge on the fresh canary, a background wiki run shows on Home and the overview, architecture and per-package pages exist at the merge commit."]
])
