package compose

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/sandbox"
	"github.com/smithersai/smithers/packages/backend/sandbox/sandboxfake"
	"github.com/stretchr/testify/require"
)

type childrenAuthorizationProvider struct {
	*sandboxfake.Provider
	snapshotEntered, snapshotRelease chan struct{}
	deleteEntered, deleteRelease     chan struct{}
}

func (p *childrenAuthorizationProvider) SnapshotSandbox(ctx context.Context, id string, req sandbox.SnapshotRequest) (sandbox.SnapshotResult, error) {
	if p.snapshotEntered != nil {
		close(p.snapshotEntered)
		select {
		case <-p.snapshotRelease:
		case <-ctx.Done():
			return sandbox.SnapshotResult{}, ctx.Err()
		}
		return sandbox.SnapshotResult{}, errors.New("test-only snapshot failure")
	}
	return p.Provider.SnapshotSandbox(ctx, id, req)
}
func (p *childrenAuthorizationProvider) DeleteSandbox(ctx context.Context, id string) error {
	if p.deleteEntered != nil {
		close(p.deleteEntered)
		select {
		case <-p.deleteRelease:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	return p.Provider.DeleteSandbox(ctx, id)
}

func TestInstallWorkspaceChildrenMutationAuthorityPostgres(t *testing.T) {
	f := newLandingGateFixtureWithFactory(t, nil, "", true)
	ctx, cancel := context.WithTimeout(f.ctx, 30*time.Second)
	defer cancel()
	provider := &childrenAuthorizationProvider{Provider: sandboxfake.New()}
	parent, err := f.q.CreateWorkspace(ctx, db.CreateWorkspaceParams{RepositoryID: f.repoID, UserID: f.owner.ID, Name: "children-authority", TargetBookmark: "smithers/children", Kind: "container", Status: "running"})
	require.NoError(t, err)
	vm := provider.Boot(map[string]string{})
	_, err = f.q.UpdateWorkspaceExecutionInfo(ctx, db.UpdateWorkspaceExecutionInfoParams{ID: parent.ID, VmID: vm, Status: "running"})
	require.NoError(t, err)
	service := services.NewWorkspaceService(f.q, services.WithWorkspaceInstallAuthorization(f.q), services.WithWorkspaceTransactions(f.pool), services.WithWorkspaceSandboxClient(provider))
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Server.PublicURL = "http://example.com"
	cfg.Server.AllowedOrigins = []string{cfg.Server.PublicURL}
	router := githubAppSetupComposeRouter(cfg, f.pool, nil, &routes.WorkspaceHandler{Service: service})
	scopes := "read:repository,write:workspace," + middleware.RepositoryRestrictionScope(f.repoID) + "," + middleware.WorkspaceRestrictionScope(parent.ID) + "," + middleware.WorkspaceChildrenCredentialScope()
	token := f.token(f.owner, "sandbox-workspace-children-"+parent.ID, scopes, true)
	sum := sha256.Sum256([]byte(token))
	hash := hex.EncodeToString(sum[:])
	stored, err := f.q.GetAuthInfoByTokenHash(ctx, hash)
	require.NoError(t, err)
	info := &middleware.AuthInfo{User: &f.owner, IsTokenAuth: true, TokenSystemIssued: true, TokenID: stored.TokenID, TokenHash: hash, RawScopes: scopes, Scopes: middleware.ParseTokenScopes(scopes)}
	type response struct {
		out       *httptest.ResponseRecorder
		decisions []string
	}
	call := func(path, body string) response {
		req := httptest.NewRequest("POST", cfg.Server.PublicURL+"/api/repos/gate-owner/app/workspaces/"+parent.ID+path, strings.NewReader(body))
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("Content-Type", "application/json")
		result := response{out: httptest.NewRecorder()}
		req = req.WithContext(services.WithAuthorizationObserver(ctx, func(command string) { result.decisions = append(result.decisions, command) }))
		router.ServeHTTP(result.out, req)
		return result
	}
	for _, body := range []string{`{"count":0}`, `{"count":129}`, `{"count":1,"profile":"unknown"}`, `{"count":1,"ttl_secs":-1}`, `{"count":1} {}`, `{"count":1,"actor":"owner"}`} {
		result := call("/children", body)
		require.Equal(t, 400, result.out.Code, result.out.Body.String())
		require.Empty(t, result.decisions)
	}
	t.Run("bound batch cannot change", func(t *testing.T) {
		input := services.SpawnWorkspaceChildrenInput{RepositoryID: f.repoID, UserID: f.owner.ID, ParentWorkspaceID: parent.ID, Count: 1}
		for _, field := range []string{"count", "profile", "ttl", "actor"} {
			t.Run(field, func(t *testing.T) {
				decisions := 0
				ctx := services.WithAuthorizationObserver(middleware.ContextWithAuthInfo(ctx, info), func(string) { decisions++ })
				subject, err := services.InstallWorkspaceChildrenSpawnSubject(input)
				require.NoError(t, err)
				decision, err := services.Authorize(ctx, f.q, "workspace.children.spawn", subject)
				require.NoError(t, err)
				changed := input
				switch field {
				case "count":
					changed.Count = 2
				case "profile":
					changed.Profile = "build"
				case "ttl":
					changed.TTL = time.Minute
				case "actor":
					changed.UserID = f.other.ID
				}
				_, err = service.SpawnWorkspaceChildren(services.WithInstallAuthorization(ctx, "workspace.children.spawn", decision, subject), changed)
				var denied *services.AccessError
				require.ErrorAs(t, err, &denied)
				require.Equal(t, 403, denied.Status)
				require.Equal(t, 1, decisions)
			})
		}
	})
	t.Run("spawn holds authority through snapshot and returns before execution", func(t *testing.T) {
		provider.snapshotEntered, provider.snapshotRelease = make(chan struct{}), make(chan struct{})
		defer func() { provider.snapshotEntered = nil; provider.snapshotRelease = nil }()
		result := call("/children", `{"count":1,"ttl_secs":60}`)
		require.Equal(t, http.StatusAccepted, result.out.Code, result.out.Body.String())
		require.Equal(t, []string{"workspace.children.spawn"}, result.decisions)
		var batch services.WorkspaceChildBatch
		require.NoError(t, json.Unmarshal(result.out.Body.Bytes(), &batch))
		require.Len(t, batch.Children, 1)
		select {
		case <-provider.snapshotEntered:
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
		revoked := make(chan error, 1)
		go func() {
			_, err := f.pool.Exec(ctx, `UPDATE access_tokens SET expires_at=now()-interval '1 second' WHERE id=$1`, stored.TokenID)
			revoked <- err
		}()
		select {
		case err := <-revoked:
			t.Fatalf("revocation crossed the snapshot fence: %v", err)
		case <-time.After(80 * time.Millisecond):
		}
		close(provider.snapshotRelease)
		require.NoError(t, service.WaitForProvisioning(ctx))
		require.NoError(t, <-revoked)
		var status string
		require.NoError(t, f.pool.QueryRow(ctx, `SELECT status FROM workspaces WHERE id=$1`, batch.Children[0].WorkspaceID).Scan(&status))
		require.Equal(t, "failed", status)
		require.Equal(t, 401, call("/children", `{"count":1}`).out.Code)
		_, err = f.pool.Exec(ctx, `UPDATE access_tokens SET expires_at=now()+interval '1 hour' WHERE id=$1`, stored.TokenID)
		require.NoError(t, err)
	})
	t.Run("stop holds authority through release", func(t *testing.T) {
		tx, err := f.pool.Begin(ctx)
		require.NoError(t, err)
		defer tx.Rollback(ctx)
		q := db.New(tx)
		batch, err := q.CreateWorkspaceChildBatch(ctx, db.CreateWorkspaceChildBatchParams{ParentWorkspaceID: parentUUID(t, parent.ID), UserID: f.owner.ID, Profile: "small", Requested: 1, ExpiresAt: time.Now().Add(time.Hour)})
		require.NoError(t, err)
		require.NoError(t, q.ReserveWorkspaceChildren(ctx, batch.ID))
		children, err := q.CreateWorkspaceChildRows(ctx, batch.ID)
		require.NoError(t, err)
		require.Len(t, children, 1)
		require.NoError(t, tx.Commit(ctx))
		child := children[0]
		vm := provider.Boot(map[string]string{})
		require.NoError(t, f.q.RecordWorkspaceChildVM(ctx, db.RecordWorkspaceChildVMParams{WorkspaceID: child.ID, VmID: vm}))
		_, err = f.q.StartWorkspaceChild(ctx, db.StartWorkspaceChildParams{WorkspaceID: child.ID, VmID: vm})
		require.NoError(t, err)
		provider.deleteEntered, provider.deleteRelease = make(chan struct{}), make(chan struct{})
		done := make(chan response, 1)
		go func() { done <- call("/children/"+child.ID+"/stop", `{}`) }()
		select {
		case <-provider.deleteEntered:
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
		revoked := make(chan error, 1)
		go func() {
			_, err := f.pool.Exec(ctx, `UPDATE access_tokens SET expires_at=now()-interval '1 second' WHERE id=$1`, stored.TokenID)
			revoked <- err
		}()
		select {
		case err := <-revoked:
			t.Fatalf("revocation crossed release: %v", err)
		case <-time.After(80 * time.Millisecond):
		}
		close(provider.deleteRelease)
		result := <-done
		require.Equal(t, 200, result.out.Code, result.out.Body.String())
		require.Equal(t, []string{"workspace.children.stop"}, result.decisions)
		require.NoError(t, <-revoked)
		provider.deleteEntered, provider.deleteRelease = nil, nil
		require.Equal(t, 401, call("/children/"+child.ID+"/stop", `{}`).out.Code)
	})
}

func parentUUID(t *testing.T, s string) pgtype.UUID {
	t.Helper()
	var value pgtype.UUID
	require.NoError(t, value.Scan(s))
	return value
}
