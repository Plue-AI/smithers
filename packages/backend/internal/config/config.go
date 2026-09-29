package config

import (
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/spf13/viper"
)

// Config holds all configuration for the API server.
type Config struct {
	Agents   AgentsConfig   `mapstructure:"agents"`
	Server   ServerConfig   `mapstructure:"server"`
	Database DatabaseConfig `mapstructure:"database"`
	RepoHost RepoHostConfig `mapstructure:"repo_host"`
	Sandbox  SandboxConfig  `mapstructure:"sandbox"`
	SSH      SSHConfig      `mapstructure:"ssh"`
	Auth     AuthConfig     `mapstructure:"auth"`
	Billing  BillingConfig  `mapstructure:"billing"`
	Webhook  WebhookConfig  `mapstructure:"webhook"`
	// ProviderConnections names the Claude and Codex OAuth token endpoints
	// the bring-your-own-subscription refresh loop calls (RFD-003).
	ProviderConnections ProviderConnectionsConfig `mapstructure:"provider_connections"`
	Cleanup             CleanupConfig             `mapstructure:"cleanup"`
	Blob                BlobConfig                `mapstructure:"blob"`
	Observability       ObservabilityConfig       `mapstructure:"observability"`
	Email               EmailConfig               `mapstructure:"email"`
	FeatureFlags        FeatureFlagsConfig        `mapstructure:"feature_flags"`
	RateLimit           RateLimitConfig           `mapstructure:"rate_limit"`
	Chat                ChatConfig                `mapstructure:"chat"`
}

// ChatConfig sizes the chat turn dispatcher. Zero keeps the default for the
// deployment role: hosted API replicas run more turns than a single owner.
type ChatConfig struct {
	// Concurrency is the number of model turns one process produces at once.
	// Env: SMITHERS_CHAT_CONCURRENCY.
	Concurrency int `mapstructure:"concurrency"`
	// QueueSize bounds admitted turns waiting in memory. PostgreSQL recovery
	// delivers any turn the queue refuses. Env: SMITHERS_CHAT_QUEUE_SIZE.
	QueueSize int `mapstructure:"queue_size"`
	// LeaseSeconds is the producer lease. The dispatcher renews it while a
	// turn runs, so it bounds recovery after a crash, not turn length.
	// Env: SMITHERS_CHAT_LEASE_SECONDS.
	LeaseSeconds int `mapstructure:"lease_seconds"`
}

// AgentsConfig controls agent session provisioning health.
type AgentsConfig struct {
	NeverStartedTimeout string `mapstructure:"never_started_timeout"`
}

// RateLimitConfig controls the per-user rate limits and active-connection
// caps applied to remote-client attack surfaces such as terminal WebSockets
// and approval decisions. See ticket 0132 for design notes.
//
// Defaults are chosen to tolerate normal mobile client resume behavior.
// A single client reconnecting after a network blip or app foregrounding
// should not trip any of these limits. Operators can tighten them later
// once real production traffic patterns are known.
type RateLimitConfig struct {
	// TerminalOpenPerMin is the per-user rate at which new terminal
	// WebSocket connections can be opened. Env:
	// SMITHERS_RATE_LIMIT_TERMINAL_OPEN_PER_MIN. Default: 20.
	TerminalOpenPerMin int `mapstructure:"terminal_open_per_min"`

	// TerminalActiveMax is the per-user cap on concurrently-open terminal
	// WebSockets. Process-local (v1 limitation — see ticket 0132).
	// Env: SMITHERS_RATE_LIMIT_TERMINAL_ACTIVE_MAX. Default: 5.
	TerminalActiveMax int `mapstructure:"terminal_active_max"`

	// ApprovalDecidePerMin is the per-user rate at which
	// POST /approvals/{id}/decide requests are accepted. Env:
	// SMITHERS_RATE_LIMIT_APPROVAL_DECIDE_PER_MIN. Default: 30.
	ApprovalDecidePerMin int `mapstructure:"approval_decide_per_min"`

	// AppTimelineWritePerMin is the per-user rate for app-timeline writes
	// (event appends, rewrites, snapshots, member changes). Env:
	// SMITHERS_RATE_LIMIT_APP_TIMELINE_WRITE_PER_MIN. Default: 240.
	AppTimelineWritePerMin int `mapstructure:"app_timeline_write_per_min"`

	// ShareListingEventPerMin is the per-user rate at which install/run pings
	// against shared listings are accepted. These feed the public catalog's
	// usage stats, so the bucket is an anti-inflation control. Env:
	// SMITHERS_RATE_LIMIT_SHARE_LISTING_EVENT_PER_MIN. Default: 30.
	ShareListingEventPerMin int `mapstructure:"share_listing_event_per_min"`

	// BuildCachePerMinute is the per-principal rate for the smithers build
	// cache routes (reads and publications share one bucket). Env:
	// SMITHERS_RATE_LIMIT_BUILD_CACHE_PER_MIN. Default: 1200.
	BuildCachePerMinute int `mapstructure:"build_cache_per_min"`
}

// EmailConfig holds email transport configuration.
// SMTP is the only public transport; without a host, delivery is disabled.
type EmailConfig struct {
	// SMTP backend
	SMTPHost string `mapstructure:"smtp_host"`
	SMTPPort int    `mapstructure:"smtp_port"`
	SMTPUser string `mapstructure:"smtp_user"`
	SMTPPass string `mapstructure:"smtp_pass"`
	SMTPFrom string `mapstructure:"smtp_from"`
	// From is the default sender address. Falls back to SMTPFrom.
	From string `mapstructure:"from"`
	// Rate limiting
	RateLimitPerSecond         int `mapstructure:"rate_limit_per_second"`
	RateLimitPerRecipientPerHr int `mapstructure:"rate_limit_per_recipient_per_hr"`
}

