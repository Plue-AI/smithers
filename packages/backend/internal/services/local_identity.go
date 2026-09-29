package services

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	stdErrors "errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"golang.org/x/crypto/argon2"

	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/identity"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/revocation"
)

const (
	localPasswordMinBytes = 12
	localPasswordMaxBytes = 1024
	argonMemoryKiB        = 64 * 1024
	argonIterations       = 3
	argonParallelism      = 2
	argonSaltBytes        = 16
	argonKeyBytes         = 32
	localArgonConcurrency = 2
)

// Each Argon2 operation reserves argonMemoryKiB. Bound concurrent work so a
// burst of valid or deliberately invalid login attempts cannot multiply that
// allocation without limit on a small self-host machine.
var localArgonSlots = make(chan struct{}, localArgonConcurrency)

// LocalIdentityQuerier is implemented by the shared PostgreSQL queries. It is
// intentionally feature-detected from AuthService so multitenant fakes and
// deployments keep the same auth implementation without acquiring local-only
// methods.
type LocalIdentityQuerier interface {
	GetSelfHostOwner(ctx context.Context) (db.User, error)
	GetSelfHostLocalCredential(ctx context.Context) (db.GetSelfHostLocalCredentialRow, error)
	BootstrapSelfHostOwner(ctx context.Context, arg db.BootstrapSelfHostOwnerParams) (db.BootstrapSelfHostOwnerRow, error)
	UpdateSelfHostOwnerPassword(ctx context.Context, arg db.UpdateSelfHostOwnerPasswordParams) (int64, error)
	DeleteUserSessions(ctx context.Context, userID int64) ([]string, error)
}

type LocalIdentityStatus struct {
	Enabled     bool `json:"enabled"`
	Initialized bool `json:"initialized"`
}

type LocalBootstrapRequest struct {
	Username       string
	Email          string
	Password       string
	BootstrapToken string
}

type LocalLoginResult struct {
	User       db.User
	SessionKey string
	ExpiresAt  time.Time
}

// ValidateLocalIdentityStartup makes an uninitialized selfhost fail loudly
// when composition omitted the one-time operator bootstrap credential. Once
// the durable owner exists, operators can remove the bootstrap token.
func ValidateLocalIdentityStartup(ctx context.Context, queries identity.OwnerQuerier, cfg config.AuthConfig) error {
	if !config.IsSingleOwner(cfg) {
		return nil
	}
	if queries == nil {
		return fmt.Errorf("single-owner identity storage is not configured")
	}
	if _, err := queries.GetSelfHostOwner(ctx); err == nil {
		return nil
	} else if !stdErrors.Is(err, pgx.ErrNoRows) {
		return fmt.Errorf("load installation owner: %w", err)
	}
	if strings.TrimSpace(cfg.BootstrapToken) == "" {
		return fmt.Errorf("auth.bootstrap_token is required until the installation owner is initialized")
	}
	return nil
}

func (s *AuthService) localIdentityQueries() (LocalIdentityQuerier, error) {
	if !config.IsSingleOwner(s.cfg) {
		return nil, pkgerrors.NotFound("local identity is not enabled")
	}
	queries, ok := s.queries.(LocalIdentityQuerier)
	if !ok {
		return nil, pkgerrors.Internal("local identity storage is not configured")
	}
	return queries, nil
}

func (s *AuthService) LocalIdentityStatus(ctx context.Context) (LocalIdentityStatus, error) {
	queries, err := s.localIdentityQueries()
	if err != nil {
		return LocalIdentityStatus{}, err
	}
	_, err = queries.GetSelfHostOwner(ctx)
	if err != nil {
		if err == pgx.ErrNoRows {
			return LocalIdentityStatus{Enabled: true}, nil
		}
		return LocalIdentityStatus{}, pkgerrors.Internal("failed to load installation owner").WithCause(err)
	}
	return LocalIdentityStatus{Enabled: true, Initialized: true}, nil
}

