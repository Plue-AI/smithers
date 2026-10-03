-- The install's people (spec §3, §5.1). The owner is the members row with
-- role 'owner'; users stays the identity that sessions and tokens reference.
-- The password owner (self_host_owners, local_credentials) is replaced: the
-- owner is claimed by the first GitHub sign-in that carries the one-time
-- setup token, whose digest lives in install_settings.
-- Unix uids start at 20000; 19999 is the coding agent (spec §5.5.1).
CREATE SEQUENCE members_unix_uid_seq START WITH 20000 MINVALUE 20000;

CREATE TABLE members (
    id                    BIGSERIAL PRIMARY KEY,
    user_id               BIGINT NOT NULL UNIQUE REFERENCES users(id) ON DELETE RESTRICT,
    -- NULL only for an owner carried over from the password install whose
    -- GitHub account was never linked; that owner signs in with GitHub once
    -- an operator links it.
    github_user_id        BIGINT UNIQUE,
    login                 TEXT NOT NULL,
    role                  TEXT NOT NULL CHECK (role IN ('owner', 'maintainer', 'member')),
    unix_uid              INTEGER NOT NULL UNIQUE DEFAULT nextval('members_unix_uid_seq') CHECK (unix_uid >= 20000),
    added_by              BIGINT REFERENCES members(id) ON DELETE SET NULL,
    added_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    suspended_at          TIMESTAMPTZ,
    suspended_reason      TEXT,
    removed_at            TIMESTAMPTZ,
    last_access_check_at  TIMESTAMPTZ
);
ALTER SEQUENCE members_unix_uid_seq OWNED BY members.unix_uid;

-- One install, one owner (spec §2).
CREATE UNIQUE INDEX members_one_owner ON members (role) WHERE role = 'owner';

INSERT INTO members (user_id, github_user_id, login, role)
SELECT o.user_id,
       (SELECT a.provider_user_id::BIGINT
          FROM oauth_accounts a
         WHERE a.user_id = o.user_id
           AND a.provider = 'workos'
           AND a.provider_user_id ~ '^[0-9]+$'
         ORDER BY a.id
         LIMIT 1),
       u.username,
       'owner'
FROM self_host_owners o
JOIN users u ON u.id = o.user_id;

DROP TABLE local_credentials;
DROP TABLE self_host_owners;

-- A sign-in started from the setup URL carries the setup token's digest
-- through the GitHub round trip; the raw token is never stored.
ALTER TABLE oauth_states ADD COLUMN setup_token_digest TEXT;
