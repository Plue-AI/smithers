package compose

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

// Hold an actual roster HTTP write after its single command authorization but
// before the transaction. Downgrade preserves that decision; credential death
// and repository replacement refuse the write before any roster effect.
func TestMemberWriteBoundDecisionAndLiveCredentialComposedInstall(t *testing.T) {
	for _, transition := range []string{"downgrade", "remove", "suspend", "disabled", "logout", "rebind"} {
		t.Run(transition, func(t *testing.T) {
			pool, _ := postgresfixture.NewProductDatabase(t)
			ctx := t.Context()
			q := db.New(pool)
			owner, err := q.CreateUser(ctx, db.CreateUserParams{Username: "owner", LowerUsername: "owner"})
			require.NoError(t, err)
			member, err := q.CreateUser(ctx, db.CreateUserParams{Username: "maintainer", LowerUsername: "maintainer"})
			require.NoError(t, err)
			_, err = pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, owner.ID)
			require.NoError(t, err)
			repo, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: owner.ID, Valid: true}, Name: "app", LowerName: "app", DefaultBookmark: "main"})
			require.NoError(t, err)
			binding := fmt.Sprintf(`{"owner_login":"owner","repository_name":"app","repository_id":%d}`, repo.ID)
			require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "github.repository", Value: []byte(binding)}))
			require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "owner.access", Value: []byte(strings.TrimSuffix(binding, "}") + `,"last_access_check_at":"2026-10-07T00:00:00Z"}`)}))
			for _, user := range []db.User{owner, member} {
				_, err = pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission,github_id,github_login) VALUES($1,$2,'admin',$3,$4)`, repo.ID, user.ID, rosterGitHubID(user.Username), user.Username)
				require.NoError(t, err)
				sum := sha256.Sum256([]byte(user.Username + "-cookie"))
				_, err = q.CreateAuthSession(ctx, db.CreateAuthSessionParams{UserID: user.ID, Username: user.Username, SessionKey: hex.EncodeToString(sum[:]), ExpiresAt: time.Now().Add(time.Hour)})
				require.NoError(t, err)
			}
			entered, release := make(chan struct{}), make(chan struct{})
			var once sync.Once
			unblock := func() { once.Do(func() { close(release) }) }
			defer unblock()
			github := &rosterGitHub{roles: map[string]string{"owner": "admin", "maintainer": "maintain", "writer": "write"}}
			provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/users/writer" {
					close(entered)
					select {
					case <-release:
					case <-r.Context().Done():
						return
					}
				}
				github.serve(w, r)
			}))
			// Unblock before closing even if a boundary assertion fails.
			defer func() { unblock(); provider.Close() }()
			t.Setenv("SMITHERS_GITHUB_APP_API_BASE_URL", provider.URL)
			members := &services.Members{Pool: pool, Credentials: rosterAppCredentials{}, Minter: services.NewRepoConnectionService(nil, rosterAppCredentials{})}
			cfg := testConfigAllFlagsOn()
			cfg.Auth.Mode, cfg.Auth.SessionCookieName = "selfhost", "session"
			cfg.Server.PublicURL = "http://example.com"
			cfg.Server.AllowedOrigins = []string{"http://example.com"}
			router := githubAppSetupComposeRouter(cfg, pool, nil, routerExtras{Members: &routes.MembersHandler{Service: members}})
			call := func(method, path, body, who string) *httptest.ResponseRecorder {
				r := httptest.NewRequest(method, "http://example.com"+path, strings.NewReader(body))
				r.Header.Set("Content-Type", "application/json")
				r.Header.Set("Origin", "http://example.com")
				r.Header.Set("X-CSRF-Token", "csrf-fixture")
				r.AddCookie(&http.Cookie{Name: "__csrf", Value: "csrf-fixture"})
				r.AddCookie(&http.Cookie{Name: "session", Value: who + "-cookie"})
				w := httptest.NewRecorder()
				router.ServeHTTP(w, r)
				return w
			}
			completed := make(chan *httptest.ResponseRecorder, 1)
			go func() { completed <- call("POST", "/api/members", `{"login":"writer"}`, "maintainer") }()
			select {
			case <-entered:
			case early := <-completed:
				t.Fatalf("request refused before provider: %d %s", early.Code, early.Body.String())
			case <-time.After(10 * time.Second):
				t.Fatal("roster write did not reach its provider")
			}
			switch transition {
			case "downgrade":
				w := call("PATCH", "/api/members/maintainer", `{"role":"member"}`, "owner")
				require.Equal(t, 204, w.Code, w.Body.String())
			case "remove":
				w := call("DELETE", "/api/members/maintainer", "", "owner")
				require.Equal(t, 204, w.Code, w.Body.String())
			case "suspend":
				_, err = pool.Exec(ctx, `UPDATE collaborators SET suspended_at=now() WHERE repository_id=$1 AND user_id=$2`, repo.ID, member.ID)
				require.NoError(t, err)
			case "disabled":
				_, err = pool.Exec(ctx, `UPDATE users SET is_active=false WHERE id=$1`, member.ID)
				require.NoError(t, err)
			case "logout":
				_, err = pool.Exec(ctx, `DELETE FROM auth_sessions WHERE user_id=$1`, member.ID)
				require.NoError(t, err)
			case "rebind":
				other, createErr := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: owner.ID, Valid: true}, Name: "other", LowerName: "other", DefaultBookmark: "main"})
				require.NoError(t, createErr)
				_, err = pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,'admin')`, other.ID, member.ID)
				require.NoError(t, err)
				replacement := fmt.Sprintf(`{"owner_login":"owner","repository_name":"other","repository_id":%d}`, other.ID)
				require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "github.repository", Value: []byte(replacement)}))
			}
			unblock()
			var w *httptest.ResponseRecorder
			select {
			case w = <-completed:
			case <-time.After(10 * time.Second):
				t.Fatal("roster write did not complete")
			}
			want := 401
			if transition == "downgrade" {
				want = 204
			}
			if transition == "rebind" {
				want = 403
			}
			require.Equal(t, want, w.Code, w.Body.String())
			if want == 401 {
				require.JSONEq(t, `{"class":"permission","code":"unauthenticated","message":"Sign in again"}`, w.Body.String())
			}
			var effects int
			require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM collaborators WHERE github_login='writer'`).Scan(&effects))
			if transition == "downgrade" {
				require.Equal(t, 1, effects)
				w = call("POST", "/api/members", `{"login":"writer"}`, "maintainer")
				require.Equal(t, 403, w.Code, w.Body.String())
			} else {
				require.Zero(t, effects)
			}
		})
	}
}
