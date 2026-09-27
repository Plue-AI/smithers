-- A workspace that ran work started from an outsider's text boots with
-- GitHub conversation withheld from its egress. egress_sealed_at is when
-- its box was first known to run only such a proxy: a box that booted
-- before the mark is suspended once before outsider-started work runs.
ALTER TABLE outsider_workspaces ADD COLUMN egress_sealed_at timestamptz;

-- Lanes of outsider items opened before lanes were marked.
INSERT INTO outsider_workspaces (workspace_id, repository_id)
SELECT lower(l.workspace_id), l.repository_id
FROM mythical_lanes l JOIN mythical_items i ON i.id = l.item_id
WHERE i.outsider
ON CONFLICT (workspace_id) DO NOTHING;
