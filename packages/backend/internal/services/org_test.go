package services

import (
	"context"
	stdErrors "errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/webhooks"
)

type orgDispatchCall struct {
	repoID    int64
	orgID     int64
	eventType webhooks.EventType
	payload   any
}

type mockOrgDispatcher struct {
	dispatchFn    func(ctx context.Context, repoID int64, eventType webhooks.EventType, payload any) error
	dispatchOrgFn func(ctx context.Context, orgID int64, eventType webhooks.EventType, payload any) error
	calls         []orgDispatchCall
}

func (m *mockOrgDispatcher) DispatchEvent(ctx context.Context, repoID int64, eventType webhooks.EventType, payload any) error {
	m.calls = append(m.calls, orgDispatchCall{
		repoID:    repoID,
		eventType: eventType,
		payload:   payload,
	})
	if m.dispatchFn != nil {
		return m.dispatchFn(ctx, repoID, eventType, payload)
	}
	return nil
}

func (m *mockOrgDispatcher) DispatchOrgEvent(ctx context.Context, orgID int64, eventType webhooks.EventType, payload any) error {
	m.calls = append(m.calls, orgDispatchCall{
		orgID:     orgID,
		eventType: eventType,
		payload:   payload,
	})
	if m.dispatchOrgFn != nil {
		return m.dispatchOrgFn(ctx, orgID, eventType, payload)
	}
	return nil
}

type mockOrgQuerier struct {
	getOrgByLowerNameFn               func(ctx context.Context, lowerName string) (db.Organization, error)
	createOrganizationFn              func(ctx context.Context, arg db.CreateOrganizationParams) (db.Organization, error)
	addOrgMemberFn                    func(ctx context.Context, arg db.AddOrgMemberParams) (db.OrgMember, error)
	getOrgMemberFn                    func(ctx context.Context, arg db.GetOrgMemberParams) (db.OrgMember, error)
	updateOrganizationFn              func(ctx context.Context, arg db.UpdateOrganizationParams) (db.Organization, error)
	listOrgReposFn                    func(ctx context.Context, arg db.ListOrgReposParams) ([]db.Repository, error)
	countOrgReposFn                   func(ctx context.Context, orgID pgtype.Int8) (int64, error)
	listPublicOrgReposFn              func(ctx context.Context, arg db.ListPublicOrgReposParams) ([]db.Repository, error)
	countPublicOrgReposFn             func(ctx context.Context, orgID pgtype.Int8) (int64, error)
	listOrgMembersFn                  func(ctx context.Context, arg db.ListOrgMembersParams) ([]db.ListOrgMembersRow, error)
	countOrgMembersFn                 func(ctx context.Context, orgID int64) (int64, error)
	listOrgTeamsFn                    func(ctx context.Context, arg db.ListOrgTeamsParams) ([]db.Team, error)
	countOrgTeamsFn                   func(ctx context.Context, orgID int64) (int64, error)
	createTeamFn                      func(ctx context.Context, arg db.CreateTeamParams) (db.Team, error)
	getTeamByOrgAndLowerNameFn        func(ctx context.Context, arg db.GetTeamByOrgAndLowerNameParams) (db.Team, error)
	updateTeamFn                      func(ctx context.Context, arg db.UpdateTeamParams) (db.Team, error)
	deleteTeamFn                      func(ctx context.Context, id int64) error
	listTeamMembersFn                 func(ctx context.Context, arg db.ListTeamMembersParams) ([]db.User, error)
	countTeamMembersFn                func(ctx context.Context, teamID int64) (int64, error)
	addTeamMemberFn                   func(ctx context.Context, arg db.AddTeamMemberParams) (db.TeamMember, error)
	addTeamMemberIfOrgMemberFn        func(ctx context.Context, arg db.AddTeamMemberIfOrgMemberParams) (db.TeamMember, error)
	removeOrgMemberFn                 func(ctx context.Context, arg db.RemoveOrgMemberParams) error
	deleteTeamMembershipsForOrgUserFn func(ctx context.Context, arg db.DeleteTeamMembershipsForOrgUserParams) error
	removeTeamMemberFn                func(ctx context.Context, arg db.RemoveTeamMemberParams) error
	listTeamReposFn                   func(ctx context.Context, arg db.ListTeamReposParams) ([]db.Repository, error)
	countTeamReposFn                  func(ctx context.Context, teamID int64) (int64, error)
	addTeamRepoFn                     func(ctx context.Context, arg db.AddTeamRepoParams) (db.TeamRepo, error)
	addTeamRepoIfOrgRepoFn            func(ctx context.Context, arg db.AddTeamRepoIfOrgRepoParams) (db.TeamRepo, error)
	removeTeamRepoFn                  func(ctx context.Context, arg db.RemoveTeamRepoParams) error
	getUserByLowerUsernameFn          func(ctx context.Context, lowerUsername string) (db.User, error)
	getRepoByOwnerAndLowerNameFn      func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error)
	countOrgOwnersFn                  func(ctx context.Context, organizationID int64) (int64, error)
}

type mockOrgCreateTx struct {
	createOrganizationFn func(ctx context.Context, arg db.CreateOrganizationParams) (db.Organization, error)
	addOrgMemberFn       func(ctx context.Context, arg db.AddOrgMemberParams) (db.OrgMember, error)
	commitFn             func(ctx context.Context) error
	rollbackFn           func(ctx context.Context) error
}

func (m *mockOrgCreateTx) CreateOrganization(ctx context.Context, arg db.CreateOrganizationParams) (db.Organization, error) {
	if m.createOrganizationFn != nil {
		return m.createOrganizationFn(ctx, arg)
	}
	return db.Organization{}, nil
}

func (m *mockOrgCreateTx) AddOrgMember(ctx context.Context, arg db.AddOrgMemberParams) (db.OrgMember, error) {
	if m.addOrgMemberFn != nil {
		return m.addOrgMemberFn(ctx, arg)
	}
	return db.OrgMember{}, nil
}

func (m *mockOrgCreateTx) Commit(ctx context.Context) error {
	if m.commitFn != nil {
		return m.commitFn(ctx)
	}
	return nil
}

func (m *mockOrgCreateTx) Rollback(ctx context.Context) error {
	if m.rollbackFn != nil {
		return m.rollbackFn(ctx)
	}
	return nil
}

type mockOrgMemberRemovalTx struct {
	lockOrganizationFn                func(ctx context.Context, id int64) (int64, error)
	getOrgMemberForUpdateFn           func(ctx context.Context, arg db.GetOrgMemberForUpdateParams) (db.OrgMember, error)
	countOrgOwnersFn                  func(ctx context.Context, organizationID int64) (int64, error)
	deleteTeamMembershipsForOrgUserFn func(ctx context.Context, arg db.DeleteTeamMembershipsForOrgUserParams) error
	removeOrgMemberFn                 func(ctx context.Context, arg db.RemoveOrgMemberParams) error
	commitFn                          func(ctx context.Context) error
	rollbackFn                        func(ctx context.Context) error
}

func (m *mockOrgMemberRemovalTx) LockOrganization(ctx context.Context, id int64) (int64, error) {
	if m.lockOrganizationFn != nil {
		return m.lockOrganizationFn(ctx, id)
	}
	return id, nil
}

func (m *mockOrgMemberRemovalTx) GetOrgMemberForUpdate(ctx context.Context, arg db.GetOrgMemberForUpdateParams) (db.OrgMember, error) {
	if m.getOrgMemberForUpdateFn != nil {
		return m.getOrgMemberForUpdateFn(ctx, arg)
	}
	return db.OrgMember{}, pgx.ErrNoRows
}

func (m *mockOrgMemberRemovalTx) CountOrgOwners(ctx context.Context, organizationID int64) (int64, error) {
	if m.countOrgOwnersFn != nil {
		return m.countOrgOwnersFn(ctx, organizationID)
	}
	return 0, nil
}

func (m *mockOrgMemberRemovalTx) DeleteTeamMembershipsForOrgUser(ctx context.Context, arg db.DeleteTeamMembershipsForOrgUserParams) error {
	if m.deleteTeamMembershipsForOrgUserFn != nil {
		return m.deleteTeamMembershipsForOrgUserFn(ctx, arg)
	}
	return nil
}

func (m *mockOrgMemberRemovalTx) RemoveOrgMember(ctx context.Context, arg db.RemoveOrgMemberParams) error {
	if m.removeOrgMemberFn != nil {
		return m.removeOrgMemberFn(ctx, arg)
	}
	return nil
}

func (m *mockOrgMemberRemovalTx) Commit(ctx context.Context) error {
	if m.commitFn != nil {
		return m.commitFn(ctx)
	}
	return nil
}

func (m *mockOrgMemberRemovalTx) Rollback(ctx context.Context) error {
	if m.rollbackFn != nil {
		return m.rollbackFn(ctx)
	}
	return nil
}

type mockOrgCreateTxManager struct {
	beginCreateTxFn        func(ctx context.Context) (orgCreateTx, error)
	beginMemberRemovalTxFn func(ctx context.Context) (orgMemberRemovalTx, error)
}

func (m *mockOrgCreateTxManager) BeginCreateTx(ctx context.Context) (orgCreateTx, error) {
	if m.beginCreateTxFn != nil {
		return m.beginCreateTxFn(ctx)
	}
	return nil, nil
}

func (m *mockOrgCreateTxManager) BeginMemberRemovalTx(ctx context.Context) (orgMemberRemovalTx, error) {
	if m.beginMemberRemovalTxFn != nil {
		return m.beginMemberRemovalTxFn(ctx)
	}
	return &mockOrgMemberRemovalTx{}, nil
}

func (m *mockOrgQuerier) GetOrgByLowerName(ctx context.Context, lowerName string) (db.Organization, error) {
	if m.getOrgByLowerNameFn != nil {
		return m.getOrgByLowerNameFn(ctx, lowerName)
	}
	return db.Organization{}, pgx.ErrNoRows
}

func (m *mockOrgQuerier) CreateOrganization(ctx context.Context, arg db.CreateOrganizationParams) (db.Organization, error) {
	if m.createOrganizationFn != nil {
		return m.createOrganizationFn(ctx, arg)
	}
	return db.Organization{}, nil
}

func (m *mockOrgQuerier) AddOrgMember(ctx context.Context, arg db.AddOrgMemberParams) (db.OrgMember, error) {
	if m.addOrgMemberFn != nil {
		return m.addOrgMemberFn(ctx, arg)
	}
	return db.OrgMember{}, nil
}

func (m *mockOrgQuerier) GetOrgMember(ctx context.Context, arg db.GetOrgMemberParams) (db.OrgMember, error) {
	if m.getOrgMemberFn != nil {
		return m.getOrgMemberFn(ctx, arg)
	}
	return db.OrgMember{}, pgx.ErrNoRows
}

func (m *mockOrgQuerier) UpdateOrganization(ctx context.Context, arg db.UpdateOrganizationParams) (db.Organization, error) {
	if m.updateOrganizationFn != nil {
		return m.updateOrganizationFn(ctx, arg)
	}
	return db.Organization{}, nil
}

func (m *mockOrgQuerier) ListOrgRepos(ctx context.Context, arg db.ListOrgReposParams) ([]db.Repository, error) {
	if m.listOrgReposFn != nil {
		return m.listOrgReposFn(ctx, arg)
	}
	return nil, nil
}

func (m *mockOrgQuerier) CountOrgRepos(ctx context.Context, orgID pgtype.Int8) (int64, error) {
	if m.countOrgReposFn != nil {
		return m.countOrgReposFn(ctx, orgID)
	}
	return 0, nil
}

func (m *mockOrgQuerier) ListPublicOrgRepos(ctx context.Context, arg db.ListPublicOrgReposParams) ([]db.Repository, error) {
	if m.listPublicOrgReposFn != nil {
		return m.listPublicOrgReposFn(ctx, arg)
	}
	return nil, nil
}

