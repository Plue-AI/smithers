package product

import (
	"github.com/stretchr/testify/require"
	"testing"
)

func TestMonitorSummaryStorageKeepsAttemptAndTargetIsolation(t *testing.T) {
	pool := newProductTestPool(t)
	ctx := t.Context()
	require.NoError(t, Apply(ctx, pool))
	for _, row := range []struct {
		attempt      int
		target, text string
	}{{1, "phase:0", "Read retry.ts"}, {1, "cell:0", "rm -rf /; import repo/flow.ts"}, {2, "phase:0", "Retried checks"}} {
		_, err := pool.Exec(ctx, `INSERT INTO run_summaries(run_id,attempt,target,text,rev) VALUES('monitor-run',$1,$2,$3,9)`, row.attempt, row.target, row.text)
		require.NoError(t, err)
	}
	var text string
	require.NoError(t, pool.QueryRow(ctx, `SELECT text FROM run_summaries WHERE run_id='monitor-run' AND attempt=1 AND target='cell:0'`).Scan(&text))
	require.Equal(t, "rm -rf /; import repo/flow.ts", text)
	_, err := pool.Exec(ctx, `INSERT INTO run_summaries(run_id,attempt,target,text,rev) VALUES('monitor-run',1,'phase:0','duplicate',10)`)
	require.Error(t, err)
	for _, args := range []struct {
		attempt int
		target  string
		rev     int
	}{{0, "phase:1", 1}, {1, "tool:1", 1}, {1, "cell:1", -1}} {
		_, err = pool.Exec(ctx, `INSERT INTO run_summaries(run_id,attempt,target,text,rev) VALUES('monitor-run',$1,$2,'invalid',$3)`, args.attempt, args.target, args.rev)
		require.Error(t, err)
	}
}
