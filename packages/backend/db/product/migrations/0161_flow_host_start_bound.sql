-- Failed host starts must not pin a machine indefinitely.
ALTER TABLE flow_runtime_host_bindings ADD COLUMN start_failures integer NOT NULL DEFAULT 0 CHECK (start_failures >= 0);
ALTER TABLE flow_runtime_host_bindings ADD COLUMN ever_started boolean NOT NULL DEFAULT false;
ALTER TABLE flow_runtime_host_bindings ADD COLUMN source_refreshed boolean NOT NULL DEFAULT false;
UPDATE flow_runtime_host_bindings SET ever_started=true WHERE state='running' OR service_identity<>'';