func (m *mockOrgQuerier) CountPublicOrgRepos(ctx context.Context, orgID pgtype.Int8) (int64, error) {
	if m.countPublicOrgReposFn != nil {
		return m.countPublicOrgReposFn(ctx, orgID)
	}
	return 0, nil
}

func (m *mockOrgQuerier) ListOrgMembers(ctx context.Context, arg db.ListOrgMembersParams) ([]db.ListOrgMembersRow, error) {
	if m.listOrgMembersFn != nil {
		return m.listOrgMembersFn(ctx, arg)
	}
	return nil, nil
}

func (m *mockOrgQuerier) CountOrgMembers(ctx context.Context, orgID int64) (int64, error) {
	if m.countOrgMembersFn != nil {
		return m.countOrgMembersFn(ctx, orgID)
	}
	return 0, nil
}

func (m *mockOrgQuerier) ListOrgTeams(ctx context.Context, arg db.ListOrgTeamsParams) ([]db.Team, error) {
	if m.listOrgTeamsFn != nil {
		return m.listOrgTeamsFn(ctx, arg)
	}
	return nil, nil
}

func (m *mockOrgQuerier) CountOrgTeams(ctx context.Context, orgID int64) (int64, error) {
	if m.countOrgTeamsFn != nil {
		return m.countOrgTeamsFn(ctx, orgID)
	}
	return 0, nil
}

func (m *mockOrgQuerier) CreateTeam(ctx context.Context, arg db.CreateTeamParams) (db.Team, error) {
	if m.createTeamFn != nil {
		return m.createTeamFn(ctx, arg)
	}
	return db.Team{}, nil
}

func (m *mockOrgQuerier) GetTeamByOrgAndLowerName(ctx context.Context, arg db.GetTeamByOrgAndLowerNameParams) (db.Team, error) {
	if m.getTeamByOrgAndLowerNameFn != nil {
		return m.getTeamByOrgAndLowerNameFn(ctx, arg)
	}
	return db.Team{}, pgx.ErrNoRows
}

func (m *mockOrgQuerier) UpdateTeam(ctx context.Context, arg db.UpdateTeamParams) (db.Team, error) {
	if m.updateTeamFn != nil {
		return m.updateTeamFn(ctx, arg)
	}
	return db.Team{}, nil
}

func (m *mockOrgQuerier) DeleteTeam(ctx context.Context, id int64) error {
	if m.deleteTeamFn != nil {
		return m.deleteTeamFn(ctx, id)
	}
	return nil
}

func (m *mockOrgQuerier) ListTeamMembers(ctx context.Context, arg db.ListTeamMembersParams) ([]db.User, error) {
	if m.listTeamMembersFn != nil {
		return m.listTeamMembersFn(ctx, arg)
	}
	return nil, nil
}

func (m *mockOrgQuerier) CountTeamMembers(ctx context.Context, teamID int64) (int64, error) {
	if m.countTeamMembersFn != nil {
		return m.countTeamMembersFn(ctx, teamID)
	}
	return 0, nil
}

func (m *mockOrgQuerier) AddTeamMember(ctx context.Context, arg db.AddTeamMemberParams) (db.TeamMember, error) {
	if m.addTeamMemberFn != nil {
		return m.addTeamMemberFn(ctx, arg)
	}
	return db.TeamMember{}, nil
}

func (m *mockOrgQuerier) AddTeamMemberIfOrgMember(ctx context.Context, arg db.AddTeamMemberIfOrgMemberParams) (db.TeamMember, error) {
	if m.addTeamMemberIfOrgMemberFn != nil {
		return m.addTeamMemberIfOrgMemberFn(ctx, arg)
	}
	return db.TeamMember{}, nil
}

func (m *mockOrgQuerier) RemoveOrgMember(ctx context.Context, arg db.RemoveOrgMemberParams) error {
	if m.removeOrgMemberFn != nil {
		return m.removeOrgMemberFn(ctx, arg)
	}
	return nil
}

func (m *mockOrgQuerier) DeleteTeamMembershipsForOrgUser(ctx context.Context, arg db.DeleteTeamMembershipsForOrgUserParams) error {
	if m.deleteTeamMembershipsForOrgUserFn != nil {
		return m.deleteTeamMembershipsForOrgUserFn(ctx, arg)
	}
	return nil
}

func (m *mockOrgQuerier) RemoveTeamMember(ctx context.Context, arg db.RemoveTeamMemberParams) error {
	if m.removeTeamMemberFn != nil {
		return m.removeTeamMemberFn(ctx, arg)
	}
	return nil
}

func (m *mockOrgQuerier) ListTeamRepos(ctx context.Context, arg db.ListTeamReposParams) ([]db.Repository, error) {
	if m.listTeamReposFn != nil {
		return m.listTeamReposFn(ctx, arg)
	}
	return nil, nil
}

func (m *mockOrgQuerier) CountTeamRepos(ctx context.Context, teamID int64) (int64, error) {
	if m.countTeamReposFn != nil {
		return m.countTeamReposFn(ctx, teamID)
	}
	return 0, nil
}

func (m *mockOrgQuerier) AddTeamRepo(ctx context.Context, arg db.AddTeamRepoParams) (db.TeamRepo, error) {
	if m.addTeamRepoFn != nil {
		return m.addTeamRepoFn(ctx, arg)
	}
	return db.TeamRepo{}, nil
}

func (m *mockOrgQuerier) AddTeamRepoIfOrgRepo(ctx context.Context, arg db.AddTeamRepoIfOrgRepoParams) (db.TeamRepo, error) {
	if m.addTeamRepoIfOrgRepoFn != nil {
		return m.addTeamRepoIfOrgRepoFn(ctx, arg)
	}
	return db.TeamRepo{}, nil
}

func (m *mockOrgQuerier) RemoveTeamRepo(ctx context.Context, arg db.RemoveTeamRepoParams) error {
	if m.removeTeamRepoFn != nil {
		return m.removeTeamRepoFn(ctx, arg)
	}
	return nil
}

func (m *mockOrgQuerier) GetUserByLowerUsername(ctx context.Context, lowerUsername string) (db.User, error) {
	if m.getUserByLowerUsernameFn != nil {
		return m.getUserByLowerUsernameFn(ctx, lowerUsername)
	}
	return db.User{}, pgx.ErrNoRows
}

func (m *mockOrgQuerier) GetRepoByOwnerAndLowerName(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
	if m.getRepoByOwnerAndLowerNameFn != nil {
		return m.getRepoByOwnerAndLowerNameFn(ctx, arg)
	}
	return db.Repository{}, pgx.ErrNoRows
}

func (m *mockOrgQuerier) CountOrgOwners(ctx context.Context, organizationID int64) (int64, error) {
	if m.countOrgOwnersFn != nil {
		return m.countOrgOwnersFn(ctx, organizationID)
	}
	return 0, nil
}

func testOrg(visibility string) db.Organization {
	now := time.Now().UTC()
	return db.Organization{
		ID:          7,
		Name:        "acme",
		LowerName:   "acme",
		Description: "acme-org",
		Visibility:  visibility,
		Website:     "",
		Location:    "",
		CreatedAt:   now,
		UpdatedAt:   now,
	}
}

func testOrgUser(id int64, username string) *db.User {
	return &db.User{ID: id, Username: username, LowerUsername: username}
}

func requireAPIErrorStatus(t *testing.T, err error, status int) {
	t.Helper()
	apiErr, ok := err.(*pkgerrors.APIError)
	require.True(t, ok, "expected APIError, got %T", err)
	assert.Equal(t, status, apiErr.Status)
}

func TestOrgService_GetOrg_PublicOrg_AllowsAnonymous(t *testing.T) {
	t.Parallel()

	s := NewOrgService(&mockOrgQuerier{
		getOrgByLowerNameFn: func(ctx context.Context, lowerName string) (db.Organization, error) {
			assert.Equal(t, "acme", lowerName)
			return testOrg("public"), nil
		},
	})

	org, err := s.GetOrg(context.Background(), nil, "Acme")
	require.NoError(t, err)
	assert.Equal(t, "acme", org.LowerName)
}

func TestOrgService_GetOrg_PrivateOrg_RequiresMembership(t *testing.T) {
	t.Parallel()

	s := NewOrgService(&mockOrgQuerier{
		getOrgByLowerNameFn: func(ctx context.Context, lowerName string) (db.Organization, error) {
			return testOrg("private"), nil
		},
		getOrgMemberFn: func(ctx context.Context, arg db.GetOrgMemberParams) (db.OrgMember, error) {
			return db.OrgMember{}, pgx.ErrNoRows
		},
	})

	_, err := s.GetOrg(context.Background(), testOrgUser(12, "outsider"), "acme")
	requireAPIErrorStatus(t, err, 404)
}

func TestOrgService_UpdateOrg_OwnerOnly(t *testing.T) {
	t.Parallel()

	s := NewOrgService(&mockOrgQuerier{
		getOrgByLowerNameFn: func(ctx context.Context, lowerName string) (db.Organization, error) {
			return testOrg("public"), nil
		},
		getOrgMemberFn: func(ctx context.Context, arg db.GetOrgMemberParams) (db.OrgMember, error) {
			return db.OrgMember{OrganizationID: 7, UserID: 33, Role: "member"}, nil
		},
	})

	_, err := s.UpdateOrg(context.Background(), testOrgUser(33, "member"), "acme", UpdateOrgRequest{Name: "new-name"})
	requireAPIErrorStatus(t, err, 403)
}

func TestOrgService_ListOrgRepos_MemberGetsAll(t *testing.T) {
	t.Parallel()

	s := NewOrgService(&mockOrgQuerier{
		getOrgByLowerNameFn: func(ctx context.Context, lowerName string) (db.Organization, error) {
			return testOrg("private"), nil
		},
		getOrgMemberFn: func(ctx context.Context, arg db.GetOrgMemberParams) (db.OrgMember, error) {
			return db.OrgMember{OrganizationID: 7, UserID: 1, Role: "member"}, nil
		},
		listOrgReposFn: func(ctx context.Context, arg db.ListOrgReposParams) ([]db.Repository, error) {
			return []db.Repository{{ID: 1, IsPublic: true}, {ID: 2, IsPublic: false}}, nil
		},
		countOrgReposFn: func(ctx context.Context, orgID pgtype.Int8) (int64, error) {
			return 2, nil
		},
	})

	repos, total, err := s.ListOrgRepos(context.Background(), testOrgUser(1, "member"), "acme", 1, 30)
	require.NoError(t, err)
	assert.Len(t, repos, 2)
	assert.Equal(t, int64(2), total)
}

func TestOrgService_ListOrgRepos_NonMemberGetsPublicOnly(t *testing.T) {
	t.Parallel()

	s := NewOrgService(&mockOrgQuerier{
		getOrgByLowerNameFn: func(ctx context.Context, lowerName string) (db.Organization, error) {
			return testOrg("public"), nil
		},
		getOrgMemberFn: func(ctx context.Context, arg db.GetOrgMemberParams) (db.OrgMember, error) {
			return db.OrgMember{}, pgx.ErrNoRows
		},
		listPublicOrgReposFn: func(ctx context.Context, arg db.ListPublicOrgReposParams) ([]db.Repository, error) {
			assert.Equal(t, int32(30), arg.PageSize)
			assert.Equal(t, int32(0), arg.PageOffset)
			return []db.Repository{{ID: 1, IsPublic: true}}, nil
		},
		countPublicOrgReposFn: func(ctx context.Context, orgID pgtype.Int8) (int64, error) {
			return 1, nil
		},
		listOrgReposFn: func(ctx context.Context, arg db.ListOrgReposParams) ([]db.Repository, error) {
			t.Fatalf("non-member path must not query all org repositories")
			return nil, nil
		},
		countOrgReposFn: func(ctx context.Context, orgID pgtype.Int8) (int64, error) {
			t.Fatalf("non-member path must not count all org repositories")
			return 0, nil
		},
	})

	repos, total, err := s.ListOrgRepos(context.Background(), testOrgUser(2, "outsider"), "acme", 1, 30)
	require.NoError(t, err)
	require.Len(t, repos, 1)
	assert.Equal(t, int64(1), repos[0].ID)
	assert.Equal(t, int64(1), total)
}

