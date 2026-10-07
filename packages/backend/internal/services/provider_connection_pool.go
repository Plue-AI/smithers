package services

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// The provider account pool. A scope (a user's own connections that apply to
// a repository, under its preference) is one pool; the pool route asks it
// for an account per request, least recently used first, and
// reports usage limits and refusals back so the next request skips that
// account until it resets.

const (
	providerPoolLockedRetries    = 3
	providerDeviceLoginPollLease = time.Minute
	providerDeviceLoginMaxAge    = 15 * time.Minute
)

// ProviderPoolPick is one selection from a run's pool.
type ProviderPoolPick struct {
	// Connection is the account to use; nil when none is usable right now.
	Connection *ResolvedProviderConnection
	// Pooled reports that the scope has connections for this provider, so the
	// call must not fall back to platform credentials.
	Pooled bool
	// NextReset is the earliest limited_until among limited accounts.
	NextReset time.Time
	// Reconnect reports that every account of the pool needs a new sign-in.
	Reconnect bool
}

// PickForModelCall selects the next account of the run's pool for one model
// request, skipping excluded connection ids (accounts this request already
// tried). A zero pick with Pooled false means the scope has no connections.
// The pool is the run user's own connections only: a subscription serves only
// its account holder's own runs.
func (s *ProviderConnectionService) PickForModelCall(ctx context.Context, userID, repositoryID int64, provider string, excluded []string) (ProviderPoolPick, error) {
	s = s.withPoolAuthorityStore(ctx)
	if s == nil || repositoryID <= 0 || userID <= 0 {
		return ProviderPoolPick{}, nil
	}
	if s.poolOwner != nil {
		var err error
		userID, err = s.poolOwner(ctx)
		if err != nil {
			return ProviderPoolPick{}, err
		}
	}
	provider, err := normalizeProviderConnectionProvider(provider)
	if err != nil {
		return ProviderPoolPick{}, nil
	}
	if use, err := s.usesUserConnections(ctx, repositoryID); err != nil || !use {
		return ProviderPoolPick{}, err
	}
	tried := append([]string{}, excluded...)
	status := db.ProviderConnectionPoolStatusParams{Provider: provider, Source: "user", UserID: userID, RepositoryID: repositoryID}
	counts, err := s.q.ProviderConnectionPoolStatus(ctx, status)
	if err != nil {
		return ProviderPoolPick{}, fmt.Errorf("provider pool status: %w", err)
	}
	if counts.Active+counts.Reconnect == 0 {
		return ProviderPoolPick{}, nil
	}
	pick := ProviderPoolPick{Pooled: true, Reconnect: counts.Active == 0}
	if counts.NextReset.After(time.Unix(0, 0)) {
		pick.NextReset = counts.NextReset
	}
	for {
		params := db.PickProviderConnectionParams{
			Provider: provider, Excluded: tried, Source: "user", UserID: userID, RepositoryID: repositoryID,
		}
		row, err := s.q.PickProviderConnection(ctx, params)
		// SKIP LOCKED also skips rows concurrent picks are stamping this
		// instant (a lock that lasts one statement): look again briefly,
		// then wait for one rather than report an empty pool.
		for retry := 1; errors.Is(err, pgx.ErrNoRows) && counts.Usable > 0 && retry <= providerPoolLockedRetries; retry++ {
			time.Sleep(time.Duration(retry) * time.Millisecond)
			row, err = s.q.PickProviderConnection(ctx, params)
		}
		if errors.Is(err, pgx.ErrNoRows) && counts.Usable > 0 {
			row, err = s.q.PickProviderConnectionWaiting(ctx, db.PickProviderConnectionWaitingParams(params))
		}
		if errors.Is(err, pgx.ErrNoRows) {
			return pick, nil
		}
		if err != nil {
			return ProviderPoolPick{}, fmt.Errorf("pick provider connection: %w", err)
		}
		tried = append(tried, row.ID)
		resolved, err := s.materialize(ctx, row)
		if err != nil {
			s.logger.Warn("provider connection unusable for model call", "connection_id", row.ID, "provider", provider, "error", err)
			continue
		}
		// Refresh and decrypt may wait on a provider while the owner revokes
		// the connection; recheck before handing the token out.
		current, err := s.q.GetProviderConnection(ctx, row.ID)
		if err != nil || current.State != ProviderConnectionStateActive {
			continue
		}
		pick.Connection = resolved
		return pick, nil
	}
}

