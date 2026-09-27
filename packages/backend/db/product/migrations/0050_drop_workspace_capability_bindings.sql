-- Repository setup no longer selects a box by capability (#2198): every box
-- runs the coding catalog's pinned host, so a capability belongs to the
-- catalog, not to a box. Setup uses the repository's ordinary box and no code
-- reads these bindings any more.
DROP TABLE IF EXISTS workspace_capability_bindings;