func TestOrgService_ListOrgRepos_NonMemberPaginatesOverPublicRepos(t *testing.T) {
	t.Parallel()

	s := NewOrgService(&mockOrgQuerier{
		getOrgByLowerNameFn: func(ctx context.Context, lowerName string) (db.Organization, error) {
			return testOrg("public"), nil
		},
		getOrgMemberFn: func(ctx context.Context, arg db.GetOrgMemberParams) (db.OrgMember, error) {
			return db.OrgMember{}, pgx.ErrNoRows
		},
		listPublicOrgReposFn: func(ctx context.Context, arg db.ListPublicOrgReposParams) ([]db.Repository, error) {
			assert.Equal(t, int32(1), arg.PageSize)
			assert.Equal(t, int32(1), arg.PageOffset)
			return []db.Repository{{ID: 3, IsPublic: true}}, nil
		},
		countPublicOrgReposFn: func(ctx context.Context, orgID pgtype.Int8) (int64, error) {
			return 2, nil
		},
		listOrgReposFn: func(ctx context.Context, arg db.ListOrgReposParams) ([]db.Repository, error) {
			t.Fatalf("non-member path must not query all org repositories")
			return nil, nil
		},
		countOrgReposFn: func(ctx context.Context, orgID pgtype.Int8) (int64, error) {
			t.Fatalf("non-member path must not count all org repositories")
			return 0, nil
		},
	})

	repos, total, err := s.ListOrgRepos(context.Background(), testOrgUser(2, "outsider"), "acme", 2, 1)
	require.NoError(t, err)
	require.Len(t, repos, 1)
	assert.Equal(t, int64(3), repos[0].ID)
	assert.Equal(t, int64(2), total)
}

func TestOrgService_ListOrgMembers_RequiresOrgMember(t *testing.T) {
	t.Parallel()

	s := NewOrgService(&mockOrgQuerier{
		getOrgByLowerNameFn: func(ctx context.Context, lowerName string) (db.Organization, error) {
			return testOrg("public"), nil
		},
		getOrgMemberFn: func(ctx context.Context, arg db.GetOrgMemberParams) (db.OrgMember, error) {
			return db.OrgMember{}, pgx.ErrNoRows
		},
	})

	_, _, err := s.ListOrgMembers(context.Background(), testOrgUser(3, "outsider"), "acme", 1, 30)
	requireAPIErrorStatus(t, err, 403)
}

func TestOrgService_ListOrgTeams_RequiresOrgMember(t *testing.T) {
	t.Parallel()

	s := NewOrgService(&mockOrgQuerier{
		getOrgByLowerNameFn: func(ctx context.Context, lowerName string) (db.Organization, error) {
			return testOrg("public"), nil
		},
		getOrgMemberFn: func(ctx context.Context, arg db.GetOrgMemberParams) (db.OrgMember, error) {
			return db.OrgMember{}, pgx.ErrNoRows
		},
	})

	_, _, err := s.ListOrgTeams(context.Background(), testOrgUser(3, "outsider"), "acme", 1, 30)
	requireAPIErrorStatus(t, err, 403)
}

func TestOrgService_AddOrgMember_Success(t *testing.T) {
	t.Parallel()

	var addCalled bool
	s := NewOrgService(&mockOrgQuerier{
		getOrgByLowerNameFn: func(ctx context.Context, lowerName string) (db.Organization, error) {
			assert.Equal(t, "acme", lowerName)
			return testOrg("public"), nil
		},
		getOrgMemberFn: func(ctx context.Context, arg db.GetOrgMemberParams) (db.OrgMember, error) {
			assert.Equal(t, int64(7), arg.OrganizationID)
			assert.Equal(t, int64(1), arg.UserID)
			return db.OrgMember{OrganizationID: 7, UserID: 1, Role: "owner"}, nil
		},
		addOrgMemberFn: func(ctx context.Context, arg db.AddOrgMemberParams) (db.OrgMember, error) {
			addCalled = true
			assert.Equal(t, int64(7), arg.OrganizationID)
			assert.Equal(t, int64(2), arg.UserID)
			assert.Equal(t, "member", arg.Role)
			return db.OrgMember{OrganizationID: 7, UserID: 2, Role: "member"}, nil
		},
	})

	err := s.AddOrgMember(context.Background(), testOrgUser(1, "owner"), "acme", 2, "member")
	require.NoError(t, err)
	assert.True(t, addCalled, "AddOrgMember should be called")
}

func TestOrgService_AddOrgMember_NotOwner(t *testing.T) {
	t.Parallel()

	var addCalled bool
	s := NewOrgService(&mockOrgQuerier{
		getOrgByLowerNameFn: func(ctx context.Context, lowerName string) (db.Organization, error) {
			return testOrg("public"), nil
		},
		getOrgMemberFn: func(ctx context.Context, arg db.GetOrgMemberParams) (db.OrgMember, error) {
			return db.OrgMember{OrganizationID: 7, UserID: 1, Role: "member"}, nil
		},
		addOrgMemberFn: func(ctx context.Context, arg db.AddOrgMemberParams) (db.OrgMember, error) {
			addCalled = true
			return db.OrgMember{}, nil
		},
	})

	err := s.AddOrgMember(context.Background(), testOrgUser(1, "member"), "acme", 2, "member")
	requireAPIErrorStatus(t, err, 403)
	assert.False(t, addCalled, "AddOrgMember should not be called for non-owner")
}

func TestOrgService_AddOrgMember_InvalidRole(t *testing.T) {
	t.Parallel()

	var addCalled bool
	s := NewOrgService(&mockOrgQuerier{
		getOrgByLowerNameFn: func(ctx context.Context, lowerName string) (db.Organization, error) {
			return testOrg("public"), nil
		},
		getOrgMemberFn: func(ctx context.Context, arg db.GetOrgMemberParams) (db.OrgMember, error) {
			return db.OrgMember{OrganizationID: 7, UserID: 1, Role: "owner"}, nil
		},
		addOrgMemberFn: func(ctx context.Context, arg db.AddOrgMemberParams) (db.OrgMember, error) {
			addCalled = true
			return db.OrgMember{}, nil
		},
	})

	err := s.AddOrgMember(context.Background(), testOrgUser(1, "owner"), "acme", 2, "admin")
	requireAPIErrorStatus(t, err, 422)
	assert.False(t, addCalled, "AddOrgMember should not be called for invalid role")
}

func TestOrgService_CreateTeam_OwnerOnly(t *testing.T) {
	t.Parallel()

	s := NewOrgService(&mockOrgQuerier{
		getOrgByLowerNameFn: func(ctx context.Context, lowerName string) (db.Organization, error) {
			return testOrg("public"), nil
		},
		getOrgMemberFn: func(ctx context.Context, arg db.GetOrgMemberParams) (db.OrgMember, error) {
			return db.OrgMember{OrganizationID: 7, UserID: 5, Role: "member"}, nil
		},
	})

	_, err := s.CreateTeam(context.Background(), testOrgUser(5, "member"), "acme", CreateTeamRequest{Name: "backend", Permission: "write"})
	requireAPIErrorStatus(t, err, 403)
}

func TestOrgService_GetTeam_RequiresOrgMember(t *testing.T) {
	t.Parallel()

	s := NewOrgService(&mockOrgQuerier{
		getOrgByLowerNameFn: func(ctx context.Context, lowerName string) (db.Organization, error) {
			return testOrg("public"), nil
		},
		getOrgMemberFn: func(ctx context.Context, arg db.GetOrgMemberParams) (db.OrgMember, error) {
			return db.OrgMember{}, pgx.ErrNoRows
		},
	})

	_, err := s.GetTeam(context.Background(), testOrgUser(6, "outsider"), "acme", "backend")
	requireAPIErrorStatus(t, err, 403)
}

func TestOrgService_UpdateTeam_OwnerOnly(t *testing.T) {
	t.Parallel()

	s := NewOrgService(&mockOrgQuerier{
		getOrgByLowerNameFn: func(ctx context.Context, lowerName string) (db.Organization, error) {
			return testOrg("public"), nil
		},
		getOrgMemberFn: func(ctx context.Context, arg db.GetOrgMemberParams) (db.OrgMember, error) {
			return db.OrgMember{OrganizationID: 7, UserID: 7, Role: "member"}, nil
		},
	})

	_, err := s.UpdateTeam(context.Background(), testOrgUser(7, "member"), "acme", "backend", UpdateTeamRequest{Name: "platform"})
	requireAPIErrorStatus(t, err, 403)
}

func TestOrgService_DeleteTeam_OwnerOnly(t *testing.T) {
	t.Parallel()

	s := NewOrgService(&mockOrgQuerier{
		getOrgByLowerNameFn: func(ctx context.Context, lowerName string) (db.Organization, error) {
			return testOrg("public"), nil
		},
		getOrgMemberFn: func(ctx context.Context, arg db.GetOrgMemberParams) (db.OrgMember, error) {
			return db.OrgMember{OrganizationID: 7, UserID: 7, Role: "member"}, nil
		},
	})

	err := s.DeleteTeam(context.Background(), testOrgUser(7, "member"), "acme", "backend")
	requireAPIErrorStatus(t, err, 403)
}

func TestOrgService_ListTeamMembers_RequiresOrgMember(t *testing.T) {
	t.Parallel()

	s := NewOrgService(&mockOrgQuerier{
		getOrgByLowerNameFn: func(ctx context.Context, lowerName string) (db.Organization, error) {
			return testOrg("public"), nil
		},
		getOrgMemberFn: func(ctx context.Context, arg db.GetOrgMemberParams) (db.OrgMember, error) {
			return db.OrgMember{}, pgx.ErrNoRows
		},
	})

	_, _, err := s.ListTeamMembers(context.Background(), testOrgUser(8, "outsider"), "acme", "backend", 1, 30)
	requireAPIErrorStatus(t, err, 403)
}

func TestOrgService_AddTeamMember_OwnerOnly(t *testing.T) {
	t.Parallel()

	s := NewOrgService(&mockOrgQuerier{
		getOrgByLowerNameFn: func(ctx context.Context, lowerName string) (db.Organization, error) {
			return testOrg("public"), nil
		},
		getOrgMemberFn: func(ctx context.Context, arg db.GetOrgMemberParams) (db.OrgMember, error) {
			return db.OrgMember{OrganizationID: 7, UserID: 9, Role: "member"}, nil
		},
	})

	err := s.AddTeamMember(context.Background(), testOrgUser(9, "member"), "acme", "backend", "alice")
	requireAPIErrorStatus(t, err, 403)
}

func TestOrgService_AddTeamMember_RequiresOrgMembershipAtInsert(t *testing.T) {
	t.Parallel()

	s := NewOrgService(&mockOrgQuerier{
		getOrgByLowerNameFn: func(ctx context.Context, lowerName string) (db.Organization, error) {
			return testOrg("public"), nil
		},
		getOrgMemberFn: func(ctx context.Context, arg db.GetOrgMemberParams) (db.OrgMember, error) {
			switch arg.UserID {
			case 9:
				return db.OrgMember{OrganizationID: 7, UserID: 9, Role: "owner"}, nil
			case 10:
				return db.OrgMember{OrganizationID: 7, UserID: 10, Role: "member"}, nil
			default:
				return db.OrgMember{}, pgx.ErrNoRows
			}
		},
		getTeamByOrgAndLowerNameFn: func(ctx context.Context, arg db.GetTeamByOrgAndLowerNameParams) (db.Team, error) {
			return db.Team{ID: 11, OrganizationID: 7, Name: "backend", LowerName: "backend", Permission: "write"}, nil
		},
		getUserByLowerUsernameFn: func(ctx context.Context, lowerUsername string) (db.User, error) {
			return db.User{ID: 10, Username: "alice", LowerUsername: "alice"}, nil
		},
		addTeamMemberIfOrgMemberFn: func(ctx context.Context, arg db.AddTeamMemberIfOrgMemberParams) (db.TeamMember, error) {
			assert.Equal(t, int64(11), arg.TeamID)
			assert.Equal(t, int64(10), arg.UserID)
			return db.TeamMember{}, pgx.ErrNoRows
		},
		addTeamMemberFn: func(ctx context.Context, arg db.AddTeamMemberParams) (db.TeamMember, error) {
			t.Fatalf("should not call non-atomic team member insert")
			return db.TeamMember{}, nil
		},
	})

	err := s.AddTeamMember(context.Background(), testOrgUser(9, "owner"), "acme", "backend", "alice")
	requireAPIErrorStatus(t, err, 422)
}