// ServesPool reports whether the user's connected accounts may serve the
// repository at all: the deployment allows subscription connections and the
// repository's preference lets a user draw on their own accounts. A guest
// offered the pool asks it which providers have accounts when it resolves a
// seat, so an account connected after boot serves the next seat.
func (s *ProviderConnectionService) ServesPool(ctx context.Context, userID, repositoryID int64) (bool, error) {
	if s == nil || repositoryID <= 0 || userID <= 0 {
		return false, nil
	}
	return s.usesUserConnections(ctx, repositoryID)
}

// HasPool reports whether the run user has any connection for the provider,
// limited or not; such a run's calls are served by the pool.
func (s *ProviderConnectionService) HasPool(ctx context.Context, userID, repositoryID int64, provider string) (bool, error) {
	s = s.withPoolAuthorityStore(ctx)
	if s == nil || repositoryID <= 0 || userID <= 0 {
		return false, nil
	}
	if s.poolOwner != nil {
		var err error
		userID, err = s.poolOwner(ctx)
		if err != nil {
			return false, err
		}
	}
	provider, err := normalizeProviderConnectionProvider(provider)
	if err != nil {
		return false, nil
	}
	if use, err := s.usesUserConnections(ctx, repositoryID); err != nil || !use {
		return false, err
	}
	counts, err := s.q.ProviderConnectionPoolStatus(ctx, db.ProviderConnectionPoolStatusParams{Provider: provider, Source: "user", UserID: userID, RepositoryID: repositoryID})
	if err != nil {
		return false, fmt.Errorf("provider pool status: %w", err)
	}
	return counts.Active+counts.Reconnect > 0, nil
}

// MarkLimited parks a connection until its usage limit resets.
func (s *ProviderConnectionService) MarkLimited(ctx context.Context, connectionID string, until time.Time) error {
	return s.q.MarkProviderConnectionLimited(ctx, db.MarkProviderConnectionLimitedParams{ID: connectionID, LimitedUntil: until.UTC()})
}

// MarkRejected records that the provider refused the credential itself: the
// connection needs a new sign-in. A refresh that already replaced the refused
// token (a newer generation) wins.
func (s *ProviderConnectionService) MarkRejected(ctx context.Context, connectionID string, generation int64, reason string) error {
	n, err := s.q.MarkProviderConnectionRejected(ctx, db.MarkProviderConnectionRejectedParams{ID: connectionID, RefreshGeneration: generation, LastError: reason})
	if err == nil && n > 0 {
		s.logger.Warn("provider refused connection credential", "connection_id", connectionID, "reason", reason)
	}
	return err
}

// ForceRefresh refreshes one connection now under the shared refresh lease.
// It fails when the connection has no refresh token or another refresh holds
// the lease.
func (s *ProviderConnectionService) ForceRefresh(ctx context.Context, connectionID string) error {
	s = s.withPoolAuthorityStore(ctx)
	row, err := s.q.GetProviderConnection(ctx, connectionID)
	if err != nil {
		return err
	}
	if len(row.RefreshTokenEncrypted) == 0 || row.State == ProviderConnectionStateRevoked {
		return errors.New("connection cannot be refreshed")
	}
	return s.refreshRow(ctx, row)
}

// Reorder sets the rotation order of the actor's connections for one
// provider and restarts the rotation at the top.
func (s *ProviderConnectionService) Reorder(ctx context.Context, actor *db.User, provider string, ids []string) error {
	if actor == nil {
		return pkgerrors.Unauthorized("authentication required")
	}
	provider, err := normalizeProviderConnectionProvider(provider)
	if err != nil {
		return err
	}
	if len(ids) == 0 || len(ids) > 100 {
		return pkgerrors.BadRequest("ids must name 1-100 connections")
	}
	for i, id := range ids {
		n, err := s.q.SetUserProviderConnectionSortOrder(ctx, db.SetUserProviderConnectionSortOrderParams{ID: strings.TrimSpace(id), UserID: pgtype.Int8{Int64: actor.ID, Valid: true}, Provider: provider, SortOrder: int32(i)})
		if err != nil {
			return pkgerrors.Internal("failed to reorder provider connections").WithCause(err)
		}
		if n == 0 {
			return pkgerrors.NotFound("provider connection not found")
		}
	}
	return nil
}