func (s *AuthService) BootstrapLocalOwner(ctx context.Context, req LocalBootstrapRequest) (LocalLoginResult, error) {
	queries, err := s.localIdentityQueries()
	if err != nil {
		return LocalLoginResult{}, err
	}
	configuredToken := strings.TrimSpace(s.cfg.BootstrapToken)
	if configuredToken == "" {
		return LocalLoginResult{}, pkgerrors.New(pkgerrors.CodeServiceUnavailable, "owner bootstrap is not configured")
	}
	if !equalSecret(configuredToken, strings.TrimSpace(req.BootstrapToken)) {
		return LocalLoginResult{}, pkgerrors.Unauthorized("invalid bootstrap token")
	}

	username := strings.TrimSpace(req.Username)
	if err := validateOwnerSegment("User", "username", username); err != nil {
		return LocalLoginResult{}, err
	}
	passwordHash, err := hashLocalPassword(req.Password)
	if err != nil {
		return LocalLoginResult{}, err
	}
	email := strings.TrimSpace(req.Email)
	userRow, err := queries.BootstrapSelfHostOwner(ctx, db.BootstrapSelfHostOwnerParams{
		Username:      username,
		LowerUsername: strings.ToLower(username),
		Email:         pgtype.Text{String: email, Valid: email != ""},
		LowerEmail:    pgtype.Text{String: strings.ToLower(email), Valid: email != ""},
		DisplayName:   username,
		PasswordHash:  passwordHash,
	})
	if err != nil {
		if isUsernameUniqueViolation(err) {
			return LocalLoginResult{}, pkgerrors.Conflict("username is already in use")
		}
		if err == pgx.ErrNoRows || isUniqueViolation(err) {
			return LocalLoginResult{}, pkgerrors.Conflict("installation owner is already initialized")
		}
		return LocalLoginResult{}, pkgerrors.Internal("failed to initialize installation owner").WithCause(err)
	}
	user := userFromBootstrapRow(userRow)
	return s.issueLocalSession(ctx, user)
}

func (s *AuthService) LoginLocalOwner(ctx context.Context, username, password string) (result LocalLoginResult, retErr error) {
	defer func() { s.observeLogin("local", retErr) }()
	owner, err := s.verifyLocalOwner(ctx, username, password)
	if err != nil {
		return LocalLoginResult{}, err
	}
	return s.issueLocalSession(ctx, owner)
}

func (s *AuthService) CreateLocalOwnerToken(ctx context.Context, username, password, name string, scopes []string) (token CreateTokenResult, owner db.User, retErr error) {
	defer func() { s.observeLogin("local-token", retErr) }()
	login, err := s.verifyLocalOwner(ctx, username, password)
	if err != nil {
		return CreateTokenResult{}, db.User{}, err
	}
	if strings.TrimSpace(name) == "" {
		name = "smithers-cli"
	}
	if len(scopes) == 0 {
		scopes = []string{"write:repository", "write:user", "write:workspace", "write:approval", "write:agent"}
	}
	for _, raw := range scopes {
		switch middleware.NormalizeTokenScope(raw) {
		case middleware.ScopeAll, middleware.ScopeAdmin,
			middleware.ScopeReadAdmin, middleware.ScopeWriteAdmin,
			middleware.ScopeReadOrganization, middleware.ScopeWriteOrganization:
			return CreateTokenResult{}, db.User{}, pkgerrors.Forbidden("tenant and administrative scopes are unavailable in single-owner mode")
		}
	}
	token, err = s.CreateToken(ctx, login.ID, CreateTokenRequest{Name: name, Scopes: scopes})
	return token, login, err
}

