-- The configuration fingerprint of the host a binding last verified running.
-- A host upgrade deferred while a run depends on the old host (plue#538)
-- reaches that host by this fingerprint, since the operator catalog it was
-- started from is gone after a deploy. Empty until the host is next verified.
ALTER TABLE flow_runtime_host_bindings ADD COLUMN service_identity TEXT NOT NULL DEFAULT '';