// Codex device-code sign-in (`codex login --device-auth`).

// ErrCodexDeviceAuthorizationPending is the poll answer before the user approves.
var ErrCodexDeviceAuthorizationPending = errors.New("device authorization pending")

// CodexDeviceAuthorization is a started device-code sign-in.
type CodexDeviceAuthorization struct {
	DeviceAuthID string
	UserCode     string
	Interval     time.Duration
	ExpiresAt    time.Time
}

// CodexDeviceAuthorizer speaks OpenAI's device-code sign-in for the Codex
// client. PollDeviceAuthorization returns ErrCodexDeviceAuthorizationPending
// until the user approves; a permanent refusal wraps errCodexDevicePermanent.
type CodexDeviceAuthorizer interface {
	StartDeviceAuthorization(ctx context.Context) (CodexDeviceAuthorization, error)
	PollDeviceAuthorization(ctx context.Context, deviceAuthID, userCode string) (code, verifier string, err error)
	ExchangeDeviceCode(ctx context.Context, code, verifier string) (RefreshedTokens, error)
	DeviceVerificationURL() string
}

var errCodexDevicePermanent = errors.New("device authorization refused")

// ProviderDeviceLoginResponse is the browser's view of a device sign-in.
type ProviderDeviceLoginResponse struct {
	ID              string                      `json:"id"`
	Provider        string                      `json:"provider"`
	State           string                      `json:"state"`
	UserCode        string                      `json:"user_code"`
	VerificationURI string                      `json:"verification_uri"`
	IntervalSeconds int32                       `json:"interval_seconds"`
	ExpiresAt       time.Time                   `json:"expires_at"`
	Connection      *ProviderConnectionResponse `json:"connection,omitempty"`
}

// StartCodexDeviceLogin begins a Codex sign-in the user approves on OpenAI.
func (s *ProviderConnectionService) StartCodexDeviceLogin(ctx context.Context, actor *db.User) (ProviderDeviceLoginResponse, error) {
	if actor == nil {
		return ProviderDeviceLoginResponse{}, pkgerrors.Unauthorized("authentication required")
	}
	if !s.SubscriptionConnectionsEnabled(ctx) {
		return ProviderDeviceLoginResponse{}, errSubscriptionConnectionsUnavailable()
	}
	if s.device == nil {
		return ProviderDeviceLoginResponse{}, pkgerrors.BadRequest("codex sign-in is not configured")
	}
	started, err := s.device.StartDeviceAuthorization(ctx)
	if err != nil {
		return ProviderDeviceLoginResponse{}, pkgerrors.New(pkgerrors.CodeBadGateway, "codex sign-in unavailable").WithCause(err)
	}
	cipher, err := s.codec.EncryptString(started.DeviceAuthID)
	if err != nil {
		return ProviderDeviceLoginResponse{}, pkgerrors.Internal("failed to encrypt device authorization").WithCause(err)
	}
	now := s.now()
	interval := started.Interval
	if interval < time.Second {
		interval = 5 * time.Second
	}
	expires := started.ExpiresAt
	if expires.IsZero() || expires.After(now.Add(providerDeviceLoginMaxAge)) {
		expires = now.Add(providerDeviceLoginMaxAge)
	}
	row, err := s.q.CreateProviderConnectionDeviceLogin(ctx, db.CreateProviderConnectionDeviceLoginParams{
		UserID: actor.ID, Provider: ProviderConnectionProviderCodex, DeviceAuthIDEncrypted: []byte(cipher), UserCode: started.UserCode,
		IntervalSeconds: int32(interval / time.Second), ExpiresAt: expires.UTC(), NextPollAt: now.Add(interval).UTC(),
	})
	if err != nil {
		return ProviderDeviceLoginResponse{}, pkgerrors.Internal("failed to store device sign-in").WithCause(err)
	}
	return s.deviceLoginResponse(ctx, actor, row), nil
}

