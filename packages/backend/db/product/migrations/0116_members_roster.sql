-- Pending GitHub identities live in collaborators, never a second roster.
CREATE SEQUENCE collaborator_unix_uid_seq START WITH 20000 MAXVALUE 2147483647 NO CYCLE;
ALTER TABLE collaborators ADD COLUMN github_id bigint, ADD COLUMN github_login text,
 ADD COLUMN unix_uid integer NOT NULL DEFAULT nextval('collaborator_unix_uid_seq'),
 ADD COLUMN suspended_at timestamptz;
CREATE UNIQUE INDEX collaborators_unix_uid_unique ON collaborators(unix_uid);
CREATE UNIQUE INDEX collaborators_github_unique ON collaborators(repository_id,github_id) WHERE github_id IS NOT NULL;
CREATE UNIQUE INDEX collaborators_login_unique ON collaborators(repository_id,lower(github_login)) WHERE github_login IS NOT NULL;
UPDATE collaborators c SET github_id=a.provider_user_id::bigint, github_login=u.username
FROM oauth_accounts a,users u WHERE a.user_id=c.user_id AND u.id=c.user_id AND a.provider='workos' AND a.provider_user_id ~ '^[0-9]+$';
