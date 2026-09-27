package services

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	stdErrors "errors"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	smitherscrypto "github.com/smithersai/smithers/packages/backend/internal/pkg/crypto"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// Linear API types — defined here so auth/linear.go can return them without import cycles.

type LinearTokenResult struct {
	AccessToken  string    `json:"access_token"`
	RefreshToken string    `json:"refresh_token"`
	ExpiresAt    time.Time `json:"expires_at"`
}

type LinearViewer struct {
	ID    string `json:"id"`
	Email string `json:"email"`
	Name  string `json:"name"`
}

type LinearTeam struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Key  string `json:"key"`
}

// LinearIssue is the subset of a Linear issue needed to validate a manual
// Smithers issue link. The team is included so callers cannot link an issue
// from a different Linear team through a repository's integration token.
type LinearIssue struct {
	ID         string     `json:"id"`
	Identifier string     `json:"identifier"`
	Team       LinearTeam `json:"team"`
}

// LinearClient is implemented by auth.LinearClient.
type LinearClient interface {
	AuthorizationURL(state string) string
	ExchangeCode(ctx context.Context, code string) (LinearTokenResult, error)
	RefreshToken(ctx context.Context, refreshToken string) (LinearTokenResult, error)
	FetchViewer(ctx context.Context, accessToken string) (LinearViewer, error)
	FetchTeams(ctx context.Context, accessToken string) ([]LinearTeam, error)
}

type LinearIntegrationQuerier interface {
	CreateLinearIntegration(ctx context.Context, arg db.CreateLinearIntegrationParams) (db.LinearIntegration, error)
	GetLinearIntegration(ctx context.Context, id int64) (db.LinearIntegration, error)
	GetLinearIntegrationByUserAndID(ctx context.Context, arg db.GetLinearIntegrationByUserAndIDParams) (db.LinearIntegration, error)
	GetLinearIntegrationByLinearTeamID(ctx context.Context, linearTeamID string) (db.LinearIntegration, error)
	ListLinearIntegrationsByUser(ctx context.Context, userID int64) ([]db.LinearIntegration, error)
	ListLinearIntegrationsByRepo(ctx context.Context, smithersRepoID int64) ([]db.LinearIntegration, error)
	ListActiveLinearIntegrations(ctx context.Context) ([]db.LinearIntegration, error)
	UpdateLinearIntegrationTokens(ctx context.Context, arg db.UpdateLinearIntegrationTokensParams) error
	UpdateLinearIntegrationLastSync(ctx context.Context, id int64) error
	UpdateLinearIntegrationActive(ctx context.Context, arg db.UpdateLinearIntegrationActiveParams) error
	DeleteLinearIntegration(ctx context.Context, arg db.DeleteLinearIntegrationParams) error
	CreateOAuthState(ctx context.Context, arg db.CreateOAuthStateParams) (db.OauthState, error)
	ConsumeOAuthState(ctx context.Context, arg db.ConsumeOAuthStateParams) (int64, error)
	CreateLinearOAuthSetup(ctx context.Context, arg db.CreateLinearOAuthSetupParams) (db.LinearOauthSetup, error)
	DeleteLinearOAuthSetupsByUser(ctx context.Context, userID int64) error
	GetLinearOAuthSetupByUser(ctx context.Context, arg db.GetLinearOAuthSetupByUserParams) (db.LinearOauthSetup, error)
	ConsumeLinearOAuthSetupByUser(ctx context.Context, arg db.ConsumeLinearOAuthSetupByUserParams) (db.ConsumeLinearOAuthSetupByUserRow, error)
}

