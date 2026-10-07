package compose

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/stretchr/testify/require"
)

func TestInstallMemberSelfCredentialsPostgres(t *testing.T) {
	f := newLandingGateFixtureWithFactory(t, nil, "", true)
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode, cfg.Auth.SessionCookieName = "selfhost", "session"
	cfg.Server.PublicURL = "http://example.com"
	cfg.Server.AllowedOrigins = []string{cfg.Server.PublicURL}
	auth := services.NewAuthService(f.q, cfg.Auth, nil, nil)
	router := buildRouterCompat(cfg, f.q, f.pool,
		&routes.RepoHandler{}, &routes.AuthHandler{}, &routes.UserHandler{TokenService: auth, SessionService: auth}, &routes.SSHKeyHandler{}, &routes.LabelHandler{},
		&routes.OrgHandler{}, &routes.LandingHandler{}, &routes.SearchHandler{Service: &mockRouterSearchService{}}, &routes.IssueHandler{}, nil, &routes.GitSmartHandler{Service: &mockRouterGitService{}},
		nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, &routes.WorkspaceHandler{}, nil, nil, nil, nil, nil, nil)
	session := func(user db.User, raw string) string {
		sum := sha256.Sum256([]byte(raw))
		hash := hex.EncodeToString(sum[:])
		_, err := f.q.CreateAuthSession(f.ctx, db.CreateAuthSessionParams{UserID: user.ID, Username: user.Username, SessionKey: hash, ExpiresAt: time.Now().Add(time.Hour)})
		require.NoError(t, err)
		return hash
	}
	current := "self-member-current"
	currentHash := session(f.other, current)
	spare := "self-member-spare"
	spareHash := session(f.other, spare)
	foreignHash := session(f.owner, "self-owner-private")
	ownToken := f.token(f.other, "self-own-token", "read:user,write:user,via:codex", true)
	foreignToken := f.token(f.owner, "self-private-owner", "read:user,write:user,via:codex", true)
	tokenID := func(raw string) int64 {
		sum := sha256.Sum256([]byte(raw))
		row, err := f.q.GetAuthInfoByTokenHash(f.ctx, hex.EncodeToString(sum[:]))
		require.NoError(t, err)
		return row.TokenID
	}
	ownID, foreignID := tokenID(ownToken), tokenID(foreignToken)
	run := f.token(f.other, "self-run", "read:user,write:user", true)
	call := func(method, path, cookie, bearer string, status int) string {
		t.Helper()
		req := httptest.NewRequest(method, cfg.Server.PublicURL+path, nil)
		req.Header.Set("Origin", cfg.Server.PublicURL)
		if cookie != "" {
			req.AddCookie(&http.Cookie{Name: "session", Value: cookie})
			req.AddCookie(&http.Cookie{Name: "__csrf", Value: "csrf"})
			req.Header.Set("X-CSRF-Token", "csrf")
		}
		if bearer != "" {
			req.Header.Set("Authorization", "Bearer "+bearer)
		}
		out := httptest.NewRecorder()
		router.ServeHTTP(out, req)
		require.Equal(t, status, out.Code, out.Body.String())
		return out.Body.String()
	}
	for _, path := range []string{"/api/user/tokens", "/api/user/sessions"} {
		body := call("GET", path, current, "", 200)
		for _, secret := range []string{current, spare, currentHash, spareHash, foreignHash, ownToken, foreignToken, "self-private-owner"} {
			require.NotContains(t, body, secret)
		}
		for _, bearer := range []string{ownToken, run} {
			refused := call("GET", path, "", bearer, 403)
			require.Contains(t, refused, `"code":"permission"`)
			require.NotContains(t, refused, "self-own-token")
		}
	}
	var tokens []map[string]any
	require.NoError(t, json.Unmarshal([]byte(call("GET", "/api/user/tokens", current, "", 200)), &tokens))
	require.Len(t, tokens, 2)
	var sessions []map[string]any
	require.NoError(t, json.Unmarshal([]byte(call("GET", "/api/user/sessions", current, "", 200)), &sessions))
	require.Len(t, sessions, 2)
	for _, row := range sessions {
		require.Contains(t, []string{services.SessionPublicID(currentHash), services.SessionPublicID(spareHash)}, row["id"])
	}
	call("DELETE", fmt.Sprintf("/api/user/tokens/%d", foreignID), current, "", 404)
	call("DELETE", "/api/user/sessions/"+services.SessionPublicID(foreignHash), current, "", 404)
	require.Equal(t, foreignID, tokenID(foreignToken))
	call("DELETE", fmt.Sprintf("/api/user/tokens/%d", ownID), "", run, 403)
	require.Equal(t, ownID, tokenID(ownToken))
	call("DELETE", fmt.Sprintf("/api/user/tokens/%d", ownID), current, "", 204)
	call("GET", "/api/user/tokens", "", ownToken, 401)
	call("DELETE", "/api/user/sessions/"+services.SessionPublicID(spareHash), current, "", 204)
	call("GET", "/api/user/sessions", spare, "", 401)
	_, err := f.pool.Exec(f.ctx, `UPDATE collaborators SET suspended_at=now() WHERE repository_id=$1 AND user_id=$2`, f.repoID, f.other.ID)
	require.NoError(t, err)
	call("GET", "/api/user/tokens", current, "", 401)
}
