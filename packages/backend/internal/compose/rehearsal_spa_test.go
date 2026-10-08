package compose

import (
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

// A browser rehearsal (SMITHERS_REHEARSAL_SPA_DIR) serves the built app on the
// install's origin, which is also the coding host's model proxy origin. The
// host reads GET /model-proxy/factory-seat before it accepts connections;
// when that read got index.html, every TODO host exited with "SeatUnresolved:
// Factory model is unavailable" and no request reached the backend.
func TestRehearsalSPAHandlerForwardsBackendRoutes(t *testing.T) {
	spa := t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(spa, "index.html"), []byte("app"), 0600))
	require.NoError(t, os.MkdirAll(filepath.Join(spa, "assets"), 0700))
	require.NoError(t, os.WriteFile(filepath.Join(spa, "assets", "app.js"), []byte("script"), 0600))
	backend := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, "backend "+r.Method+" "+r.URL.Path)
	})
	server := httptest.NewServer(rehearsalSPAHandler(spa, backend))
	t.Cleanup(server.Close)
	for _, c := range []struct{ method, path, want string }{
		// The coding host's startup seat read and its model turns.
		{http.MethodGet, "/model-proxy/factory-seat", "backend GET /model-proxy/factory-seat"},
		{http.MethodPost, "/model-proxy/cerebras/v1/chat/completions", "backend POST /model-proxy/cerebras/v1/chat/completions"},
		{http.MethodPost, "/model-proxy/openai/v1/responses", "backend POST /model-proxy/openai/v1/responses"},
		{http.MethodGet, "/api/install", "backend GET /api/install"},
		{http.MethodPost, "/webhooks/github", "backend POST /webhooks/github"},
		{http.MethodGet, "/setup", "backend GET /setup"},
		{http.MethodGet, "/setup/github/callback", "backend GET /setup/github/callback"},
		{http.MethodGet, "/rehearsal-owner/app.git/info/refs", "backend GET /rehearsal-owner/app.git/info/refs"},
		// The app's own routes and files.
		{http.MethodGet, "/rehearsal-owner/app", "app"},
		{http.MethodGet, "/assets/app.js", "script"},
		{http.MethodGet, "/model-proxyless", "app"},
	} {
		request, err := http.NewRequest(c.method, server.URL+c.path, strings.NewReader(""))
		require.NoError(t, err)
		response, err := server.Client().Do(request)
		require.NoError(t, err)
		body, err := io.ReadAll(response.Body)
		require.NoError(t, response.Body.Close())
		require.NoError(t, err)
		require.Equal(t, c.want, string(body), "%s %s", c.method, c.path)
	}
}