func TestOrgService_RemoveTeamMember_OwnerOnly(t *testing.T) {
	t.Parallel()

	s := NewOrgService(&mockOrgQuerier{
		getOrgByLowerNameFn: func(ctx context.Context, lowerName string) (db.Organization, error) {
			return testOrg("public"), nil
		},
		getOrgMemberFn: func(ctx context.Context, arg db.GetOrgMemberParams) (db.OrgMember, error) {
			return db.OrgMember{OrganizationID: 7, UserID: 9, Role: "member"}, nil
		},
	})

	err := s.RemoveTeamMember(context.Background(), testOrgUser(9, "member"), "acme", "backend", "alice")
	requireAPIErrorStatus(t, err, 403)
}

func TestOrgService_ListTeamRepos_RequiresOrgMember(t *testing.T) {
	t.Parallel()

	s := NewOrgService(&mockOrgQuerier{
		getOrgByLowerNameFn: func(ctx context.Context, lowerName string) (db.Organization, error) {
			return testOrg("public"), nil
		},
		getOrgMemberFn: func(ctx context.Context, arg db.GetOrgMemberParams) (db.OrgMember, error) {
			return db.OrgMember{}, pgx.ErrNoRows
		},
	})

	_, _, err := s.ListTeamRepos(context.Background(), testOrgUser(8, "outsider"), "acme", "backend", 1, 30)
	requireAPIErrorStatus(t, err, 403)
}

func TestOrgService_AddTeamRepo_OwnerOnly(t *testing.T) {
	t.Parallel()

	s := NewOrgService(&mockOrgQuerier{
		getOrgByLowerNameFn: func(ctx context.Context, lowerName string) (db.Organization, error) {
			return testOrg("public"), nil
		},
		getOrgMemberFn: func(ctx context.Context, arg db.GetOrgMemberParams) (db.OrgMember, error) {
			return db.OrgMember{OrganizationID: 7, UserID: 10, Role: "member"}, nil
		},
	})

	err := s.AddTeamRepo(context.Background(), testOrgUser(10, "member"), "acme", "backend", "acme", "repo")
	requireAPIErrorStatus(t, err, 403)
}

func TestOrgService_AddTeamRepo_RejectsRepoOutsideOrg(t *testing.T) {
	t.Parallel()

	s := NewOrgService(&mockOrgQuerier{
		getOrgByLowerNameFn: func(ctx context.Context, lowerName string) (db.Organization, error) {
			return testOrg("public"), nil
		},
		getOrgMemberFn: func(ctx context.Context, arg db.GetOrgMemberParams) (db.OrgMember, error) {
			return db.OrgMember{OrganizationID: 7, UserID: 10, Role: "owner"}, nil
		},
		getTeamByOrgAndLowerNameFn: func(ctx context.Context, arg db.GetTeamByOrgAndLowerNameParams) (db.Team, error) {
			return db.Team{ID: 11, OrganizationID: 7, Name: "backend", LowerName: "backend", Permission: "write"}, nil
		},
		getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return db.Repository{ID: 12, OrgID: pgtype.Int8{Int64: 7, Valid: true}}, nil
		},
		addTeamRepoIfOrgRepoFn: func(ctx context.Context, arg db.AddTeamRepoIfOrgRepoParams) (db.TeamRepo, error) {
			assert.Equal(t, int64(11), arg.TeamID)
			assert.Equal(t, int64(12), arg.RepositoryID)
			return db.TeamRepo{}, pgx.ErrNoRows
		},
		addTeamRepoFn: func(ctx context.Context, arg db.AddTeamRepoParams) (db.TeamRepo, error) {
			t.Fatalf("should not call non-atomic team repo insert")
			return db.TeamRepo{}, nil
		},
	})

	err := s.AddTeamRepo(context.Background(), testOrgUser(10, "owner"), "acme", "backend", "other-org", "repo")
	requireAPIErrorStatus(t, err, 422)
}

func TestOrgService_RemoveTeamRepo_OwnerOnly(t *testing.T) {
	t.Parallel()

	s := NewOrgService(&mockOrgQuerier{
		getOrgByLowerNameFn: func(ctx context.Context, lowerName string) (db.Organization, error) {
			return testOrg("public"), nil
		},
		getOrgMemberFn: func(ctx context.Context, arg db.GetOrgMemberParams) (db.OrgMember, error) {
			return db.OrgMember{OrganizationID: 7, UserID: 10, Role: "member"}, nil
		},
	})

	err := s.RemoveTeamRepo(context.Background(), testOrgUser(10, "member"), "acme", "backend", "acme", "repo")
	requireAPIErrorStatus(t, err, 403)
}

// ────────────────────────────────────────────────────────────────
// Happy-path tests — cover the successful execution paths
// ────────────────────────────────────────────────────────────────

func ownerOrgQuerier(extraFns ...func(*mockOrgQuerier)) *mockOrgQuerier {
	q := &mockOrgQuerier{
		getOrgByLowerNameFn: func(ctx context.Context, lowerName string) (db.Organization, error) {
			return testOrg("public"), nil
		},
		getOrgMemberFn: func(ctx context.Context, arg db.GetOrgMemberParams) (db.OrgMember, error) {
			return db.OrgMember{OrganizationID: 7, UserID: 1, Role: "owner"}, nil
		},
	}
	for _, fn := range extraFns {
		fn(q)
	}
	return q
}

func TestOrgService_UpdateOrg_Success(t *testing.T) {
	t.Parallel()

	s := NewOrgService(ownerOrgQuerier(func(q *mockOrgQuerier) {
		q.updateOrganizationFn = func(ctx context.Context, arg db.UpdateOrganizationParams) (db.Organization, error) {
			assert.Equal(t, "acme", arg.Name)
			assert.Equal(t, "acme", arg.LowerName)
			assert.Equal(t, "new description", arg.Description)
			assert.Equal(t, "public", arg.Visibility)
			org := testOrg("public")
			org.Description = arg.Description
			return org, nil
		}
	}))

	updated, err := s.UpdateOrg(context.Background(), testOrgUser(1, "owner"), "Acme", UpdateOrgRequest{Description: "new description"})
	require.NoError(t, err)
	assert.Equal(t, "new description", updated.Description)
}

func TestOrgService_UpdateOrg_RequiresAuthentication(t *testing.T) {
	t.Parallel()

	s := NewOrgService(&mockOrgQuerier{})
	_, err := s.UpdateOrg(context.Background(), nil, "acme", UpdateOrgRequest{})
	requireAPIErrorStatus(t, err, 401)
}

func TestOrgService_UpdateOrg_InvalidVisibility(t *testing.T) {
	t.Parallel()

	s := NewOrgService(ownerOrgQuerier())
	_, err := s.UpdateOrg(context.Background(), testOrgUser(1, "owner"), "acme", UpdateOrgRequest{Visibility: "invalid-value"})
	requireAPIErrorStatus(t, err, 422)
}

func TestOrgService_UpdateOrg_RejectsNamespaceRenameBeforeDBWrite(t *testing.T) {
	t.Parallel()

	q := ownerOrgQuerier(func(q *mockOrgQuerier) {
		q.updateOrganizationFn = func(context.Context, db.UpdateOrganizationParams) (db.Organization, error) {
			t.Fatal("organization rename must fail before the database update")
			return db.Organization{}, nil
		}
	})
	s := NewOrgService(q)

	_, err := s.UpdateOrg(context.Background(), testOrgUser(1, "owner"), "acme", UpdateOrgRequest{Name: "Acme"})
	requireAPIErrorStatus(t, err, 409)
	assert.Contains(t, err.Error(), "organization name changes are not supported")
}

func TestOrgService_ListOrgMembers_Success(t *testing.T) {
	t.Parallel()

	s := NewOrgService(ownerOrgQuerier(func(q *mockOrgQuerier) {
		q.listOrgMembersFn = func(ctx context.Context, arg db.ListOrgMembersParams) ([]db.ListOrgMembersRow, error) {
			assert.Equal(t, int64(7), arg.OrganizationID)
			return []db.ListOrgMembersRow{{ID: 1, Username: "alice", Role: "owner"}}, nil
		}
		q.countOrgMembersFn = func(ctx context.Context, orgID int64) (int64, error) {
			return 1, nil
		}
	}))

	members, total, err := s.ListOrgMembers(context.Background(), testOrgUser(1, "owner"), "acme", 1, 30)
	require.NoError(t, err)
	assert.Equal(t, int64(1), total)
	require.Len(t, members, 1)
	assert.Equal(t, "alice", members[0].Username)
}

func TestOrgService_ListOrgMembers_RequiresAuthentication(t *testing.T) {
	t.Parallel()

	s := NewOrgService(&mockOrgQuerier{
		getOrgByLowerNameFn: func(ctx context.Context, lowerName string) (db.Organization, error) {
			return testOrg("public"), nil
		},
	})
	_, _, err := s.ListOrgMembers(context.Background(), nil, "acme", 1, 30)
	requireAPIErrorStatus(t, err, 401)
}

func TestOrgService_ListOrgTeams_Success(t *testing.T) {
	t.Parallel()

	s := NewOrgService(ownerOrgQuerier(func(q *mockOrgQuerier) {
		q.listOrgTeamsFn = func(ctx context.Context, arg db.ListOrgTeamsParams) ([]db.Team, error) {
			return []db.Team{{ID: 5, OrganizationID: 7, Name: "backend", Permission: "write"}}, nil
		}
		q.countOrgTeamsFn = func(ctx context.Context, orgID int64) (int64, error) {
			return 1, nil
		}
	}))

	teams, total, err := s.ListOrgTeams(context.Background(), testOrgUser(1, "owner"), "acme", 1, 30)
	require.NoError(t, err)
	assert.Equal(t, int64(1), total)
	require.Len(t, teams, 1)
	assert.Equal(t, "backend", teams[0].Name)
}

func TestOrgService_ListOrgTeams_RequiresAuthentication(t *testing.T) {
	t.Parallel()

	s := NewOrgService(&mockOrgQuerier{
		getOrgByLowerNameFn: func(ctx context.Context, lowerName string) (db.Organization, error) {
			return testOrg("public"), nil
		},
	})
	_, _, err := s.ListOrgTeams(context.Background(), nil, "acme", 1, 30)
	requireAPIErrorStatus(t, err, 401)
}

func TestOrgService_CreateTeam_Success(t *testing.T) {
	t.Parallel()

	s := NewOrgService(ownerOrgQuerier(func(q *mockOrgQuerier) {
		q.createTeamFn = func(ctx context.Context, arg db.CreateTeamParams) (db.Team, error) {
			assert.Equal(t, int64(7), arg.OrganizationID)
			assert.Equal(t, "backend", arg.Name)
			assert.Equal(t, "backend", arg.LowerName)
			assert.Equal(t, "write", arg.Permission)
			return db.Team{ID: 9, OrganizationID: arg.OrganizationID, Name: arg.Name, Permission: arg.Permission}, nil
		}
	}))

	team, err := s.CreateTeam(context.Background(), testOrgUser(1, "owner"), "acme", CreateTeamRequest{Name: "backend", Permission: "write"})
	require.NoError(t, err)
	assert.Equal(t, "backend", team.Name)
	assert.Equal(t, "write", team.Permission)
}