// PollCodexDeviceLogin checks a pending sign-in once. It is safe to call
// repeatedly and concurrently: one poller at a time talks to OpenAI, never
// faster than its interval, and a finished sign-in answers from storage.
func (s *ProviderConnectionService) PollCodexDeviceLogin(ctx context.Context, actor *db.User, id string) (ProviderDeviceLoginResponse, error) {
	if actor == nil {
		return ProviderDeviceLoginResponse{}, pkgerrors.Unauthorized("authentication required")
	}
	if !s.SubscriptionConnectionsEnabled(ctx) {
		return ProviderDeviceLoginResponse{}, errSubscriptionConnectionsUnavailable()
	}
	row, err := s.q.GetProviderConnectionDeviceLogin(ctx, db.GetProviderConnectionDeviceLoginParams{ID: strings.TrimSpace(id), UserID: actor.ID})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ProviderDeviceLoginResponse{}, pkgerrors.NotFound("device sign-in not found")
		}
		return ProviderDeviceLoginResponse{}, pkgerrors.BadRequest("device sign-in not found")
	}
	if row.State != "pending" {
		return s.deviceLoginResponse(ctx, actor, row), nil
	}
	now := s.now()
	reload := func() (ProviderDeviceLoginResponse, error) {
		fresh, err := s.q.GetProviderConnectionDeviceLogin(ctx, db.GetProviderConnectionDeviceLoginParams{ID: row.ID, UserID: actor.ID})
		if err != nil {
			return ProviderDeviceLoginResponse{}, pkgerrors.Internal("failed to reload device sign-in").WithCause(err)
		}
		return s.deviceLoginResponse(ctx, actor, fresh), nil
	}
	if !now.Before(row.ExpiresAt) {
		// A poll holding the lease may be finishing the exchange; it decides.
		if _, err := s.q.ExpireProviderConnectionDeviceLogin(ctx, db.ExpireProviderConnectionDeviceLoginParams{ID: row.ID, UserID: actor.ID}); err != nil {
			return ProviderDeviceLoginResponse{}, pkgerrors.Internal("failed to expire device sign-in").WithCause(err)
		}
		return reload()
	}
	claimed, err := s.q.ClaimProviderConnectionDeviceLoginPoll(ctx, db.ClaimProviderConnectionDeviceLoginPollParams{ID: row.ID, UserID: actor.ID, LeaseUntil: now.Add(providerDeviceLoginPollLease).UTC()})
	if errors.Is(err, pgx.ErrNoRows) {
		return s.deviceLoginResponse(ctx, actor, row), nil // too soon, or another poll holds the lease
	}
	if err != nil {
		return ProviderDeviceLoginResponse{}, pkgerrors.Internal("failed to claim device sign-in").WithCause(err)
	}
	finish := func(state string, next time.Time, connectionID string, lastError string) (ProviderDeviceLoginResponse, error) {
		params := db.FinishProviderConnectionDeviceLoginPollParams{ID: row.ID, State: state, NextPollAt: next.UTC(), LastError: lastError, LeaseUntil: claimed.PollLeaseUntil.Time}
		if connectionID != "" {
			params.ConnectionID = pgUUIDFromString(connectionID)
		}
		if _, err := s.q.FinishProviderConnectionDeviceLoginPoll(ctx, params); err != nil {
			return ProviderDeviceLoginResponse{}, pkgerrors.Internal("failed to store device sign-in").WithCause(err)
		}
		return reload()
	}
	interval := time.Duration(max(claimed.IntervalSeconds, 1)) * time.Second
	deviceAuthID, err := s.codec.DecryptString(string(claimed.DeviceAuthIDEncrypted))
	if err != nil {
		return finish("failed", now, "", "device authorization unreadable")
	}
	code, verifier, err := s.device.PollDeviceAuthorization(ctx, deviceAuthID, claimed.UserCode)
	if errors.Is(err, ErrCodexDeviceAuthorizationPending) {
		return finish("pending", now.Add(interval), "", "")
	}
	if err != nil {
		if errors.Is(err, errCodexDevicePermanent) {
			return finish("failed", now, "", "sign-in refused")
		}
		return finish("pending", now.Add(2*interval), "", "")
	}
	// The authorization code is single-use: from here a failure is final.
	tokens, err := s.device.ExchangeDeviceCode(ctx, code, verifier)
	if err != nil {
		return finish("failed", now, "", "token exchange failed")
	}
	if tokens.AccountID == "" {
		return finish("failed", now, "", "the sign-in carried no ChatGPT account")
	}
	label := strings.TrimSpace(tokens.AccountEmail)
	if !providerConnectionLabelPattern.MatchString(label) {
		label = ProviderConnectionProviderCodex
	}
	in := ConnectProviderInput{
		Provider: ProviderConnectionProviderCodex, Kind: ProviderConnectionKindOAuth, Label: label,
		AccessToken: tokens.AccessToken, RefreshToken: tokens.RefreshToken,
		AccountEmail: tokens.AccountEmail, AccountID: tokens.AccountID, Plan: tokens.Plan,
	}
	if !tokens.ExpiresAt.IsZero() {
		expires := tokens.ExpiresAt
		in.AccessExpiresAt = &expires
	}
	connection, err := s.createConnection(ctx, actor, "user", actor.ID, 0, in)
	if err != nil {
		return finish("failed", now, "", "failed to store the connection")
	}
	if granted, err := s.grantEverywhere(ctx, connection); err == nil {
		connection = granted
	} else if granted, err = s.grantEverywhere(ctx, connection); err == nil {
		connection = granted
	}
	if _, err := s.q.RevokeOtherUserProviderAccountConnections(ctx, db.RevokeOtherUserProviderAccountConnectionsParams{
		UserID: pgtype.Int8{Int64: actor.ID, Valid: true}, Provider: ProviderConnectionProviderCodex, AccountID: tokens.AccountID, KeepID: connection.ID,
	}); err != nil {
		s.logger.Warn("revoke replaced codex connections failed", "connection_id", connection.ID, "error", err)
	}
	return finish("connected", now, connection.ID, "")
}

