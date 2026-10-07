package compose

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/stretchr/testify/require"
)

// The real install credential fence and PostgreSQL transaction must compose
// with head persistence. This does not qualify physical guest isolation.
func TestFlowLoadHeadReportUsesCredentialTransaction(t *testing.T) {
	f := newLandingGateFixtureWithFactory(t, nil, "", true)
	workspace, err := f.q.CreateWorkspace(f.ctx, db.CreateWorkspaceParams{RepositoryID: f.repoID,
		UserID: f.owner.ID, Name: "flow-load", TargetBookmark: "main", Kind: "container", Status: "running"})
	require.NoError(t, err)
	scopes := "write:repository," + middleware.RepositoryRestrictionScope(f.repoID) + "," + middleware.WorkspaceRestrictionScope(workspace.ID)
	token := f.token(f.owner, "flow-load-publisher", scopes, true)
	sum := sha256.Sum256([]byte(token))
	stored, err := f.q.GetAuthInfoByTokenHash(f.ctx, hex.EncodeToString(sum[:]))
	require.NoError(t, err)
	_, err = f.pool.Exec(f.ctx, `UPDATE workspaces SET head_push_token_id=$2 WHERE id=$1`, workspace.ID, stored.TokenID)
	require.NoError(t, err)
	runtime := &candidateHeadRuntime{host: true}
	service := services.NewWorkspaceService(f.q, services.WithWorkspaceInstallAuthorization(f.q),
		services.WithWorkspaceTransactions(f.pool), services.WithWorkspaceRuntime(runtime))
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode, cfg.Auth.SessionCookieName = "selfhost", "session"
	cfg.Server.PublicURL = "http://example.com"
	cfg.Server.AllowedOrigins = []string{cfg.Server.PublicURL}
	router := githubAppSetupComposeRouter(cfg, f.pool, nil, &routes.WorkspaceHandler{Service: service})
	head, change := strings.Repeat("a", 40), strings.Repeat("z", 32)
	report := func(commit string) *httptest.ResponseRecorder {
		t.Helper()
		ctx, cancel := context.WithTimeout(f.ctx, 5*time.Second)
		defer cancel()
		request := httptest.NewRequest("POST", fmt.Sprintf("%s/api/repos/gate-owner/app/workspaces/%s/head", cfg.Server.PublicURL, workspace.ID),
			strings.NewReader(fmt.Sprintf(`{"commit_id":%q,"change_id":%q,"ahead":0,"behind":0}`, commit, change))).WithContext(ctx)
		request.Header.Set("Authorization", "Bearer "+token)
		request.Header.Set("Content-Type", "application/json")
		response := httptest.NewRecorder()
		router.ServeHTTP(response, request)
		require.NoError(t, ctx.Err(), "head persistence must not wait on its own workspace fence")
		return response
	}
	response := report(head)
	require.Equal(t, 200, response.Code, response.Body.String())
	row, err := f.q.GetWorkspace(f.ctx, workspace.ID)
	require.NoError(t, err)
	require.Equal(t, head, row.HeadCommitID)
	require.Zero(t, runtime.calls, "a flow-load head report executes no repository code on the host")
	// Associating the same machine with a TODO still requires real isolation.
	// Refusal must roll back, rather than publish the unvalidated replacement.
	_, err = f.pool.Exec(f.ctx, `INSERT INTO mythical_items(repository_id,source,state,title,owner_id,workspace_id,candidate_base,candidate_head,attempt,generation,checks)
		VALUES($1,'todo','proposed','Protected candidate',$2,$3,$4,$4,1,1,'{}')`, f.repoID, f.owner.ID, workspace.ID, head)
	require.NoError(t, err)
	response = report(strings.Repeat("b", 40))
	require.Equal(t, 503, response.Code, response.Body.String())
	require.Contains(t, response.Body.String(), `"code":"service_unavailable"`)
	require.Contains(t, response.Body.String(), `"class":"infra"`)
	require.Zero(t, runtime.calls)
	row, err = f.q.GetWorkspace(f.ctx, workspace.ID)
	require.NoError(t, err)
	require.Equal(t, head, row.HeadCommitID)
}
