package compose

import (
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/stretchr/testify/require"
)

func TestInstallSearchAuthorizationPostgres(t *testing.T) {
	f := newLandingGateFixtureWithFactory(t, nil, "", true)
	_, err := f.pool.Exec(f.ctx, `UPDATE repositories SET description='Needle visible repository' WHERE id=$1`, f.repoID)
	require.NoError(t, err)
	_, err = f.pool.Exec(f.ctx, `UPDATE users SET display_name='Needle member' WHERE id=$1`, f.other.ID)
	require.NoError(t, err)
	_, err = f.q.CreateIssue(f.ctx, db.CreateIssueParams{RepositoryID: f.repoID, Title: "Needle visible issue", Body: "Recorded issue", AuthorID: f.owner.ID, Kind: "issue", IdempotencyKey: "search-visible"})
	require.NoError(t, err)
	_, err = f.q.UpsertCodeSearchDocument(f.ctx, db.UpsertCodeSearchDocumentParams{RepositoryID: f.repoID, FilePath: "visible.ts", Content: "const needle = 'visible source'"})
	require.NoError(t, err)
	hidden, err := f.q.CreateRepo(f.ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: f.owner.ID, Valid: true}, Name: "hidden-search", LowerName: "hidden-search", DefaultBookmark: "main", Description: "Needle private repository canary"})
	require.NoError(t, err)
	_, err = f.q.CreateIssue(f.ctx, db.CreateIssueParams{RepositoryID: hidden.ID, Title: "Needle private issue canary", AuthorID: f.owner.ID, Kind: "issue", IdempotencyKey: "search-private"})
	require.NoError(t, err)
	_, err = f.q.UpsertCodeSearchDocument(f.ctx, db.UpsertCodeSearchDocumentParams{RepositoryID: hidden.ID, FilePath: "private-canary.ts", Content: "const needle = 'private code canary'"})
	require.NoError(t, err)
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode, cfg.Auth.SessionCookieName = "selfhost", "session"
	cfg.Server.PublicURL = "http://example.com"
	cfg.Server.AllowedOrigins = []string{cfg.Server.PublicURL}
	router := buildRouterCompat(cfg, f.q, f.pool,
		&routes.RepoHandler{}, &routes.AuthHandler{}, &routes.UserHandler{}, &routes.SSHKeyHandler{}, &routes.LabelHandler{},
		&routes.OrgHandler{}, &routes.LandingHandler{}, &routes.SearchHandler{Service: services.NewSearchService(f.q)}, &routes.IssueHandler{}, nil, &routes.GitSmartHandler{Service: &mockRouterGitService{}},
		nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, &routes.WorkspaceHandler{}, nil, nil, nil, nil, nil, nil)
	cookie := "search-member-person"
	sum := sha256.Sum256([]byte(cookie))
	_, err = f.q.CreateAuthSession(f.ctx, db.CreateAuthSessionParams{UserID: f.other.ID, Username: f.other.Username, SessionKey: hex.EncodeToString(sum[:]), ExpiresAt: time.Now().Add(time.Hour)})
	require.NoError(t, err)
	external := f.token(f.other, "search-external", "read:user,write:repository,via:codex", true)
	app := f.token(f.other, "search-app", "read:user,write:repository,via:smithers,terminal-session:"+liveAppTurnCredentialFixture(t, f.pool, f.other.ID)+"/1", true)
	readOnly := f.token(f.other, "search-read-only", "read:user,read:repository,via:codex", true)
	run := f.token(f.other, "search-run", "read:user,write:repository", true)
	workspace, err := f.q.CreateWorkspace(f.ctx, db.CreateWorkspaceParams{RepositoryID: f.repoID, UserID: f.other.ID, Name: "search-machine", Kind: "container", Status: "running", TargetBookmark: "smithers/search"})
	require.NoError(t, err)
	machine := f.token(f.other, "search-machine", "read:user,write:repository,"+middleware.RepositoryRestrictionScope(f.repoID)+","+middleware.WorkspaceRestrictionScope(workspace.ID), true)
	for _, door := range []struct{ path, content string }{{"repositories", "Needle visible repository"}, {"issues", "Needle visible issue"}, {"users", "Needle member"}, {"code", "visible.ts"}} {
		for _, actor := range []struct {
			name, cookie, token string
			status, decisions   int
		}{
			{"person", cookie, "", 200, 1}, {"external", "", external, 200, 1}, {"app", "", app, 200, 1},
			{"read only", "", readOnly, 403, 1}, {"run", "", run, 403, 1}, {"machine", "", machine, 403, 1}, {"anonymous", "", "", 401, 0},
		} {
			t.Run(door.path+"/"+actor.name, func(t *testing.T) {
				req := httptest.NewRequest("GET", cfg.Server.PublicURL+"/api/search/"+door.path+"?q=needle", nil)
				if actor.cookie != "" {
					req.AddCookie(&http.Cookie{Name: "session", Value: actor.cookie})
				}
				if actor.token != "" {
					req.Header.Set("Authorization", "Bearer "+actor.token)
				}
				var commands []string
				req = req.WithContext(services.WithAuthorizationObserver(req.Context(), func(command string) { commands = append(commands, command) }))
				out := httptest.NewRecorder()
				router.ServeHTTP(out, req)
				require.Equal(t, actor.status, out.Code, out.Body.String())
				require.Len(t, commands, actor.decisions)
				if actor.decisions > 0 {
					require.Equal(t, []string{"search"}, commands)
				}
				if actor.status == 200 {
					require.Contains(t, out.Body.String(), door.content)
				} else {
					require.NotContains(t, out.Body.String(), door.content)
				}
				require.NotContains(t, out.Body.String(), "private repository canary")
				require.NotContains(t, out.Body.String(), "private issue canary")
				require.NotContains(t, out.Body.String(), "private-canary.ts")
			})
		}
	}
}
