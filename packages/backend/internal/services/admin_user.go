package services

import (
	"context"
	stdErrors "errors"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/revocation"
)

type AdminUserQuerier interface {
	AdminSetUserSynthetic(context.Context, db.AdminSetUserSyntheticParams) (db.User, error)
	ListUsers(ctx context.Context, arg db.ListUsersParams) ([]db.User, error)
	CountUsers(ctx context.Context) (int64, error)
	CreateUser(ctx context.Context, arg db.CreateUserParams) (db.User, error)
	GetUserByLowerUsername(ctx context.Context, lowerUsername string) (db.User, error)
	AdminGetUserForSuspension(ctx context.Context, lowerUsername string) (db.User, error)
	SuspendUser(ctx context.Context, id int64) error
	SetUserAdmin(ctx context.Context, arg db.SetUserAdminParams) error
	SetUserSuspended(ctx context.Context, arg db.SetUserSuspendedParams) (db.User, error)
	GetAccessTokenByID(ctx context.Context, id int64) (db.AccessToken, error)
	DeleteAccessTokenByIDAndUserID(ctx context.Context, arg db.DeleteAccessTokenByIDAndUserIDParams) (int64, error)
}

// TokenCreator creates access tokens for a given user. Satisfied by *AuthService.
type TokenCreator interface {
	CreateToken(ctx context.Context, userID int64, req CreateTokenRequest) (CreateTokenResult, error)
}

// AdminAuditor records privileged admin mutation events.
type AdminAuditor interface {
	Log(ctx context.Context, event AuditEvent)
}

type AdminUserService struct {
	revocations  revocation.Publisher
	queries      AdminUserQuerier
	tokenCreator TokenCreator
	auditor      AdminAuditor
	erasure      *AccountErasure
	export       *AccountExport
}

type adminAuditActorContextKey struct{}

// AdminAuditActor identifies the authenticated admin behind an admin user mutation.
type AdminAuditActor struct {
	UserID    int64
	Username  string
	IPAddress string
}

// ContextWithAdminAuditActor attaches the acting admin to service-layer audit
// events, with the IP in the form audit_log stores (AuditIP).
func ContextWithAdminAuditActor(ctx context.Context, actor AdminAuditActor) context.Context {
	actor.IPAddress = AuditIP(actor.IPAddress)
	return context.WithValue(ctx, adminAuditActorContextKey{}, actor)
}

// AdminAuditActorFromContext returns the acting admin attached by admin routes.
func AdminAuditActorFromContext(ctx context.Context) (AdminAuditActor, bool) {
	actor, ok := ctx.Value(adminAuditActorContextKey{}).(AdminAuditActor)
	return actor, ok
}

func NewAdminUserService(q AdminUserQuerier, opts ...AdminUserServiceOption) *AdminUserService {
	s := &AdminUserService{queries: q}
	for _, opt := range opts {
		opt(s)
	}
	return s
}

type AdminUserServiceOption func(*AdminUserService)

func WithTokenCreator(tc TokenCreator) AdminUserServiceOption {
	return func(s *AdminUserService) {
		s.tokenCreator = tc
	}
}

// WithAdminAuditor wires an audit logger into AdminUserService.
func WithAdminAuditor(a AdminAuditor) AdminUserServiceOption {
	return func(s *AdminUserService) {
		s.auditor = a
	}
}

type AdminUserListInput struct {
	Page    int
	PerPage int
}

// AdminUserProfile adds classification metadata only to the admin user list.
type AdminUserProfile struct {
	UserProfile
	IsSynthetic bool   `json:"is_synthetic"`
	UserType    string `json:"user_type"`
}

// AdminCreateUserInput holds the parameters for admin-created users.
type AdminCreateUserInput struct {
	Username    string `json:"username"`
	Email       string `json:"email"`
	DisplayName string `json:"display_name"`
}

func (s *AdminUserService) ListUsers(ctx context.Context, input AdminUserListInput) ([]AdminUserProfile, int64, error) {
	page, perPage := normalizePagination(input.Page, input.PerPage)
	offset := ClampInt32((page - 1) * perPage)

	total, err := s.queries.CountUsers(ctx)
	if err != nil {
		return nil, 0, pkgerrors.Internal("failed to count users").WithCause(err)
	}

	users, err := s.queries.ListUsers(ctx, db.ListUsersParams{
		PageOffset: offset,
		PageSize:   int32(perPage),
	})
	if err != nil {
		return nil, 0, pkgerrors.Internal("failed to list users").WithCause(err)
	}

	profiles := make([]AdminUserProfile, len(users))
	for i, u := range users {
		profiles[i] = AdminUserProfile{
			UserProfile: mapUserProfile(u),
			IsSynthetic: u.IsSynthetic,
			UserType:    u.UserType,
		}
	}

	return profiles, total, nil
}