func (s *ProviderConnectionService) deviceLoginResponse(ctx context.Context, actor *db.User, row db.ProviderConnectionDeviceLogin) ProviderDeviceLoginResponse {
	out := ProviderDeviceLoginResponse{
		ID: row.ID, Provider: row.Provider, State: row.State, UserCode: row.UserCode,
		IntervalSeconds: row.IntervalSeconds, ExpiresAt: row.ExpiresAt,
	}
	if s.device != nil {
		out.VerificationURI = s.device.DeviceVerificationURL()
	}
	leased := row.PollLeaseUntil.Valid && row.PollLeaseUntil.Time.After(s.now())
	if row.State == "pending" && !leased && !s.now().Before(row.ExpiresAt) {
		out.State = "expired"
	}
	if row.ConnectionID.Valid {
		if connection, err := s.Get(ctx, actor, uuidString(row.ConnectionID)); err == nil {
			out.Connection = &connection
		}
	}
	return out
}

// HTTP device authorizer on the Codex CLI's OAuth client.

func (r *HTTPProviderTokenRefresher) codexIssuer() string {
	issuer := strings.TrimRight(strings.TrimSpace(r.cfg.CodexIssuer), "/")
	if issuer == "" {
		issuer = "https://auth.openai.com"
	}
	return issuer
}

// DeviceVerificationURL is where the user enters the code.
func (r *HTTPProviderTokenRefresher) DeviceVerificationURL() string {
	return r.codexIssuer() + "/codex/device"
}

func (r *HTTPProviderTokenRefresher) postJSON(ctx context.Context, endpoint string, payload any) (int, []byte, error) {
	body, err := json.Marshal(payload)
	if err != nil {
		return 0, nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return 0, nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	resp, err := r.client.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 64*1024))
	return resp.StatusCode, raw, nil
}

