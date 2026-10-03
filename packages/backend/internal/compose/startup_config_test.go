package compose

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
)

func TestLogStartupConfig_TransportBranches(t *testing.T) {
	smtpCfg := &config.Config{}
	smtpCfg.Email.SMTPHost = "smtp.example.com"

	for _, tc := range []struct {
		name   string
		cfg    *config.Config
		expect string
	}{
		{"smtp", smtpCfg, `"email_transport":"smtp"`},
		{"disabled", &config.Config{}, `"email_transport":"disabled"`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var buf bytes.Buffer
			prev := slog.Default()
			t.Cleanup(func() { slog.SetDefault(prev) })
			slog.SetDefault(middleware.NewServerLogger(&buf, "info"))
			logStartupConfig(tc.cfg, false)
			assert.Contains(t, buf.String(), tc.expect)
			var entry map[string]any
			require.NoError(t, json.Unmarshal(buf.Bytes(), &entry))
			assert.Equal(t, tc.name, entry["email_transport"])
			assert.Equal(t, "server configuration summary", entry["message"])
			assert.Equal(t, "unavailable", entry["github_oauth"])
		})
	}
}

func TestLogStartupConfigGitHubAppSourceAvailability(t *testing.T) {
	t.Setenv("SMITHERS_AUTH_GITHUB_CLIENT_ID", "legacy-client-id")
	t.Setenv("SMITHERS_AUTH_GITHUB_CLIENT_SECRET", "legacy-client-secret")
	var buf bytes.Buffer
	prev := slog.Default()
	t.Cleanup(func() { slog.SetDefault(prev) })
	slog.SetDefault(middleware.NewServerLogger(&buf, "info"))
	cfg := &config.Config{}
	cfg.Database.URL = "postgres://owner:operator-password@database.example/product"
	cfg.RepoHost.URL = "http://repo-host:9090"
	logStartupConfig(cfg, true)
	var entry map[string]any
	require.NoError(t, json.Unmarshal(buf.Bytes(), &entry))
	require.Equal(t, "stored App credentials read per request", entry["github_oauth"])
	require.Equal(t, "configured", entry["database"])
	require.Equal(t, "http://repo-host:9090", entry["repo_host_url"])
	require.NotContains(t, buf.String(), "legacy")
	require.NotContains(t, buf.String(), "operator-password")
}
