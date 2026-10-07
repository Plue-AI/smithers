package compose

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/stretchr/testify/require"
	"golang.org/x/crypto/ssh"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestInstallMemberManagesOnlyOwnSSHKeysPostgres(t *testing.T) {
	f := newLandingGateFixtureWithFactory(t, nil, "", true)
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Auth.SessionCookieName = "session"
	cfg.Server.PublicURL = "http://example.com"
	cfg.Server.AllowedOrigins = []string{cfg.Server.PublicURL}
	service := services.NewSSHKeyService(f.q)
	router := buildRouterCompat(cfg, f.q, f.pool, &routes.RepoHandler{}, &routes.AuthHandler{}, &routes.UserHandler{}, &routes.SSHKeyHandler{Service: service}, &routes.LabelHandler{}, &routes.OrgHandler{}, &routes.LandingHandler{}, &routes.SearchHandler{Service: &mockRouterSearchService{}}, &routes.IssueHandler{}, nil, &routes.GitSmartHandler{Service: &mockRouterGitService{}}, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, &routes.WorkspaceHandler{}, nil, nil, nil, nil, nil, nil)
	key := func(seed byte) string {
		pub, err := ssh.NewPublicKey(ed25519.NewKeyFromSeed(bytes.Repeat([]byte{seed}, ed25519.SeedSize)).Public())
		require.NoError(t, err)
		return string(ssh.MarshalAuthorizedKey(pub))
	}
	owner, err := service.CreateKey(f.ctx, f.owner.ID, services.CreateSSHKeyRequest{Title: "private-owner-key", Key: key(1)})
	require.NoError(t, err)
	cookie := "member-key-cookie"
	sum := sha256.Sum256([]byte(cookie))
	_, err = f.q.CreateAuthSession(f.ctx, db.CreateAuthSessionParams{UserID: f.other.ID, Username: f.other.Username, SessionKey: hex.EncodeToString(sum[:]), ExpiresAt: time.Now().Add(time.Hour)})
	require.NoError(t, err)
	body, err := json.Marshal(services.CreateSSHKeyRequest{Title: "member-key", Key: key(2)})
	require.NoError(t, err)
	call := func(method, path, token string, person bool, status int) []byte {
		t.Helper()
		req := httptest.NewRequest(method, cfg.Server.PublicURL+path, bytes.NewReader(body))
		req.Header.Set("Origin", cfg.Server.PublicURL)
		req.Header.Set("Content-Type", "application/json")
		if person {
			req.AddCookie(&http.Cookie{Name: "session", Value: cookie})
			req.AddCookie(&http.Cookie{Name: "__csrf", Value: "csrf"})
			req.Header.Set("X-CSRF-Token", "csrf")
		}
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		out := httptest.NewRecorder()
		router.ServeHTTP(out, req)
		require.Equal(t, status, out.Code, out.Body.String())
		return out.Body.Bytes()
	}
	for _, actor := range []struct{ name, scopes string }{
		{"external", "write:user,via:codex"}, {"app", "write:user,via:smithers,terminal-session:" + liveAppTurnCredentialFixture(t, f.pool, f.other.ID) + "/1"}, {"run", "write:user"}, {"machine", "write:user," + middleware.WorkspaceRestrictionScope("11111111-1111-4111-8111-111111111111")},
	} {
		t.Run(actor.name, func(t *testing.T) {
			token := f.token(f.other, "ssh-key-"+actor.name, actor.scopes, true)
			require.Contains(t, string(call("POST", "/api/user/keys", token, false, 403)), `"code":"permission"`)
			require.Contains(t, string(call("DELETE", fmt.Sprintf("/api/user/keys/%d", owner.ID), token, false, 403)), `"code":"permission"`)
			keys, err := service.ListKeys(f.ctx, f.other.ID)
			require.NoError(t, err)
			require.Empty(t, keys)
		})
	}
	call("POST", "/api/user/keys", "", false, 401)
	var created services.SSHKeyResponse
	require.NoError(t, json.Unmarshal(call("POST", "/api/user/keys", "", true, 201), &created))
	require.Equal(t, "member-key", created.Name)
	require.NotEmpty(t, created.Fingerprint)
	call("DELETE", fmt.Sprintf("/api/user/keys/%d", owner.ID), "", true, 404)
	_, err = service.GetKeyByID(f.ctx, f.owner.ID, owner.ID)
	require.NoError(t, err)
	call("DELETE", fmt.Sprintf("/api/user/keys/%d", created.ID), "", true, 204)
	keys, err := service.ListKeys(f.ctx, f.other.ID)
	require.NoError(t, err)
	require.Empty(t, keys)
	_, err = f.pool.Exec(f.ctx, `UPDATE collaborators SET suspended_at=now() WHERE repository_id=$1 AND user_id=$2`, f.repoID, f.other.ID)
	require.NoError(t, err)
	call("POST", "/api/user/keys", "", true, 401)
}
