package compose

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
)

func TestTerminalPersonCommandComposedInstall(t *testing.T) { testOwnerTerminalComposed(t, false) }

func proveTerminalPersonCommand(t *testing.T, f presenceInstallFixture, origin, session, guest string) func() {
	t.Helper()
	call := func(cookie, bearer, body, key string) (int, []byte) {
		request, err := http.NewRequestWithContext(t.Context(), "POST", origin+"/api/terminals/"+session+"/commands", strings.NewReader(body))
		require.NoError(t, err)
		request.Header.Set("Origin", origin)
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("X-CSRF-Token", "csrf")
		request.Header.Set("Idempotency-Key", key)
		if cookie != "" {
			request.Header.Set("Cookie", "session="+cookie+"; __csrf=csrf")
		}
		if bearer != "" {
			request.Header.Set("Authorization", "Bearer "+bearer)
		}
		request.Header.Set("Smithers-Via", "claude-code")
		request.Header.Set("Smithers-Actor-Kind", "person")
		response, err := http.DefaultClient.Do(request)
		require.NoError(t, err)
		defer response.Body.Close()
		raw, err := io.ReadAll(response.Body)
		require.NoError(t, err)
		return response.StatusCode, raw
	}
	body := `{"command":"todo.new","payload":{"title":"Person terminal append","prompt":"Append through the host command broker","place":{"mode":"append"}}}`
	var before int
	require.NoError(t, f.pool.QueryRow(t.Context(), `SELECT count(*) FROM mythical_items WHERE repository_id=$1`, f.row.RepositoryID).Scan(&before))
	for _, fixture := range []struct {
		cookie, bearer, body string
		status               int
	}{
		{"alice-terminal-cookie", "", body, 401},
		{"", guest, body, 403},
		{f.cookie, "", `{"command":"todo.new","payload":{"title":"Invalid placement","prompt":"Must not append","place":{"mode":"before","n":1}}}`, 403},
		{f.cookie, "", `{"command":"merge","payload":{}}`, 400},
		{f.cookie, "", body + ` {}`, 400},
	} {
		status, raw := call(fixture.cookie, fixture.bearer, fixture.body, uuid.NewString())
		require.Equal(t, fixture.status, status, string(raw))
	}
	key := uuid.NewString()
	status, raw := call(f.cookie, "", body, key)
	require.Equal(t, 202, status, string(raw))
	var receipt struct {
		N int64 `json:"n"`
	}
	require.NoError(t, json.Unmarshal(raw, &receipt))
	require.Positive(t, receipt.N)
	status, raw = call(f.cookie, "", body, key)
	require.Equal(t, 202, status, string(raw))
	var replay struct {
		N int64 `json:"n"`
	}
	require.NoError(t, json.Unmarshal(raw, &replay))
	require.Equal(t, receipt.N, replay.N)
	var after, confirmations int
	require.NoError(t, f.pool.QueryRow(t.Context(), `SELECT count(*) FROM mythical_items WHERE repository_id=$1`, f.row.RepositoryID).Scan(&after))
	require.Equal(t, before+1, after)
	require.NoError(t, f.pool.QueryRow(t.Context(), `SELECT count(*) FROM approvals`).Scan(&confirmations))
	require.Zero(t, confirmations)
	var binding string
	require.NoError(t, f.pool.QueryRow(t.Context(), `SELECT convert_from(data,'UTF8') FROM auth_sessions WHERE convert_from(data,'UTF8')::jsonb->>'terminal_session'=$1`, session).Scan(&binding))
	require.JSONEq(t, fmt.Sprintf(`{"kind":"session","via":"terminal","member":%d,"branch":%q,"terminal_session":%q}`, f.user.ID, f.row.ID, session), binding)
	return func() {
		status, raw := call(f.cookie, "", body, uuid.NewString())
		require.Equal(t, 401, status, string(raw))
		var live int
		require.NoError(t, f.pool.QueryRow(t.Context(), `SELECT count(*) FROM auth_sessions WHERE convert_from(data,'UTF8')::jsonb->>'terminal_session'=$1`, session).Scan(&live))
		require.Zero(t, live)
	}
}
