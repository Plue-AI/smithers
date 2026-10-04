-- T-INS-06: App creation precedes repository selection. Retain existing
-- repository-bound conversion receipts; new App attempts have no selected repo.
ALTER TABLE github_app_manifest_states
    DROP CONSTRAINT github_app_manifest_states_repository_name_check;
