package compose

import (
	"encoding/json"
	"io"
	"net/http"
	"strconv"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
)

func TestTerminalS2CatalogComposedInstall(t *testing.T) {
	testOwnerTerminalComposed(t, false, "catalog-delegation")
}

func proveTerminalCatalogDelegation(t *testing.T, f presenceInstallFixture, origin, session, token string) {
	t.Helper()
	var scopes string
	require.NoError(t, f.pool.QueryRow(t.Context(), `SELECT scopes FROM access_tokens WHERE name=$1`, "terminal-session-"+session).Scan(&scopes))
	require.Equal(t, "repo,user,workspace,agent,repo:"+strconv.FormatInt(f.row.RepositoryID, 10)+",via:terminal,branch:"+f.row.ID+",terminal-session:"+session, scopes)
	var before int
	require.NoError(t, f.pool.QueryRow(t.Context(), `SELECT count(*) FROM mythical_items WHERE repository_id=$1`, f.row.RepositoryID).Scan(&before))
	call := func(method, path, body, cookie, bearer, key string) (int, []byte) {
		request, err := http.NewRequestWithContext(t.Context(), method, origin+path, strings.NewReader(body))
		require.NoError(t, err)
		request.Header.Set("Origin", origin)
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Idempotency-Key", key)
		if cookie != "" {
			request.Header.Set("Cookie", "session="+cookie+"; __csrf=csrf")
			request.Header.Set("X-CSRF-Token", "csrf")
		}
		if bearer != "" {
			request.Header.Set("Authorization", "Bearer "+bearer)
		}
		request.Header.Set("Smithers-Via", "claude-code")
		response, err := http.DefaultClient.Do(request)
		require.NoError(t, err)
		defer response.Body.Close()
		raw, err := io.ReadAll(response.Body)
		require.NoError(t, err)
		return response.StatusCode, raw
	}
	status, raw := call("POST", "/api/todos", `{"title":"S2 after placement","prompt":"Request after T1 through the catalog","place":{"mode":"before","n":2}}`, "", token, uuid.NewString())
	require.Equal(t, 202, status, string(raw))
	var receipt struct {
		ID string `json:"confirmation"`
	}
	require.NoError(t, json.Unmarshal(raw, &receipt))
	require.NotEmpty(t, receipt.ID, string(raw))
	var after int
	require.NoError(t, f.pool.QueryRow(t.Context(), `SELECT count(*) FROM mythical_items WHERE repository_id=$1`, f.row.RepositoryID).Scan(&after))
	require.Equal(t, before, after)
	status, raw = call("GET", "/api/confirmations", "", f.cookie, "", "")
	require.Equal(t, 200, status, string(raw))
	for _, door := range []struct {
		method, path, cookie, bearer string
		status                       int
	}{
		{"GET", "/api/confirmations", "", token, 200},
		{"POST", "/api/confirmations/" + receipt.ID + "/approve", "", token, 403},
		{"POST", "/api/confirmations/" + receipt.ID + "/approve", "alice-terminal-cookie", "", 403},
	} {
		status, raw = call(door.method, door.path, "{}", door.cookie, door.bearer, uuid.NewString())
		require.Equal(t, door.status, status, string(raw))
		if door.method == "GET" && door.bearer != "" {
			require.JSONEq(t, `[{"id":"`+receipt.ID+`","state":"pending"}]`, string(raw))
		}
	}
	key := uuid.NewString()
	for i := 0; i < 2; i++ {
		status, raw = call("POST", "/api/confirmations/"+receipt.ID+"/approve", "{}", f.cookie, "", key)
		require.Equal(t, 200, status, string(raw))
	}
	require.NoError(t, f.pool.QueryRow(t.Context(), `SELECT count(*) FROM mythical_items WHERE repository_id=$1`, f.row.RepositoryID).Scan(&after))
	require.Equal(t, before+1, after)
	var titles []string
	rows, err := f.pool.Query(t.Context(), `SELECT issue_title FROM mythical_items WHERE repository_id=$1 ORDER BY stack_position`, f.row.RepositoryID)
	require.NoError(t, err)
	defer rows.Close()
	for rows.Next() {
		var title string
		require.NoError(t, rows.Scan(&title))
		titles = append(titles, title)
	}
	require.NoError(t, rows.Err())
	require.Equal(t, []string{"Retry webhooks", "S2 after placement", "Person terminal append"}, titles)
}
