package services

import (
	"context"
	stdErrors "errors"
	"log/slog"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// Per-repository ownership advisory locks. Ownership mutators (transfer,
// delete, settings update) take the exclusive form; repo-scoped writers that
// only need to fence against a concurrent ownership change take the shared
// form, so they serialize with transfers but not with each other. The string
// prefix keeps the key space disjoint from other advisory-lock users.
//
// The parameter is typed bigint and cast to text inside the statement rather
// than written as $1::text: the latter makes Postgres infer a text parameter,
// which pgx cannot encode the int64 repository id into.
const (
	repoOwnershipLockSQL       = "SELECT pg_advisory_xact_lock(hashtextextended('repository_ownership:' || ($1::bigint)::text, 0))"
	repoOwnershipSharedLockSQL = "SELECT pg_advisory_xact_lock_shared(hashtextextended('repository_ownership:' || ($1::bigint)::text, 0))"
)

// RepoOwnershipGuard fences a repository-scoped write against concurrent
// ownership changes: the write runs while the per-repository ownership lock is
// held in shared mode, after re-validating that the repository still has the
// owner/name the caller authorized against.
type RepoOwnershipGuard interface {
	WithRepoOwnershipShared(ctx context.Context, snapshot db.Repository, write func() error) error
}

// RepoOwnershipFence is the pgxpool-backed RepoOwnershipGuard used in
// production. It shares the advisory-lock key space with RepoService's
// ownership transaction, so guarded writes serialize with transfers, deletes,
// and settings updates.
type RepoOwnershipFence struct {
	pool *pgxpool.Pool
}

// NewRepoOwnershipFence returns a fence backed by pool, or nil when pool is nil.
func NewRepoOwnershipFence(pool *pgxpool.Pool) *RepoOwnershipFence {
	if pool == nil {
		return nil
	}
	return &RepoOwnershipFence{pool: pool}
}

func (f *RepoOwnershipFence) WithRepoOwnershipShared(ctx context.Context, snapshot db.Repository, write func() error) error {
	if f == nil || f.pool == nil {
		return write()
	}
	tx, err := f.pool.Begin(ctx)
	if err != nil {
		slog.Error("failed to begin repository ownership guard transaction", "repo_id", snapshot.ID, "error", err)
		return pkgerrors.Internal("failed to serialize repository write").WithCause(err)
	}
	// The transaction only holds the shared lock; rolling it back releases the
	// lock after the write completes and never discards data.
	defer func() { _ = tx.Rollback(ctx) }()

	if _, err := tx.Exec(ctx, repoOwnershipSharedLockSQL, snapshot.ID); err != nil {
		slog.Error("failed to acquire repository ownership shared lock", "repo_id", snapshot.ID, "error", err)
		return pkgerrors.Internal("failed to serialize repository write").WithCause(err)
	}

	fresh, err := db.New(tx).GetRepoByID(ctx, snapshot.ID)
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return pkgerrors.NotFound("repository not found")
		}
		slog.Error("failed to re-validate repository ownership", "repo_id", snapshot.ID, "error", err)
		return pkgerrors.Internal("failed to serialize repository write").WithCause(err)
	}
	if !repoOwnershipUnchanged(fresh, snapshot) {
		return pkgerrors.Conflict("repository ownership changed concurrently")
	}

	return write()
}

// guardedRepoWrite runs write under g's shared ownership fence when g is
// non-nil, otherwise directly (unit tests without a pool).
func guardedRepoWrite(ctx context.Context, g RepoOwnershipGuard, repository db.Repository, write func() error) error {
	if g == nil {
		return write()
	}
	return g.WithRepoOwnershipShared(ctx, repository, write)
}

// RepoPermQuerier is the minimal DB interface required for repository permission
// resolution. All per-service querier interfaces must embed or satisfy this set.
type RepoPermQuerier interface {
	IsOrgOwnerForRepoUser(ctx context.Context, arg db.IsOrgOwnerForRepoUserParams) (bool, error)
	GetHighestTeamPermissionForRepoUser(ctx context.Context, arg db.GetHighestTeamPermissionForRepoUserParams) (string, error)
	GetCollaboratorPermissionForRepoUser(ctx context.Context, arg db.GetCollaboratorPermissionForRepoUserParams) (string, error)
}