func (s *AdminUserService) logAudit(ctx context.Context, event AuditEvent) {
	if s.auditor == nil {
		return
	}
	actor, ok := AdminAuditActorFromContext(ctx)
	if ok {
		if actor.UserID != 0 {
			actorID := actor.UserID
			event.ActorID = &actorID
		}
		event.ActorName = actor.Username
		event.IPAddress = actor.IPAddress
	}
	s.auditor.Log(ctx, event)
}

// CreateUser creates a new user account as an admin operation.
// The username must be unique (case-insensitive). Email is optional.
func (s *AdminUserService) CreateUser(ctx context.Context, input AdminCreateUserInput) (UserProfile, error) {
	username := strings.TrimSpace(input.Username)
	if username == "" {
		return UserProfile{}, pkgerrors.ValidationFailed(pkgerrors.FieldError{
			Resource: "User",
			Field:    "username",
			Code:     "missing_field",
		})
	}
	if err := validateOwnerSegment("User", "username", username); err != nil {
		return UserProfile{}, err
	}

	displayName := strings.TrimSpace(input.DisplayName)
	if displayName == "" {
		displayName = username
	}

	var emailText pgtype.Text
	var lowerEmailText pgtype.Text
	emailTrimmed := strings.TrimSpace(input.Email)
	if emailTrimmed != "" {
		emailText = pgtype.Text{String: emailTrimmed, Valid: true}
		lowerEmailText = pgtype.Text{String: strings.ToLower(emailTrimmed), Valid: true}
	}

	user, err := s.queries.CreateUser(ctx, db.CreateUserParams{
		Username:      username,
		LowerUsername: strings.ToLower(username),
		Email:         emailText,
		LowerEmail:    lowerEmailText,
		DisplayName:   displayName,
	})
	if err != nil {
		if isUniqueViolation(err) {
			return UserProfile{}, pkgerrors.Conflict("username or email already in use")
		}
		return UserProfile{}, pkgerrors.Internal("failed to create user").WithCause(err)
	}

	createdID := user.ID
	s.logAudit(ctx, AuditEvent{
		EventType:  "admin.user.create",
		TargetType: "user",
		TargetID:   &createdID,
		TargetName: user.Username,
		Action:     "create_user",
		Metadata:   map[string]any{"username": user.Username, "email": input.Email},
	})

	return mapUserProfile(user), nil
}

// DeleteUser suspends a user by username as an admin operation.
// Sets deleted_at, is_active=false, and prohibit_login=true to preserve all
// collaboration history while preventing future access.
// Returns NotFound if the user does not exist.
func (s *AdminUserService) DeleteUser(ctx context.Context, username string) error {
	username = strings.TrimSpace(username)
	if username == "" {
		return pkgerrors.BadRequest("username is required")
	}

	user, err := s.queries.GetUserByLowerUsername(ctx, strings.ToLower(username))
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return pkgerrors.NotFound("user not found")
		}
		return pkgerrors.Internal("failed to look up user").WithCause(err)
	}

	err = s.queries.SuspendUser(ctx, user.ID)
	if err != nil {
		return pkgerrors.Internal("failed to suspend user").WithCause(err)
	}

	targetID := user.ID
	s.logAudit(ctx, AuditEvent{
		EventType:  "admin.user.suspend",
		TargetType: "user",
		TargetID:   &targetID,
		TargetName: user.Username,
		Action:     "suspend",
	})
	// The user-access trigger publishes the state change in the same transaction.

	return nil
}

// SetUserAdmin sets or clears the admin flag on a user.
func (s *AdminUserService) SetUserAdmin(ctx context.Context, username string, isAdmin bool) (UserProfile, error) {
	username = strings.TrimSpace(username)
	if username == "" {
		return UserProfile{}, pkgerrors.BadRequest("username is required")
	}

	user, err := s.queries.GetUserByLowerUsername(ctx, strings.ToLower(username))
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return UserProfile{}, pkgerrors.NotFound("user not found")
		}
		return UserProfile{}, pkgerrors.Internal("failed to look up user").WithCause(err)
	}

	if err := s.queries.SetUserAdmin(ctx, db.SetUserAdminParams{
		UserID:  user.ID,
		IsAdmin: isAdmin,
	}); err != nil {
		return UserProfile{}, pkgerrors.Internal("failed to update admin status").WithCause(err)
	}

	targetID := user.ID
	action := "grant_admin"
	if !isAdmin {
		action = "revoke_admin"
	}
	s.logAudit(ctx, AuditEvent{
		EventType:  "admin.user.set_admin",
		TargetType: "user",
		TargetID:   &targetID,
		TargetName: user.Username,
		Action:     action,
		Metadata:   map[string]any{"is_admin": isAdmin},
	})

	user.IsAdmin = isAdmin
	return mapUserProfile(user), nil
}

