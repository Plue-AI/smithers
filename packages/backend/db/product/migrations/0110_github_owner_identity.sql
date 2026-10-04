-- GitHub owns sign-in. Retain the immutable owner and seed repository access.
INSERT INTO collaborators(repository_id,user_id,permission)
SELECT r.id,o.user_id,'admin' FROM repositories r CROSS JOIN self_host_owners o
ON CONFLICT(repository_id,user_id) WHERE user_id IS NOT NULL DO UPDATE SET permission='admin';
DROP TABLE local_credentials;