func (s *AuthService) ChangeLocalOwnerPassword(ctx context.Context, userID int64, currentPassword, newPassword string) (LocalLoginResult, error) {
	queries, err := s.localIdentityQueries()
	if err != nil {
		return LocalLoginResult{}, err
	}
	credential, err := queries.GetSelfHostLocalCredential(ctx)
	if err != nil || credential.ID != userID || !verifyLocalPassword(credential.PasswordHash, currentPassword) {
		return LocalLoginResult{}, pkgerrors.Unauthorized("current password is invalid")
	}
	passwordHash, err := hashLocalPassword(newPassword)
	if err != nil {
		return LocalLoginResult{}, err
	}
	// Password rotation invalidates every browser session, then issues one new
	// session for the caller. Existing PATs deliberately remain valid: they are
	// independently scoped credentials revoked through the existing token API.
	// Record the current sessions' revocations before changing anything, so a
	// failed record leaves the old password in place for a retry.
	existing, err := s.queries.ListUserSessions(ctx, userID)
	if err != nil {
		return LocalLoginResult{}, pkgerrors.Internal("failed to revoke old sessions").WithCause(err)
	}
	announced := make(map[string]bool, len(existing))
	for _, session := range existing {
		hash := storedSessionHash(session.SessionKey)
		if err := s.publishSessionRevoked(ctx, sessionRevokedEvent(hash, userID, "password changed")); err != nil {
			return LocalLoginResult{}, err
		}
		announced[hash] = true
	}
	rows, err := queries.UpdateSelfHostOwnerPassword(ctx, db.UpdateSelfHostOwnerPasswordParams{UserID: userID, PasswordHash: passwordHash})
	if err != nil || rows != 1 {
		return LocalLoginResult{}, pkgerrors.Internal("failed to change owner password")
	}
	deleted, err := queries.DeleteUserSessions(ctx, userID)
	if err != nil {
		return LocalLoginResult{}, pkgerrors.Internal("failed to revoke old sessions").WithCause(err)
	}
	// A session minted during rotation was not listed; the password change is
	// committed, so announce it best effort.
	for _, storedKey := range deleted {
		if hash := storedSessionHash(storedKey); !announced[hash] {
			revocation.PublishBestEffort(ctx, s.revocations, sessionRevokedEvent(hash, userID, "password changed"))
		}
	}
	return s.issueLocalSession(ctx, userFromLocalCredential(credential))
}

func (s *AuthService) verifyLocalOwner(ctx context.Context, username, password string) (db.User, error) {
	queries, err := s.localIdentityQueries()
	if err != nil {
		return db.User{}, err
	}
	credential, err := queries.GetSelfHostLocalCredential(ctx)
	if err != nil {
		if err == pgx.ErrNoRows {
			burnLocalPassword(password)
			return db.User{}, pkgerrors.Unauthorized("invalid username or password")
		}
		return db.User{}, pkgerrors.Internal("failed to load local credential").WithCause(err)
	}
	passwordOK := verifyLocalPassword(credential.PasswordHash, password)
	usernameOK := subtle.ConstantTimeCompare([]byte(strings.ToLower(strings.TrimSpace(username))), []byte(credential.LowerUsername)) == 1
	// Ownership is anchored by the singleton installation record, not the
	// mutable admin flag. This keeps the bootstrapped identity recoverable even
	// if an operator changes that flag directly in the database.
	if !passwordOK || !usernameOK || !credential.IsActive || credential.ProhibitLogin {
		return db.User{}, pkgerrors.Unauthorized("invalid username or password")
	}
	return userFromLocalCredential(credential), nil
}

func (s *AuthService) issueLocalSession(ctx context.Context, user db.User) (LocalLoginResult, error) {
	raw, session, err := s.createSession(ctx, user)
	if err != nil {
		return LocalLoginResult{}, pkgerrors.Internal("failed to create session").WithCause(err)
	}
	return LocalLoginResult{User: user, SessionKey: raw, ExpiresAt: session.ExpiresAt}, nil
}

func equalSecret(expected, actual string) bool {
	expectedHash := sha256.Sum256([]byte(expected))
	actualHash := sha256.Sum256([]byte(actual))
	return subtle.ConstantTimeCompare(expectedHash[:], actualHash[:]) == 1
}

func hashLocalPassword(password string) (string, error) {
	if len(password) < localPasswordMinBytes || len(password) > localPasswordMaxBytes {
		return "", pkgerrors.BadRequest("password must be between 12 and 1024 bytes")
	}
	salt := make([]byte, argonSaltBytes)
	if _, err := rand.Read(salt); err != nil {
		return "", pkgerrors.Internal("failed to initialize password credential").WithCause(err)
	}
	key := deriveLocalPasswordKey(password, salt, argonIterations, argonMemoryKiB, argonParallelism, argonKeyBytes)
	return fmt.Sprintf("$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s",
		argon2.Version, argonMemoryKiB, argonIterations, argonParallelism,
		base64.RawStdEncoding.EncodeToString(salt), base64.RawStdEncoding.EncodeToString(key)), nil
}

