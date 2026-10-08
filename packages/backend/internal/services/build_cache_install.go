package services

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
)

func WithBuildCacheInstallAuthorization(pool *pgxpool.Pool) func(*BuildCacheService) {
	return func(s *BuildCacheService) { s.install = &installRepositoryMutationStore{pool: pool} }
}

// One normalized request binds admission to the actual token operation.
func InstallBuildCacheTokenSubject(repository *db.Repository, id int64, name, namespace string) InstallSubject {
	subject := InstallSubject{Resource: "cache-token:" + strconv.FormatInt(id, 10)}
	if repository != nil {
		subject.RepositoryID = repository.ID
	}
	raw, _ := json.Marshal([]string{strings.TrimSpace(name), namespace})
	digest := sha256.Sum256(raw)
	subject.PayloadDigest = hex.EncodeToString(digest[:])
	return subject
}
func withInstallBuildCacheToken[T any](ctx context.Context, s *BuildCacheService, actor *db.User, repository *db.Repository, command string, subject InstallSubject, write bool, effect func(context.Context, *BuildCacheService) (T, error)) (T, error) {
	var zero T
	if s.install.pool == nil {
		return zero, confirmationPermission()
	}
	tx, err := s.install.pool.Begin(ctx)
	if err != nil {
		return zero, err
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()
	q := db.New(tx)
	decision, err := Authorize(ctx, q, command, subject)
	if err != nil {
		return zero, err
	}
	installed, err := InstallRepositoryID(ctx, q)
	if err != nil {
		return zero, err
	}
	info := middleware.AuthInfoFromContext(ctx)
	if repository == nil || repository.ID != installed || info == nil || info.User == nil || decision.UserID != info.User.ID || (actor != nil && actor.ID != decision.UserID) || (command == "cache.tokens.create" && actor == nil) {
		return zero, confirmationPermission()
	}
	ctx = WithInstallAuthorization(ctx, command, decision, subject)
	if err = guardInstallMemberCredential(ctx, tx, installed, decision.UserID, false); err != nil {
		return zero, err
	}
	scoped := *s
	scoped.installAdmitted = true
	scoped.store = &pgxBuildCacheStore{Queries: q, pool: s.install.pool}
	result, err := effect(ctx, &scoped)
	if err != nil {
		return zero, err
	}
	if err = guardInstallMemberCredential(ctx, tx, installed, decision.UserID, false); err != nil {
		return zero, err
	}
	if write {
		if err = tx.Commit(ctx); err != nil {
			return zero, err
		}
	}
	return result, nil
}
