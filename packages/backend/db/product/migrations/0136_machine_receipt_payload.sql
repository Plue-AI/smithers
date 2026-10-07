-- Generic event receipts must bind the exact validated inner event bytes.
-- Capture metadata outlives activity pruning so stale-base recovery can still
-- find the immutable snapshot. Do not retain transcript bodies in this table.
-- Existing receipts stay readable; missing evidence never licenses a new ACK.
ALTER TABLE machine_event_receipts
    ADD COLUMN payload_digest BYTEA CHECK (octet_length(payload_digest) = 32),
    ADD COLUMN capture_payload BYTEA CHECK (octet_length(capture_payload) BETWEEN 1 AND 256),
    ADD CONSTRAINT machine_capture_receipt_digest CHECK (capture_payload IS NULL OR payload_digest IS NOT NULL);

-- Recover legacy capture evidence only from its matching committed host fact.
-- Ambiguous, pruned or unrelated facts cannot authenticate an old receipt.
-- ADR 0004's captured union has three 20-byte fields (head, tree, base).
WITH candidates AS (
    SELECT r.workspace_id, r.event_id,
           '020000003f01' || (e.data->>'head') ||
           '02' || (e.data->>'tree') ||
           '03' || (e.data->>'base') AS payload_hex
    FROM machine_event_receipts r
    JOIN workspaces w ON w.id = r.workspace_id
    JOIN product_job_events e ON e.event_type = 'branch.captured'
      AND e.tenant_id = w.repository_id::text
      AND e.principal_id = 'branch:' || w.id::text
      AND e.data->>'branch' = w.id::text
      AND e.data->>'machine_event_id' = r.event_id::text
    WHERE ((r.outcome = 'applied' AND e.data->>'applied' = 'true')
        OR (r.outcome = 'stale_base' AND e.data->>'applied' = 'false'))
      AND e.data->>'head' ~ '^[0-9a-f]{40}$'
      AND e.data->>'tree' ~ '^[0-9a-f]{40}$'
      AND e.data->>'base' ~ '^[0-9a-f]{40}$'
), bound AS (
    SELECT workspace_id, event_id, min(payload_hex) AS payload_hex
    FROM candidates GROUP BY workspace_id, event_id
    HAVING count(DISTINCT payload_hex) = 1
)
UPDATE machine_event_receipts r
SET capture_payload = decode(bound.payload_hex, 'hex'),
    payload_digest = sha256(decode(bound.payload_hex, 'hex'))
FROM bound WHERE r.workspace_id = bound.workspace_id AND r.event_id = bound.event_id;
