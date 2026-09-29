-- Factory execution has an explicit principal for organization repositories.
ALTER TABLE organizations ADD COLUMN factory_owner_id BIGINT REFERENCES users(id) ON DELETE SET NULL;

-- Ref synchronization and factory reconciliation have independent receipts.
ALTER TABLE github_main_pulls
    ADD COLUMN factory_state TEXT NOT NULL DEFAULT '' CHECK (factory_state IN ('', 'reconciled', 'skipped', 'failed', 'empty')),
    ADD COLUMN factory_error TEXT NOT NULL DEFAULT '';
