package services

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"strconv"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

type installAccountMutationStore struct{ pool *pgxpool.Pool }
type UserServiceOption func(*UserService)

func WithUserInstallAuthorization(pool *pgxpool.Pool) UserServiceOption {
	return func(s *UserService) { s.install = &installAccountMutationStore{pool: pool} }
}

// InstallAccountMutationSubject binds the authenticated account and the typed
// values the existing service consumes. An ignored HTTP field grants nothing.
func InstallAccountMutationSubject(repository, userID int64, command string, resourceID int64, input any) (InstallSubject, error) {
	subject := InstallSubject{RepositoryID: repository, Resource: "user:" + strconv.FormatInt(userID, 10) + ":" + strconv.FormatInt(resourceID, 10)}
	valid := false
	switch command {
	case "account.profile.update":
		_, valid = input.(UpdateUserRequest)
		valid = valid && resourceID == 0
	case "account.notifications.update":
		_, valid = input.(UpdateNotificationPreferencesRequest)
		valid = valid && resourceID == 0
	case "account.connection.delete":
		_, valid = input.(struct{})
		valid = valid && resourceID > 0
	}
	if !valid || userID <= 0 {
		return subject, pkgerrors.BadRequest("invalid account request")
	}
	raw, err := json.Marshal(input)
	if err != nil {
		return subject, pkgerrors.BadRequest("invalid account request")
	}
	sum := sha256.Sum256(raw)
	subject.PayloadDigest = hex.EncodeToString(sum[:])
	return subject, nil
}

func withInstallAccountMutation[T any](store *installAccountMutationStore, ctx context.Context, userID int64, command string, resourceID int64, input any, effect func(context.Context, *db.Queries) (T, error)) (T, error) {
	var zero T
	info := middleware.AuthInfoFromContext(ctx)
	if info == nil || info.User == nil {
		return zero, &AccessError{Status: 401, Class: "permission", Code: "unauthenticated", Message: "Sign in again"}
	}
	if info.User.ID != userID {
		return zero, confirmationPermission()
	}
	if store.pool == nil {
		return zero, pkgerrors.New(pkgerrors.CodeServiceUnavailable, "account store unavailable")
	}
	tx, err := store.pool.Begin(ctx)
	if err != nil {
		return zero, err
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()
	q := db.New(tx)
	installed, err := InstallRepositoryID(ctx, q)
	if err != nil {
		return zero, err
	}
	// Competing install mutations wait before taking credential row locks.
	if err := lockInstallRepositoryAdminMutation(ctx, tx, installed); err != nil {
		return zero, err
	}
	if err := guardInstallMemberCredential(ctx, tx, installed, userID, false); err != nil {
		return zero, err
	}
	subject, validation := InstallAccountMutationSubject(installed, userID, command, resourceID, input)
	decision, err := Authorize(ctx, q, command, subject)
	if err != nil {
		return zero, err
	}
	if validation != nil {
		return zero, validation
	}
	if decision.UserID != userID {
		return zero, confirmationPermission()
	}
	ctx = WithInstallAuthorization(ctx, command, decision, subject)
	result, err := effect(ctx, q)
	if err != nil {
		return zero, err
	}
	// SQL writes may have waited on another writer long enough for expiry.
	// Recheck before committing so all account changes roll back together.
	if err := guardInstallMemberCredential(ctx, tx, installed, userID, false); err != nil {
		return zero, err
	}
	if err := tx.Commit(ctx); err != nil {
		return zero, err
	}
	return result, nil
}
