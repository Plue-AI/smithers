-- A planner's decline is its own state: admission re-evaluates a skipped
-- item on every sweep, but a declined item waits for new issue text or a
-- person's retry.
ALTER TABLE mythical_items
  DROP CONSTRAINT mythical_items_state_check,
  ADD CONSTRAINT mythical_items_state_check
    CHECK (state IN ('queued', 'skipped', 'declined', 'cancelled', 'running', 'delivering', 'integrating', 'verifying',
                     'proposing', 'waiting', 'proposed', 'landed', 'rejected', 'retrying', 'blocked'));

UPDATE mythical_items SET state = 'declined'
  WHERE state = 'skipped' AND request_outcome LIKE 'declined: %'
    AND reason = substring(request_outcome from 11);
