package services

import (
	"context"
	"errors"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// orgLookupFake is the two-lookup surface older fakes already implement.
type orgLookupFake interface {
	GetOrgByLowerName(ctx context.Context, lowerName string) (db.Organization, error)
	GetOrgMember(ctx context.Context, arg db.GetOrgMemberParams) (db.OrgMember, error)
}

// visibleOrgFromLookups answers GetVisibleOrgForViewer from a fake's own org
// and membership lookups with the SQL statement's semantics: no row for a
// missing organization or a private one the viewer does not belong to, and a
// membership row always carries a role. Fakes keep their existing fixtures.
func visibleOrgFromLookups(ctx context.Context, q orgLookupFake, arg db.GetVisibleOrgForViewerParams) (db.GetVisibleOrgForViewerRow, error) {
	org, err := q.GetOrgByLowerName(ctx, arg.LowerName)
	if err != nil {
		return db.GetVisibleOrgForViewerRow{}, err
	}
	role := ""
	if arg.ViewerID != 0 {
		member, err := q.GetOrgMember(ctx, db.GetOrgMemberParams{OrganizationID: org.ID, UserID: arg.ViewerID})
		switch {
		case err == nil:
			role = member.Role
			if strings.TrimSpace(role) == "" {
				role = "member"
			}
		case !errors.Is(err, pgx.ErrNoRows):
			return db.GetVisibleOrgForViewerRow{}, err
		}
	}
	if org.Visibility == "private" && role == "" {
		return db.GetVisibleOrgForViewerRow{}, pgx.ErrNoRows
	}
	return db.GetVisibleOrgForViewerRow{Organization: org, ViewerRole: role}, nil
}

func (q *benchRepoQuerier) GetVisibleOrgForViewer(ctx context.Context, arg db.GetVisibleOrgForViewerParams) (db.GetVisibleOrgForViewerRow, error) {
	return visibleOrgFromLookups(ctx, q, arg)
}

func (q *billingAgentTxQuerierStub) GetVisibleOrgForViewer(ctx context.Context, arg db.GetVisibleOrgForViewerParams) (db.GetVisibleOrgForViewerRow, error) {
	return visibleOrgFromLookups(ctx, q, arg)
}

func (q *billingCommittedTxQuerier) GetVisibleOrgForViewer(ctx context.Context, arg db.GetVisibleOrgForViewerParams) (db.GetVisibleOrgForViewerRow, error) {
	return visibleOrgFromLookups(ctx, q, arg)
}

func (q *billingCovQuerier) GetVisibleOrgForViewer(ctx context.Context, arg db.GetVisibleOrgForViewerParams) (db.GetVisibleOrgForViewerRow, error) {
	return visibleOrgFromLookups(ctx, q, arg)
}

func (q *billingHQuerier) GetVisibleOrgForViewer(ctx context.Context, arg db.GetVisibleOrgForViewerParams) (db.GetVisibleOrgForViewerRow, error) {
	return visibleOrgFromLookups(ctx, q, arg)
}

func (q *billingQuerierMock) GetVisibleOrgForViewer(ctx context.Context, arg db.GetVisibleOrgForViewerParams) (db.GetVisibleOrgForViewerRow, error) {
	return visibleOrgFromLookups(ctx, q, arg)
}

func (q *canonicalRepoQuerier) GetVisibleOrgForViewer(ctx context.Context, arg db.GetVisibleOrgForViewerParams) (db.GetVisibleOrgForViewerRow, error) {
	return visibleOrgFromLookups(ctx, q, arg)
}

func (q *changesetFinalizeFailure) GetVisibleOrgForViewer(ctx context.Context, arg db.GetVisibleOrgForViewerParams) (db.GetVisibleOrgForViewerRow, error) {
	return visibleOrgFromLookups(ctx, q, arg)
}

func (q *fakeChangesetQueries) GetVisibleOrgForViewer(ctx context.Context, arg db.GetVisibleOrgForViewerParams) (db.GetVisibleOrgForViewerRow, error) {
	return visibleOrgFromLookups(ctx, q, arg)
}

func (q *fakeProviderConnectionQuerier) GetVisibleOrgForViewer(ctx context.Context, arg db.GetVisibleOrgForViewerParams) (db.GetVisibleOrgForViewerRow, error) {
	return visibleOrgFromLookups(ctx, q, arg)
}

func (q *forkOwnerNamingQuerier) GetVisibleOrgForViewer(ctx context.Context, arg db.GetVisibleOrgForViewerParams) (db.GetVisibleOrgForViewerRow, error) {
	return visibleOrgFromLookups(ctx, q, arg)
}

func (q *mockOrgQuerier) GetVisibleOrgForViewer(ctx context.Context, arg db.GetVisibleOrgForViewerParams) (db.GetVisibleOrgForViewerRow, error) {
	return visibleOrgFromLookups(ctx, q, arg)
}

func (q *mockRepoQuerier) GetVisibleOrgForViewer(ctx context.Context, arg db.GetVisibleOrgForViewerParams) (db.GetVisibleOrgForViewerRow, error) {
	return visibleOrgFromLookups(ctx, q, arg)
}

func (q *mockSecretQuerier) GetVisibleOrgForViewer(ctx context.Context, arg db.GetVisibleOrgForViewerParams) (db.GetVisibleOrgForViewerRow, error) {
	return visibleOrgFromLookups(ctx, q, arg)
}

func (q *mockVariableQuerier) GetVisibleOrgForViewer(ctx context.Context, arg db.GetVisibleOrgForViewerParams) (db.GetVisibleOrgForViewerRow, error) {
	return visibleOrgFromLookups(ctx, q, arg)
}

func (q *offsetChangesetQueries) GetVisibleOrgForViewer(ctx context.Context, arg db.GetVisibleOrgForViewerParams) (db.GetVisibleOrgForViewerRow, error) {
	return visibleOrgFromLookups(ctx, q, arg)
}

func (q *orgWorkspaceRevocationQuerier) GetVisibleOrgForViewer(ctx context.Context, arg db.GetVisibleOrgForViewerParams) (db.GetVisibleOrgForViewerRow, error) {
	return visibleOrgFromLookups(ctx, q, arg)
}

func (q *querierWithActiveSub) GetVisibleOrgForViewer(ctx context.Context, arg db.GetVisibleOrgForViewerParams) (db.GetVisibleOrgForViewerRow, error) {
	return visibleOrgFromLookups(ctx, q, arg)
}

func (q *repoZQuerier) GetVisibleOrgForViewer(ctx context.Context, arg db.GetVisibleOrgForViewerParams) (db.GetVisibleOrgForViewerRow, error) {
	return visibleOrgFromLookups(ctx, q, arg)
}

func (q *rolloutRepoQuerier) GetVisibleOrgForViewer(ctx context.Context, arg db.GetVisibleOrgForViewerParams) (db.GetVisibleOrgForViewerRow, error) {
	return visibleOrgFromLookups(ctx, q, arg)
}

func (q *secretCovQuerier) GetVisibleOrgForViewer(ctx context.Context, arg db.GetVisibleOrgForViewerParams) (db.GetVisibleOrgForViewerRow, error) {
	return visibleOrgFromLookups(ctx, q, arg)
}

func (q *teamRevocationQuerier) GetVisibleOrgForViewer(ctx context.Context, arg db.GetVisibleOrgForViewerParams) (db.GetVisibleOrgForViewerRow, error) {
	return visibleOrgFromLookups(ctx, q, arg)
}

func (q *variableCovQuerier) GetVisibleOrgForViewer(ctx context.Context, arg db.GetVisibleOrgForViewerParams) (db.GetVisibleOrgForViewerRow, error) {
	return visibleOrgFromLookups(ctx, q, arg)
}

func (q *variableHQuerier) GetVisibleOrgForViewer(ctx context.Context, arg db.GetVisibleOrgForViewerParams) (db.GetVisibleOrgForViewerRow, error) {
	return visibleOrgFromLookups(ctx, q, arg)
}

func (q staleCounterQuerier) GetVisibleOrgForViewer(ctx context.Context, arg db.GetVisibleOrgForViewerParams) (db.GetVisibleOrgForViewerRow, error) {
	return visibleOrgFromLookups(ctx, q, arg)
}
