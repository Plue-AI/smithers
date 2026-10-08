package compose

import (
	"fmt"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Production install HTTP, real dispatcher/host, native capture and stack
// worker. The process fixture qualifies orchestration, not microVM isolation.
func TestTodoLiveDropBundledHost(t *testing.T) {
	r := newRehearsal(t, "SMITHERS_TODO_DROP_REHEARSAL", "C-STK-03", "live-drop-")
	if !r.install("Install through Machine ready") {
		return
	}
	number, err := r.file("Drop live work", "[HOLD drop-live] [FILE retry.md] Add a retry helper.")
	require.NoError(t, err)
	defer r.release("drop-live")
	require.NoError(t, r.waitHeld("drop-live", 4*time.Minute))
	var branch, run string
	require.EventuallyWithT(t, func(c *assert.CollectT) {
		require.NoError(c, r.pool.QueryRow(r.ctx, `SELECT workspace_id,request_run_id FROM mythical_items WHERE number=$1`, number).Scan(&branch, &run))
		require.NotEmpty(c, run)
	}, 15*time.Second, 250*time.Millisecond)
	started := time.Now()
	for range 2 {
		code, body, err := r.keyed("POST", fmt.Sprintf("/api/todos/%d", number), `{"op":"drop"}`, "drop-live-once")
		require.NoError(t, err)
		require.Equal(t, 202, code, string(body))
	}
	require.Less(t, time.Since(started), 2*time.Second, "acknowledgment must not wait for the writer")
	require.EventuallyWithT(t, func(c *assert.CollectT) {
		card, err := r.todo(number)
		require.NoError(c, err)
		require.Equal(c, "dropped", card.State)
		var status string
		require.NoError(c, r.pool.QueryRow(r.ctx, `SELECT status FROM workspaces WHERE id=$1`, branch).Scan(&status))
		require.Equal(c, "suspended", status)
	}, time.Minute, 250*time.Millisecond)
	var captures, drops, requests int
	require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT count(*) FROM product_job_events WHERE event_type='branch.final_capture' AND principal_id=$1`, "branch:"+branch).Scan(&captures))
	require.Positive(t, captures)
	require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT count(*) FROM product_job_events WHERE event_type='todo.dropped' AND (data->>'n')::bigint=$1`, number).Scan(&drops))
	require.Equal(t, 1, drops)
	require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT count(*) FROM product_job_events WHERE event_type='todo.drop-requested' AND (data->>'n')::bigint=$1`, number).Scan(&requests))
	require.Equal(t, 1, requests)
	var keptDigest, keptRun string
	var pending, placed bool
	require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT flow_digest,request_run_id,checks ? 'drop_requested',stack_position IS NOT NULL FROM mythical_items WHERE number=$1`, number).Scan(&keptDigest, &keptRun, &pending, &placed))
	require.Len(t, keptDigest, 64)
	require.Equal(t, run, keptRun)
	require.False(t, pending)
	require.False(t, placed)
	code, body, err := r.keyed("POST", fmt.Sprintf("/api/todos/%d", number), `{"op":"drop"}`, "drop-live-once")
	require.NoError(t, err)
	require.Equal(t, 202, code, string(body))
}
