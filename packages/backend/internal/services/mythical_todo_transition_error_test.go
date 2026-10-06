package services

import (
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/stretchr/testify/require"
)

func TestTodoTransitionRefusalLiteralEnvelopes(t *testing.T) {
	now := time.Unix(1, 0)
	cases := []struct {
		state, op, from                       string
		paused, launched, attached, executing bool
		wait                                  string
	}{
		{"running", "stop", "starting", false, true, false, false, ""},
		{"running", "resume", "working", false, true, true, true, ""},
		{"running", "stop", "paused", true, true, true, false, ""},
		{"proposed", "retry", "in_review", false, false, false, false, ""},
		{"blocked", "stop", "needs_you", false, false, false, false, "foreign_push"},
		{"running", "stop", "needs_you", false, true, true, true, "question"},
		{"running", "stop", "needs_you", false, true, true, true, "approval"},
		{"landed", "drop", "merged", true, true, true, true, "question"},
		{"cancelled", "retry-current-flow", "dropped", true, true, true, true, "question"},
	}
	for _, c := range cases {
		checks := mythicalChecks{RunLaunched: c.launched, RunAttached: c.attached}
		facts := todoControlFacts{Executing: c.executing, Paused: c.paused}
		if c.wait != "" {
			checks.Waits = []TodoWait{{ID: "literal-wait", Kind: c.wait, Since: now}}
			facts.Waits = []string{c.wait}
		}
		item := db.MythicalItem{State: c.state, PausedAt: pgtype.Timestamptz{Time: now, Valid: c.paused}, Checks: checks.encode()}
		err := todoControlGuard(item, TodoControlInput{Op: c.op}, facts)
		var refusal *TodoTransitionRefusedError
		require.ErrorAs(t, err, &refusal)
		require.Equal(t, c.from, refusal.From)
		require.Equal(t, c.op, refusal.Trigger)
		var control *TodoControlError
		require.ErrorAs(t, err, &control, "existing control consumers retain the status and class")
		require.Equal(t, http.StatusConflict, control.Status)
		require.Equal(t, "conflict", control.Class)
		raw, marshalErr := json.Marshal(refusal)
		require.NoError(t, marshalErr)
		var envelope map[string]any
		require.NoError(t, json.Unmarshal(raw, &envelope))
		require.Equal(t, map[string]any{"code": "todo_transition_refused", "class": "conflict", "message": control.Message, "from": c.from, "trigger": c.op}, envelope)
	}
	t.Logf("literal refusal envelopes: %d", len(cases))
}
