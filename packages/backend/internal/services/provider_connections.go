package services

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/subscriptiontoken"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
)

// Bring-your-own accounts (RFD-003). A provider connection is one Codex
// (ChatGPT) sign-in or one Anthropic API key a user connected. A Codex refresh
// token stays here, encrypted; the access token is minted by the refresh loop
// and handed to the pool route per model call. The guest only ever sees
// placeholders. A Claude subscription is never stored (#2777): it runs through
// the user's own logged-in Claude Code (`claude-code:*` seats).

const (
	ProviderConnectionProviderClaude = "claude"
	ProviderConnectionProviderCodex  = "codex"

	ProviderConnectionKindOAuth  = "oauth"
	ProviderConnectionKindAPIKey = "api_key"

	ProviderConnectionStateActive        = "active"
	ProviderConnectionStateRefreshFailed = "refresh_failed"
	ProviderConnectionStateRevoked       = "revoked"

	ProviderConnectionPreferenceOrgFirst     = "org_first"
	ProviderConnectionPreferenceUserFirst    = "user_first"
	ProviderConnectionPreferenceOrgOnly      = "org_only"
	ProviderConnectionPreferenceUserOnly     = "user_only"
	ProviderConnectionPreferencePlatformOnly = "platform_only"

	// providerConnectionRefreshHorizon is how close to expiry the worker
	// refreshes; providerConnectionDispatchHorizon is how close a pool pick
	// refreshes synchronously before handing the token to a model call.
	providerConnectionRefreshHorizon  = 30 * time.Minute
	providerConnectionDispatchHorizon = 5 * time.Minute
	providerConnectionRefreshLease    = 5 * time.Minute
	providerConnectionMaxFailures     = 3
)

var (
	providerConnectionLabelPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9 ._@-]{0,79}$`)
	claudeAPIKeyPrefix             = "sk-ant-api"

	// ErrProviderRefreshInvalidGrant is what a provider says when the refresh
	// token was revoked, expired, or reused elsewhere (reuse detection).
	ErrProviderRefreshInvalidGrant = errors.New("provider refused the refresh token (invalid_grant)")
)

// ProviderConnectionQuerier is the DB surface the service needs.
type ProviderConnectionQuerier interface {
	CreateProviderConnection(ctx context.Context, arg db.CreateProviderConnectionParams) (db.ProviderConnection, error)
	GetProviderConnection(ctx context.Context, id string) (db.ProviderConnection, error)
	ListUserProviderConnections(ctx context.Context, userID pgtype.Int8) ([]db.ProviderConnection, error)
	ListOrgProviderConnections(ctx context.Context, orgID pgtype.Int8) ([]db.ProviderConnection, error)
	RevokeProviderConnection(ctx context.Context, arg db.RevokeProviderConnectionParams) (int64, error)
	UpdateProviderConnectionTokens(ctx context.Context, arg db.UpdateProviderConnectionTokensParams) error
	MarkProviderConnectionRefreshFailure(ctx context.Context, arg db.MarkProviderConnectionRefreshFailureParams) error
	ClaimProviderConnectionForRefresh(ctx context.Context, arg db.ClaimProviderConnectionForRefreshParams) (db.ProviderConnection, error)
	ProviderConnectionPoolStatus(ctx context.Context, arg db.ProviderConnectionPoolStatusParams) (db.ProviderConnectionPoolStatusRow, error)
	PickProviderConnection(ctx context.Context, arg db.PickProviderConnectionParams) (db.ProviderConnection, error)
	PickProviderConnectionWaiting(ctx context.Context, arg db.PickProviderConnectionWaitingParams) (db.ProviderConnection, error)
	MarkProviderConnectionLimited(ctx context.Context, arg db.MarkProviderConnectionLimitedParams) error
	MarkProviderConnectionRejected(ctx context.Context, arg db.MarkProviderConnectionRejectedParams) (int64, error)
	SetUserProviderConnectionSortOrder(ctx context.Context, arg db.SetUserProviderConnectionSortOrderParams) (int64, error)
	RevokeOtherUserProviderAccountConnections(ctx context.Context, arg db.RevokeOtherUserProviderAccountConnectionsParams) (int64, error)
	CreateProviderConnectionDeviceLogin(ctx context.Context, arg db.CreateProviderConnectionDeviceLoginParams) (db.ProviderConnectionDeviceLogin, error)
	GetProviderConnectionDeviceLogin(ctx context.Context, arg db.GetProviderConnectionDeviceLoginParams) (db.ProviderConnectionDeviceLogin, error)
	ClaimProviderConnectionDeviceLoginPoll(ctx context.Context, arg db.ClaimProviderConnectionDeviceLoginPollParams) (db.ProviderConnectionDeviceLogin, error)
	FinishProviderConnectionDeviceLoginPoll(ctx context.Context, arg db.FinishProviderConnectionDeviceLoginPollParams) (int64, error)
	ExpireProviderConnectionDeviceLogin(ctx context.Context, arg db.ExpireProviderConnectionDeviceLoginParams) (int64, error)
	AddProviderConnectionGrant(ctx context.Context, arg db.AddProviderConnectionGrantParams) (db.ProviderConnectionGrant, error)
	ListProviderConnectionGrants(ctx context.Context, connectionID string) ([]db.ProviderConnectionGrant, error)
	DeleteProviderConnectionGrant(ctx context.Context, arg db.DeleteProviderConnectionGrantParams) (int64, error)
	UpsertRepositoryProviderConnectionPreference(ctx context.Context, arg db.UpsertRepositoryProviderConnectionPreferenceParams) error
	GetRepositoryProviderConnectionPreference(ctx context.Context, repositoryID int64) (string, error)
	GetRepoByID(ctx context.Context, id int64) (db.Repository, error)
	GetOrgByLowerName(ctx context.Context, lowerName string) (db.Organization, error)
	GetOrgMember(ctx context.Context, arg db.GetOrgMemberParams) (db.OrgMember, error)
}

// RefreshedTokens is what a provider hands back for a refresh.
type RefreshedTokens struct {
	AccessToken  string
	RefreshToken string
	ExpiresAt    time.Time
	AccountID    string
	AccountEmail string
	Plan         string
}

// ProviderTokenRefresher exchanges a refresh token for fresh tokens.
type ProviderTokenRefresher interface {
	Refresh(ctx context.Context, provider, refreshToken string) (RefreshedTokens, error)
}

// ProviderConnectionsConfig names the Codex token endpoint. It defaults to
// the Codex CLI's own endpoint and client id; tests point it at a local
// server.
type ProviderConnectionsConfig struct {
	CodexTokenURL string
	CodexClientID string
	// CodexIssuer is the OpenAI auth origin serving the device-code sign-in
	// (`codex login --device-auth`).
	CodexIssuer string
}

// DefaultProviderConnectionsConfig is the Codex CLI OAuth client, the only
// client OpenAI issues ChatGPT subscription tokens to.
func DefaultProviderConnectionsConfig() ProviderConnectionsConfig {
	return ProviderConnectionsConfig{
		CodexTokenURL: "https://auth.openai.com/oauth/token",
		CodexClientID: "app_EMoamEEZ73f0CkXaXp7hrann",
		CodexIssuer:   "https://auth.openai.com",
	}
}

// HTTPProviderTokenRefresher talks to the providers' token endpoints.
type HTTPProviderTokenRefresher struct {
	cfg    ProviderConnectionsConfig
	client *http.Client
}

func NewHTTPProviderTokenRefresher(cfg ProviderConnectionsConfig, client *http.Client) *HTTPProviderTokenRefresher {
	if client == nil {
		client = &http.Client{Timeout: 30 * time.Second}
	}
	return &HTTPProviderTokenRefresher{cfg: cfg, client: client}
}

func (r *HTTPProviderTokenRefresher) Refresh(ctx context.Context, provider, refreshToken string) (RefreshedTokens, error) {
	if provider != ProviderConnectionProviderCodex {
		return RefreshedTokens{}, fmt.Errorf("provider %q has no refreshable connection", provider)
	}
	endpoint := r.cfg.CodexTokenURL
	payload := map[string]any{"grant_type": "refresh_token", "refresh_token": refreshToken, "client_id": r.cfg.CodexClientID, "scope": "openid profile email"}
	body, err := json.Marshal(payload)
	if err != nil {
		return RefreshedTokens{}, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return RefreshedTokens{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	resp, err := r.client.Do(req)
	if err != nil {
		return RefreshedTokens{}, fmt.Errorf("provider token endpoint: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 64*1024))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		if bytes.Contains(raw, []byte("invalid_grant")) || resp.StatusCode == http.StatusUnauthorized {
			return RefreshedTokens{}, ErrProviderRefreshInvalidGrant
		}
		return RefreshedTokens{}, fmt.Errorf("provider token endpoint returned %d", resp.StatusCode)
	}
	var parsed struct {
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
		IDToken      string `json:"id_token"`
		ExpiresIn    int64  `json:"expires_in"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil || parsed.AccessToken == "" {
		return RefreshedTokens{}, fmt.Errorf("provider token endpoint returned an unreadable body")
	}
	out := RefreshedTokens{AccessToken: parsed.AccessToken, RefreshToken: parsed.RefreshToken}
	if parsed.ExpiresIn > 0 {
		out.ExpiresAt = time.Now().Add(time.Duration(parsed.ExpiresIn) * time.Second)
	} else if exp, ok := jwtExpiry(parsed.AccessToken); ok {
		out.ExpiresAt = exp
	}
	if parsed.IDToken != "" {
		out.AccountID, out.AccountEmail, out.Plan = codexIdentityClaims(parsed.IDToken)
	}
	return out, nil
}