// LinearIntegrationRepositoryQuerier is kept separate from
// LinearIntegrationQuerier because token refresh and sync paths do not need
// repository authorization queries. The production db.Queries implements both
// interfaces; the split keeps those narrower consumers narrow as well.
type LinearIntegrationRepositoryQuerier interface {
	GetRepoByID(ctx context.Context, id int64) (db.Repository, error)
	GetRepoByOwnerAndLowerName(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error)
	GetUserByID(ctx context.Context, id int64) (db.User, error)
	GetOrgByID(ctx context.Context, id int64) (db.Organization, error)
	IsOrgOwnerForRepoUser(ctx context.Context, arg db.IsOrgOwnerForRepoUserParams) (bool, error)
	GetHighestTeamPermissionForRepoUser(ctx context.Context, arg db.GetHighestTeamPermissionForRepoUserParams) (string, error)
	GetCollaboratorPermissionForRepoUser(ctx context.Context, arg db.GetCollaboratorPermissionForRepoUserParams) (string, error)
}

type LinearIntegrationService struct {
	queries           LinearIntegrationQuerier
	repositoryQueries LinearIntegrationRepositoryQuerier
	linearClient      LinearClient
	sessionSecret     string
	now               func() time.Time
	generateSetupKey  func() (string, error)
}

var (
	linearIntegrationJSONMarshal = json.Marshal
	linearIntegrationEncrypt     = smitherscrypto.Encrypt
	linearIntegrationDecrypt     = smitherscrypto.Decrypt
)

func NewLinearIntegrationService(q LinearIntegrationQuerier, linearClient LinearClient, sessionSecret string) *LinearIntegrationService {
	repositoryQueries, _ := q.(LinearIntegrationRepositoryQuerier)
	return &LinearIntegrationService{
		queries:           q,
		repositoryQueries: repositoryQueries,
		linearClient:      linearClient,
		sessionSecret:     sessionSecret,
		now:               func() time.Time { return time.Now().UTC() },
		generateSetupKey:  func() (string, error) { return randomLinearHex(16) },
	}
}

type LinearOAuthStartResult struct {
	AuthorizationURL string `json:"authorization_url"`
}

func (s *LinearIntegrationService) StartLinearOAuth(ctx context.Context, stateVerifier string) (string, error) {
	if s.linearClient == nil {
		return "", pkgerrors.BadRequest("linear oauth is not configured")
	}

	stateKey, err := randomLinearHex(16)
	if err != nil {
		return "", pkgerrors.Internal("failed to generate linear oauth state").WithCause(err)
	}
	contextHash := hashSHA256(stateVerifier)

	_, err = s.queries.CreateOAuthState(ctx, db.CreateOAuthStateParams{
		State:       stateKey,
		ContextHash: contextHash,
		ExpiresAt:   s.now().Add(10 * time.Minute),
	})
	if err != nil {
		return "", pkgerrors.Internal("failed to create oauth state: " + err.Error())
	}

	return s.linearClient.AuthorizationURL(stateKey), nil
}

type LinearOAuthCallbackResult struct {
	AccessToken  string       `json:"access_token"`
	RefreshToken string       `json:"refresh_token,omitempty"`
	ExpiresAt    time.Time    `json:"expires_at,omitempty"`
	Viewer       LinearViewer `json:"viewer"`
	Teams        []LinearTeam `json:"teams"`
}

const linearOAuthSetupTTL = 10 * time.Minute

func (s *LinearIntegrationService) CompleteLinearOAuth(ctx context.Context, code, state, stateVerifier string) (LinearOAuthCallbackResult, error) {
	if s.linearClient == nil {
		return LinearOAuthCallbackResult{}, pkgerrors.BadRequest("linear oauth is not configured")
	}

	contextHash := hashSHA256(stateVerifier)
	consumed, err := s.queries.ConsumeOAuthState(ctx, db.ConsumeOAuthStateParams{
		State:       strings.TrimSpace(state),
		ContextHash: contextHash,
	})
	if err != nil {
		return LinearOAuthCallbackResult{}, pkgerrors.Internal("failed to consume oauth state: " + err.Error())
	}
	if consumed == 0 {
		return LinearOAuthCallbackResult{}, pkgerrors.BadRequest("invalid or expired oauth state")
	}

	tokenResult, err := s.linearClient.ExchangeCode(ctx, code)
	if err != nil {
		return LinearOAuthCallbackResult{}, pkgerrors.Internal("linear oauth code exchange failed: " + err.Error())
	}

	viewer, err := s.linearClient.FetchViewer(ctx, tokenResult.AccessToken)
	if err != nil {
		return LinearOAuthCallbackResult{}, pkgerrors.Internal("failed to fetch linear viewer: " + err.Error())
	}

	teams, err := s.linearClient.FetchTeams(ctx, tokenResult.AccessToken)
	if err != nil {
		return LinearOAuthCallbackResult{}, pkgerrors.Internal("failed to fetch linear teams: " + err.Error())
	}

	return LinearOAuthCallbackResult{
		AccessToken:  tokenResult.AccessToken,
		RefreshToken: tokenResult.RefreshToken,
		ExpiresAt:    tokenResult.ExpiresAt,
		Viewer:       viewer,
		Teams:        teams,
	}, nil
}

