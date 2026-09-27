-- The librarian Flow host family (the product gateway) is retired (#2194):
-- every browser flow call now runs on its box's coding host. Retire each
-- librarian binding so the existing reconciliation pass stops its host and
-- deletes the row. Running this again changes nothing.
UPDATE flow_runtime_host_bindings
   SET state = 'retired', updated_at = clock_timestamp()
 WHERE catalog_key = 'librarian' AND state <> 'retired';