// jwtExpiry reads the exp claim of a JWT without verifying it; the value is
// only used to schedule refreshes.
func jwtExpiry(token string) (time.Time, bool) {
	claims, ok := jwtClaims(token)
	if !ok {
		return time.Time{}, false
	}
	exp, ok := claims["exp"].(float64)
	if !ok || exp <= 0 {
		return time.Time{}, false
	}
	return time.Unix(int64(exp), 0), true
}

func jwtClaims(token string) (map[string]any, bool) {
	parts := strings.Split(strings.TrimSpace(token), ".")
	if len(parts) < 2 {
		return nil, false
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(parts[1], "="))
	if err != nil {
		return nil, false
	}
	var claims map[string]any
	if err := json.Unmarshal(raw, &claims); err != nil {
		return nil, false
	}
	return claims, true
}

// codexIdentityClaims reads the non-secret identity the Codex id token
// carries: the ChatGPT account id, plan, and email.
func codexIdentityClaims(idToken string) (accountID, email, plan string) {
	claims, ok := jwtClaims(idToken)
	if !ok {
		return "", "", ""
	}
	email, _ = claims["email"].(string)
	if auth, ok := claims["https://api.openai.com/auth"].(map[string]any); ok {
		accountID, _ = auth["chatgpt_account_id"].(string)
		plan, _ = auth["chatgpt_plan_type"].(string)
	}
	return accountID, email, plan
}

// ProviderConnectionService owns connections, grants, resolution, and refresh.
type ProviderConnectionService struct {
	q         ProviderConnectionQuerier
	codec     webhook.SecretCodec
	refresher ProviderTokenRefresher
	device    CodexDeviceAuthorizer
	audit     *AuditService
	logger    *slog.Logger
	now       func() time.Time
	// enabled mirrors feature_flags.subscription_connections. Off (the
	// default, and the hosted product): nothing connects, refreshes, pools or
	// resolves a stored subscription token.
	enabled bool
}

