package db

import (
	"context"
	"time"
)

// UpdateInstallObsidianReceipt cannot overwrite a folder changed during a pass.
func (q *Queries) UpdateInstallObsidianReceipt(ctx context.Context, path, identity, failure string, at time.Time) error {
	_, err := q.db.Exec(ctx, `UPDATE install_settings SET value=(value - 'error') || jsonb_build_object('error',$3::text) || CASE WHEN $3='' THEN jsonb_build_object('last_sync_at',$4::timestamptz) ELSE '{}'::jsonb END,updated_at=now() WHERE key='wiki_sync.obsidian' AND value->>'path'=$1 AND value->>'identity'=$2`, path, identity, failure, at)
	return err
}
