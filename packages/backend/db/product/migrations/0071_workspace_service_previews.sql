-- Only an explicit owner choice opens an individual workspace port.
CREATE TABLE workspace_service_previews (
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    port INTEGER NOT NULL CHECK (port BETWEEN 1 AND 65535),
    public BOOLEAN NOT NULL DEFAULT FALSE,
    PRIMARY KEY (workspace_id, port)
);