type ProviderConnectionServiceOption func(*ProviderConnectionService)

// WithSubscriptionConnectionsEnabled turns on bring-your-own ChatGPT
// subscriptions and Anthropic API keys for a self-hosted deployment. Each
// connection serves only the connecting user's own runs and workspaces.
func WithSubscriptionConnectionsEnabled(enabled bool) ProviderConnectionServiceOption {
	return func(s *ProviderConnectionService) { s.enabled = enabled }
}

// SubscriptionConnectionsEnabled reports feature_flags.subscription_connections.
func (s *ProviderConnectionService) SubscriptionConnectionsEnabled() bool {
	return s != nil && s.enabled
}

// errSubscriptionConnectionsUnavailable matches the route gate: a deployment
// with the flag off refuses to store a subscription login.
func errSubscriptionConnectionsUnavailable() error {
	return pkgerrors.Forbidden("feature not available: subscription connections are not available on this deployment")
}

func WithProviderConnectionAudit(audit *AuditService) ProviderConnectionServiceOption {
	return func(s *ProviderConnectionService) { s.audit = audit }
}

func WithProviderConnectionLogger(logger *slog.Logger) ProviderConnectionServiceOption {
	return func(s *ProviderConnectionService) { s.logger = logger }
}

func NewProviderConnectionService(q ProviderConnectionQuerier, codec webhook.SecretCodec, refresher ProviderTokenRefresher, opts ...ProviderConnectionServiceOption) *ProviderConnectionService {
	s := &ProviderConnectionService{q: q, codec: codec, refresher: refresher, logger: slog.Default(), now: time.Now}
	if device, ok := refresher.(CodexDeviceAuthorizer); ok {
		s.device = device
	}
	for _, opt := range opts {
		opt(s)
	}
	return s
}

// ConnectProviderInput is what a user hands over to connect an account: an
// Anthropic API key, or a Codex access+refresh pair.
type ConnectProviderInput struct {
	Provider        string     `json:"provider"`
	Kind            string     `json:"kind"`
	Label           string     `json:"label"`
	AccessToken     string     `json:"access_token"`
	RefreshToken    string     `json:"refresh_token,omitempty"`
	AccessExpiresAt *time.Time `json:"access_expires_at,omitempty"`
	AccountEmail    string     `json:"account_email,omitempty"`
	AccountID       string     `json:"account_id,omitempty"`
	Plan            string     `json:"plan,omitempty"`
}

type ProviderConnectionGrantResponse struct {
	ID              int64  `json:"id"`
	RepositoryID    *int64 `json:"repository_id,omitempty"`
	OrgID           *int64 `json:"org_id,omitempty"`
	AllRepositories bool   `json:"all_repositories"`
}

type ProviderConnectionResponse struct {
	ID              string                            `json:"id"`
	OwnerType       string                            `json:"owner_type"`
	UserID          *int64                            `json:"user_id,omitempty"`
	OrgID           *int64                            `json:"org_id,omitempty"`
	Provider        string                            `json:"provider"`
	Kind            string                            `json:"kind"`
	Label           string                            `json:"label"`
	AccountEmail    string                            `json:"account_email"`
	AccountID       string                            `json:"account_id"`
	Plan            string                            `json:"plan"`
	State           string                            `json:"state"`
	HasRefreshToken bool                              `json:"has_refresh_token"`
	LimitedUntil    *time.Time                        `json:"limited_until,omitempty"`
	SortOrder       int32                             `json:"sort_order"`
	AccessExpiresAt *time.Time                        `json:"access_expires_at,omitempty"`
	LastRefreshAt   *time.Time                        `json:"last_refresh_at,omitempty"`
	LastError       string                            `json:"last_error"`
	Grants          []ProviderConnectionGrantResponse `json:"grants"`
	CreatedAt       time.Time                         `json:"created_at"`
	UpdatedAt       time.Time                         `json:"updated_at"`
}

type ProviderConnectionGrantInput struct {
	RepositoryID    *int64 `json:"repository_id,omitempty"`
	OrgID           *int64 `json:"org_id,omitempty"`
	AllRepositories bool   `json:"all_repositories"`
}

// ResolvedProviderConnection is what dispatch binds: the decrypted access
// token and the non-secret identity the guest may see.
type ResolvedProviderConnection struct {
	ConnectionID string
	Provider     string
	Kind         string
	AccessToken  string
	AccountID    string
	// RefreshGeneration fences a later refusal of this token (MarkRejected).
	RefreshGeneration int64
	HasRefreshToken   bool
}

func normalizeProviderConnectionProvider(provider string) (string, error) {
	switch strings.ToLower(strings.TrimSpace(provider)) {
	case ProviderConnectionProviderClaude, "anthropic", "claude-code", "smithers", "":
		return ProviderConnectionProviderClaude, nil
	case ProviderConnectionProviderCodex, "openai", "chatgpt":
		return ProviderConnectionProviderCodex, nil
	}
	return "", pkgerrors.BadRequest("provider must be claude or codex")
}

// errClaudeSubscriptionToken refuses anything but an Anthropic API key where
// a Claude credential is offered (#2777).
func errClaudeSubscriptionToken() error {
	return pkgerrors.BadRequest("a claude connection is an Anthropic API key (sk-ant-api…); Claude subscriptions run locally through Claude Code")
}

