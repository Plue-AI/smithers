package compose

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Both entry points run the same production loader, engine, dispatcher and HTTP
// controls. Only the reference entry proves machine isolation and retention.
func TestTodoFourStepComposedInstall(t *testing.T) {
	testTodoFourStep(t, "SMITHERS_TODO_FOUR_STEP")
}

func TestTodoFourStepMicroVM(t *testing.T) {
	if os.Getenv("SMITHERS_TODO_FOUR_STEP_MICROVM") != "1" {
		t.Skip("requires the reference microVM and approved bundle")
	}
	t.Setenv(pinnedMicroVMRehearsal, "1")
	testTodoFourStep(t, pinnedMicroVMRehearsal)
}

func testTodoFourStep(t *testing.T, enable string) {
	t.Setenv("SMITHERS_FEATURE_FLAGS_FLOW_LOAD", "true")
	r := newRehearsal(t, enable, "C-STK-03", "four-step-", 25)
	require.True(t, r.install("Install through Machine ready"))
	source, err := os.ReadFile("testdata/todo-four-step/flow.ts")
	require.NoError(t, err)
	commit, digest := activateWatchdogOverride(t, r, string(source))
	var config []byte
	require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT config FROM workflow_definitions WHERE digest=$1 AND name='todo'`, digest).Scan(&config))
	require.NoError(t, os.WriteFile(filepath.Join(r.evidence, "inspection.json"), config, 0600))
	n, err := r.file("Four-step controls", "Exercise four durable steps")
	require.NoError(t, err)
	path := fmt.Sprintf("/api/todos/%d", n)

	workspace := fourStepHeld(t, r, n)
	before, err := r.todo(n)
	require.NoError(t, err)
	require.Equal(t, "working", before.State)
	require.NotNil(t, before.Run)
	require.Equal(t, digest, before.FlowVersion.Digest)
	require.Equal(t, commit, before.FlowVersion.SourceCommit)
	fourStepCounters(t, r, workspace, "D1", []string{"s1", "s2", "s3"}, "")
	control := func(number int64, op, steer, key string) {
		t.Helper()
		payload := map[string]string{"op": op}
		if steer != "" {
			payload["steer"] = steer
		}
		raw, err := json.Marshal(payload)
		require.NoError(t, err)
		for range 2 {
			code, receipt, err := r.keyed("POST", fmt.Sprintf("/api/todos/%d", number), string(raw), key)
			require.NoError(t, err)
			require.Equal(t, 202, code, string(receipt))
		}
	}
	control(n, "stop", "", "four-step-stop")
	raw, err := r.expect("GET", path, "", 200)
	require.NoError(t, err)
	var requested map[string]any
	require.NoError(t, json.Unmarshal(raw, &requested))
	require.Equal(t, "working", requested["state"])
	require.Equal(t, "requested", requested["stop"], "Stop admission cannot manufacture a pause")
	observation, err := json.Marshal(map[string]any{"at": time.Now().UTC(), "card": requested})
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(filepath.Join(r.evidence, "stop-requested.json"), observation, 0600))
	// Wait for durable signal delivery before releasing the in-flight action.
	require.Eventually(t, func() bool {
		var delivered int
		err := r.pool.QueryRow(r.ctx, `SELECT count(*) FROM product_job_requests WHERE operation='flow.runtime.signal' AND payload->>'runId'=$1 AND state='completed'`, before.Run.ID).Scan(&delivered)
		return err == nil && delivered == 1
	}, time.Minute, 25*time.Millisecond)
	fourStepRelease(t, r, workspace)
	parked, err := r.waitTodoWithin(n, time.Minute, "paused")
	require.NoError(t, err)
	require.Equal(t, before.Run, parked.Run)
	fourStepCounters(t, r, workspace, "D1", []string{"s1", "s2", "s3"}, "")
	var pause []byte
	require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT checks->'pause' FROM mythical_items WHERE number=$1 AND paused_at IS NOT NULL`, n).Scan(&pause))
	require.Contains(t, string(pause), `resume#1`)
	require.NoError(t, os.WriteFile(filepath.Join(r.evidence, "paused.json"), pause, 0600))
	if enable == pinnedMicroVMRehearsal {
		require.Eventually(t, func() bool {
			var status string
			err := r.pool.QueryRow(r.ctx, `SELECT status FROM workspaces WHERE id=$1 AND deleted_at IS NULL`, workspace).Scan(&status)
			return err == nil && (status == "suspended" || status == "stopped")
		}, 2*time.Minute, 100*time.Millisecond, "Stop must release the safe-idle machine while retaining its disk")
	}
	var cursor int64
	require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT coalesce(max(sequence),0) FROM product_job_events WHERE event_type LIKE 'todo.%' AND data->>'n'=$1`, fmt.Sprint(n)).Scan(&cursor))
	control(n, "resume", "", "four-step-resume")
	// Observe attachment before allowing the literal next step to fail.
	resumed, err := r.waitTodoWithin(n, time.Minute, "working")
	require.NoError(t, err)
	require.Equal(t, before.Run, resumed.Run)
	fourStepFail(t, r, workspace)
	failed, err := r.waitTodoWithin(n, 2*time.Minute, "failed")
	require.NoError(t, err)
	require.Equal(t, before.Run, failed.Run)
	require.Equal(t, before.FlowVersion, failed.FlowVersion)
	fourStepCounters(t, r, workspace, "D1", []string{"s1", "s2", "s3", "s4"}, "")
	raw, err = r.expect("GET", path, "", 200)
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(filepath.Join(r.evidence, "failed.json"), raw, 0600))
	var failure struct {
		Failure struct {
			Step, Class, Message string
			Retryable            bool
		}
	}
	require.NoError(t, json.Unmarshal(raw, &failure))
	require.True(t, failure.Failure.Retryable)
	require.Equal(t, "s4", failure.Failure.Step)
	require.Equal(t, "user", failure.Failure.Class)
	require.NotEmpty(t, failure.Failure.Message)
	transitions, err := r.pool.Query(r.ctx, `SELECT recorded_at,data FROM product_job_events WHERE sequence>$1 AND event_type LIKE 'todo.%' AND data->>'n'=$2 ORDER BY sequence`, cursor, fmt.Sprint(n))
	require.NoError(t, err)
	var states [][2]string
	var observations []map[string]any
	for transitions.Next() {
		var at time.Time
		var event []byte
		require.NoError(t, transitions.Scan(&at, &event))
		var fact map[string]any
		require.NoError(t, json.Unmarshal(event, &fact))
		from, _ := fact["from"].(string)
		to, _ := fact["to"].(string)
		if from != "" && from != to {
			states = append(states, [2]string{from, to})
		}
		observations = append(observations, map[string]any{"at": at, "event": fact})
	}
	require.NoError(t, transitions.Err())
	transitions.Close()
	require.GreaterOrEqual(t, len(states), 3)
	require.Equal(t, [][2]string{{"paused", "queued"}, {"queued", "starting"}, {"starting", "working"}}, states[:3])
	history, err := json.MarshalIndent(observations, "", "  ")
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(filepath.Join(r.evidence, "transitions.json"), history, 0600))
	// Keep a separate failed D1 TODO for Retry-current, as required by C-STK-03.
	other, err := r.file("Four-step current flow", "Exercise the current flow retry")
	require.NoError(t, err)
	otherWorkspace := fourStepHeld(t, r, other)
	_, err = r.waitTodoWithin(other, time.Minute, "working")
	require.NoError(t, err)
	fourStepRelease(t, r, otherWorkspace)
	fourStepFail(t, r, otherWorkspace)
	otherFailed, err := r.waitTodoWithin(other, 2*time.Minute, "failed")
	require.NoError(t, err)
	require.Equal(t, digest, otherFailed.FlowVersion.Digest)
	prior := fourStepAttempts(t, r, n)
	otherPrior := fourStepAttempts(t, r, other)
	source2 := strings.ReplaceAll(string(source), `version: "D1"`, `version: "D2"`)
	commit2, digest2 := activateWatchdogOverride(t, r, source2)
	require.NotEqual(t, digest, digest2)
	const steer = "use the helper in lib/retry.ts"
	for _, c := range []struct {
		n                                   int64
		op, version, pin, source, workspace string
		before                              rehearsalTodo
		prior                               []json.RawMessage
	}{
		{n, "retry", "D1", digest, commit, workspace, failed, prior},
		{other, "retry-current-flow", "D2", digest2, commit2, otherWorkspace, otherFailed, otherPrior},
	} {
		control(c.n, c.op, steer, "four-step-"+c.op)
		nextWorkspace := fourStepHeld(t, r, c.n, 2)
		require.NotEqual(t, c.workspace, nextWorkspace)
		// Guest step output can arrive before run_attached is projected onto
		// the card. Verify the person's working card before reading its run.
		var next rehearsalTodo
		require.EventuallyWithT(t, func(caught *assert.CollectT) {
			var err error
			next, err = r.todo(c.n)
			require.NoError(caught, err)
			require.Equal(caught, "working", next.State)
			require.NotNil(caught, next.Run)
			require.Equal(caught, 2, next.Run.Attempt)
		}, time.Minute, 100*time.Millisecond)
		require.NotNil(t, c.before.Run)
		require.NotEqual(t, c.before.Run.ID, next.Run.ID)
		require.Equal(t, c.pin, next.FlowVersion.Digest)
		require.Equal(t, c.source, next.FlowVersion.SourceCommit)
		fourStepCounters(t, r, nextWorkspace, c.version, []string{"s1", "s2", "s3"}, steer)
		kept := fourStepAttempts(t, r, c.n)
		require.Len(t, c.prior, 1)
		require.Len(t, kept, 2)
		require.JSONEq(t, string(c.prior[0]), string(kept[0]), "Retry preserves every earlier attempt field")
		require.NotEmpty(t, next.Evidence)
		require.Equal(t, c.before.Evidence[0], next.Evidence[0])
		fourStepRelease(t, r, nextWorkspace)
		fourStepFail(t, r, nextWorkspace)
		_, err = r.waitTodoWithin(c.n, 2*time.Minute, "failed")
		require.NoError(t, err)
		require.Len(t, fourStepAttempts(t, r, c.n), 2)
	}
}

func fourStepHeld(t *testing.T, r *rehearsal, n int64, wantAttempt ...int) string {
	t.Helper()
	var workspace string
	attempt := 1
	if len(wantAttempt) > 0 {
		attempt = wantAttempt[0]
	}
	require.Eventually(t, func() bool {
		err := r.pool.QueryRow(r.ctx, `SELECT workspace_id FROM mythical_items WHERE number=$1 AND attempt=$2 AND request_outcome=''`, n, attempt).Scan(&workspace)
		if err != nil || workspace == "" {
			return false
		}
		raw, err := r.workspaceRuntime.ReadFile(r.ctx, workspace, "four-step.jsonl")
		if err != nil || !containsFourStep(raw, "s3") {
			return false
		}
		// A Retry starts from the captured working copy. Its old counters
		// are not evidence that the new attempt has reached its held step.
		rows := splitFourStep(raw)
		return attempt == 1 || len(rows) == 3 && rows[0]["feedback"] != ""
	}, 3*time.Minute, 100*time.Millisecond)
	return workspace
}
func fourStepRelease(t *testing.T, r *rehearsal, workspace string) {
	t.Helper()
	require.NoError(t, writeGuestFixture(r.workspaceRuntime, r.ctx, workspace, "four-step-release", []byte("release"), 0600))
}
func fourStepFail(t *testing.T, r *rehearsal, workspace string) {
	t.Helper()
	require.NoError(t, writeGuestFixture(r.workspaceRuntime, r.ctx, workspace, "four-step-fail", []byte("fail"), 0600))
}
func fourStepCounters(t *testing.T, r *rehearsal, workspace, version string, want []string, feedback string) {
	t.Helper()
	raw, err := r.workspaceRuntime.ReadFile(r.ctx, workspace, "four-step.jsonl")
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(filepath.Join(r.evidence, "counters-"+workspace+".jsonl"), raw, 0600))
	rows := splitFourStep(raw)
	require.True(t, bytes.HasSuffix(raw, []byte("\n")), "counter record must be complete")
	require.Equal(t, len(rows), bytes.Count(raw, []byte("\n")), "every counter record must decode")
	var steps []string
	for _, row := range rows {
		steps = append(steps, row["step"].(string))
		require.Equal(t, version, row["version"])
		if feedback != "" {
			require.Contains(t, row["feedback"], feedback)
		}
	}
	require.Equal(t, want, steps, "completed actions cannot replay; a fresh attempt starts at s1")
}
func fourStepAttempts(t *testing.T, r *rehearsal, n int64) []json.RawMessage {
	t.Helper()
	var raw []byte
	require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT checks->'attempts' FROM mythical_items WHERE number=$1`, n).Scan(&raw))
	var attempts []json.RawMessage
	require.NoError(t, json.Unmarshal(raw, &attempts))
	require.NoError(t, os.WriteFile(filepath.Join(r.evidence, fmt.Sprintf("attempts-%d-%d.json", n, len(attempts))), raw, 0600))
	return attempts
}

func containsFourStep(raw []byte, step string) bool {
	for _, line := range splitFourStep(raw) {
		if line["step"] == step {
			return true
		}
	}
	return false
}
func splitFourStep(raw []byte) []map[string]any {
	var result []map[string]any
	for _, line := range bytes.Split(raw, []byte("\n")) {
		var row map[string]any
		if json.Unmarshal(line, &row) == nil {
			result = append(result, row)
		}
	}
	return result
}
