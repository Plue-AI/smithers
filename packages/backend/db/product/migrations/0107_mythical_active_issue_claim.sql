-- T-STK-09: retain issue history; only an unmerged, undropped item owns
-- admission. These are the existing engine states projected by spec §4.1.
DROP INDEX mythical_items_issue_idx;
CREATE UNIQUE INDEX mythical_items_issue_idx
    ON mythical_items (repository_id, issue_number)
    WHERE issue_number IS NOT NULL
      AND state NOT IN ('landed', 'cancelled', 'rejected', 'declined');
CREATE INDEX mythical_items_issue_history_idx
    ON mythical_items (repository_id, issue_number, created_at DESC, id DESC)
    WHERE issue_number IS NOT NULL;