func (s *ProviderConnectionService) validateConnectInput(in *ConnectProviderInput) error {
	provider, err := normalizeProviderConnectionProvider(in.Provider)
	if err != nil {
		return err
	}
	in.Provider = provider
	in.Kind = strings.ToLower(strings.TrimSpace(in.Kind))
	in.AccessToken = strings.TrimSpace(in.AccessToken)
	in.RefreshToken = strings.TrimSpace(in.RefreshToken)
	in.Label = strings.TrimSpace(in.Label)
	if in.Label == "" {
		in.Label = provider
	}
	if !providerConnectionLabelPattern.MatchString(in.Label) {
		return pkgerrors.BadRequest("label must be 1-80 characters of letters, digits, spaces, '.', '_', '@', or '-'")
	}
	if in.AccessToken == "" {
		return pkgerrors.BadRequest("access_token is required")
	}
	if !IsUsableProviderCredential(in.AccessToken) || strings.ContainsAny(in.AccessToken, " \t\r\n") {
		return pkgerrors.BadRequest("access_token does not look like a provider token")
	}
	// A Claude subscription token is never stored, whatever provider it is
	// labeled with (#2777), and a claude connection is an Anthropic API key
	// and nothing else.
	if subscriptiontoken.HoldsClaude("", in.AccessToken) || subscriptiontoken.HoldsClaude("", in.RefreshToken) {
		return errClaudeSubscriptionToken()
	}
	if provider == ProviderConnectionProviderClaude {
		if (in.Kind != "" && in.Kind != ProviderConnectionKindAPIKey) || in.RefreshToken != "" || !strings.HasPrefix(in.AccessToken, claudeAPIKeyPrefix) {
			return errClaudeSubscriptionToken()
		}
		in.Kind = ProviderConnectionKindAPIKey
		return nil
	}
	if in.Kind != "" && in.Kind != ProviderConnectionKindOAuth {
		return pkgerrors.BadRequest("a codex connection is a ChatGPT sign-in (kind oauth)")
	}
	in.Kind = ProviderConnectionKindOAuth
	if in.RefreshToken == "" {
		return pkgerrors.BadRequest("oauth connections need a refresh_token")
	}
	if in.AccessExpiresAt == nil {
		if exp, ok := jwtExpiry(in.AccessToken); ok {
			in.AccessExpiresAt = &exp
		}
	}
	if in.AccountID == "" {
		return pkgerrors.BadRequest("codex connections need the ChatGPT account_id")
	}
	return nil
}

func (s *ProviderConnectionService) createConnection(ctx context.Context, actor *db.User, ownerType string, userID, orgID int64, in ConnectProviderInput) (ProviderConnectionResponse, error) {
	if err := s.validateConnectInput(&in); err != nil {
		return ProviderConnectionResponse{}, err
	}
	accessCipher, err := s.codec.EncryptString(in.AccessToken)
	if err != nil {
		return ProviderConnectionResponse{}, pkgerrors.Internal("failed to encrypt access token").WithCause(err)
	}
	params := db.CreateProviderConnectionParams{
		OwnerType:            ownerType,
		Provider:             in.Provider,
		Kind:                 in.Kind,
		Label:                in.Label,
		AccountEmail:         strings.TrimSpace(in.AccountEmail),
		AccountID:            strings.TrimSpace(in.AccountID),
		Plan:                 strings.TrimSpace(in.Plan),
		AccessTokenEncrypted: []byte(accessCipher),
		CreatedBy:            pgtype.Int8{Int64: actor.ID, Valid: true},
	}
	if ownerType == "user" {
		params.UserID = pgtype.Int8{Int64: userID, Valid: true}
	} else {
		params.OrgID = pgtype.Int8{Int64: orgID, Valid: true}
	}
	if in.RefreshToken != "" {
		refreshCipher, err := s.codec.EncryptString(in.RefreshToken)
		if err != nil {
			return ProviderConnectionResponse{}, pkgerrors.Internal("failed to encrypt refresh token").WithCause(err)
		}
		params.RefreshTokenEncrypted = []byte(refreshCipher)
		params.NextRefreshAt = pgtype.Timestamptz{Time: s.now(), Valid: true}
	}
	if in.AccessExpiresAt != nil {
		params.AccessExpiresAt = pgtype.Timestamptz{Time: in.AccessExpiresAt.UTC(), Valid: true}
	}
	row, err := s.q.CreateProviderConnection(ctx, params)
	if err != nil {
		return ProviderConnectionResponse{}, pkgerrors.Internal("failed to store provider connection").WithCause(err)
	}
	s.logAudit(ctx, actor, row, "provider_connection.connected", nil)
	return s.toResponse(ctx, row), nil
}

// ConnectForUser connects an account owned by the actor.
func (s *ProviderConnectionService) ConnectForUser(ctx context.Context, actor *db.User, in ConnectProviderInput) (ProviderConnectionResponse, error) {
	if actor == nil {
		return ProviderConnectionResponse{}, pkgerrors.Unauthorized("authentication required")
	}
	if !s.enabled {
		return ProviderConnectionResponse{}, errSubscriptionConnectionsUnavailable()
	}
	if err := s.validateConnectInput(&in); err != nil {
		return ProviderConnectionResponse{}, err
	}
	// The browser persists only this public request label. A replay after a
	// lost response returns the same metadata and never replaces the token.
	find := func() (*ProviderConnectionResponse, error) {
		rows, err := s.q.ListUserProviderConnections(ctx, pgtype.Int8{Int64: actor.ID, Valid: true})
		if err != nil {
			return nil, err
		}
		for _, row := range rows {
			if row.Label == in.Label {
				if row.Provider != in.Provider {
					return nil, pkgerrors.BadRequest("request label belongs to another provider")
				}
				answer := s.toResponse(ctx, row)
				return &answer, nil
			}
		}
		return nil, nil
	}
	if strings.HasPrefix(in.Label, "web-") {
		if found, err := find(); err != nil {
			return ProviderConnectionResponse{}, pkgerrors.Internal("failed to check connection request").WithCause(err)
		} else if found != nil {
			return s.grantEverywhere(ctx, *found)
		}
	}
	answer, err := s.createConnection(ctx, actor, "user", actor.ID, 0, in)
	if err != nil && strings.HasPrefix(in.Label, "web-") {
		if found, lookupErr := find(); lookupErr == nil && found != nil {
			return s.grantEverywhere(ctx, *found)
		}
	}
	if err == nil && strings.HasPrefix(in.Label, "web-") {
		return s.grantEverywhere(ctx, answer)
	}
	return answer, err
}

