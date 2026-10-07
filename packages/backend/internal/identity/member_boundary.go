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

type setupScopeKey struct{}

// WithSetupScope is set only by the HTTP boundary for install setup routes.
func WithSetupScope(ctx context.Context) context.Context {
	return context.WithValue(ctx, setupScopeKey{}, true)
}

type memberRouteKey struct{}

// WithMemberRoute is set only by the HTTP boundary for a route a roster
// member may call; without it the boundary admits the owner alone.
func WithMemberRoute(ctx context.Context) context.Context {
	return context.WithValue(ctx, memberRouteKey{}, true)
}

// ownerLookup resolves the immutable owner of a single-owner installation.
type ownerLookup interface {
	GetSelfHostOwner(context.Context) (db.User, error)
}

// OwnerQuerier resolves the installation owner and reads the install
// settings that verify the owner's GitHub access (spec §5.1.0). Requiring
// both at construction means no adapter can skip owner verification by
// lacking the settings read.
type OwnerQuerier interface {
	ownerLookup
	GetInstallSetting(context.Context, string) (db.InstallSetting, error)
}

// MemberAuthorizer is the common identity check used by every authenticated
// transport. Resource-scoped credentials such as deploy keys are checked by
// their own owner-authorized minting paths and do not implement this interface.
type MemberAuthorizer interface {
	AuthorizeMember(context.Context, int64) *pkgerrors.APIError
}

// MemberBoundary authorizes the persisted installation owner, and active
// roster members on member routes (WithMemberRoute).
// A successful lookup is cached: the singleton row cannot be reassigned, while
// an uninitialized installation remains observable until bootstrap succeeds.
type MemberBoundary struct {
	queries ownerLookup
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
		// A roster member reaches only the routes the HTTP boundary maps to
		// a member command; each route still authorizes its command by role.
		q, ok := b.queries.(interface {
			InstallationMemberPermission(context.Context, int64) (string, error)
		})
		if allowed, _ := ctx.Value(memberRouteKey{}).(bool); !allowed || !ok {
			return pkgerrors.Forbidden("credential does not belong to the installation owner")
		}
		permission, err := q.InstallationMemberPermission(ctx, userID)
		if errors.Is(err, pgx.ErrNoRows) || err == nil && permission != "write" && permission != "admin" {
			// An absent or suspended member's stored credential is dead before
			// command policy, even before physical token revocation finishes.
			return pkgerrors.New(pkgerrors.CodeUnauthenticated, "Sign in again")
		}
		if err != nil {
			return pkgerrors.Internal("failed to authorize member").WithCause(err)
		}
		return nil
	}
	// Setup routes run before the owner's access is verified. Every other
	// owner request needs the verified settings; a querier that cannot read
	// them fails closed, never open (§5.1.0).
	if allowed, _ := ctx.Value(setupScopeKey{}).(bool); !allowed {
		q, ok := b.queries.(OwnerQuerier)
		if !ok {
			return pkgerrors.New(pkgerrors.CodeOwnerUnverified, "owner_unverified")
		}
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
		repo, err := db.ReadInstallRepositoryBinding(ctx, q)
		if err != nil || repo.Owner != access.OwnerLogin || repo.Name != access.RepositoryName || repo.ID != access.RepositoryID {
			return pkgerrors.New(pkgerrors.CodeOwnerUnverified, "owner_unverified")
		}
	}
	return nil
}
