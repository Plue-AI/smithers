package services

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// These private namespaces distinguish OAuth requests from consent records in
// the durable, expiring, single-use OAuth state store. They are never PAT scopes.
const adminCLIRequestPrefix = "cli-admin-request:"
const adminCLIConsentPrefix = "cli-admin-consent:"

type AdminCLIRequest struct {
	TTL           time.Duration `json:"ttl"`
	CallbackPort  int           `json:"callback_port"`
	CallbackState string        `json:"callback_state,omitempty"`
}

type AdminCLIConsent struct {
	State        string
	CSRF         string
	Scopes       []string
	TTL          string
	CallbackPort int
	ExpiresAt    time.Time
}

type adminCLIGrant struct {
	Request    AdminCLIRequest `json:"request"`
	UserID     int64           `json:"user_id"`
	OAuthState string          `json:"oauth_state"`
}

type adminCLITokenQuerier interface {
	CreateAdminCLIAccessToken(context.Context, db.CreateAdminCLIAccessTokenParams) (db.CreateAdminCLIAccessTokenRow, error)
}

type AdminCLILoginResult struct {
	User    db.User
	Token   CreateTokenResult
	Request AdminCLIRequest
}

func ParseAdminCLITTL(raw string) (time.Duration, error) {
	if raw == "" {
		return time.Hour, nil
	}
	ttl, err := time.ParseDuration(raw)
	if err != nil || ttl < 5*time.Minute || ttl > 12*time.Hour {
		return 0, pkgerrors.BadRequest("ttl must be a Go duration between 5m and 12h")
	}
	return ttl, nil
}

func adminCLIScopes() []string {
	return append(defaultCLIOAuthScopes(), "read:admin", "write:admin")
}

func (s *AuthService) StartAdminCLILogin(ctx context.Context, verifier, rawTTL string, port int, callbackState, rawScopes string) (string, error) {
	ttl, err := ParseAdminCLITTL(rawTTL)
	if err != nil {
		return "", err
	}
	if port < 1024 || port > 65535 {
		return "", pkgerrors.BadRequest("invalid callback port")
	}
	// Admin consent always grants the documented scope set. Never accept a
	// caller-supplied privileged scope, even when admin=1 accompanies it.
	if _, err := normalizeAndValidateCLIOAuthScopes(rawScopes); err != nil {
		return "", err
	}
	request := AdminCLIRequest{TTL: ttl, CallbackPort: port, CallbackState: callbackState}
	payload, err := json.Marshal(request)
	if err != nil {
		return "", err
	}
	return s.startGitHubOAuthDirect(ctx, verifier, []string{adminCLIRequestPrefix + string(payload)})
}

func decodeAdminCLIRequest(scopes []string) (*AdminCLIRequest, error) {
	if len(scopes) != 1 || !strings.HasPrefix(scopes[0], adminCLIRequestPrefix) {
		return nil, nil
	}
	var request AdminCLIRequest
	if err := json.Unmarshal([]byte(strings.TrimPrefix(scopes[0], adminCLIRequestPrefix)), &request); err != nil {
		return nil, pkgerrors.BadRequest("invalid admin CLI request")
	}
	if _, err := ParseAdminCLITTL(request.TTL.String()); err != nil {
		return nil, err
	}
	if request.CallbackPort < 1024 || request.CallbackPort > 65535 {
		return nil, pkgerrors.BadRequest("invalid callback port")
	}
	return &request, nil
}

// PrepareAdminCLIConsent is called only after the upstream OAuth state and
// identity have been verified. No PAT or browser session is created here.
func (s *AuthService) PrepareAdminCLIConsent(ctx context.Context, result OAuthCallbackResult, oauthState, verifier string) (AdminCLIConsent, error) {
	if !result.User.IsAdmin || result.User.ProhibitLogin {
		return AdminCLIConsent{}, pkgerrors.Forbidden("administrator access required")
	}
	if result.AdminCLI == nil || verifier == "" || oauthState == "" {
		return AdminCLIConsent{}, pkgerrors.BadRequest("invalid admin CLI request")
	}
	csrf := randomHex(32)
	state := adminCLIConsentPrefix + s.generateState()
	payload, err := json.Marshal(adminCLIGrant{Request: *result.AdminCLI, UserID: result.User.ID, OAuthState: oauthState})
	if err != nil {
		return AdminCLIConsent{}, err
	}
	_, err = s.queries.CreateOAuthState(ctx, db.CreateOAuthStateParams{
		State: state, ContextHash: hashOAuthStateVerifier(verifier + ":" + csrf),
		RequestedScopes: []string{string(payload)}, ExpiresAt: s.now().Add(10 * time.Minute),
	})
	if err != nil {
		return AdminCLIConsent{}, pkgerrors.Internal("failed to store admin CLI consent").WithCause(err)
	}
	return AdminCLIConsent{State: state, CSRF: csrf, Scopes: adminCLIScopes(), TTL: result.AdminCLI.TTL.String(), CallbackPort: result.AdminCLI.CallbackPort, ExpiresAt: s.now().UTC().Add(result.AdminCLI.TTL)}, nil
}

