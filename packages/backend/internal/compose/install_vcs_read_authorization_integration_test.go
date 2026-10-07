package compose

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/repository"
	"github.com/stretchr/testify/require"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestInstallRetainedVCSReadsPostgres(t *testing.T) {
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
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Auth.SessionCookieName = "session"
	cfg.Server.PublicURL = "http://example.com"
	cfg.Server.AllowedOrigins = []string{cfg.Server.PublicURL}
	changeService := services.NewChangeService(f.q, client, f.pool)
	change, err := client.GetChange(f.ctx, "gate-owner", "app", head)
	require.NoError(t, err)
	_, err = f.q.UpsertChange(f.ctx, db.UpsertChangeParams{RepositoryID: f.repoID, ChangeID: change.ChangeID, CommitID: head, ParentChangeIds: []byte("[]")})
	require.NoError(t, err)
	revision, err := f.q.RecordChangeRevision(f.ctx, db.RecordChangeRevisionParams{RepositoryID: f.repoID, ChangeID: change.ChangeID, CommitID: head, Source: "push", OperationIds: []string{}})
	require.NoError(t, err)
	_, err = changeService.StoreWalkthrough(f.ctx, f.repoID, change.ChangeID, revision.Seq, services.ChangeWalkthroughResponse{Sections: []services.ChangeWalkthroughSection{{Title: "Recorded revision", Markdown: "Recorded explanation"}}})
	require.NoError(t, err)
	statusService := services.NewCommitStatusService(f.q)
	_, err = statusService.CreateCommitStatus(f.ctx, f.repoID, head, services.CreateCommitStatusInput{Context: "recorded-check", Status: "success", Description: "Recorded check result"})
	require.NoError(t, err)
	_, err = f.q.CreateLFSObject(f.ctx, db.CreateLFSObjectParams{RepositoryID: f.repoID, Oid: strings.Repeat("b", 64), Size: 42, GcsPath: "private-storage-object"})
	require.NoError(t, err)
	git("--git-dir", filepath.Join(storage, "gate-owner", "app", ".jj/repo/store/git"), "update-ref", fmt.Sprintf("refs/smithers/users/%d/private-owner-ref", f.owner.ID), head)
	router := buildRouterCompat(cfg, f.q, f.pool,
		&routes.RepoHandler{Service: services.NewRepoService(f.q, client, "")}, &routes.AuthHandler{}, &routes.UserHandler{}, &routes.SSHKeyHandler{}, &routes.LabelHandler{},
		&routes.OrgHandler{}, &routes.LandingHandler{}, &routes.SearchHandler{Service: &mockRouterSearchService{}}, &routes.IssueHandler{}, nil, &routes.GitSmartHandler{Service: &mockRouterGitService{}},
		nil, nil, nil, nil, nil, nil, nil, nil, nil, &routes.CommitStatusHandler{Service: statusService}, &routes.LFSHandler{Service: services.NewLFSService(f.q, nil, time.Minute)},
		&routes.JJVCSHandler{RepoHost: client, RepoResolver: f.q, ChangeService: changeService, FindingsService: changeService, WalkthroughService: changeService, ChangeOperations: services.NewChangeOperationService(f.q, client, nil, f.pool)},
		nil, nil, nil, nil, nil, &routes.WorkspaceHandler{}, nil, nil, nil, nil, nil, nil, routerExtras{UserRefs: &routes.UserRefHandler{Service: services.NewUserRefService(client, f.q)}})
	type actorCase struct {
		name, token, cookie string
		status              int
	}
	actors := []actorCase{}
	maintainer, err := f.q.CreateUser(f.ctx, db.CreateUserParams{Username: "history-maintainer", LowerUsername: "history-maintainer"})
	require.NoError(t, err)
	_, err = f.pool.Exec(f.ctx, `INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,'admin')`, f.repoID, maintainer.ID)
	require.NoError(t, err)
	// These literal statuses exercise each trusted actor class at every roster role.
	for _, person := range []struct {
		role string
		user db.User
	}{{"owner", f.owner}, {"maintainer", maintainer}, {"member", f.other}} {
		cookie := "history-" + person.role
		sum := sha256.Sum256([]byte(cookie))
		_, err = f.q.CreateAuthSession(f.ctx, db.CreateAuthSessionParams{UserID: person.user.ID, Username: person.user.Username, SessionKey: hex.EncodeToString(sum[:]), ExpiresAt: time.Now().Add(time.Hour)})
		require.NoError(t, err)
		actors = append(actors, actorCase{name: person.role, cookie: cookie, status: 200})
		external := f.token(person.user, "vcs-external-"+person.role, "read:repository,via:codex", true)
		app := f.token(person.user, "vcs-app-"+person.role, "read:repository,via:smithers,terminal-session:"+liveAppTurnCredentialFixture(t, f.pool, person.user.ID)+"/1", true)
		actors = append(actors, actorCase{name: person.role + " external", token: external, status: 200}, actorCase{name: person.role + " app", token: app, status: 200})
	}
	ws, err := f.q.CreateWorkspace(f.ctx, db.CreateWorkspaceParams{RepositoryID: f.repoID, UserID: f.owner.ID, Name: "history-run", Kind: "container", Status: "running", TargetBookmark: "smithers/own"})
	require.NoError(t, err)
	run := f.token(f.owner, "vcs-run", "read:repository,"+middleware.RepositoryRestrictionScope(f.repoID)+","+middleware.LandingWorkspaceScope(ws.ID)+","+middleware.AgentSessionRestrictionScope("history-run"), true)
	machine := f.token(f.owner, "vcs-machine", "read:repository,"+middleware.RepositoryRestrictionScope(f.repoID)+","+middleware.WorkspaceRestrictionScope(ws.ID), true)
	_, err = f.pool.Exec(f.ctx, `INSERT INTO mythical_items(repository_id,source,state,stack_position,title,workspace_id,request_run_id,owner_id,created_by,attempt) VALUES($1,'todo','running',1,'Bound execution',$2,'history-run',$3,$3,1)`, f.repoID, ws.ID, f.owner.ID)
	require.NoError(t, err)
	actors = append(actors, actorCase{name: "run", token: run, status: 403}, actorCase{name: "machine", token: machine, status: 403}, actorCase{name: "insufficient scope", token: f.token(f.owner, "vcs-scope", "read:user,via:codex", true), status: 403})
	paths := []string{"/user-refs", "/lfs/objects", "/commits/" + head + "/statuses", "/git/refs", "/contents", "/contents/history.txt", "/bookmarks", "/changes", "/changes/count?rev=" + head + "&since=2020-01-01T00:00:00Z", "/changes/" + change.ChangeID, "/changes/" + change.ChangeID + "/files", "/changes/" + change.ChangeID + "/conflicts", "/changes/" + change.ChangeID + "/diff", "/changes/" + change.ChangeID + "/findings", "/changes/" + change.ChangeID + "/operations", "/changes/" + change.ChangeID + "/walkthrough", "/operations", "/status", "/file/" + change.ChangeID + "/history.txt"}
	for _, actor := range actors {
		for _, path := range paths {
			t.Run(actor.name+path, func(t *testing.T) {
				req := httptest.NewRequest("GET", cfg.Server.PublicURL+"/api/repos/gate-owner/app"+path, nil)
				if actor.token == "" {
					req.AddCookie(&http.Cookie{Name: "session", Value: actor.cookie})
				} else {
					req.Header.Set("Authorization", "Bearer "+actor.token)
				}
				var decisions []string
				req = req.WithContext(services.WithAuthorizationObserver(req.Context(), func(command string) { decisions = append(decisions, command) }))
				out := httptest.NewRecorder()
				router.ServeHTTP(out, req)
				require.Equal(t, actor.status, out.Code, out.Body.String())
				require.Equal(t, []string{"repo.read"}, decisions)
				if actor.status == 403 {
					require.Contains(t, out.Body.String(), `"code":"permission"`)
					require.NotContains(t, out.Body.String(), "Recorded repository content")
				}
				if actor.status == 200 && path == "/commits/"+head+"/statuses" {
					require.Contains(t, out.Body.String(), "Recorded check result")
				}
				if actor.status == 200 && path == "/lfs/objects" {
					require.Contains(t, out.Body.String(), strings.Repeat("b", 64))
				}
				if actor.status == 200 && path == "/user-refs" && strings.HasPrefix(actor.name, "owner") {
					require.Contains(t, out.Body.String(), "private-owner-ref")
				}
				if actor.status == 200 && path == "/user-refs" && !strings.HasPrefix(actor.name, "owner") {
					require.NotContains(t, out.Body.String(), "private-owner-ref")
				}
				if actor.status == 200 && (strings.HasPrefix(path, "/file/") || path == "/contents/history.txt") {
					require.Contains(t, out.Body.String(), "Recorded repository content")
				}
			})
		}
	}
	require.Equal(t, head, git("--git-dir", filepath.Join(storage, "gate-owner", "app", ".jj/repo/store/git"), "rev-parse", "refs/heads/main"))
}
