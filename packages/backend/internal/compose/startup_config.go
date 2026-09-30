package compose

import (
	"log/slog"

	"github.com/smithersai/smithers/packages/backend/internal/config"
)

// logStartupConfig emits a single structured log entry summarizing the server's
// configuration at startup. This makes misconfiguration immediately visible in
// pod logs without needing to dig through individual error messages.
func logStartupConfig(cfg *config.Config) {
	status := func(val string, label string) string {
		if val == "" {
			return "(not configured)"
		}
		return label
	}

	// Redact sensitive URL components (password) from database URL.
	dbStatus := "(not configured)"
	if cfg.Database.URL != "" {
		dbStatus = "configured"
	}

	// Determine email transport type.
	emailStatus := "disabled"
	if cfg.Email.SMTPHost != "" {
		emailStatus = "smtp"
	}

	slog.Info("server configuration summary",
		"listen_addr", cfg.Server.Addr,
		"database", dbStatus,
		"repo_host_url", status(cfg.RepoHost.URL, cfg.RepoHost.URL),
		"github_oauth", status(cfg.Auth.GitHubClientID, "configured"),
		"email_transport", emailStatus,
		"log_level", cfg.Observability.LogLevel,
	)
}