// grantEverywhere lets an account connected in the browser serve the owner's
// work in every repository, organization repositories included. A user
// connection is only ever drawn on for its owner's own workspaces and runs.
// It is idempotent, so a replayed request repairs a grant that failed.
func (s *ProviderConnectionService) grantEverywhere(ctx context.Context, answer ProviderConnectionResponse) (ProviderConnectionResponse, error) {
	for _, grant := range answer.Grants {
		if grant.AllRepositories {
			return answer, nil
		}
	}
	grant, err := s.q.AddProviderConnectionGrant(ctx, db.AddProviderConnectionGrantParams{ConnectionID: answer.ID, AllRepositories: true})
	if err != nil {
		s.logger.Warn("grant provider connection to every repository failed", "connection_id", answer.ID, "error", err)
		return answer, pkgerrors.Internal("failed to grant the connection").WithCause(err)
	}
	answer.Grants = append(answer.Grants, toGrantResponse(grant))
	return answer, nil
}

// ConnectForOrg always refuses. A connection serves only its account
// holder's own runs; sharing one across an organization's members
// is exactly what the providers' consumer terms forbid.
func (s *ProviderConnectionService) ConnectForOrg(ctx context.Context, actor *db.User, orgName string, in ConnectProviderInput) (ProviderConnectionResponse, error) {
	if !s.enabled {
		return ProviderConnectionResponse{}, errSubscriptionConnectionsUnavailable()
	}
	if _, err := s.requireOrgRole(ctx, actor, orgName, true); err != nil {
		return ProviderConnectionResponse{}, err
	}
	return ProviderConnectionResponse{}, pkgerrors.Forbidden("a subscription serves only its account holder's own runs; connect it to your user account instead of the organization")
}

func (s *ProviderConnectionService) requireOrgRole(ctx context.Context, actor *db.User, orgName string, ownerOnly bool) (db.Organization, error) {
	if actor == nil {
		return db.Organization{}, pkgerrors.Unauthorized("authentication required")
	}
	org, err := s.q.GetOrgByLowerName(ctx, strings.ToLower(strings.TrimSpace(orgName)))
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return db.Organization{}, pkgerrors.NotFound("organization not found")
		}
		return db.Organization{}, pkgerrors.Internal("failed to load organization").WithCause(err)
	}
	member, err := s.q.GetOrgMember(ctx, db.GetOrgMemberParams{OrganizationID: org.ID, UserID: actor.ID})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return db.Organization{}, pkgerrors.Forbidden("not a member of this organization")
		}
		return db.Organization{}, pkgerrors.Internal("failed to load organization membership").WithCause(err)
	}
	if ownerOnly && member.Role != "owner" {
		return db.Organization{}, pkgerrors.Forbidden("organization owner required")
	}
	return org, nil
}

func (s *ProviderConnectionService) ListForUser(ctx context.Context, actor *db.User) ([]ProviderConnectionResponse, error) {
	if actor == nil {
		return nil, pkgerrors.Unauthorized("authentication required")
	}
	rows, err := s.q.ListUserProviderConnections(ctx, pgtype.Int8{Int64: actor.ID, Valid: true})
	if err != nil {
		return nil, pkgerrors.Internal("failed to list provider connections").WithCause(err)
	}
	out := make([]ProviderConnectionResponse, 0, len(rows))
	for _, row := range rows {
		out = append(out, s.toResponse(ctx, row))
	}
	return out, nil
}

func (s *ProviderConnectionService) ListForOrg(ctx context.Context, actor *db.User, orgName string) ([]ProviderConnectionResponse, error) {
	org, err := s.requireOrgRole(ctx, actor, orgName, false)
	if err != nil {
		return nil, err
	}
	rows, err := s.q.ListOrgProviderConnections(ctx, pgtype.Int8{Int64: org.ID, Valid: true})
	if err != nil {
		return nil, pkgerrors.Internal("failed to list provider connections").WithCause(err)
	}
	out := make([]ProviderConnectionResponse, 0, len(rows))
	for _, row := range rows {
		out = append(out, s.toResponse(ctx, row))
	}
	return out, nil
}

// loadOwned returns the connection when the actor may manage it: the owning
// user, or an owner of the owning organization.
func (s *ProviderConnectionService) loadOwned(ctx context.Context, actor *db.User, id string) (db.ProviderConnection, error) {
	if actor == nil {
		return db.ProviderConnection{}, pkgerrors.Unauthorized("authentication required")
	}
	row, err := s.q.GetProviderConnection(ctx, strings.TrimSpace(id))
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return db.ProviderConnection{}, pkgerrors.NotFound("provider connection not found")
		}
		return db.ProviderConnection{}, pkgerrors.Internal("failed to load provider connection").WithCause(err)
	}
	switch row.OwnerType {
	case "user":
		if !row.UserID.Valid || row.UserID.Int64 != actor.ID {
			return db.ProviderConnection{}, pkgerrors.NotFound("provider connection not found")
		}
	case "org":
		member, err := s.q.GetOrgMember(ctx, db.GetOrgMemberParams{OrganizationID: row.OrgID.Int64, UserID: actor.ID})
		if err != nil || member.Role != "owner" {
			return db.ProviderConnection{}, pkgerrors.NotFound("provider connection not found")
		}
	}
	return row, nil
}

func (s *ProviderConnectionService) Get(ctx context.Context, actor *db.User, id string) (ProviderConnectionResponse, error) {
	row, err := s.loadOwned(ctx, actor, id)
	if err != nil {
		return ProviderConnectionResponse{}, err
	}
	return s.toResponse(ctx, row), nil
}

