package compose

import (
	"crypto/sha256"
	"encoding/hex"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/stretchr/testify/require"
)

func TestMemberTodoCredentialComposedInstallPostgres(t *testing.T) {
	f := newLandingGateFixtureWithFactory(t, nil, "", true)
	workspace, err := f.q.CreateWorkspace(f.ctx, db.CreateWorkspaceParams{RepositoryID: f.repoID, UserID: f.other.ID, Name: "member", TargetBookmark: "smithers/member", Kind: "container", Status: "running"})
	require.NoError(t, err)
	_, err = f.pool.Exec(f.ctx, `INSERT INTO mythical_stacks(repository_id,actor_user_id,state) VALUES($1,$2,'active')`, f.repoID, f.owner.ID)
	require.NoError(t, err)
	run := uuid.NewString()
	item, _, err := f.q.InsertMythicalItem(f.ctx, db.MythicalItem{RepositoryID: f.repoID, Source: "todo", State: "running", WorkspaceID: workspace.ID, RequestRunID: run, OwnerID: pgtype.Int8{Int64: f.other.ID, Valid: true}, Attempt: 1, Checks: []byte(`{"todo":true}`)})
	require.NoError(t, err)
	_, err = f.pool.Exec(f.ctx, `UPDATE mythical_items SET source='todo',workspace_id=$2,request_run_id=$3,owner_id=$4,attempt=1,number=1 WHERE id=$1`, item.ID, workspace.ID, run, f.other.ID)
	require.NoError(t, err)
	item, err = f.q.GetMythicalItem(f.ctx, item.ID)
	require.NoError(t, err)
	_, _, err = f.q.BindMythicalLane(f.ctx, db.MythicalLane{RepositoryID: f.repoID, WorkspaceID: workspace.ID, ItemID: item.ID, Name: "member"})
	require.NoError(t, err)
	service := services.NewMythicalService(f.pool, nil)
	target := flowruntime.FlowRuntimeTarget{TenantID: "repository:" + strconv.FormatInt(f.repoID, 10), PrincipalID: "user:" + strconv.FormatInt(f.other.ID, 10), WorkspaceID: workspace.ID, BindingKind: "mythical-item", BindingID: uuid.UUID(item.ID.Bytes).String()}
	resolver := services.NewMythicalFlowHostTargetResolver(service)
	authority, err := resolver.ResolveFlowHostTarget(f.ctx, target)
	require.NoError(t, err)
	require.Equal(t, f.other.ID, authority.UserID)
	ownerTarget := target
	ownerTarget.PrincipalID = "user:" + strconv.FormatInt(f.owner.ID, 10)
	_, err = resolver.ResolveFlowHostTarget(f.ctx, ownerTarget)
	require.Error(t, err)
	runtime := &candidatePublisherRuntime{}
	workspaces := services.NewWorkspaceService(f.q, services.WithWorkspaceInstallAuthorization(f.q), services.WithWorkspaceTransactions(f.pool), services.WithWorkspaceRuntime(runtime), services.WithWorkspaceGitBaseURL("http://127.0.0.1:47199"))
	environment, err := workspaces.PrepareBoxHost(f.ctx, "member-host", workspace.ID, f.repoID, authority.UserID)
	require.NoError(t, err)
	token := environment["SMITHERS_JJHUB_TOKEN"]
	require.NotEmpty(t, token)
	hash := sha256.Sum256([]byte(token))
	stored, err := f.q.GetAuthInfoByTokenHash(f.ctx, hex.EncodeToString(hash[:]))
	require.NoError(t, err)
	require.Equal(t, f.other.ID, stored.ID)
	other, _, err := f.q.InsertMythicalItem(f.ctx, db.MythicalItem{RepositoryID: f.repoID, Source: "todo", State: "queued", OwnerID: pgtype.Int8{Int64: f.owner.ID, Valid: true}, Checks: []byte(`{"todo":true}`)})
	require.NoError(t, err)
	_, err = f.pool.Exec(f.ctx, `UPDATE mythical_items SET source='todo',owner_id=$2,number=2 WHERE id=$1`, other.ID, f.owner.ID)
	require.NoError(t, err)
	other, err = f.q.GetMythicalItem(f.ctx, other.ID)
	require.NoError(t, err)
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Auth.SessionCookieName = "session"
	cfg.Server.PublicURL = "http://example.com"
	cfg.Server.AllowedOrigins = []string{cfg.Server.PublicURL}
	router := githubAppSetupComposeRouter(cfg, f.pool, nil, routerExtras{Mythical: &routes.MythicalHandler{Service: service}})
	call := func(n int64, status int) {
		t.Helper()
		req := httptest.NewRequest("GET", cfg.Server.PublicURL+"/api/todos/"+strconv.FormatInt(n, 10), nil)
		req.Header.Set("Authorization", "Bearer "+token)
		out := httptest.NewRecorder()
		router.ServeHTTP(out, req)
		require.Equal(t, status, out.Code, out.Body.String())
	}
	call(item.Number.Int64, 200)
	call(other.Number.Int64, 403)
	landing := token
	token = runtime.token
	require.NotEmpty(t, token)
	machineHash := sha256.Sum256([]byte(token))
	machine, err := f.q.GetAuthInfoByTokenHash(f.ctx, hex.EncodeToString(machineHash[:]))
	require.NoError(t, err)
	require.Equal(t, f.other.ID, machine.ID)
	call(item.Number.Int64, 200)
	call(other.Number.Int64, 403)
	token = landing
	started := time.Now()
	_, err = f.pool.Exec(f.ctx, `UPDATE collaborators SET suspended_at=now() WHERE repository_id=$1 AND user_id=$2`, f.repoID, f.other.ID)
	require.NoError(t, err)
	call(item.Number.Int64, 401)
	token = runtime.token
	call(item.Number.Int64, 401)
	require.LessOrEqual(t, time.Since(started), 5*time.Second)
}
