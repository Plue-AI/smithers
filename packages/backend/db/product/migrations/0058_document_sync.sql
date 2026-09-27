-- Document adapters use the chat channel, delivery, claim and receipt store.
ALTER TABLE issue_sync_channels DROP CONSTRAINT issue_sync_channels_provider_check;
ALTER TABLE issue_sync_channels ADD CHECK(provider IN ('slack','telegram','obsidian','notion'));
ALTER TABLE issue_sync_channels ADD COLUMN document_state jsonb NOT NULL DEFAULT '{}';
ALTER TABLE issue_sync_deliveries ALTER COLUMN issue_id DROP NOT NULL;
ALTER TABLE issue_sync_deliveries ALTER COLUMN event_id DROP NOT NULL;
ALTER TABLE issue_sync_deliveries ADD COLUMN document_scope text;
ALTER TABLE issue_sync_deliveries ADD COLUMN document_payload jsonb;
ALTER TABLE issue_sync_deliveries ADD COLUMN document_owner_id bigint REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE issue_sync_deliveries ADD COLUMN document_repository_id bigint REFERENCES repositories(id) ON DELETE CASCADE;
ALTER TABLE issue_sync_deliveries ADD CONSTRAINT sync_delivery_entity CHECK (
 (issue_id IS NOT NULL AND event_id IS NOT NULL AND document_scope IS NULL AND document_payload IS NULL AND document_owner_id IS NULL AND document_repository_id IS NULL) OR
 (issue_id IS NULL AND event_id IS NULL AND document_scope IS NOT NULL AND document_payload IS NOT NULL AND document_owner_id IS NOT NULL AND document_repository_id IS NOT NULL)
);
CREATE INDEX sync_document_deliveries ON issue_sync_deliveries(document_scope,id) WHERE document_scope IS NOT NULL;
