package app_test

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/app"
	"github.com/smithersai/smithers/packages/backend/repository"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

// This uses the public composition with PostgreSQL and the native repository
// engine behind a real TCP HTTP client. No route service or database is mocked.
func TestReleaseHTTPWriteAndPaginationContracts(t *testing.T) {
	pool, databaseURL := postgresfixture.NewProductDatabase(t)
	ffi := os.Getenv("SMITHERS_FFI_LIBRARY_PATH")
	require.NotEmpty(t, ffi, "real repository engine is required")
	local, err := repository.OpenLocal(repository.Config{StoragePath: t.TempDir(), AuthToken: "release-audit-repo", FFILibraryPath: ffi})
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, local.Shutdown(context.Background())) })
	for key, value := range map[string]string{
		"SMITHERS_DATABASE_URL": databaseURL, "SMITHERS_BLOB_DATA_DIR": t.TempDir(),
		"SMITHERS_AUTH_MODE": "selfhost", "SMITHERS_AUTH_BOOTSTRAP_TOKEN": "release-audit-bootstrap",
		"SMITHERS_AUTH_SESSION_SECRET": "release-audit-session", "SMITHERS_LFS_SIGNING_SECRET": "release-audit-lfs",
		"SMITHERS_WEBHOOK_SECRET_ENCRYPTION_KEY": "release-audit-webhook", "SMITHERS_REPO_HOST_AUTH_TOKEN": "release-audit-repo",
		"SMITHERS_PUSH_HOOK_CALLBACK_TOKEN": "release-audit-push", "SMITHERS_SERVER_ADDR": "127.0.0.1:0",
		"SMITHERS_PUBLIC_URL": "http://127.0.0.1:4000", "SMITHERS_FEATURE_FLAGS_WORKFLOWS": "false",
		"SMITHERS_FEATURE_FLAGS_SANDBOXES": "false", "SMITHERS_FEATURE_FLAGS_WORKSPACES": "false",
		"SMITHERS_FEATURE_FLAGS_WIKI": "true", "SMITHERS_FEATURE_FLAGS_NOTIFICATIONS": "true",
	} {
		t.Setenv(key, value)
	}
	previous := slog.Default()
	t.Cleanup(func() { slog.SetDefault(previous) })
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	instance, err := app.Start(ctx, app.Config{Stdout: io.Discard, Stderr: io.Discard, Repository: local.Client()})
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, instance.Close(context.Background())) })
	server := httptest.NewServer(instance.Handler())
	t.Cleanup(server.Close)
	token := ""
	request := func(method, path, body string, want int, headers map[string]string) (map[string]any, http.Header) {
		t.Helper()
		var reader io.Reader
		if body != "" {
			reader = strings.NewReader(body)
		}
		req, err := http.NewRequest(method, server.URL+path, reader)
		require.NoError(t, err)
		if body != "" {
			req.Header.Set("Content-Type", "application/json")
		}
		if token != "" {
			req.Header.Set("Authorization", "token "+token)
		}
		for k, v := range headers {
			req.Header.Set(k, v)
		}
		res, err := server.Client().Do(req)
		require.NoError(t, err)
		defer res.Body.Close()
		raw, err := io.ReadAll(res.Body)
		require.NoError(t, err)
		require.Equal(t, want, res.StatusCode, "%s %s: %s", method, path, raw)
		var result map[string]any
		if len(raw) > 0 && raw[0] == '{' {
			require.NoError(t, json.Unmarshal(raw, &result))
		}
		return result, res.Header
	}
	request("POST", "/api/auth/local/bootstrap", `{"username":"releaseowner","password":"release-owner-password"}`, 200, map[string]string{"X-Smithers-Bootstrap-Token": "release-audit-bootstrap"})
	auth, _ := request("POST", "/api/auth/local/token", `{"username":"releaseowner","password":"release-owner-password","name":"audit"}`, 200, nil)
	token = auth["token"].(string)
	repo, _ := request("POST", "/api/user/repos", `{"name":"audit","private":true,"auto_init":true}`, 201, nil)
	require.Equal(t, true, repo["can_write"], "creator must retain editing access")
	path := "/api/repos/releaseowner/audit"
	for _, change := range []struct {
		method, suffix, body string
		archived             bool
	}{
		{"PATCH", "", `{"description":"updated"}`, false},
		{"POST", "/archive", "", true}, {"POST", "/unarchive", "", false},
		{"PATCH", "", `{"archived":true}`, true}, {"PATCH", "", `{"archived":false}`, false},
	} {
		result, _ := request(change.method, path+change.suffix, change.body, 200, nil)
		require.Equal(t, true, result["can_write"])
		require.Equal(t, change.archived, result["is_archived"])
		view, _ := request("GET", path, "", 200, nil)
		require.Equal(t, result["can_write"], view["can_write"])
	}
	for _, tc := range []struct{ route, body string }{
		{"/api/user/repos", `{"name":"discarded"}`},
		{"/api/app-timelines", `{"client_key":"discarded"}`},
		{"/api/share/listings", `{"name":"discarded"}`},
		{path + "/issues", `{"title":"discarded"}`},
		{path + "/variables", `{"name":"DISCARDED","value":"value"}`},
		{path + "/secrets", `{"name":"DISCARDED","value":"scratch"}`},
		{path + "/wiki", `{"title":"Discarded","slug":"discarded","body":"text"}`},
	} {
		for _, suffix := range []string{" {}", " null", " broken"} {
			request("POST", tc.route, tc.body+suffix, 400, nil)
		}
	}
	for _, suffix := range []string{" {}", " null", " broken"} {
		request("PUT", path+"/agent-environment/secrets/DISCARDED", `{"value":"scratch"}`+suffix, 400, nil)
	}
	var discardedTimelines int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM app_timelines WHERE client_key='discarded'`).Scan(&discardedTimelines))
	require.Zero(t, discardedTimelines, "rejected timeline documents must not persist their prefix")
	request("POST", "/api/app-timelines", `{"client_key":"discarded","future":true}`, 201, nil)
	request("POST", "/api/app-timelines", `{"client_key":"discarded"}`, 200, nil)
	request("GET", "/api/repos/releaseowner/discarded", "", 404, nil)
	request("GET", path+"/variables/DISCARDED", "", 404, nil)
	request("GET", path+"/wiki/discarded", "", 404, nil)
	for i, body := range []string{`{"title":"one"}`, `{"title":"two"}`, `{"title":"three"}`} {
		result, _ := request("POST", path+"/issues", body, 201, nil)
		require.Equal(t, float64(i+1), result["number"], "rejected bodies must not consume issue numbers")
	}
	for _, route := range []string{"/api/user/repos", path + "/issues", path + "/wiki", "/api/notifications/list"} {
		for _, cursor := range []string{"garbage", "-1", "9223372036854775808"} {
			request("GET", route+"?cursor="+cursor, "", 400, nil)
		}
	}
	// Follow exactly the public Link contract through all pages.
	next := path + "/issues?limit=1"
	seen := map[float64]bool{}
	for next != "" {
		req, err := http.NewRequest("GET", server.URL+next, nil)
		require.NoError(t, err)
		req.Header.Set("Authorization", "token "+token)
		res, err := server.Client().Do(req)
		require.NoError(t, err)
		require.Equal(t, 200, res.StatusCode)
		var issues []map[string]any
		require.NoError(t, json.NewDecoder(res.Body).Decode(&issues))
		res.Body.Close()
		require.LessOrEqual(t, len(issues), 1)
		for _, issue := range issues {
			number := issue["number"].(float64)
			require.False(t, seen[number], "pagination repeats rows")
			seen[number] = true
		}
		next = ""
		for _, part := range strings.Split(res.Header.Get("Link"), ",") {
			if strings.Contains(part, `rel="next"`) {
				part = strings.TrimSpace(part)
				next = strings.Split(strings.TrimPrefix(part, "<"), ">")[0]
			}
		}
		require.Equal(t, "3", res.Header.Get("X-Total-Count"))
	}
	require.Len(t, seen, 3)
}