func (s *LinearIntegrationService) CreateOAuthSetup(ctx context.Context, userID int64, result LinearOAuthCallbackResult) (string, error) {
	payload, err := linearIntegrationJSONMarshal(result)
	if err != nil {
		return "", pkgerrors.Internal("failed to encode linear oauth setup").WithCause(err)
	}

	key := smitherscrypto.DeriveKey(s.sessionSecret)
	encryptedPayload, err := linearIntegrationEncrypt(key, payload)
	if err != nil {
		return "", pkgerrors.Internal("failed to encrypt linear oauth setup").WithCause(err)
	}

	setupKey, err := s.generateSetupKey()
	if err != nil {
		return "", pkgerrors.Internal("failed to generate linear oauth setup key").WithCause(err)
	}
	if err := s.queries.DeleteLinearOAuthSetupsByUser(ctx, userID); err != nil {
		return "", pkgerrors.Internal("failed to clear prior linear oauth setups: " + err.Error())
	}
	_, err = s.queries.CreateLinearOAuthSetup(ctx, db.CreateLinearOAuthSetupParams{
		SetupKey:         setupKey,
		UserID:           userID,
		PayloadEncrypted: encryptedPayload,
		ExpiresAt:        s.now().Add(linearOAuthSetupTTL),
	})
	if err != nil {
		return "", pkgerrors.Internal("failed to persist linear oauth setup: " + err.Error())
	}

	return setupKey, nil
}

// LinearOAuthSetupResult is the deliberately small, client-safe projection of
// a pending setup. OAuth credentials remain server-side; the actor identity is
// returned so the setup card can name the account that just authorized access.
type LinearOAuthSetupResult struct {
	LinearActor LinearViewer `json:"linear_actor"`
	Teams       []LinearTeam `json:"teams"`
	ExpiresAt   time.Time    `json:"expires_at"`
}

func (s *LinearIntegrationService) GetOAuthSetup(ctx context.Context, userID int64, setupKey string) (LinearOAuthSetupResult, error) {
	record, err := s.queries.GetLinearOAuthSetupByUser(ctx, db.GetLinearOAuthSetupByUserParams{
		SetupKey: strings.TrimSpace(setupKey),
		UserID:   userID,
	})
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return LinearOAuthSetupResult{}, pkgerrors.NotFound("linear oauth setup not found or expired")
		}
		return LinearOAuthSetupResult{}, pkgerrors.Internal("failed to load linear oauth setup: " + err.Error())
	}

	setup, err := s.decodeOAuthSetup(record.PayloadEncrypted)
	if err != nil {
		return LinearOAuthSetupResult{}, err
	}
	teams := setup.Teams
	if teams == nil {
		teams = make([]LinearTeam, 0)
	}
	return LinearOAuthSetupResult{
		LinearActor: setup.Viewer,
		Teams:       teams,
		ExpiresAt:   record.ExpiresAt,
	}, nil
}

