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

	"github.com/google/uuid"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

func TestInstallDevtoolsReadAuthorizationPostgres(t *testing.T) {
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
	router := githubAppSetupComposeRouter(cfg, pool, nil, nil)
	session := func(user db.User, raw string) string {
		sum := sha256.Sum256([]byte(raw))
		hash := hex.EncodeToString(sum[:])
		_, err := q.CreateAuthSession(f.ctx, db.CreateAuthSessionParams{UserID: user.ID, Username: user.Username, SessionKey: hash, ExpiresAt: time.Now().Add(time.Hour)})
		require.NoError(t, err)
		return hash
	}
	hash := session(f.other, "devtools-member")
	session(f.owner, "devtools-owner")
	workspace := uuid.NewString()
	seed := func(user db.User, name string) string {
		id := uuid.NewString()
		_, err := q.CreateAgentSession(f.ctx, db.CreateAgentSessionParams{ID: id, RepositoryID: f.repoID, UserID: user.ID, Title: name, Status: "active", Metadata: []byte(`{}`)})
		require.NoError(t, err)
		for _, kind := range []string{"command_output", "tool_state"} {
			_, err = q.UpsertDevtoolsSnapshot(f.ctx, db.UpsertDevtoolsSnapshotParams{SessionID: id, RepositoryID: f.repoID, Kind: kind, Payload: []byte(`{"private":"` + name + `","workspace_id":"` + workspace + `"}`)})
			require.NoError(t, err)
		}
		return id
	}
	own := seed(f.other, "member private output")
	foreign := seed(f.owner, "owner private output")
	maintainer, err := q.CreateUser(f.ctx, db.CreateUserParams{Username: "devtools-maintainer", LowerUsername: "devtools-maintainer"})
	require.NoError(t, err)
	_, err = f.pool.Exec(f.ctx, `INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,'admin')`, f.repoID, maintainer.ID)
	require.NoError(t, err)
	session(maintainer, "devtools-maintainer")
	maintained := seed(maintainer, "maintainer private output")
	app := f.token(f.other, "devtools-app", "read:repository,via:smithers,terminal-session:"+liveAppTurnCredentialFixture(t, f.pool, f.other.ID)+"/1", true)
	external := f.token(f.other, "devtools-external", "read:repository,via:codex", true)
	run := f.token(f.other, "devtools-run", "read:repository", true)
	machine := f.token(f.other, "devtools-machine", "read:repository,"+middleware.WorkspaceRestrictionScope(workspace), true)
	limited := f.token(f.other, "devtools-limited", "read:user,via:codex", true)
	request := func(ctx context.Context, path, query, cookie, token string) *http.Request {
		req := httptest.NewRequest("GET", cfg.Server.PublicURL+"/api/repos/gate-owner/app/devtools/snapshots"+path+"?"+query, nil).WithContext(ctx)
		if cookie != "" {
			req.AddCookie(&http.Cookie{Name: "session", Value: cookie})
		}
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		return req
	}
	call := func(t *testing.T, path, query, cookie, token string, status int) *httptest.ResponseRecorder {
		t.Helper()
		ctx, cancel := context.WithTimeout(f.ctx, 7*time.Second)
		defer cancel()
		commands := []string{}
		ctx = services.WithAuthorizationObserver(ctx, func(command string) { commands = append(commands, command) })
		out := httptest.NewRecorder()
		router.ServeHTTP(out, request(ctx, path, query, cookie, token))
		require.Equal(t, status, out.Code, out.Body.String())
		require.Equal(t, []string{"devtools.read"}, commands)
		return out
	}
	for _, path := range []string{"", "/latest"} {
		for _, a := range []struct {
			name, cookie, token, id string
			status                  int
		}{
			{"member", "devtools-member", "", own, 200}, {"owner", "devtools-owner", "", foreign, 200}, {"maintainer", "devtools-maintainer", "", maintained, 200}, {"app", "", app, own, 200}, {"external", "", external, own, 403}, {"run", "", run, own, 403}, {"machine", "", machine, own, 403}, {"scope", "", limited, own, 403}, {"anonymous", "", "", own, 401},
		} {
			t.Run(path+"/"+a.name, func(t *testing.T) {
				out := call(t, path, "session_id="+a.id+"&kind=console&workspace_id="+workspace, a.cookie, a.token, a.status)
				if a.status == 200 {
					require.Contains(t, out.Body.String(), `"kind":"command_output"`)
					require.NotContains(t, out.Body.String(), `"kind":"tool_state"`)
				} else {
					require.NotContains(t, out.Body.String(), "private output")
				}
			})
		}
		t.Run(path+"/list and filters", func(t *testing.T) {
			out := call(t, path, "session_id="+own, "devtools-member", "", 200)
			require.Contains(t, out.Body.String(), `"kind":"tool_state"`)
			require.Contains(t, out.Body.String(), `"kind":"command_output"`)
			call(t, path, "session_id="+own+"&workspace_id="+uuid.NewString(), "devtools-member", "", 404)
		})
		t.Run(path+"/private sessions", func(t *testing.T) {
			call(t, path, "session_id="+own, "devtools-owner", "", 403)
			call(t, path, "session_id="+foreign, "devtools-member", "", 403)
			call(t, path, "session_id="+foreign, "", app, 403)
			call(t, path, "session_id="+uuid.NewString(), "devtools-member", "", 404)
		})
	}
	for _, tc := range []struct {
		query  string
		status int
	}{{"session_id=bad", 422}, {"session_id=" + own + "&kind=bad", 422}, {"session_id=" + own + "&workspace_id=bad", 422}, {"session_id=" + own + "&repository_id=bad", 400}} {
		t.Run(tc.query, func(t *testing.T) {
			out := call(t, "", tc.query, "devtools-member", "", tc.status)
			require.NotContains(t, out.Body.String(), "private output")
		})
	}

	t.Run("deleted session has no retained snapshot door", func(t *testing.T) {
		_, err := f.pool.Exec(f.ctx, `UPDATE agent_sessions SET deleted_at=now() WHERE id=$1`, own)
		require.NoError(t, err)
		defer func() {
			_, err := f.pool.Exec(f.ctx, `UPDATE agent_sessions SET deleted_at=NULL WHERE id=$1`, own)
			require.NoError(t, err)
		}()
		call(t, "", "session_id="+own, "devtools-member", "", 404)
	})
	reader := services.NewDevtoolsSnapshotReader(q, pool)
	authenticated := func() context.Context {
		return middleware.ContextWithAuthInfo(f.ctx, &middleware.AuthInfo{User: &f.other, SessionHash: hash})
	}
	input := services.DevtoolsSnapshotReadInput{SessionID: own, Kind: "command_output", WorkspaceID: workspace}
	t.Run("bound subject and actor", func(t *testing.T) {
		ctx := authenticated()
		subject := services.InstallDevtoolsSnapshotReadSubject(f.repoID, input)
		decision, err := services.Authorize(ctx, q, "devtools.read", subject)
		require.NoError(t, err)
		ctx = services.WithInstallAuthorization(ctx, "devtools.read", decision, subject)
		for _, replace := range []string{"session", "kind", "workspace", "repository", "actor"} {
			t.Run(replace, func(t *testing.T) {
				changed := input
				repo, actor := f.repoID, f.other.ID
				switch replace {
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
				_, err := reader.Read(ctx, repo, actor, changed)
				var access *services.AccessError
				require.ErrorAs(t, err, &access)
				require.Equal(t, 403, access.Status)
			})
		}
		_, err = reader.Read(f.ctx, f.repoID, f.other.ID, input)
		require.Error(t, err)
		_, err = f.pool.Exec(f.ctx, `UPDATE auth_sessions SET expires_at=now()-interval '1 second' WHERE session_key=$1`, hash)
		require.NoError(t, err)
		defer func() {
			_, err := f.pool.Exec(f.ctx, `UPDATE auth_sessions SET expires_at=now()+interval '1 hour' WHERE session_key=$1`, hash)
			require.NoError(t, err)
		}()
		_, err = reader.Read(ctx, f.repoID, f.other.ID, input)
		var access *services.AccessError
		require.ErrorAs(t, err, &access)
		require.Equal(t, 401, access.Status)
	})
	t.Run("clock expiry while session ownership is locked", func(t *testing.T) {
		ctx, cancel := context.WithTimeout(f.ctx, 12*time.Second)
		defer cancel()
		held, err := f.pool.Begin(ctx)
		require.NoError(t, err)
		defer held.Rollback(context.Background())
		_, err = held.Exec(ctx, `SELECT id FROM agent_sessions WHERE id=$1 FOR UPDATE`, own)
		require.NoError(t, err)
		deadline := time.Now().Add(4 * time.Second)
		_, err = f.pool.Exec(ctx, `UPDATE auth_sessions SET expires_at=$2 WHERE session_key=$1`, hash, deadline)
		require.NoError(t, err)
		defer func() {
			_, err := f.pool.Exec(f.ctx, `UPDATE auth_sessions SET expires_at=now()+interval '1 hour' WHERE session_key=$1`, hash)
			require.NoError(t, err)
		}()
		commands := []string{}
		req := request(services.WithAuthorizationObserver(ctx, func(command string) { commands = append(commands, command) }), "/latest", "session_id="+url.QueryEscape(own), "devtools-member", "")
		done := make(chan *httptest.ResponseRecorder, 1)
		go func() { out := httptest.NewRecorder(); router.ServeHTTP(out, req); done <- out }()
		require.Eventually(t, func() bool {
			var count int
			err := f.pool.QueryRow(ctx, `SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%FROM agent_sessions%FOR SHARE%'`).Scan(&count)
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
			require.False(t, strings.Contains(out.Body.String(), "private output"))
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
		require.Equal(t, []string{"devtools.read"}, commands)
	})
	t.Run("disabled snapshot feature remains unavailable", func(t *testing.T) {
		cfg.FeatureFlags.DevtoolsSnapshotEnabled = false
		router = githubAppSetupComposeRouter(cfg, pool, nil, nil)
		call(t, "", "session_id="+own, "devtools-member", "", 404)
	})
}
