package compose

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
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

func TestInstallWorkspaceHeadCommandPostgres(t *testing.T) {
	f := newLandingGateFixtureWithFactory(t, nil, "", true)
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Auth.SessionCookieName = "session"
	cfg.Server.PublicURL = "http://example.com"
	cfg.Server.AllowedOrigins = []string{"http://example.com"}
	service := services.NewWorkspaceService(f.q, services.WithWorkspaceInstallAuthorization(f.q), services.WithWorkspaceTransactions(f.pool))
	router := githubAppSetupComposeRouter(cfg, f.pool, nil, &routes.WorkspaceHandler{Service: service})
	workspace := func(name string) db.Workspace {
		row, err := f.q.CreateWorkspace(f.ctx, db.CreateWorkspaceParams{RepositoryID: f.repoID, UserID: f.owner.ID, Name: name, TargetBookmark: "main", Kind: "container", EnvironmentSource: ".smithers/environment.nix", Status: "running"})
		require.NoError(t, err)
		return row
	}
	own, other := workspace("own"), workspace("other")
	// Install machines have a separate database owner; the recorded publisher
	// token, rather than that owner, binds the active member sponsoring reports.
	_, err := f.pool.Exec(f.ctx, `UPDATE workspaces SET user_id=$2 WHERE id=$1`, own.ID, f.other.ID)
	require.NoError(t, err)

	cookie := "head-owner-session"
	sum := sha256.Sum256([]byte(cookie))
	_, err = f.q.CreateAuthSession(f.ctx, db.CreateAuthSessionParams{UserID: f.owner.ID, Username: f.owner.Username, SessionKey: hex.EncodeToString(sum[:]), ExpiresAt: time.Now().Add(time.Hour)})
	require.NoError(t, err)
	scopes := "write:repository," + middleware.RepositoryRestrictionScope(f.repoID) + "," + middleware.WorkspaceRestrictionScope(own.ID)
	machine := f.token(f.owner, "head-machine", scopes, true)
	sum = sha256.Sum256([]byte(machine))
	stored, err := f.q.GetAuthInfoByTokenHash(f.ctx, hex.EncodeToString(sum[:]))
	require.NoError(t, err)
	_, err = f.pool.Exec(f.ctx, `UPDATE workspaces SET head_push_token_id=$2 WHERE id=$1`, own.ID, stored.TokenID)
	require.NoError(t, err)
	unrecorded := f.token(f.owner, "head-unrecorded", scopes, true)

	run := f.token(f.owner, "head-run", "write:repository,"+middleware.RepositoryRestrictionScope(f.repoID), true)
	external := f.token(f.owner, "head-external", "write:repository,via:codex", true)
	children := f.token(f.owner, "head-children", scopes+","+middleware.WorkspaceChildrenCredentialScope(), true)
	for _, cell := range []struct {
		name, token, workspace string
		status                 int
		decisions              int
	}{
		{"machine own", machine, own.ID, 200, 1}, {"unrecorded", unrecorded, own.ID, 403, 1}, {"machine other", machine, other.ID, 403, 1},
		{"run", run, own.ID, 403, 1}, {"delegated", external, own.ID, 403, 1}, {"session", "", own.ID, 403, 1}, {"children", children, own.ID, 403, 1},
	} {
		t.Run(cell.name, func(t *testing.T) {
			req := httptest.NewRequest("POST", fmt.Sprintf("http://example.com/api/repos/gate-owner/app/workspaces/%s/head", cell.workspace), strings.NewReader(`{"change_id":"new-change","commit_id":"new-commit","ahead":2,"behind":0}`))
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("Origin", "http://example.com")
			if cell.token != "" {
				req.Header.Set("Authorization", "Bearer "+cell.token)
			} else {
				req.AddCookie(&http.Cookie{Name: "session", Value: cookie})
				req.AddCookie(&http.Cookie{Name: "__csrf", Value: "csrf"})
				req.Header.Set("X-CSRF-Token", "csrf")
			}
			ctx, cancel := context.WithTimeout(req.Context(), 5*time.Second)
			defer cancel()
			req = req.WithContext(ctx)
			var decisions []string
			requestCtx, cancel := context.WithTimeout(req.Context(), 5*time.Second)
			defer cancel()
			req = req.WithContext(services.WithAuthorizationObserver(requestCtx, func(command string) { decisions = append(decisions, command) }))
			out := httptest.NewRecorder()
			router.ServeHTTP(out, req)
			require.Equal(t, cell.status, out.Code, out.Body.String())
			require.Len(t, decisions, cell.decisions)
			if cell.decisions > 0 {
				require.Equal(t, "workspace.head", decisions[0])
			}
			row, err := f.q.GetWorkspace(f.ctx, cell.workspace)
			require.NoError(t, err)
			if cell.status == 200 {
				require.Equal(t, "new-commit", row.HeadCommitID)
				_, err = f.pool.Exec(f.ctx, `UPDATE workspaces SET head_commit_id='',head_change_id='',ahead=0 WHERE id=$1`, cell.workspace)
				require.NoError(t, err)
			} else {
				require.Empty(t, row.HeadCommitID)
				require.Contains(t, out.Body.String(), `"code":"permission"`)
			}
		})
	}
	t.Run("direct entry binds the stored subject", func(t *testing.T) {
		info := &middleware.AuthInfo{User: &f.owner, IsTokenAuth: true, TokenSystemIssued: true, TokenID: stored.TokenID, TokenHash: hex.EncodeToString(sum[:]), RawScopes: scopes, Scopes: middleware.ParseTokenScopes(scopes)}
		ctx := middleware.ContextWithAuthInfo(f.ctx, info)
		var decisions []string
		ctx = services.WithAuthorizationObserver(ctx, func(command string) { decisions = append(decisions, command) })
		input := services.ReportWorkspaceHeadInput{WorkspaceID: own.ID, RepositoryID: f.repoID, UserID: f.owner.ID, TokenWorkspaceID: own.ID, ChangeID: "direct-change", CommitID: "direct-commit"}
		subject, err := services.InstallWorkspaceHeadSubject(input)
		require.NoError(t, err)
		decision, err := services.Authorize(ctx, f.q, "workspace.head", subject)
		require.NoError(t, err)
		ctx = services.WithInstallAuthorization(ctx, "workspace.head", decision, subject)
		_, err = service.ReportWorkspaceHead(ctx, input)
		require.NoError(t, err)
		require.Equal(t, []string{"workspace.head"}, decisions, "direct service reuses the admitted subject")
		changed := input
		changed.CommitID = "substituted-commit"
		_, err = service.ReportWorkspaceHead(ctx, changed)
		var payloadRefusal *services.AccessError
		require.ErrorAs(t, err, &payloadRefusal)
		require.Equal(t, 403, payloadRefusal.Status)
		current, err := f.q.GetWorkspace(f.ctx, own.ID)
		require.NoError(t, err)
		require.Equal(t, "direct-commit", current.HeadCommitID)
		input.WorkspaceID = other.ID
		_, err = service.ReportWorkspaceHead(ctx, input)
		var refusal *services.AccessError
		require.ErrorAs(t, err, &refusal)
		require.Equal(t, 403, refusal.Status)
		require.Equal(t, []string{"workspace.head"}, decisions, "a changed subject refuses the original binding")
		untouched, err := f.q.GetWorkspace(f.ctx, other.ID)
		require.NoError(t, err)
		require.Empty(t, untouched.HeadCommitID)
	})

	for _, testCase := range []struct {
		name      string
		suspended bool
		status    int
	}{
		{"publisher rotated after decision", false, 403},
		{"sponsor suspended after decision", true, 401},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			info := &middleware.AuthInfo{User: &f.owner, IsTokenAuth: true, TokenSystemIssued: true, TokenID: stored.TokenID, TokenHash: hex.EncodeToString(sum[:]), RawScopes: scopes, Scopes: middleware.ParseTokenScopes(scopes)}
			ctx := middleware.ContextWithAuthInfo(f.ctx, info)
			count := 0
			ctx = services.WithAuthorizationObserver(ctx, func(string) { count++ })
			input := services.ReportWorkspaceHeadInput{WorkspaceID: own.ID, RepositoryID: f.repoID, UserID: f.owner.ID, TokenWorkspaceID: own.ID, ChangeID: "stale", CommitID: "stale"}
			subject, err := services.InstallWorkspaceHeadSubject(input)
			require.NoError(t, err)
			decision, err := services.Authorize(ctx, f.q, "workspace.head", subject)
			require.NoError(t, err)
			ctx = services.WithInstallAuthorization(ctx, "workspace.head", decision, subject)
			before, err := f.q.GetWorkspace(f.ctx, own.ID)
			require.NoError(t, err)
			if testCase.suspended {
				_, err = f.pool.Exec(f.ctx, `UPDATE users SET prohibit_login=true WHERE id=$1`, f.owner.ID)
				defer func() {
					_, err := f.pool.Exec(f.ctx, `UPDATE users SET prohibit_login=false WHERE id=$1`, f.owner.ID)
					require.NoError(t, err)
				}()
			} else {
				_, err = f.pool.Exec(f.ctx, `UPDATE workspaces SET head_push_token_id=NULL WHERE id=$1`, own.ID)
				defer func() {
					_, err := f.pool.Exec(f.ctx, `UPDATE workspaces SET head_push_token_id=$2 WHERE id=$1`, own.ID, stored.TokenID)
					require.NoError(t, err)
				}()
			}
			require.NoError(t, err)
			_, err = service.ReportWorkspaceHead(ctx, input)
			var refusal *services.AccessError
			require.ErrorAs(t, err, &refusal)
			require.Equal(t, testCase.status, refusal.Status)
			require.Equal(t, 1, count)
			after, err := f.q.GetWorkspace(f.ctx, own.ID)
			require.NoError(t, err)
			require.Equal(t, before.HeadCommitID, after.HeadCommitID)
		})
	}
	t.Run("revoked after decision", func(t *testing.T) {
		info := &middleware.AuthInfo{User: &f.owner, IsTokenAuth: true, TokenSystemIssued: true, TokenID: stored.TokenID, TokenHash: hex.EncodeToString(sum[:]), RawScopes: scopes, Scopes: middleware.ParseTokenScopes(scopes)}
		ctx := middleware.ContextWithAuthInfo(f.ctx, info)
		count := 0
		ctx = services.WithAuthorizationObserver(ctx, func(string) { count++ })
		input := services.ReportWorkspaceHeadInput{WorkspaceID: own.ID, RepositoryID: f.repoID, UserID: f.owner.ID, TokenWorkspaceID: own.ID, ChangeID: "revoked", CommitID: "revoked"}
		subject, err := services.InstallWorkspaceHeadSubject(input)
		require.NoError(t, err)
		decision, err := services.Authorize(ctx, f.q, "workspace.head", subject)
		require.NoError(t, err)
		ctx = services.WithInstallAuthorization(ctx, "workspace.head", decision, subject)
		before, err := f.q.GetWorkspace(f.ctx, own.ID)
		require.NoError(t, err)
		_, err = f.pool.Exec(f.ctx, `DELETE FROM access_tokens WHERE id=$1`, stored.TokenID)
		require.NoError(t, err)
		_, err = service.ReportWorkspaceHead(ctx, input)
		var refusal *services.AccessError
		require.ErrorAs(t, err, &refusal)
		require.Equal(t, 401, refusal.Status)
		require.Equal(t, "unauthenticated", refusal.Code)
		require.Equal(t, 1, count)
		after, err := f.q.GetWorkspace(f.ctx, own.ID)
		require.NoError(t, err)
		require.Equal(t, before.HeadCommitID, after.HeadCommitID)
	})

}
