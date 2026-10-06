package compose

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/stretchr/testify/require"
)

// Actual install composition, authentication and PostgreSQL; view state is
// never selected by a caller-supplied author or exposed to another member.
func TestBranchConversationMemberViewStateInstall(t *testing.T) {
	_, _, pool := splitProcessDatabase(t)
	q, ctx := db.New(pool), t.Context()
	user := func(login string) db.User {
		u, err := q.CreateUser(ctx, db.CreateUserParams{Username: login, LowerUsername: login, DisplayName: login})
		require.NoError(t, err)
		return u
	}
	owner, ben, alice := user("owner"), user("ben"), user("alice")
	_, err := pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, owner.ID)
	require.NoError(t, err)
	repo, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: owner.ID, Valid: true}, Name: "demo", LowerName: "demo", DefaultBookmark: "main"})
	require.NoError(t, err)
	binding := fmt.Sprintf(`{"owner_login":"owner","repository_name":"demo","repository_id":%d,"last_access_check_at":"%s"}`, repo.ID, time.Now().UTC().Format(time.RFC3339))
	for _, key := range []string{"github.repository", "owner.access"} {
		require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: key, Value: []byte(binding)}))
	}
	for _, u := range []db.User{owner, ben, alice} {
		permission := "admin"
		if u.ID == alice.ID {
			permission = "write"
		}
		_, err = pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,$3)`, repo.ID, u.ID, permission)
		require.NoError(t, err)
	}
	session := func(u db.User) string {
		key := u.Username + "-view-cookie"
		hash := sha256.Sum256([]byte(key))
		_, err := q.CreateAuthSession(ctx, db.CreateAuthSessionParams{UserID: u.ID, Username: u.Username, SessionKey: hex.EncodeToString(hash[:]), ExpiresAt: time.Now().Add(time.Hour)})
		require.NoError(t, err)
		return key
	}
	benCookie, aliceCookie := session(ben), session(alice)
	rawToken := "smithers_" + strings.Repeat("d", 40)
	tokenHash := sha256.Sum256([]byte(rawToken))
	tokenDigest := hex.EncodeToString(tokenHash[:])
	_, err = q.CreateAccessToken(ctx, db.CreateAccessTokenParams{UserID: ben.ID, Name: "private-view-delegation",
		TokenHash: tokenDigest, TokenLastEight: tokenDigest[len(tokenDigest)-8:], SystemIssued: true,
		Scopes:    "write:user,read:user," + strings.Join(middleware.DelegationScopes(middleware.Delegation{Via: "smithers"}), ","),
		ExpiresAt: pgtype.Timestamptz{Time: time.Now().Add(time.Hour), Valid: true}})
	require.NoError(t, err)
	server := httptest.NewUnstartedServer(nil)
	origin := "http://" + strings.Replace(server.Listener.Addr().String(), "127.0.0.1:", "localhost:", 1)
	t.Setenv("SMITHERS_PUBLIC_URL", origin)
	t.Setenv("SMITHERS_SERVER_ALLOWED_ORIGINS", origin)
	server.Config.Handler = startSplitProcess(t, Options{ChatHost: unusedChatHost{}})
	server.Start()
	defer server.Close()
	call := func(method, path, body, cookie string, expected int) string {
		req, err := http.NewRequest(method, origin+path, strings.NewReader(body))
		require.NoError(t, err)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Origin", origin)
		req.Header.Set("X-CSRF-Token", "csrf-fixture")
		req.AddCookie(&http.Cookie{Name: "__csrf", Value: "csrf-fixture"})
		req.AddCookie(&http.Cookie{Name: "smithers_session", Value: cookie})
		res, err := server.Client().Do(req)
		require.NoError(t, err)
		defer res.Body.Close()
		raw, err := io.ReadAll(res.Body)
		require.NoError(t, err)
		require.Equal(t, expected, res.StatusCode, string(raw))
		return string(raw)
	}
	const path = "/api/conversations/main/view-state"
	const benState = `{"scroll_anchor":"entry-8","card_view":{"todo-2":"maximized"},"last_seen_seq":8,"toasts_hidden":true}`
	require.JSONEq(t, benState, call("PUT", path, benState, benCookie, 200))
	require.JSONEq(t, `{}`, call("GET", path, "", aliceCookie, 200))
	require.JSONEq(t, `{"scroll_anchor":"entry-2"}`, call("PUT", path, `{"scroll_anchor":"entry-2"}`, aliceCookie, 200))
	require.JSONEq(t, benState, call("GET", path, "", benCookie, 200))
	for _, method := range []string{"GET", "PUT"} {
		req, err := http.NewRequest(method, origin+path, strings.NewReader(`{}`))
		require.NoError(t, err)
		req.Header.Set("Authorization", "Bearer "+rawToken)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Origin", origin)
		response, err := server.Client().Do(req)
		require.NoError(t, err)
		privateBody, err := io.ReadAll(response.Body)
		response.Body.Close()
		require.NoError(t, err)
		require.Equal(t, http.StatusForbidden, response.StatusCode, string(privateBody))
		require.NotContains(t, string(privateBody), "entry-8")
	}
	require.JSONEq(t, benState, call("GET", path, "", benCookie, 200))
	require.JSONEq(t, `{"scroll_anchor":"entry-2"}`, call("GET", path, "", aliceCookie, 200))
	call("PUT", path, `[]`, benCookie, 400)
	call("GET", path+"/ben", "", aliceCookie, 403)
	call("PUT", path, `{"user_id":2,"scroll_anchor":"own"}`, aliceCookie, 200)
	require.JSONEq(t, benState, call("GET", path, "", benCookie, 200))
	_, err = pool.Exec(ctx, `UPDATE collaborators SET suspended_at=now() WHERE user_id=$1`, alice.ID)
	require.NoError(t, err)
	call("PUT", path, `{}`, aliceCookie, 403)
}
