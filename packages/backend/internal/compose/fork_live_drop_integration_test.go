package compose

import (
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/stretchr/testify/require"
)

// Production HTTP, PostgreSQL, bundled flow host, native capture and stack
// worker compose Fork/Add with live Drop. The process rehearsal does not
// qualify member terminals, SSH continuity or microVM isolation.
func TestForkAddLiveDropComposedInstall(t *testing.T) {
	testForkAddLiveDrop(t, "SMITHERS_TODO_DROP_REHEARSAL")
}

func TestForkAddLiveDropInstalledMicroVM(t *testing.T) {
	if os.Getenv("SMITHERS_TODO_DROP_MICROVM") != "1" {
		t.Skip("set SMITHERS_TODO_DROP_MICROVM=1 and SMITHERS_CHECK_BUNDLE")
	}
	t.Setenv(pinnedMicroVMRehearsal, "1")
	testForkAddLiveDrop(t, pinnedMicroVMRehearsal)
}

func testForkAddLiveDrop(t *testing.T, enable string) {
	r := newRehearsal(t, enable, "C-J7-02", "fork-live-drop-")
	if !r.install("Install through Machine ready") {
		return
	}
	_, err := r.expect("PUT", "/api/install", `{"parallel":2}`, 200)
	require.NoError(t, err)
	first, err := r.file("Prefix", "[PR] [FILE prefix.md] Add the prefix note.")
	require.NoError(t, err)
	_, err = r.waitTodoWithin(first, 6*time.Minute, "in_review")
	require.NoError(t, err)
	second, err := r.file("Source", "[PR] [FILE source.md] Add the source note.")
	require.NoError(t, err)
	reviewed, err := r.waitTodoWithin(second, 6*time.Minute, "in_review")
	require.NoError(t, err)
	// In review is visible while its engine launch still settles. Steer the
	// retained executor only after the review publication receipt exists.
	require.Eventually(t, func() bool {
		var posted bool
		return r.pool.QueryRow(r.ctx, `SELECT COALESCE((checks->'review'->>'posted')::boolean,false) FROM mythical_items WHERE number=$1`, second).Scan(&posted) == nil && posted
	}, 4*time.Minute, 250*time.Millisecond)
	_, err = r.expect("POST", fmt.Sprintf("/api/todos/%d", second), `{"steer":"[HOLD fold-source] [FILE source.md] Improve the source note."}`, 202)
	require.NoError(t, err)
	t.Cleanup(func() { _ = r.release("fold-source"); _ = r.release("fold-child"); _ = r.release("fold-third") })
	require.NoError(t, r.waitHeld("fold-source", 6*time.Minute))
	original, err := r.todo(second)
	require.NoError(t, err)
	require.Equal(t, reviewed.Run.ID, original.Run.ID)
	require.Equal(t, reviewed.Run.Attempt, original.Run.Attempt)
	_, err = r.expect("PUT", "/api/install", `{"parallel":1}`, 200)
	require.NoError(t, err)
	third, err := r.file("Later", "[HOLD fold-third] [FILE later.md] Add the later note.")
	require.NoError(t, err)
	// T1 retains its review executor. Restore two slots after filing T3;
	// T1 and the held source occupy them until Drop frees T2's slot.
	_, err = r.expect("PUT", "/api/install", `{"parallel":2}`, 200)
	require.NoError(t, err)

	var prefix string
	require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT candidate_head FROM mythical_items WHERE number=$1`, first).Scan(&prefix))
	body, err := r.expect("POST", "/api/branches", fmt.Sprintf(`{"from":"T%d","name":"keep-source"}`, second), 201)
	require.NoError(t, err)
	var scratch services.BranchMachineResponse
	require.NoError(t, json.Unmarshal(body, &scratch))
	require.Equal(t, "scratch", scratch.Kind)
	require.NotNil(t, scratch.ForkedFrom)
	require.Equal(t, prefix, scratch.ForkedFrom.Base)
	current, err := r.todo(second)
	require.NoError(t, err)
	require.Equal(t, "working", current.State)
	require.Equal(t, original.Run, current.Run)
	githubLifecycleBrowserPhase(t, r, second, "forked", map[string]any{"scratchName": scratch.Name})
	path := "/api/branches/" + url.PathEscape(scratch.Name)
	source, err := r.expect("GET", path+"/files/source.md", "", 200)
	require.NoError(t, err)
	// A fixed uncommitted member edit exercises awake Add capture without
	// substituting a host filesystem write for the production file seam.
	_, err = r.expect("PUT", "/api/repos/rehearsal-owner/app/workspaces/"+scratch.Machine.ID+"/files/content?path=fork-edit.md", `{"base_digest":"absent","content":"fixed fork edit\n"}`, 200)
	require.NoError(t, err)
	// All writes, including adoption and cancellation, enter served commands.
	_, err = r.expect("POST", path+"/add-to-stack", `{"text":"[HOLD fold-child] Keep the source fork"}`, 202)
	require.NoError(t, err)
	var child int64
	require.Eventually(t, func() bool {
		return r.pool.QueryRow(r.ctx, `SELECT number FROM mythical_items WHERE workspace_id=$1`, scratch.Machine.ID).Scan(&child) == nil
	}, time.Minute, 250*time.Millisecond)
	var position int64
	require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT stack_position FROM mythical_items WHERE number=$1`, child).Scan(&position))
	require.EqualValues(t, 3, position)
	var seedBefore json.RawMessage
	require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT checks->'seed' FROM mythical_items WHERE number=$1`, child).Scan(&seedBefore))
	var seed struct{ Base, Diff string }
	require.NoError(t, json.Unmarshal(seedBefore, &seed))
	require.Equal(t, prefix, seed.Base)
	require.Contains(t, seed.Diff, "source.md")
	require.Contains(t, seed.Diff, "+fixed fork edit")
	githubLifecycleBrowserPhase(t, r, second, "adopted", map[string]any{"childNumber": child})
	// The mounted-card check presses the person's Drop confirmation. Other
	// invocations exercise duplicate admission through the same HTTP boundary.
	if os.Getenv("SMITHERS_GH03_BROWSER_HARNESS") == "" {
		for range 2 {
			code, body, err := r.keyed("POST", fmt.Sprintf("/api/todos/%d", second), `{"op":"drop"}`, "fold-drop-once")
			require.NoError(t, err)
			require.Equal(t, 202, code, string(body))
		}
	}
	_, err = r.waitTodoWithin(second, 3*time.Minute, "dropped")
	require.NoError(t, err)
	require.Eventually(t, func() bool {
		pull, err := r.readFakePull(reviewed.PR.Number)
		return err == nil && pull.State == "closed"
	}, time.Minute, 250*time.Millisecond)
	var order []int64
	require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT array_agg(number ORDER BY stack_position) FROM mythical_items WHERE stack_position IS NOT NULL`).Scan(&order))
	require.Equal(t, []int64{first, child, third}, order)
	added, err := r.todo(child)
	require.NoError(t, err)
	require.Equal(t, scratch.Machine.ID, added.Branch.ID)
	retained, err := r.expect("GET", "/api/branches/"+url.PathEscape(added.Branch.Name)+"/files/source.md", "", 200)
	require.NoError(t, err)
	var beforeFile, afterFile map[string]any
	require.NoError(t, json.Unmarshal(source, &beforeFile))
	require.NoError(t, json.Unmarshal(retained, &afterFile))
	require.Equal(t, beforeFile["content"], afterFile["content"])
	require.Equal(t, beforeFile["digest"], afterFile["digest"])
	edit, err := r.expect("GET", "/api/branches/"+url.PathEscape(added.Branch.Name)+"/files/fork-edit.md", "", 200)
	require.NoError(t, err)
	var editFile struct{ Content struct{ Kind, Text string } }
	require.NoError(t, json.Unmarshal(edit, &editFile))
	require.Equal(t, "text", editFile.Content.Kind)
	require.Equal(t, "fixed fork edit\n", editFile.Content.Text)

	require.NoError(t, r.waitHeld("fold-child", 4*time.Minute))
	_, err = r.waitTodoWithin(child, time.Minute, "working")
	require.NoError(t, err)
	var finalSeed json.RawMessage
	require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT checks->'seed' FROM mythical_items WHERE number=$1`, child).Scan(&finalSeed))
	require.NoError(t, json.Unmarshal(finalSeed, &seed))
	require.Equal(t, prefix, seed.Base)
	require.Contains(t, seed.Diff, "source.md")
	require.Contains(t, seed.Diff, "+fixed fork edit")
	var captures, drops int
	require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT count(*) FROM product_job_events WHERE event_type='branch.final_capture' AND principal_id=$1`, "branch:"+original.Branch.ID).Scan(&captures))
	require.Positive(t, captures)
	require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT count(*) FROM product_job_events WHERE event_type='todo.dropped' AND (data->>'n')::bigint=$1`, second).Scan(&drops))
	require.Equal(t, 1, drops)
	var requestedAt, capturedAt, droppedAt time.Time
	require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT max(recorded_at) FROM product_job_events WHERE event_type='branch.final_capture' AND principal_id=$1`, "branch:"+original.Branch.ID).Scan(&capturedAt))
	require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT recorded_at FROM product_job_events WHERE event_type='todo.dropped' AND (data->>'n')::bigint=$1`, second).Scan(&droppedAt))
	require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT recorded_at FROM product_job_events WHERE event_type='todo.drop-requested' AND (data->>'n')::bigint=$1`, second).Scan(&requestedAt))
	require.True(t, requestedAt.Before(capturedAt), "capture must fulfill this Drop request")
	require.True(t, capturedAt.Before(droppedAt), "retain writer-excluded capture before removal")
	var status string
	require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT status FROM workspaces WHERE id=$1`, original.Branch.ID).Scan(&status))
	require.Equal(t, "suspended", status)
	githubLifecycleBrowserPhase(t, r, second, "dropped", map[string]any{"childNumber": child, "branchName": added.Branch.Name})
}