// Revoke marks a connection revoked. Tokens stay encrypted at rest until the
// row is deleted; nothing reads them again.
func (s *ProviderConnectionService) Revoke(ctx context.Context, actor *db.User, id string) error {
	row, err := s.loadOwned(ctx, actor, id)
	if err != nil {
		return err
	}
	if _, err := s.q.RevokeProviderConnection(ctx, db.RevokeProviderConnectionParams{ID: row.ID, LastError: "revoked by " + actor.Username}); err != nil {
		return pkgerrors.Internal("failed to revoke provider connection").WithCause(err)
	}
	s.logAudit(ctx, actor, row, "provider_connection.revoked", nil)
	return nil
}

// RefreshNow refreshes one connection on demand.
func (s *ProviderConnectionService) RefreshNow(ctx context.Context, actor *db.User, id string) (ProviderConnectionResponse, error) {
	row, err := s.loadOwned(ctx, actor, id)
	if err != nil {
		return ProviderConnectionResponse{}, err
	}
	if len(row.RefreshTokenEncrypted) == 0 {
		return ProviderConnectionResponse{}, pkgerrors.BadRequest("this connection has no refresh token; API keys are not refreshed")
	}
	if row.State == ProviderConnectionStateRevoked {
		return ProviderConnectionResponse{}, pkgerrors.Conflict("connection is revoked")
	}
	if err := s.refreshRow(ctx, row); err != nil {
		return ProviderConnectionResponse{}, pkgerrors.BadRequest("refresh failed: " + err.Error())
	}
	updated, err := s.q.GetProviderConnection(ctx, row.ID)
	if err != nil {
		return ProviderConnectionResponse{}, pkgerrors.Internal("failed to reload provider connection").WithCause(err)
	}
	return s.toResponse(ctx, updated), nil
}

func (s *ProviderConnectionService) AddGrant(ctx context.Context, actor *db.User, id string, in ProviderConnectionGrantInput) (ProviderConnectionGrantResponse, error) {
	row, err := s.loadOwned(ctx, actor, id)
	if err != nil {
		return ProviderConnectionGrantResponse{}, err
	}
	if row.OwnerType != "user" {
		return ProviderConnectionGrantResponse{}, pkgerrors.BadRequest("organization connections apply to every repository of the organization; grants are for user connections")
	}
	if !in.AllRepositories && in.RepositoryID == nil && in.OrgID == nil {
		return ProviderConnectionGrantResponse{}, pkgerrors.BadRequest("a grant names a repository_id, an org_id, or all_repositories")
	}
	params := db.AddProviderConnectionGrantParams{ConnectionID: row.ID, AllRepositories: in.AllRepositories}
	if in.RepositoryID != nil {
		params.RepositoryID = pgtype.Int8{Int64: *in.RepositoryID, Valid: true}
	}
	if in.OrgID != nil {
		params.OrgID = pgtype.Int8{Int64: *in.OrgID, Valid: true}
	}
	grant, err := s.q.AddProviderConnectionGrant(ctx, params)
	if err != nil {
		return ProviderConnectionGrantResponse{}, pkgerrors.BadRequest("failed to add grant (does the repository or organization exist?)")
	}
	s.logAudit(ctx, actor, row, "provider_connection.grant_added", map[string]any{"grant_id": grant.ID})
	return toGrantResponse(grant), nil
}

func (s *ProviderConnectionService) DeleteGrant(ctx context.Context, actor *db.User, id string, grantID int64) error {
	row, err := s.loadOwned(ctx, actor, id)
	if err != nil {
		return err
	}
	n, err := s.q.DeleteProviderConnectionGrant(ctx, db.DeleteProviderConnectionGrantParams{ID: grantID, ConnectionID: row.ID})
	if err != nil {
		return pkgerrors.Internal("failed to delete grant").WithCause(err)
	}
	if n == 0 {
		return pkgerrors.NotFound("grant not found")
	}
	s.logAudit(ctx, actor, row, "provider_connection.grant_removed", map[string]any{"grant_id": grantID})
	return nil
}

// SetRepositoryPreference records which connection kind a repository's runs
// prefer. Callers verify repository admin rights.
func (s *ProviderConnectionService) SetRepositoryPreference(ctx context.Context, repositoryID int64, preference string) error {
	switch preference {
	case ProviderConnectionPreferenceOrgFirst, ProviderConnectionPreferenceUserFirst, ProviderConnectionPreferenceOrgOnly, ProviderConnectionPreferenceUserOnly, ProviderConnectionPreferencePlatformOnly:
	default:
		return pkgerrors.BadRequest("preference must be org_first, user_first, org_only, user_only, or platform_only")
	}
	if err := s.q.UpsertRepositoryProviderConnectionPreference(ctx, db.UpsertRepositoryProviderConnectionPreferenceParams{RepositoryID: repositoryID, Preference: preference}); err != nil {
		return pkgerrors.Internal("failed to store provider connection preference").WithCause(err)
	}
	return nil
}

// usesUserConnections reports whether the repository's preference lets a
// run's user draw on their own connections. A subscription serves only its
// account holder's own runs: organization rows (legacy) never resolve, and
// org_only and platform_only keep the platform credentials.
func (s *ProviderConnectionService) usesUserConnections(ctx context.Context, repositoryID int64) (bool, error) {
	if !s.enabled {
		return false, nil
	}
	preference, err := s.q.GetRepositoryProviderConnectionPreference(ctx, repositoryID)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return false, fmt.Errorf("load provider connection preference: %w", err)
	}
	return preference != ProviderConnectionPreferencePlatformOnly && preference != ProviderConnectionPreferenceOrgOnly, nil
}