// FeatureFlagsConfig controls which features are enabled in the platform.
// Most flags default to false; core launch and observability flags default to true.
type FeatureFlagsConfig struct {
	ReadoutDashboard     bool `mapstructure:"readout_dashboard"`
	LandingQueue         bool `mapstructure:"landing_queue"`
	ToolSkills           bool `mapstructure:"tool_skills"`
	ToolPolicies         bool `mapstructure:"tool_policies"`
	RepoSnapshots        bool `mapstructure:"repo_snapshots"`
	Integrations         bool `mapstructure:"integrations"`
	SessionReplay        bool `mapstructure:"session_replay"`
	SecretsManager       bool `mapstructure:"secrets_manager"`
	WebEditor            bool `mapstructure:"web_editor"`
	ClientErrorReporting bool `mapstructure:"client_error_reporting"`
	ClientMetrics        bool `mapstructure:"client_metrics"`

	// iOS + remote-sandbox rollout flags (see ticket 0101 rollout plan; 0112 adds them).

	// RemoteSandboxEnabled gates the remote-sandbox client surfaces used by iOS and
	// desktop remote clients (OAuth2 sign-in, sandbox API, mobile productization).
	// Owner: tickets 0109 + 0113 (umbrella) and 0120–0126. Env: SMITHERS_REMOTE_SANDBOX_ENABLED.
	RemoteSandboxEnabled bool `mapstructure:"remote_sandbox_enabled"`

	// ApprovalsFlowEnabled gates the tool-call approvals flow (request / approve / deny lifecycle).
	// Owner: ticket 0110 (Smithers approvals implementation). Env: SMITHERS_APPROVALS_FLOW_ENABLED.
	ApprovalsFlowEnabled bool `mapstructure:"approvals_flow_enabled"`

	// DevtoolsSnapshotEnabled gates the devtools snapshot surface used for debugging agent state.
	// Owner: ticket 0107 (Smithers devtools snapshot surface). Env: SMITHERS_DEVTOOLS_SNAPSHOT_ENABLED.
	DevtoolsSnapshotEnabled bool `mapstructure:"devtools_snapshot_enabled"`

	// RunShapeEnabled gates the run shape + route reconciliation surface that unifies per-run state.
	// Owner: ticket 0111 (Smithers run shape + route reconciliation). Env: SMITHERS_RUN_SHAPE_ENABLED.
	RunShapeEnabled bool `mapstructure:"run_shape_enabled"`

	// MVP gating flags (ticket 12). These flags gate entire route families that
	// are NOT part of the MVP. When false, the corresponding routes return
	// 403 "feature not available" via the FeatureFlagGate middleware. The MVP
	// surface (StackedPRs, Workflows, Sandboxes, AutoPush, Secrets) defaults to
	// true so the platform's core features are reachable out of the box. Every
	// other flag defaults to false until that feature ships.

	// StackedPRs gates the stacked-changes / stacked-PR family. MVP = true.
	StackedPRs bool `mapstructure:"stacked_prs"`
	// Workflows gates the legacy workflow execution family. Hosted Plue opts in
	// explicitly until canonical Flow trigger ingestion replaces it.
	Workflows bool `mapstructure:"workflows"`
	// Sandboxes gates workspace + agent sandbox creation. MVP = true.
	Sandboxes bool `mapstructure:"sandboxes"`
	// AutoPush gates the jj auto-push hook surface. MVP = true.
	AutoPush bool `mapstructure:"auto_push"`

	// Issues gates /issues, issue comments, issue artifacts. Default true.
	Issues bool `mapstructure:"issues"`
	// Search gates /api/search/*. Default false.
	Search bool `mapstructure:"search"`
	// Workspaces gates the standalone workspaces routes (separate from Sandboxes). Default true.
	Workspaces bool `mapstructure:"workspaces"`
	// Agents gates the agent sessions / messages REST surface. Default false.
	Agents bool `mapstructure:"agents"`
	// WebDashboard gates the web dashboard read-out surface. Default false.
	WebDashboard bool `mapstructure:"web_dashboard"`
	// Changesets gates /orgs/{org}/changesets: cross-repository changesets
	// landed through the organization superproject. Default false.
	Changesets bool `mapstructure:"changesets"`
	// SubscriptionConnections lets each user connect their own ChatGPT (Codex)
	// subscription login or Anthropic API key so their own agent runs and
	// workspaces authenticate with it through the pool route. A Claude
	// subscription token is refused even with the flag on (#2777). Default false,
	// and the hosted product keeps it false: storing subscription logins is for
	// self-hosters running their own subscriptions, never a service offered to
	// others. When false the /provider-connections routes and the account pool
	// return 403, the refresh worker does not start, and no run or workspace
	// resolves a stored token.
	// Env: SMITHERS_FEATURE_FLAGS_SUBSCRIPTION_CONNECTIONS.
	SubscriptionConnections bool `mapstructure:"subscription_connections"`
	// ProtectedBookmarks gates branch / bookmark protection rules. Default false.
	ProtectedBookmarks bool `mapstructure:"protected_bookmarks"`
	// Notifications gates /notifications and /notifications/list. Default false.
	Notifications bool `mapstructure:"notifications"`
	// Wiki gates the wiki routes. Default false.
	Wiki bool `mapstructure:"wiki"`
	// Labels gates label CRUD (repo + issue labels). Default false.
	Labels bool `mapstructure:"labels"`
	// Releases gates the releases / release-asset routes. Default false.
	Releases bool `mapstructure:"releases"`
	// Secrets gates per-repo secret management. Default true because unattended
	// workflow runs cannot use browser-local connector credentials.
	Secrets bool `mapstructure:"secrets"`
	// WebhooksUser gates the per-repo webhook management surface (/hooks). Default false.
	WebhooksUser bool `mapstructure:"webhooks_user"`
	// BotCommands gates inbound bot-command parsing in comments. Default false.
	BotCommands bool `mapstructure:"bot_commands"`
	// DraftPRs gates the draft landing-request / PR flow. Default false.
	DraftPRs bool `mapstructure:"draft_prs"`
	// Reviewers gates code-review reviewer assignment routes. Default false.
	Reviewers bool `mapstructure:"reviewers"`
	// MultiAuth gates the multi-provider auth surface (Auth0, Linear OAuth). Default false.
	MultiAuth bool `mapstructure:"multi_auth"`
	// PrivateRepos gates creating / using private repositories. Default false.
	PrivateRepos bool `mapstructure:"private_repos"`
}

type ObservabilityConfig struct {
	// LogLevel sets the minimum log level (debug, info, warn, error). Default: info.
	// Env: SMITHERS_LOG_LEVEL
	LogLevel string `mapstructure:"log_level"`

	// TraceSampleRate sets the OpenTelemetry trace sampling rate (0.0–1.0).
	// Default: 0.01 (1% for production). Set to 1.0 for local development.
	// Env: SMITHERS_TRACE_SAMPLE_RATE
	TraceSampleRate float64 `mapstructure:"trace_sample_rate"`

	// OTelExporter selects the trace exporter backend.
	// Valid: "none" (default), "otlp". A deployment exporter such as Cloud
	// Trace is injected by the host, not selected here. Env: SMITHERS_OTEL_EXPORTER
	OTelExporter string `mapstructure:"otel_exporter"`

	// OTLPEndpoint is the OTLP/HTTP trace collector endpoint used when
	// OTelExporter is "otlp". Env: SMITHERS_OTEL_EXPORTER_OTLP_ENDPOINT
	OTLPEndpoint string `mapstructure:"otlp_endpoint"`

	// MetricsAddr is the listen address of the Prometheus /metrics endpoint in
	// a workers-only process, which serves no product router. It requires the
	// same SMITHERS_METRICS_TOKEN bearer token as the router's /metrics. Empty
	// exports no worker metrics; processes that serve HTTP reject it.
	// Env: SMITHERS_METRICS_ADDR
	MetricsAddr string `mapstructure:"metrics_addr"`
}

type ServerConfig struct {
	Addr string `mapstructure:"addr"`
	// PublicURL is the externally reachable origin for browser, email, Git,
	// and blob transfer links. Env: SMITHERS_PUBLIC_URL.
	PublicURL        string `mapstructure:"public_url"`
	ReadTimeoutSecs  int    `mapstructure:"read_timeout_secs"`
	WriteTimeoutSecs int    `mapstructure:"write_timeout_secs"`
	ShutdownTimeout  string `mapstructure:"shutdown_timeout"`
	SSHHost          string `mapstructure:"ssh_host"`
	// AllowedOrigins is the explicit CORS allowlist for the API server.
	// When empty, the server allows its configured public origin. LAN,
	// public, and native-webview origins must be listed exactly; loopback
	// aliases are not interchangeable.
	// Env: SMITHERS_SERVER_ALLOWED_ORIGINS (comma-separated).
	AllowedOrigins []string `mapstructure:"allowed_origins"`
	// TrustedProxyHops is the number of trailing X-Forwarded-For entries
	// appended by trusted proxies in front of the server. 0 (default)
	// ignores forwarding headers entirely; set 1 behind GCLB (GKE Ingress).
	// Env: SMITHERS_SERVER_TRUSTED_PROXY_HOPS.
	TrustedProxyHops int `mapstructure:"trusted_proxy_hops"`
}

type DatabaseConfig struct {
	URL             string `mapstructure:"url"`
	MaxConns        int32  `mapstructure:"max_conns"`
	MinConns        int32  `mapstructure:"min_conns"`
	MaxConnLifetime int    `mapstructure:"max_conn_lifetime_secs"`
	MaxConnIdleTime int    `mapstructure:"max_conn_idle_time_secs"`
}

type RepoHostConfig struct {
	URL                   string `mapstructure:"url"`
	AuthToken             string `mapstructure:"auth_token"`
	PushHookCallbackToken string `mapstructure:"push_hook_callback_token"`
}

