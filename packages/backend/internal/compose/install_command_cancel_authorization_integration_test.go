package compose

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
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
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

type commandCancelAdmissionProbe struct {
	*services.WorkspaceService
	before               func()
	workspace, operation string
	actor, repository    int64
}

func (p *commandCancelAdmissionProbe) CancelWorkspaceCommandRun(ctx context.Context, workspace string, repo, user int64, operation string) (services.WorkspaceCommandRun, error) {
	if p.before != nil {
		p.before()
	}
	if p.workspace != "" {
		workspace = p.workspace
	}
	if p.operation != "" {
		operation = p.operation
	}
	if p.actor != 0 {
		user = p.actor
	}
	if p.repository != 0 {
		repo = p.repository
	}
	return p.WorkspaceService.CancelWorkspaceCommandRun(ctx, workspace, repo, user, operation)
}
func TestInstallCommandCancellationAuthorizationPostgres(t *testing.T) {
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
	cfg.Server.AllowedOrigins = []string{cfg.Server.PublicURL}
	router := githubAppSetupComposeRouter(cfg, pool, nil, handler)
	session := func(user db.User, raw string) string {
		digest := sha256.Sum256([]byte(raw))
		hash := hex.EncodeToString(digest[:])
		_, err := q.CreateAuthSession(f.ctx, db.CreateAuthSessionParams{UserID: user.ID, Username: user.Username, SessionKey: hash, ExpiresAt: time.Now().Add(time.Hour)})
		require.NoError(t, err)
		return hash
	}
	memberHash := session(f.other, "cancel-member")
	session(f.owner, "cancel-owner")
	workspace, err := q.CreateWorkspace(f.ctx, db.CreateWorkspaceParams{RepositoryID: f.repoID, UserID: f.other.ID, Name: "cancel-member", TargetBookmark: "scratch/cancel-member", Kind: "container", Status: "running"})
	require.NoError(t, err)
	ownerWorkspace, err := q.CreateWorkspace(f.ctx, db.CreateWorkspaceParams{RepositoryID: f.repoID, UserID: f.owner.ID, Name: "cancel-owner", TargetBookmark: "scratch/cancel-owner", Kind: "container", Status: "running"})
	require.NoError(t, err)
	scope := jobs.Scope{TenantID: fmt.Sprintf("repository:%d", f.repoID), PrincipalID: fmt.Sprintf("user:%d", f.other.ID)}
	seed := func(name string) string {
		payload, err := json.Marshal(map[string]any{"WorkspaceID": workspace.ID, "RepositoryID": f.repoID, "UserID": f.other.ID, "EncryptedInput": "fixture ciphertext"})
		require.NoError(t, err)
		receipt, err := store.Admit(f.ctx, jobs.Admission{Scope: scope, Operation: "workspace.command", RequestID: name, Payload: payload, EffectPolicy: jobs.EffectUnsafe})
		require.NoError(t, err)
		return receipt.OperationID
	}
	ready := seed("ready")
	call := func(cookie, token, workspace, run string) (*httptest.ResponseRecorder, []string) {
		req := httptest.NewRequest("POST", fmt.Sprintf("%s/api/repos/gate-owner/app/workspaces/%s/command-runs/%s/cancel", cfg.Server.PublicURL, workspace, run), strings.NewReader(`{}`))
		ctx, cancel := context.WithTimeout(req.Context(), 10*time.Second)
		defer cancel()
		req = req.WithContext(ctx)
		req.Header.Set("Origin", cfg.Server.PublicURL)
		req.Header.Set("Content-Type", "application/json")
		if cookie != "" {
			req.AddCookie(&http.Cookie{Name: "session", Value: cookie})
			req.AddCookie(&http.Cookie{Name: middleware.CSRFCookieName, Value: "cancel-csrf"})
			req.Header.Set("X-CSRF-Token", "cancel-csrf")
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
	unchanged := func(id string) {
		value, err := store.Get(f.ctx, scope, id)
		require.NoError(t, err)
		require.False(t, value.CancellationRequested)
		require.False(t, value.State.Terminal())
	}
	for _, actor := range []struct {
		name, cookie, token string
		status              int
	}{
		{"owner cannot cancel member", "cancel-owner", "", 403},
		{"external", "", f.token(f.other, "cancel-external", "write:repository,via:codex", true), 403},
		{"app needs confirmation", "", f.token(f.other, "cancel-app", "write:repository,via:smithers,terminal-session:"+liveAppTurnCredentialFixture(t, f.pool, f.other.ID)+"/1", true), 503},
		{"run", "", f.token(f.other, "cancel-run", "write:repository", true), 403},
		{"machine", "", f.token(f.other, "cancel-machine", "write:repository,"+middleware.WorkspaceRestrictionScope(workspace.ID), true), 403},
		{"scope", "", f.token(f.other, "cancel-scope", "read:repository,via:smithers,terminal-session:"+liveAppTurnCredentialFixture(t, f.pool, f.other.ID)+"/1", true), 403}, {"anonymous", "", "", 401},
	} {
		t.Run(actor.name, func(t *testing.T) {
			out, commands := call(actor.cookie, actor.token, workspace.ID, ready)
			require.Equal(t, actor.status, out.Code, out.Body.String())
			require.Equal(t, []string{"runs.cancel"}, commands)
			if actor.status == 503 {
				require.Contains(t, out.Body.String(), `"code":"confirmation_unavailable"`)
			}
			unchanged(ready)
		})
	}
	other := seed("other")
	for _, mode := range []string{"workspace", "operation", "actor", "repository"} {
		t.Run("substituted "+mode, func(t *testing.T) {
			probe := &commandCancelAdmissionProbe{WorkspaceService: service}
			switch mode {
			case "workspace":
				probe.workspace = ownerWorkspace.ID
			case "operation":
				probe.operation = other
			case "actor":
				probe.actor = f.owner.ID
			case "repository":
				probe.repository = f.repoID + 1
			}
			handler.Service = probe
			defer func() { handler.Service = service }()
			out, commands := call("cancel-member", "", workspace.ID, ready)
			require.Equal(t, 403, out.Code, out.Body.String())
			require.Equal(t, []string{"runs.cancel"}, commands)
			unchanged(ready)
			unchanged(other)
		})
	}
	t.Run("member cancels ready work once", func(t *testing.T) {
		for range 2 {
			out, commands := call("cancel-member", "", workspace.ID, ready)
			require.Equal(t, 200, out.Code, out.Body.String())
			require.Contains(t, out.Body.String(), `"state":"cancelled"`)
			require.Equal(t, []string{"runs.cancel"}, commands)
		}
		var events int
		require.NoError(t, pool.QueryRow(f.ctx, "SELECT count(*) FROM product_job_events WHERE operation_id=$1 AND event_type='operation.cancelled'", ready).Scan(&events))
		require.Equal(t, 1, events)
	})
	t.Run("running cancellation awaits worker receipt", func(t *testing.T) {
		id := seed("claimed")
		claim, err := store.ClaimOperation(f.ctx, "cancel-fixture", time.Minute, id)
		require.NoError(t, err)
		out, commands := call("cancel-member", "", workspace.ID, id)
		require.Equal(t, 202, out.Code, out.Body.String())
		require.Equal(t, []string{"runs.cancel"}, commands)
		require.NotContains(t, out.Body.String(), `"state":"cancelled"`)
		value, err := store.Get(f.ctx, scope, id)
		require.NoError(t, err)
		require.True(t, value.CancellationRequested)
		require.False(t, value.State.Terminal())
		require.NoError(t, store.AcknowledgeCancellation(f.ctx, claim, json.RawMessage(`{"stopped":true}`)))
		value, err = store.Get(f.ctx, scope, id)
		require.NoError(t, err)
		require.Equal(t, jobs.StateCancelled, value.State)
	})
	t.Run("shared workspace requires a live write grant", func(t *testing.T) {
		seedShared := func(name string) string {
			payload, err := json.Marshal(map[string]any{"WorkspaceID": ownerWorkspace.ID, "RepositoryID": f.repoID, "UserID": f.other.ID, "EncryptedInput": "fixture ciphertext"})
			require.NoError(t, err)
			receipt, err := store.Admit(f.ctx, jobs.Admission{Scope: scope, Operation: "workspace.command", RequestID: name, Payload: payload, EffectPolicy: jobs.EffectUnsafe})
			require.NoError(t, err)
			return receipt.OperationID
		}
		grant := func(level string) {
			_, err := q.UpsertWorkspaceShare(f.ctx, db.UpsertWorkspaceShareParams{WorkspaceID: ownerWorkspace.ID, OwnerUserID: f.owner.ID, GranteeUserID: f.other.ID, Level: level})
			require.NoError(t, err)
		}
		id := seedShared("shared-readonly")
		grant("read")
		out, commands := call("cancel-member", "", ownerWorkspace.ID, id)
		require.Equal(t, 403, out.Code, out.Body.String())
		require.Equal(t, []string{"runs.cancel"}, commands)
		unchanged(id)
		grant("write")
		out, commands = call("cancel-member", "", ownerWorkspace.ID, id)
		require.Equal(t, 200, out.Code, out.Body.String())
		require.Contains(t, out.Body.String(), `"state":"cancelled"`)
		require.Equal(t, []string{"runs.cancel"}, commands)
		id = seedShared("shared-revoked")
		handler.Service = &commandCancelAdmissionProbe{WorkspaceService: service, before: func() {
			require.NoError(t, q.DeleteWorkspaceShare(f.ctx, db.DeleteWorkspaceShareParams{WorkspaceID: ownerWorkspace.ID, GranteeUserID: f.other.ID}))
		}}
		defer func() { handler.Service = service }()
		out, commands = call("cancel-member", "", ownerWorkspace.ID, id)
		require.Equal(t, 403, out.Code, out.Body.String())
		require.Equal(t, []string{"runs.cancel"}, commands)
		unchanged(id)
	})
	t.Run("expiry after admission", func(t *testing.T) {
		handler.Service = &commandCancelAdmissionProbe{WorkspaceService: service, before: func() {
			_, err := f.pool.Exec(f.ctx, "UPDATE auth_sessions SET expires_at=now()-interval '1 second' WHERE session_key=$1", memberHash)
			require.NoError(t, err)
		}}
		defer func() { handler.Service = service }()
		out, commands := call("cancel-member", "", workspace.ID, other)
		require.Equal(t, 401, out.Code, out.Body.String())
		require.Equal(t, []string{"runs.cancel"}, commands)
		unchanged(other)
	})
	t.Run("clock expiry while dispatch is locked rolls back cancellation", func(t *testing.T) {
		expires := time.Now().Add(2 * time.Second)
		_, err := f.pool.Exec(f.ctx, "UPDATE auth_sessions SET expires_at=$2 WHERE session_key=$1", memberHash, expires)
		require.NoError(t, err)
		block, err := f.pool.Begin(f.ctx)
		require.NoError(t, err)
		defer block.Rollback(context.WithoutCancel(f.ctx))
		_, err = block.Exec(f.ctx, "SELECT operation_id FROM product_job_dispatches WHERE operation_id=$1::uuid FOR UPDATE", other)
		require.NoError(t, err)
		conn, err := pool.Acquire(f.ctx)
		require.NoError(t, err)
		pid := conn.Conn().PgConn().PID()
		conn.Release()
		done := make(chan *httptest.ResponseRecorder, 1)
		go func() { out, _ := call("cancel-member", "", workspace.ID, other); done <- out }()
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
			t.Fatal("expired cancellation did not settle")
		}
		unchanged(other)
		var events int
		require.NoError(t, pool.QueryRow(f.ctx, "SELECT count(*) FROM product_job_events WHERE operation_id=$1 AND event_type LIKE 'operation.cancel%'", other).Scan(&events))
		require.Zero(t, events)
	})
	_, err = service.CancelWorkspaceCommandRun(context.Background(), workspace.ID, f.repoID, f.other.ID, other)
	require.Error(t, err)
	unchanged(other)
}