// repoPermissionForUser resolves the effective permission string and whether the
// user is the repository owner.  It is the single canonical implementation used
// by every service — replacing the ~16 per-service copies that previously existed.
//
// Return contract:
//   - isOwner=true  → the caller should treat the user as having full access.
//   - permission    → highest of team + collaborator permissions ("read"/"write"/"admin").
//   - err           → non-nil only on DB failures (wrapped as pkgerrors.Internal).
func repoPermissionForUser(ctx context.Context, q RepoPermQuerier, repository db.Repository, userID int64) (permission string, isOwner bool, err error) {
	if repository.UserID.Valid && repository.UserID.Int64 == userID {
		return "", true, nil
	}

	teamPermission := ""
	if repository.OrgID.Valid {
		orgOwner, err := q.IsOrgOwnerForRepoUser(ctx, db.IsOrgOwnerForRepoUserParams{
			RepositoryID: repository.ID,
			UserID:       userID,
		})
		if err != nil {
			return "", false, pkgerrors.Internal("failed to resolve repository permissions").WithCause(err)
		}
		if orgOwner {
			return "", true, nil
		}

		teamPermission, err = q.GetHighestTeamPermissionForRepoUser(ctx, db.GetHighestTeamPermissionForRepoUserParams{
			RepositoryID: repository.ID,
			UserID:       userID,
		})
		if err != nil {
			return "", false, pkgerrors.Internal("failed to resolve repository permissions").WithCause(err)
		}
	}

	collabPermission, err := q.GetCollaboratorPermissionForRepoUser(ctx, db.GetCollaboratorPermissionForRepoUserParams{
		RepositoryID: repository.ID,
		UserID:       pgtype.Int8{Int64: userID, Valid: true},
	})
	if err != nil {
		return "", false, pkgerrors.Internal("failed to resolve repository permissions").WithCause(err)
	}

	return highestRepoPermission(teamPermission, collabPermission), false, nil
}

// canReadRepo returns true when userID may read repository (public repos are
// always readable, owners and any collaborator/team with at least read access).
func canReadRepo(ctx context.Context, q RepoPermQuerier, repository db.Repository, userID int64) (bool, error) {
	if repository.IsPublic {
		return true, nil
	}
	permission, isOwner, err := repoPermissionForUser(ctx, q, repository, userID)
	if err != nil {
		return false, err
	}
	if isOwner {
		return true, nil
	}
	return permission == "read" || permission == "write" || permission == "admin", nil
}

// canWriteRepo returns true when userID may push/modify repository contents.
func canWriteRepo(ctx context.Context, q RepoPermQuerier, repository db.Repository, userID int64) (bool, error) {
	permission, isOwner, err := repoPermissionForUser(ctx, q, repository, userID)
	if err != nil {
		return false, err
	}
	if isOwner {
		return true, nil
	}
	return permission == "write" || permission == "admin", nil
}

// canAdminRepo returns true when userID has admin or owner access to the
// repository. A request that authenticated as userID with a system-issued
// credential never has it (middleware.capCredentialPermission).
func canAdminRepo(ctx context.Context, q RepoPermQuerier, repository db.Repository, userID int64) (bool, error) {
	if actsThroughRunCredential(ctx, userID) {
		return false, nil
	}
	return canLandRepo(ctx, q, repository, userID)
}

// canLandRepo returns true when userID may land into the repository's
// bookmarks: admin or owner access, whatever credential the request used.
// Landing is how an agent's work reaches a bookmark (the coding flow lands
// with its run credential); protected-bookmark policy applies inside the
// landing, and a landing records no push, so its runs never save caches.
func canLandRepo(ctx context.Context, q RepoPermQuerier, repository db.Repository, userID int64) (bool, error) {
	permission, isOwner, err := repoPermissionForUser(ctx, q, repository, userID)
	if err != nil {
		return false, err
	}
	if isOwner {
		return true, nil
	}
	return permission == "admin", nil
}

// canOwnRepo returns true only when userID is the direct owner of the repository.
func canOwnRepo(ctx context.Context, q RepoPermQuerier, repository db.Repository, userID int64) (bool, error) {
	if actsThroughRunCredential(ctx, userID) {
		return false, nil
	}
	_, isOwner, err := repoPermissionForUser(ctx, q, repository, userID)
	if err != nil {
		return false, err
	}
	return isOwner, nil
}

// actsThroughRunCredential reports whether an agent makes the request as
// userID: a system-issued credential, or an agent account's own
// (middleware.AuthInfo.IsAgent).
func actsThroughRunCredential(ctx context.Context, userID int64) bool {
	info := middleware.AuthInfoFromContext(ctx)
	return info.IsAgent() && info.User != nil && info.User.ID == userID
}

// CanAdminRepo reports whether userID has admin or owner access to repository.
// It is the exported entry point to the canonical permission logic for callers
// outside the services package (e.g. the push hook gating config-sync on the
// pusher's permission before applying admin-only repo settings).
func CanAdminRepo(ctx context.Context, q RepoPermQuerier, repository db.Repository, userID int64) (bool, error) {
	return canAdminRepo(ctx, q, repository, userID)
}

// normalizeRepoPermission lower-cases and trims a permission string.
func normalizeRepoPermission(permission string) string {
	return strings.ToLower(strings.TrimSpace(permission))
}

func repoPermissionRank(permission string) int {
	switch normalizeRepoPermission(permission) {
	case "admin":
		return 3
	case "write":
		return 2
	case "read":
		return 1
	default:
		return 0
	}
}

func highestRepoPermission(permissions ...string) string {
	best := ""
	for _, permission := range permissions {
		if repoPermissionRank(permission) > repoPermissionRank(best) {
			best = normalizeRepoPermission(permission)
		}
	}
	return best
}
