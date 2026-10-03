package routes

import (
	"context"
	"net/http"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/stretchr/testify/require"
)

func TestTodoActivityGETPreservesSystemRequesterPostgres(t *testing.T) {
	f := newTodoRoutesFixture(t)
	ctx := context.Background()
	status, requested := f.do(http.MethodPost, "/api/todos", f.userID, "history-requester", `{"title":"History"}`)
	require.Equal(t, http.StatusAccepted, status, requested)
	status, card := f.do(http.MethodGet, "/api/todos/T1", f.userID, "", "")
	require.Equal(t, http.StatusOK, status, card)
	branch := card["branch"].(map[string]any)["id"].(string)
	var memberID int64
	require.NoError(t, f.pool.QueryRow(ctx, `SELECT id FROM members WHERE user_id=$1`, f.userID).Scan(&memberID))
	requester := services.TodoPerson(memberID, "agent")
	require.NoError(t, pgx.BeginFunc(ctx, f.pool, func(tx pgx.Tx) error {
		_, appended, err := services.AppendActivity(ctx, tx, branch, services.TodoActor{System: "stack"}, &requester, services.ActivityRebase, map[string]string{"onto": "T8"}, "history-get")
		require.True(t, appended)
		return err
	}))
	status, response := f.do(http.MethodGet, "/api/branches/"+branch+"/activity", f.userID, "", "")
	require.Equal(t, http.StatusOK, status, response)
	entries := response["entries"].([]any)
	require.Len(t, entries, 1)
	entry := entries[0].(map[string]any)
	require.Equal(t, map[string]any{"kind": "system", "name": "stack"}, entry["actor"])
	require.Equal(t, map[string]any{"kind": "person", "id": float64(memberID), "via": "agent"}, entry["asked_by"])
}
