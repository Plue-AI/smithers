//go:build unix

package compose

import (
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// C-STK-08 sequence 5 through the installed HTTP door and the packaged built-in
// engine's retained journal. The scripted model supplies the two-step barrier
// and an independent route counter. This is Linux process evidence, not the
// reference microVM machine-grant latency receipt.
func TestTodoFoldedResumeAfterFinishedStepComposedInstall(t *testing.T) {
	t.Setenv("TODO_HOLD_STEP", "coding/draft-plan")
	r := newRehearsal(t, "SMITHERS_TODO_FOLDED_RESUME", "C-STK-08", "folded-resume-", 25)
	require.True(t, r.install("Install through Machine ready"))
	number, err := r.file("Resume after route", "Add a greeting to JOURNEY.md. [HOLD folded-resume]")
	require.NoError(t, err)
	t.Cleanup(func() { _ = r.release("folded-resume") })
	require.NoError(t, r.waitHeld("folded-resume", 3*time.Minute))
	before, err := r.todo(number)
	require.NoError(t, err)
	require.Equal(t, "working", before.State)
	require.NotNil(t, before.Run)
	require.Equal(t, 1, livePauseModelSteps(t, r)["route"])
	require.Equal(t, 1, livePauseModelSteps(t, r)["coding/draft-plan"])
	path := fmt.Sprintf("/api/todos/%d", number)
	code, receipt, err := r.keyed("POST", path, `{"op":"stop"}`, "folded-stop-once")
	require.NoError(t, err)
	require.Equal(t, 202, code, string(receipt))
	require.NoError(t, r.release("folded-resume"))
	parked, err := r.waitTodoWithin(number, time.Minute, "paused")
	require.NoError(t, err)
	require.Equal(t, before.Run, parked.Run)
	var cursor int64
	require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT coalesce(max(sequence),0) FROM product_job_events WHERE event_type LIKE 'todo.%' AND data->>'n'=$1`, fmt.Sprint(number)).Scan(&cursor))
	code, receipt, err = r.keyed("POST", path, `{"op":"resume"}`, "folded-resume-once")
	require.NoError(t, err)
	require.Equal(t, 202, code, string(receipt))
	resumed, err := r.waitTodoWithin(number, time.Minute, "working", "in_review")
	require.NoError(t, err)
	require.Equal(t, before.Run, resumed.Run, "Resume keeps the same attempt and journal")
	require.Equal(t, before.FlowVersion, resumed.FlowVersion)
	require.Equal(t, 1, livePauseModelSteps(t, r)["route"], "completed s1 must not run again")
	require.Equal(t, 1, livePauseModelSteps(t, r)["coding/draft-plan"])
	rows, err := r.pool.Query(r.ctx, `SELECT data FROM product_job_events WHERE sequence>$1 AND event_type LIKE 'todo.%' AND data->>'n'=$2 ORDER BY sequence`, cursor, fmt.Sprint(number))
	require.NoError(t, err)
	defer rows.Close()
	var transitions [][2]string
	for rows.Next() {
		var raw []byte
		require.NoError(t, rows.Scan(&raw))
		var fact struct {
			From string `json:"from"`
			To   string `json:"to"`
		}
		require.NoError(t, json.Unmarshal(raw, &fact))
		if fact.From != fact.To {
			transitions = append(transitions, [2]string{fact.From, fact.To})
		}
	}
	require.NoError(t, rows.Err())
	require.GreaterOrEqual(t, len(transitions), 3, transitions)
	require.Equal(t, [][2]string{{"paused", "queued"}, {"queued", "starting"}, {"starting", "working"}}, transitions[:3])
}