// CreateTokenForUser creates an access token for a specified user (admin operation).
func (s *AdminUserService) CreateTokenForUser(ctx context.Context, username string, req CreateTokenRequest) (CreateTokenResult, error) {
	if s.tokenCreator == nil {
		return CreateTokenResult{}, pkgerrors.Internal("token creation not configured")
	}

	username = strings.TrimSpace(username)
	if username == "" {
		return CreateTokenResult{}, pkgerrors.BadRequest("username is required")
	}

	user, err := s.queries.GetUserByLowerUsername(ctx, strings.ToLower(username))
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return CreateTokenResult{}, pkgerrors.NotFound("user not found")
		}
		return CreateTokenResult{}, pkgerrors.Internal("failed to look up user").WithCause(err)
	}

	result, err := s.tokenCreator.CreateToken(ctx, user.ID, req)
	if err != nil {
		return CreateTokenResult{}, err
	}

	targetID := user.ID
	s.logAudit(ctx, AuditEvent{
		EventType:  "admin.user.create_token",
		TargetType: "user",
		TargetID:   &targetID,
		TargetName: user.Username,
		Action:     "create_token",
		Metadata:   map[string]any{"token_name": req.Name, "scopes": req.Scopes},
	})

	return result, nil
}

// SetSuspended suspends or unsuspends a user by username. Unlike DeleteUser,
// this does not set deleted_at so the operation is reversible.
func (s *AdminUserService) SetSuspended(ctx context.Context, username string, suspended bool) (UserProfile, error) {
	username = strings.TrimSpace(username)
	if username == "" {
		return UserProfile{}, pkgerrors.BadRequest("username is required")
	}

	user, err := s.queries.AdminGetUserForSuspension(ctx, strings.ToLower(username))
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return UserProfile{}, pkgerrors.NotFound("user not found")
		}
		return UserProfile{}, pkgerrors.Internal("failed to look up user").WithCause(err)
	}

	updated, err := s.queries.SetUserSuspended(ctx, db.SetUserSuspendedParams{
		UserID:    user.ID,
		Suspended: suspended,
	})
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return UserProfile{}, pkgerrors.NotFound("user not found")
		}
		return UserProfile{}, pkgerrors.Internal("failed to update suspension status").WithCause(err)
	}

	targetID := user.ID
	action := "suspend"
	if !suspended {
		action = "unsuspend"
	}
	s.logAudit(ctx, AuditEvent{
		EventType:  "admin.user.set_suspended",
		TargetType: "user",
		TargetID:   &targetID,
		TargetName: user.Username,
		Action:     action,
		Metadata:   map[string]any{"suspended": suspended},
	})
	// The user-access trigger publishes the state change in the same transaction.

	return mapUserProfile(updated), nil
}

// RevokeToken deletes a specific access token belonging to the given user.
// Returns NotFound if the user or token does not exist, or if the token does
// not belong to the user (to prevent information leakage).
func (s *AdminUserService) RevokeToken(ctx context.Context, username string, tokenID int64) error {
	username = strings.TrimSpace(username)
	if username == "" {
		return pkgerrors.BadRequest("username is required")
	}

	user, err := s.queries.GetUserByLowerUsername(ctx, strings.ToLower(username))
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return pkgerrors.NotFound("user not found")
		}
		return pkgerrors.Internal("failed to look up user").WithCause(err)
	}

	// Fetch token to validate ownership and capture metadata for audit log
	// before deletion.
	token, err := s.queries.GetAccessTokenByID(ctx, tokenID)
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return pkgerrors.NotFound("token not found")
		}
		return pkgerrors.Internal("failed to look up token").WithCause(err)
	}
	if token.UserID != user.ID {
		// Return 404 rather than 403 to avoid leaking token existence.
		return pkgerrors.NotFound("token not found")
	}

	rows, err := s.queries.DeleteAccessTokenByIDAndUserID(ctx, db.DeleteAccessTokenByIDAndUserIDParams{
		ID:     tokenID,
		UserID: user.ID,
	})
	if err != nil {
		return pkgerrors.Internal("failed to revoke token").WithCause(err)
	}
	if rows == 0 {
		return pkgerrors.NotFound("token not found")
	}
	revocation.PublishBestEffort(ctx, s.revocations, revocation.Event{
		Kind:      revocation.KindTokenRevoked,
		UserID:    user.ID,
		TokenID:   tokenID,
		TokenHash: token.TokenHash,
		Reason:    "token revoked by an administrator",
		ActorID:   adminActorID(ctx),
	})

	targetID := user.ID
	s.logAudit(ctx, AuditEvent{
		EventType:  "admin.user.revoke_token",
		TargetType: "user",
		TargetID:   &targetID,
		TargetName: user.Username,
		Action:     "revoke_token",
		Metadata:   map[string]any{"token_id": tokenID, "token_name": token.Name},
	})

	return nil
}
