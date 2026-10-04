// Package identity contains product-neutral identity boundaries shared by
// HTTP, Git, SSE, and SSH transports.
package identity

import (
	"context"
	"encoding/json"
	"errors"
	"sync/atomic"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// OwnerQuerier resolves the immutable owner of a single-owner installation.
type setupScopeKey struct{}

// WithSetupScope is set only by the HTTP boundary for install setup routes.
func WithSetupScope(ctx context.Context) context.Context {
	return context.WithValue(ctx, setupScopeKey{}, true)
}

type OwnerQuerier interface {
	GetSelfHostOwner(context.Context) (db.User, error)
}

// MemberAuthorizer is the common identity check used by every authenticated
// transport. Resource-scoped credentials such as deploy keys are checked by
// their own owner-authorized minting paths and do not implement this interface.
type MemberAuthorizer interface {
	AuthorizeMember(context.Context, int64) *pkgerrors.APIError
}

// MemberBoundary authorizes exactly the persisted installation owner.
// A successful lookup is cached: the singleton row cannot be reassigned, while
// an uninitialized installation remains observable until bootstrap succeeds.
type MemberBoundary struct {
	queries OwnerQuerier
	ownerID atomic.Int64
}

func NewMemberBoundary(queries OwnerQuerier) *MemberBoundary {
	return &MemberBoundary{queries: queries}
}

func (b *MemberBoundary) AuthorizeMember(ctx context.Context, userID int64) *pkgerrors.APIError {
	if b == nil || b.queries == nil {
		return pkgerrors.Internal("single-owner authorization is not configured")
	}
	ownerID := b.ownerID.Load()
	if ownerID == 0 {
		owner, err := b.queries.GetSelfHostOwner(ctx)
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return pkgerrors.Unauthorized("installation owner is not initialized")
			}
			return pkgerrors.Internal("failed to authorize installation owner").WithCause(err)
		}
		ownerID = owner.ID
		if ownerID <= 0 {
			return pkgerrors.Internal("installation owner is invalid")
		}
		b.ownerID.CompareAndSwap(0, ownerID)
		ownerID = b.ownerID.Load()
	}
	if ownerID != userID {
		return pkgerrors.Forbidden("credential does not belong to the installation owner")
	}
	if q, ok := b.queries.(interface {
		GetInstallSetting(context.Context, string) (db.InstallSetting, error)
	}); ok {
		if allowed, _ := ctx.Value(setupScopeKey{}).(bool); !allowed {
			setting, err := q.GetInstallSetting(ctx, "owner.access")
			var access struct {
				LastAccessCheckAt string `json:"last_access_check_at"`
				OwnerLogin        string `json:"owner_login"`
				RepositoryName    string `json:"repository_name"`
				RepositoryID      int64  `json:"repository_id"`
			}
			if err != nil || json.Unmarshal(setting.Value, &access) != nil || access.LastAccessCheckAt == "" {
				return pkgerrors.New(pkgerrors.CodeOwnerUnverified, "owner_unverified")
			}
			if _, err := time.Parse(time.RFC3339Nano, access.LastAccessCheckAt); err != nil {
				return pkgerrors.New(pkgerrors.CodeOwnerUnverified, "owner_unverified")
			}
			binding, err := q.GetInstallSetting(ctx, "github.repository")
			var repo struct {
				OwnerLogin     string `json:"owner_login"`
				RepositoryName string `json:"repository_name"`
				RepositoryID   int64  `json:"repository_id"`
			}
			if err != nil || json.Unmarshal(binding.Value, &repo) != nil || repo.OwnerLogin != access.OwnerLogin || repo.RepositoryName != access.RepositoryName || repo.RepositoryID != access.RepositoryID {
				return pkgerrors.New(pkgerrors.CodeOwnerUnverified, "owner_unverified")
			}

		}
	}
	return nil
}