func (s *LinearIntegrationService) ConsumeOAuthSetup(ctx context.Context, userID int64, setupKey string) (LinearOAuthCallbackResult, error) {
	record, err := s.queries.ConsumeLinearOAuthSetupByUser(ctx, db.ConsumeLinearOAuthSetupByUserParams{
		SetupKey: strings.TrimSpace(setupKey),
		UserID:   userID,
	})
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return LinearOAuthCallbackResult{}, pkgerrors.NotFound("linear oauth setup not found or expired")
		}
		return LinearOAuthCallbackResult{}, pkgerrors.Internal("failed to load linear oauth setup: " + err.Error())
	}

	return s.decodeOAuthSetup(record.PayloadEncrypted)
}

type ConfigureLinearIntegrationRequest struct {
	LinearTeamID     string    `json:"linear_team_id"`
	LinearTeamName   string    `json:"linear_team_name"`
	LinearTeamKey    string    `json:"linear_team_key"`
	RepoOwner        string    `json:"repo_owner"`
	RepoName         string    `json:"repo_name"`
	RepoID           int64     `json:"repo_id"`
	AccessToken      string    `json:"access_token"`
	RefreshToken     string    `json:"refresh_token"`
	ExpiresAt        time.Time `json:"expires_at"`
	LinearActorID    string    `json:"linear_actor_id"`
	LinearActorName  string    `json:"linear_actor_name"`
	LinearActorEmail string    `json:"linear_actor_email"`
}

// ConfigureLinearIntegrationFromSetupRequest is the public create contract.
// Repo is the canonical owner/name form. RepoID remains an internal
// compatibility input for the older /api/integrations/linear route.
type ConfigureLinearIntegrationFromSetupRequest struct {
	SetupKey     string
	LinearTeamID string
	Repo         string
	RepoID       int64
}

// ConfigureIntegrationFromOAuthSetup resolves and authorizes the repository,
// consumes the one-time OAuth setup, validates the selected team, and creates
// the integration. Keeping this orchestration in the service ensures the HTTP
// handler only translates the request and response.
func (s *LinearIntegrationService) ConfigureIntegrationFromOAuthSetup(ctx context.Context, userID int64, req ConfigureLinearIntegrationFromSetupRequest) (db.LinearIntegration, error) {
	setupKey := strings.TrimSpace(req.SetupKey)
	teamID := strings.TrimSpace(req.LinearTeamID)
	if setupKey == "" {
		return db.LinearIntegration{}, pkgerrors.BadRequest("setup_key is required")
	}
	if teamID == "" {
		return db.LinearIntegration{}, pkgerrors.BadRequest("linear_team_id is required")
	}
	if s.repositoryQueries == nil {
		return db.LinearIntegration{}, pkgerrors.Internal("repository access checker is not configured")
	}

	repo, err := s.resolveLinearIntegrationRepository(ctx, req)
	if err != nil {
		return db.LinearIntegration{}, err
	}
	canAdmin, err := s.canAdminLinearIntegrationRepository(ctx, userID, repo)
	if err != nil {
		return db.LinearIntegration{}, err
	}
	if !canAdmin {
		return db.LinearIntegration{}, pkgerrors.Forbidden("you do not have admin access to this repository")
	}

	repoOwner, repoName, err := s.canonicalLinearIntegrationRepositoryName(ctx, repo)
	if err != nil {
		return db.LinearIntegration{}, err
	}
	setup, err := s.ConsumeOAuthSetup(ctx, userID, setupKey)
	if err != nil {
		return db.LinearIntegration{}, err
	}

	var selectedTeam LinearTeam
	matchedTeam := false
	for _, team := range setup.Teams {
		if team.ID == teamID {
			selectedTeam = team
			matchedTeam = true
			break
		}
	}
	if !matchedTeam {
		return db.LinearIntegration{}, pkgerrors.BadRequest("selected linear_team_id was not returned by the oauth setup")
	}

	return s.ConfigureIntegration(ctx, userID, ConfigureLinearIntegrationRequest{
		LinearTeamID:     selectedTeam.ID,
		LinearTeamName:   selectedTeam.Name,
		LinearTeamKey:    selectedTeam.Key,
		RepoOwner:        repoOwner,
		RepoName:         repoName,
		RepoID:           repo.ID,
		AccessToken:      setup.AccessToken,
		RefreshToken:     setup.RefreshToken,
		ExpiresAt:        setup.ExpiresAt,
		LinearActorID:    setup.Viewer.ID,
		LinearActorName:  setup.Viewer.Name,
		LinearActorEmail: setup.Viewer.Email,
	})
}

