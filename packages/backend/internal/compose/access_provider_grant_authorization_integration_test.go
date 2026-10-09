package compose

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
	"github.com/stretchr/testify/require"
)

// The local upstream observes actual account selection and outbound bytes.
// Stored machine grants are fixture inputs; guest publication is not qualified.
func TestAccessProviderGrantMatrixComposedPostgres(t *testing.T) {
	f := newLandingGateFixtureWithFactory(t, nil, "", true)
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode, cfg.Auth.SessionCookieName = "selfhost", "session"
	cfg.Server.PublicURL = "http://example.com"
	cfg.Server.AllowedOrigins = []string{cfg.Server.PublicURL}
	maintainer, err := f.q.CreateUser(f.ctx, db.CreateUserParams{Username: "pool-maintainer", LowerUsername: "pool-maintainer"})
	require.NoError(t, err)
	_, err = f.pool.Exec(f.ctx, `INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,'admin')`, f.repoID, maintainer.ID)
	require.NoError(t, err)
	codec, err := webhook.NewSecretCodec("pool-matrix-host-key")
	require.NoError(t, err)
	require.NoError(t, f.q.UpsertInstallSetting(f.ctx, db.UpsertInstallSettingParams{Key: "models.chatgpt", Value: []byte("true")}))
	pool := services.NewProviderConnectionService(f.q, codec, nil, services.WithSubscriptionConnectionsEnabled(true))
	var sends atomic.Int64
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sends.Add(1)
		raw, err := io.ReadAll(r.Body)
		if err != nil || string(raw) != `{"model":"matrix-local","messages":[]}` || r.URL.Path != "/v1/messages" {
			w.WriteHeader(400)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"id":"matrix-response"}`)
	}))
	defer upstream.Close()
	handler := &routes.ProviderConnectionHandler{Service: pool, Pool: &routes.ProviderPoolHandler{Pool: pool, Scopes: services.NewProviderPoolScopes(f.q, f.pool, codec, true), Upstreams: map[string]string{"anthropic": upstream.URL}}}
	router := githubAppSetupComposeRouter(cfg, f.pool, nil, handler)
	issuer := services.NewAuthService(f.q, cfg.Auth, nil, nil)
	issuer.Members = &services.Members{Pool: f.pool}
	index, cells := 0, 0
	mint := func(user db.User, name, scopes string, system bool) string {
		index++
		token := f.token(user, fmt.Sprintf("pool-cell-%d", index), scopes, system)
		sum := sha256.Sum256([]byte(token))
		_, err := f.pool.Exec(f.ctx, `UPDATE access_tokens SET name=$2 WHERE token_hash=$1`, hex.EncodeToString(sum[:]), name)
		require.NoError(t, err)
		return token
	}
	for _, user := range []db.User{f.owner, maintainer, f.other} {
		t.Run(user.Username, func(t *testing.T) {
			workspace, err := f.q.CreateWorkspace(f.ctx, db.CreateWorkspaceParams{RepositoryID: f.repoID, UserID: user.ID, Name: "pool-" + user.Username, Kind: "container", Status: "running", TargetBookmark: "main"})
			require.NoError(t, err)
			cipher, err := codec.EncryptString("sk-ant-api03-matrix-local-abcdefghijklmnopqrstuvwxyz0123456789")
			require.NoError(t, err)
			connection, err := f.q.CreateProviderConnection(f.ctx, db.CreateProviderConnectionParams{OwnerType: "user", UserID: pgtype.Int8{Int64: user.ID, Valid: true}, Provider: "claude", Kind: "api_key", Label: "matrix-local", AccessTokenEncrypted: []byte(cipher), CreatedBy: pgtype.Int8{Int64: user.ID, Valid: true}})
			require.NoError(t, err)
			_, err = f.q.AddProviderConnectionGrant(f.ctx, db.AddProviderConnectionGrantParams{ConnectionID: connection.ID, RepositoryID: pgtype.Int8{Int64: f.repoID, Valid: true}})
			require.NoError(t, err)
			cookie := "pool-session-" + user.Username
			sum := sha256.Sum256([]byte(cookie))
			_, err = f.q.CreateAuthSession(f.ctx, db.CreateAuthSessionParams{UserID: user.ID, Username: user.Username, SessionKey: hex.EncodeToString(sum[:]), ExpiresAt: time.Now().Add(time.Hour)})
			require.NoError(t, err)
			scopes := services.ProviderPoolTokenScopes(f.repoID, workspace.ID)
			name := "provider-pool-workspace-" + workspace.ID
			machine := mint(user, name, scopes, true)
			type actor struct {
				name, token       string
				status, decisions int
			}
			actors := []actor{
				{"machine", machine, 200, 1}, {"session", "", 401, 0},
				{"wrong-publisher", mint(user, "wrong-publisher", scopes, true), 403, 1},
				{"not-system-issued", mint(user, name, scopes, false), 401, 0},
				{"missing-read", mint(user, name, middleware.RepositoryRestrictionScope(f.repoID)+","+middleware.WorkspaceRestrictionScope(workspace.ID), true), 403, 1},
				{"missing-repository", mint(user, name, "read:workspace,"+middleware.WorkspaceRestrictionScope(workspace.ID), true), 403, 1},
				{"missing-workspace", mint(user, name, "read:workspace,"+middleware.RepositoryRestrictionScope(f.repoID), true), 403, 1},
				{"foreign-repository", mint(user, name, services.ProviderPoolTokenScopes(f.repoID+1, workspace.ID), true), 403, 1},
				{"foreign-owner", mint(f.other, name, scopes, true), 403, 1},
			}
			// The Member's foreign owner must really differ from that Member.
			if user.ID == f.other.ID {
				actors[len(actors)-1].token = mint(f.owner, name, scopes, true)
			}
			for _, via := range []string{"cli", "codex", "claude-code"} {
				token, err := issuer.CreateToken(f.ctx, user.ID, services.CreateTokenRequest{Name: "pool-" + via, Via: via, Scopes: []string{"repo", "user"}})
				require.NoError(t, err)
				actors = append(actors, actor{via, token.Token, 403, 1})
			}
			turn, err := issuer.MintForTurn(f.ctx, user.ID, liveAppTurnCredentialFixture(t, f.pool, user.ID), 1)
			require.NoError(t, err)
			actors = append(actors, actor{"app-agent", turn.Token, 403, 1})
			expired := mint(user, name, scopes, true)
			sum = sha256.Sum256([]byte(expired))
			_, err = f.pool.Exec(f.ctx, `UPDATE access_tokens SET expires_at=now()-interval '1 second' WHERE token_hash=$1`, hex.EncodeToString(sum[:]))
			require.NoError(t, err)
			actors = append(actors, actor{"expired", expired, 401, 0})
			var afterRequest func()
			runActor := func(t *testing.T, a actor) {
				for _, door := range []struct{ method, path string }{{"GET", "/provider-pool/routes"}, {"POST", "/provider-pool/anthropic/v1/messages"}} {
					t.Run(a.name+"/"+door.method, func(t *testing.T) {
						beforeSends := sends.Load()
						before, err := f.q.GetProviderConnection(f.ctx, connection.ID)
						require.NoError(t, err)
						req := httptest.NewRequest(door.method, cfg.Server.PublicURL+door.path, strings.NewReader(`{"model":"matrix-local","messages":[]}`))
						req.Header.Set("Content-Type", "application/json")
						req.Header.Set("Smithers-Actor", "person")
						req.Header.Set("Smithers-Via", "terminal")
						if a.token == "" {
							req.AddCookie(&http.Cookie{Name: "session", Value: cookie})
						} else {
							req.Header.Set("Authorization", "Bearer "+a.token)
						}
						var decisions []string
						req = req.WithContext(services.WithAuthorizationObserver(req.Context(), func(command string) { decisions = append(decisions, command) }))
						out := httptest.NewRecorder()
						router.ServeHTTP(out, req)
						if afterRequest != nil {
							afterRequest()
						}
						require.Equal(t, a.status, out.Code, out.Body.String())
						require.Len(t, decisions, a.decisions)
						if a.decisions == 1 {
							require.Equal(t, "workspace.provider-pool", decisions[0])
						}
						after, err := f.q.GetProviderConnection(f.ctx, connection.ID)
						require.NoError(t, err)
						if a.status != 200 {
							if a.name == "session" {
								require.Contains(t, out.Body.String(), `"type":"authentication_error"`)
							} else {
								require.Contains(t, out.Body.String(), `"class":"permission"`)
								require.Contains(t, out.Body.String(), `"code":"`+map[bool]string{true: "unauthenticated", false: "permission"}[a.status == 401]+`"`)
							}
							require.NotContains(t, out.Body.String(), "matrix-response")
							require.Equal(t, before, after, "refusal cannot rotate an account")
							require.Equal(t, beforeSends, sends.Load(), "refusal cannot send a model call")
						} else if door.method == "POST" {
							require.JSONEq(t, `{"id":"matrix-response"}`, out.Body.String())
							require.Equal(t, beforeSends+1, sends.Load())
							require.True(t, after.LastUsedAt.Valid)
						} else {
							require.Contains(t, out.Body.String(), "anthropic")
							require.NotContains(t, out.Body.String(), "sk-ant")
							require.Equal(t, beforeSends, sends.Load())
						}
						cells++
					})
				}
			}
			for _, a := range actors {
				runActor(t, a)
			}
			sum = sha256.Sum256([]byte(machine))
			hash := hex.EncodeToString(sum[:])
			type transition struct {
				name, change, restore string
				key                   any
				status                int
			}
			changes := []transition{
				{"expiry", `UPDATE access_tokens SET expires_at=now()-interval '1 second' WHERE token_hash=$1`, `UPDATE access_tokens SET expires_at=now()+interval '1 hour' WHERE token_hash=$1`, hash, 401},
				{"suspension", `UPDATE users SET prohibit_login=true WHERE id=$1`, `UPDATE users SET prohibit_login=false WHERE id=$1`, user.ID, 401},
				{"workspace-deletion", `UPDATE workspaces SET deleted_at=now() WHERE id=$1`, `UPDATE workspaces SET deleted_at=NULL WHERE id=$1`, workspace.ID, 403},
			}
			if user.ID != f.owner.ID {
				permission := "write"
				if user.ID == maintainer.ID {
					permission = "admin"
				}
				changes = append(changes, transition{"member-removal", fmt.Sprintf(`DELETE FROM collaborators WHERE repository_id=%d AND user_id=$1`, f.repoID), fmt.Sprintf(`INSERT INTO collaborators(repository_id,user_id,permission) VALUES(%d,$1,'%s') ON CONFLICT DO NOTHING`, f.repoID, permission), user.ID, 401})
			}
			for _, change := range changes {
				for _, order := range []string{"before-admission", "after-authorization"} {
					t.Run(change.name+"/"+order, func(t *testing.T) {
						original := handler.Pool.Scopes
						defer func() {
							handler.Pool.Scopes = original
							afterRequest = nil
							_, err := f.pool.Exec(f.ctx, change.restore, change.key)
							require.NoError(t, err)
						}()
						mutate := func() { _, err := f.pool.Exec(f.ctx, change.change, change.key); require.NoError(t, err) }
						decisions := 1
						if order == "before-admission" {
							mutate()
							if change.status == 401 {
								decisions = 0
							}
						} else {
							real, ok := original.(*services.ProviderPoolScopes)
							require.True(t, ok)
							handler.Pool.Scopes = &poolAfterAuthorization{ProviderPoolScopes: real, after: mutate}
							afterRequest = func() { _, err := f.pool.Exec(f.ctx, change.restore, change.key); require.NoError(t, err) }
						}
						runActor(t, actor{change.name, machine, change.status, decisions})
					})
				}
			}
		})
	}
	require.Equal(t, 128, cells)
	require.EqualValues(t, 3, sends.Load())
	t.Logf("provider grants: %d composed HTTP cells, three real local outbound effects; guest publication unqualified", cells)
}
