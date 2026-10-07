package services

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

type installProtectedBookmarkStore struct{ pool *pgxpool.Pool }

func WithProtectedBookmarkInstallAuthorization(pool *pgxpool.Pool) ProtectedBookmarkServiceOption {
	return func(s *ProtectedBookmarkService) { s.install = &installProtectedBookmarkStore{pool: pool} }
}

// Configuration changes never move a bookmark. These subjects bind the stored
// repository and rule name, with the same typed validation as the existing CRUD.
func InstallProtectedBookmarkSubject(repository int64, command, pattern string, input any) (InstallSubject, error) {
	subject := InstallSubject{RepositoryID: repository, Resource: "protected-bookmark:" + strings.TrimSpace(pattern)}
	switch command {
	case "protected-bookmarks.upsert":
		value, ok := input.(UpsertProtectedBookmarkInput)
		if !ok || value.Pattern != pattern {
			return subject, pkgerrors.BadRequest("invalid bookmark protection")
		}
		if _, _, err := validateProtectedBookmarkInput(value); err != nil {
			return subject, err
		}
	case "protected-bookmarks.delete":
		if strings.TrimSpace(pattern) == "" {
			return subject, pkgerrors.BadRequest("invalid bookmark protection")
		}
		if _, ok := input.(struct{}); !ok {
			return subject, pkgerrors.BadRequest("invalid bookmark protection")
		}
	case "protected-bookmarks.read":
		if _, ok := input.(struct{}); !ok || pattern != "" {
			return subject, pkgerrors.BadRequest("invalid bookmark protection")
		}
	default:
		return subject, confirmationPermission()
	}
	raw, err := json.Marshal(input)
	if err != nil {
		return subject, pkgerrors.BadRequest("invalid bookmark protection")
	}
	digest := sha256.Sum256(raw)
	subject.PayloadDigest = hex.EncodeToString(digest[:])
	return subject, nil
}

func withInstallProtectedBookmark[T any](s *ProtectedBookmarkService, ctx context.Context, actor *db.User, owner, name, command, pattern string, input any, effect func(*ProtectedBookmarkService, context.Context) (T, error)) (T, error) {
	var zero T
	info := middleware.AuthInfoFromContext(ctx)
	if actor == nil || info == nil || info.User == nil {
		return zero, &AccessError{Status: 401, Class: "permission", Code: "unauthenticated", Message: "Sign in again"}
	}
	if s.install.pool == nil {
		return zero, pkgerrors.New(pkgerrors.CodeServiceUnavailable, "bookmark protection store unavailable")
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
	if command != "protected-bookmarks.read" {
		if err := lockInstallRepositoryAdminMutation(ctx, tx, installed); err != nil {
			return zero, err
		}
	}
	if err := guardInstallMemberCredential(ctx, tx, installed, actor.ID, false); err != nil {
		return zero, err
	}
	scoped := *s
	scoped.queries = q
	repository, lookup := scoped.resolveRepo(ctx, owner, name)
	subject, validation := InstallProtectedBookmarkSubject(repository.ID, command, pattern, input)
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
	if repository.ID != installed || actor.ID != decision.UserID {
		return zero, confirmationPermission()
	}
	ctx = WithInstallAuthorization(ctx, command, decision, subject)
	if command != "protected-bookmarks.read" {
		// Existing rows can also be locked by retained storage callers. Recheck
		// natural expiry after that wait and immediately before the mutation.
		if _, err := tx.Exec(ctx, `SELECT id FROM protected_bookmarks WHERE repository_id=$1 AND pattern=$2 FOR UPDATE`, repository.ID, strings.TrimSpace(pattern)); err != nil {
			return zero, err
		}
		if err := guardInstallMemberCredential(ctx, tx, installed, actor.ID, false); err != nil {
			return zero, err
		}
	}
	scoped.installAdmitted = true
	scoped.installRepository = &repository
	result, err := effect(&scoped, ctx)
	if err != nil {
		return zero, err
	}
	if err := tx.Commit(ctx); err != nil {
		return zero, err
	}
	return result, nil
}