func (s *LinearIntegrationService) resolveLinearIntegrationRepository(ctx context.Context, req ConfigureLinearIntegrationFromSetupRequest) (db.Repository, error) {
	repoName := strings.TrimSpace(req.Repo)
	if repoName != "" {
		owner, name, ok := strings.Cut(repoName, "/")
		if !ok || strings.TrimSpace(owner) == "" || strings.TrimSpace(name) == "" || strings.Contains(name, "/") {
			return db.Repository{}, pkgerrors.BadRequest("repo must be in owner/name format")
		}
		owner = strings.TrimSpace(owner)
		name = strings.TrimSpace(name)
		repo, err := s.repositoryQueries.GetRepoByOwnerAndLowerName(ctx, db.GetRepoByOwnerAndLowerNameParams{
			Owner:     owner,
			LowerName: strings.ToLower(name),
		})
		if err != nil {
			if stdErrors.Is(err, pgx.ErrNoRows) {
				return db.Repository{}, pkgerrors.NotFound("repository not found")
			}
			return db.Repository{}, pkgerrors.Internal("failed to resolve repository").WithCause(err)
		}
		return repo, nil
	}

	if req.RepoID == 0 {
		return db.Repository{}, pkgerrors.BadRequest("repo is required")
	}
	repo, err := s.repositoryQueries.GetRepoByID(ctx, req.RepoID)
	if err != nil {
		return db.Repository{}, pkgerrors.NotFound("repository not found")
	}
	return repo, nil
}

func (s *LinearIntegrationService) canAdminLinearIntegrationRepository(ctx context.Context, userID int64, repo db.Repository) (bool, error) {
	allowed, err := canAdminRepo(ctx, s.repositoryQueries, repo, userID)
	if err != nil {
		return false, pkgerrors.Internal("failed to resolve repository permissions").WithCause(err)
	}
	return allowed, nil
}

func (s *LinearIntegrationService) canonicalLinearIntegrationRepositoryName(ctx context.Context, repo db.Repository) (string, string, error) {
	switch {
	case repo.OrgID.Valid:
		org, err := s.repositoryQueries.GetOrgByID(ctx, repo.OrgID.Int64)
		if err != nil {
			return "", "", pkgerrors.Internal("failed to resolve repository owner").WithCause(err)
		}
		return org.Name, repo.Name, nil
	case repo.UserID.Valid:
		user, err := s.repositoryQueries.GetUserByID(ctx, repo.UserID.Int64)
		if err != nil {
			return "", "", pkgerrors.Internal("failed to resolve repository owner").WithCause(err)
		}
		return user.Username, repo.Name, nil
	default:
		return "", "", pkgerrors.Internal("repository has no owner")
	}
}