func verifyLocalPassword(encoded, password string) bool {
	parts := strings.Split(encoded, "$")
	if len(parts) != 6 || parts[1] != "argon2id" {
		burnLocalPassword(password)
		return false
	}
	var version int
	if _, err := fmt.Sscanf(parts[2], "v=%d", &version); err != nil || version != argon2.Version {
		burnLocalPassword(password)
		return false
	}
	params := strings.Split(parts[3], ",")
	if len(params) != 3 {
		burnLocalPassword(password)
		return false
	}
	memory, errM := strconv.ParseUint(strings.TrimPrefix(params[0], "m="), 10, 32)
	iterations, errT := strconv.ParseUint(strings.TrimPrefix(params[1], "t="), 10, 32)
	parallelism, errP := strconv.ParseUint(strings.TrimPrefix(params[2], "p="), 10, 8)
	if errM != nil || errT != nil || errP != nil || memory < 8*1024 || memory > 256*1024 || iterations == 0 || iterations > 10 || parallelism == 0 || parallelism > 16 {
		burnLocalPassword(password)
		return false
	}
	salt, errSalt := base64.RawStdEncoding.DecodeString(parts[4])
	want, errKey := base64.RawStdEncoding.DecodeString(parts[5])
	if errSalt != nil || errKey != nil || len(salt) < 16 || len(want) < 16 || len(want) > 64 {
		burnLocalPassword(password)
		return false
	}
	got := deriveLocalPasswordKey(password, salt, uint32(iterations), uint32(memory), uint8(parallelism), uint32(len(want)))
	return subtle.ConstantTimeCompare(got, want) == 1
}

func burnLocalPassword(password string) {
	_ = deriveLocalPasswordKey(password, make([]byte, argonSaltBytes), argonIterations, argonMemoryKiB, argonParallelism, argonKeyBytes)
}

func acquireLocalArgonSlot() func() {
	localArgonSlots <- struct{}{}
	return func() { <-localArgonSlots }
}

func deriveLocalPasswordKey(password string, salt []byte, iterations, memory uint32, parallelism uint8, keyBytes uint32) []byte {
	release := acquireLocalArgonSlot()
	defer release()
	return argon2.IDKey([]byte(password), salt, iterations, memory, parallelism, keyBytes)
}

func userFromBootstrapRow(row db.BootstrapSelfHostOwnerRow) db.User {
	return db.User{
		ID: row.ID, Username: row.Username, LowerUsername: row.LowerUsername,
		Email: row.Email, LowerEmail: row.LowerEmail, DisplayName: row.DisplayName,
		Bio: row.Bio, AvatarUrl: row.AvatarUrl, WalletAddress: row.WalletAddress,
		UserType: row.UserType, IsActive: row.IsActive, IsAdmin: row.IsAdmin,
		ProhibitLogin: row.ProhibitLogin, EmailNotificationsEnabled: row.EmailNotificationsEnabled,
		LastLoginAt: row.LastLoginAt, DeletedAt: row.DeletedAt, CreatedAt: row.CreatedAt,
		UpdatedAt: row.UpdatedAt, IsSynthetic: row.IsSynthetic,
	}
}

func userFromLocalCredential(row db.GetSelfHostLocalCredentialRow) db.User {
	return db.User{
		ID: row.ID, Username: row.Username, LowerUsername: row.LowerUsername,
		Email: row.Email, LowerEmail: row.LowerEmail, DisplayName: row.DisplayName,
		Bio: row.Bio, SearchVector: row.SearchVector, AvatarUrl: row.AvatarUrl,
		WalletAddress: row.WalletAddress, UserType: row.UserType, IsActive: row.IsActive,
		IsAdmin: row.IsAdmin, ProhibitLogin: row.ProhibitLogin,
		EmailNotificationsEnabled: row.EmailNotificationsEnabled, LastLoginAt: row.LastLoginAt,
		DeletedAt: row.DeletedAt, CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt,
		IsSynthetic: row.IsSynthetic,
	}
}
