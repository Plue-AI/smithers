-- T-MCH-08: a scratch fork records what it was forked from on its existing
-- workspace row (spec §8.5.3 forked_from {kind, ref, commit, base, item?}).
-- commit is source_commit and the item's workspace is parent_workspace_id;
-- only the item and the base its change is measured from are new. No
-- branches table (§8.1.2).
ALTER TABLE workspaces
 ADD COLUMN forked_from_item uuid REFERENCES mythical_items(id) ON DELETE SET NULL,
 ADD COLUMN forked_from_base text NOT NULL DEFAULT '';
