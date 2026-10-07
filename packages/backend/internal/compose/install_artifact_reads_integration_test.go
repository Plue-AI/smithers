package compose

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/internal/blob"
	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/stretchr/testify/require"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestInstallArtifactReadsPostgres(t *testing.T) {
	f := newLandingGateFixtureWithFactory(t, nil, "", true)
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Auth.SessionCookieName = "session"
	var handler http.Handler
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { handler.ServeHTTP(w, r) }))
	t.Cleanup(server.Close)
	cfg.Server.PublicURL = "http://example.com"
	cfg.Server.AllowedOrigins = []string{cfg.Server.PublicURL}
	store, err := blob.NewFilesystemStore(blob.FilesystemConfig{Root: t.TempDir(), PublicBaseURL: server.URL})
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, store.Close()) })
	router := buildInstallArtifactReadRouter(cfg, f.q, f.pool, nil, &routes.WorkflowArtifactHandler{Service: services.NewWorkflowArtifactService(f.q, store, time.Minute)})
	mux := http.NewServeMux()
	mux.Handle("/api/blob-transfer/", store.TransferHandler())
	mux.Handle("/", router)
	handler = mux
	run, err := f.q.CreateWorkflowRun(f.ctx, db.CreateWorkflowRunParams{RepositoryID: f.repoID, WorkflowDefinitionID: ciTestDefinition(t, f.q, f.repoID), Status: "success", TriggerEvent: "workflow_dispatch", TriggerRef: "refs/heads/main", DispatchInputs: []byte(`{}`)})
	require.NoError(t, err)
	payload := "Retained private artifact bytes"
	artifact, err := f.q.CreateWorkflowArtifact(f.ctx, db.CreateWorkflowArtifactParams{RepositoryID: f.repoID, WorkflowRunID: run.ID, Name: "report.txt", Size: int64(len(payload)), ContentType: "text/plain", ExpiresAt: time.Now().Add(time.Hour)})
	require.NoError(t, err)
	require.NoError(t, store.Put(f.ctx, artifact.GcsKey, "text/plain", strings.NewReader(payload)))
	_, err = f.pool.Exec(f.ctx, `UPDATE workflow_artifacts SET status='ready',confirmed_at=now() WHERE id=$1`, artifact.ID)
	require.NoError(t, err)
	cookie := "artifact-member"
	sum := sha256.Sum256([]byte(cookie))
	_, err = f.q.CreateAuthSession(f.ctx, db.CreateAuthSessionParams{UserID: f.other.ID, Username: f.other.Username, SessionKey: hex.EncodeToString(sum[:]), ExpiresAt: time.Now().Add(time.Hour)})
	require.NoError(t, err)
	actors := []struct {
		name, token string
		status      int
	}{
		{"member", "", 200},
		{"external", f.token(f.other, "artifact-external", "read:repository,write:repository,via:codex", true), 403},
		{"app", f.token(f.other, "artifact-app", "read:repository,write:repository,via:smithers,terminal-session:"+liveAppTurnCredentialFixture(t, f.pool, f.other.ID)+"/1", true), 200},
		{"run", f.token(f.owner, "artifact-run", "read:repository", true), 403},
		{"missing scope", f.token(f.other, "artifact-scope", "read:user,via:codex", true), 403},
	}
	for _, prefix := range []string{"runs/", "actions/runs/", "workflow/runs/"} {
		for _, download := range []bool{false, true} {
			suffix := ""
			if download {
				suffix = "/report.txt"
				if prefix != "workflow/runs/" {
					suffix += "/download"
				}
			}
			path := fmt.Sprintf("/api/repos/gate-owner/app/%s%d/artifacts%s", prefix, run.ID, suffix)
			for _, actor := range actors {
				t.Run(prefix+suffix+"/"+actor.name, func(t *testing.T) {
					req := httptest.NewRequest("GET", cfg.Server.PublicURL+path, nil)
					if actor.token == "" {
						req.AddCookie(&http.Cookie{Name: "session", Value: cookie})
					} else {
						req.Header.Set("Authorization", "Bearer "+actor.token)
					}
					var decisions []string
					req = req.WithContext(services.WithAuthorizationObserver(req.Context(), func(c string) { decisions = append(decisions, c) }))
					out := httptest.NewRecorder()
					router.ServeHTTP(out, req)
					require.Equal(t, actor.status, out.Code, out.Body.String())
					require.Equal(t, []string{"run.view"}, decisions)
					if actor.status != 200 {
						require.Contains(t, out.Body.String(), `"code":"permission"`)
						require.NotContains(t, out.Body.String(), artifact.Name)
						return
					}
					require.Contains(t, out.Body.String(), artifact.Name)
					if download {
						var result struct {
							URL string `json:"download_url"`
						}
						require.NoError(t, json.Unmarshal(out.Body.Bytes(), &result))
						resp, err := http.Get(result.URL)
						require.NoError(t, err)
						defer resp.Body.Close()
						body, err := io.ReadAll(resp.Body)
						require.NoError(t, err)
						require.Equal(t, 200, resp.StatusCode)
						require.Equal(t, payload, string(body))
					}
				})
			}
		}
	}
}