func TestOrgService_CreateTeam_DefaultPermission(t *testing.T) {
	t.Parallel()

	s := NewOrgService(ownerOrgQuerier(func(q *mockOrgQuerier) {
		q.createTeamFn = func(ctx context.Context, arg db.CreateTeamParams) (db.Team, error) {
			assert.Equal(t, "read", arg.Permission)
			return db.Team{ID: 10, Name: arg.Name, Permission: arg.Permission}, nil
		}
	}))

	team, err := s.CreateTeam(context.Background(), testOrgUser(1, "owner"), "acme", CreateTeamRequest{Name: "viewers"})
	require.NoError(t, err)
	assert.Equal(t, "read", team.Permission)
}

func TestOrgService_CreateTeam_ValidationErrors(t *testing.T) {
	t.Parallel()

	s := NewOrgService(ownerOrgQuerier())

	tests := []struct {
		name string
		req  CreateTeamRequest
	}{
		{"empty name", CreateTeamRequest{Name: "   ", Permission: "write"}},
		{"invalid permission", CreateTeamRequest{Name: "backend", Permission: "superadmin"}},
		{"name too long", CreateTeamRequest{Name: string(make([]byte, 256)), Permission: "read"}},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			_, err := s.CreateTeam(context.Background(), testOrgUser(1, "owner"), "acme", tc.req)
			requireAPIErrorStatus(t, err, 422)
		})
	}
}

func TestOrgService_GetTeam_Success(t *testing.T) {
	t.Parallel()

	s := NewOrgService(ownerOrgQuerier(func(q *mockOrgQuerier) {
		q.getTeamByOrgAndLowerNameFn = func(ctx context.Context, arg db.GetTeamByOrgAndLowerNameParams) (db.Team, error) {
			assert.Equal(t, int64(7), arg.OrganizationID)
			assert.Equal(t, "backend", arg.LowerName)
			return db.Team{ID: 5, OrganizationID: 7, Name: "backend", Permission: "write"}, nil
		}
	}))

	team, err := s.GetTeam(context.Background(), testOrgUser(1, "owner"), "acme", "Backend")
	require.NoError(t, err)
	assert.Equal(t, "backend", team.Name)
}

func TestOrgService_UpdateTeam_Success(t *testing.T) {
	t.Parallel()

	s := NewOrgService(ownerOrgQuerier(func(q *mockOrgQuerier) {
		q.getTeamByOrgAndLowerNameFn = func(ctx context.Context, arg db.GetTeamByOrgAndLowerNameParams) (db.Team, error) {
			return db.Team{ID: 5, OrganizationID: 7, Name: "backend", LowerName: "backend", Permission: "write"}, nil
		}
		q.updateTeamFn = func(ctx context.Context, arg db.UpdateTeamParams) (db.Team, error) {
			assert.Equal(t, int64(5), arg.ID)
			assert.Equal(t, "admin", arg.Permission)
			return db.Team{ID: 5, Name: arg.Name, Permission: arg.Permission}, nil
		}
	}))

	team, err := s.UpdateTeam(context.Background(), testOrgUser(1, "owner"), "acme", "backend", UpdateTeamRequest{Permission: "admin"})
	require.NoError(t, err)
	assert.Equal(t, "admin", team.Permission)
}

func TestOrgService_UpdateTeam_InvalidPermission(t *testing.T) {
	t.Parallel()

	s := NewOrgService(ownerOrgQuerier(func(q *mockOrgQuerier) {
		q.getTeamByOrgAndLowerNameFn = func(ctx context.Context, arg db.GetTeamByOrgAndLowerNameParams) (db.Team, error) {
			return db.Team{ID: 5, OrganizationID: 7, Name: "backend", LowerName: "backend", Permission: "write"}, nil
		}
	}))

	_, err := s.UpdateTeam(context.Background(), testOrgUser(1, "owner"), "acme", "backend", UpdateTeamRequest{Permission: "godmode"})
	requireAPIErrorStatus(t, err, 422)
}

func TestOrgService_DeleteTeam_Success(t *testing.T) {
	t.Parallel()

	deleteCalled := false
	s := NewOrgService(ownerOrgQuerier(func(q *mockOrgQuerier) {
		q.getTeamByOrgAndLowerNameFn = func(ctx context.Context, arg db.GetTeamByOrgAndLowerNameParams) (db.Team, error) {
			return db.Team{ID: 5, OrganizationID: 7, Name: "backend"}, nil
		}
		q.deleteTeamFn = func(ctx context.Context, id int64) error {
			deleteCalled = true
			assert.Equal(t, int64(5), id)
			return nil
		}
	}))

	err := s.DeleteTeam(context.Background(), testOrgUser(1, "owner"), "acme", "backend")
	require.NoError(t, err)
	assert.True(t, deleteCalled)
}

func TestOrgService_ListTeamMembers_Success(t *testing.T) {
	t.Parallel()

	s := NewOrgService(ownerOrgQuerier(func(q *mockOrgQuerier) {
		q.getTeamByOrgAndLowerNameFn = func(ctx context.Context, arg db.GetTeamByOrgAndLowerNameParams) (db.Team, error) {
			return db.Team{ID: 5, OrganizationID: 7, Name: "backend"}, nil
		}
		q.listTeamMembersFn = func(ctx context.Context, arg db.ListTeamMembersParams) ([]db.User, error) {
			assert.Equal(t, int64(5), arg.TeamID)
			return []db.User{{ID: 2, Username: "bob", LowerUsername: "bob"}}, nil
		}
		q.countTeamMembersFn = func(ctx context.Context, teamID int64) (int64, error) {
			return 1, nil
		}
	}))

	members, total, err := s.ListTeamMembers(context.Background(), testOrgUser(1, "owner"), "acme", "backend", 1, 30)
	require.NoError(t, err)
	assert.Equal(t, int64(1), total)
	require.Len(t, members, 1)
	assert.Equal(t, "bob", members[0].Username)
}

func TestOrgService_AddTeamMember_Success(t *testing.T) {
	t.Parallel()

	addCalled := false
	s := NewOrgService(ownerOrgQuerier(func(q *mockOrgQuerier) {
		q.getTeamByOrgAndLowerNameFn = func(ctx context.Context, arg db.GetTeamByOrgAndLowerNameParams) (db.Team, error) {
			return db.Team{ID: 5, OrganizationID: 7, Name: "backend"}, nil
		}
		q.getUserByLowerUsernameFn = func(ctx context.Context, lowerUsername string) (db.User, error) {
			assert.Equal(t, "bob", lowerUsername)
			return db.User{ID: 2, Username: "bob", LowerUsername: "bob"}, nil
		}
		q.addTeamMemberIfOrgMemberFn = func(ctx context.Context, arg db.AddTeamMemberIfOrgMemberParams) (db.TeamMember, error) {
			addCalled = true
			assert.Equal(t, int64(5), arg.TeamID)
			assert.Equal(t, int64(2), arg.UserID)
			return db.TeamMember{TeamID: 5, UserID: 2}, nil
		}
	}))

	err := s.AddTeamMember(context.Background(), testOrgUser(1, "owner"), "acme", "backend", "bob")
	require.NoError(t, err)
	assert.True(t, addCalled)
}

func TestOrgService_RemoveTeamMember_Success(t *testing.T) {
	t.Parallel()

	removeCalled := false
	s := NewOrgService(ownerOrgQuerier(func(q *mockOrgQuerier) {
		q.getTeamByOrgAndLowerNameFn = func(ctx context.Context, arg db.GetTeamByOrgAndLowerNameParams) (db.Team, error) {
			return db.Team{ID: 5, OrganizationID: 7, Name: "backend"}, nil
		}
		q.getUserByLowerUsernameFn = func(ctx context.Context, lowerUsername string) (db.User, error) {
			return db.User{ID: 2, Username: "bob", LowerUsername: "bob"}, nil
		}
		q.removeTeamMemberFn = func(ctx context.Context, arg db.RemoveTeamMemberParams) error {
			removeCalled = true
			assert.Equal(t, int64(5), arg.TeamID)
			assert.Equal(t, int64(2), arg.UserID)
			return nil
		}
	}))

	err := s.RemoveTeamMember(context.Background(), testOrgUser(1, "owner"), "acme", "backend", "bob")
	require.NoError(t, err)
	assert.True(t, removeCalled)
}

func TestOrgService_ListTeamRepos_Success(t *testing.T) {
	t.Parallel()

	s := NewOrgService(ownerOrgQuerier(func(q *mockOrgQuerier) {
		q.getTeamByOrgAndLowerNameFn = func(ctx context.Context, arg db.GetTeamByOrgAndLowerNameParams) (db.Team, error) {
			return db.Team{ID: 5, OrganizationID: 7, Name: "backend"}, nil
		}
		q.listTeamReposFn = func(ctx context.Context, arg db.ListTeamReposParams) ([]db.Repository, error) {
			assert.Equal(t, int64(5), arg.TeamID)
			return []db.Repository{{ID: 9, Name: "repo-a", IsPublic: true}}, nil
		}
		q.countTeamReposFn = func(ctx context.Context, teamID int64) (int64, error) {
			return 1, nil
		}
	}))

	repos, total, err := s.ListTeamRepos(context.Background(), testOrgUser(1, "owner"), "acme", "backend", 1, 30)
	require.NoError(t, err)
	assert.Equal(t, int64(1), total)
	require.Len(t, repos, 1)
	assert.Equal(t, "repo-a", repos[0].Name)
}

func TestOrgService_AddTeamRepo_Success(t *testing.T) {
	t.Parallel()

	addCalled := false
	s := NewOrgService(ownerOrgQuerier(func(q *mockOrgQuerier) {
		q.getTeamByOrgAndLowerNameFn = func(ctx context.Context, arg db.GetTeamByOrgAndLowerNameParams) (db.Team, error) {
			return db.Team{ID: 5, OrganizationID: 7, Name: "backend"}, nil
		}
		q.getRepoByOwnerAndLowerNameFn = func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			assert.Equal(t, "acme", arg.Owner)
			assert.Equal(t, "repo-a", arg.LowerName)
			return db.Repository{ID: 9, OrgID: pgtype.Int8{Int64: 7, Valid: true}}, nil
		}
		q.addTeamRepoIfOrgRepoFn = func(ctx context.Context, arg db.AddTeamRepoIfOrgRepoParams) (db.TeamRepo, error) {
			addCalled = true
			assert.Equal(t, int64(5), arg.TeamID)
			assert.Equal(t, int64(9), arg.RepositoryID)
			return db.TeamRepo{TeamID: 5, RepositoryID: 9}, nil
		}
	}))

	err := s.AddTeamRepo(context.Background(), testOrgUser(1, "owner"), "acme", "backend", "acme", "repo-a")
	require.NoError(t, err)
	assert.True(t, addCalled)
}

func TestOrgService_AddTeamRepo_DispatchesTeamWebhookEvent(t *testing.T) {
	t.Parallel()

	dispatcher := &mockOrgDispatcher{}
	s := NewOrgService(
		ownerOrgQuerier(func(q *mockOrgQuerier) {
			q.getTeamByOrgAndLowerNameFn = func(ctx context.Context, arg db.GetTeamByOrgAndLowerNameParams) (db.Team, error) {
				return db.Team{ID: 5, OrganizationID: 7, Name: "backend"}, nil
			}
			q.getRepoByOwnerAndLowerNameFn = func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				return db.Repository{ID: 9, Name: "repo-a", OrgID: pgtype.Int8{Int64: 7, Valid: true}}, nil
			}
			q.addTeamRepoIfOrgRepoFn = func(ctx context.Context, arg db.AddTeamRepoIfOrgRepoParams) (db.TeamRepo, error) {
				return db.TeamRepo{TeamID: 5, RepositoryID: 9}, nil
			}
		}),
		WithOrgWebhookDispatcher(dispatcher),
	)

	err := s.AddTeamRepo(context.Background(), testOrgUser(1, "owner"), "acme", "backend", "acme", "repo-a")
	require.NoError(t, err)
	require.Len(t, dispatcher.calls, 1)
	assert.Equal(t, webhooks.EventTypeTeam, dispatcher.calls[0].eventType)
	assert.Equal(t, int64(9), dispatcher.calls[0].repoID)
}

