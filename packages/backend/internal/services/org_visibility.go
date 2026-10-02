package services

import (
	"context"
	stdErrors "errors"
	"slices"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// Organization visibility is decided here and nowhere else (plue#542). Every
// organization-scoped path, read or write, resolves the organization with
// resolveOrgForViewer before agent restrictions, input validation, or any side
// effect. One statement returns the organization and the caller's membership,
// and returns no row for a private organization the caller does not belong
// to, so "hidden" and "absent" cost the same round trip, fail the same way,
// and answer with the same status, code, and body. Callers apply their own
// role requirement afterward, so their 403s reach only callers who may
// already know the organization exists. Public and limited organizations are
// discoverable by name.

// orgVisibilityQuerier is the statement every organization-scoped service
// resolves organizations with.
type orgVisibilityQuerier interface {
	GetVisibleOrgForViewer(ctx context.Context, arg db.GetVisibleOrgForViewerParams) (db.GetVisibleOrgForViewerRow, error)
}

// orgNotFound is the one answer for a missing organization and for a private
// organization the caller may not see.
func orgNotFound() *pkgerrors.APIError {
	return pkgerrors.NotFound("organization not found")
}

func normalizeOrgName(orgName string) (string, error) {
	lowerName := strings.ToLower(strings.TrimSpace(orgName))
	if lowerName == "" {
		return "", pkgerrors.BadRequest("organization name is required")
	}
	return lowerName, nil
}

// lookupOrgByName loads an organization without deciding visibility. Only a
// site administrator's access, which does not come from membership, uses it.
func lookupOrgByName(ctx context.Context, q interface {
	GetOrgByLowerName(ctx context.Context, lowerName string) (db.Organization, error)
}, orgName string) (db.Organization, error) {
	lowerName, err := normalizeOrgName(orgName)
	if err != nil {
		return db.Organization{}, err
	}
	org, err := q.GetOrgByLowerName(ctx, lowerName)
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return db.Organization{}, orgNotFound()
		}
		return db.Organization{}, pkgerrors.Internal("failed to load organization").WithCause(err)
	}
	return org, nil
}

// orgMembership is a caller's standing in one organization.
type orgMembership struct {
	Member bool   // false for anonymous callers and non-members
	Role   string // "owner" or "member" when Member
}

// hasRole reports membership in one of roles, or any membership when roles
// is empty.
func (m orgMembership) hasRole(roles ...string) bool {
	return m.Member && (len(roles) == 0 || slices.Contains(roles, m.Role))
}

// resolveOrgForViewer loads orgName as viewer may see it, in one statement.
func resolveOrgForViewer(ctx context.Context, q orgVisibilityQuerier, viewer *db.User, orgName string) (db.Organization, orgMembership, error) {
	lowerName, err := normalizeOrgName(orgName)
	if err != nil {
		return db.Organization{}, orgMembership{}, err
	}
	var viewerID int64
	if viewer != nil {
		viewerID = viewer.ID
	}
	row, err := q.GetVisibleOrgForViewer(ctx, db.GetVisibleOrgForViewerParams{ViewerID: viewerID, LowerName: lowerName})
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return db.Organization{}, orgMembership{}, orgNotFound()
		}
		return db.Organization{}, orgMembership{}, pkgerrors.Internal("failed to load organization").WithCause(err)
	}
	role := strings.ToLower(strings.TrimSpace(row.ViewerRole))
	return row.Organization, orgMembership{Member: role != "", Role: role}, nil
}
