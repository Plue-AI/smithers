package compose

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// The real packaged planner produces its native receipt, the dispatcher reads
// it and the stack retains it after implementation fails before submission.
// Only GitHub/model peers are scripted. This unprivileged host fixture does
// not qualify the production microVM or its still-disabled atomic writer.
func TestTodoNativePlanRecoveryBundledHost(t *testing.T) {
	t.Setenv("SMITHERS_FEATURE_FLAGS_FLOW_LOAD", "true")
	r := newRehearsal(t, "SMITHERS_TODO_PLAN_REHEARSAL", "C-STK-06", "native-plan-")
	if !r.install("Install through Machine ready") {
		return
	}
	require.NoError(t, r.waitStackActive())
	// The scripted edit fails its required check even once the atomic writer
	// is qualified; no successful candidate is needed for this regression.
	number, err := r.file("Retain a failed implementation plan", "[FAIL] Add a greeting to JOURNEY.md")
	require.NoError(t, err)
	var plan, checks json.RawMessage
	var candidate, outcome, reason string
	var attempt int
	require.EventuallyWithT(t, func(c *assert.CollectT) {
		require.NoError(c, r.pool.QueryRow(r.ctx, `SELECT plan,checks,candidate_head,request_outcome,reason,attempt FROM mythical_items WHERE number=$1`, number).Scan(&plan, &checks, &candidate, &outcome, &reason, &attempt))
		require.NotEmpty(c, plan, "reason: %s; outcome: %s; model: %s", reason, outcome, r.coder.turns())
		require.Empty(c, candidate)
		require.True(c, strings.HasPrefix(outcome, "failed:") || strings.HasPrefix(outcome, "outage:") || attempt > 1,
			"the actual implementation must fail before candidate submission: %s", outcome)
	}, 4*time.Minute, 500*time.Millisecond)
	var summary struct {
		Title string   `json:"title"`
		Steps []string `json:"steps"`
	}
	require.NoError(t, json.Unmarshal(plan, &summary))
	require.Equal(t, "Add a greeting", summary.Title)
	require.Contains(t, summary.Steps, "📝 docs: add a greeting to JOURNEY.md")
	var retained struct {
		Route       string `json:"route"`
		PlanReceipt struct {
			Attempt int    `json:"attempt"`
			RunID   string `json:"runId"`
			Cursor  struct {
				Sequence int64 `json:"sequence"`
			} `json:"cursor"`
		} `json:"planReceipt"`
	}
	require.NoError(t, json.Unmarshal(checks, &retained))
	require.Equal(t, "implement", retained.Route, "the native route survives a later typed implementation failure")
	require.NotEmpty(t, retained.PlanReceipt.RunID)
	require.Positive(t, retained.PlanReceipt.Attempt)
	require.LessOrEqual(t, retained.PlanReceipt.Attempt, attempt)
	require.Positive(t, retained.PlanReceipt.Cursor.Sequence)
	t.Logf("TODO %d retained the native plan from %s at sequence %d before any candidate; attempt=%d outcome=%s", number, retained.PlanReceipt.RunID, retained.PlanReceipt.Cursor.Sequence, attempt, outcome)
}
