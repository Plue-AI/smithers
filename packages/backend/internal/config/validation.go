package config

import (
	"errors"
	"fmt"
	"net"
	"net/url"
	"strings"
	"time"
)

// ValidateServerStartup performs fail-fast checks for API startup-critical settings.
func ValidateServerStartup(cfg *Config) error {
	return ValidateServerStartupWithDependencies(cfg, StartupDependencies{})
}

// StartupDependencies names capabilities supplied by the deployment rather
// than by network URLs in Config. Only actual injected adapters may set them.
type StartupDependencies struct {
	InProcessRepository bool
	WorkspaceRuntime    bool
	ComputeProvider     bool
	MeteredAdmission    bool
}

func ValidateServerStartupWithDependencies(cfg *Config, dependencies StartupDependencies) error {
	if cfg == nil {
		return fmt.Errorf("config must not be nil")
	}

	var errs []string

	validateCommonStartupWithRepository(cfg, &errs, !dependencies.InProcessRepository)
	validateSingleOwnerBrowserSecurity(cfg, &errs)

	if strings.TrimSpace(cfg.Auth.SessionSecret) == "" {
		errs = append(errs, "auth.session_secret must not be empty")
	}
	if strings.TrimSpace(cfg.Auth.LFSSigningSecret) == "" {
		errs = append(errs, "auth.lfs_signing_secret must not be empty")
	}
	if strings.TrimSpace(cfg.Webhook.SecretEncryptionKey) == "" {
		errs = append(errs, "webhook.secret_encryption_key must not be empty")
	}
	for _, key := range cfg.Webhook.PreviousKeys() {
		if key == "" {
			errs = append(errs, "webhook.previous_secret_encryption_keys must not hold an empty key")
			break
		}
		if key == strings.TrimSpace(cfg.Webhook.SecretEncryptionKey) {
			errs = append(errs, "webhook.previous_secret_encryption_keys must not repeat the current key")
			break
		}
	}
	if strings.TrimSpace(cfg.RepoHost.PushHookCallbackToken) == "" {
		errs = append(errs, "repo_host.push_hook_callback_token must not be empty")
	} else if cfg.RepoHost.PushHookCallbackToken != strings.TrimSpace(cfg.RepoHost.PushHookCallbackToken) {
		errs = append(errs, "repo_host.push_hook_callback_token must not contain surrounding whitespace")
	}
	if cfg.FeatureFlags.Workflows ||
		cfg.FeatureFlags.Sandboxes ||
		cfg.FeatureFlags.Workspaces ||
		cfg.FeatureFlags.Agents ||
		cfg.FeatureFlags.RemoteSandboxEnabled {
		if !dependencies.WorkspaceRuntime && !dependencies.ComputeProvider {
			errs = append(errs, "an injected workspace runtime or compute provider is required when sandbox-backed features are enabled")
		}
	}
	if err := normalizeAgentAvailability(cfg); err != nil {
		errs = append(errs, err.Error())
	}
	validateBilling(cfg, dependencies, &errs)
	validateOptionalProviders(cfg, &errs)

	if len(errs) > 0 {
		return fmt.Errorf("config validation failed: %s", strings.Join(errs, "; "))
	}
	return nil
}

func validateBilling(cfg *Config, dependencies StartupDependencies, errs *[]string) {
	switch strings.ToLower(strings.TrimSpace(cfg.Billing.Mode)) {
	case "unlimited":
		if !IsSingleOwner(cfg.Auth) {
			*errs = append(*errs, "billing.mode=unlimited requires single-owner authentication")
		}
		if dependencies.MeteredAdmission {
			*errs = append(*errs, "injected admission requires billing.mode=metered")
		}
		if billingStripeConfigured(cfg.Billing) {
			*errs = append(*errs, "billing Stripe settings are unavailable in the public backend")
		}
	case "metered":
		if !dependencies.MeteredAdmission {
			*errs = append(*errs, "billing.mode=metered requires injected admission")
		}
		if strings.TrimSpace(cfg.Billing.StripeSecretKey) != "" || strings.TrimSpace(cfg.Billing.StripeWebhookSecret) != "" {
			*errs = append(*errs, "billing payment credentials belong to the deployment commerce adapter")
		}
	case "stripe":
		*errs = append(*errs, "billing.mode=stripe is unavailable in the public backend")
	default:
		*errs = append(*errs, "billing.mode must be unlimited or metered")
	}
}

func validateOptionalProviders(cfg *Config, errs *[]string) {
	// GitHub OAuth becomes available when the install creates its App. Validate
	// the callback at startup without consulting provider secrets or App state.
	callback, err := url.Parse(strings.TrimSpace(cfg.Auth.GitHubRedirectURL))
	if err != nil || callback.Host == "" || callback.User != nil || callback.RawQuery != "" || callback.Fragment != "" ||
		(callback.Scheme != "http" && callback.Scheme != "https") || callback.Path != "/api/auth/github/callback" {
		*errs = append(*errs, "auth.github_redirect_url must name the browser origin's /api/auth/github/callback endpoint")
	}
}

