package compose

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
)

// The runtime supplies deterministic revision observations; this tests the real
// HTTP/credential/SQL transaction, not microVM or repository-engine qualification.
type headObservationRuntime struct {
	workspaceapi.WorkspaceRuntime
	calls int
}

func (*headObservationRuntime) Isolation() workspaceapi.IsolationLevel {
	return workspaceapi.IsolationSandboxed
}
func (r *headObservationRuntime) ExecuteCommand(_ context.Context, _ string, c workspaceapi.Command) (workspaceapi.CommandResult, error) {
	r.calls++
	if len(c.Args) > 0 && c.Args[0] == "jj" {
		return workspaceapi.CommandResult{Stdout: strings.Repeat("c", 40) + " " + strings.Repeat("l", 32)}, nil
	}
	if len(c.Args) == 4 && c.Args[0] == "git" && c.Args[1] == "rev-parse" {
		switch c.Args[3] {
		case strings.Repeat("c", 40) + "^{tree}":
			return workspaceapi.CommandResult{Stdout: strings.Repeat("d", 40)}, nil
		case strings.Repeat("b", 40) + "^{tree}":
			return workspaceapi.CommandResult{Stdout: strings.Repeat("e", 40)}, nil
		}
	}
	return workspaceapi.CommandResult{}, fmt.Errorf("unexpected observation: %v", c.Args)
}

func TestInstallHeadStaleReportCommitsInvalidationPostgres(t *testing.T) {
	f := newLandingGateFixtureWithFactory(t, nil, "", true)
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Server.PublicURL = "http://example.com"
	cfg.Server.AllowedOrigins = []string{cfg.Server.PublicURL}
	runtime := &headObservationRuntime{}
	service := services.NewWorkspaceService(f.q, services.WithWorkspaceInstallAuthorization(f.q), services.WithWorkspaceTransactions(f.pool), services.WithWorkspaceRuntime(runtime))
	router := githubAppSetupComposeRouter(cfg, f.pool, nil, &routes.WorkspaceHandler{Service: service})
	row, err := f.q.CreateWorkspace(f.ctx, db.CreateWorkspaceParams{RepositoryID: f.repoID, UserID: f.owner.ID, Name: "stale-report", TargetBookmark: "main", Kind: "container", Status: "running"})
	require.NoError(t, err)
	scopes := "write:repository," + middleware.RepositoryRestrictionScope(f.repoID) + "," + middleware.WorkspaceRestrictionScope(row.ID)
	token := f.token(f.owner, "stale-head", scopes, true)
	sum := sha256.Sum256([]byte(token))
	stored, err := f.q.GetAuthInfoByTokenHash(f.ctx, hex.EncodeToString(sum[:]))
	require.NoError(t, err)
	_, err = f.pool.Exec(f.ctx, `UPDATE workspaces SET head_push_token_id=$2 WHERE id=$1`, row.ID, stored.TokenID)
	require.NoError(t, err)
	_, err = f.pool.Exec(f.ctx, `INSERT INTO mythical_stacks(repository_id,actor_user_id,state) VALUES($1,$2,'active') ON CONFLICT DO NOTHING`, f.repoID, f.owner.ID)
	require.NoError(t, err)
	_, err = f.pool.Exec(f.ctx, `INSERT INTO mythical_items(repository_id,source,state,number,stack_position,title,workspace_id,request_run_id,owner_id,created_by,candidate_verified,candidate_head,checks) VALUES($1,'todo','proposed',61,61,'Head observation',$2,'current-run',$3,$3,true,$4,'{"todo":true,"land":{}}')`, f.repoID, row.ID, f.owner.ID, strings.Repeat("b", 40))
	require.NoError(t, err)
	req := httptest.NewRequest("POST", fmt.Sprintf("%s/api/repos/gate-owner/app/workspaces/%s/head", cfg.Server.PublicURL, row.ID), strings.NewReader(fmt.Sprintf(`{"change_id":%q,"commit_id":%q,"ahead":1,"behind":0}`, strings.Repeat("k", 32), strings.Repeat("a", 40))))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	ctx, cancel := context.WithTimeout(req.Context(), 5*time.Second)
	defer cancel()
	count := 0
	req = req.WithContext(services.WithAuthorizationObserver(ctx, func(string) { count++ }))
	out := httptest.NewRecorder()
	router.ServeHTTP(out, req)
	require.Equal(t, 409, out.Code, out.Body.String())
	require.Equal(t, 1, count)
	require.Equal(t, 3, runtime.calls)
	var number int64
	require.NoError(t, f.pool.QueryRow(f.ctx, `SELECT number FROM mythical_items WHERE workspace_id=$1`, row.ID).Scan(&number))
	item, err := f.q.GetMythicalItemByNumber(f.ctx, f.repoID, number)
	require.NoError(t, err)
	require.False(t, item.CandidateVerified, "the stale HTTP result must not roll back live-tree invalidation")
	require.Equal(t, strings.Repeat("b", 40), item.CandidateHead)
	var checks map[string]any
	require.NoError(t, json.Unmarshal(item.Checks, &checks))
	require.NotContains(t, checks, "land")
	after, err := f.q.GetWorkspace(f.ctx, row.ID)
	require.NoError(t, err)
	require.Equal(t, row.HeadCommitID, after.HeadCommitID)
	require.Equal(t, row.HeadChangeID, after.HeadChangeID)
}
