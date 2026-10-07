package compose

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/blob"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/stretchr/testify/require"
)

func TestInstallExecutionLogReadPostgres(t *testing.T) {
	f := newLandingGateFixtureWithFactory(t, nil, "", true)
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Server.PublicURL = "http://example.com"
	cfg.Server.AllowedOrigins = []string{"http://example.com"}
	disk, err := blob.NewFilesystemStore(blob.FilesystemConfig{Root: filepath.Join(t.TempDir(), "logs"), PublicBaseURL: cfg.Server.PublicURL, SigningKey: bytes.Repeat([]byte{0x42}, 32)})
	require.NoError(t, err)
	defer disk.Close()
	store := &todoCountingLogStore{Store: disk}
	service := services.NewMythicalService(f.pool, nil)
	service.SetTodoLogStore(store)
	router := githubAppSetupComposeRouter(cfg, f.pool, nil, routerExtras{Mythical: &routes.MythicalHandler{Service: service}})
	payload := "current execution check output\n"
	hash := sha256.Sum256([]byte(payload))
	digest := hex.EncodeToString(hash[:])
	require.NoError(t, blob.Put(f.ctx, store, fmt.Sprintf("repos/%d/todo-logs/%s", f.repoID, digest), "text/plain", strings.NewReader(payload)))
	workspaces := make([]db.Workspace, 2)
	for i := range workspaces {
		row, err := f.q.CreateWorkspace(f.ctx, db.CreateWorkspaceParams{RepositoryID: f.repoID, UserID: f.owner.ID, Name: fmt.Sprintf("log-%d", i), TargetBookmark: "main", Kind: "container", Status: "running"})
		require.NoError(t, err)
		workspaces[i] = row
		evidence := map[string]any{"attempts": []any{map[string]any{"attempt": 1, "items": []any{map[string]any{"kind": "check", "log_digest": digest}}}, map[string]any{"attempt": 2, "items": []any{map[string]any{"kind": "check", "log_digest": digest}}}}}
		checks, err := json.Marshal(evidence)
		require.NoError(t, err)
		_, err = f.pool.Exec(f.ctx, `INSERT INTO mythical_items(repository_id,source,state,number,stack_position,title,workspace_id,request_run_id,owner_id,created_by,attempt,checks) VALUES($1,'todo','running',$2,$2,'Execution log',$3,$4,$5,$5,2,$6)`, f.repoID, i+1, row.ID, fmt.Sprintf("log-run-%d", i), f.owner.ID, checks)
		require.NoError(t, err)
	}
	for _, kind := range []string{"run", "machine"} {
		binding := middleware.LandingWorkspaceScope(workspaces[0].ID) + "," + middleware.AgentSessionRestrictionScope("log-run-0")
		if kind == "machine" {
			binding = middleware.WorkspaceRestrictionScope(workspaces[0].ID)
		}
		token := f.token(f.owner, "log-"+kind, "read:repository,"+middleware.RepositoryRestrictionScope(f.repoID)+","+binding, true)
		for _, cell := range []struct {
			name, path string
			status     int
		}{
			{"current", "/api/todos/1/attempts/2/logs/" + digest, 200},
			{"prior", "/api/todos/1/attempts/1/logs/" + digest, 403},
			{"other", "/api/todos/2/attempts/2/logs/" + digest, 403},
			{"unreferenced", "/api/todos/1/attempts/2/logs/" + strings.Repeat("a", 64), 404},
			{"private events", "/api/todos/1/events", 403},
		} {
			t.Run(kind+"/"+cell.name, func(t *testing.T) {
				before := store.reads.Load()
				req := httptest.NewRequest("GET", cfg.Server.PublicURL+cell.path, nil)
				req.Header.Set("Authorization", "Bearer "+token)
				decisions := []string{}
				req = req.WithContext(services.WithAuthorizationObserver(req.Context(), func(command string) { decisions = append(decisions, command) }))
				out := httptest.NewRecorder()
				router.ServeHTTP(out, req)
				require.Equal(t, cell.status, out.Code, out.Body.String())
				require.Equal(t, []string{"todo.read"}, decisions)
				if cell.status == 200 {
					require.Equal(t, payload, out.Body.String())
					require.Equal(t, before+1, store.reads.Load())
				} else {
					require.Equal(t, before, store.reads.Load())
					require.NotContains(t, out.Body.String(), payload)
				}
			})
		}
	}
	for _, mutation := range []struct{ name, sql string }{
		{"attempt", `UPDATE mythical_items SET attempt=3 WHERE repository_id=$1 AND number=1`},
		{"run", `UPDATE mythical_items SET request_run_id='replacement-run' WHERE repository_id=$1 AND number=1`},
		{"sponsor", fmt.Sprintf(`UPDATE mythical_items SET owner_id=%d WHERE repository_id=$1 AND number=1`, f.other.ID)},
	} {
		t.Run("current "+mutation.name+" changes after admission", func(t *testing.T) {
			t.Cleanup(func() {
				_, err := f.pool.Exec(f.ctx, `UPDATE mythical_items SET attempt=2,request_run_id='log-run-0',owner_id=$2 WHERE repository_id=$1 AND number=1`, f.repoID, f.owner.ID)
				require.NoError(t, err)
			})
			scopes := "read:repository," + middleware.RepositoryRestrictionScope(f.repoID) + "," + middleware.LandingWorkspaceScope(workspaces[0].ID) + "," + middleware.AgentSessionRestrictionScope("log-run-0")
			token := f.token(f.owner, "log-stale-"+mutation.name, scopes, true)
			hash := sha256.Sum256([]byte(token))
			tokenHash := hex.EncodeToString(hash[:])
			stored, err := f.q.GetAuthInfoByTokenHash(f.ctx, tokenHash)
			require.NoError(t, err)
			info := &middleware.AuthInfo{User: &f.owner, IsTokenAuth: true, TokenSystemIssued: true, TokenID: stored.TokenID, TokenHash: tokenHash, RawScopes: scopes, Scopes: middleware.ParseTokenScopes(scopes)}
			ctx := middleware.ContextWithAuthInfo(f.ctx, info)
			count := 0
			ctx = services.WithAuthorizationObserver(ctx, func(string) { count++ })
			subject := services.InstallSubject{RepositoryID: f.repoID, TodoNumber: 1, Attempt: 2, PayloadDigest: digest}
			decision, err := services.Authorize(ctx, f.q, "todo.read", subject)
			require.NoError(t, err)
			ctx = services.WithInstallAuthorization(ctx, "todo.read", decision, subject)
			_, err = f.pool.Exec(f.ctx, mutation.sql, f.repoID)
			require.NoError(t, err)
			before := store.reads.Load()
			data, err := service.TodoLog(ctx, f.repoID, 1, 2, digest)
			var refusal *services.AccessError
			require.ErrorAs(t, err, &refusal)
			require.Equal(t, 403, refusal.Status)
			require.Nil(t, data)
			require.Equal(t, before, store.reads.Load())
			require.Equal(t, 1, count)
		})

	}
}
