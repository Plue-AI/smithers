package compose

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

// An actual HTTP listener and database-backed bearer authentication qualify the
// product cut independently of context-injected router tests. No provider is
// configured or invoked: the retired webhook must never acknowledge a delivery.
func TestFirstPartyLinearRetirementHTTPPostgres(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	ctx := context.Background()
	q := db.New(pool)
	owner, err := q.CreateUser(ctx, db.CreateUserParams{Username: "alice", LowerUsername: "alice", DisplayName: "Alice"})
	require.NoError(t, err)
	_, err = q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: owner.ID, Valid: true}, Name: "demo", LowerName: "demo", DefaultBookmark: "main"})
	require.NoError(t, err)
	token := "smithers_" + strings.Repeat("d", 40)
	sum := sha256.Sum256([]byte(token))
	digest := hex.EncodeToString(sum[:])
	_, err = q.CreateAccessToken(ctx, db.CreateAccessTokenParams{UserID: owner.ID, Name: "retirement", TokenHash: digest, TokenLastEight: digest[len(digest)-8:], Scopes: "read:user,read:repository,write:repository", ExpiresAt: pgtype.Timestamptz{Time: time.Now().Add(time.Hour), Valid: true}})
	require.NoError(t, err)
	router := buildRouterCompat(testConfigAllFlagsOn(), q, pool,
		&routes.RepoHandler{}, &routes.AuthHandler{}, &routes.UserHandler{}, &routes.SSHKeyHandler{}, &routes.LabelHandler{},
		&routes.OrgHandler{}, &routes.LandingHandler{}, &routes.SearchHandler{Service: &mockRouterSearchService{}}, &routes.IssueHandler{},
		nil, &routes.GitSmartHandler{Service: &mockRouterGitService{}},
		nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil)
	server := httptest.NewServer(router)
	defer server.Close()
	client := &http.Client{Timeout: 5 * time.Second, CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }}
	call := func(method, path, bearer string) (int, string) {
		t.Helper()
		request, err := http.NewRequest(method, server.URL+path, strings.NewReader(`{}`))
		require.NoError(t, err)
		request.Header.Set("Content-Type", "application/json")
		if bearer != "" {
			request.Header.Set("Authorization", "Bearer "+bearer)
		}
		response, err := client.Do(request)
		require.NoError(t, err)
		defer response.Body.Close()
		body, err := io.ReadAll(response.Body)
		require.NoError(t, err)
		return response.StatusCode, string(body)
	}
	doors := []struct {
		method string
		path   string
	}{
		{http.MethodPost, "/webhooks/linear"},
		{http.MethodGet, "/api/auth/linear"},
		{http.MethodGet, "/api/auth/linear/callback"},
		{http.MethodGet, "/api/linear/setup/key"},
		{http.MethodPost, "/api/linear"},
		{http.MethodGet, "/api/integrations/linear"},
		{http.MethodPost, "/api/integrations/linear"},
		{http.MethodGet, "/api/integrations/linear/repositories"},
		{http.MethodGet, "/api/integrations/linear/setup/key"},
		{http.MethodDelete, "/api/integrations/linear/1"},
		{http.MethodPost, "/api/integrations/linear/1/sync"},
		{http.MethodGet, "/api/linear/1/ops"},
		{http.MethodPost, "/api/linear/1/ops/2/retry"},
		{http.MethodPost, "/api/linear/1/sync"},
		{http.MethodGet, "/api/linear/1/sync/run"},
		{http.MethodPost, "/api/repos/alice/demo/issues/1/linear-link"},
		{http.MethodDelete, "/api/repos/alice/demo/issues/1/linear-link"},
	}

	for _, door := range doors {
		t.Run(door.method+" "+door.path, func(t *testing.T) {
			for _, bearer := range []string{"", token} {
				status, body := call(door.method, door.path, bearer)
				require.Contains(t, []int{http.StatusNotFound, http.StatusMethodNotAllowed}, status, body)
			}
		})
	}
	// Supported catalog reads still authenticate against the real database; an
	// empty installation is truthfully empty rather than advertising Linear.
	for _, path := range []string{"/api/integrations/mcp", "/api/integrations/skills"} {
		status, body := call(http.MethodGet, path, "")
		require.Equal(t, http.StatusUnauthorized, status, body)
		status, body = call(http.MethodGet, path, token)
		require.Equal(t, http.StatusOK, status, body)
		require.JSONEq(t, `[]`, body)
	}
	// Historical schema is retained, but refused old ingress/commands cannot
	// create an issue, operation, setup, mapping, integration, or sync run.
	for _, table := range []string{"issues", "linear_integrations", "linear_oauth_setups", "linear_issue_map", "linear_comment_map", "linear_sync_ops", "linear_sync_runs"} {
		var count int64
		require.NoError(t, pool.QueryRow(ctx, "SELECT count(*) FROM "+table).Scan(&count))
		require.Zero(t, count, table)
	}
}
