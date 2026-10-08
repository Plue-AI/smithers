//go:build unix

package compose

import (
	"encoding/json"
	"fmt"
	"net/url"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/stretchr/testify/require"
)

// C-STK-08 sequence 3 is continuous: HTTP Stop, real engine park, GitHub main
// sync, native conflict, member file/Done, and same-journal HTTP Resume. No
// parked input or conflict receipt is seeded. Linux process evidence only.
func TestTodoFoldedPausedConflictResumeComposedInstall(t *testing.T) {
	t.Setenv("TODO_HOLD_STEP", "coding/draft-plan")
	r := newRehearsal(t, "SMITHERS_TODO_FOLDED_CONFLICT", "C-STK-08", "folded-conflict-", 25)
	require.True(t, r.install("Install through Machine ready"))
	require.NoError(t, db.New(r.pool).UpsertInstallSetting(r.ctx, db.UpsertInstallSettingParams{Key: services.InstallCodingProjectKey, Value: []byte(`{"conflictAttempts":0}`)}))
	n, err := r.file("Pause through main conflict", "[NORESOLVE] Add a greeting to JOURNEY.md")
	require.NoError(t, err)
	reviewed, err := r.waitTodoWithin(n, j10RunWait, "in_review")
	require.NoError(t, err)
	require.NotNil(t, reviewed.Run)
	require.NotNil(t, reviewed.Branch)
	path := fmt.Sprintf("/api/todos/%d", n)
	code, raw, err := r.keyed("POST", path, `{"steer":"[HOLD folded-conflict] Preserve the greeting and continue."}`, "folded-conflict-steer")
	require.NoError(t, err)
	require.Equal(t, 202, code, string(raw))
	t.Cleanup(func() { _ = r.release("folded-conflict") })
	require.NoError(t, r.waitHeld("folded-conflict", 3*time.Minute))
	working, err := r.todo(n)
	require.NoError(t, err)
	require.Equal(t, "working", working.State)
	require.Equal(t, reviewed.Run.ID, working.Run.ID)
	steps := livePauseModelSteps(t, r)
	code, raw, err = r.keyed("POST", path, `{"op":"stop"}`, "folded-conflict-stop")
	require.NoError(t, err)
	require.Equal(t, 202, code, string(raw))
	require.NoError(t, r.release("folded-conflict"))
	parked, err := r.waitTodoWithin(n, time.Minute, "paused")
	require.NoError(t, err)
	require.Equal(t, working.Run.ID, parked.Run.ID)
	main, err := r.pushMain("JOURNEY.md", "Greeting from new main\n", "Conflict while the TODO is parked")
	require.NoError(t, err)
	conflict, err := r.waitTodoWithin(n, 3*time.Minute, "needs_you")
	require.NoError(t, err)
	raw, err = r.expect("GET", path, "", 200)
	require.NoError(t, err)
	var detailed struct {
		Waits []struct {
			Kind   string `json:"kind"`
			Change string `json:"conflict_change"`
			Onto   string `json:"onto_revision"`
		} `json:"waits"`
	}
	require.NoError(t, json.Unmarshal(raw, &detailed))
	require.Len(t, detailed.Waits, 1)
	require.Equal(t, "conflict", detailed.Waits[0].Kind)
	var binding string
	for _, wait := range detailed.Waits {
		if wait.Kind == "conflict" {
			require.Equal(t, main, wait.Onto)
			binding = wait.Change
		}
	}
	require.NotEmpty(t, binding)
	var stillParked bool
	require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT paused_at IS NOT NULL FROM mythical_items WHERE number=$1`, n).Scan(&stillParked))
	require.True(t, stillParked)
	filePath := "/api/repos/rehearsal-owner/app/workspaces/" + conflict.Branch.ID + "/files/content?path=JOURNEY.md"
	raw, err = r.expect("GET", filePath, "", 200)
	require.NoError(t, err)
	var file struct{ Digest string }
	require.NoError(t, json.Unmarshal(raw, &file))
	body, err := json.Marshal(map[string]string{"base_digest": file.Digest, "content": "Greeting from new main\nHello from Smithers!\n"})
	require.NoError(t, err)
	_, err = r.expect("PUT", filePath, string(body), 200)
	require.NoError(t, err)
	body, err = json.Marshal(map[string]string{"conflict_change": binding, "onto_revision": main})
	require.NoError(t, err)
	branchPath := "/api/branches/" + url.PathEscape(conflict.Branch.ID)
	code, raw, err = r.keyed("POST", branchPath, string(body), "folded-conflict-done")
	require.NoError(t, err)
	require.Equal(t, 202, code, string(raw))
	resolved, err := r.waitTodoWithin(n, time.Minute, "paused")
	require.NoError(t, err)
	require.Equal(t, working.Run.ID, resolved.Run.ID)
	require.Empty(t, resolved.Waits)
	var cursor int64
	require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT coalesce(max(sequence),0) FROM product_job_events WHERE event_type LIKE 'todo.%' AND data->>'n'=$1`, fmt.Sprint(n)).Scan(&cursor))
	code, raw, err = r.keyed("POST", path, `{"op":"resume"}`, "folded-conflict-resume")
	require.NoError(t, err)
	require.Equal(t, 202, code, string(raw))
	resumed, err := r.waitTodoWithin(n, time.Minute, "working", "in_review")
	require.NoError(t, err)
	require.Equal(t, working.Run.ID, resumed.Run.ID)
	require.Equal(t, working.FlowVersion, resumed.FlowVersion)
	require.Equal(t, steps["route"], livePauseModelSteps(t, r)["route"], "completed routing steps do not replay")
	rows, err := r.pool.Query(r.ctx, `SELECT data->>'from',data->>'to' FROM product_job_events WHERE sequence>$1 AND event_type LIKE 'todo.%' AND data->>'n'=$2 ORDER BY sequence`, cursor, fmt.Sprint(n))
	require.NoError(t, err)
	defer rows.Close()
	var transitions [][2]string
	for rows.Next() {
		var from, to string
		require.NoError(t, rows.Scan(&from, &to))
		if from != to {
			transitions = append(transitions, [2]string{from, to})
		}
	}
	require.NoError(t, rows.Err())
	require.GreaterOrEqual(t, len(transitions), 3)
	require.Equal(t, [][2]string{{"paused", "queued"}, {"queued", "starting"}, {"starting", "working"}}, transitions[:3])
}
