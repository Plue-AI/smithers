package compose

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/identity"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/stretchr/testify/require"
)

func TestInstallMemberScratchArchivePostgres(t *testing.T) {
	f := newLandingGateFixtureWithFactory(t, nil, "", true)
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Auth.SessionCookieName = "session"
	cfg.Server.PublicURL = "http://example.com"
	cfg.Server.AllowedOrigins = []string{cfg.Server.PublicURL}
	// Archive writes the retention decision, never starts or destroys a VM.
	// Compose the real membership provider and SQL service without a runtime.
	svc := services.NewWorkspaceService(f.q, services.WithWorkspaceTransactions(f.pool), services.WithBranchMachineProviders(services.InstallBranchMachineProviders(identity.NewMemberBoundary(f.q), nil)))
	boundary := &archiveSubstitutionService{WorkspaceService: svc}
	router := buildRouterCompat(cfg, f.q, f.pool, &routes.RepoHandler{}, &routes.AuthHandler{}, &routes.UserHandler{}, &routes.SSHKeyHandler{}, &routes.LabelHandler{}, &routes.OrgHandler{}, &routes.LandingHandler{}, &routes.SearchHandler{Service: &mockRouterSearchService{}}, &routes.IssueHandler{}, nil, &routes.GitSmartHandler{Service: &mockRouterGitService{}}, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, &routes.WorkspaceHandler{Service: boundary}, nil, nil, nil, nil, nil, nil)
	cookie := "archive-member"
	digest := sha256.Sum256([]byte(cookie))
	_, err := f.q.CreateAuthSession(f.ctx, db.CreateAuthSessionParams{UserID: f.other.ID, Username: f.other.Username, SessionKey: hex.EncodeToString(digest[:]), ExpiresAt: time.Now().Add(time.Hour)})
	require.NoError(t, err)
	external := f.token(f.other, "archive-external", "write:repository,via:codex", true)
	app := f.token(f.other, "archive-app", "write:repository,via:smithers,terminal-session:"+liveAppTurnCredentialFixture(t, f.pool, f.other.ID)+"/1", true)
	run := f.token(f.other, "archive-run", "write:repository", true)
	machine := f.token(f.other, "archive-machine", "write:repository,"+middleware.WorkspaceRestrictionScope("11111111-1111-4111-8111-111111111111"), true)
	limited := f.token(f.other, "archive-readonly", "read:repository,via:codex", true)
	owner, err := f.q.GetBranchMachineOwner(f.ctx)
	require.NoError(t, err)
	for _, actor := range []struct {
		name, token string
		status      int
		code        string
	}{
		{"member-id", "", 200, ""}, {"member-name", "", 200, ""}, {"external", external, 503, "confirmation_unavailable"}, {"app", app, 503, "confirmation_unavailable"}, {"run", run, 403, "permission"}, {"machine", machine, 403, "permission"}, {"scope", limited, 403, "permission"}, {"substituted", "", 403, "permission"},
	} {
		t.Run(actor.name, func(t *testing.T) {
			row, err := f.q.CreateWorkspace(f.ctx, db.CreateWorkspaceParams{RepositoryID: f.repoID, UserID: owner, Name: actor.name, TargetBookmark: "scratch/member/" + actor.name, Kind: "container", Status: "suspended"})
			require.NoError(t, err)
			boundary.replace = ""
			var alternate db.Workspace
			if actor.name == "substituted" {
				alternate, err = f.q.CreateWorkspace(f.ctx, db.CreateWorkspaceParams{RepositoryID: f.repoID, UserID: owner, Name: "substituted-other", TargetBookmark: "scratch/member/substituted-other", Kind: "container", Status: "suspended"})
				require.NoError(t, err)
				boundary.replace = alternate.ID
			}
			selector := row.ID
			if actor.name == "member-name" {
				selector = url.PathEscape(row.TargetBookmark)
			}
			call := func() *httptest.ResponseRecorder {
				req := httptest.NewRequest(http.MethodPost, cfg.Server.PublicURL+"/api/branches/"+selector+"/archive", strings.NewReader(`{}`))
				req.Header.Set("Content-Type", "application/json")
				req.Header.Set("Origin", cfg.Server.PublicURL)
				req.Header.Set("Idempotency-Key", "archive-"+actor.name)
				if actor.token == "" {
					req.AddCookie(&http.Cookie{Name: "session", Value: cookie})
					req.AddCookie(&http.Cookie{Name: middleware.CSRFCookieName, Value: "csrf"})
					req.Header.Set("X-CSRF-Token", "csrf")
				} else {
					req.Header.Set("Authorization", "Bearer "+actor.token)
				}
				var commands []string
				req = req.WithContext(services.WithAuthorizationObserver(req.Context(), func(command string) { commands = append(commands, command) }))
				out := httptest.NewRecorder()
				router.ServeHTTP(out, req)
				require.Equal(t, actor.status, out.Code, out.Body.String())
				require.Equal(t, []string{"branch.archive"}, commands)
				return out
			}
			out := call()
			if alternate.ID != "" {
				refused, err := f.q.GetWorkspace(f.ctx, alternate.ID)
				require.NoError(t, err)
				require.False(t, refused.BranchArchivedAt.Valid)
			}
			stored, err := f.q.GetWorkspace(f.ctx, row.ID)
			require.NoError(t, err)
			require.False(t, stored.DeletedAt.Valid)
			require.False(t, stored.DiskReclaimedAt.Valid)
			require.Equal(t, "suspended", stored.Status)
			if actor.status == 200 {
				require.True(t, stored.BranchArchivedAt.Valid)
				require.Contains(t, out.Body.String(), `"state":"closed"`)
				call()
				repeated, err := f.q.GetWorkspace(f.ctx, row.ID)
				require.NoError(t, err)
				require.Equal(t, stored.BranchArchivedAt, repeated.BranchArchivedAt)
			} else {
				require.False(t, stored.BranchArchivedAt.Valid)
				require.Contains(t, out.Body.String(), `"code":"`+actor.code+`"`)
			}
		})
	}

	t.Run("direct entry binds once", func(t *testing.T) {
		row, err := f.q.CreateWorkspace(f.ctx, db.CreateWorkspaceParams{RepositoryID: f.repoID, UserID: owner, Name: "direct", TargetBookmark: "scratch/member/direct", Kind: "container", Status: "suspended"})
		require.NoError(t, err)
		ctx := middleware.ContextWithAuthInfo(f.ctx, &middleware.AuthInfo{User: &f.other, SessionHash: hex.EncodeToString(digest[:])})
		var commands []string
		ctx = services.WithAuthorizationObserver(ctx, func(command string) { commands = append(commands, command) })
		_, err = svc.ArchiveScratchBranch(ctx, row.ID, f.repoID, f.other.ID)
		require.NoError(t, err)
		require.Equal(t, []string{"branch.archive"}, commands)
		_, err = f.pool.Exec(f.ctx, `UPDATE auth_sessions SET expires_at=now()-interval '1 second' WHERE user_id=$1`, f.other.ID)
		require.NoError(t, err)
		commands = nil
		_, err = svc.ArchiveScratchBranch(ctx, "unknown", f.repoID, f.other.ID)
		var refusal *services.AccessError
		require.ErrorAs(t, err, &refusal)
		require.Equal(t, 401, refusal.Status)
		require.Empty(t, commands, "dead direct credentials fail before policy and subject disclosure")
	})
}

type archiveSubstitutionService struct {
	*services.WorkspaceService
	replace string
}

func (s *archiveSubstitutionService) ArchiveScratchBranch(ctx context.Context, branch string, repository, actor int64) (services.BranchMachineResponse, error) {
	if s.replace != "" {
		branch = s.replace
	}
	return s.WorkspaceService.ArchiveScratchBranch(ctx, branch, repository, actor)
}