func (r *HTTPProviderTokenRefresher) StartDeviceAuthorization(ctx context.Context) (CodexDeviceAuthorization, error) {
	status, raw, err := r.postJSON(ctx, r.codexIssuer()+"/api/accounts/deviceauth/usercode", map[string]any{"client_id": r.cfg.CodexClientID})
	if err != nil {
		return CodexDeviceAuthorization{}, fmt.Errorf("device authorization endpoint: %w", err)
	}
	if status < 200 || status >= 300 {
		return CodexDeviceAuthorization{}, fmt.Errorf("device authorization endpoint returned %d", status)
	}
	var parsed struct {
		DeviceAuthID string          `json:"device_auth_id"`
		UserCode     string          `json:"user_code"`
		UserCodeAlt  string          `json:"usercode"`
		Interval     json.RawMessage `json:"interval"`
		ExpiresAt    string          `json:"expires_at"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return CodexDeviceAuthorization{}, errors.New("device authorization endpoint returned an unreadable body")
	}
	if parsed.UserCode == "" {
		parsed.UserCode = parsed.UserCodeAlt
	}
	if parsed.DeviceAuthID == "" || parsed.UserCode == "" || len(parsed.UserCode) > 32 {
		return CodexDeviceAuthorization{}, errors.New("device authorization endpoint returned no code")
	}
	out := CodexDeviceAuthorization{DeviceAuthID: parsed.DeviceAuthID, UserCode: parsed.UserCode, Interval: 5 * time.Second}
	if seconds, err := strconv.Atoi(strings.Trim(string(parsed.Interval), `"`)); err == nil && seconds > 0 && seconds <= 60 {
		out.Interval = time.Duration(seconds) * time.Second
	}
	if expires, err := time.Parse(time.RFC3339Nano, parsed.ExpiresAt); err == nil {
		out.ExpiresAt = expires
	}
	return out, nil
}

func (r *HTTPProviderTokenRefresher) PollDeviceAuthorization(ctx context.Context, deviceAuthID, userCode string) (string, string, error) {
	status, raw, err := r.postJSON(ctx, r.codexIssuer()+"/api/accounts/deviceauth/token", map[string]any{"device_auth_id": deviceAuthID, "user_code": userCode})
	if err != nil {
		return "", "", fmt.Errorf("device token endpoint: %w", err)
	}
	if status == http.StatusForbidden || status == http.StatusNotFound {
		if bytes.Contains(raw, []byte("pending")) || status == http.StatusNotFound {
			return "", "", ErrCodexDeviceAuthorizationPending
		}
		return "", "", fmt.Errorf("%w (HTTP %d)", errCodexDevicePermanent, status)
	}
	if status >= 400 && status < 500 {
		return "", "", fmt.Errorf("%w (HTTP %d)", errCodexDevicePermanent, status)
	}
	if status < 200 || status >= 300 {
		return "", "", fmt.Errorf("device token endpoint returned %d", status)
	}
	var parsed struct {
		AuthorizationCode string `json:"authorization_code"`
		CodeVerifier      string `json:"code_verifier"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil || parsed.AuthorizationCode == "" || parsed.CodeVerifier == "" {
		return "", "", fmt.Errorf("%w: unreadable approval", errCodexDevicePermanent)
	}
	return parsed.AuthorizationCode, parsed.CodeVerifier, nil
}

func (r *HTTPProviderTokenRefresher) ExchangeDeviceCode(ctx context.Context, code, verifier string) (RefreshedTokens, error) {
	form := url.Values{
		"grant_type":    {"authorization_code"},
		"code":          {code},
		"redirect_uri":  {r.codexIssuer() + "/deviceauth/callback"},
		"client_id":     {r.cfg.CodexClientID},
		"code_verifier": {verifier},
	}
	endpoint := r.cfg.CodexTokenURL
	if endpoint == "" {
		endpoint = r.codexIssuer() + "/oauth/token"
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(form.Encode()))
	if err != nil {
		return RefreshedTokens{}, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	resp, err := r.client.Do(req)
	if err != nil {
		return RefreshedTokens{}, fmt.Errorf("token endpoint: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 64*1024))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return RefreshedTokens{}, fmt.Errorf("token endpoint returned %d", resp.StatusCode)
	}
	var parsed struct {
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
		IDToken      string `json:"id_token"`
		ExpiresIn    int64  `json:"expires_in"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil || parsed.AccessToken == "" || parsed.RefreshToken == "" {
		return RefreshedTokens{}, errors.New("token endpoint returned an unreadable body")
	}
	out := RefreshedTokens{AccessToken: parsed.AccessToken, RefreshToken: parsed.RefreshToken}
	if parsed.ExpiresIn > 0 {
		out.ExpiresAt = time.Now().Add(time.Duration(parsed.ExpiresIn) * time.Second)
	} else if exp, ok := jwtExpiry(parsed.AccessToken); ok {
		out.ExpiresAt = exp
	}
	out.AccountID, out.AccountEmail, out.Plan = codexIdentityClaims(parsed.IDToken)
	return out, nil
}
