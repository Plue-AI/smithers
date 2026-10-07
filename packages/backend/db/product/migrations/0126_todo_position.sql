-- One occupied slot per repository. Settled history retains its former slot;
-- placement transactions vacate a slot before shifting or swapping items.
CREATE UNIQUE INDEX mythical_items_stack_position_idx
ON mythical_items(repository_id, stack_position)
WHERE state NOT IN ('landed', 'cancelled', 'rejected', 'declined');
