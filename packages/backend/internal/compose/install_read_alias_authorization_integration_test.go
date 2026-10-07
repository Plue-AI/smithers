package compose

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"github.com/jackc/pgx/v5/pgtype"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/stretchr/testify/require"
)

func TestInstallReadAliasesPostgres(t *testing.T) {
	f := newLandingGateFixtureWithFactory(t, nil, "", true)
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Auth.SessionCookieName = "session"
	cfg.Server.PublicURL = "http://example.com"
	cfg.Server.AllowedOrigins = []string{"http://example.com"}
	router := buildRouterCompat(cfg, f.q, f.pool,
		&routes.RepoHandler{Service: services.NewRepoService(f.q, nil, "")}, &routes.AuthHandler{}, &routes.UserHandler{}, &routes.SSHKeyHandler{}, &routes.LabelHandler{Service: services.NewLabelService(f.q)},
		&routes.OrgHandler{}, &routes.LandingHandler{}, &routes.SearchHandler{Service: &mockRouterSearchService{}}, &routes.IssueHandler{Service: services.NewIssueService(f.q)},
		nil, &routes.GitSmartHandler{Service: &mockRouterGitService{}},
		nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, &routes.WorkspaceHandler{}, nil, nil, nil, nil, nil, nil, &routes.StackHandler{Service: services.NewStackService(f.q)})
	issue, err := f.q.CreateIssue(f.ctx, db.CreateIssueParams{RepositoryID: f.repoID, Title: "Shared issue", Body: "Team text", AuthorID: f.owner.ID, Kind: "issue"})
	require.NoError(t, err)
	comment, err := f.q.CreateIssueComment(f.ctx, db.CreateIssueCommentParams{IssueID: issue.ID, UserID: pgtype.Int8{Int64: f.owner.ID, Valid: true}, Body: "Reaction source", Commenter: f.owner.Username})
	require.NoError(t, err)
	_, err = f.pool.Exec(f.ctx, `INSERT INTO reactions(user_id,target_type,target_id,emoji) VALUES($1,'issue_comment',$2,'eyes')`, f.other.ID, comment.ID)
	require.NoError(t, err)
	for _, actor := range []struct {
		user int64
		name string
	}{{f.owner.ID, "private-owner-stack"}, {f.other.ID, "member-saved-stack"}} {
		stack, err := f.q.UpsertActiveStack(f.ctx, db.UpsertActiveStackParams{RepositoryID: f.repoID, UserID: actor.user, TargetRef: "main"})
		require.NoError(t, err)
		_, err = f.q.UpsertStackChange(f.ctx, db.UpsertStackChangeParams{StackID: stack.ID, ChangeID: actor.name, BranchName: actor.name, Position: 0})
		require.NoError(t, err)
	}
	_, err = f.q.CreateLabel(f.ctx, db.CreateLabelParams{RepositoryID: f.repoID, Name: "todo", Color: "ffffff"})
	require.NoError(t, err)
	session := "read-alias-member"
	sum := sha256.Sum256([]byte(session))
	_, err = f.q.CreateAuthSession(f.ctx, db.CreateAuthSessionParams{UserID: f.other.ID, Username: f.other.Username, SessionKey: hex.EncodeToString(sum[:]), ExpiresAt: time.Now().Add(time.Hour)})
	require.NoError(t, err)
	delegated := f.token(f.other, "alias-external", "read:repository,via:codex", true)
	run := f.token(f.owner, "alias-run", "read:repository", true)
	app := f.token(f.other, "alias-app", "read:repository,via:smithers,terminal-session:"+liveAppTurnCredentialFixture(t, f.pool, f.other.ID)+"/1", true)
	machine := f.token(f.owner, "alias-machine", "read:repository,"+middleware.WorkspaceRestrictionScope("11111111-1111-4111-8111-111111111111"), true)
	limited := f.token(f.other, "alias-scope", "read:user,via:codex", true)
	for _, path := range []string{"/issues", "/issues/1", "/issues/1/comments", "/issues/1/labels", "/labels", fmt.Sprintf("/issues/1/comments/%d/reactions", comment.ID), "/stacks/active"} {
		for _, actor := range []struct {
			name, token string
			status      int
		}{{"member", "", 200}, {"delegated", delegated, 200}, {"app", app, 200}, {"run", run, 403}, {"machine", machine, 403}, {"scope", limited, 403}, {"anonymous", "", 404}} {
			t.Run(path+"/"+actor.name, func(t *testing.T) {
				req := httptest.NewRequest("GET", "http://example.com/api/repos/gate-owner/app"+path, nil)
				if actor.token == "" && actor.name != "anonymous" {
					req.AddCookie(&http.Cookie{Name: "session", Value: session})
				} else if actor.token != "" {
					req.Header.Set("Authorization", "Bearer "+actor.token)
				}
				decisions := []string{}
				req = req.WithContext(services.WithAuthorizationObserver(req.Context(), func(command string) { decisions = append(decisions, command) }))
				out := httptest.NewRecorder()
				router.ServeHTTP(out, req)
				require.Equal(t, actor.status, out.Code, out.Body.String())
				command := "issue.read"
				if path == "/stacks/active" {
					command = "repo.read"
				}
				if actor.name == "anonymous" {
					require.Empty(t, decisions)
				} else {
					require.Equal(t, []string{command}, decisions)
				}
				require.NotContains(t, out.Body.String(), "private-owner-stack")
				if actor.name == "anonymous" {
					require.Contains(t, out.Body.String(), `"code":"not_found"`)
					require.NotContains(t, out.Body.String(), "member-saved-stack")
				}
				if actor.status == 200 && path == "/stacks/active" {
					require.Contains(t, out.Body.String(), "member-saved-stack")
				}
				if actor.status == 200 && strings.HasSuffix(path, "/reactions") {
					require.Contains(t, out.Body.String(), `"name":"eyes"`)
					require.Contains(t, out.Body.String(), f.other.Username)
				}
				if actor.status == 403 {
					require.Contains(t, out.Body.String(), `"code":"permission"`)
					require.NotContains(t, out.Body.String(), "Shared issue")
				}
				if actor.status == 200 && path == "/issues/1" {
					require.Contains(t, out.Body.String(), "Shared issue")
				}
			})
		}
	}
	for _, credential := range []string{"", "expired-cookie"} {
		req := httptest.NewRequest("GET", "http://example.com/api/health", nil)
		if credential != "" {
			req.AddCookie(&http.Cookie{Name: "session", Value: credential})
		}
		out := httptest.NewRecorder()
		router.ServeHTTP(out, req)
		require.Equal(t, 200, out.Code, out.Body.String())
	}
}
