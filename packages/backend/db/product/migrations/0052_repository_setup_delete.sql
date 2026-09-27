-- Setup receipts belong to their repository. They must not keep an otherwise
-- deletable repository alive after inspection or configuration.
ALTER TABLE repository_setup_requests
  DROP CONSTRAINT repository_setup_requests_repository_id_fkey,
  ADD CONSTRAINT repository_setup_requests_repository_id_fkey
    FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE;