// SandboxConfig holds product compute requirements. Deployment transport
// settings belong to the injected provider.
type SandboxConfig struct {
	GoldenSnapshotsEnabled bool   `mapstructure:"golden_snapshots_enabled"`
	AgentSnapshotID        string `mapstructure:"agent_snapshot_id"`
	AgentMemoryMB          int32  `mapstructure:"agent_memory_mb"`
	AgentVCPUCount         int32  `mapstructure:"agent_vcpu_count"`
	AgentRootfsSizeMB      int64  `mapstructure:"agent_rootfs_size_mb"`
	AgentMaxRuntimeSecs    int64  `mapstructure:"agent_max_runtime_seconds"`
	AgentIdleTimeoutSecs   int64  `mapstructure:"agent_idle_timeout_seconds"`
	// WorkspaceMemoryMB and WorkspaceVCPUCount size kind=vm/container workspaces.
	WorkspaceMemoryMB  int32 `mapstructure:"workspace_memory_mb"`
	WorkspaceVCPUCount int32 `mapstructure:"workspace_vcpu_count"`
	// DesktopMemoryMB and DesktopVCPUCount size kind=desktop workspace VMs.
	// Non-positive values keep the service defaults.
	DesktopMemoryMB  int32 `mapstructure:"desktop_memory_mb"`
	DesktopVCPUCount int32 `mapstructure:"desktop_vcpu_count"`
	// DesktopObserveText enables reading the focused Chrome tab's document
	// text in POST .../desktop/observe. It is the operator's kill switch for a
	// prompt-injection channel: the text is chosen by whatever page the box is
	// displaying. On by default because it is the cheapest useful observation
	// an agent can take; turning it off makes every observation report
	// text: null without a code change.
	DesktopObserveText bool `mapstructure:"desktop_observe_text"`
	// AgentMaxConcurrent is a GLOBAL (fleet-wide) cap on how many agent sandbox
	// VMs may be allocated at once, enforced on the dispatch path via a DB COUNT
	// of live agent sessions. It is a capacity guard against a runaway
	// agent loop (AgentMaxRuntimeSecs only bounds each VM's lifetime, not how many
	// spawn). 0 means UNLIMITED/disabled — the knob is opt-in and must be set
	// explicitly (e.g. in Helm) to take effect, so the code default never changes
	// prod behavior.
	AgentMaxConcurrent   int32  `mapstructure:"agent_max_concurrent"`
	WorkspaceIdleTimeout int64  `mapstructure:"workspace_idle_timeout"`
	WorkspacePersistence string `mapstructure:"workspace_persistence"`
	WorkspaceSSHHost     string `mapstructure:"workspace_ssh_host"`
	WorkspaceSSHDialHost string `mapstructure:"workspace_ssh_dial_host"`

	// Optional public model pin for workspace coding. Repository model settings
	// and runtime credentials keep precedence; pool-only defaults resolve at host start.
	WorkspaceCodingDefaultModel string `mapstructure:"workspace_coding_default_model"`

	// PreviewRelayToken is the shared credential the preview gateway demands
	// for platform domains (its SMITHERS_PREVIEW_RELAY_TOKEN). The gateway is
	// public for user previews, so the desktop relay presents this on every
	// request.
	// Empty means every such request is refused with 401.
	// Env: SMITHERS_PREVIEW_RELAY_TOKEN.
	PreviewRelayToken string `mapstructure:"preview_relay_token"`
}

type SSHConfig struct {
	Addr                     string `mapstructure:"addr"`
	HostKeyDir               string `mapstructure:"host_key_dir"`
	MaxConnections           int    `mapstructure:"max_connections"`
	MaxConnectionsPerIP      int    `mapstructure:"max_connections_per_ip"`
	MaxReceivePackSize       int64  `mapstructure:"max_receive_pack_size"`
	MaxUploadPackRequestSize int64  `mapstructure:"max_upload_pack_request_size"`
	ReceivePackTimeout       string `mapstructure:"receive_pack_timeout"`
	UploadPackTimeout        string `mapstructure:"upload_pack_timeout"`
	ShutdownDrainTimeout     string `mapstructure:"shutdown_drain_timeout"`
	AuthAttemptsPerMinute    int    `mapstructure:"auth_attempts_per_minute"`
	IdleTimeout              string `mapstructure:"idle_timeout"`
	MaxTimeout               string `mapstructure:"max_timeout"`
	MaxSessionsPerConn       int    `mapstructure:"max_sessions_per_conn"`
}

type AuthConfig struct {
	// Mode selects identity topology, not product features. It is required:
	// SMITHERS_ENV cannot distinguish a production selfhost from Plue dev/test.
	Mode                 string `mapstructure:"mode"`
	BootstrapToken       string `mapstructure:"bootstrap_token"`
	SessionDuration      string `mapstructure:"session_duration"`
	SessionRefreshWindow string `mapstructure:"session_refresh_window"`
	SessionCookieName    string `mapstructure:"session_cookie_name"`
	SessionSecret        string `mapstructure:"session_secret"`
	// LFSSigningSecret signs the short-lived credentials that bridge an
	// authenticated SSH session to the HTTP Git LFS API. It is deliberately
	// separate from SessionSecret so the public SSH tier never receives the
	// application's session/provider-token encryption key.
	LFSSigningSecret   string `mapstructure:"lfs_signing_secret"`
	CookieSecure       bool   `mapstructure:"cookie_secure"`
	ClosedAlphaEnabled bool   `mapstructure:"closed_alpha_enabled"`
	EnableKeyAuth      bool   `mapstructure:"enable_key_auth"`
	KeyAuthDomain      string `mapstructure:"key_auth_domain"`
	GitHubClientID     string `mapstructure:"github_client_id"`
	GitHubClientSecret string `mapstructure:"github_client_secret"`
	GitHubRedirectURL  string `mapstructure:"github_redirect_url"`
	GitHubOAuthBaseURL string `mapstructure:"github_oauth_base_url"`
	GitHubAPIBaseURL   string `mapstructure:"github_api_base_url"`
	Auth0Domain        string `mapstructure:"auth0_domain"`
	Auth0ClientID      string `mapstructure:"auth0_client_id"`
	Auth0ClientSecret  string `mapstructure:"auth0_client_secret"`
	Auth0RedirectURL   string `mapstructure:"auth0_redirect_url"`
	Auth0Connection    string `mapstructure:"auth0_connection"`
	LinearClientID     string `mapstructure:"linear_client_id"`
	LinearClientSecret string `mapstructure:"linear_client_secret"`
	LinearRedirectURL  string `mapstructure:"linear_redirect_url"`
	// WorkerExchangeToken is the shared secret that trusted first-party
	// workers (e.g. the multi frontend's Cloudflare Worker) present as a
	// Bearer token to call POST /api/auth/github/token-exchange. When unset
	// the endpoint fails closed (RequireSharedBearerToken rejects everything).
	WorkerExchangeToken string `mapstructure:"worker_exchange_token"`
}

type WebhookConfig struct {
	SecretEncryptionKey string `mapstructure:"secret_encryption_key"`
	GitHubAppSecret     string `mapstructure:"github_app_secret"`
	// GitHubSyncURL and GitHubSyncSecret name the deployment's github-sync
	// Smithers webhook endpoint and its signing secret. When both are set,
	// every repository mirrored to GitHub gets a hook there, so landings,
	// comments and commit statuses reach GitHub. Empty when none is deployed.
	GitHubSyncURL    string `mapstructure:"github_sync_url"`
	GitHubSyncSecret string `mapstructure:"github_sync_secret"`
}

// ProviderConnectionsConfig is the Codex token endpoint and the Codex CLI
// client id the refresh loop presents; tests point them at a local server.
type ProviderConnectionsConfig struct {
	CodexTokenURL string `mapstructure:"codex_token_url"`
	CodexClientID string `mapstructure:"codex_client_id"`
}

