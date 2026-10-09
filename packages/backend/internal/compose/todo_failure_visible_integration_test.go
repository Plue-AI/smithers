package compose

import (
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// The declaration-free repository goes through setup, GitHub sync, the real
// TODO composition and the coding host. The check must refuse, never pass.
func TestTodoNoChecksFailureVisibleComposedInstall(t *testing.T) {
	t.Setenv("REHEARSAL_CONFIG_FIXTURE", "no-checks")
	r := newRehearsal(t, "SMITHERS_FAILURE_VISIBLE_REHEARSAL", "fr33-no-checks", "failure-visible-")
	require.True(t, r.install("Install"))
	n, err := r.file("No checks", "Add a greeting to JOURNEY.md")
	require.NoError(t, err)
	_, err = r.waitTodoWithin(n, 8*time.Minute, "failed")
	require.NoError(t, err)
	raw, err := r.expect("GET", fmt.Sprintf("/api/todos/%d", n), "", 200)
	require.NoError(t, err)
	var card struct {
		State   string `json:"state"`
		Failure struct {
			Step          string `json:"step"`
			Label         string `json:"label"`
			Class         string `json:"class"`
			Message       string `json:"message"`
			Configuration bool   `json:"check_configuration"`
		} `json:"failure"`
	}
	require.NoError(t, json.Unmarshal(raw, &card))
	require.Equal(t, "failed", card.State)
	require.Equal(t, "user", card.Failure.Class)
	require.Equal(t, "No checks found", card.Failure.Message)
	require.Equal(t, "coding/check", card.Failure.Step)
	require.Equal(t, "Ran checks", card.Failure.Label)
	require.True(t, card.Failure.Configuration)
}

func TestTodoRetryReasonVisibleComposedInstall(t *testing.T) {
	h := newTodoLiteralInstall(t)
	const reason = "outage: infra: the previous lane could not be retired: command termination could not be confirmed: not_ready; this is not the TODO's fault, Smithers retries it"
	const at = "2026-10-10T12:00:00Z"
	_, err := h.pool.Exec(t.Context(), `UPDATE mythical_items SET state='retrying',reason=$2,next_attempt_at=$3::timestamptz,checks='{"todo":true,"run_launched":true,"run_attached":true,"fault":{"class":"infra","tag":"retirement","kind":"runtime"}}' WHERE id=$1`, h.item.ID, reason, at)
	require.NoError(t, err)
	status, card := h.call(t, "GET", "", "")
	require.Equal(t, 200, status, card)
	require.Equal(t, "retrying", card["state"])
	require.Equal(t, map[string]any{"reason": "The previous machine could not be retired", "at": at}, card["retry"])
	require.Nil(t, card["failure"], "automatic retry is not a failed TODO with a Retry button")
}
