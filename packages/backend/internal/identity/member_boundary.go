// Package identity contains product-neutral identity boundaries shared by
// HTTP, Git, SSE, and SSH transports.
package identity

import (
	"context"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// MemberQuerier answers whether a user is on the install's roster.
type MemberQuerier interface {
	AuthorizeMemberUser(ctx context.Context, userID int64) (bool, error)
}

// MemberAuthorizer is the common identity check used by every authenticated
// transport on the install. Resource-scoped credentials such as deploy keys
// are checked by their own member-authorized minting paths and do not
// implement this interface.
type MemberAuthorizer interface {
	AuthorizeMember(ctx context.Context, userID int64) *pkgerrors.APIError
}

// MemberBoundary authorizes a credential only while its user is a member of
// the install: on the roster, not removed and not suspended. It reads the
// roster on every check, so a removal takes effect on the next request.
type MemberBoundary struct {
	queries MemberQuerier
}

func NewMemberBoundary(queries MemberQuerier) *MemberBoundary {
	return &MemberBoundary{queries: queries}
}

func (b *MemberBoundary) AuthorizeMember(ctx context.Context, userID int64) *pkgerrors.APIError {
	if b == nil || b.queries == nil {
		return pkgerrors.Internal("member authorization is not configured")
	}
	member, err := b.queries.AuthorizeMemberUser(ctx, userID)
	if err != nil {
		return pkgerrors.Internal("failed to authorize member").WithCause(err)
	}
	if !member {
		return pkgerrors.New(pkgerrors.CodeNotAMember, "not a member of this install")
	}
	return nil
}
