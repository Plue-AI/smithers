package compose

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

// C-INS-03 step 0: the composed install router, real PostgreSQL and sockets.
// Publication/isolation are deliberately unavailable parallel providers, not
// substitutes for a successful source-event or microVM acceptance receipt.
func TestInstallServingProviderRefusalPostgres(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	ctx := context.Background()
	q := db.New(pool)
	owner, err := q.CreateUser(ctx, db.CreateUserParams{Username: "serving-owner", LowerUsername: "serving-owner"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, "INSERT INTO self_host_owners(singleton,user_id) VALUES(TRUE,$1)", owner.ID)
	require.NoError(t, err)
	session := "serving-owner-session"
	hash := sha256.Sum256([]byte(session))
	_, err = q.CreateAuthSession(ctx, db.CreateAuthSessionParams{SessionKey: hex.EncodeToString(hash[:]), UserID: owner.ID, Username: owner.Username, ExpiresAt: time.Now().Add(time.Hour)})
	require.NoError(t, err)
	serving := &services.InstallServing{Pool: pool}
	h := &routes.GitHubAppSetupHandler{Owners: q, Serving: serving}
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	server := httptest.NewServer(githubAppSetupComposeRouter(cfg, pool, h))
	defer server.Close()
	request := func(body, origin, csrf, host string) (int, map[string]any, http.Header) {
		r, err := http.NewRequest("PUT", server.URL+"/api/install", strings.NewReader(body))
		require.NoError(t, err)
		r.Host = host
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Origin", origin)
		r.Header.Set("X-CSRF-Token", csrf)
		r.AddCookie(&http.Cookie{Name: "smithers_session", Value: session})
		r.AddCookie(&http.Cookie{Name: "__csrf", Value: "csrf"})
		response, err := server.Client().Do(r)
		require.NoError(t, err)
		defer response.Body.Close()
		raw, err := io.ReadAll(response.Body)
		require.NoError(t, err)
		var value map[string]any
		require.NoError(t, json.Unmarshal(raw, &value))
		return response.StatusCode, value, response.Header
	}
	for _, tc := range []struct {
		name, body, origin, csrf, host string
		status                         int
		code, class                    string
	}{
		// Literal classes and codes: T-INS-04 C-INS-03 / spec §6.2.3.
		{"unknown before auth", `{"address":{"bind":"0.0.0.0","origins":["http://lan-a:4000"]}}`, "", "", "evil.example", 421, "unknown_origin", "user"},
		{"origin", `{"address":{"bind":"0.0.0.0"}}`, "http://evil.example", "csrf", "localhost:4000", 403, "origin", "permission"},
		{"missing Origin", `{"address":{"bind":"0.0.0.0"}}`, "", "csrf", "localhost:4000", 403, "origin", "permission"},
		{"csrf", `{"address":{"bind":"0.0.0.0"}}`, "http://localhost:4000", "", "localhost:4000", 403, "csrf", "permission"},
		{"invalid bind", `{"address":{"bind":"bad"}}`, "http://localhost:4000", "csrf", "localhost:4000", 422, "validation_failed", "user"},
		{"invalid origin", `{"address":{"origins":["ftp://box"]}}`, "http://localhost:4000", "csrf", "localhost:4000", 422, "validation_failed", "user"},
		{"missing launcher", `{"address":{"bind":"0.0.0.0","origins":["http://lan-a:4000"]}}`, "http://localhost:4000", "csrf", "localhost:4000", 503, "service_unavailable", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			status, value, headers := request(tc.body, tc.origin, tc.csrf, tc.host)
			require.Equal(t, tc.status, status)
			require.Equal(t, tc.code, value["code"])
			if tc.class != "" {
				require.Equal(t, tc.class, value["class"])
			}
			for name := range headers {
				require.False(t, strings.HasPrefix(strings.ToLower(name), "access-control-allow-"))
			}
			var n int
			require.NoError(t, pool.QueryRow(ctx, "SELECT count(*) FROM install_settings WHERE key='address'").Scan(&n))
			require.Zero(t, n)
		})
	}
	// C-INS-03 step 1: a real member session cannot reach any serving provider.
	member, err := q.CreateUser(ctx, db.CreateUserParams{Username: "serving-member", LowerUsername: "serving-member"})
	require.NoError(t, err)
	memberSession := "serving-member-session"
	memberHash := sha256.Sum256([]byte(memberSession))
	_, err = q.CreateAuthSession(ctx, db.CreateAuthSessionParams{SessionKey: hex.EncodeToString(memberHash[:]), UserID: member.ID, Username: member.Username, ExpiresAt: time.Now().Add(time.Hour)})
	require.NoError(t, err)
	ownerSession := session
	session = memberSession
	status, _, _ := request(`{"address":{"bind":"0.0.0.0","origins":["http://lan-a:4000"]}}`, "http://localhost:4000", "csrf", "localhost:4000")
	require.Equal(t, 403, status)
	session = ownerSession
	var n int
	require.NoError(t, pool.QueryRow(ctx, "SELECT count(*) FROM install_settings WHERE key='address'").Scan(&n))
	require.Zero(t, n)
	h.Owners = nil
	status, _, _ = request(`{"address":{"bind":"0.0.0.0","origins":["http://lan-a:4000"]}}`, "http://localhost:4000", "csrf", "localhost:4000")
	require.Equal(t, 503, status)
	h.Owners = q

	serving.Isolation = func(context.Context) error { return nil }
	status, _, _ = request(`{"address":{"bind":"0.0.0.0","origins":["http://lan-a:4000"]}}`, "http://localhost:4000", "csrf", "localhost:4000")
	require.Equal(t, 503, status)
	a, err := serving.Read(ctx)
	require.NoError(t, err)
	raw, err := json.Marshal(a)
	require.NoError(t, err)
	require.JSONEq(t, `{"listen":"mac","bind":"","origins":[]}`, string(raw))
}
