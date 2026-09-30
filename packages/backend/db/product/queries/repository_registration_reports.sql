-- name: GetRepositoryRegistrationReport :one
SELECT *
FROM repository_registration_reports
WHERE host = sqlc.arg(host)
  AND owner = sqlc.arg(owner)
  AND name = sqlc.arg(name)
  AND commit_sha = sqlc.arg(commit_sha);

-- name: InsertRepositoryRegistrationReport :execrows
INSERT INTO repository_registration_reports (host, owner, name, commit_sha, report)
VALUES (sqlc.arg(host), sqlc.arg(owner), sqlc.arg(name), sqlc.arg(commit_sha), sqlc.arg(report)::jsonb)
ON CONFLICT (host, owner, name, commit_sha) DO NOTHING;
