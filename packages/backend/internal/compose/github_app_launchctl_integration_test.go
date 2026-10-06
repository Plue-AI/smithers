package compose

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

// The child opens the same durable database after each launchd start. Only
// fixture session/database values cross the process boundary; App secrets stay sealed.
func TestGitHubAppLaunchctlChild(t *testing.T) {
	raw := os.Getenv("SMITHERS_GH_RESTART_DB")
	if raw == "" {
		t.Skip("isolated launchctl child only")
	}
	pool, err := postgresfixture.Open(t.Context(), raw, 2)
	require.NoError(t, err)
	defer pool.Close()
	codec, err := webhook.NewSecretCodec("manual-fallback-install-key")
	require.NoError(t, err)
	store := services.NewGitHubAppCredentialStore(pool, codec)
	credentials, err := store.Load(t.Context())
	require.NoError(t, err)
	require.EqualValues(t, 42, credentials.ID)
	require.Equal(t, "manual-app", credentials.Slug)
	origin := os.Getenv("SMITHERS_GH_RESTART_ORIGIN")
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Server.PublicURL = "http://localhost:4000"
	cfg.Server.AllowedOrigins = []string{"http://localhost:4000", "http://lan-a:4000"}
	h := &routes.GitHubAppSetupHandler{Store: store, Setup: &services.InstallSetupService{Pool: pool}, Owners: db.New(pool), Sessions: &services.InstallSetupSessions{Pool: pool}, Origins: middleware.FixedOrigins(cfg.Server.AllowedOrigins...)}
	router := githubAppSetupComposeRouter(cfg, pool, h)
	request := httptest.NewRequest("GET", origin+"/api/install", nil)
	request.RemoteAddr = "192.0.2.1:12345"
	if origin == "http://localhost:4000" {
		request.RemoteAddr = "127.0.0.1:12345"
	}
	request.AddCookie(&http.Cookie{Name: routes.GitHubAppSetupSessionCookie, Value: os.Getenv("SMITHERS_GH_RESTART_SESSION")})
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	require.Equal(t, 200, response.Code)
	var status struct {
		Steps []struct {
			ID    string `json:"id"`
			State string `json:"state"`
		} `json:"steps"`
	}
	require.NoError(t, json.Unmarshal(response.Body.Bytes(), &status))
	found := false
	for _, step := range status.Steps {
		if step.ID == "app_manifest" {
			require.Equal(t, "done", step.State)
			found = true
		}
	}
	require.True(t, found)
	token, err := services.NewRepoConnectionService(pool, store).CreateGitHubInstallationToken(t.Context(), 91, services.GitHubTokenScope{RepositoryIDs: []int64{1001}, Permissions: map[string]string{"contents": "read"}})
	require.NoError(t, err)
	require.NotEmpty(t, token.Token)
	// Receipt deliberately contains no token, PEM, state, session, or secret.
	receipt, err := json.Marshal(map[string]any{"pid": os.Getpid(), "app_id": 42, "slug": "manual-app", "step": "done", "installation_id": 91, "token_minted": true})
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(os.Getenv("SMITHERS_GH_RESTART_RECEIPT"), receipt, 0600))
	select {} // launchctl kickstart must terminate this exact process.
}

func verifyGitHubAppLaunchctlRestart(t *testing.T, databaseURL, origin, session, apiURL string) {
	t.Helper()
	if os.Getenv("SMITHERS_REQUIRE_GITHUB_LAUNCHCTL_TESTS") != "1" {
		return
	}
	require.Equal(t, "darwin", runtime.GOOS)
	binary, err := os.Executable()
	require.NoError(t, err)
	directory := t.TempDir()
	receipt := filepath.Join(directory, "receipt.json")
	label := fmt.Sprintf("sh.smithers.lane.fr4-t-gh-01.%d.%d", os.Getpid(), time.Now().UnixNano())
	domain := fmt.Sprintf("gui/%d", os.Getuid())
	target := domain + "/" + label
	escape := func(s string) string { return strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;").Replace(s) }
	environment := map[string]string{"SMITHERS_GH_RESTART_DB": databaseURL, "SMITHERS_GH_RESTART_ORIGIN": origin, "SMITHERS_GH_RESTART_SESSION": session, "SMITHERS_GH_RESTART_RECEIPT": receipt, "SMITHERS_GITHUB_APP_API_BASE_URL": apiURL}
	var env strings.Builder
	for key, value := range environment {
		fmt.Fprintf(&env, "<key>%s</key><string>%s</string>", key, escape(value))
	}
	plist := filepath.Join(directory, "host.plist")
	log := filepath.Join(directory, "host.log")
	t.Cleanup(func() {
		if t.Failed() {
			data, _ := os.ReadFile(log)
			t.Logf("isolated restart child: %s", data)
		}
	})
	content := fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>%s</string><key>ProgramArguments</key><array><string>%s</string><string>-test.run=^TestGitHubAppLaunchctlChild$</string><string>-test.timeout=3m</string></array><key>EnvironmentVariables</key><dict>%s</dict><key>StandardOutPath</key><string>%s</string><key>StandardErrorPath</key><string>%s</string></dict></plist>`, label, escape(binary), env.String(), escape(log), escape(log))
	require.NoError(t, os.WriteFile(plist, []byte(content), 0600))
	command := func(args ...string) {
		t.Helper()
		output, err := exec.Command("launchctl", args...).CombinedOutput()
		require.NoError(t, err, "%s", output)
	}
	command("bootstrap", domain, plist)
	t.Cleanup(func() {
		output, err := exec.Command("launchctl", "bootout", target).CombinedOutput()
		require.NoError(t, err, "%s", output)
	})
	readPID := func() int {
		t.Helper()
		var result struct {
			PID int `json:"pid"`
		}
		require.Eventually(t, func() bool {
			data, err := os.ReadFile(receipt)
			return err == nil && json.Unmarshal(data, &result) == nil && result.PID > 0
		}, 30*time.Second, 100*time.Millisecond)
		return result.PID
	}
	command("kickstart", target)
	first := readPID()
	require.NoError(t, os.Remove(receipt))
	command("kickstart", "-k", target)
	second := readPID()
	require.NotEqual(t, first, second)
	data, err := os.ReadFile(receipt)
	require.NoError(t, err)
	t.Logf("launchctl kickstart -k %s: changed PID %d -> %d; receipt %s", target, first, second, data)
}