func buildInstallArtifactReadRouter(cfg *config.Config, q *db.Queries, pool *pgxpool.Pool, cache *routes.WorkflowCacheHandler, artifacts *routes.WorkflowArtifactHandler) http.Handler {
	return buildRouter(
		cfg, q, pool,
		&routes.RepoHandler{},
		nil, // mirrorSyncHandler
		&routes.AuthHandler{}, &routes.UserHandler{}, &routes.SSHKeyHandler{},
		nil, // deployKeyHandler
		&routes.LabelHandler{}, &routes.OrgHandler{}, &routes.LandingHandler{},
		nil, // buildCacheHandler
		nil, // stackHandler
		&routes.SearchHandler{Service: &mockRouterSearchService{}}, &routes.IssueHandler{},
		nil, // wikiService
		&routes.GitSmartHandler{Service: &mockRouterGitService{}},
		nil,                     // notificationHandler
		nil, nil, nil, nil, nil, // admin user/org/repo/github-app/audit
		nil, nil, nil, nil, nil, nil, nil, nil, // webhook, secret, provider, variable, billing, protected, status, lfs
		nil, // jjVCSHandler
		&routes.AgentInternalHandler{},
		nil, nil, nil, nil, nil, // agent sessions/stream, approvals, branch lock, push hook, workflow
		cache, artifacts,
		nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil,
	)
}

func TestInstallCacheMetadataReadsPostgres(t *testing.T) {
	f := newLandingGateFixtureWithFactory(t, nil, "", true)
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Auth.SessionCookieName = "session"
	cfg.Server.PublicURL = "http://example.com"
	cfg.Server.AllowedOrigins = []string{cfg.Server.PublicURL}
	store, err := blob.NewFilesystemStore(blob.FilesystemConfig{Root: t.TempDir(), PublicBaseURL: cfg.Server.PublicURL})
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, store.Close()) })
	router := buildInstallArtifactReadRouter(cfg, f.q, f.pool, &routes.WorkflowCacheHandler{Service: services.NewWorkflowCacheService(f.q, store, services.WorkflowCacheConfig{})}, nil)
	cache, err := f.q.UpsertPendingWorkflowCache(f.ctx, db.UpsertPendingWorkflowCacheParams{RepositoryID: f.repoID, BookmarkName: "main", CacheKey: "private-dependency-cache", CacheVersion: "v1", ObjectKey: "cache/retained", ObjectSizeBytes: 123, Compression: "zstd", ExpiresAt: time.Now().Add(time.Hour)})
	require.NoError(t, err)
	_, err = f.pool.Exec(f.ctx, `UPDATE workflow_caches SET status='finalized',finalized_at=now() WHERE id=$1`, cache.ID)
	require.NoError(t, err)
	cookie := "cache-member"
	sum := sha256.Sum256([]byte(cookie))
	_, err = f.q.CreateAuthSession(f.ctx, db.CreateAuthSessionParams{UserID: f.other.ID, Username: f.other.Username, SessionKey: hex.EncodeToString(sum[:]), ExpiresAt: time.Now().Add(time.Hour)})
	require.NoError(t, err)
	for _, actor := range []struct {
		name, token string
		status      int
	}{
		{"member", "", 200},
		{"external", f.token(f.other, "cache-external", "read:repository,via:codex", true), 200},
		{"app", f.token(f.other, "cache-app", "read:repository,via:smithers,terminal-session:"+liveAppTurnCredentialFixture(t, f.pool, f.other.ID)+"/1", true), 200},
		{"run", f.token(f.owner, "cache-run", "read:repository", true), 403},
		{"scope", f.token(f.other, "cache-scope", "read:user,via:codex", true), 403},
	} {
		for _, suffix := range []string{"", "/stats"} {
			t.Run(actor.name+suffix, func(t *testing.T) {
				req := httptest.NewRequest("GET", cfg.Server.PublicURL+"/api/repos/gate-owner/app/caches"+suffix, nil)
				if actor.token == "" {
					req.AddCookie(&http.Cookie{Name: "session", Value: cookie})
				} else {
					req.Header.Set("Authorization", "Bearer "+actor.token)
				}
				var decisions []string
				req = req.WithContext(services.WithAuthorizationObserver(req.Context(), func(c string) { decisions = append(decisions, c) }))
				out := httptest.NewRecorder()
				router.ServeHTTP(out, req)
				require.Equal(t, actor.status, out.Code, out.Body.String())
				require.Equal(t, []string{"repo.read"}, decisions)
				if actor.status == 200 {
					if suffix == "" {
						require.Contains(t, out.Body.String(), "private-dependency-cache")
					} else {
						require.Contains(t, out.Body.String(), "123")
					}
				} else {
					require.Contains(t, out.Body.String(), `"code":"permission"`)
					require.NotContains(t, out.Body.String(), "private-dependency-cache")
				}
			})
		}
	}
}
