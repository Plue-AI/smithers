package compose

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/identity"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
	"github.com/smithersai/smithers/packages/backend/repository"
	"github.com/stretchr/testify/require"
)

type accessNativeFileReads struct {
	*repohost.Client
	reads      atomic.Int64
	beforeRead func()
}

func (s *accessNativeFileReads) GetFileAtCommit(ctx context.Context, owner, repo, commit, path string) (repohost.FileContent, error) {
	s.reads.Add(1)
	if s.beforeRead != nil {
		s.beforeRead()
	}
	return s.Client.GetFileAtCommit(ctx, owner, repo, commit, path)
}

func TestInstallExecutionFileReadsPostgres(t *testing.T) {
	f := newLandingGateFixtureWithFactory(t, nil, "", true)
	storage := t.TempDir()
	engine, err := repository.OpenLocal(repository.Config{StoragePath: storage, AuthToken: "native-history", FFILibraryPath: os.Getenv("SMITHERS_FFI_LIBRARY_PATH"), InstallMainMirror: true})
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, engine.Shutdown(context.Background())) })
	client := engine.Client()
	require.NoError(t, client.InitRepo(f.ctx, "gate-owner", "app", "main", false))
	seed := t.TempDir()
	git := func(args ...string) string {
		t.Helper()
		cmd := exec.CommandContext(f.ctx, "git", args...)
		cmd.Env = append(os.Environ(), "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL="+os.DevNull)
		out, err := cmd.CombinedOutput()
		require.NoError(t, err, string(out))
		return strings.TrimSpace(string(out))
	}
	git("init", "-q", "--initial-branch=main", seed)
	require.NoError(t, os.WriteFile(filepath.Join(seed, "history.txt"), []byte("Recorded repository content\n"), 0600))
	git("-C", seed, "add", ".")
	git("-C", seed, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "Recorded revision")
	head := git("-C", seed, "rev-parse", "HEAD")
	git("-C", seed, "push", filepath.Join(storage, "gate-owner", "app", ".jj/repo/store/git"), "HEAD:refs/heads/main")
	require.NoError(t, client.ImportRefs(f.ctx, "gate-owner", "app"))

	machineOwner, err := f.q.GetBranchMachineOwner(f.ctx)
	require.NoError(t, err)
	ws, err := f.q.CreateWorkspace(f.ctx, db.CreateWorkspaceParams{RepositoryID: f.repoID, UserID: machineOwner, Name: "file-read", Kind: "container", Status: "suspended", TargetBookmark: "smithers/file-read"})
	require.NoError(t, err)
	_, err = f.pool.Exec(f.ctx, `UPDATE workspaces SET vm_id='retained-files',head_commit_id=$2 WHERE id=$1`, ws.ID, head)
	require.NoError(t, err)
	git("-C", seed, "push", filepath.Join(storage, "gate-owner", "app", ".jj/repo/store/git"), "HEAD:"+repohost.BranchHeadRef(ws.ID))
	require.NoError(t, client.ImportRefs(f.ctx, "gate-owner", "app"))
	var itemID pgtype.UUID
	var number int64
	require.NoError(t, f.pool.QueryRow(f.ctx, `INSERT INTO mythical_items(repository_id,source,state,stack_position,title,workspace_id,request_run_id,owner_id,created_by,attempt) VALUES($1,'todo','running',1,'Execution files',$2,'file-run',$3,$3,1) RETURNING id,number`, f.repoID, ws.ID, f.owner.ID).Scan(&itemID, &number))
	_, _, err = f.q.BindMythicalLane(f.ctx, db.MythicalLane{RepositoryID: f.repoID, WorkspaceID: ws.ID, ItemID: itemID, Name: "file-read"})
	require.NoError(t, err)
	store := &accessNativeFileReads{Client: client}
	service := services.NewWorkspaceService(f.q, services.WithWorkspaceInstallAuthorization(f.q), services.WithWorkspaceTransactions(f.pool), services.WithBranchMachineProviders(services.InstallBranchMachineProviders(identity.NewMemberBoundary(f.q), nil)), services.WithBranchHeads(store))
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Auth.SessionCookieName = "session"
	cfg.Server.PublicURL = "http://example.com"
	cfg.Server.AllowedOrigins = []string{cfg.Server.PublicURL}
	codec, err := webhook.NewSecretCodec("file-read-roster-test")
	require.NoError(t, err)
	credentials := services.NewGitHubAppCredentialStore(f.pool, codec)
	members := &services.Members{Pool: f.pool, Credentials: credentials, Minter: services.NewRepoConnectionService(f.pool, credentials)}
	todos := services.NewMythicalService(f.pool, client)
	todos.SetOrchestration(nil, nil, services.NewWorkspaceMythicalLanes(service))
	topics := &liveTopics{changePool: f.pool, queries: f.q, presence: &branchPresence{queries: f.q, members: members, branches: service}, members: members}
	router := githubAppSetupComposeRouter(cfg, f.pool, nil, &routes.WorkspaceHandler{Service: service}, routerExtras{Members: &routes.MembersHandler{Service: members}, Mythical: &routes.MythicalHandler{Service: todos}, Live: &routes.LiveHandler{Queries: f.q, Topics: topics.resolver}})
	scopes := "read:repository," + middleware.RepositoryRestrictionScope(f.repoID) + "," + middleware.LandingWorkspaceScope(ws.ID) + "," + middleware.AgentSessionRestrictionScope("file-run")
	own := f.token(f.owner, "file-own-run", scopes, true)
	machine := f.token(f.owner, "file-machine", "read:repository,"+middleware.RepositoryRestrictionScope(f.repoID)+","+middleware.WorkspaceRestrictionScope(ws.ID), true)
	// Members and delegated readers use the same branch-read command for
	// retained workspace metadata and files, without waking the machine.
	memberCookie := "retained-workspace-member"
	memberSum := sha256.Sum256([]byte(memberCookie))
	_, err = f.q.CreateAuthSession(f.ctx, db.CreateAuthSessionParams{UserID: f.other.ID, Username: f.other.Username, SessionKey: hex.EncodeToString(memberSum[:]), ExpiresAt: time.Now().Add(time.Hour)})
	require.NoError(t, err)
	t.Run("member session reads another member's repository work", func(t *testing.T) {
		alice, err := f.q.CreateUser(f.ctx, db.CreateUserParams{Username: "alice", LowerUsername: "alice"})
		require.NoError(t, err)
		_, err = f.pool.Exec(f.ctx, `INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,'write')`, f.repoID, alice.ID)
		require.NoError(t, err)
		_, err = f.pool.Exec(f.ctx, `UPDATE mythical_items SET owner_id=$2,base_commit=$3 WHERE id=$1`, itemID, alice.ID, head)
		require.NoError(t, err)
		defer func() {
			_, err := f.pool.Exec(f.ctx, `UPDATE mythical_items SET owner_id=$2 WHERE id=$1`, itemID, f.owner.ID)
			require.NoError(t, err)
		}()
		for _, path := range []string{"/api/todos", "/api/todos/" + fmt.Sprint(number), "/api/repos/gate-owner/app/workspaces/" + ws.ID + "/files", "/api/branches/" + ws.ID + "/files/history.txt", "/api/branches/" + ws.ID + "/diff", "/api/branches/" + ws.ID + "/activity"} {
			t.Run(path, func(t *testing.T) {
				req := httptest.NewRequest("GET", cfg.Server.PublicURL+path, nil)
				req.AddCookie(&http.Cookie{Name: "session", Value: memberCookie})
				out := httptest.NewRecorder()
				router.ServeHTTP(out, req)
				require.Equal(t, 200, out.Code, out.Body.String())
			})
		}
	})
	for _, reader := range []struct{ name, token string }{
		{"member", ""},
		{"external", f.token(f.other, "retained-workspace-external", "read:repository,via:codex", true)},
		{"app", f.token(f.other, "retained-workspace-app", "read:repository,via:smithers,terminal-session:"+liveAppTurnCredentialFixture(t, f.pool, f.other.ID)+"/1", true)},
	} {
		for _, suffix := range []string{"", "/files", "/files/content?path=history.txt"} {
			t.Run(reader.name+" retained workspace"+suffix, func(t *testing.T) {
				req := httptest.NewRequest("GET", cfg.Server.PublicURL+"/api/repos/gate-owner/app/workspaces/"+ws.ID+suffix, nil)
				if reader.token == "" {
					req.AddCookie(&http.Cookie{Name: "session", Value: memberCookie})
				} else {
					req.Header.Set("Authorization", "Bearer "+reader.token)
				}
				var decisions []string
				req = req.WithContext(services.WithAuthorizationObserver(req.Context(), func(command string) { decisions = append(decisions, command) }))
				out := httptest.NewRecorder()
				router.ServeHTTP(out, req)
				require.Equal(t, 200, out.Code, out.Body.String())
				require.Equal(t, []string{"branch.read"}, decisions)
				if suffix == "" {
					require.Contains(t, out.Body.String(), ws.ID)
				} else {
					require.Contains(t, out.Body.String(), "history.txt")
				}
				stored, err := f.q.GetWorkspace(f.ctx, ws.ID)
				require.NoError(t, err)
				require.Equal(t, "suspended", stored.Status)
			})
		}
	}
	otherRun := f.token(f.owner, "file-other-run", strings.Replace(scopes, "file-run", "other-run", 1), true)
	unbound := f.token(f.owner, "file-unbound", "read:repository", true)
	children := f.token(f.owner, "file-children", "read:repository,read:workspace,write:workspace,"+middleware.RepositoryRestrictionScope(f.repoID)+","+middleware.WorkspaceRestrictionScope(ws.ID)+","+middleware.WorkspaceChildrenCredentialScope(), true)
	otherWS, err := f.q.CreateWorkspace(f.ctx, db.CreateWorkspaceParams{RepositoryID: f.repoID, UserID: machineOwner, Name: "other-files", Kind: "container", Status: "suspended", TargetBookmark: "smithers/other"})
	require.NoError(t, err)
	foreignDelegate := f.token(f.other, "file-foreign-delegation", "read:repository,via:codex,branch:"+otherWS.ID, true)
	readUser := f.token(f.other, "file-insufficient-scope", "read:user,via:codex", true)
	for _, suffix := range []string{"", "/files", "/files/content?path=history.txt"} {
		t.Run("delegation bound elsewhere"+suffix, func(t *testing.T) {
			before := store.reads.Load()
			req := httptest.NewRequest("GET", cfg.Server.PublicURL+"/api/repos/gate-owner/app/workspaces/"+ws.ID+suffix, nil)
			req.Header.Set("Authorization", "Bearer "+foreignDelegate)
			var decisions []string
			req = req.WithContext(services.WithAuthorizationObserver(req.Context(), func(command string) { decisions = append(decisions, command) }))
			out := httptest.NewRecorder()
			router.ServeHTTP(out, req)
			require.Equal(t, 403, out.Code, out.Body.String())
			require.Contains(t, out.Body.String(), `"code":"permission"`)
			require.Equal(t, []string{"branch.read"}, decisions)
			require.Equal(t, before, store.reads.Load())
		})
	}
	for _, actor := range []struct {
		name, token string
		status      int
	}{{"unknown run profile", f.token(f.owner, "unknown-run-profile", scopes+",profile:unknown", true), 403},
		{"unknown run kind", f.token(f.owner, "unknown-run-kind", scopes+",credential:unknown", true), 403},
		{"unknown machine profile", f.token(f.owner, "unknown-machine-profile", "read:repository,"+middleware.RepositoryRestrictionScope(f.repoID)+","+middleware.WorkspaceRestrictionScope(ws.ID)+",profile:unknown", true), 403},
		{"unknown machine kind", f.token(f.owner, "unknown-machine-kind", "read:repository,"+middleware.RepositoryRestrictionScope(f.repoID)+","+middleware.WorkspaceRestrictionScope(ws.ID)+",credential:unknown", true), 403},
		{"unknown delegated profile", f.token(f.other, "unknown-delegated-profile", "read:repository,via:codex,profile:unknown", true), 403},
		{"run", own, 200}, {"machine", machine, 200}, {"other run", otherRun, 403}, {"unbound", unbound, 403}, {"children", children, 403}, {"insufficient scope", readUser, 403}} {
		for _, door := range []struct {
			name, path string
			own        bool
		}{{"list", "/api/repos/gate-owner/app/workspaces/" + ws.ID + "/files", true}, {"canonical list", "/api/branches/" + ws.ID + "/files", true}, {"canonical file", "/api/branches/" + ws.ID + "/files/history.txt", true}, {"named file", "/api/branches/" + url.PathEscape(ws.TargetBookmark) + "/files/history.txt", true}, {"canonical other", "/api/branches/" + otherWS.ID + "/files/history.txt", false}, {"historical at", "/api/branches/" + ws.ID + "/files/history.txt?at=" + head, false}, {"historical digest", "/api/branches/" + ws.ID + "/files/history.txt?digest=absent", false}, {"historical compare", "/api/branches/" + ws.ID + "/files/history.txt?compare=main", false}, {"file", "/api/repos/gate-owner/app/workspaces/" + ws.ID + "/files/content?path=history.txt", true}, {"other", "/api/repos/gate-owner/app/workspaces/" + otherWS.ID + "/files/content?path=history.txt", false}, {"retained branch", "/api/repos/gate-owner/app/workspaces/" + ws.ID, false}, {"branch card", "/api/branches/" + ws.ID, false}, {"main file", "/api/branches/main/files/history.txt", false}} {
			t.Run(actor.name+"/"+door.name, func(t *testing.T) {
				status := actor.status
				if !door.own {
					status = 403
				}
				before := store.reads.Load()
				var decisions []string
				req := httptest.NewRequest("GET", cfg.Server.PublicURL+door.path, nil)
				req.Header.Set("Authorization", "Bearer "+actor.token)
				req = req.WithContext(services.WithAuthorizationObserver(req.Context(), func(command string) { decisions = append(decisions, command) }))
				out := httptest.NewRecorder()
				router.ServeHTTP(out, req)
				require.Equal(t, status, out.Code, out.Body.String())
				require.Equal(t, []string{"branch.read"}, decisions)
				if status == 200 {
					require.Contains(t, out.Body.String(), "history.txt")
					require.Greater(t, store.reads.Load(), before)
					if strings.HasSuffix(door.name, "file") {
						require.Contains(t, out.Body.String(), "Recorded repository content")
					}
				} else {
					require.Equal(t, before, store.reads.Load())
					require.Contains(t, out.Body.String(), `"code":"permission"`)
				}
			})
		}
	}
	t.Run("production issuer replaces current run", func(t *testing.T) {
		// Issuance and HTTP/native file reads are real. Only the source
		// publisher's guest transport uses the existing controlled fixture.
		_, err := f.pool.Exec(f.ctx, `UPDATE workspaces SET user_id=$2,status='running' WHERE id=$1`, ws.ID, f.owner.ID)
		require.NoError(t, err)
		defer func() {
			_, err := f.pool.Exec(f.ctx, `UPDATE workspaces SET user_id=$2,status='suspended' WHERE id=$1`, ws.ID, machineOwner)
			require.NoError(t, err)
			_, err = f.pool.Exec(f.ctx, `UPDATE mythical_items SET request_run_id='file-run',attempt=1 WHERE id=$1`, itemID)
			require.NoError(t, err)
		}()
		issuer := services.NewWorkspaceService(f.q, services.WithWorkspaceInstallAuthorization(f.q), services.WithWorkspaceTransactions(f.pool), services.WithWorkspaceRuntime(&candidatePublisherRuntime{}), services.WithWorkspaceGitBaseURL("http://127.0.0.1:47199"))
		issue := func() string {
			t.Helper()
			_, err := f.pool.Exec(f.ctx, `UPDATE workspaces SET status='running' WHERE id=$1`, ws.ID)
			require.NoError(t, err)
			environment, err := issuer.PrepareBoxHost(f.ctx, "file-read-host", ws.ID, f.repoID, f.owner.ID)
			require.NoError(t, err)
			token := environment["SMITHERS_JJHUB_TOKEN"]
			require.NotEmpty(t, token)
			// Retained source reads use native repository bytes, without a guest.
			_, err = f.pool.Exec(f.ctx, `UPDATE workspaces SET status='suspended' WHERE id=$1`, ws.ID)
			require.NoError(t, err)
			return token
		}
		read := func(token, workspace string, status int, commands []string) {
			t.Helper()
			req := httptest.NewRequest("GET", cfg.Server.PublicURL+"/api/branches/"+workspace+"/files/history.txt", nil)
			req.Header.Set("Authorization", "Bearer "+token)
			var decisions []string
			req = req.WithContext(services.WithAuthorizationObserver(req.Context(), func(command string) { decisions = append(decisions, command) }))
			before := store.reads.Load()
			out := httptest.NewRecorder()
			router.ServeHTTP(out, req)
			require.Equal(t, status, out.Code, out.Body.String())
			require.Equal(t, commands, decisions)
			if status == 200 {
				require.Contains(t, out.Body.String(), "Recorded repository content")
			} else {
				require.NotContains(t, out.Body.String(), "Recorded repository content")
				require.Equal(t, before, store.reads.Load())
			}
		}
		old := issue()
		defer issuer.RetireBoxHostCredential(f.ctx, "file-read-host", f.owner.ID)
		read(old, ws.ID, 200, []string{"branch.read"})
		read(old, otherWS.ID, 403, []string{"branch.read"})
		_, err = f.pool.Exec(f.ctx, `UPDATE mythical_items SET request_run_id='replacement-file-run',attempt=2 WHERE id=$1`, itemID)
		require.NoError(t, err)
		read(old, ws.ID, 403, []string{"branch.read"})
		fresh := issue()
		require.NotEqual(t, old, fresh)
		read(old, ws.ID, 401, nil)
		read(fresh, ws.ID, 200, []string{"branch.read"})
	})
	for _, change := range []struct {
		name, sql string
		status    int
	}{{"sponsor", fmt.Sprintf(`UPDATE mythical_items SET owner_id=%d WHERE id=$1`, f.other.ID), 403}, {"run", `UPDATE mythical_items SET request_run_id='replacement' WHERE id=$1`, 403}, {"workspace", fmt.Sprintf(`UPDATE mythical_items SET workspace_id='%s' WHERE id=$1`, otherWS.ID), 403}, {"todo identity", `UPDATE mythical_items SET number=number+1000 WHERE id=$1`, 403}, {"expired", "", 401}} {
		t.Run("bound read after "+change.name, func(t *testing.T) {
			token := f.token(f.owner, "file-stale-"+change.name, scopes, true)
			sum := sha256.Sum256([]byte(token))
			hash := hex.EncodeToString(sum[:])
			row, err := f.q.GetAuthInfoByTokenHash(f.ctx, hash)
			require.NoError(t, err)
			info := &middleware.AuthInfo{User: &f.owner, IsTokenAuth: true, TokenSystemIssued: true, TokenID: row.TokenID, TokenHash: hash, RawScopes: scopes, Scopes: middleware.ParseTokenScopes(scopes)}
			ctx := middleware.ContextWithAuthInfo(f.ctx, info)
			count := 0
			ctx = services.WithAuthorizationObserver(ctx, func(string) { count++ })
			subject, err := services.InstallExecutionFileSubject(ctx, f.q, f.repoID, ws.ID)
			require.NoError(t, err)
			decision, err := services.Authorize(ctx, f.q, "branch.read", subject)
			require.NoError(t, err)
			ctx = services.WithInstallAuthorization(ctx, "branch.read", decision, subject)
			if change.sql != "" {
				_, err = f.pool.Exec(f.ctx, change.sql, itemID)
			} else {
				_, err = f.pool.Exec(f.ctx, `UPDATE access_tokens SET expires_at=NOW()-INTERVAL '1 minute' WHERE id=$1`, row.TokenID)
			}
			require.NoError(t, err)
			t.Cleanup(func() {
				_, err := f.pool.Exec(f.ctx, `UPDATE mythical_items SET owner_id=$2,workspace_id=$3,request_run_id='file-run',number=$4 WHERE id=$1`, itemID, f.owner.ID, ws.ID, number)
				require.NoError(t, err)
			})
			before := store.reads.Load()
			file, err := service.ReadWorkspaceFile(ctx, ws.ID, f.repoID, f.owner.ID, "history.txt")
			var refusal *services.AccessError
			require.ErrorAs(t, err, &refusal)
			require.Equal(t, change.status, refusal.Status)
			require.Empty(t, file.Content)
			require.Equal(t, before, store.reads.Load())
			require.Equal(t, 1, count)
		})
	}
	for _, spelling := range []string{"workspace", "branch"} {
		t.Run("member suspension serializes after admitted bytes/"+spelling, func(t *testing.T) {
			_, err := f.pool.Exec(f.ctx, `UPDATE mythical_items SET owner_id=$2 WHERE id=$1`, itemID, f.other.ID)
			require.NoError(t, err)
			t.Cleanup(func() {
				_, err := f.pool.Exec(f.ctx, `UPDATE mythical_items SET owner_id=$2 WHERE id=$1`, itemID, f.owner.ID)
				require.NoError(t, err)
				_, err = f.pool.Exec(f.ctx, `UPDATE collaborators SET suspended_at=NULL WHERE repository_id=$1 AND user_id=$2`, f.repoID, f.other.ID)
				require.NoError(t, err)
			})
			token := f.token(f.other, "file-member-serial-"+spelling, scopes, true)
			cookie := "suspended-file-member-" + spelling
			sum := sha256.Sum256([]byte(cookie))
			_, err = f.q.CreateAuthSession(f.ctx, db.CreateAuthSessionParams{UserID: f.other.ID, Username: f.other.Username, SessionKey: hex.EncodeToString(sum[:]), ExpiresAt: time.Now().Add(time.Hour)})
			require.NoError(t, err)
			delegated := f.token(f.other, spelling+"-file-dead-delegated", "write:repository,via:codex", true)
			challenge := func(bearer string, status, decisions int, code string) {
				t.Helper()
				req := httptest.NewRequest("GET", cfg.Server.PublicURL+"/api/members", nil)
				if bearer == "" {
					req.AddCookie(&http.Cookie{Name: "session", Value: cookie})
				} else {
					req.Header.Set("Authorization", "Bearer "+bearer)
				}
				count := 0
				req = req.WithContext(services.WithAuthorizationObserver(req.Context(), func(string) { count++ }))
				out := httptest.NewRecorder()
				router.ServeHTTP(out, req)
				require.Equal(t, status, out.Code, out.Body.String())
				require.Equal(t, decisions, count)
				if code != "" {
					require.Contains(t, out.Body.String(), `"code":"`+code+`"`)
				}
			}
			challenge("", 200, 1, "")
			challenge(delegated, 403, 1, "never")
			challenge(token, 403, 1, "permission")

			var decisionCount atomic.Int64
			request := func() *httptest.ResponseRecorder {
				path := "/api/repos/gate-owner/app/workspaces/" + ws.ID + "/files/content?path=history.txt"
				if spelling == "branch" {
					path = "/api/branches/" + ws.ID + "/files/history.txt"
				}
				req := httptest.NewRequest("GET", cfg.Server.PublicURL+path, nil)
				req.Header.Set("Authorization", "Bearer "+token)
				req = req.WithContext(services.WithAuthorizationObserver(req.Context(), func(string) { decisionCount.Add(1) }))
				out := httptest.NewRecorder()
				router.ServeHTTP(out, req)
				return out
			}
			entered, finish := make(chan struct{}), make(chan struct{})
			var release sync.Once
			finishRead := func() { release.Do(func() { close(finish) }) }
			defer finishRead()
			store.beforeRead = func() { close(entered); <-finish }
			readDone := make(chan *httptest.ResponseRecorder, 1)
			go func() { readDone <- request() }()
			select {
			case <-entered:
			case <-time.After(5 * time.Second):
				t.Fatal("file did not reach native storage")
			}
			conn, err := f.pool.Acquire(f.ctx)
			require.NoError(t, err)
			var pid int32
			require.NoError(t, conn.QueryRow(f.ctx, `SELECT pg_backend_pid()`).Scan(&pid))
			writeDone := make(chan error, 1)
			writeCtx, cancel := context.WithTimeout(f.ctx, 10*time.Second)
			defer cancel()
			go func() {
				defer conn.Release()
				_, err := conn.Exec(writeCtx, `UPDATE collaborators SET suspended_at=NOW() WHERE repository_id=$1 AND user_id=$2`, f.repoID, f.other.ID)
				writeDone <- err
			}()
			require.Eventually(t, func() bool {
				var waiting bool
				err := f.pool.QueryRow(f.ctx, `SELECT COALESCE(wait_event_type='Lock',false) FROM pg_stat_activity WHERE pid=$1`, pid).Scan(&waiting)
				return err == nil && waiting
			}, 5*time.Second, 10*time.Millisecond, "suspension must wait for the admitted read")
			finishRead()
			select {
			case out := <-readDone:
				require.Equal(t, 200, out.Code, out.Body.String())
				require.Contains(t, out.Body.String(), "Recorded repository content")
			case <-time.After(5 * time.Second):
				t.Fatal("read did not finish")
			}
			store.beforeRead = nil
			select {
			case err := <-writeDone:
				require.NoError(t, err)
			case <-time.After(5 * time.Second):
				t.Fatal("suspension did not finish")
			}
			before := store.reads.Load()
			out := request()
			require.Equal(t, 401, out.Code, out.Body.String())
			require.Equal(t, before, store.reads.Load())
			require.NotContains(t, out.Body.String(), "Recorded repository content")
			require.Equal(t, int64(1), decisionCount.Load())
			// Death wins over both person-only delegation and command policy.
			challenge("", 401, 0, "unauthenticated")
			challenge(delegated, 401, 0, "unauthenticated")
			challenge(token, 401, 0, "unauthenticated")

		})

	}
}