// ApproveAdminCLILogin atomically consumes consent before minting. Identity and
// admin membership are reloaded so demotion while the page is open takes effect.
func (s *AuthService) ApproveAdminCLILogin(ctx context.Context, state, verifier, csrf, ip string) (AdminCLILoginResult, error) {
	if !strings.HasPrefix(state, adminCLIConsentPrefix) || verifier == "" || csrf == "" {
		return AdminCLILoginResult{}, pkgerrors.Forbidden("invalid admin CLI consent")
	}
	tokens, ok := s.queries.(adminCLITokenQuerier)
	if !ok {
		return AdminCLILoginResult{}, pkgerrors.Internal("admin CLI audit unavailable")
	}
	scopes, err := s.queries.ConsumeOAuthStateWithScopes(ctx, db.ConsumeOAuthStateWithScopesParams{State: state, ContextHash: hashOAuthStateVerifier(verifier + ":" + csrf)})
	if err != nil {
		return AdminCLILoginResult{}, pkgerrors.Forbidden("invalid or expired admin CLI consent")
	}
	var grant adminCLIGrant
	if len(scopes) != 1 || json.Unmarshal([]byte(scopes[0]), &grant) != nil || grant.OAuthState == "" {
		return AdminCLILoginResult{}, pkgerrors.Forbidden("invalid admin CLI consent")
	}
	if _, err := ParseAdminCLITTL(grant.Request.TTL.String()); err != nil {
		return AdminCLILoginResult{}, err
	}
	if grant.Request.CallbackPort < 1024 || grant.Request.CallbackPort > 65535 {
		return AdminCLILoginResult{}, pkgerrors.BadRequest("invalid callback port")
	}
	user, err := s.queries.GetUserByID(ctx, grant.UserID)
	if err != nil {
		return AdminCLILoginResult{}, pkgerrors.Internal("failed to load admin user").WithCause(err)
	}
	if !user.IsAdmin || user.ProhibitLogin {
		return AdminCLILoginResult{}, pkgerrors.Forbidden("administrator access required")
	}
	expiry := s.now().UTC().Add(grant.Request.TTL)
	scopes, scopeErr := normalizeAndValidateRequestedScopes(adminCLIScopes())
	if scopeErr != nil {
		return AdminCLILoginResult{}, scopeErr
	}
	rawToken := "smithers_" + randomHex(20)
	hash := sha256.Sum256([]byte(rawToken))
	tokenHash := hex.EncodeToString(hash[:])
	ip = AuditIP(ip)
	metadata, _ := json.Marshal(map[string]any{"ttl": grant.Request.TTL.String(), "callback_port": grant.Request.CallbackPort, "ip": ip})
	created, err := tokens.CreateAdminCLIAccessToken(ctx, db.CreateAdminCLIAccessTokenParams{
		UserID: user.ID, TokenHash: tokenHash, TokenLastEight: tokenHash[len(tokenHash)-8:],
		Scopes: strings.Join(scopes, ","), ExpiresAt: pgtype.Timestamptz{Time: expiry, Valid: true},
		ActorName: user.Username, Metadata: metadata, IpAddress: ip,
	})
	if err != nil {
		return AdminCLILoginResult{}, pkgerrors.Internal("failed to create audited admin CLI token").WithCause(err)
	}
	token := CreateTokenResult{Token: rawToken, TokenSummary: TokenSummary{ID: created.ID, Name: created.Name, Scopes: splitScopes(created.Scopes), TokenLastEight: created.TokenLastEight, ExpiresAt: timePtrFromTimestamptz(created.ExpiresAt)}}
	return AdminCLILoginResult{User: user, Token: token, Request: grant.Request}, nil
}