func TestOrgService_RemoveTeamRepo_Success(t *testing.T) {
	t.Parallel()

	removeCalled := false
	s := NewOrgService(ownerOrgQuerier(func(q *mockOrgQuerier) {
		q.getTeamByOrgAndLowerNameFn = func(ctx context.Context, arg db.GetTeamByOrgAndLowerNameParams) (db.Team, error) {
			return db.Team{ID: 5, OrganizationID: 7, Name: "backend"}, nil
		}
		q.getRepoByOwnerAndLowerNameFn = func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return db.Repository{ID: 9, OrgID: pgtype.Int8{Int64: 7, Valid: true}}, nil
		}
		q.removeTeamRepoFn = func(ctx context.Context, arg db.RemoveTeamRepoParams) error {
			removeCalled = true
			assert.Equal(t, int64(5), arg.TeamID)
			assert.Equal(t, int64(9), arg.RepositoryID)
			return nil
		}
	}))

	err := s.RemoveTeamRepo(context.Background(), testOrgUser(1, "owner"), "acme", "backend", "acme", "repo-a")
	require.NoError(t, err)
	assert.True(t, removeCalled)
}

func TestOrgService_RemoveTeamRepo_DispatchesTeamWebhookEvent(t *testing.T) {
	t.Parallel()

	dispatcher := &mockOrgDispatcher{}
	s := NewOrgService(
		ownerOrgQuerier(func(q *mockOrgQuerier) {
			q.getTeamByOrgAndLowerNameFn = func(ctx context.Context, arg db.GetTeamByOrgAndLowerNameParams) (db.Team, error) {
				return db.Team{ID: 5, OrganizationID: 7, Name: "backend"}, nil
			}
			q.getRepoByOwnerAndLowerNameFn = func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				return db.Repository{ID: 9, Name: "repo-a", OrgID: pgtype.Int8{Int64: 7, Valid: true}}, nil
			}
			q.removeTeamRepoFn = func(ctx context.Context, arg db.RemoveTeamRepoParams) error {
				return nil
			}
		}),
		WithOrgWebhookDispatcher(dispatcher),
	)

	err := s.RemoveTeamRepo(context.Background(), testOrgUser(1, "owner"), "acme", "backend", "acme", "repo-a")
	require.NoError(t, err)
	require.Len(t, dispatcher.calls, 1)
	assert.Equal(t, webhooks.EventTypeTeam, dispatcher.calls[0].eventType)
	assert.Equal(t, int64(9), dispatcher.calls[0].repoID)
}

func TestOrgService_RemoveTeamRepo_RejectsRepoFromDifferentOrg(t *testing.T) {
	t.Parallel()

	s := NewOrgService(ownerOrgQuerier(func(q *mockOrgQuerier) {
		q.getTeamByOrgAndLowerNameFn = func(ctx context.Context, arg db.GetTeamByOrgAndLowerNameParams) (db.Team, error) {
			return db.Team{ID: 5, OrganizationID: 7, Name: "backend"}, nil
		}
		q.getRepoByOwnerAndLowerNameFn = func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			// Repo belongs to a different org (ID 99, not 7)
			return db.Repository{ID: 9, OrgID: pgtype.Int8{Int64: 99, Valid: true}}, nil
		}
	}))

	err := s.RemoveTeamRepo(context.Background(), testOrgUser(1, "owner"), "acme", "backend", "other-org", "repo-a")
	requireAPIErrorStatus(t, err, 422)
}

// ────────────────────────────────────────────────────────────────
// CreateOrg tests
// ────────────────────────────────────────────────────────────────

func TestOrgService_CreateOrg_Success(t *testing.T) {
	t.Parallel()

	createCalled := false
	addMemberCalled := false

	s := NewOrgService(&mockOrgQuerier{
		createOrganizationFn: func(ctx context.Context, arg db.CreateOrganizationParams) (db.Organization, error) {
			createCalled = true
			assert.Equal(t, "acme", arg.Name)
			assert.Equal(t, "acme", arg.LowerName)
			assert.Equal(t, "An org", arg.Description)
			assert.Equal(t, "public", arg.Visibility)
			return db.Organization{
				ID:          42,
				Name:        arg.Name,
				LowerName:   arg.LowerName,
				Description: arg.Description,
				Visibility:  arg.Visibility,
			}, nil
		},
		addOrgMemberFn: func(ctx context.Context, arg db.AddOrgMemberParams) (db.OrgMember, error) {
			addMemberCalled = true
			assert.Equal(t, int64(42), arg.OrganizationID)
			assert.Equal(t, int64(1), arg.UserID)
			assert.Equal(t, "owner", arg.Role)
			return db.OrgMember{OrganizationID: 42, UserID: 1, Role: "owner"}, nil
		},
	})

	actor := testOrgUser(1, "alice")
	org, err := s.CreateOrg(context.Background(), actor, CreateOrgRequest{
		Name:        "acme",
		Description: "An org",
		Visibility:  "public",
	})
	require.NoError(t, err)
	assert.Equal(t, "acme", org.Name)
	assert.Equal(t, int64(42), org.ID)
	assert.True(t, createCalled, "CreateOrganization should be called")
	assert.True(t, addMemberCalled, "AddOrgMember should be called to add creator as owner")
}

func TestOrgService_CreateOrg_RequiresAuthentication(t *testing.T) {
	t.Parallel()

	s := NewOrgService(&mockOrgQuerier{})
	_, err := s.CreateOrg(context.Background(), nil, CreateOrgRequest{Name: "acme"})
	requireAPIErrorStatus(t, err, 401)
}

func TestOrgService_CreateOrg_ValidationErrors(t *testing.T) {
	t.Parallel()

	s := NewOrgService(&mockOrgQuerier{})
	actor := testOrgUser(1, "alice")

	tests := []struct {
		name string
		req  CreateOrgRequest
	}{
		{"empty name", CreateOrgRequest{Name: "   ", Visibility: "public"}},
		{"name too long", CreateOrgRequest{Name: string(make([]byte, 256)), Visibility: "public"}},
		{"invalid owner namespace", CreateOrgRequest{Name: "parent/org", Visibility: "private"}},
		{"invalid visibility", CreateOrgRequest{Name: "acme", Visibility: "bad"}},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			_, err := s.CreateOrg(context.Background(), actor, tc.req)
			requireAPIErrorStatus(t, err, 422)
		})
	}
}

func TestOrgService_CreateOrg_DuplicateName(t *testing.T) {
	t.Parallel()

	s := NewOrgService(&mockOrgQuerier{
		createOrganizationFn: func(ctx context.Context, arg db.CreateOrganizationParams) (db.Organization, error) {
			// A user may already own this slug in the shared namespace.
			return db.Organization{}, &pgconn.PgError{Code: "23505", ConstraintName: "owner_namespaces_pkey"}
		},
	})

	actor := testOrgUser(1, "alice")
	_, err := s.CreateOrg(context.Background(), actor, CreateOrgRequest{
		Name:       "acme",
		Visibility: "public",
	})
	requireAPIErrorStatus(t, err, 409)
}

func TestOrgService_CreateOrg_AddsCreatorAsOwner(t *testing.T) {
	t.Parallel()

	addMemberCalled := false
	s := NewOrgService(&mockOrgQuerier{
		createOrganizationFn: func(ctx context.Context, arg db.CreateOrganizationParams) (db.Organization, error) {
			return db.Organization{ID: 99, Name: arg.Name, LowerName: arg.LowerName, Visibility: arg.Visibility}, nil
		},
		addOrgMemberFn: func(ctx context.Context, arg db.AddOrgMemberParams) (db.OrgMember, error) {
			addMemberCalled = true
			assert.Equal(t, int64(99), arg.OrganizationID)
			assert.Equal(t, int64(5), arg.UserID)
			assert.Equal(t, "owner", arg.Role)
			return db.OrgMember{}, nil
		},
	})

	actor := testOrgUser(5, "bob")
	_, err := s.CreateOrg(context.Background(), actor, CreateOrgRequest{
		Name:       "myorg",
		Visibility: "private",
	})
	require.NoError(t, err)
	assert.True(t, addMemberCalled, "creator must be added as owner of the new org")
}

func TestOrgService_CreateOrg_DefaultVisibility(t *testing.T) {
	t.Parallel()

	s := NewOrgService(&mockOrgQuerier{
		createOrganizationFn: func(ctx context.Context, arg db.CreateOrganizationParams) (db.Organization, error) {
			assert.Equal(t, "private", arg.Visibility, "default visibility should be private")
			return db.Organization{ID: 1, Name: arg.Name, LowerName: arg.LowerName, Visibility: arg.Visibility}, nil
		},
		addOrgMemberFn: func(ctx context.Context, arg db.AddOrgMemberParams) (db.OrgMember, error) {
			return db.OrgMember{}, nil
		},
	})

	actor := testOrgUser(1, "alice")
	org, err := s.CreateOrg(context.Background(), actor, CreateOrgRequest{
		Name: "neworg",
	})
	require.NoError(t, err)
	assert.Equal(t, "private", org.Visibility)
}

// ────────────────────────────────────────────────────────────────
// RemoveOrgMember tests
// ────────────────────────────────────────────────────────────────

func TestOrgService_RemoveOrgMember_RequiresAuthentication(t *testing.T) {
	t.Parallel()

	s := NewOrgService(&mockOrgQuerier{})
	err := s.RemoveOrgMember(context.Background(), nil, "acme", "bob")
	requireAPIErrorStatus(t, err, 401)
}

func TestOrgService_RemoveOrgMember_OwnerOnly(t *testing.T) {
	t.Parallel()

	s := NewOrgService(&mockOrgQuerier{
		getOrgByLowerNameFn: func(ctx context.Context, lowerName string) (db.Organization, error) {
			return testOrg("public"), nil
		},
		getOrgMemberFn: func(ctx context.Context, arg db.GetOrgMemberParams) (db.OrgMember, error) {
			return db.OrgMember{OrganizationID: 7, UserID: 9, Role: "member"}, nil
		},
	})

	err := s.RemoveOrgMember(context.Background(), testOrgUser(9, "member"), "acme", "bob")
	requireAPIErrorStatus(t, err, 403)
}

func TestOrgService_RemoveOrgMember_UserNotFound(t *testing.T) {
	t.Parallel()

	s := NewOrgService(ownerOrgQuerier(func(q *mockOrgQuerier) {
		q.getUserByLowerUsernameFn = func(ctx context.Context, lowerUsername string) (db.User, error) {
			return db.User{}, pgx.ErrNoRows
		}
	}))

	err := s.RemoveOrgMember(context.Background(), testOrgUser(1, "owner"), "acme", "nonexistent")
	requireAPIErrorStatus(t, err, 404)
}

func TestOrgService_RemoveOrgMember_Success(t *testing.T) {
	t.Parallel()

	removeCalled := false
	s := NewOrgService(ownerOrgQuerier(func(q *mockOrgQuerier) {
		q.getUserByLowerUsernameFn = func(ctx context.Context, lowerUsername string) (db.User, error) {
			assert.Equal(t, "bob", lowerUsername)
			return db.User{ID: 2, Username: "bob", LowerUsername: "bob"}, nil
		}
		q.countOrgOwnersFn = func(ctx context.Context, organizationID int64) (int64, error) {
			return 2, nil
		}
		q.removeOrgMemberFn = func(ctx context.Context, arg db.RemoveOrgMemberParams) error {
			removeCalled = true
			assert.Equal(t, int64(7), arg.OrganizationID)
			assert.Equal(t, int64(2), arg.UserID)
			return nil
		}
	}))

	err := s.RemoveOrgMember(context.Background(), testOrgUser(1, "owner"), "acme", "bob")
	require.NoError(t, err)
	assert.True(t, removeCalled)
}

