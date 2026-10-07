package chat

import (
	"context"
	"encoding/json"
	"github.com/stretchr/testify/require"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

type promptReceipt struct {
	Status string `json:"status"`
	TurnID string `json:"turnId"`
	RunID  string `json:"runId"`
	LegID  string `json:"legId"`
	Cursor Cursor `json:"cursor"`
	Branch string
}

func submitPrompt(t *testing.T, server *httptest.Server, branch, key, prompt string) promptReceipt {
	t.Helper()
	body, err := json.Marshal(map[string]string{"prompt": prompt, "idempotencyKey": key})
	require.NoError(t, err)
	response := postJSON(t, server.Client(), server.URL+"/api/conversations/"+branch+"/prompt", body)
	defer response.Body.Close()
	var receipt promptReceipt
	require.Equal(t, http.StatusAccepted, response.StatusCode)
	require.NoError(t, json.NewDecoder(response.Body).Decode(&receipt))
	receipt.Branch = branch
	return receipt
}

func awaitPrompt(t *testing.T, server *httptest.Server, receipt promptReceipt) SharedTurn {
	t.Helper()
	var result SharedTurn
	require.Eventually(t, func() bool {
		response, err := server.Client().Get(server.URL + "/api/conversations/" + receipt.Branch)
		require.NoError(t, err)
		defer response.Body.Close()
		require.Equal(t, 200, response.StatusCode)
		var conversation SharedConversation
		require.NoError(t, json.NewDecoder(response.Body).Decode(&conversation))
		for _, entry := range conversation.Entries {
			if entry.ID == receipt.TurnID {
				result = entry
				return entry.State == StateCompleted || entry.State == StateFailed || entry.State == StateCancelled
			}
		}
		return false
	}, dbWait, 10*time.Millisecond)
	return result
}

// Old stored journals remain cancellable by the queue writer; no public run-ID cancellation API exists.
func stopStoredTurn(store *Store, ctx context.Context, scope Scope, runID string) (CancelResult, error) {
	var id, branch string
	err := store.pool.QueryRow(ctx, `SELECT id,COALESCE(conversation_id,run_id) FROM chat_turns WHERE user_id=$1 AND run_id=$2`, scope.UserID, runID).Scan(&id, &branch)
	if err != nil {
		return CancelResult{}, err
	}
	// Fixtures predating branch admission deliberately seed historical rows.
	_, err = store.pool.Exec(ctx, `UPDATE chat_turns SET conversation_id=$2 WHERE id=$1 AND conversation_id IS NULL`, id, branch)
	if err != nil {
		return CancelResult{}, err
	}
	_, err = store.MutateQueuedTurn(ctx, scope, branch, id, http.MethodPost, "")
	return CancelResult{Count: 1, TurnIDs: []string{id}}, err
}

type CancelResult struct {
	TurnIDs []string `json:"-"`
	Count   int      `json:"cancelled"`
}