func billingStripeConfigured(cfg BillingConfig) bool {
	values := []string{
		cfg.StripeSecretKey,
		cfg.StripeWebhookSecret,
		cfg.PortalReturnURL,
		cfg.CheckoutSuccessURL,
		cfg.CheckoutCancelURL,
		cfg.PersonalMonthlyPriceID,
		cfg.PersonalAnnualPriceID,
		cfg.ProMonthlyPriceID,
		cfg.ProAnnualPriceID,
		cfg.MaxMonthlyPriceID,
		cfg.MaxAnnualPriceID,
		cfg.TeamMonthlyPriceID,
		cfg.TeamAnnualPriceID,
		cfg.EnterpriseMonthlyPriceID,
		cfg.EnterpriseAnnualPriceID,
	}
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return true
		}
	}
	return false
}

// ValidateSSHStartup performs fail-fast checks for SSH server startup-critical settings.
func ValidateSSHStartup(cfg *Config) error {
	if cfg == nil {
		return fmt.Errorf("config must not be nil")
	}

	var errs []string
	validateCommonStartup(cfg, &errs)
	if strings.TrimSpace(cfg.Auth.LFSSigningSecret) == "" {
		errs = append(errs, "auth.lfs_signing_secret must not be empty")
	}
	baseURL := PublicOrigin(cfg)
	baseURLSetting := "SMITHERS_PUBLIC_URL"
	if baseURL == "" {
		errs = append(errs, "SMITHERS_PUBLIC_URL is required for Git LFS SSH authentication")
	} else if err := validateURL(baseURL, true); err != nil {
		errs = append(errs, fmt.Sprintf("%s is invalid: %v", baseURLSetting, err))
	} else if parsed, err := url.Parse(baseURL); err != nil || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		errs = append(errs, fmt.Sprintf("%s is invalid: credentials, query, and fragment are not allowed", baseURLSetting))
	}

	if len(errs) > 0 {
		return fmt.Errorf("config validation failed: %s", strings.Join(errs, "; "))
	}
	return nil
}

func validateCommonStartup(cfg *Config, errs *[]string) {
	validateCommonStartupWithRepository(cfg, errs, true)
}