func TestOrgService_RemoveOrgMember_EmptyUsername(t *testing.T) {
	t.Parallel()

	s := NewOrgService(ownerOrgQuerier())

	err := s.RemoveOrgMember(context.Background(), testOrgUser(1, "owner"), "acme", "   ")
	requireAPIErrorStatus(t, err, 400)
}

func TestOrgService_GetOrg_NotFound(t *testing.T) {
	t.Parallel()

	s := NewOrgService(&mockOrgQuerier{
		getOrgByLowerNameFn: func(ctx context.Context, lowerName string) (db.Organization, error) {
			return db.Organization{}, pgx.ErrNoRows
		},
	})

	_, err := s.GetOrg(context.Background(), nil, "nonexistent")
	requireAPIErrorStatus(t, err, 404)
}

// ────────────────────────────────────────────────────────────────
// RemoveOrgMember — last-owner invariant tests
// ────────────────────────────────────────────────────────────────

func TestOrgService_RemoveOrgMember_RejectsRemovingLastOwner(t *testing.T) {
	t.Parallel()

	removeCalled := false
	callCount := 0
	s := NewOrgService(&mockOrgQuerier{
		getOrgByLowerNameFn: func(ctx context.Context, lowerName string) (db.Organization, error) {
			return testOrg("public"), nil
		},
		getOrgMemberFn: func(ctx context.Context, arg db.GetOrgMemberParams) (db.OrgMember, error) {
			callCount++
			// First call: actor ownership check (user 1 is owner)
			if arg.UserID == 1 {
				return db.OrgMember{OrganizationID: 7, UserID: 1, Role: "owner"}, nil
			}
			// Second call: target membership lookup (user 2 is also owner)
			return db.OrgMember{OrganizationID: 7, UserID: 2, Role: "owner"}, nil
		},
		getUserByLowerUsernameFn: func(ctx context.Context, lowerUsername string) (db.User, error) {
			return db.User{ID: 2, Username: "bob", LowerUsername: "bob"}, nil
		},
		countOrgOwnersFn: func(ctx context.Context, organizationID int64) (int64, error) {
			assert.Equal(t, int64(7), organizationID)
			return 1, nil
		},
		removeOrgMemberFn: func(ctx context.Context, arg db.RemoveOrgMemberParams) error {
			removeCalled = true
			return nil
		},
	})

	err := s.RemoveOrgMember(context.Background(), testOrgUser(1, "owner"), "acme", "bob")
	requireAPIErrorStatus(t, err, 409)
	assert.False(t, removeCalled, "RemoveOrgMember query must not be called when removing the last owner")
}

func TestOrgService_RemoveOrgMember_AllowsRemovingOwnerWhenAnotherOwnerExists(t *testing.T) {
	t.Parallel()

	removeCalled := false
	s := NewOrgService(&mockOrgQuerier{
		getOrgByLowerNameFn: func(ctx context.Context, lowerName string) (db.Organization, error) {
			return testOrg("public"), nil
		},
		getOrgMemberFn: func(ctx context.Context, arg db.GetOrgMemberParams) (db.OrgMember, error) {
			if arg.UserID == 1 {
				return db.OrgMember{OrganizationID: 7, UserID: 1, Role: "owner"}, nil
			}
			return db.OrgMember{OrganizationID: 7, UserID: 2, Role: "owner"}, nil
		},
		getUserByLowerUsernameFn: func(ctx context.Context, lowerUsername string) (db.User, error) {
			return db.User{ID: 2, Username: "bob", LowerUsername: "bob"}, nil
		},
		countOrgOwnersFn: func(ctx context.Context, organizationID int64) (int64, error) {
			return 2, nil
		},
		removeOrgMemberFn: func(ctx context.Context, arg db.RemoveOrgMemberParams) error {
			removeCalled = true
			assert.Equal(t, int64(7), arg.OrganizationID)
			assert.Equal(t, int64(2), arg.UserID)
			return nil
		},
	})

	err := s.RemoveOrgMember(context.Background(), testOrgUser(1, "owner"), "acme", "bob")
	require.NoError(t, err)
	assert.True(t, removeCalled, "RemoveOrgMember query must be called when multiple owners exist")
}

func TestOrgService_RemoveOrgMember_NonOwnerSkipsOwnerCount(t *testing.T) {
	t.Parallel()

	countOwnersCalled := false
	removeCalled := false
	s := NewOrgService(&mockOrgQuerier{
		getOrgByLowerNameFn: func(ctx context.Context, lowerName string) (db.Organization, error) {
			return testOrg("public"), nil
		},
		getOrgMemberFn: func(ctx context.Context, arg db.GetOrgMemberParams) (db.OrgMember, error) {
			if arg.UserID == 1 {
				return db.OrgMember{OrganizationID: 7, UserID: 1, Role: "owner"}, nil
			}
			// Target user is a regular member, not an owner
			return db.OrgMember{OrganizationID: 7, UserID: 2, Role: "member"}, nil
		},
		getUserByLowerUsernameFn: func(ctx context.Context, lowerUsername string) (db.User, error) {
			return db.User{ID: 2, Username: "bob", LowerUsername: "bob"}, nil
		},
		countOrgOwnersFn: func(ctx context.Context, organizationID int64) (int64, error) {
			countOwnersCalled = true
			return 0, nil
		},
		removeOrgMemberFn: func(ctx context.Context, arg db.RemoveOrgMemberParams) error {
			removeCalled = true
			return nil
		},
	})

	err := s.RemoveOrgMember(context.Background(), testOrgUser(1, "owner"), "acme", "bob")
	require.NoError(t, err)
	assert.True(t, removeCalled, "RemoveOrgMember query must be called for non-owner targets")
	assert.False(t, countOwnersCalled, "CountOrgOwners must not be called for non-owner targets")
}

func TestOrgService_RemoveOrgMember_OwnerCountLookupFailure(t *testing.T) {
	t.Parallel()

	removeCalled := false
	s := NewOrgService(&mockOrgQuerier{
		getOrgByLowerNameFn: func(ctx context.Context, lowerName string) (db.Organization, error) {
			return testOrg("public"), nil
		},
		getOrgMemberFn: func(ctx context.Context, arg db.GetOrgMemberParams) (db.OrgMember, error) {
			if arg.UserID == 1 {
				return db.OrgMember{OrganizationID: 7, UserID: 1, Role: "owner"}, nil
			}
			return db.OrgMember{OrganizationID: 7, UserID: 2, Role: "owner"}, nil
		},
		getUserByLowerUsernameFn: func(ctx context.Context, lowerUsername string) (db.User, error) {
			return db.User{ID: 2, Username: "bob", LowerUsername: "bob"}, nil
		},
		countOrgOwnersFn: func(ctx context.Context, organizationID int64) (int64, error) {
			return 0, assert.AnError
		},
		removeOrgMemberFn: func(ctx context.Context, arg db.RemoveOrgMemberParams) error {
			removeCalled = true
			return nil
		},
	})

	err := s.RemoveOrgMember(context.Background(), testOrgUser(1, "owner"), "acme", "bob")
	requireAPIErrorStatus(t, err, 500)
	assert.False(t, removeCalled, "RemoveOrgMember query must not be called when owner count lookup fails")
}

func TestOrgService_RemoveOrgMember_TxLocksThenChecksThenDeletes(t *testing.T) {
	t.Parallel()

	var calls []string
	tx := &mockOrgMemberRemovalTx{
		lockOrganizationFn: func(ctx context.Context, id int64) (int64, error) {
			calls = append(calls, "lock_org")
			assert.Equal(t, int64(7), id)
			return id, nil
		},
		getOrgMemberForUpdateFn: func(ctx context.Context, arg db.GetOrgMemberForUpdateParams) (db.OrgMember, error) {
			calls = append(calls, "lock_member")
			assert.Equal(t, int64(7), arg.OrganizationID)
			assert.Equal(t, int64(2), arg.UserID)
			return db.OrgMember{OrganizationID: 7, UserID: 2, Role: "owner"}, nil
		},
		countOrgOwnersFn: func(ctx context.Context, organizationID int64) (int64, error) {
			calls = append(calls, "count_owners")
			assert.Equal(t, int64(7), organizationID)
			return 2, nil
		},
		deleteTeamMembershipsForOrgUserFn: func(ctx context.Context, arg db.DeleteTeamMembershipsForOrgUserParams) error {
			calls = append(calls, "delete_team_memberships")
			assert.Equal(t, int64(7), arg.OrganizationID)
			assert.Equal(t, int64(2), arg.UserID)
			return nil
		},
		removeOrgMemberFn: func(ctx context.Context, arg db.RemoveOrgMemberParams) error {
			calls = append(calls, "remove_member")
			assert.Equal(t, int64(7), arg.OrganizationID)
			assert.Equal(t, int64(2), arg.UserID)
			return nil
		},
		commitFn: func(ctx context.Context) error {
			calls = append(calls, "commit")
			return nil
		},
	}
	s := NewOrgService(ownerOrgQuerier(func(q *mockOrgQuerier) {
		q.getUserByLowerUsernameFn = func(ctx context.Context, lowerUsername string) (db.User, error) {
			return db.User{ID: 2, Username: "bob", LowerUsername: "bob"}, nil
		}
	}))
	s.txManager = &mockOrgCreateTxManager{beginMemberRemovalTxFn: func(context.Context) (orgMemberRemovalTx, error) {
		return tx, nil
	}}

	err := s.RemoveOrgMember(context.Background(), testOrgUser(1, "owner"), "acme", "bob")
	require.NoError(t, err)
	assert.Equal(t,
		[]string{"lock_org", "lock_member", "count_owners", "delete_team_memberships", "remove_member", "commit"},
		calls,
		"last-owner check and deletes must run in order under the organization and membership locks in one transaction")
}

func TestOrgService_RemoveOrgMember_TxRejectsLastOwnerWithoutMutating(t *testing.T) {
	t.Parallel()

	teamsDeleted := false
	removeCalled := false
	committed := false
	tx := &mockOrgMemberRemovalTx{
		getOrgMemberForUpdateFn: func(ctx context.Context, arg db.GetOrgMemberForUpdateParams) (db.OrgMember, error) {
			return db.OrgMember{OrganizationID: 7, UserID: 2, Role: "owner"}, nil
		},
		countOrgOwnersFn: func(ctx context.Context, organizationID int64) (int64, error) {
			return 1, nil
		},
		deleteTeamMembershipsForOrgUserFn: func(ctx context.Context, arg db.DeleteTeamMembershipsForOrgUserParams) error {
			teamsDeleted = true
			return nil
		},
		removeOrgMemberFn: func(ctx context.Context, arg db.RemoveOrgMemberParams) error {
			removeCalled = true
			return nil
		},
		commitFn: func(ctx context.Context) error {
			committed = true
			return nil
		},
	}
	s := NewOrgService(ownerOrgQuerier(func(q *mockOrgQuerier) {
		q.getUserByLowerUsernameFn = func(ctx context.Context, lowerUsername string) (db.User, error) {
			return db.User{ID: 2, Username: "bob", LowerUsername: "bob"}, nil
		}
	}))
	s.txManager = &mockOrgCreateTxManager{beginMemberRemovalTxFn: func(context.Context) (orgMemberRemovalTx, error) {
		return tx, nil
	}}

	err := s.RemoveOrgMember(context.Background(), testOrgUser(1, "owner"), "acme", "bob")
	requireAPIErrorStatus(t, err, 409)
	assert.False(t, teamsDeleted, "team memberships must not be touched when the target is the last owner")
	assert.False(t, removeCalled, "org membership must not be deleted when the target is the last owner")
	assert.False(t, committed, "transaction must not commit when the last-owner check fails")
}

