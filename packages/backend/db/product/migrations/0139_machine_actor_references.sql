-- Host-owned attribution survives process/session lifetime and event retention.
-- These references grant no authorization and contain no bearer credentials.
CREATE TABLE machine_actor_references (
    id UUID PRIMARY KEY,
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    machine_id TEXT NOT NULL CHECK (machine_id <> '' AND octet_length(machine_id) <= 1024),
    actor JSONB NOT NULL CHECK (jsonb_typeof(actor) = 'object' AND octet_length(actor::text) <= 1024),
    digest BYTEA NOT NULL CHECK (octet_length(digest) = 32),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (workspace_id, machine_id, digest)
);

CREATE FUNCTION reject_machine_actor_reference_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'machine actor references are immutable';
END
$$;
CREATE TRIGGER machine_actor_reference_immutable BEFORE UPDATE ON machine_actor_references
FOR EACH ROW EXECUTE FUNCTION reject_machine_actor_reference_update();
