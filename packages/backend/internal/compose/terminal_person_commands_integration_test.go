package compose

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/stretchr/testify/require"
)

// Real terminal admission, cookie authentication, catalog and TODO services.
// PTY and delegated file placement remain doubles; no guest isolation claim.
func TestPersonTerminalCommandsComposedInstall(t *testing.T) {
	terminalReplacementInstall(t, false, false, false, false, false, false, true)
}

func exercisePersonTerminalBroker(t *testing.T, ctx context.Context, pool *pgxpool.Pool, q *db.Queries, conn *websocket.Conn, runtime *replacementRuntime, session, origin string, member db.User) {
	t.Helper()
	// Finish the production replay before inspecting command results.
	_, replay, err := conn.Read(ctx)
	require.NoError(t, err)
	require.JSONEq(t, `{"type":"replay-complete"}`, string(replay))
	call := func(frame string, expected int) map[string]any {
		t.Helper()
		require.NoError(t, conn.Write(ctx, websocket.MessageText, []byte(frame)))
		kind, raw, err := conn.Read(ctx)
		require.NoError(t, err)
		require.Equal(t, websocket.MessageText, kind)
		var receipt struct {
			Type   string         `json:"type"`
			ID     string         `json:"id"`
			Status int            `json:"status"`
			Body   map[string]any `json:"body"`
		}
		require.NoError(t, json.Unmarshal(raw, &receipt), string(raw))
		require.Equal(t, "command", receipt.Type)
		require.Equal(t, "person-append", receipt.ID)
		require.Equal(t, expected, receipt.Status, string(raw))
		require.NotContains(t, string(raw), "replacement-cookie")
		require.NotContains(t, string(raw), runtime.current(session))
		return receipt.Body
	}
	appendFrame := `{"type":"command","id":"person-append","command":"todo.new","method":"POST","path":"/api/todos","body":{"title":"Person terminal","prompt":"Keep the person on the host"},"idempotencyKey":"person-terminal-append"}`
	count := func(table string) int {
		var n int
		require.NoError(t, pool.QueryRow(ctx, "SELECT count(*) FROM "+table).Scan(&n))
		return n
	}
	for _, frame := range []string{
		`{"type":"command","id":"person-append","command":"todo.new","method":"POST","path":"https://other.example/api/todos","body":{},"idempotencyKey":"refused"}`,
		`{"type":"command","id":"person-append","command":"todo.new","method":"POST","path":"/api/members","body":{},"idempotencyKey":"refused"}`,
		`{"type":"command","id":"person-append","command":"todo.new","method":"DELETE","path":"/api/todos","body":{},"idempotencyKey":"refused"}`,
		`{"type":"command","id":"person-append","command":"todo.new","method":"POST","path":"/api/todos","body":{}}`,
	} {
		body := call(frame, 403)
		require.Equal(t, "permission", body["class"])
		require.Equal(t, "permission", body["code"])
		require.Zero(t, count("mythical_items"))
		require.Zero(t, count("approvals"))
	}
	first := call(appendFrame, 202)
	require.NotContains(t, first, "confirmation")
	require.Equal(t, 1, count("mythical_items"))
	require.Zero(t, count("approvals"))
	second := call(appendFrame, 202)
	require.Equal(t, first, second)
	require.Equal(t, 1, count("mythical_items"))
	var author int64
	var prompt string
	require.NoError(t, pool.QueryRow(ctx, `SELECT owner_id,issue_body FROM mythical_items`).Scan(&author, &prompt))
	require.Equal(t, member.ID, author)
	require.Equal(t, "Keep the person on the host", prompt)
	// The guest receives a delegated credential and cannot use the person's
	// command channel to skip its ordinary append confirmation requirement.
	token := runtime.current(session)
	require.NotEmpty(t, token)
	code, body := packagedTerminalCLIInvoker(t, ctx, origin, token)("todo", "new", "--text", "Guest append", "--idempotencyKey", "guest-broker-append")
	require.Equal(t, 3, code, body)
	require.Equal(t, "pending", body["state"])
	require.Equal(t, 1, count("mythical_items"))
	require.Equal(t, 1, count("approvals"))
	// Deleting the browser credential after socket admission must be noticed
	// by the next command. The cached socket identity is not fresh authority.
	_, err = pool.Exec(ctx, `DELETE FROM auth_sessions WHERE user_id=$1`, member.ID)
	require.NoError(t, err)
	body = call(appendFrame, 401)
	require.Equal(t, "permission", body["class"])
	require.Equal(t, "unauthenticated", body["code"])
	require.Equal(t, 1, count("mythical_items"))
	require.Equal(t, 1, count("approvals"))
	require.NoError(t, conn.Write(ctx, websocket.MessageText, []byte(`{"type":"close"}`)))
	_, _, err = conn.Read(ctx)
	require.Equal(t, websocket.StatusNormalClosure, websocket.CloseStatus(err))
	require.Eventually(t, func() bool { return runtime.current(session) == "" }, 5*time.Second, 10*time.Millisecond)
}