// refuseStoredClaudeToken refuses a row whose stored access or refresh token
// is a Claude subscription token, whatever provider it is labeled with
// (#2777): it is never forwarded to a provider nor sent to a refresher. The
// startup scan deletes such rows.
func (s *ProviderConnectionService) refuseStoredClaudeToken(row db.ProviderConnection) error {
	for _, cipher := range [][]byte{row.AccessTokenEncrypted, row.RefreshTokenEncrypted} {
		if len(cipher) == 0 {
			continue
		}
		if value, err := s.codec.DecryptString(string(cipher)); err == nil && subscriptiontoken.HoldsClaude("", value) {
			return errors.New("the connection holds a Claude subscription token")
		}
	}
	return nil
}

// materialize decrypts the access token, refreshing first when it is about to
// expire and a refresh token exists.
func (s *ProviderConnectionService) materialize(ctx context.Context, row db.ProviderConnection) (*ResolvedProviderConnection, error) {
	if err := s.refuseStoredClaudeToken(row); err != nil {
		return nil, err
	}
	if row.AccessExpiresAt.Valid && row.AccessExpiresAt.Time.Before(s.now().Add(providerConnectionDispatchHorizon)) {
		if len(row.RefreshTokenEncrypted) == 0 {
			return nil, errors.New("access token expired and the connection has no refresh token")
		}
		refreshErr := s.refreshRow(ctx, row)
		fresh, err := s.q.GetProviderConnection(ctx, row.ID)
		if err != nil {
			return nil, err
		}
		// A lost claim means another refresh holds the lease. Its stored
		// result is usable once it lands; until then the dispatch waits.
		stillExpiring := fresh.AccessExpiresAt.Valid && fresh.AccessExpiresAt.Time.Before(s.now().Add(providerConnectionDispatchHorizon))
		if refreshErr != nil && (stillExpiring || fresh.State != ProviderConnectionStateActive) {
			return nil, refreshErr
		}
		row = fresh
	}
	plaintext, err := s.codec.DecryptString(string(row.AccessTokenEncrypted))
	if err != nil {
		return nil, errors.New("failed to decrypt access token")
	}
	// A claude row read before migration 0067 deleted the subscription ones
	// is never handed out (#2777).
	if row.Provider == ProviderConnectionProviderClaude && !strings.HasPrefix(plaintext, claudeAPIKeyPrefix) {
		return nil, errors.New("a claude connection holds no Anthropic API key")
	}
	return &ResolvedProviderConnection{
		ConnectionID: row.ID, Provider: row.Provider, Kind: row.Kind,
		AccessToken: plaintext, AccountID: row.AccountID,
		RefreshGeneration: row.RefreshGeneration, HasRefreshToken: len(row.RefreshTokenEncrypted) > 0,
	}, nil
}

