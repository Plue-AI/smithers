CREATE TABLE repository_transfer_requests (
    id BIGSERIAL PRIMARY KEY,
    repository_id BIGINT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    sender_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    recipient_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    source_user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
    source_org_id BIGINT REFERENCES organizations(id) ON DELETE CASCADE,
    source_owner TEXT NOT NULL,
    source_name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined', 'cancelled', 'expired')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    expires_at TIMESTAMPTZ NOT NULL DEFAULT (clock_timestamp() + INTERVAL '7 days'),
    resolved_at TIMESTAMPTZ,
    CHECK (num_nonnulls(source_user_id, source_org_id) = 1),
    CHECK (expires_at > created_at)
);
CREATE UNIQUE INDEX repository_transfer_requests_pending_repo
    ON repository_transfer_requests(repository_id) WHERE status = 'pending';
CREATE INDEX repository_transfer_requests_recipient
    ON repository_transfer_requests(recipient_id, id) WHERE status = 'pending';

-- Consent names a particular source repository. A rename or another transfer
-- invalidates it, even if the repository later returns to its original owner.
CREATE FUNCTION cancel_changed_repository_transfers() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.user_id IS DISTINCT FROM NEW.user_id OR OLD.org_id IS DISTINCT FROM NEW.org_id
       OR OLD.name IS DISTINCT FROM NEW.name THEN
        UPDATE repository_transfer_requests SET status = 'cancelled', resolved_at = clock_timestamp()
        WHERE repository_id = NEW.id AND status = 'pending';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER cancel_changed_repository_transfers
    AFTER UPDATE OF user_id, org_id, name ON repositories
    FOR EACH ROW EXECUTE FUNCTION cancel_changed_repository_transfers();
