package compose

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

type commandResultAdmissionProbe struct {
	*services.WorkspaceService
	before               func()
	workspace, operation string
	repository, actor    int64
}

func (p *commandResultAdmissionProbe) GetWorkspaceCommandRun(ctx context.Context, workspace string, repo, user int64, operation string) (services.WorkspaceCommandRun, error) {
	if p.before != nil {
		p.before()
	}
	if p.workspace != "" {
		workspace = p.workspace
	}
	if p.operation != "" {
		operation = p.operation
	}
	if p.repository != 0 {
		repo = p.repository
	}
	if p.actor != 0 {
		user = p.actor
	}
	return p.WorkspaceService.GetWorkspaceCommandRun(ctx, workspace, repo, user, operation)
}
func TestInstallCommandResultAuthorizationPostgres(t *testing.T) {
	f := newLandingGateFixtureWithFactory(t, nil, "", true)
	pool, err := postgresfixture.Open(f.ctx, f.pool.Config().ConnConfig.ConnString(), 1)
	require.NoError(t, err)
	defer pool.Close()
	q := db.New(pool)
	store, err := jobs.NewStore(pool)
	require.NoError(t, err)
	service := services.NewWorkspaceService(q, services.WithWorkspaceInstallAuthorization(q), services.WithWorkspaceTransactions(pool), services.WithWorkspaceCommandJobs(store, nil))
	handler := &routes.WorkspaceHandler{Service: service}
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Auth.SessionCookieName = "session"
	cfg.Auth.SessionRefreshWindow = "0s"
	cfg.Server.PublicURL = "http://example.com"
	router := githubAppSetupComposeRouter(cfg, pool, nil, handler)
	maintainer, err := q.CreateUser(f.ctx, db.CreateUserParams{Username: "command-maint", LowerUsername: "command-maint"})
	require.NoError(t, err)
	_, err = pool.Exec(f.ctx, "INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,'admin')", f.repoID, maintainer.ID)
	require.NoError(t, err)
	session := func(user db.User, raw string) string {
		digest := sha256.Sum256([]byte(raw))
		hash := hex.EncodeToString(digest[:])
		_, err := q.CreateAuthSession(f.ctx, db.CreateAuthSessionParams{UserID: user.ID, Username: user.Username, SessionKey: hash, ExpiresAt: time.Now().Add(time.Hour)})
		require.NoError(t, err)
		return hash
	}
	memberHash := session(f.other, "result-member")
	session(f.owner, "result-owner")
	session(maintainer, "result-maint")
	seed := func(user db.User, name string) (string, string) {
		workspace, err := q.CreateWorkspace(f.ctx, db.CreateWorkspaceParams{RepositoryID: f.repoID, UserID: user.ID, Name: name, TargetBookmark: "scratch/" + name, Kind: "container", Status: "running"})
		require.NoError(t, err)
		payload, err := json.Marshal(map[string]any{"WorkspaceID": workspace.ID, "RepositoryID": f.repoID, "UserID": user.ID, "EncryptedInput": "fixture ciphertext"})
		require.NoError(t, err)
		receipt, err := store.Admit(f.ctx, jobs.Admission{Scope: jobs.Scope{TenantID: fmt.Sprintf("repository:%d", f.repoID), PrincipalID: fmt.Sprintf("user:%d", user.ID)}, Operation: "workspace.command", RequestID: name, Payload: payload, EffectPolicy: jobs.EffectUnsafe})
		require.NoError(t, err)
		claim, err := store.ClaimOperation(f.ctx, "result-fixture", time.Minute, receipt.OperationID)
		require.NoError(t, err)
		result, err := json.Marshal(map[string]any{"exit_code": 0, "stdout": []byte(name + " private stdout"), "stderr": []byte{}, "output_truncated": false})
		require.NoError(t, err)
		require.NoError(t, store.Complete(f.ctx, claim, result))
		return workspace.ID, receipt.OperationID
	}
	memberWorkspace, memberRun := seed(f.other, "member-command")
	ownerWorkspace, ownerRun := seed(f.owner, "owner-command")
	maintWorkspace, maintRun := seed(maintainer, "maint-command")
	otherWorkspace, err := q.CreateWorkspace(f.ctx, db.CreateWorkspaceParams{RepositoryID: f.repoID, UserID: f.other.ID, Name: "other-member", TargetBookmark: "scratch/other-member", Kind: "container", Status: "running"})
	require.NoError(t, err)
	call := func(cookie, token, workspace, run string) (*httptest.ResponseRecorder, []string) {
		req := httptest.NewRequest("GET", fmt.Sprintf("%s/api/repos/gate-owner/app/workspaces/%s/command-runs/%s", cfg.Server.PublicURL, workspace, run), nil)
		ctx, cancel := context.WithTimeout(req.Context(), 5*time.Second)
		defer cancel()
		req = req.WithContext(ctx)
		if cookie != "" {
			req.AddCookie(&http.Cookie{Name: "session", Value: cookie})
		}
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		commands := []string{}
		req = req.WithContext(services.WithAuthorizationObserver(req.Context(), func(command string) { commands = append(commands, command) }))
		out := httptest.NewRecorder()
		router.ServeHTTP(out, req)
		return out, commands
	}
	app := f.token(f.other, "result-app", "read:repository,via:smithers,terminal-session:"+liveAppTurnCredentialFixture(t, f.pool, f.other.ID)+"/1", true)
	for _, actor := range []struct {
		name, cookie, token, workspace, run string
		status                              int
	}{
		{"owner", "result-owner", "", ownerWorkspace, ownerRun, 200}, {"member", "result-member", "", memberWorkspace, memberRun, 200}, {"maintainer", "result-maint", "", maintWorkspace, maintRun, 200}, {"app", "", app, memberWorkspace, memberRun, 200},
		{"external", "", f.token(f.other, "result-external", "read:repository,via:codex", true), memberWorkspace, memberRun, 403},
		{"run", "", f.token(f.other, "result-run", "read:repository", true), memberWorkspace, memberRun, 403},
		{"machine", "", f.token(f.other, "result-machine", "read:repository,"+middleware.WorkspaceRestrictionScope(memberWorkspace), true), memberWorkspace, memberRun, 403},
		{"scope", "", f.token(f.other, "result-scope", "read:user,via:smithers,terminal-session:"+liveAppTurnCredentialFixture(t, f.pool, f.other.ID)+"/1", true), memberWorkspace, memberRun, 403},
		{"anonymous", "", "", memberWorkspace, memberRun, 401}, {"owner cannot read member", "result-owner", "", memberWorkspace, memberRun, 403}, {"member cannot read owner", "result-member", "", ownerWorkspace, ownerRun, 403}, {"app cannot read owner", "", app, ownerWorkspace, ownerRun, 403},
		{"wrong workspace", "result-member", "", otherWorkspace.ID, memberRun, 404}, {"wrong principal", "result-member", "", memberWorkspace, ownerRun, 404}, {"malformed run", "result-member", "", memberWorkspace, "invalid", 404},
	} {
		t.Run(actor.name, func(t *testing.T) {
			out, commands := call(actor.cookie, actor.token, actor.workspace, actor.run)
			require.Equal(t, actor.status, out.Code, out.Body.String())
			require.Equal(t, []string{"workspace.command.read"}, commands)
			if actor.status == 200 {
				require.Contains(t, out.Body.String(), "private stdout")
				require.Contains(t, out.Body.String(), `"state":"completed"`)
			} else {
				require.NotContains(t, out.Body.String(), "private stdout")
			}
		})
	}
	for _, mode := range []string{"workspace", "operation", "actor", "repository"} {
		t.Run("substituted "+mode, func(t *testing.T) {
			probe := &commandResultAdmissionProbe{WorkspaceService: service}
			switch mode {
			case "workspace":
				probe.workspace = otherWorkspace.ID
			case "operation":
				probe.operation = ownerRun
			case "actor":
				probe.actor = f.owner.ID
			case "repository":
				probe.repository = f.repoID + 1
			}
			handler.Service = probe
			defer func() { handler.Service = service }()
			out, commands := call("result-member", "", memberWorkspace, memberRun)
			require.Equal(t, 403, out.Code, out.Body.String())
			require.Equal(t, []string{"workspace.command.read"}, commands)
			require.NotContains(t, out.Body.String(), "private stdout")
		})
	}
	t.Run("expiry after admission", func(t *testing.T) {
		handler.Service = &commandResultAdmissionProbe{WorkspaceService: service, before: func() {
			_, err := f.pool.Exec(f.ctx, "UPDATE auth_sessions SET expires_at=now()-interval '1 second' WHERE session_key=$1", memberHash)
			require.NoError(t, err)
		}}
		defer func() { handler.Service = service }()
		out, commands := call("result-member", "", memberWorkspace, memberRun)
		require.Equal(t, 401, out.Code, out.Body.String())
		require.Equal(t, []string{"workspace.command.read"}, commands)
		require.NotContains(t, out.Body.String(), "private stdout")
	})
	_, err = service.GetWorkspaceCommandRun(context.Background(), memberWorkspace, f.repoID, f.other.ID, memberRun)
	require.Error(t, err)
}
