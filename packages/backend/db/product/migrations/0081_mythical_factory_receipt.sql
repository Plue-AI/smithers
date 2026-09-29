-- Local main reconciliation reports factory outcomes independently of stack work.
ALTER TABLE mythical_stacks
    ADD COLUMN factory_state TEXT NOT NULL DEFAULT '' CHECK (factory_state IN ('', 'reconciled', 'skipped', 'failed', 'empty')),
    ADD COLUMN factory_error TEXT NOT NULL DEFAULT '';
