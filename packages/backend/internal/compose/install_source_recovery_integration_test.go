package compose

import (
	"testing"

	"github.com/stretchr/testify/require"
)

// Walk the composed install over HTTP with the real durable importer. Then
// restore only the setup-side pre-checkpoint boundary, retaining the published
// import. This is a reconciliation fixture, not a process-kill receipt.
func TestInstallSourcePublishedImportRecoveryHTTPPostgres(t *testing.T) {
	r := newRehearsal(t, "SMITHERS_INSTALL_SOURCE_RECOVERY", "C-J1-02", "source-recovery-")
	require.True(t, r.setupSource())
	var operation, importID string
	require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT value->>'operation_id' FROM install_settings WHERE key='setup.step.source'`).Scan(&operation))
	require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT id::text FROM import_jobs WHERE status='ready'`).Scan(&importID))
	// Hold delivery until the person's Retry has reused the expired operation.
	tx, err := r.pool.Begin(r.ctx)
	require.NoError(t, err)
	defer tx.Rollback(r.ctx)
	_, err = tx.Exec(r.ctx, `UPDATE product_job_requests SET state='running',terminal_receipt=NULL WHERE id=$1`, operation)
	require.NoError(t, err)
	_, err = tx.Exec(r.ctx, `UPDATE product_job_dispatches SET status='ready',external_receipt=NULL,next_attempt_at=clock_timestamp()+interval '1 hour' WHERE operation_id=$1`, operation)
	require.NoError(t, err)
	_, err = tx.Exec(r.ctx, `UPDATE install_settings SET value=jsonb_set(jsonb_set(value,'{status}','"running"'),'{expires_at}',to_jsonb(clock_timestamp()-interval '1 second')) WHERE key='setup.step.source'`)
	require.NoError(t, err)
	_, err = tx.Exec(r.ctx, `DELETE FROM product_job_events WHERE operation_id=$1 AND event_type='operation.completed'`, operation)
	require.NoError(t, err)
	require.NoError(t, tx.Commit(r.ctx))
	_, err = r.expect("POST", "/api/install/setup/source", `{}`, 202)
	require.NoError(t, err)
	_, err = r.pool.Exec(r.ctx, `UPDATE product_job_dispatches SET next_attempt_at=clock_timestamp() WHERE operation_id=$1`, operation)
	require.NoError(t, err)
	require.NoError(t, r.waitStep("source"))
	var recovered, receipt string
	require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT value->>'operation_id' FROM install_settings WHERE key='setup.step.source'`).Scan(&recovered))
	require.Equal(t, operation, recovered)
	require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT external_receipt->>'import_id' FROM product_job_dispatches WHERE operation_id=$1`, operation).Scan(&receipt))
	require.Equal(t, importID, receipt)
	var imports, completions int
	require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT count(*) FROM import_jobs`).Scan(&imports))
	require.Equal(t, 1, imports, "recovery does not mirror again")
	require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT count(*) FROM product_job_events WHERE operation_id=$1 AND event_type='operation.completed'`, operation).Scan(&completions))
	require.Equal(t, 1, completions)
}
