package compose

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/stretchr/testify/require"
)

// Opt-in because it launches Chromium and Vite. PostgreSQL, session/CSRF auth,
// catalog dispatch, approvals, TODO effects and live transport are real. No
// browser route mocks or machine execution are involved in this control test.
func TestAccessMembersBrowserPostgres(t *testing.T) {
	if os.Getenv("SMITHERS_ACCESS_ASSETS_URL") == "" {
		t.Skip("run the C-ACC-01 Playwright spec for the composed browser journey")
	}
	ctx, cancel := context.WithTimeout(t.Context(), 4*time.Minute)
	defer cancel()
	_, _, pool := splitProcessDatabase(t)
	q := db.New(pool)
	owner, err := q.CreateUser(ctx, db.CreateUserParams{Username: "maya", LowerUsername: "maya", DisplayName: "Maya"})
	require.NoError(t, err)
	other, err := q.CreateUser(ctx, db.CreateUserParams{Username: "alice", LowerUsername: "alice", DisplayName: "Alice"})
	require.NoError(t, err)
	repo, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: owner.ID, Valid: true}, Name: "demo", LowerName: "demo", DefaultBookmark: "main"})
	require.NoError(t, err)
	for _, person := range []db.User{owner, other} {
		permission := "admin"
		if person.ID == other.ID {
			permission = "write"
		}
		_, err = pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,$3)`, repo.ID, person.ID, permission)
		require.NoError(t, err)
		sum := sha256.Sum256([]byte(person.Username + "-browser-session"))
		_, err = q.CreateAuthSession(ctx, db.CreateAuthSessionParams{UserID: person.ID, Username: person.Username, SessionKey: hex.EncodeToString(sum[:]), ExpiresAt: time.Now().Add(time.Hour)})
		require.NoError(t, err)
	}
	_, err = pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, owner.ID)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO mythical_stacks(repository_id,actor_user_id,state) VALUES($1,$2,'active')`, repo.ID, owner.ID)
	require.NoError(t, err)
	binding := []byte(fmt.Sprintf(`{"owner_login":"maya","repository_name":"demo","repository_id":%d}`, repo.ID))
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "github.repository", Value: binding}))
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "owner.access", Value: []byte(fmt.Sprintf(`{"owner_login":"maya","repository_name":"demo","repository_id":%d,"last_access_check_at":"%s"}`, repo.ID, time.Now().UTC().Format(time.RFC3339Nano)))}))
	_, err = q.CreateOrUpdateSecret(ctx, db.CreateOrUpdateSecretParams{RepositoryID: repo.ID, Name: "TEST_TOKEN", ValueEncrypted: []byte("never-return-this-value")})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO mythical_items(repository_id,source,state,title,issue_title,owner_id,created_by,revisions,number,stack_position,candidate_verified,pr_number,pr_url,pr_state,pr_head,candidate_head,checks)
 VALUES($1,'todo','proposed','Ready sample','Ready sample',$2,$2,'[{"text":"Ready sample","acceptance":[],"by":{"kind":"person","color_index":0,"login":"maya","name":"Maya","avatar_url":"https://example.com/maya.png"},"at":"2026-10-07T00:00:00Z"}]',1,1,true,1,'https://github.com/maya/demo/pull/1','open',$3,$3,'{"todo":true}')`, repo.ID, owner.ID, strings.Repeat("a", 40))
	require.NoError(t, err)
	server := httptest.NewUnstartedServer(nil)
	origin := "http://" + server.Listener.Addr().String()
	t.Setenv("SMITHERS_AUTH_SESSION_COOKIE_NAME", "session")
	t.Setenv("SMITHERS_PUBLIC_URL", origin)
	t.Setenv("SMITHERS_SERVER_ALLOWED_ORIGINS", origin)
	api := startSplitProcess(t, Options{ChatHost: unusedChatHost{}})
	vite, err := url.Parse(os.Getenv("SMITHERS_ACCESS_ASSETS_URL"))
	require.NoError(t, err)
	proxy := httputil.NewSingleHostReverseProxy(vite)
	rewrite := proxy.Director
	proxy.Director = func(r *http.Request) { rewrite(r); r.Host = vite.Host }
	server.Config.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/") {
			api.ServeHTTP(w, r)
		} else {
			proxy.ServeHTTP(w, r)
		}
	})
	server.Start()
	defer server.Close()
	fmt.Println("ACCESS_BROWSER_READY " + origin)
	ticker := time.NewTicker(20 * time.Millisecond)
	defer ticker.Stop()
waiting:
	for {
		select {
		case <-ticker.C:
			if _, err := os.Stat(os.Getenv("SMITHERS_ACCESS_DONE_FILE")); err == nil {
				break waiting
			}
		case <-ctx.Done():
			t.Fatal("browser did not finish")
		}
	}
	var approvals int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM approvals`).Scan(&approvals))
	require.Zero(t, approvals)
	var state string
	require.NoError(t, pool.QueryRow(ctx, `SELECT state FROM mythical_items WHERE repository_id=$1 AND number=1`, repo.ID).Scan(&state))
	require.Equal(t, "proposed", state)
}
