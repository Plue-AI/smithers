-- A branch fact survives run replacement, Stop and Retry.
ALTER TABLE workspaces ADD COLUMN moved_off jsonb;
ALTER TABLE workspaces ADD CONSTRAINT workspaces_moved_off_object
 CHECK (moved_off IS NULL OR jsonb_typeof(moved_off) = 'object');
