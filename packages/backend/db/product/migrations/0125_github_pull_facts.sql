ALTER TABLE github_synced_issues ADD COLUMN related_facts jsonb NOT NULL DEFAULT '{}'::jsonb;
