package compose

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

type previewWriteAdmissionProbe struct {
	*services.WorkspaceService
	before            func()
	replace           bool
	port              uint16
	actor, repository int64
	workspace         string
}

func (p *previewWriteAdmissionProbe) SetWorkspaceServicePublic(ctx context.Context, id string, repo, user int64, port uint16, public bool) error {
	if p.before != nil {
		p.before()
	}
	if p.replace {
		public = !public
	}
	if p.port != 0 {
		port = p.port
	}
	if p.actor != 0 {
		user = p.actor
	}
	if p.repository != 0 {
		repo = p.repository
	}
	if p.workspace != "" {
		id = p.workspace
	}
	return p.WorkspaceService.SetWorkspaceServicePublic(ctx, id, repo, user, port, public)
}

func TestInstallPreviewVisibilityWriteAuthorizationPostgres(t *testing.T) {
	f := newLandingGateFixtureWithFactory(t, nil, "", true)
	pool, err := postgresfixture.Open(f.ctx, f.pool.Config().ConnConfig.ConnString(), 1)
	require.NoError(t, err)
	defer pool.Close()
	q := db.New(pool)
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Auth.SessionCookieName = "session"
	cfg.Auth.SessionRefreshWindow = "0s"
	cfg.Server.PublicURL = "http://example.com"
	cfg.Server.AllowedOrigins = []string{cfg.Server.PublicURL}
	service := services.NewWorkspaceService(q, services.WithWorkspaceInstallAuthorization(q), services.WithWorkspaceTransactions(pool))
	handler := &routes.WorkspaceHandler{Service: service}
	router := githubAppSetupComposeRouter(cfg, pool, nil, handler)
	workspace, err := q.CreateWorkspace(f.ctx, db.CreateWorkspaceParams{RepositoryID: f.repoID, UserID: f.owner.ID, Name: "owner-preview", TargetBookmark: "scratch/owner/preview", Kind: "container", Status: "running"})
	require.NoError(t, err)
	foreign, err := q.CreateWorkspace(f.ctx, db.CreateWorkspaceParams{RepositoryID: f.repoID, UserID: f.other.ID, Name: "member-preview", TargetBookmark: "scratch/member/preview", Kind: "container", Status: "running"})
	require.NoError(t, err)
	session := func(user db.User, raw string) string {
		digest := sha256.Sum256([]byte(raw))
		hash := hex.EncodeToString(digest[:])
		_, err := q.CreateAuthSession(f.ctx, db.CreateAuthSessionParams{UserID: user.ID, Username: user.Username, SessionKey: hash, ExpiresAt: time.Now().Add(time.Hour)})
		require.NoError(t, err)
		return hash
	}
	ownerHash := session(f.owner, "preview-owner")
	session(f.other, "preview-member")
	maintainer, err := q.CreateUser(f.ctx, db.CreateUserParams{Username: "preview-maintainer", LowerUsername: "preview-maintainer"})
	require.NoError(t, err)
	_, err = pool.Exec(f.ctx, "INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,'admin')", f.repoID, maintainer.ID)
	require.NoError(t, err)
	session(maintainer, "preview-maintainer")
	call := func(cookie, bearer, id, body string) (*httptest.ResponseRecorder, []string) {
		req := httptest.NewRequest("PUT", cfg.Server.PublicURL+"/api/repos/gate-owner/app/workspaces/"+id+"/services/3000/visibility", strings.NewReader(body))
		ctx, cancel := context.WithTimeout(req.Context(), 10*time.Second)
		defer cancel()
		req = req.WithContext(ctx)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Origin", cfg.Server.PublicURL)
		if cookie != "" {
			req.AddCookie(&http.Cookie{Name: "session", Value: cookie})
			req.AddCookie(&http.Cookie{Name: middleware.CSRFCookieName, Value: "preview-csrf"})
			req.Header.Set("X-CSRF-Token", "preview-csrf")
		}
		if bearer != "" {
			req.Header.Set("Authorization", "Bearer "+bearer)
		}
		commands := []string{}
		req = req.WithContext(services.WithAuthorizationObserver(req.Context(), func(command string) { commands = append(commands, command) }))
		out := httptest.NewRecorder()
		router.ServeHTTP(out, req)
		return out, commands
	}
	private := func() {
		t.Helper()
		value, err := q.WorkspaceServicePublic(f.ctx, db.WorkspaceServicePublicParams{WorkspaceID: workspace.ID, Port: 3000})
		require.NoError(t, err)
		require.False(t, value)
	}
	for _, actor := range []struct {
		name, cookie, token string
		status              int
	}{
		{"member", "preview-member", "", 403},
		{"maintainer", "preview-maintainer", "", 403},
		{"app", "", f.token(f.owner, "preview-app", "write:repository,via:smithers,terminal-session:"+liveAppTurnCredentialFixture(t, f.pool, f.owner.ID)+"/1", true), 403},
		{"external", "", f.token(f.owner, "preview-external", "write:repository,via:codex", true), 403},
		{"run", "", f.token(f.owner, "preview-run", "write:repository", true), 403},
		{"machine", "", f.token(f.owner, "preview-machine", "write:repository,"+middleware.WorkspaceRestrictionScope(workspace.ID), true), 403},
		{"scope", "", f.token(f.owner, "preview-scope", "read:repository,via:codex", true), 403},
		{"anonymous", "", "", 401},
	} {
		t.Run(actor.name, func(t *testing.T) {
			out, commands := call(actor.cookie, actor.token, workspace.ID, `{"public":true}`)
			require.Equal(t, actor.status, out.Code, out.Body.String())
			require.Equal(t, []string{"workspace.preview.update"}, commands)
			private()
		})
	}
	for _, body := range []string{`{}`, `null`, `{"public":null}`, `{"public":"yes"}`, `{"public":true,"unknown":true}`, `{"public":true} {}`} {
		t.Run("invalid "+body, func(t *testing.T) {
			out, commands := call("preview-owner", "", workspace.ID, body)
			require.Equal(t, 400, out.Code, out.Body.String())
			require.Equal(t, []string{"workspace.preview.update"}, commands)
			private()
		})
	}
	for _, mode := range []string{"value", "port", "actor", "repository", "workspace"} {
		t.Run("substituted "+mode, func(t *testing.T) {
			probe := &previewWriteAdmissionProbe{WorkspaceService: service}
			switch mode {
			case "value":
				probe.replace = true
			case "port":
				probe.port = 3001
			case "actor":
				probe.actor = f.other.ID
			case "repository":
				probe.repository = f.repoID + 1
			case "workspace":
				probe.workspace = foreign.ID
			}
			handler.Service = probe
			defer func() { handler.Service = service }()
			out, commands := call("preview-owner", "", workspace.ID, `{"public":true}`)
			require.Equal(t, 403, out.Code, out.Body.String())
			require.Equal(t, []string{"workspace.preview.update"}, commands)
			private()
		})
	}
	t.Run("owner changes only own preview", func(t *testing.T) {
		for _, body := range []string{`{"public":true}`, `{"public":false}`} {
			out, commands := call("preview-owner", "", workspace.ID, body)
			require.Equal(t, 200, out.Code, out.Body.String())
			require.JSONEq(t, body, out.Body.String())
			require.Equal(t, []string{"workspace.preview.update"}, commands)
			value, err := q.WorkspaceServicePublic(f.ctx, db.WorkspaceServicePublicParams{WorkspaceID: workspace.ID, Port: 3000})
			require.NoError(t, err)
			require.Equal(t, strings.Contains(body, "true"), value)
		}
		out, commands := call("preview-owner", "", foreign.ID, `{"public":true}`)
		require.Equal(t, 403, out.Code, out.Body.String())
		require.Equal(t, []string{"workspace.preview.update"}, commands)
		value, err := q.WorkspaceServicePublic(f.ctx, db.WorkspaceServicePublicParams{WorkspaceID: foreign.ID, Port: 3000})
		require.NoError(t, err)
		require.False(t, value)
	})
	t.Run("missing and malformed workspaces remain not found", func(t *testing.T) {
		for _, id := range []string{"not-a-workspace", "11111111-1111-4111-8111-111111111111"} {
			out, commands := call("preview-owner", "", id, `{"public":true}`)
			require.Equal(t, 404, out.Code, out.Body.String())
			require.Equal(t, []string{"workspace.preview.update"}, commands)
			private()
		}
	})
	t.Run("expiry after admission", func(t *testing.T) {
		handler.Service = &previewWriteAdmissionProbe{WorkspaceService: service, before: func() {
			_, err := f.pool.Exec(f.ctx, "UPDATE auth_sessions SET expires_at=now()-interval '1 second' WHERE session_key=$1", ownerHash)
			require.NoError(t, err)
		}}
		defer func() { handler.Service = service }()
		out, commands := call("preview-owner", "", workspace.ID, `{"public":true}`)
		require.Equal(t, 401, out.Code, out.Body.String())
		require.Equal(t, []string{"workspace.preview.update"}, commands)
		private()
	})
	t.Run("expiry while waiting for workspace rolls back publication", func(t *testing.T) {
		expires := time.Now().Add(2 * time.Second)
		_, err := f.pool.Exec(f.ctx, "UPDATE auth_sessions SET expires_at=$2 WHERE session_key=$1", ownerHash, expires)
		require.NoError(t, err)
		block, err := f.pool.Begin(f.ctx)
		require.NoError(t, err)
		defer block.Rollback(context.WithoutCancel(f.ctx))
		_, err = block.Exec(f.ctx, "SELECT id FROM workspaces WHERE id=$1::uuid FOR UPDATE", workspace.ID)
		require.NoError(t, err)
		conn, err := pool.Acquire(f.ctx)
		require.NoError(t, err)
		pid := conn.Conn().PgConn().PID()
		conn.Release()
		done := make(chan *httptest.ResponseRecorder, 1)
		go func() { out, _ := call("preview-owner", "", workspace.ID, `{"public":true}`); done <- out }()
		require.Eventually(t, func() bool {
			var wait bool
			err := f.pool.QueryRow(f.ctx, "SELECT coalesce(wait_event_type='Lock',false) FROM pg_stat_activity WHERE pid=$1", pid).Scan(&wait)
			return err == nil && wait
		}, time.Second, 10*time.Millisecond)
		require.Eventually(t, func() bool { return time.Now().After(expires) }, 3*time.Second, 10*time.Millisecond)
		require.NoError(t, block.Rollback(f.ctx))
		select {
		case out := <-done:
			require.Equal(t, 401, out.Code, out.Body.String())
		case <-time.After(5 * time.Second):
			t.Fatal("expired preview writer did not settle")
		}
		private()
	})
	require.Error(t, service.SetWorkspaceServicePublic(context.Background(), workspace.ID, f.repoID, f.owner.ID, 3000, true))
	private()
}