type BillingConfig struct {
	// Mode selects the one entitlement authority used by all product services.
	// "unlimited" is the single-owner self-host policy; "stripe" enables the
	// hosted account, usage, checkout, portal, and webhook implementation.
	Mode                     string `mapstructure:"mode"`
	StripeSecretKey          string `mapstructure:"stripe_secret_key"`
	StripeWebhookSecret      string `mapstructure:"stripe_webhook_secret"`
	PortalReturnURL          string `mapstructure:"portal_return_url"`
	CheckoutSuccessURL       string `mapstructure:"checkout_success_url"`
	CheckoutCancelURL        string `mapstructure:"checkout_cancel_url"`
	PersonalMonthlyPriceID   string `mapstructure:"personal_monthly_price_id"`
	PersonalAnnualPriceID    string `mapstructure:"personal_annual_price_id"`
	ProMonthlyPriceID        string `mapstructure:"pro_monthly_price_id"`
	ProAnnualPriceID         string `mapstructure:"pro_annual_price_id"`
	MaxMonthlyPriceID        string `mapstructure:"max_monthly_price_id"`
	MaxAnnualPriceID         string `mapstructure:"max_annual_price_id"`
	TeamMonthlyPriceID       string `mapstructure:"team_monthly_price_id"`
	TeamAnnualPriceID        string `mapstructure:"team_annual_price_id"`
	EnterpriseMonthlyPriceID string `mapstructure:"enterprise_monthly_price_id"`
	EnterpriseAnnualPriceID  string `mapstructure:"enterprise_annual_price_id"`
}

type CleanupConfig struct {
	AuthInterval                    string `mapstructure:"auth_interval"`
	WorkflowCacheInterval           string `mapstructure:"workflow_cache_interval"`
	SandboxEgressAuditRetentionDays int64  `mapstructure:"sandbox_egress_audit_retention_days"`
}

type BlobConfig struct {
	// DataDir configures the durable local adapter when no store is injected.
	DataDir string `mapstructure:"data_dir"`
	// TransferSigningKey optionally supplies the local application-transfer
	// HMAC key. When empty, the adapter persists a generated key in DataDir.
	TransferSigningKey string `mapstructure:"transfer_signing_key"`
	// MaxBytes is a global safety ceiling in addition to product-level owner and
	// repository quotas. Zero means the product quotas are the only ceiling.
	MaxBytes int64 `mapstructure:"max_bytes"`
	// ReserveBytes keeps filesystem capacity available to the API and database.
	ReserveBytes int64 `mapstructure:"reserve_bytes"`
	// TransferBaseURL is assigned by shared composition from the trusted public
	// API origin; it is not a second externally configurable origin.
	TransferBaseURL              string `mapstructure:"-"`
	SignedURLExpiry              string `mapstructure:"signed_url_expiry"`
	WorkflowCachePrefix          string `mapstructure:"workflow_cache_prefix"`
	WorkflowCacheTTL             string `mapstructure:"workflow_cache_ttl"`
	WorkflowCacheRepoQuotaBytes  int64  `mapstructure:"workflow_cache_repo_quota_bytes"`
	WorkflowCacheArchiveMaxBytes int64  `mapstructure:"workflow_cache_archive_max_bytes"`
	// BuildCacheArtifactMaxBytes bounds one artifact (PUT /cas) of the
	// per-repository smithers build cache; 0 selects the protocol default of
	// 16 MiB, which is also the absolute ceiling.
	BuildCacheArtifactMaxBytes int64 `mapstructure:"build_cache_artifact_max_bytes"`
	BuildCacheMaxAgeDays       int   `mapstructure:"build_cache_max_age_days"`
	BuildCacheRepoQuotaBytes   int64 `mapstructure:"build_cache_repo_quota_bytes"`
}

