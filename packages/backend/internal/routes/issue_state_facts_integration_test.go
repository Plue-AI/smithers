//go:build integration

package routes

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

func TestIssueStateFactsHTTPPagedReplayIsolationAndRevocation(t *testing.T) {
	f := setupSSETicketRevocationFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	owner := routesIntegrationCreateUser(t, f.pool, "issue_facts_owner")
	reader := routesIntegrationCreateUser(t, f.pool, "issue_facts_reader")
	repo := routesIntegrationCreateRepo(t, f.pool, owner, "issue_facts_public", true)
	private := routesIntegrationCreateRepo(t, f.pool, owner, "issue_facts_private", false)
	_, err := f.pool.Exec(ctx, `INSERT INTO issues(repository_id,number,title,body,author_id) SELECT $1,n,'issue ' || n,'visible body',$2 FROM generate_series(1,1005)n`, repo.ID, owner.ID)
	require.NoError(t, err)
	_, err = f.pool.Exec(ctx, `INSERT INTO issues(repository_id,number,title,body,author_id) VALUES($1,1,'private','private historical body',$2)`, private.ID, owner.ID)
	require.NoError(t, err)
	pat, err := f.auth.CreateToken(ctx, reader.ID, services.CreateTokenRequest{Name: "issue facts", Scopes: []string{string(middleware.ScopeReadRepository)}})
	require.NoError(t, err)
	path := fmt.Sprintf("/api/repos/%s/%s/issues/state-events", repo.Owner, repo.Name)
	open := func(path string) *http.Response {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, f.server.URL+path, nil)
		require.NoError(t, err)
		req.Header.Set("Authorization", "token "+pat.Token)
		resp, err := f.client.Do(req)
		require.NoError(t, err)
		return resp
	}
	unauth := routesIntegrationDoRequest(t, f.client, f.server.URL, http.MethodGet, path, nil)
	require.Equal(t, http.StatusUnauthorized, unauth.StatusCode)
	_ = routesIntegrationReadBody(t, unauth)
	denied := open(fmt.Sprintf("/api/repos/%s/%s/issues/state-events", private.Owner, private.Name))
	require.Equal(t, http.StatusForbidden, denied.StatusCode)
	require.NotContains(t, string(routesIntegrationReadBody(t, denied)), "private historical body")
	pageResp := open(path + "?after=0&limit=1000")
	require.Equal(t, http.StatusOK, pageResp.StatusCode)
	var page services.IssueStateFactPage
	routesIntegrationDecodeJSON(t, pageResp, &page)
	require.Len(t, page.Events, 1000)
	require.True(t, page.HasMore)
	require.Equal(t, int64(1000), page.Cursor)
	resp := open(path + "/stream?after=999")
	defer resp.Body.Close()
	require.Equal(t, http.StatusOK, resp.StatusCode)
	stream := bufio.NewReader(resp.Body)
	for seq := int64(1000); seq <= 1005; seq++ {
		frame := readAgentSSEFrameFromReader(t, stream, resp.Body, 3*time.Second)
		require.Equal(t, fmt.Sprint(seq), frame["id"])
		require.Equal(t, "issue.fact", frame["event"])
		var fact services.IssueStateFact
		require.NoError(t, json.Unmarshal([]byte(frame["data"]), &fact))
		require.Equal(t, fmt.Sprintf("issues:%d", repo.ID), fact.StreamID)
		require.NotContains(t, frame["data"], "private historical body")
		if seq == 1000 {
			require.Equal(t, page.Events[999].ID, fact.ID)
		}
	}
	_, err = f.pool.Exec(ctx, `UPDATE issues SET body='live accepted edit' WHERE repository_id=$1 AND number=1`, repo.ID)
	require.NoError(t, err)
	frame := readAgentSSEFrameFromReader(t, stream, resp.Body, 3*time.Second)
	require.Equal(t, "1006", frame["id"])
	require.Contains(t, frame["data"], "live accepted edit")
	require.NoError(t, f.auth.DeleteToken(ctx, reader.ID, pat.ID))
	body, err := io.ReadAll(stream)
	require.NoError(t, err)
	require.Contains(t, string(body), "event: revoked")
	// Current source permissions also gate historical replay after visibility changes.
	_, err = f.pool.Exec(ctx, `UPDATE repositories SET is_public=false WHERE id=$1`, repo.ID)
	require.NoError(t, err)
	client := routesIntegrationAuthenticatedClient(t, f.server, routesIntegrationCreateSessionCookie(t, f.queries, reader))
	hidden := routesIntegrationDoRequest(t, client, f.server.URL, http.MethodGet, path, nil)
	require.Equal(t, http.StatusForbidden, hidden.StatusCode)
	require.NotContains(t, string(routesIntegrationReadBody(t, hidden)), "visible body")
}

// Reaction deliveries have no comment fact. Their committed notify must travel
// through the real broker/stream without waiting for a client repair poll.
