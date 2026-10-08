package compose

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

func TestInstallDevtoolsWriteAuthorizationPostgres(t *testing.T) {
	f := newLandingGateFixtureWithFactory(t, nil, "", true)
	pool, err := postgresfixture.Open(f.ctx, f.pool.Config().ConnConfig.ConnString(), 1)
	require.NoError(t, err)
	defer pool.Close()
	q := db.New(pool)
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Auth.SessionCookieName = "session"
	cfg.Auth.SessionRefreshWindow = "0s"
	cfg.FeatureFlags.DevtoolsSnapshotEnabled = true
	cfg.Server.PublicURL = "http://example.com"
	cfg.Server.AllowedOrigins = []string{cfg.Server.PublicURL}
	router := githubAppSetupComposeRouter(cfg, pool, nil, nil)
	session := func(user db.User, raw string) string {
		sum := sha256.Sum256([]byte(raw))
		hash := hex.EncodeToString(sum[:])
		_, err := q.CreateAuthSession(f.ctx, db.CreateAuthSessionParams{UserID: user.ID, Username: user.Username, SessionKey: hash, ExpiresAt: time.Now().Add(time.Hour)})
		require.NoError(t, err)
		return hash
	}
	hash := session(f.other, "snapshot-writer")
	session(f.owner, "snapshot-owner")
	seed := func(user db.User) string {
		id := uuid.NewString()
		_, err := q.CreateAgentSession(f.ctx, db.CreateAgentSessionParams{ID: id, RepositoryID: f.repoID, UserID: user.ID, Title: "private snapshot", Status: "active", Metadata: []byte(`{}`)})
		require.NoError(t, err)
		return id
	}
	own, foreign := seed(f.other), seed(f.owner)
	workspace := uuid.NewString()
	maintainer, err := q.CreateUser(f.ctx, db.CreateUserParams{Username: "snapshot-maintainer", LowerUsername: "snapshot-maintainer"})
	require.NoError(t, err)
	_, err = f.pool.Exec(f.ctx, `INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,'admin')`, f.repoID, maintainer.ID)
	require.NoError(t, err)
	session(maintainer, "snapshot-maintainer")
	maintained := seed(maintainer)
	app := f.token(f.other, "snapshot-app", "write:repository,via:smithers,terminal-session:"+liveAppTurnCredentialFixture(t, f.pool, f.other.ID)+"/1", true)
	external := f.token(f.other, "snapshot-external", "write:repository,via:codex", true)
	run := f.token(f.other, "snapshot-run", "write:repository", true)
	machine := f.token(f.other, "snapshot-machine", "write:repository,"+middleware.WorkspaceRestrictionScope(workspace), true)
	limited := f.token(f.other, "snapshot-limited", "read:repository,via:codex", true)
	body := func(id, value string) string {
		raw, err := json.Marshal(routes.DevtoolsSnapshotWriteRequest{SessionID: id, Kind: "console", WorkspaceID: &workspace, Payload: json.RawMessage(`{"private":"` + value + `"}`)})
		require.NoError(t, err)
		return string(raw)
	}
	request := func(ctx context.Context, cookie, token, body string) *http.Request {
		req := httptest.NewRequest("POST", cfg.Server.PublicURL+"/api/repos/gate-owner/app/devtools/snapshots", strings.NewReader(body)).WithContext(ctx)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Origin", cfg.Server.PublicURL)
		if cookie != "" {
			req.AddCookie(&http.Cookie{Name: "session", Value: cookie})
			req.AddCookie(&http.Cookie{Name: middleware.CSRFCookieName, Value: "snapshot-csrf"})
			req.Header.Set("X-CSRF-Token", "snapshot-csrf")
		}
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		return req
	}
	call := func(t *testing.T, cookie, token, body string, status int) *httptest.ResponseRecorder {
		t.Helper()
		ctx, cancel := context.WithTimeout(f.ctx, 7*time.Second)
		defer cancel()
		commands := []string{}
		ctx = services.WithAuthorizationObserver(ctx, func(command string) { commands = append(commands, command) })
		out := httptest.NewRecorder()
		router.ServeHTTP(out, request(ctx, cookie, token, body))
		require.Equal(t, status, out.Code, out.Body.String())
		require.Equal(t, []string{"devtools.write"}, commands)
		return out
	}

	count := func(want int) {
		var got int
		err := f.pool.QueryRow(f.ctx, `SELECT count(*) FROM devtools_snapshots WHERE repository_id=$1`, f.repoID).Scan(&got)
		require.NoError(t, err)
		require.Equal(t, want, got)
	}
	for _, a := range []struct {
		name, cookie, token, id string
		status                  int
	}{
		{"external", "", external, own, 403}, {"run", "", run, own, 403}, {"machine", "", machine, own, 403}, {"scope", "", limited, own, 403}, {"anonymous", "", "", own, 401}, {"owner cannot overwrite member", "snapshot-owner", "", own, 403}, {"member cannot overwrite owner", "snapshot-writer", "", foreign, 403}, {"app cannot overwrite owner", "", app, foreign, 403},
	} {
		t.Run(a.name, func(t *testing.T) { call(t, a.cookie, a.token, body(a.id, "denied"), a.status); count(0) })
	}
	for _, a := range []struct{ name, cookie, token, id string }{{"member", "snapshot-writer", "", own}, {"owner", "snapshot-owner", "", foreign}, {"maintainer", "snapshot-maintainer", "", maintained}, {"app", "", app, own}} {
		t.Run(a.name, func(t *testing.T) {
			out := call(t, a.cookie, a.token, body(a.id, a.name), 201)
			require.Contains(t, out.Body.String(), a.id+":command_output")
			row, err := q.GetDevtoolsSnapshot(f.ctx, db.GetDevtoolsSnapshotParams{SessionID: a.id, Kind: "command_output"})
			require.NoError(t, err)
			require.JSONEq(t, `{"private":"`+a.name+`","workspace_id":"`+workspace+`"}`, string(row.Payload))
		})
	}
	count(3)
	stored := func() {
		row, err := q.GetDevtoolsSnapshot(f.ctx, db.GetDevtoolsSnapshotParams{SessionID: own, Kind: "command_output"})
		require.NoError(t, err)
		require.JSONEq(t, `{"private":"app","workspace_id":"`+workspace+`"}`, string(row.Payload))
		count(3)
	}
	t.Run("bound body and selectors", func(t *testing.T) {
		var request routes.DevtoolsSnapshotWriteRequest
		require.NoError(t, json.Unmarshal([]byte(body(own, "changed")), &request))
		input, err := routes.DevtoolsSnapshotWriteInput(f.repoID, request)
		require.NoError(t, err)
		api := services.NewDevtoolsSnapshotAPI(q, pool)
		ctx := middleware.ContextWithAuthInfo(f.ctx, &middleware.AuthInfo{User: &f.other, SessionHash: hash})
		subject := services.InstallDevtoolsSnapshotWriteSubject(f.repoID, input)
		decision, err := services.Authorize(ctx, q, "devtools.write", subject)
		require.NoError(t, err)
		ctx = services.WithInstallAuthorization(ctx, "devtools.write", decision, subject)
		for _, replace := range []string{"payload", "session", "kind", "workspace", "repository", "actor"} {
			t.Run(replace, func(t *testing.T) {
				changed := input
				repo, actor := f.repoID, f.other.ID
				switch replace {
				case "payload":
					changed.Payload = []byte(`{"private":"substituted"}`)
				case "session":
					changed.SessionID = foreign
				case "kind":
					changed.Kind = "tool_state"
				case "workspace":
					changed.WorkspaceID = ""
				case "repository":
					repo++
				case "actor":
					actor = f.owner.ID
				}
				_, err := api.Write(ctx, repo, actor, changed)
				var access *services.AccessError
				require.ErrorAs(t, err, &access)
				require.Equal(t, 403, access.Status)
				stored()
			})
		}
		_, err = api.Write(f.ctx, f.repoID, f.other.ID, input)
		require.Error(t, err)
		stored()
		_, err = f.pool.Exec(f.ctx, `UPDATE auth_sessions SET expires_at=now()-interval '1 second' WHERE session_key=$1`, hash)
		require.NoError(t, err)
		defer func() {
			_, err := f.pool.Exec(f.ctx, `UPDATE auth_sessions SET expires_at=now()+interval '1 hour' WHERE session_key=$1`, hash)
			require.NoError(t, err)
		}()
		_, err = api.Write(ctx, f.repoID, f.other.ID, input)
		var access *services.AccessError
		require.ErrorAs(t, err, &access)
		require.Equal(t, 401, access.Status)
		stored()
	})
	t.Run("clock expiry rolls back a blocked upload", func(t *testing.T) {
		ctx, cancel := context.WithTimeout(f.ctx, 12*time.Second)
		defer cancel()
		held, err := f.pool.Begin(ctx)
		require.NoError(t, err)
		defer held.Rollback(context.Background())
		_, err = held.Exec(ctx, `SELECT session_id FROM devtools_snapshots WHERE session_id=$1 FOR UPDATE`, own)
		require.NoError(t, err)
		deadline := time.Now().Add(4 * time.Second)
		_, err = f.pool.Exec(ctx, `UPDATE auth_sessions SET expires_at=$2 WHERE session_key=$1`, hash, deadline)
		require.NoError(t, err)
		defer func() {
			_, err := f.pool.Exec(f.ctx, `UPDATE auth_sessions SET expires_at=now()+interval '1 hour' WHERE session_key=$1`, hash)
			require.NoError(t, err)
		}()
		commands := []string{}
		req := request(services.WithAuthorizationObserver(ctx, func(command string) { commands = append(commands, command) }), "snapshot-writer", "", body(own, "expired"))
		done := make(chan *httptest.ResponseRecorder, 1)
		go func() { out := httptest.NewRecorder(); router.ServeHTTP(out, req); done <- out }()
		require.Eventually(t, func() bool {
			var count int
			err := f.pool.QueryRow(ctx, `SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%INSERT INTO devtools_snapshots%'`).Scan(&count)
			return err == nil && count == 1
		}, 3*time.Second, 10*time.Millisecond)
		timer := time.NewTimer(time.Until(deadline) + 25*time.Millisecond)
		defer timer.Stop()
		select {
		case <-timer.C:
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
		require.NoError(t, held.Commit(ctx))
		select {
		case out := <-done:
			require.Equal(t, 401, out.Code, out.Body.String())
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
		require.Equal(t, []string{"devtools.write"}, commands)
		stored()
	})
	t.Run("invalid or missing targets preserve snapshots", func(t *testing.T) {
		call(t, "snapshot-writer", "", body(uuid.NewString(), "unknown"), 404)
		stored()
		call(t, "snapshot-writer", "", `{"session_id":"`+own+`","kind":"console","payload":null}`, 422)
		stored()
		call(t, "snapshot-writer", "", `{"session_id":"`+own+`","kind":"console","payload":3}`, 422)
		stored()
		_, err := f.pool.Exec(f.ctx, `UPDATE agent_sessions SET deleted_at=now() WHERE id=$1`, own)
		require.NoError(t, err)
		defer func() {
			_, err := f.pool.Exec(f.ctx, `UPDATE agent_sessions SET deleted_at=NULL WHERE id=$1`, own)
			require.NoError(t, err)
		}()
		call(t, "snapshot-writer", "", body(own, "deleted"), 404)
		stored()
	})
	t.Run("disabled feature stays unavailable", func(t *testing.T) {
		cfg.FeatureFlags.DevtoolsSnapshotEnabled = false
		router = githubAppSetupComposeRouter(cfg, pool, nil, nil)
		call(t, "snapshot-writer", "", body(own, "disabled"), 404)
		stored()
	})
}
