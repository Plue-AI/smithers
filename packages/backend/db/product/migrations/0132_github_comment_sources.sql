ALTER TABLE github_synced_issue_comments ADD COLUMN source text NOT NULL DEFAULT 'conversation' CHECK (source IN ('conversation','review'));
DROP INDEX uq_github_synced_issue_comments_github_id;
CREATE UNIQUE INDEX uq_github_synced_issue_comments_github_id ON github_synced_issue_comments(synced_repo_id,source,github_id);