func (s *LinearIntegrationService) ConfigureIntegration(ctx context.Context, userID int64, req ConfigureLinearIntegrationRequest) (db.LinearIntegration, error) {
	key := smitherscrypto.DeriveKey(s.sessionSecret)

	encryptedAccess, err := linearIntegrationEncrypt(key, []byte(req.AccessToken))
	if err != nil {
		return db.LinearIntegration{}, pkgerrors.Internal("failed to encrypt linear access token").WithCause(err)
	}

	var encryptedRefresh []byte
	if req.RefreshToken != "" {
		encryptedRefresh, err = linearIntegrationEncrypt(key, []byte(req.RefreshToken))
		if err != nil {
			return db.LinearIntegration{}, pkgerrors.Internal("failed to encrypt linear refresh token").WithCause(err)
		}
	}

	webhookSecret, err := randomLinearHex(32)
	if err != nil {
		return db.LinearIntegration{}, pkgerrors.Internal("failed to generate linear webhook secret").WithCause(err)
	}
	encryptedWebhookSecret, err := linearIntegrationEncrypt(key, []byte(webhookSecret))
	if err != nil {
		return db.LinearIntegration{}, pkgerrors.Internal("failed to encrypt linear webhook secret").WithCause(err)
	}

	var tokenExpiresAt pgtype.Timestamptz
	if !req.ExpiresAt.IsZero() {
		tokenExpiresAt = pgtype.Timestamptz{Time: req.ExpiresAt, Valid: true}
	}

	integration, err := s.queries.CreateLinearIntegration(ctx, db.CreateLinearIntegrationParams{
		UserID:                userID,
		LinearTeamID:          req.LinearTeamID,
		LinearTeamName:        req.LinearTeamName,
		LinearTeamKey:         req.LinearTeamKey,
		AccessTokenEncrypted:  encryptedAccess,
		RefreshTokenEncrypted: encryptedRefresh,
		TokenExpiresAt:        tokenExpiresAt,
		WebhookSecret:         base64.StdEncoding.EncodeToString(encryptedWebhookSecret),
		JjhubRepoID:           req.RepoID,
		JjhubRepoOwner:        req.RepoOwner,
		JjhubRepoName:         req.RepoName,
		LinearActorID:         req.LinearActorID,
		LinearActorName:       req.LinearActorName,
		LinearActorEmail:      req.LinearActorEmail,
	})
	if err != nil {
		return db.LinearIntegration{}, pkgerrors.Internal("failed to create linear integration: " + err.Error())
	}

	return integration, nil
}

func (s *LinearIntegrationService) ListIntegrations(ctx context.Context, userID int64) ([]db.LinearIntegration, error) {
	return s.queries.ListLinearIntegrationsByUser(ctx, userID)
}

func (s *LinearIntegrationService) GetIntegration(ctx context.Context, userID, integrationID int64) (db.LinearIntegration, error) {
	return s.queries.GetLinearIntegrationByUserAndID(ctx, db.GetLinearIntegrationByUserAndIDParams{
		ID:     integrationID,
		UserID: userID,
	})
}

func (s *LinearIntegrationService) DeleteIntegration(ctx context.Context, userID, integrationID int64) error {
	return s.queries.DeleteLinearIntegration(ctx, db.DeleteLinearIntegrationParams{
		ID:     integrationID,
		UserID: userID,
	})
}

func (s *LinearIntegrationService) GetDecryptedAccessToken(ctx context.Context, integration db.LinearIntegration) (string, error) {
	if len(integration.AccessTokenEncrypted) == 0 {
		return "", pkgerrors.Internal("linear integration has no access token")
	}

	key := smitherscrypto.DeriveKey(s.sessionSecret)
	plaintext, err := linearIntegrationDecrypt(key, integration.AccessTokenEncrypted)
	if err != nil {
		return "", pkgerrors.Internal("failed to decrypt linear access token").WithCause(err)
	}
	return string(plaintext), nil
}

// GetDecryptedWebhookSecret decrypts the stored base64(AES-256-GCM) webhook signing secret.
func (s *LinearIntegrationService) GetDecryptedWebhookSecret(integration db.LinearIntegration) (string, error) {
	if integration.WebhookSecret == "" {
		return "", pkgerrors.Internal("linear integration has no webhook secret")
	}
	ciphertext, err := base64.StdEncoding.DecodeString(integration.WebhookSecret)
	if err != nil {
		return "", pkgerrors.Internal("failed to decode linear webhook secret").WithCause(err)
	}
	key := smitherscrypto.DeriveKey(s.sessionSecret)
	plaintext, err := linearIntegrationDecrypt(key, ciphertext)
	if err != nil {
		return "", pkgerrors.Internal("failed to decrypt linear webhook secret").WithCause(err)
	}
	return string(plaintext), nil
}