// Load reads configuration from config files, environment variables, and defaults.
func Load(configFile string) (*Config, error) {
	v := viper.New()

	// Defaults
	v.SetDefault("server.addr", ":4000")
	v.SetDefault("server.public_url", "http://localhost:4000")
	v.SetDefault("server.read_timeout_secs", 30)
	v.SetDefault("server.write_timeout_secs", 0)
	v.SetDefault("server.shutdown_timeout", "30s")
	v.SetDefault("server.ssh_host", "localhost")
	v.SetDefault("server.trusted_proxy_hops", 0)
	// No default DB URL: a real connection string (with TLS) must be supplied
	// via SMITHERS_DATABASE_URL. Startup validation rejects an empty value so we
	// never silently fall back to insecure local credentials with TLS disabled.
	v.SetDefault("database.url", "")
	v.SetDefault("database.max_conns", 25)
	v.SetDefault("database.min_conns", 5)
	v.SetDefault("database.max_conn_lifetime_secs", 3600)
	v.SetDefault("database.max_conn_idle_time_secs", 1800)
	v.SetDefault("repo_host.url", "http://localhost:8080")
	v.SetDefault("repo_host.auth_token", "")
	v.SetDefault("repo_host.push_hook_callback_token", "")
	v.SetDefault("sandbox.golden_snapshots_enabled", true)
	v.SetDefault("sandbox.agent_snapshot_id", "")
	// Agent guests are model-latency-bound, not CPU-bound: 1 vCPU/3 GiB packs
	// 7 per worker (CPU binds: 7×1000m vs the 7000m budget) vs 3 at 2 vCPU.
	v.SetDefault("sandbox.agent_memory_mb", 3072)
	v.SetDefault("sandbox.workspace_memory_mb", 4096)
	v.SetDefault("sandbox.workspace_vcpu_count", 2)
	v.SetDefault("sandbox.agent_vcpu_count", 1)
	v.SetDefault("sandbox.agent_rootfs_size_mb", 2048)
	v.SetDefault("sandbox.agent_max_runtime_seconds", 1800)
	v.SetDefault("sandbox.agent_idle_timeout_seconds", 300)
	// A desktop guest runs XFCE on Xvnc plus a browser; the provider's 512 MiB
	// default OOMs on the first page. 1 vCPU keeps 7 desktops per worker.
	v.SetDefault("sandbox.desktop_memory_mb", 2048)
	v.SetDefault("sandbox.desktop_vcpu_count", 1)
	v.SetDefault("sandbox.desktop_observe_text", true)
	// 0 = unlimited/disabled. Opt-in spend guard; enabling it (e.g. via
	// SMITHERS_SANDBOX_AGENT_MAX_CONCURRENT in Helm) is a deliberate change.
	v.SetDefault("sandbox.agent_max_concurrent", 0)
	v.SetDefault("sandbox.workspace_idle_timeout", 1800)
	v.SetDefault("sandbox.workspace_persistence", "persistent")
	v.SetDefault("sandbox.workspace_ssh_host", "ssh.smithers.sh")
	v.SetDefault("ssh.addr", ":2222")
	v.SetDefault("ssh.host_key_dir", "./data/ssh")
	v.SetDefault("ssh.max_connections", 100)
	v.SetDefault("ssh.max_connections_per_ip", 10)
	v.SetDefault("ssh.max_receive_pack_size", 500*1024*1024)
	v.SetDefault("ssh.max_upload_pack_request_size", 10*1024*1024)
	v.SetDefault("ssh.receive_pack_timeout", "10m")
	v.SetDefault("ssh.upload_pack_timeout", "")
	v.SetDefault("ssh.shutdown_drain_timeout", "30s")
	v.SetDefault("ssh.auth_attempts_per_minute", 0) // 0 means use package default (20)
	v.SetDefault("ssh.idle_timeout", "")            // empty means derive from pack timeouts
	v.SetDefault("ssh.max_timeout", "")             // empty means use package default (2h)
	v.SetDefault("ssh.max_sessions_per_conn", 0)    // 0 means use package default (10)
	v.SetDefault("auth.mode", "")
	v.SetDefault("auth.bootstrap_token", "")
	v.SetDefault("auth.session_duration", "720h")
	v.SetDefault("auth.session_refresh_window", "168h")
	v.SetDefault("auth.session_cookie_name", "smithers_session")
	v.SetDefault("auth.session_secret", "")
	v.SetDefault("auth.lfs_signing_secret", "")
	v.SetDefault("auth.cookie_secure", true)
	v.SetDefault("auth.closed_alpha_enabled", true)
	v.SetDefault("auth.enable_key_auth", true)
	v.SetDefault("auth.key_auth_domain", "smithers.sh")
	v.SetDefault("auth.github_client_id", "")
	v.SetDefault("auth.github_client_secret", "")
	v.SetDefault("auth.github_redirect_url", "http://localhost:4000/api/auth/github/callback")
	v.SetDefault("auth.github_oauth_base_url", "https://github.com")
	v.SetDefault("auth.github_api_base_url", "https://api.github.com")
	v.SetDefault("auth.auth0_domain", "")
	v.SetDefault("auth.auth0_client_id", "")
	v.SetDefault("auth.auth0_client_secret", "")
	v.SetDefault("auth.auth0_redirect_url", "http://localhost:4000/api/auth/auth0/callback")
	v.SetDefault("auth.auth0_connection", "github")
	v.SetDefault("auth.linear_client_id", "")
	v.SetDefault("auth.linear_client_secret", "")
	v.SetDefault("auth.linear_redirect_url", "http://localhost:4000/api/auth/linear/callback")
	v.SetDefault("billing.mode", "unlimited")
	v.SetDefault("billing.stripe_secret_key", "")
	v.SetDefault("billing.stripe_webhook_secret", "")
	v.SetDefault("billing.portal_return_url", "")
	v.SetDefault("billing.checkout_success_url", "")
	v.SetDefault("billing.checkout_cancel_url", "")
	v.SetDefault("billing.personal_monthly_price_id", "")
	v.SetDefault("billing.personal_annual_price_id", "")
	v.SetDefault("billing.pro_monthly_price_id", "")
	v.SetDefault("billing.pro_annual_price_id", "")
	v.SetDefault("billing.max_monthly_price_id", "")
	v.SetDefault("billing.max_annual_price_id", "")
	v.SetDefault("billing.team_monthly_price_id", "")
	v.SetDefault("billing.team_annual_price_id", "")
	v.SetDefault("billing.enterprise_monthly_price_id", "")
	v.SetDefault("billing.enterprise_annual_price_id", "")
	v.SetDefault("webhook.secret_encryption_key", "")
	v.SetDefault("provider_connections.codex_token_url", "https://auth.openai.com/oauth/token")
	v.SetDefault("provider_connections.codex_client_id", "app_EMoamEEZ73f0CkXaXp7hrann")
	v.SetDefault("webhook.github_app_secret", "")
	v.SetDefault("webhook.github_sync_url", "")
	v.SetDefault("webhook.github_sync_secret", "")
	v.SetDefault("agents.never_started_timeout", "1h")
	v.SetDefault("cleanup.auth_interval", "5m")
	v.SetDefault("cleanup.workflow_cache_interval", "1h")
	v.SetDefault("cleanup.sandbox_egress_audit_retention_days", 30)
	v.SetDefault("blob.data_dir", "./data/blobs")
	v.SetDefault("blob.transfer_signing_key", "")
	v.SetDefault("blob.max_bytes", 0)
	v.SetDefault("blob.reserve_bytes", 256*1024*1024)
	v.SetDefault("blob.signed_url_expiry", "5m")
	v.SetDefault("blob.workflow_cache_prefix", "workflow-cache")
	v.SetDefault("blob.workflow_cache_ttl", "168h")
	v.SetDefault("blob.workflow_cache_repo_quota_bytes", 2*1024*1024*1024)
	v.SetDefault("blob.workflow_cache_archive_max_bytes", 1024*1024*1024)
	v.SetDefault("blob.build_cache_artifact_max_bytes", 16*1024*1024)
	v.SetDefault("blob.build_cache_max_age_days", 30)
	v.SetDefault("blob.build_cache_repo_quota_bytes", 1<<30)
	v.SetDefault("observability.log_level", "info")
	v.SetDefault("observability.trace_sample_rate", 0.01)
	v.SetDefault("observability.otel_exporter", "none")
	v.SetDefault("observability.otlp_endpoint", "")
	v.SetDefault("observability.metrics_addr", "")
	v.SetDefault("email.smtp_host", "")
	v.SetDefault("email.smtp_port", 587)
	v.SetDefault("email.smtp_user", "")
	v.SetDefault("email.smtp_pass", "")
	v.SetDefault("email.smtp_from", "noreply@smithers.sh")
	v.SetDefault("email.from", "noreply@smithers.sh")
	v.SetDefault("email.rate_limit_per_second", 10)
	v.SetDefault("email.rate_limit_per_recipient_per_hr", 20)
	v.SetDefault("feature_flags.readout_dashboard", false)
	v.SetDefault("feature_flags.landing_queue", false)
	v.SetDefault("feature_flags.tool_skills", false)
	v.SetDefault("feature_flags.tool_policies", false)
	v.SetDefault("feature_flags.repo_snapshots", false)
	v.SetDefault("feature_flags.integrations", false)
	v.SetDefault("feature_flags.session_replay", false)
	v.SetDefault("feature_flags.secrets_manager", false)
	v.SetDefault("feature_flags.web_editor", false)
	v.SetDefault("feature_flags.client_error_reporting", true)
	v.SetDefault("feature_flags.client_metrics", true)
	// Ticket 0132: rate-limit defaults for remote-client surfaces.
	v.SetDefault("rate_limit.terminal_open_per_min", 20)
	v.SetDefault("rate_limit.terminal_active_max", 5)
	v.SetDefault("rate_limit.approval_decide_per_min", 30)
	v.SetDefault("rate_limit.app_timeline_write_per_min", 240)
	v.SetDefault("rate_limit.share_listing_event_per_min", 30)
	v.SetDefault("rate_limit.build_cache_per_min", 1200)
	v.SetDefault("chat.concurrency", 0)
	v.SetDefault("chat.queue_size", 0)
	v.SetDefault("chat.lease_seconds", 0)

	// iOS + remote-sandbox rollout flags (ticket 0112) — all default false.
	v.SetDefault("feature_flags.remote_sandbox_enabled", false)
	v.SetDefault("feature_flags.approvals_flow_enabled", false)
	v.SetDefault("feature_flags.devtools_snapshot_enabled", false)
	v.SetDefault("feature_flags.run_shape_enabled", false)

	// Core repository operations are available in every deployment mode.
	// Operators can still override the legacy flags per environment.
	v.SetDefault("feature_flags.stacked_prs", true)
	v.SetDefault("feature_flags.workflows", false)
	v.SetDefault("feature_flags.sandboxes", true)
	v.SetDefault("feature_flags.auto_push", true)

	v.SetDefault("feature_flags.issues", true)
	v.SetDefault("feature_flags.search", false)
	v.SetDefault("feature_flags.workspaces", true)
	v.SetDefault("feature_flags.agents", false)
	v.SetDefault("feature_flags.web_dashboard", false)
	v.SetDefault("feature_flags.changesets", false)
	v.SetDefault("feature_flags.subscription_connections", false)
	v.SetDefault("feature_flags.protected_bookmarks", false)
	v.SetDefault("feature_flags.notifications", false)
	v.SetDefault("feature_flags.wiki", false)
	v.SetDefault("feature_flags.labels", false)
	v.SetDefault("feature_flags.releases", false)
	v.SetDefault("feature_flags.secrets", true)
	v.SetDefault("feature_flags.webhooks_user", false)
	v.SetDefault("feature_flags.bot_commands", false)
	v.SetDefault("feature_flags.draft_prs", false)
	v.SetDefault("feature_flags.reviewers", false)
	v.SetDefault("feature_flags.multi_auth", false)
	v.SetDefault("feature_flags.private_repos", false)

	// Env overrides
	v.SetEnvPrefix("SMITHERS")
	v.AutomaticEnv()

	// Bind specific env vars (BindEnv never returns an error for static bindings)
	for _, b := range [][2]string{
		{"server.addr", "SMITHERS_SERVER_ADDR"},
		{"server.public_url", "SMITHERS_PUBLIC_URL"},
		{"server.read_timeout_secs", "SMITHERS_SERVER_READ_TIMEOUT_SECS"},
		{"server.write_timeout_secs", "SMITHERS_SERVER_WRITE_TIMEOUT_SECS"},
		{"server.shutdown_timeout", "SMITHERS_SERVER_SHUTDOWN_TIMEOUT"},
		{"server.ssh_host", "SMITHERS_SERVER_SSH_HOST"},
		{"server.allowed_origins", "SMITHERS_SERVER_ALLOWED_ORIGINS"},
		{"server.trusted_proxy_hops", "SMITHERS_SERVER_TRUSTED_PROXY_HOPS"},
		{"database.url", "SMITHERS_DATABASE_URL"},
		{"database.max_conns", "SMITHERS_DATABASE_MAX_CONNS"},
		{"database.min_conns", "SMITHERS_DATABASE_MIN_CONNS"},
		{"database.max_conn_lifetime_secs", "SMITHERS_DATABASE_MAX_CONN_LIFETIME_SECS"},
		{"database.max_conn_idle_time_secs", "SMITHERS_DATABASE_MAX_CONN_IDLE_TIME_SECS"},
		{"repo_host.url", "SMITHERS_REPO_HOST_URL"},
		{"ssh.addr", "SMITHERS_SSH_ADDR"},
		{"ssh.host_key_dir", "SMITHERS_SSH_HOST_KEY_DIR"},
		{"ssh.max_connections", "SMITHERS_SSH_MAX_CONNECTIONS"},
		{"ssh.max_connections_per_ip", "SMITHERS_SSH_MAX_CONNECTIONS_PER_IP"},
		{"ssh.max_receive_pack_size", "SMITHERS_SSH_MAX_RECEIVE_PACK_SIZE"},
		{"ssh.max_upload_pack_request_size", "SMITHERS_SSH_MAX_UPLOAD_PACK_REQUEST_SIZE"},
		{"ssh.receive_pack_timeout", "SMITHERS_SSH_RECEIVE_PACK_TIMEOUT"},
		{"ssh.upload_pack_timeout", "SMITHERS_SSH_UPLOAD_PACK_TIMEOUT"},
		{"ssh.shutdown_drain_timeout", "SMITHERS_SSH_SHUTDOWN_DRAIN_TIMEOUT"},
		{"ssh.auth_attempts_per_minute", "SMITHERS_SSH_AUTH_ATTEMPTS_PER_MINUTE"},
		{"ssh.idle_timeout", "SMITHERS_SSH_IDLE_TIMEOUT"},
		{"ssh.max_timeout", "SMITHERS_SSH_MAX_TIMEOUT"},
		{"ssh.max_sessions_per_conn", "SMITHERS_SSH_MAX_SESSIONS_PER_CONN"},
		{"auth.session_duration", "SMITHERS_AUTH_SESSION_DURATION"},
		{"auth.session_refresh_window", "SMITHERS_AUTH_SESSION_REFRESH_WINDOW"},
		{"auth.session_cookie_name", "SMITHERS_AUTH_SESSION_COOKIE_NAME"},
		{"auth.session_secret", "SMITHERS_AUTH_SESSION_SECRET"},
		{"auth.lfs_signing_secret", "SMITHERS_LFS_SIGNING_SECRET"},
		{"auth.cookie_secure", "SMITHERS_AUTH_COOKIE_SECURE"},
		{"auth.closed_alpha_enabled", "SMITHERS_AUTH_CLOSED_ALPHA_ENABLED"},
		{"auth.enable_key_auth", "SMITHERS_AUTH_ENABLE_KEY_AUTH"},
		{"auth.key_auth_domain", "SMITHERS_AUTH_KEY_AUTH_DOMAIN"},
		{"auth.github_client_id", "SMITHERS_AUTH_GITHUB_CLIENT_ID"},
		{"auth.github_client_secret", "SMITHERS_AUTH_GITHUB_CLIENT_SECRET"},
		{"auth.github_redirect_url", "SMITHERS_AUTH_GITHUB_REDIRECT_URL"},
		{"auth.github_oauth_base_url", "SMITHERS_AUTH_GITHUB_OAUTH_BASE_URL"},
		{"auth.github_api_base_url", "SMITHERS_AUTH_GITHUB_API_BASE_URL"},
		{"auth.mode", "SMITHERS_AUTH_MODE"},
		{"auth.bootstrap_token", "SMITHERS_AUTH_BOOTSTRAP_TOKEN"},
		{"auth.auth0_domain", "SMITHERS_AUTH_AUTH0_DOMAIN"},
		{"auth.auth0_client_id", "SMITHERS_AUTH_AUTH0_CLIENT_ID"},
		{"auth.auth0_client_secret", "SMITHERS_AUTH_AUTH0_CLIENT_SECRET"},
		{"auth.auth0_redirect_url", "SMITHERS_AUTH_AUTH0_REDIRECT_URL"},
		{"auth.auth0_connection", "SMITHERS_AUTH_AUTH0_CONNECTION"},
		{"auth.linear_client_id", "SMITHERS_AUTH_LINEAR_CLIENT_ID"},
		{"auth.linear_client_secret", "SMITHERS_AUTH_LINEAR_CLIENT_SECRET"},
		{"auth.linear_redirect_url", "SMITHERS_AUTH_LINEAR_REDIRECT_URL"},
		{"auth.worker_exchange_token", "SMITHERS_AUTH_WORKER_EXCHANGE_TOKEN"},
		{"billing.mode", "SMITHERS_BILLING_MODE"},
		{"billing.stripe_secret_key", "SMITHERS_BILLING_STRIPE_SECRET_KEY"},
		{"billing.stripe_webhook_secret", "SMITHERS_BILLING_STRIPE_WEBHOOK_SECRET"},
		{"billing.portal_return_url", "SMITHERS_BILLING_PORTAL_RETURN_URL"},
		{"billing.checkout_success_url", "SMITHERS_BILLING_CHECKOUT_SUCCESS_URL"},
		{"billing.checkout_cancel_url", "SMITHERS_BILLING_CHECKOUT_CANCEL_URL"},
		{"billing.personal_monthly_price_id", "SMITHERS_BILLING_PERSONAL_MONTHLY_PRICE_ID"},
		{"billing.personal_annual_price_id", "SMITHERS_BILLING_PERSONAL_ANNUAL_PRICE_ID"},
		{"billing.pro_monthly_price_id", "SMITHERS_BILLING_PRO_MONTHLY_PRICE_ID"},
		{"billing.pro_annual_price_id", "SMITHERS_BILLING_PRO_ANNUAL_PRICE_ID"},
		{"billing.max_monthly_price_id", "SMITHERS_BILLING_MAX_MONTHLY_PRICE_ID"},
		{"billing.max_annual_price_id", "SMITHERS_BILLING_MAX_ANNUAL_PRICE_ID"},
		{"billing.team_monthly_price_id", "SMITHERS_BILLING_TEAM_MONTHLY_PRICE_ID"},
		{"billing.team_annual_price_id", "SMITHERS_BILLING_TEAM_ANNUAL_PRICE_ID"},
		{"billing.enterprise_monthly_price_id", "SMITHERS_BILLING_ENTERPRISE_MONTHLY_PRICE_ID"},
		{"billing.enterprise_annual_price_id", "SMITHERS_BILLING_ENTERPRISE_ANNUAL_PRICE_ID"},
		{"webhook.secret_encryption_key", "SMITHERS_WEBHOOK_SECRET_ENCRYPTION_KEY"},
		{"webhook.github_app_secret", "SMITHERS_WEBHOOK_GITHUB_APP_SECRET"},
		{"webhook.github_sync_url", "SMITHERS_WEBHOOK_GITHUB_SYNC_URL"},
		{"webhook.github_sync_secret", "SMITHERS_WEBHOOK_GITHUB_SYNC_SECRET"},
		{"agents.never_started_timeout", "SMITHERS_AGENT_NEVER_STARTED_TIMEOUT"},
		{"cleanup.auth_interval", "SMITHERS_CLEANUP_AUTH_INTERVAL"},
		{"cleanup.workflow_cache_interval", "SMITHERS_CLEANUP_WORKFLOW_CACHE_INTERVAL"},
		{"cleanup.sandbox_egress_audit_retention_days", "SMITHERS_CLEANUP_SANDBOX_EGRESS_AUDIT_RETENTION_DAYS"},
		{"blob.data_dir", "SMITHERS_BLOB_DATA_DIR"},
		{"blob.transfer_signing_key", "SMITHERS_BLOB_TRANSFER_SIGNING_KEY"},
		{"blob.max_bytes", "SMITHERS_BLOB_MAX_BYTES"},
		{"blob.reserve_bytes", "SMITHERS_BLOB_RESERVE_BYTES"},
		{"blob.signed_url_expiry", "SMITHERS_BLOB_SIGNED_URL_EXPIRY"},
		{"blob.workflow_cache_prefix", "SMITHERS_BLOB_WORKFLOW_CACHE_PREFIX"},
		{"blob.workflow_cache_ttl", "SMITHERS_BLOB_WORKFLOW_CACHE_TTL"},
		{"blob.workflow_cache_repo_quota_bytes", "SMITHERS_BLOB_WORKFLOW_CACHE_REPO_QUOTA_BYTES"},
		{"blob.workflow_cache_archive_max_bytes", "SMITHERS_BLOB_WORKFLOW_CACHE_ARCHIVE_MAX_BYTES"},
		{"blob.build_cache_artifact_max_bytes", "SMITHERS_BLOB_BUILD_CACHE_ARTIFACT_MAX_BYTES"},
		{"blob.build_cache_max_age_days", "SMITHERS_BLOB_BUILD_CACHE_MAX_AGE_DAYS"},
		{"blob.build_cache_repo_quota_bytes", "SMITHERS_BLOB_BUILD_CACHE_REPO_QUOTA_BYTES"},
		{"observability.log_level", "SMITHERS_LOG_LEVEL"},
		{"observability.trace_sample_rate", "SMITHERS_TRACE_SAMPLE_RATE"},
		{"observability.otel_exporter", "SMITHERS_OTEL_EXPORTER"},
		{"observability.otlp_endpoint", "SMITHERS_OTEL_EXPORTER_OTLP_ENDPOINT"},
		{"observability.metrics_addr", "SMITHERS_METRICS_ADDR"},
		{"email.smtp_host", "SMITHERS_EMAIL_SMTP_HOST"},
		{"email.smtp_port", "SMITHERS_EMAIL_SMTP_PORT"},
		{"email.smtp_user", "SMITHERS_EMAIL_SMTP_USER"},
		{"email.smtp_pass", "SMITHERS_EMAIL_SMTP_PASS"},
		{"email.smtp_from", "SMITHERS_EMAIL_SMTP_FROM"},
		{"email.from", "SMITHERS_EMAIL_FROM"},
		{"email.rate_limit_per_second", "SMITHERS_EMAIL_RATE_LIMIT_PER_SECOND"},
		{"email.rate_limit_per_recipient_per_hr", "SMITHERS_EMAIL_RATE_LIMIT_PER_RECIPIENT_PER_HR"},
		{"feature_flags.readout_dashboard", "SMITHERS_FEATURE_FLAGS_READOUT_DASHBOARD"},
		{"feature_flags.landing_queue", "SMITHERS_FEATURE_FLAGS_LANDING_QUEUE"},
		{"feature_flags.tool_skills", "SMITHERS_FEATURE_FLAGS_TOOL_SKILLS"},
		{"feature_flags.tool_policies", "SMITHERS_FEATURE_FLAGS_TOOL_POLICIES"},
		{"feature_flags.repo_snapshots", "SMITHERS_FEATURE_FLAGS_REPO_SNAPSHOTS"},
		{"feature_flags.integrations", "SMITHERS_FEATURE_FLAGS_INTEGRATIONS"},
		{"feature_flags.session_replay", "SMITHERS_FEATURE_FLAGS_SESSION_REPLAY"},
		{"feature_flags.secrets_manager", "SMITHERS_FEATURE_FLAGS_SECRETS_MANAGER"},
		{"feature_flags.web_editor", "SMITHERS_FEATURE_FLAGS_WEB_EDITOR"},
		{"feature_flags.client_error_reporting", "SMITHERS_FEATURE_FLAGS_CLIENT_ERROR_REPORTING"},
		{"feature_flags.client_metrics", "SMITHERS_FEATURE_FLAGS_CLIENT_METRICS"},
		// Ticket 12: MVP gating flags. Use the canonical SMITHERS_ prefix; these
		// gate route families server-side via FeatureFlagGate middleware.
		{"feature_flags.stacked_prs", "SMITHERS_FEATURE_FLAGS_STACKED_PRS"},
		{"feature_flags.workflows", "SMITHERS_FEATURE_FLAGS_WORKFLOWS"},
		{"feature_flags.sandboxes", "SMITHERS_FEATURE_FLAGS_SANDBOXES"},
		{"feature_flags.auto_push", "SMITHERS_FEATURE_FLAGS_AUTO_PUSH"},
		{"feature_flags.issues", "SMITHERS_FEATURE_FLAGS_ISSUES"},
		{"feature_flags.search", "SMITHERS_FEATURE_FLAGS_SEARCH"},
		{"feature_flags.workspaces", "SMITHERS_FEATURE_FLAGS_WORKSPACES"},
		{"feature_flags.agents", "SMITHERS_FEATURE_FLAGS_AGENTS"},
		{"feature_flags.web_dashboard", "SMITHERS_FEATURE_FLAGS_WEB_DASHBOARD"},
		{"feature_flags.changesets", "SMITHERS_FEATURE_FLAGS_CHANGESETS"},
		{"feature_flags.subscription_connections", "SMITHERS_FEATURE_FLAGS_SUBSCRIPTION_CONNECTIONS"},
		{"feature_flags.protected_bookmarks", "SMITHERS_FEATURE_FLAGS_PROTECTED_BOOKMARKS"},
		{"feature_flags.notifications", "SMITHERS_FEATURE_FLAGS_NOTIFICATIONS"},
		{"feature_flags.wiki", "SMITHERS_FEATURE_FLAGS_WIKI"},
		{"feature_flags.labels", "SMITHERS_FEATURE_FLAGS_LABELS"},
		{"feature_flags.releases", "SMITHERS_FEATURE_FLAGS_RELEASES"},
		{"feature_flags.secrets", "SMITHERS_FEATURE_FLAGS_SECRETS"},
		{"feature_flags.webhooks_user", "SMITHERS_FEATURE_FLAGS_WEBHOOKS_USER"},
		{"feature_flags.bot_commands", "SMITHERS_FEATURE_FLAGS_BOT_COMMANDS"},
		{"feature_flags.draft_prs", "SMITHERS_FEATURE_FLAGS_DRAFT_PRS"},
		{"feature_flags.reviewers", "SMITHERS_FEATURE_FLAGS_REVIEWERS"},
		{"feature_flags.multi_auth", "SMITHERS_FEATURE_FLAGS_MULTI_AUTH"},
		{"feature_flags.private_repos", "SMITHERS_FEATURE_FLAGS_PRIVATE_REPOS"},
	} {
		_ = v.BindEnv(b[0], b[1])
	}
	// iOS + remote-sandbox rollout flags (ticket 0112). These use the SMITHERS_ env prefix
	// per the ticket spec — they are intentionally not SMITHERS_FEATURE_FLAGS_* aliases.
	for _, b := range [][2]string{
		{"feature_flags.remote_sandbox_enabled", "SMITHERS_REMOTE_SANDBOX_ENABLED"},
		{"feature_flags.approvals_flow_enabled", "SMITHERS_APPROVALS_FLOW_ENABLED"},
		{"feature_flags.devtools_snapshot_enabled", "SMITHERS_DEVTOOLS_SNAPSHOT_ENABLED"},
		{"feature_flags.run_shape_enabled", "SMITHERS_RUN_SHAPE_ENABLED"},
		// Ticket 0132: SMITHERS_ prefix to stay consistent with sibling iOS /
		// remote-sandbox knobs (these limits are specifically for those
		// surfaces; they don't apply to legacy web traffic).
		{"rate_limit.terminal_open_per_min", "SMITHERS_RATE_LIMIT_TERMINAL_OPEN_PER_MIN"},
		{"rate_limit.terminal_active_max", "SMITHERS_RATE_LIMIT_TERMINAL_ACTIVE_MAX"},
		{"rate_limit.approval_decide_per_min", "SMITHERS_RATE_LIMIT_APPROVAL_DECIDE_PER_MIN"},
		{"rate_limit.app_timeline_write_per_min", "SMITHERS_RATE_LIMIT_APP_TIMELINE_WRITE_PER_MIN"},
		{"rate_limit.share_listing_event_per_min", "SMITHERS_RATE_LIMIT_SHARE_LISTING_EVENT_PER_MIN"},
		{"rate_limit.build_cache_per_min", "SMITHERS_RATE_LIMIT_BUILD_CACHE_PER_MIN"},
		{"chat.concurrency", "SMITHERS_CHAT_CONCURRENCY"},
		{"chat.queue_size", "SMITHERS_CHAT_QUEUE_SIZE"},
		{"chat.lease_seconds", "SMITHERS_CHAT_LEASE_SECONDS"},
	} {
		_ = v.BindEnv(b[0], b[1])
	}
	// Prefer the canonical SMITHERS_ prefix, but keep the legacy name as a temporary fallback.
	_ = v.BindEnv("database.url", "SMITHERS_DATABASE_URL", "DATABASE_URL")
	_ = v.BindEnv("repo_host.auth_token", "SMITHERS_REPO_HOST_AUTH_TOKEN", "REPO_HOST_AUTH_TOKEN")
	// These credentials intentionally have no fallback to repo_host.auth_token:
	// each crosses a narrower trust boundary than the repo-host control token.
	_ = v.BindEnv("repo_host.push_hook_callback_token", "SMITHERS_PUSH_HOOK_CALLBACK_TOKEN")

	// Provider selection and the self-hosted controller transport are explicit.
	// TLS file paths point at Secret Manager-backed Kubernetes volume mounts.
	for _, b := range [][2]string{
		{"sandbox.provider", "SMITHERS_SANDBOX_PROVIDER"},
		{"provider_connections.claude_token_url", "SMITHERS_PROVIDER_CONNECTIONS_CLAUDE_TOKEN_URL"},
		{"provider_connections.claude_client_id", "SMITHERS_PROVIDER_CONNECTIONS_CLAUDE_CLIENT_ID"},
		{"provider_connections.codex_token_url", "SMITHERS_PROVIDER_CONNECTIONS_CODEX_TOKEN_URL"},
		{"provider_connections.codex_client_id", "SMITHERS_PROVIDER_CONNECTIONS_CODEX_CLIENT_ID"},
		{"sandbox.golden_snapshots_enabled", "SMITHERS_GOLDEN_SNAPSHOTS_ENABLED"},
		{"sandbox.workspace_ssh_host", "SMITHERS_SANDBOX_WORKSPACE_SSH_HOST"},
		{"sandbox.workspace_ssh_dial_host", "SMITHERS_SANDBOX_WORKSPACE_SSH_DIAL_HOST"},
		{"sandbox.agent_snapshot_id", "SMITHERS_SANDBOX_AGENT_SNAPSHOT_ID"},
		{"sandbox.workspace_coding_default_model", "SMITHERS_WORKSPACE_CODING_DEFAULT_MODEL"},
		{"sandbox.preview_relay_token", "SMITHERS_PREVIEW_RELAY_TOKEN"},
	} {
		_ = v.BindEnv(b[0], b[1])
	}

	for _, b := range [][2]string{
		{"sandbox.agent_memory_mb", "SMITHERS_SANDBOX_AGENT_MEMORY_MB"},
		{"sandbox.workspace_memory_mb", "SMITHERS_SANDBOX_WORKSPACE_MEMORY_MB"},
		{"sandbox.workspace_vcpu_count", "SMITHERS_SANDBOX_WORKSPACE_VCPU_COUNT"},
		{"sandbox.agent_vcpu_count", "SMITHERS_SANDBOX_AGENT_VCPU_COUNT"},
		{"sandbox.agent_rootfs_size_mb", "SMITHERS_SANDBOX_AGENT_ROOTFS_SIZE_MB"},
		{"sandbox.agent_max_runtime_seconds", "SMITHERS_SANDBOX_AGENT_MAX_RUNTIME_SECONDS"},
		{"sandbox.agent_idle_timeout_seconds", "SMITHERS_SANDBOX_AGENT_IDLE_TIMEOUT_SECONDS"},
		{"sandbox.desktop_memory_mb", "SMITHERS_SANDBOX_DESKTOP_MEMORY_MB"},
		{"sandbox.desktop_vcpu_count", "SMITHERS_SANDBOX_DESKTOP_VCPU_COUNT"},
		{"sandbox.desktop_observe_text", "SMITHERS_DESKTOP_OBSERVE_TEXT"},
		{"sandbox.agent_max_concurrent", "SMITHERS_SANDBOX_AGENT_MAX_CONCURRENT"},
		{"sandbox.workspace_idle_timeout", "SMITHERS_SANDBOX_WORKSPACE_IDLE_TIMEOUT"},
		{"sandbox.workspace_persistence", "SMITHERS_SANDBOX_WORKSPACE_PERSISTENCE"},
	} {
		_ = v.BindEnv(b[0], b[1])
	}

	if configFile != "" {
		v.SetConfigFile(configFile)
	} else {
		v.SetConfigName("config")
		v.AddConfigPath(".")
		v.AddConfigPath("/etc/smithers/")
		if home, err := os.UserHomeDir(); err == nil && home != "" {
			v.AddConfigPath(filepath.Join(home, ".smithers"))
		}
	}

	if err := v.ReadInConfig(); err != nil {
		var notFound viper.ConfigFileNotFoundError
		if !errors.As(err, &notFound) {
			return nil, fmt.Errorf("read config file: %w", err)
		}
	}
	// Browser cookies must work on the public origin chosen for this process.
	// An explicit cookie_secure setting still wins over this scheme default.
	if publicURL, err := url.Parse(v.GetString("server.public_url")); err == nil {
		v.SetDefault("auth.cookie_secure", strings.EqualFold(publicURL.Scheme, "https"))
	}

	var cfg Config
	if err := v.Unmarshal(&cfg); err != nil {
		return nil, err
	}
	// Repo-host trims the same shared bearer value before putting it on push
	// callbacks. Normalize the API copy as well so a trailing newline from an
	// out-of-band Secret Manager seeding pipeline cannot split the two sides.
	cfg.RepoHost.PushHookCallbackToken = strings.TrimSpace(cfg.RepoHost.PushHookCallbackToken)
	cfg.Auth.LFSSigningSecret = strings.TrimSpace(cfg.Auth.LFSSigningSecret)
	cfg.Server.AllowedOrigins = splitCommaSeparatedList(cfg.Server.AllowedOrigins)
	if err := normalizeAgentAvailability(&cfg); err != nil {
		return nil, err
	}
	if d, err := time.ParseDuration(cfg.Agents.NeverStartedTimeout); err != nil || d <= 0 {
		return nil, fmt.Errorf("agents.never_started_timeout must be a positive duration")
	}
	if cfg.Blob.BuildCacheMaxAgeDays < 1 || cfg.Blob.BuildCacheMaxAgeDays > 36500 {
		return nil, fmt.Errorf("blob.build_cache_max_age_days must be between 1 and 36500")
	}
	if cfg.Blob.BuildCacheRepoQuotaBytes <= 0 {
		return nil, fmt.Errorf("blob.build_cache_repo_quota_bytes must be positive")
	}
	return &cfg, nil
}

// normalizeAgentAvailability validates the required production input for agent
// VM dispatch. An enabled agent surface must always have an immutable provider
// snapshot to boot from; silently changing the feature flag would hide a broken
// deployment and make canary results misleading.
func normalizeAgentAvailability(cfg *Config) error {
	if cfg.FeatureFlags.Agents && strings.TrimSpace(cfg.Sandbox.AgentSnapshotID) == "" {
		return errors.New("feature_flags.agents requires sandbox.agent_snapshot_id; set SMITHERS_SANDBOX_AGENT_SNAPSHOT_ID to an immutable provider snapshot")
	}
	return nil
}

func splitCommaSeparatedList(values []string) []string {
	var out []string
	for _, value := range values {
		for _, part := range strings.Split(value, ",") {
			part = strings.TrimSpace(part)
			if part != "" {
				out = append(out, part)
			}
		}
	}
	return out
}
