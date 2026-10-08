package compose

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/flowhost"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/process"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// The qualified guest writer has not landed (microsandbox/files_compare_write.go).
// Its existing test-only contract fake isolates admission; this is not evidence
// of a working install write or qualification of guest atomicity/isolation.
type coeditControlledRuntime struct {
	*restoreRuntimeFixture
	before func(context.Context) error
}

func (r *coeditControlledRuntime) CompareWriteFiles(ctx context.Context, id string, changes []workspaceapi.FileMutation) (*workspaceapi.FileWriteResult, error) {
	if r.before != nil {
		if err := r.before(ctx); err != nil {
			return nil, err
		}
	}
	return r.restoreRuntimeFixture.CompareWriteFiles(ctx, id, changes)
}

func TestInstallSourceCoeditAdmissionPostgres(t *testing.T) {
	testInstallSourceCoeditAdmissionPostgres(t)
}

func testInstallSourceCoeditAdmissionPostgres(t *testing.T) map[string]any {
	f := newLandingGateFixtureWithFactory(t, nil, "", true)
	ws, err := f.q.CreateWorkspace(f.ctx, db.CreateWorkspaceParams{RepositoryID: f.repoID, UserID: f.other.ID, Name: "coedit", Kind: "container", Status: "running", TargetBookmark: "smithers/coedit"})
	require.NoError(t, err)
	_, err = f.pool.Exec(f.ctx, `UPDATE workspaces SET vm_id='fixture' WHERE id=$1`, ws.ID)
	require.NoError(t, err)
	var item pgtype.UUID
	var number int64
	require.NoError(t, f.pool.QueryRow(f.ctx, `INSERT INTO mythical_items(repository_id,source,state,stack_position,title,workspace_id,request_run_id,owner_id,created_by,attempt) VALUES($1,'todo','running',1,'Co-edit',$2,'coedit-run',$3,$3,1) RETURNING id,number`, f.repoID, ws.ID, f.other.ID).Scan(&item, &number))
	_, _, err = f.q.BindMythicalLane(f.ctx, db.MythicalLane{RepositoryID: f.repoID, WorkspaceID: ws.ID, ItemID: item, Name: "coedit"})
	require.NoError(t, err)
	runtime, err := process.New(process.Config{Root: t.TempDir()})
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, runtime.Close()) })
	provider := &coeditControlledRuntime{restoreRuntimeFixture: &restoreRuntimeFixture{writeReplyRuntime: &writeReplyRuntime{Runtime: runtime, repo: f.repoID, clone: "http://fixture/gate-owner/app.git"}, branch: ws.ID, bookmark: ws.TargetBookmark, files: map[string][]byte{}}}
	service := services.NewWorkspaceService(f.q, services.WithWorkspaceInstallAuthorization(f.q), services.WithWorkspaceRuntime(provider), services.WithWorkspaceTransactions(f.pool), services.WithWorkspaceGitBaseURL("http://fixture"))
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Auth.SessionCookieName = "session"
	cfg.Server.PublicURL = "http://example.com"
	cfg.Server.AllowedOrigins = []string{cfg.Server.PublicURL}
	router := githubAppSetupComposeRouter(cfg, f.pool, nil, &routes.WorkspaceHandler{Service: service})
	cookie := "coedit-member"
	sum := sha256.Sum256([]byte(cookie))
	_, err = f.q.CreateAuthSession(f.ctx, db.CreateAuthSessionParams{UserID: f.other.ID, Username: f.other.Username, SessionKey: hex.EncodeToString(sum[:]), ExpiresAt: time.Now().Add(time.Hour)})
	require.NoError(t, err)
	external := f.token(f.other, "coedit-external", "write:repository,via:codex", true)
	app := f.token(f.other, "coedit-app", "write:repository,via:smithers,terminal-session:"+liveAppTurnCredentialFixture(t, f.pool, f.other.ID)+"/1", true)
	runScopes := "write:repository," + middleware.RepositoryRestrictionScope(f.repoID) + "," + middleware.LandingWorkspaceScope(ws.ID) + "," + middleware.AgentSessionRestrictionScope("coedit-run")
	run := f.token(f.other, "coedit-run", runScopes, true)
	machine := f.token(f.other, "coedit-machine", "write:repository,"+middleware.RepositoryRestrictionScope(f.repoID)+","+middleware.WorkspaceRestrictionScope(ws.ID), true)
	call := func(bearer, path, body string, status, decisions int) {
		t.Helper()
		before := provider.writes
		req := httptest.NewRequest("PUT", cfg.Server.PublicURL+"/api/repos/gate-owner/app/workspaces/"+path+"/files/content", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Origin", cfg.Server.PublicURL)
		req.Header.Set("Smithers-Actor", "person")
		req.Header.Set("Smithers-Via", "smithers")
		if bearer == "" {
			req.AddCookie(&http.Cookie{Name: "session", Value: cookie})
			req.AddCookie(&http.Cookie{Name: "__csrf", Value: "coedit-csrf"})
			req.Header.Set("X-CSRF-Token", "coedit-csrf")
		} else {
			req.Header.Set("Authorization", "Bearer "+bearer)
		}
		var commands []string
		req = req.WithContext(services.WithAuthorizationObserver(req.Context(), func(command string) { commands = append(commands, command) }))
		out := httptest.NewRecorder()
		router.ServeHTTP(out, req)
		require.Equal(t, status, out.Code, out.Body.String())
		require.Len(t, commands, decisions)
		if decisions == 1 {
			require.Equal(t, "flow.source-coedit", commands[0])
		}
		if status == 200 {
			require.Equal(t, before+1, provider.writes)
		} else {
			require.Equal(t, before, provider.writes)
			if status == 403 {
				require.Contains(t, out.Body.String(), `"code":"permission"`)
			}
		}
	}
	for i, actor := range []struct {
		name, bearer string
		status       int
	}{{"member", "", 200}, {"external", external, 200}, {"app", app, 403}, {"own run", run, 200}, {"machine", machine, 403}, {"read only", f.token(f.other, "coedit-read", "read:repository,via:codex", true), 403}} {
		t.Run(actor.name, func(t *testing.T) {
			body := fmt.Sprintf(`{"changes":[{"path":"src/%d","base_digest":"absent","content":"owned edit"}]}`, i)
			call(actor.bearer, ws.ID, body, actor.status, 1)
			if actor.status == 200 {
				require.Equal(t, []byte("owned edit"), provider.files[fmt.Sprintf("src/%d", i)])
			}
		})
	}
	call(run, "11111111-1111-4111-8111-111111111111", `{"changes":[{"path":"src/other","base_digest":"absent","content":"no"}]}`, 403, 1)
	for _, body := range []string{`{"changes":[]}`, `{"changes":[{"path":"../escape","base_digest":"absent","content":"no"}]}`, `{"changes":[{"path":"a","base_digest":"absent","content":"no"},{"path":"a","base_digest":"absent","content":"no"}]}`} {
		call(run, ws.ID, body, 400, 0)
	}

	for _, cancelWrite := range []bool{false, true} {
		t.Run(fmt.Sprintf("credential fence cancellation=%v", cancelWrite), func(t *testing.T) {
			sum := sha256.Sum256([]byte(run))
			hash := hex.EncodeToString(sum[:])
			stored, err := f.q.GetAuthInfoByTokenHash(f.ctx, hash)
			require.NoError(t, err)
			info := &middleware.AuthInfo{User: &f.other, IsTokenAuth: true, TokenSystemIssued: true, TokenID: stored.TokenID, TokenHash: hash, RawScopes: runScopes, Scopes: middleware.ParseTokenScopes(runScopes)}
			ctx, cancel := context.WithCancel(middleware.ContextWithAuthInfo(f.ctx, info))
			defer cancel()
			entered, release := make(chan struct{}), make(chan struct{})
			defer func() { provider.before = nil }()
			provider.before = func(ctx context.Context) error {
				close(entered)
				select {
				case <-release:
					return nil
				case <-ctx.Done():
					return ctx.Err()
				}
			}
			done := make(chan error, 1)
			before := provider.writes
			go func() {
				_, err := service.WriteWorkspaceFiles(ctx, ws.ID, f.repoID, f.other.ID, []workspaceapi.FileMutation{{Path: fmt.Sprintf("src/serialized-%v", cancelWrite), BaseDigest: "absent", Content: []byte("serialized")}})
				done <- err
			}()
			select {
			case <-entered:
			case err := <-done:
				t.Fatalf("write did not reach provider: %v", err)
			case <-time.After(5 * time.Second):
				t.Fatal("write did not reach provider")
			}
			timeout, stop := context.WithTimeout(f.ctx, 150*time.Millisecond)
			_, err = f.pool.Exec(timeout, `UPDATE access_tokens SET expires_at=now()-interval '1 second' WHERE id=$1`, stored.TokenID)
			stop()
			require.Error(t, err, "revocation waits for an already admitted write")
			if cancelWrite {
				cancel()
			} else {
				close(release)
			}
			select {
			case err = <-done:
			case <-time.After(5 * time.Second):
				t.Fatal("write did not settle")
			}
			if cancelWrite {
				require.Error(t, err)
				require.Equal(t, before, provider.writes)
			} else {
				require.NoError(t, err)
				require.Equal(t, before+1, provider.writes)
			}
			update, stop := context.WithTimeout(f.ctx, 2*time.Second)
			defer stop()
			_, err = f.pool.Exec(update, `UPDATE access_tokens SET expires_at=now()+interval '1 hour' WHERE id=$1`, stored.TokenID)
			require.NoError(t, err, "settlement releases the credential fence")
		})
	}
	t.Run("bound payload and live authority", func(t *testing.T) {
		sum := sha256.Sum256([]byte(run))
		hash := hex.EncodeToString(sum[:])
		stored, err := f.q.GetAuthInfoByTokenHash(f.ctx, hash)
		require.NoError(t, err)
		info := &middleware.AuthInfo{User: &f.other, IsTokenAuth: true, TokenSystemIssued: true, TokenID: stored.TokenID, TokenHash: hash, RawScopes: runScopes, Scopes: middleware.ParseTokenScopes(runScopes)}
		for _, change := range []string{"payload", "expired", "sponsor"} {
			t.Run(change, func(t *testing.T) {
				calls := 0
				ctx := services.WithAuthorizationObserver(middleware.ContextWithAuthInfo(f.ctx, info), func(string) { calls++ })
				batch := []workspaceapi.FileMutation{{Path: "src/direct", BaseDigest: "absent", Content: []byte("bound")}}
				encoded, err := json.Marshal(batch)
				require.NoError(t, err)
				digest := sha256.Sum256(encoded)
				subject, err := services.InstallExecutionFileSubject(ctx, f.q, f.repoID, ws.ID)
				require.NoError(t, err)
				subject.PayloadDigest = hex.EncodeToString(digest[:])
				decision, err := services.Authorize(ctx, f.q, "flow.source-coedit", subject)
				require.NoError(t, err)
				bound := services.WithInstallAuthorization(ctx, "flow.source-coedit", decision, subject)
				status := 403
				switch change {
				case "payload":
					batch[0].Content = []byte("substituted")
				case "expired":
					status = 401
					_, err = f.pool.Exec(f.ctx, `UPDATE access_tokens SET expires_at=now()-interval '1 second' WHERE id=$1`, stored.TokenID)
					require.NoError(t, err)
					t.Cleanup(func() {
						_, err := f.pool.Exec(f.ctx, `UPDATE access_tokens SET expires_at=now()+interval '1 hour' WHERE id=$1`, stored.TokenID)
						require.NoError(t, err)
					})
				case "sponsor":
					_, err = f.pool.Exec(f.ctx, `UPDATE mythical_items SET request_run_id='another' WHERE id=$1`, item)
					require.NoError(t, err)
					t.Cleanup(func() {
						_, err := f.pool.Exec(f.ctx, `UPDATE mythical_items SET request_run_id='coedit-run' WHERE id=$1`, item)
						require.NoError(t, err)
					})
				}
				before := provider.writes
				_, err = service.WriteWorkspaceFiles(bound, ws.ID, f.repoID, f.other.ID, batch)
				var denied *services.AccessError
				require.ErrorAs(t, err, &denied)
				require.Equal(t, status, denied.Status)
				require.Equal(t, before, provider.writes)
				require.Equal(t, 1, calls)
			})
		}
	})

	t.Run("restore refuses actor substitution", func(t *testing.T) {
		versions := &restoreVersionFixture{}
		restore := services.NewWorkspaceService(f.q, services.WithWorkspaceInstallAuthorization(f.q), services.WithWorkspaceBurstVersions(f.pool, versions))
		decisions := 0
		ctx := services.WithAuthorizationObserver(middleware.ContextWithAuthInfo(f.ctx, &middleware.AuthInfo{User: &f.other, SessionHash: hex.EncodeToString(sum[:])}), func(command string) {
			require.Equal(t, "file.restore", command)
			decisions++
		})
		_, err := restore.RestoreBranchFile(ctx, ws.ID, f.repoID, f.owner.ID, "src/actor", strings.Repeat("a", 40), "absent", false)
		var denied *services.AccessError
		require.ErrorAs(t, err, &denied)
		require.Equal(t, 403, denied.Status)
		require.Equal(t, 1, decisions)
		require.Zero(t, versions.calls)
	})
	t.Run("issuer-only coding host batch", func(t *testing.T) {
		codec, err := newSecretCodec(config.WebhookConfig{SecretEncryptionKey: "coedit-host-fixture"})
		require.NoError(t, err)
		hosts, err := flowhost.NewStore(f.pool, codec)
		require.NoError(t, err)
		lease, err := hosts.Acquire(f.ctx, flowhost.Authority{
			Target:       flowruntime.Target{TenantID: fmt.Sprintf("repository:%d", f.repoID), PrincipalID: fmt.Sprintf("user:%d", f.other.ID), BindingKind: "browser-flow", BindingID: "gate-owner/app"},
			RepositoryID: f.repoID, UserID: f.other.ID, WorkspaceID: ws.ID, CatalogKey: flowhost.CatalogCoding, SourceRevision: strings.Repeat("a", 40),
		}, flowhost.Catalog{Key: flowhost.CatalogCoding, Family: flowhost.CatalogCoding, Executable: "/opt/smithers/coding", ArtifactDigest: strings.Repeat("b", 64), ServiceName: "coding", SystemFlows: []string{"coding/plan"}})
		require.NoError(t, err)
		_, err = lease.PrepareStart(f.ctx, false)
		require.NoError(t, err)
		require.NoError(t, lease.MarkRunning(f.ctx, "coedit-fixture-host"))
		host, credential := lease.Binding().ID, lease.Credential()
		require.NoError(t, lease.Close())
		auth := services.NewAuthService(f.q, cfg.Auth, nil, nil)
		auth.Members = &services.Members{Pool: f.pool}
		issuer := services.NewCodingFileCredentials(auth, services.NewFlowHostCallbacks(f.pool, f.q), service)
		body := `{"changes":[{"path":"src/host","base_digest":"absent","content":"host edit"}]}`
		digest := sha256.Sum256([]byte(body))
		grant, err := issuer.Mint(f.ctx, host, credential, services.CodingFileGrantInput{RunID: "coding/host@1", BatchDigest: hex.EncodeToString(digest[:])})
		require.NoError(t, err)
		call(grant.Token, ws.ID, body+" ", 403, 0)
		call(grant.Token, "11111111-1111-4111-8111-111111111111", body, 403, 0)
		call(grant.Token, ws.ID, body, 200, 1)
		_, err = f.pool.Exec(f.ctx, `UPDATE flow_runtime_host_bindings SET state='failed' WHERE id=$1::uuid`, host)
		require.NoError(t, err)
		call(grant.Token, ws.ID, body, 403, 1)
		_, err = f.pool.Exec(f.ctx, `UPDATE flow_runtime_host_bindings SET state='running' WHERE id=$1::uuid`, host)
		require.NoError(t, err)
		_, err = f.pool.Exec(f.ctx, `UPDATE access_tokens SET name='forged-publisher' WHERE id=$1`, grant.TokenID)
		require.NoError(t, err)
		call(grant.Token, ws.ID, body, 403, 1)
		_, err = f.pool.Exec(f.ctx, `UPDATE access_tokens SET expires_at=now()-interval '1 second' WHERE id=$1`, grant.TokenID)
		require.NoError(t, err)
		call(grant.Token, ws.ID, body, 401, 0)
	})
	_, err = f.pool.Exec(f.ctx, `UPDATE mythical_items SET request_run_id='replacement' WHERE id=$1`, item)
	require.NoError(t, err)
	call(run, ws.ID, `{"changes":[{"path":"src/replaced","base_digest":"absent","content":"no"}]}`, 403, 1)
	runDigest := sha256.Sum256([]byte(run))
	return map[string]any{"credential_hash": hex.EncodeToString(runDigest[:]), "repository_id": f.repoID, "workspace_id": ws.ID, "todo_number": number, "run_id": "coedit-run", "attempt": 1, "transport": "controlled guest compare-write"}
}
