package services

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

// Supplemental transaction-adapter proof. Merge/poll admission and the
// background launcher still require their production journey receipts.
func TestLearningPostgresSignatureSuppression(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	ctx := t.Context()
	now := time.Date(2026, 10, 6, 12, 0, 0, 0, time.UTC)
	for _, row := range []struct {
		name, status string
		age          int
		suppressed   bool
	}{
		{"open", "pending", 0, true},
		{"dismissed30", "rejected", 30, true},
		{"dismissed90", "rejected", 90, true},
		{"dismissed91", "rejected", 91, false},
		{"future", "rejected", -1, true},
		{"accepted", "accepted", 30, false},
	} {
		t.Run(row.name, func(t *testing.T) {
			_, err := pool.Exec(ctx, `DELETE FROM memory_notes WHERE namespace_kind='flow' AND namespace_id='learning:1'`)
			require.NoError(t, err)
			_, err = pool.Exec(ctx, `INSERT INTO memory_notes(id,namespace_kind,namespace_id,text,tags_json,provenance_json,status,created_at_ms,status_at_ms,accepted_todo) VALUES('existing-signature','flow','learning:1','Run lint','[]','{"signature":"check:lint@review","repository":"maya/app","run":"previous"}',$1,1,$2,'8')`, row.status, now.Add(-time.Duration(row.age)*24*time.Hour).UnixMilli())
			require.NoError(t, err)
			err = pgx.BeginFunc(ctx, pool, func(tx pgx.Tx) error {
				adapter := learningReceiptTx{tx: tx, repository: 1, receipt: LearningReceipt{Todo: 7, Run: "learning-7", Lessons: []LearningLesson{}}}
				created, err := adapter.Proposal(ctx, LearningBinding{Repository: "maya/app", Todo: 7, Run: "learning-7", State: "merged"}, LearningProposal{Signature: "check:lint@review", Title: "Run lint", Prompt: "Run lint", Evidence: []string{"3 of the last 5"}, Todos: []int64{1, 3, 7}}, now)
				require.NoError(t, err)
				require.Equal(t, !row.suppressed, created)
				require.Equal(t, map[bool]int{true: 0, false: 1}[row.suppressed], len(adapter.receipt.Lessons))
				return err
			})
			require.NoError(t, err)
			var count int
			var status, run string
			var at *int64
			require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM memory_notes WHERE namespace_id='learning:1'`).Scan(&count))
			require.Equal(t, 1, count)
			require.NoError(t, pool.QueryRow(ctx, `SELECT status,provenance_json::jsonb->>'run',status_at_ms FROM memory_notes WHERE id='existing-signature'`).Scan(&status, &run, &at))
			if row.suppressed {
				require.Equal(t, row.status, status)
				require.Equal(t, "previous", run)
				require.NotNil(t, at)
			} else {
				require.Equal(t, "pending", status)
				require.Equal(t, "learning-7", run)
				require.Nil(t, at)
			}
		})
	}
	// Nil dismissal is missing provenance, never permission to repropose.
	_, err := pool.Exec(ctx, `UPDATE memory_notes SET status='rejected',status_at_ms=NULL`)
	require.NoError(t, err)
	require.NoError(t, pgx.BeginFunc(ctx, pool, func(tx pgx.Tx) error {
		adapter := learningReceiptTx{tx: tx, repository: 1}
		created, err := adapter.Proposal(context.Background(), LearningBinding{Repository: "maya/app", Todo: 7, Run: "learning-7", State: "merged"}, LearningProposal{Signature: "check:lint@review"}, now)
		require.NoError(t, err)
		require.False(t, created)
		return err
	}))
}