func (s *LinearIntegrationService) RefreshTokenIfNeeded(ctx context.Context, integration db.LinearIntegration) (db.LinearIntegration, error) {
	if !integration.TokenExpiresAt.Valid {
		return integration, nil
	}
	if s.now().Before(integration.TokenExpiresAt.Time.Add(-5 * time.Minute)) {
		return integration, nil
	}
	if len(integration.RefreshTokenEncrypted) == 0 {
		return integration, nil
	}

	key := smitherscrypto.DeriveKey(s.sessionSecret)
	refreshPlain, err := linearIntegrationDecrypt(key, integration.RefreshTokenEncrypted)
	if err != nil {
		return integration, pkgerrors.Internal("failed to decrypt linear refresh token").WithCause(err)
	}

	tokenResult, err := s.linearClient.RefreshToken(ctx, string(refreshPlain))
	if err != nil {
		return integration, fmt.Errorf("linear token refresh failed: %w", err)
	}

	encryptedAccess, err := linearIntegrationEncrypt(key, []byte(tokenResult.AccessToken))
	if err != nil {
		return integration, pkgerrors.Internal("failed to encrypt refreshed access token").WithCause(err)
	}

	var encryptedRefresh []byte
	if tokenResult.RefreshToken != "" {
		encryptedRefresh, err = linearIntegrationEncrypt(key, []byte(tokenResult.RefreshToken))
		if err != nil {
			return integration, pkgerrors.Internal("failed to encrypt refreshed refresh token").WithCause(err)
		}
	}

	var tokenExpiresAt pgtype.Timestamptz
	if !tokenResult.ExpiresAt.IsZero() {
		tokenExpiresAt = pgtype.Timestamptz{Time: tokenResult.ExpiresAt, Valid: true}
	}

	if err := s.queries.UpdateLinearIntegrationTokens(ctx, db.UpdateLinearIntegrationTokensParams{
		ID:                    integration.ID,
		AccessTokenEncrypted:  encryptedAccess,
		RefreshTokenEncrypted: encryptedRefresh,
		TokenExpiresAt:        tokenExpiresAt,
	}); err != nil {
		return integration, pkgerrors.Internal("failed to store refreshed tokens").WithCause(err)
	}

	integration.AccessTokenEncrypted = encryptedAccess
	integration.RefreshTokenEncrypted = encryptedRefresh
	integration.TokenExpiresAt = tokenExpiresAt
	return integration, nil
}

func (s *LinearIntegrationService) GetIntegrationByLinearTeamID(ctx context.Context, teamID string) (db.LinearIntegration, error) {
	return s.queries.GetLinearIntegrationByLinearTeamID(ctx, teamID)
}

func (s *LinearIntegrationService) ListIntegrationsByRepo(ctx context.Context, repoID int64) ([]db.LinearIntegration, error) {
	return s.queries.ListLinearIntegrationsByRepo(ctx, repoID)
}

func (s *LinearIntegrationService) decodeOAuthSetup(payloadEncrypted []byte) (LinearOAuthCallbackResult, error) {
	key := smitherscrypto.DeriveKey(s.sessionSecret)
	payload, err := linearIntegrationDecrypt(key, payloadEncrypted)
	if err != nil {
		return LinearOAuthCallbackResult{}, pkgerrors.Internal("failed to decrypt linear oauth setup").WithCause(err)
	}

	var result LinearOAuthCallbackResult
	if err := json.Unmarshal(payload, &result); err != nil {
		return LinearOAuthCallbackResult{}, pkgerrors.Internal("failed to decode linear oauth setup").WithCause(err)
	}

	return result, nil
}

func randomLinearHex(n int) (string, error) {
	buf := make([]byte, n)
	if _, err := io.ReadFull(rand.Reader, buf); err != nil {
		return "", fmt.Errorf("randomLinearHex: failed to read random bytes: %w", err)
	}
	return hex.EncodeToString(buf), nil
}

func hashSHA256(s string) string {
	return fmt.Sprintf("%x", smitherscrypto.DeriveKey(s))
}
