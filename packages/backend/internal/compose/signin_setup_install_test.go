package compose

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"net/http"
	"net/http/httptest"
	"os"
	"regexp"
	"strings"
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
	"github.com/stretchr/testify/require"
)

func TestSignInSetupInstallPostgres(t *testing.T) {
	_, _, pool := splitProcessDatabase(t)
	q := db.New(pool)
	digest := sha256.Sum256([]byte("reinstall-token"))
	value, _ := json.Marshal(hex.EncodeToString(digest[:]))
	codec, err := webhook.NewSecretCodec("split-process-webhook-key")
	require.NoError(t, err)
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	require.NoError(t, err)
	privateKey := string(pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)}))
	store := services.NewGitHubAppCredentialStore(pool, codec)
	require.NoError(t, store.Save(t.Context(), services.GitHubAppCredentials{ID: 42, Slug: "install-test", OwnerLogin: "acme", OwnerKind: "org", PEM: privateKey, ClientID: "install-client", ClientSecret: "secret", WebhookSecret: "webhook"}))
	require.NoError(t, store.SaveCallbackURLs(t.Context(), []string{"http://127.0.0.1:4000/api/auth/github/callback"}))
	handler := startSplitProcess(t, Options{})
	require.NoError(t, q.UpsertInstallSetting(t.Context(), db.UpsertInstallSettingParams{Key: "setup.token", Value: value}))

	ask := func(path string, cookies []*http.Cookie) *httptest.ResponseRecorder {
		target := path
		if !strings.HasPrefix(target, "http") {
			target = "http://127.0.0.1:4000" + target
		}
		request := httptest.NewRequest("GET", target, nil)
		request.RemoteAddr = "127.0.0.1:51000"
		for _, cookie := range cookies {
			request.AddCookie(cookie)
		}
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		return response
	}
	stale := &http.Cookie{Name: "smithers_session", Value: "previous-install-session"}
	exchange := ask("/setup?token=reinstall-token", []*http.Cookie{stale})
	require.Equal(t, 303, exchange.Code, exchange.Body.String())
	var setupCookies []*http.Cookie
	cleared := false
	for _, cookie := range exchange.Result().Cookies() {
		if cookie.Name == stale.Name {
			cleared = cookie.MaxAge < 0
			continue
		}
		setupCookies = append(setupCookies, cookie)
	}
	require.True(t, cleared)
	// Keep the stale cookie deliberately: setup authority must still win when
	// a browser or concurrent response has retained it.
	setupCookies = append(setupCookies, stale)
	status := ask("/api/install", setupCookies)
	require.Equal(t, 200, status.Code, status.Body.String())
	require.Contains(t, status.Body.String(), "sign_in")
	require.Contains(t, status.Body.String(), "pending")
	require.Equal(t, 401, ask("/api/install", []*http.Cookie{stale}).Code)
	require.Equal(t, 403, ask("/api/repos/acme/app", setupCookies).Code)

	// Address and App creation precede owner sign-in on an install.
	_, err = pool.Exec(t.Context(), `UPDATE install_settings SET value=jsonb_set(value,'{status}','"done"') WHERE key IN ('setup.step.address','setup.step.app_manifest')`)
	require.NoError(t, err)

	// Read the actual app door constant: following it proves the mounted route
	// and RPC contract agree, rather than duplicating the expected path in Go.
	source, err := os.ReadFile("../../../rpc/src/AgentApiRoutes.ts")
	require.NoError(t, err)
	match := regexp.MustCompile(`export const AUTH_SIGN_IN_PATH = "([^"]+)"`).FindSubmatch(source)
	require.Len(t, match, 2)
	redirect := ask(string(match[1]), setupCookies)
	require.Equal(t, 302, redirect.Code, redirect.Body.String())
	if strings.HasPrefix(redirect.Header().Get("Location"), "http://localhost:4000/") {
		redirect = ask(redirect.Header().Get("Location"), setupCookies)
		require.Equal(t, 302, redirect.Code, redirect.Body.String())
	}
	require.Contains(t, redirect.Header().Get("Location"), "github.com/login/oauth/authorize")
	require.Contains(t, redirect.Header().Get("Location"), "client_id=install-client")
	require.Equal(t, 404, ask("/api/auth/github/start", nil).Code)
}
