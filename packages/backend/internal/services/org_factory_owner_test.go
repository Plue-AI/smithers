package services

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

func TestOrgService_UpdateOrgFactoryOwner(t *testing.T) {
	ownerID := int64(22)
	clearID := int64(0)
	for _, tc := range []struct {
		name        string
		current     pgtype.Int8
		request     *int64
		want        pgtype.Int8
		wantSet     bool
		targetCheck bool
	}{
		{name: "omitted preserves configured owner", current: pgtype.Int8{Int64: 10, Valid: true}, want: pgtype.Int8{Int64: 10, Valid: true}},
		{name: "sets another organization owner", request: &ownerID, want: pgtype.Int8{Int64: 22, Valid: true}, wantSet: true, targetCheck: true},
		{name: "clears configured owner", current: pgtype.Int8{Int64: 10, Valid: true}, request: &clearID, wantSet: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			memberLookups := 0
			writes := 0
			q := &mockOrgQuerier{
				getOrgByLowerNameFn: func(context.Context, string) (db.Organization, error) {
					org := testOrg("public")
					org.FactoryOwnerID = tc.current
					return org, nil
				},
				getOrgMemberFn: func(_ context.Context, arg db.GetOrgMemberParams) (db.OrgMember, error) {
					memberLookups++
					require.Equal(t, int64(7), arg.OrganizationID)
					if arg.UserID == 22 {
						return db.OrgMember{OrganizationID: 7, UserID: 22, Role: "owner"}, nil
					}
					require.Equal(t, int64(1), arg.UserID)
					return db.OrgMember{OrganizationID: 7, UserID: 1, Role: "owner"}, nil
				},
				updateOrganizationFn: func(_ context.Context, arg db.UpdateOrganizationParams) (db.Organization, error) {
					writes++
					require.Equal(t, tc.wantSet, arg.SetFactoryOwner)
					if tc.wantSet {
						require.Equal(t, tc.want, arg.FactoryOwnerID)
					} else {
						require.Equal(t, pgtype.Int8{}, arg.FactoryOwnerID)
					}
					org := testOrg("public")
					org.FactoryOwnerID = tc.want
					return org, nil
				},
			}
			updated, err := NewOrgService(q).UpdateOrg(context.Background(), testOrgUser(1, "owner"), "acme", UpdateOrgRequest{FactoryOwnerID: tc.request})
			require.NoError(t, err)
			require.Equal(t, tc.want, updated.FactoryOwnerID)
			require.Equal(t, 1, writes)
			if tc.targetCheck {
				require.Equal(t, 2, memberLookups)
			} else {
				require.Equal(t, 1, memberLookups)
			}
		})
	}
}

func TestOrgService_UpdateOrgFactoryOwnerRejectsInvalidSelection(t *testing.T) {
	memberID := int64(23)
	missingID := int64(24)
	negativeID := int64(-1)
	for _, tc := range []struct {
		name   string
		target int64
		role   string
		found  bool
		status int
	}{
		{name: "member is not an owner", target: memberID, role: "member", found: true, status: 422},
		{name: "unknown user is not an owner", target: missingID, status: 422},
		{name: "negative user ID", target: negativeID, status: 422},
	} {
		t.Run(tc.name, func(t *testing.T) {
			q := &mockOrgQuerier{
				getOrgByLowerNameFn: func(context.Context, string) (db.Organization, error) { return testOrg("public"), nil },
				getOrgMemberFn: func(_ context.Context, arg db.GetOrgMemberParams) (db.OrgMember, error) {
					if arg.UserID == 1 {
						return db.OrgMember{OrganizationID: 7, UserID: 1, Role: "owner"}, nil
					}
					require.Equal(t, tc.target, arg.UserID)
					if tc.found {
						return db.OrgMember{OrganizationID: 7, UserID: tc.target, Role: tc.role}, nil
					}
					return db.OrgMember{}, pgx.ErrNoRows
				},
				updateOrganizationFn: func(context.Context, db.UpdateOrganizationParams) (db.Organization, error) {
					t.Fatal("invalid factory owner reached database write")
					return db.Organization{}, nil
				},
			}
			_, err := NewOrgService(q).UpdateOrg(context.Background(), testOrgUser(1, "owner"), "acme", UpdateOrgRequest{FactoryOwnerID: &tc.target})
			requireAPIErrorStatus(t, err, tc.status)
		})
	}
}

func TestOrgService_UpdateOrgFactoryOwnerRequiresActorOwner(t *testing.T) {
	target := int64(1)
	q := &mockOrgQuerier{
		getOrgByLowerNameFn: func(context.Context, string) (db.Organization, error) { return testOrg("public"), nil },
		getOrgMemberFn: func(_ context.Context, arg db.GetOrgMemberParams) (db.OrgMember, error) {
			require.Equal(t, int64(2), arg.UserID)
			return db.OrgMember{OrganizationID: 7, UserID: 2, Role: "member"}, nil
		},
		updateOrganizationFn: func(context.Context, db.UpdateOrganizationParams) (db.Organization, error) {
			t.Fatal("non-owner reached database write")
			return db.Organization{}, nil
		},
	}
	_, err := NewOrgService(q).UpdateOrg(context.Background(), testOrgUser(2, "member"), "acme", UpdateOrgRequest{FactoryOwnerID: &target})
	requireAPIErrorStatus(t, err, 403)
}
