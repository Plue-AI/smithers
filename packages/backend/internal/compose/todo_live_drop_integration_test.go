package compose

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
	"github.com/smithersai/smithers/packages/backend/internal/services"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Production install HTTP, real dispatcher/host, native capture and stack
// worker. The process fixture qualifies orchestration, not microVM isolation.
func TestTodoLiveDropBundledHost(t *testing.T) {
	testTodoLiveDrop(t, "SMITHERS_TODO_DROP_REHEARSAL", false, false)
}

func TestTodoDropRetainedCaptureBundledHost(t *testing.T) {
	testTodoLiveDrop(t, "SMITHERS_TODO_DROP_REHEARSAL", true, false)
}

func TestTodoDropFailedRetainedCaptureBundledHost(t *testing.T) {
	testTodoLiveDrop(t, "SMITHERS_TODO_DROP_REHEARSAL", true, true)
}

// Uses the approved bundle and native guest providers; never a process fallback.
func TestTodoLiveDropInstalledMicroVM(t *testing.T) {
	if os.Getenv("SMITHERS_TODO_DROP_MICROVM") != "1" {
		t.Skip("set SMITHERS_TODO_DROP_MICROVM=1 and SMITHERS_CHECK_BUNDLE")
	}
	t.Setenv(pinnedMicroVMRehearsal, "1")
	testTodoLiveDrop(t, pinnedMicroVMRehearsal, false, false)
}

func testTodoLiveDrop(t *testing.T, enable string, retainedCapture, ended bool) {
	r := newRehearsal(t, enable, "C-STK-03", "live-drop-")
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
	// These bytes exist only in the working copy when Drop is requested.
	_, err = r.expect("PUT", "/api/repos/rehearsal-owner/app/workspaces/"+branch+"/files/content?path=notes.txt", `{"base_digest":"absent","content":"retain these uncommitted Drop notes\n"}`, 200)
	require.NoError(t, err)
	if retainedCapture {
		// Retain a real daemon snapshot as an unconsumed continuation, as J7
		// does when its coding attempt ends with source_refused. The fixture
		// only seeds that prior state; Drop uses the real HTTP and host path.
		var payload []byte
		require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT capture_payload FROM machine_event_receipts WHERE workspace_id=$1 AND outcome='applied' AND capture_payload IS NOT NULL ORDER BY at DESC LIMIT 1`, branch).Scan(&payload))
		capture, err := wire.DecodeCaptured(payload)
		require.NoError(t, err)
		pending, err := json.Marshal(services.MachineCapturePending{Head: capture.Head, Tree: capture.Tree, Base: capture.Base, Onto: capture.Head})
		require.NoError(t, err)
		_, err = r.pool.Exec(r.ctx, `UPDATE mythical_items SET checks=jsonb_set(checks,'{capture}',$2::jsonb) WHERE number=$1`, number, pending)
		require.NoError(t, err)
		if ended {
			_, err = r.pool.Exec(r.ctx, `UPDATE mythical_items SET state='blocked',request_outcome='stopped: source_refused' WHERE number=$1`, number)
			require.NoError(t, err)
		}
	}
	started := time.Now()
	for range 2 {
		code, body, err := r.keyed("POST", fmt.Sprintf("/api/todos/%d", number), `{"op":"drop"}`, "drop-live-once")
		require.NoError(t, err)
		require.Equal(t, 202, code, string(body))
	}
	require.Less(t, time.Since(started), time.Second, "acknowledgment must not wait for the writer")
	require.EventuallyWithT(t, func(c *assert.CollectT) {
		card, err := r.todo(number)
		require.NoError(c, err)
		require.Equal(c, "dropped", card.State)
		var status, boundWorkspace string
		require.NoError(c, r.pool.QueryRow(r.ctx, `SELECT status FROM workspaces WHERE id=$1`, branch).Scan(&status))
		require.Contains(c, []string{"suspended", "stopped"}, status)
		require.NoError(c, r.pool.QueryRow(r.ctx, `SELECT workspace_id FROM mythical_items WHERE number=$1`, number).Scan(&boundWorkspace))
		require.Empty(c, boundWorkspace, "Drop must release its lane as well as stop the machine")
	}, time.Until(started.Add(time.Minute)), 250*time.Millisecond)
	var captures, drops, requests int
	require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT count(*) FROM product_job_events WHERE event_type='branch.final_capture' AND principal_id=$1`, "branch:"+branch).Scan(&captures))
	require.Positive(t, captures)
	require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT count(*) FROM product_job_events WHERE event_type='todo.dropped' AND (data->>'n')::bigint=$1`, number).Scan(&drops))
	require.Equal(t, 1, drops)
	require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT count(*) FROM product_job_events WHERE event_type='todo.drop-requested' AND (data->>'n')::bigint=$1`, number).Scan(&requests))
	if ended {
		require.Equal(t, 0, requests, "an ended attempt retires through ordinary final capture")
	} else {
		require.Equal(t, 1, requests)
	}
	var head string
	require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT head_commit_id FROM workspaces WHERE id=$1`, branch).Scan(&head))
	require.Regexp(t, "^[0-9a-f]{40}$", head)
	file, err := r.repoClient.GetFileAtCommit(r.ctx, "rehearsal-owner", "app", head, "notes.txt")
	require.NoError(t, err)
	bytes := []byte(file.Content)
	if file.Encoding == "base64" {
		bytes, err = base64.StdEncoding.DecodeString(file.Content)
		require.NoError(t, err)
	}
	require.Equal(t, "retain these uncommitted Drop notes\n", string(bytes), "final retained object must contain the member's unfinished bytes")
	var capturedAt, droppedAt time.Time
	require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT max(recorded_at) FROM product_job_events WHERE event_type='branch.final_capture' AND principal_id=$1 AND data->>'head'=$2`, "branch:"+branch, head).Scan(&capturedAt))
	require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT recorded_at FROM product_job_events WHERE event_type='todo.dropped' AND (data->>'n')::bigint=$1`, number).Scan(&droppedAt))
	require.True(t, capturedAt.After(started))
	if !ended {
		require.True(t, droppedAt.After(capturedAt), "live removal follows retained capture")
	}
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
