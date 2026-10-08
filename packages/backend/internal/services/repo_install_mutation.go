package services

import (
	"context"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// Repository mutations share ownership ordering, one bound decision, and live
// credential fences. The callback uses this transaction's sole connection.
func withInstallRepositoryMutation[T any](ctx context.Context, s *RepoService, actor *db.User, owner, name, command string, bind func(int64) (InstallSubject, error), write func(context.Context, *RepoService) (T, error)) (T, error) {
	var zero T
	info := middleware.AuthInfoFromContext(ctx)
	if actor == nil || info == nil || info.User == nil {
		return zero, &AccessError{Status: 401, Class: "permission", Code: "unauthenticated", Message: "Sign in again"}
	}
	if s.install.pool == nil {
		return zero, pkgerrors.New(pkgerrors.CodeServiceUnavailable, "repository store unavailable")
	}
	tx, err := s.install.pool.Begin(ctx)
	if err != nil {
		return zero, err
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()
	q := db.New(tx)
	installed, err := InstallRepositoryID(ctx, q)
	if err != nil {
		return zero, err
	}
	if _, err := tx.Exec(ctx, repoOwnershipSharedLockSQL, installed); err != nil {
		return zero, err
	}
	if err := lockInstallRepositoryAdminMutation(ctx, tx, installed); err != nil {
		return zero, err
	}
	if err := guardInstallMemberCredential(ctx, tx, installed, info.User.ID, false); err != nil {
		return zero, err
	}
	scoped := *s
	scoped.queries = q
	repository, lookup := scoped.resolveRepoByOwnerAndName(ctx, owner, name)
	subject, validation := bind(repository.ID)
	decision, err := Authorize(ctx, q, command, subject)
	if err != nil {
		return zero, err
	}
	if lookup != nil {
		return zero, lookup
	}
	if validation != nil {
		return zero, validation
	}
	if repository.ID != installed || actor.ID != decision.UserID || actor.ID != info.User.ID {
		return zero, confirmationPermission()
	}
	scoped.installAdmitted = true
	ctx = WithInstallAuthorization(ctx, command, decision, subject)
	result, err := write(ctx, &scoped)
	if err != nil {
		return zero, err
	}
	if err := guardInstallMemberCredential(ctx, tx, installed, info.User.ID, false); err != nil {
		return zero, err
	}
	if err := tx.Commit(ctx); err != nil {
		return zero, err
	}
	return result, nil
}