func TestOrgService_RemoveOrgMember_TxMembershipGoneUnderLock(t *testing.T) {
	t.Parallel()

	committed := false
	tx := &mockOrgMemberRemovalTx{
		getOrgMemberForUpdateFn: func(ctx context.Context, arg db.GetOrgMemberForUpdateParams) (db.OrgMember, error) {
			return db.OrgMember{}, pgx.ErrNoRows
		},
		commitFn: func(ctx context.Context) error {
			committed = true
			return nil
		},
	}
	s := NewOrgService(ownerOrgQuerier(func(q *mockOrgQuerier) {
		q.getUserByLowerUsernameFn = func(ctx context.Context, lowerUsername string) (db.User, error) {
			return db.User{ID: 2, Username: "bob", LowerUsername: "bob"}, nil
		}
	}))
	s.txManager = &mockOrgCreateTxManager{beginMemberRemovalTxFn: func(context.Context) (orgMemberRemovalTx, error) {
		return tx, nil
	}}

	err := s.RemoveOrgMember(context.Background(), testOrgUser(1, "owner"), "acme", "bob")
	requireAPIErrorStatus(t, err, 404)
	assert.False(t, committed, "transaction must not commit when the membership vanished under the lock")
}

// ────────────────────────────────────────────────────────────────
// Team lifecycle dispatch tests — CreateTeam, UpdateTeam, DeleteTeam
// ────────────────────────────────────────────────────────────────

func TestOrgService_CreateTeam_DispatchesTeamWebhookEvent(t *testing.T) {
	t.Parallel()

	dispatcher := &mockOrgDispatcher{}
	s := NewOrgService(
		ownerOrgQuerier(func(q *mockOrgQuerier) {
			q.createTeamFn = func(ctx context.Context, arg db.CreateTeamParams) (db.Team, error) {
				return db.Team{ID: 20, OrganizationID: 7, Name: "backend", Permission: "write"}, nil
			}
		}),
		WithOrgWebhookDispatcher(dispatcher),
	)

	_, err := s.CreateTeam(context.Background(), testOrgUser(1, "owner"), "acme", CreateTeamRequest{Name: "backend", Permission: "write"})
	require.NoError(t, err)
	require.Len(t, dispatcher.calls, 1)
	assert.Equal(t, webhooks.EventTypeTeam, dispatcher.calls[0].eventType)
}

func TestOrgService_UpdateTeam_DispatchesTeamWebhookEvent(t *testing.T) {
	t.Parallel()

	dispatcher := &mockOrgDispatcher{}
	s := NewOrgService(
		ownerOrgQuerier(func(q *mockOrgQuerier) {
			q.getTeamByOrgAndLowerNameFn = func(ctx context.Context, arg db.GetTeamByOrgAndLowerNameParams) (db.Team, error) {
				return db.Team{ID: 5, OrganizationID: 7, Name: "backend", LowerName: "backend", Permission: "write"}, nil
			}
			q.updateTeamFn = func(ctx context.Context, arg db.UpdateTeamParams) (db.Team, error) {
				return db.Team{ID: 5, Name: "backend", Permission: "admin"}, nil
			}
		}),
		WithOrgWebhookDispatcher(dispatcher),
	)

	_, err := s.UpdateTeam(context.Background(), testOrgUser(1, "owner"), "acme", "backend", UpdateTeamRequest{Permission: "admin"})
	require.NoError(t, err)
	require.Len(t, dispatcher.calls, 1)
	assert.Equal(t, webhooks.EventTypeTeam, dispatcher.calls[0].eventType)
}

func TestOrgService_DeleteTeam_DispatchesTeamWebhookEvent(t *testing.T) {
	t.Parallel()

	dispatcher := &mockOrgDispatcher{}
	s := NewOrgService(
		ownerOrgQuerier(func(q *mockOrgQuerier) {
			q.getTeamByOrgAndLowerNameFn = func(ctx context.Context, arg db.GetTeamByOrgAndLowerNameParams) (db.Team, error) {
				return db.Team{ID: 5, OrganizationID: 7, Name: "backend"}, nil
			}
			q.deleteTeamFn = func(ctx context.Context, id int64) error {
				return nil
			}
		}),
		WithOrgWebhookDispatcher(dispatcher),
	)

	err := s.DeleteTeam(context.Background(), testOrgUser(1, "owner"), "acme", "backend")
	require.NoError(t, err)
	require.Len(t, dispatcher.calls, 1)
	assert.Equal(t, webhooks.EventTypeTeam, dispatcher.calls[0].eventType)
}

// ────────────────────────────────────────────────────────────────
// Team member dispatch tests — AddTeamMember, RemoveTeamMember
// ────────────────────────────────────────────────────────────────

func TestOrgService_AddTeamMember_DispatchesTeamWebhookEvent(t *testing.T) {
	t.Parallel()

	dispatcher := &mockOrgDispatcher{}
	s := NewOrgService(
		ownerOrgQuerier(func(q *mockOrgQuerier) {
			q.getTeamByOrgAndLowerNameFn = func(ctx context.Context, arg db.GetTeamByOrgAndLowerNameParams) (db.Team, error) {
				return db.Team{ID: 5, OrganizationID: 7, Name: "backend"}, nil
			}
			q.getUserByLowerUsernameFn = func(ctx context.Context, lowerUsername string) (db.User, error) {
				return db.User{ID: 2, Username: "bob", LowerUsername: "bob"}, nil
			}
			q.addTeamMemberIfOrgMemberFn = func(ctx context.Context, arg db.AddTeamMemberIfOrgMemberParams) (db.TeamMember, error) {
				return db.TeamMember{TeamID: 5, UserID: 2}, nil
			}
		}),
		WithOrgWebhookDispatcher(dispatcher),
	)

	err := s.AddTeamMember(context.Background(), testOrgUser(1, "owner"), "acme", "backend", "bob")
	require.NoError(t, err)
	require.Len(t, dispatcher.calls, 1)
	assert.Equal(t, webhooks.EventTypeTeam, dispatcher.calls[0].eventType)
}

func TestOrgService_RemoveTeamMember_DispatchesTeamWebhookEvent(t *testing.T) {
	t.Parallel()

	dispatcher := &mockOrgDispatcher{}
	s := NewOrgService(
		ownerOrgQuerier(func(q *mockOrgQuerier) {
			q.getTeamByOrgAndLowerNameFn = func(ctx context.Context, arg db.GetTeamByOrgAndLowerNameParams) (db.Team, error) {
				return db.Team{ID: 5, OrganizationID: 7, Name: "backend"}, nil
			}
			q.getUserByLowerUsernameFn = func(ctx context.Context, lowerUsername string) (db.User, error) {
				return db.User{ID: 2, Username: "bob", LowerUsername: "bob"}, nil
			}
			q.removeTeamMemberFn = func(ctx context.Context, arg db.RemoveTeamMemberParams) error {
				return nil
			}
		}),
		WithOrgWebhookDispatcher(dispatcher),
	)

	err := s.RemoveTeamMember(context.Background(), testOrgUser(1, "owner"), "acme", "backend", "bob")
	require.NoError(t, err)
	require.Len(t, dispatcher.calls, 1)
	assert.Equal(t, webhooks.EventTypeTeam, dispatcher.calls[0].eventType)
}

// ────────────────────────────────────────────────────────────────
// Organization member dispatch tests — AddOrgMember, RemoveOrgMember
// ────────────────────────────────────────────────────────────────

func TestOrgService_AddOrgMember_DispatchesOrganizationWebhookEvent(t *testing.T) {
	t.Parallel()

	dispatcher := &mockOrgDispatcher{}
	s := NewOrgService(
		ownerOrgQuerier(func(q *mockOrgQuerier) {
			q.addOrgMemberFn = func(ctx context.Context, arg db.AddOrgMemberParams) (db.OrgMember, error) {
				return db.OrgMember{OrganizationID: 7, UserID: 2, Role: "member"}, nil
			}
		}),
		WithOrgWebhookDispatcher(dispatcher),
	)

	err := s.AddOrgMember(context.Background(), testOrgUser(1, "owner"), "acme", 2, "member")
	require.NoError(t, err)
	require.Len(t, dispatcher.calls, 1)
	assert.Equal(t, webhooks.EventTypeOrganization, dispatcher.calls[0].eventType)
	payload, ok := dispatcher.calls[0].payload.(webhooks.OrganizationEventPayload)
	require.True(t, ok, "payload should be OrganizationEventPayload")
	assert.Equal(t, "member_added", payload.Action)
}

func TestOrgService_RemoveOrgMember_DispatchesOrganizationWebhookEvent(t *testing.T) {
	t.Parallel()

	dispatcher := &mockOrgDispatcher{}
	s := NewOrgService(
		ownerOrgQuerier(func(q *mockOrgQuerier) {
			q.getUserByLowerUsernameFn = func(ctx context.Context, lowerUsername string) (db.User, error) {
				return db.User{ID: 2, Username: "bob", LowerUsername: "bob"}, nil
			}
			q.countOrgOwnersFn = func(ctx context.Context, organizationID int64) (int64, error) {
				return 2, nil
			}
			q.removeOrgMemberFn = func(ctx context.Context, arg db.RemoveOrgMemberParams) error {
				return nil
			}
		}),
		WithOrgWebhookDispatcher(dispatcher),
	)

	err := s.RemoveOrgMember(context.Background(), testOrgUser(1, "owner"), "acme", "bob")
	require.NoError(t, err)
	require.Len(t, dispatcher.calls, 1)
	assert.Equal(t, webhooks.EventTypeOrganization, dispatcher.calls[0].eventType)
	payload, ok := dispatcher.calls[0].payload.(webhooks.OrganizationEventPayload)
	require.True(t, ok, "payload should be OrganizationEventPayload")
	assert.Equal(t, "member_removed", payload.Action)
}

func TestOrgService_MembershipChanges_InvokeSeatReconciler(t *testing.T) {
	t.Parallel()

	newService := func() (*OrgService, *[]int64) {
		reconciled := []int64{}
		s := NewOrgService(ownerOrgQuerier(func(q *mockOrgQuerier) {
			q.addOrgMemberFn = func(ctx context.Context, arg db.AddOrgMemberParams) (db.OrgMember, error) {
				return db.OrgMember{OrganizationID: arg.OrganizationID, UserID: arg.UserID, Role: arg.Role}, nil
			}
			q.getUserByLowerUsernameFn = func(ctx context.Context, lowerUsername string) (db.User, error) {
				return db.User{ID: 2, Username: "bob", LowerUsername: "bob"}, nil
			}
			q.countOrgOwnersFn = func(ctx context.Context, organizationID int64) (int64, error) {
				return 2, nil
			}
			q.removeOrgMemberFn = func(ctx context.Context, arg db.RemoveOrgMemberParams) error {
				return nil
			}
		}))
		s.SetSeatReconciler(func(_ context.Context, orgID int64) error {
			reconciled = append(reconciled, orgID)
			return nil
		})
		return s, &reconciled
	}

	t.Run("add member reconciles seats", func(t *testing.T) {
		s, reconciled := newService()
		require.NoError(t, s.AddOrgMember(context.Background(), testOrgUser(1, "owner"), "acme", 2, "member"))
		assert.Equal(t, []int64{7}, *reconciled)
	})

	t.Run("remove member reconciles seats", func(t *testing.T) {
		s, reconciled := newService()
		require.NoError(t, s.RemoveOrgMember(context.Background(), testOrgUser(1, "owner"), "acme", "bob"))
		assert.Equal(t, []int64{7}, *reconciled)
	})
}

func TestOrgService_SeatReconcilerFailure_DoesNotFailMembershipChange(t *testing.T) {
	t.Parallel()

	s := NewOrgService(ownerOrgQuerier(func(q *mockOrgQuerier) {
		q.addOrgMemberFn = func(ctx context.Context, arg db.AddOrgMemberParams) (db.OrgMember, error) {
			return db.OrgMember{OrganizationID: arg.OrganizationID, UserID: arg.UserID, Role: arg.Role}, nil
		}
	}))
	s.SetSeatReconciler(func(context.Context, int64) error {
		return stdErrors.New("stripe unavailable")
	})

	require.NoError(t, s.AddOrgMember(context.Background(), testOrgUser(1, "owner"), "acme", 2, "member"))
}