// refreshRow acquires the same durable lease as the background worker. The
// claim returns the current token pair, never the caller's stale snapshot.
func (s *ProviderConnectionService) refreshRow(ctx context.Context, row db.ProviderConnection) error {
	claimed, err := s.q.ClaimProviderConnectionForRefresh(ctx, db.ClaimProviderConnectionForRefreshParams{
		ConnectionID: row.ID, ExpiresBefore: s.now().Add(providerConnectionRefreshHorizon), LeaseUntil: s.now().Add(providerConnectionRefreshLease),
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return pkgerrors.Conflict("provider connection refresh already in progress or unavailable")
	}
	if err != nil {
		return err
	}
	return s.refreshClaimedRow(ctx, claimed)
}

// Every result is fenced by the claim generation, including invalid_grant.
func (s *ProviderConnectionService) refreshClaimedRow(ctx context.Context, row db.ProviderConnection) error {
	if s.refresher == nil {
		return errors.New("no token refresher configured")
	}
	if err := s.refuseStoredClaudeToken(row); err != nil {
		slog.Warn("refused to refresh a connection holding a Claude subscription token (#2777); the next start deletes it", "connection_id", row.ID)
		return err
	}
	refreshToken, err := s.codec.DecryptString(string(row.RefreshTokenEncrypted))
	if err != nil {
		return errors.New("failed to decrypt refresh token")
	}
	tokens, err := s.refresher.Refresh(ctx, row.Provider, refreshToken)
	if err != nil {
		failures := row.RefreshFailures + 1
		state := ProviderConnectionStateActive
		if errors.Is(err, ErrProviderRefreshInvalidGrant) {
			state = ProviderConnectionStateRevoked
		} else if failures >= providerConnectionMaxFailures {
			state = ProviderConnectionStateRefreshFailed
		}
		backoff := time.Duration(1<<uint(min(int(failures), 6))) * time.Minute
		_ = s.q.MarkProviderConnectionRefreshFailure(ctx, db.MarkProviderConnectionRefreshFailureParams{
			ID: row.ID, RefreshGeneration: row.RefreshGeneration, RefreshFailures: failures, LastError: err.Error(), State: state,
			NextRefreshAt: pgtype.Timestamptz{Time: s.now().Add(backoff), Valid: true},
		})
		s.logger.Warn("provider connection refresh failed", "connection_id", row.ID, "provider", row.Provider, "state", state, "failures", failures, "error", err)
		if state != ProviderConnectionStateActive {
			s.logAudit(ctx, nil, row, "provider_connection."+state, map[string]any{"error": err.Error()})
		}
		return err
	}
	accessCipher, err := s.codec.EncryptString(tokens.AccessToken)
	if err != nil {
		return errors.New("failed to encrypt access token")
	}
	params := db.UpdateProviderConnectionTokensParams{ID: row.ID, RefreshGeneration: row.RefreshGeneration, AccessTokenEncrypted: []byte(accessCipher), RefreshTokenEncrypted: row.RefreshTokenEncrypted}
	if tokens.RefreshToken != "" {
		refreshCipher, err := s.codec.EncryptString(tokens.RefreshToken)
		if err != nil {
			return errors.New("failed to encrypt refresh token")
		}
		params.RefreshTokenEncrypted = []byte(refreshCipher)
	}
	if !tokens.ExpiresAt.IsZero() {
		params.AccessExpiresAt = pgtype.Timestamptz{Time: tokens.ExpiresAt.UTC(), Valid: true}
		params.NextRefreshAt = pgtype.Timestamptz{Time: tokens.ExpiresAt.Add(-providerConnectionRefreshHorizon).UTC(), Valid: true}
	} else {
		params.NextRefreshAt = pgtype.Timestamptz{Time: s.now().Add(6 * time.Hour), Valid: true}
	}
	if err := s.q.UpdateProviderConnectionTokens(ctx, params); err != nil {
		return errors.New("failed to store refreshed tokens")
	}
	return nil
}

// RefreshDue leases and refreshes one due connection. It returns false when
// nothing was due.
func (s *ProviderConnectionService) RefreshDue(ctx context.Context) (bool, error) {
	if !s.enabled {
		return false, nil
	}
	now := s.now()
	row, err := s.q.ClaimProviderConnectionForRefresh(ctx, db.ClaimProviderConnectionForRefreshParams{
		ExpiresBefore: now.Add(providerConnectionRefreshHorizon), LeaseUntil: now.Add(providerConnectionRefreshLease),
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return false, nil
		}
		return false, fmt.Errorf("claim provider connection: %w", err)
	}
	if err := s.refreshClaimedRow(ctx, row); err != nil {
		return true, nil // recorded on the row; the worker keeps going
	}
	return true, nil
}

func (s *ProviderConnectionService) logAudit(ctx context.Context, actor *db.User, row db.ProviderConnection, action string, metadata map[string]any) {
	if s.audit == nil {
		return
	}
	if metadata == nil {
		metadata = map[string]any{}
	}
	metadata["provider"] = row.Provider
	metadata["owner_type"] = row.OwnerType
	metadata["kind"] = row.Kind
	event := AuditEvent{EventType: action, TargetType: "provider_connection", TargetName: row.ID, Action: action, Metadata: metadata}
	if actor != nil {
		id := actor.ID
		event.ActorID = &id
		event.ActorName = actor.Username
	}
	s.audit.Log(ctx, event)
}

func (s *ProviderConnectionService) toResponse(ctx context.Context, row db.ProviderConnection) ProviderConnectionResponse {
	out := ProviderConnectionResponse{
		ID: row.ID, OwnerType: row.OwnerType, Provider: row.Provider, Kind: row.Kind, Label: row.Label,
		AccountEmail: row.AccountEmail, AccountID: row.AccountID, Plan: row.Plan, State: row.State,
		HasRefreshToken: len(row.RefreshTokenEncrypted) > 0, LastError: row.LastError, SortOrder: row.SortOrder,
		Grants: []ProviderConnectionGrantResponse{}, CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt,
	}
	if row.UserID.Valid {
		v := row.UserID.Int64
		out.UserID = &v
	}
	if row.OrgID.Valid {
		v := row.OrgID.Int64
		out.OrgID = &v
	}
	if row.AccessExpiresAt.Valid {
		t := row.AccessExpiresAt.Time
		out.AccessExpiresAt = &t
	}
	if row.LastRefreshAt.Valid {
		t := row.LastRefreshAt.Time
		out.LastRefreshAt = &t
	}
	if row.LimitedUntil.Valid && row.LimitedUntil.Time.After(s.now()) {
		t := row.LimitedUntil.Time
		out.LimitedUntil = &t
	}
	if grants, err := s.q.ListProviderConnectionGrants(ctx, row.ID); err == nil {
		for _, grant := range grants {
			out.Grants = append(out.Grants, toGrantResponse(grant))
		}
	}
	return out
}

func toGrantResponse(grant db.ProviderConnectionGrant) ProviderConnectionGrantResponse {
	out := ProviderConnectionGrantResponse{ID: grant.ID, AllRepositories: grant.AllRepositories}
	if grant.RepositoryID.Valid {
		v := grant.RepositoryID.Int64
		out.RepositoryID = &v
	}
	if grant.OrgID.Valid {
		v := grant.OrgID.Int64
		out.OrgID = &v
	}
	return out
}

// ProviderConnectionRefreshWorker keeps access tokens fresh: level-triggered,
// once a minute, one leased connection per pass until none is due.
type ProviderConnectionRefreshWorker struct {
	svc      *ProviderConnectionService
	interval time.Duration
	logger   *slog.Logger
}

func NewProviderConnectionRefreshWorker(svc *ProviderConnectionService, interval time.Duration, logger *slog.Logger) *ProviderConnectionRefreshWorker {
	if interval <= 0 {
		interval = time.Minute
	}
	if logger == nil {
		logger = slog.Default()
	}
	return &ProviderConnectionRefreshWorker{svc: svc, interval: interval, logger: logger}
}

func (w *ProviderConnectionRefreshWorker) Start(ctx context.Context) {
	if w.svc == nil || !w.svc.enabled {
		w.logger.Info("provider connection refresh worker not started: subscription connections are disabled")
		return
	}
	w.logger.Info("provider connection refresh worker started", "interval", w.interval)
	for {
		if err := w.PollOnce(ctx); err != nil {
			if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
				return
			}
			w.logger.Error("provider connection refresh poll error", "error", err)
		}
		select {
		case <-ctx.Done():
			w.logger.Info("provider connection refresh worker stopped")
			return
		case <-time.After(w.interval):
		}
	}
}

// PollOnce refreshes every due connection, bounded so one pass cannot spin.
func (w *ProviderConnectionRefreshWorker) PollOnce(ctx context.Context) error {
	for i := 0; i < 50; i++ {
		did, err := w.svc.RefreshDue(ctx)
		if err != nil {
			return err
		}
		if !did {
			return nil
		}
	}
	return nil
}