func validateCommonStartupWithRepository(cfg *Config, errs *[]string, requireRepositoryURL bool) {
	if publicURL := strings.TrimSpace(cfg.Server.PublicURL); publicURL == "" {
		*errs = append(*errs, "server.public_url is required")
	} else {
		if err := validateURL(publicURL, true); err != nil {
			*errs = append(*errs, fmt.Sprintf("server.public_url is invalid: %v", err))
		} else if parsed, err := url.Parse(publicURL); err != nil || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" || (parsed.Path != "" && parsed.Path != "/") {
			*errs = append(*errs, "server.public_url must be an origin without path, credentials, query, or fragment")
		}
	}
	switch strings.ToLower(strings.TrimSpace(cfg.Auth.Mode)) {
	case AuthModeSelfHosted, AuthModeMultitenant:
	case "":
		*errs = append(*errs, "auth.mode is required (selfhost or multitenant)")
	default:
		*errs = append(*errs, "auth.mode must be one of selfhost, multitenant")
	}
	if strings.TrimSpace(cfg.Database.URL) == "" {
		*errs = append(*errs, "database.url is required")
	}
	if requireRepositoryURL && strings.TrimSpace(cfg.RepoHost.URL) == "" {
		*errs = append(*errs, "repo_host.url is required")
	}
	if strings.TrimSpace(cfg.RepoHost.AuthToken) == "" {
		*errs = append(*errs, "repo_host.auth_token is required")
	}
	for _, raw := range splitCommaSeparatedList(cfg.Server.AllowedOrigins) {
		if _, err := CanonicalOrigin(raw); err != nil {
			*errs = append(*errs, fmt.Sprintf("server.allowed_origins contains invalid origin %q: %v", raw, err))
		}
	}

	if cfg.Database.MaxConns <= 0 {
		*errs = append(*errs, "database.max_conns must be > 0")
	}
	if cfg.Database.MinConns <= 0 {
		*errs = append(*errs, "database.min_conns must be > 0")
	}
	if cfg.Database.MaxConns > 0 && cfg.Database.MinConns > 0 && cfg.Database.MaxConns < cfg.Database.MinConns {
		*errs = append(*errs, "database.max_conns must be >= database.min_conns")
	}

	if cfg.Database.MaxConnLifetime <= 0 {
		*errs = append(*errs, "database.max_conn_lifetime_secs must be > 0")
	}
	if cfg.Database.MaxConnIdleTime <= 0 {
		*errs = append(*errs, "database.max_conn_idle_time_secs must be > 0")
	}
	if cfg.Server.ReadTimeoutSecs <= 0 {
		*errs = append(*errs, "server.read_timeout_secs must be > 0")
	}
	if cfg.Server.WriteTimeoutSecs < 0 {
		*errs = append(*errs, "server.write_timeout_secs must be >= 0")
	}
	if timeout, err := time.ParseDuration(strings.TrimSpace(cfg.Server.ShutdownTimeout)); err != nil {
		*errs = append(*errs, fmt.Sprintf("server.shutdown_timeout is invalid: %v", err))
	} else if timeout <= 0 {
		*errs = append(*errs, "server.shutdown_timeout must be > 0")
	}

	if err := validateURL(cfg.Database.URL, false); err != nil {
		*errs = append(*errs, fmt.Sprintf("database.url is invalid: %v", err))
	}
	if requireRepositoryURL {
		if err := validateURL(cfg.RepoHost.URL, true); err != nil {
			*errs = append(*errs, fmt.Sprintf("repo_host.url is invalid: %v", err))
		}
	}
	switch strings.TrimSpace(cfg.Sandbox.WorkspacePersistence) {
	case "", "ephemeral", "persistent":
	default:
		*errs = append(*errs, "sandbox.workspace_persistence must be one of ephemeral, persistent")
	}
	if cfg.Sandbox.WorkspaceMemoryMB <= 0 || cfg.Sandbox.WorkspaceMemoryMB > 65536 {
		*errs = append(*errs, "sandbox.workspace_memory_mb must be between 1 and 65536")
	}
	if cfg.Sandbox.WorkspaceVCPUCount <= 0 || cfg.Sandbox.WorkspaceVCPUCount > 16 {
		*errs = append(*errs, "sandbox.workspace_vcpu_count must be between 1 and 16")
	}
	for _, limit := range []struct {
		name  string
		value int32
	}{{"workspace_max_vcpu_count", cfg.Sandbox.WorkspaceMaxVCPUCount}, {"workspace_max_memory_mb", cfg.Sandbox.WorkspaceMaxMemoryMB}, {"workspace_max_disk_mb", cfg.Sandbox.WorkspaceMaxDiskMB}} {
		if limit.value < 0 {
			*errs = append(*errs, "sandbox."+limit.name+" must be non-negative")
		}
	}
	if cfg.Sandbox.WorkspaceIdleTimeout < 0 {
		*errs = append(*errs, "sandbox.workspace_idle_timeout must be >= 0")
	}
	if cfg.Sandbox.WorkspaceLeaseDeleteAfter < 0 {
		*errs = append(*errs, "sandbox.workspace_lease_delete_after must be >= 0")
	}
	if cfg.Sandbox.AgentMaxConcurrent < 0 {
		*errs = append(*errs, "sandbox.agent_max_concurrent must be >= 0")
	}
	if cfg.Sandbox.AgentIdleTimeoutSecs <= 0 {
		*errs = append(*errs, "sandbox.agent_idle_timeout_seconds must be > 0")
	}
}

func validateSingleOwnerBrowserSecurity(cfg *Config, errs *[]string) {
	if !IsSingleOwner(cfg.Auth) {
		return
	}

	rawOrigins := splitCommaSeparatedList(cfg.Server.AllowedOrigins)
	hasConfiguredOrigins := len(rawOrigins) > 0
	if !hasConfiguredOrigins {
		rawOrigins = []string{PublicOrigin(cfg)}
	}

	for _, raw := range rawOrigins {
		origin, err := CanonicalOrigin(raw)
		if err != nil {
			// Configured entries are already reported by validateCommonStartup;
			// this branch also covers an invalid derived public API origin.
			if !hasConfiguredOrigins {
				*errs = append(*errs, fmt.Sprintf("selfhost public API origin is invalid: %v", err))
			}
			continue
		}
		parsed, err := url.Parse(origin)
		if err != nil || !strings.EqualFold(parsed.Scheme, "http") || isLoopbackHostname(parsed.Hostname()) {
			continue
		}
		if cfg.Auth.CookieSecure {
			*errs = append(*errs, fmt.Sprintf("auth.cookie_secure must be false for non-loopback HTTP origin %q, or serve that origin over HTTPS", origin))
		}
	}
}

func isLoopbackHostname(host string) bool {
	host = strings.TrimSuffix(strings.ToLower(strings.TrimSpace(host)), ".")
	if host == "localhost" || strings.HasSuffix(host, ".localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func validateURL(raw string, requireHTTP bool) error {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		// url.Parse errors quote the raw input, which for a DSN carries the
		// password. Return only the underlying reason so startup logs never
		// persist credentials.
		var parseErr *url.Error
		if errors.As(err, &parseErr) {
			return fmt.Errorf("cannot parse URL: %v", parseErr.Err)
		}
		return fmt.Errorf("cannot parse URL: %v", err)
	}
	if u.Scheme == "" {
		return fmt.Errorf("missing scheme")
	}
	if requireHTTP && u.Scheme != "http" && u.Scheme != "https" {
		return fmt.Errorf("scheme must be http or https")
	}
	if u.Host == "" {
		return fmt.Errorf("missing host")
	}
	return nil
}
