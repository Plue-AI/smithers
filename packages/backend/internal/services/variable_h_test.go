package services

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

type variableHQuerier struct {
	getRepoFn           func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error)
	getOrgFn            func(context.Context, string) (db.Organization, error)
	getOrgMemberFn      func(context.Context, db.GetOrgMemberParams) (db.OrgMember, error)
	isOrgOwnerFn        func(context.Context, db.IsOrgOwnerForRepoUserParams) (bool, error)
	teamPermFn          func(context.Context, db.GetHighestTeamPermissionForRepoUserParams) (string, error)
	collabPermFn        func(context.Context, db.GetCollaboratorPermissionForRepoUserParams) (string, error)
	createVariableFn    func(context.Context, db.CreateOrUpdateVariableParams) (db.RepositoryVariable, error)
	getVariableFn       func(context.Context, db.GetVariableByNameParams) (db.RepositoryVariable, error)
	listVariablesFn     func(context.Context, int64) ([]db.RepositoryVariable, error)
	deleteVariableFn    func(context.Context, db.DeleteVariableParams) error
	createOrgVariableFn func(context.Context, db.CreateOrUpdateOrgVariableParams) (db.OrganizationVariable, error)
	getOrgVariableFn    func(context.Context, db.GetOrgVariableByNameParams) (db.OrganizationVariable, error)
	listOrgVariablesFn  func(context.Context, int64) ([]db.OrganizationVariable, error)
	deleteOrgVariableFn func(context.Context, db.DeleteOrgVariableParams) error
}

func variableHRepo() db.Repository {
	return db.Repository{ID: 11, Name: "demo", LowerName: "demo", UserID: pgtype.Int8{Int64: 1, Valid: true}, IsPublic: false}
}

func variableHOrg() db.Organization {
	return db.Organization{ID: 22, Name: "Acme", LowerName: "acme"}
}

func variableHUser(id int64) *db.User {
	return &db.User{ID: id, Username: "alice", LowerUsername: "alice"}
}

func (q *variableHQuerier) GetRepoByOwnerAndLowerName(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
	if q.getRepoFn != nil {
		return q.getRepoFn(ctx, arg)
	}
	return variableHRepo(), nil
}

func (q *variableHQuerier) GetOrgByLowerName(ctx context.Context, lowerName string) (db.Organization, error) {
	if q.getOrgFn != nil {
		return q.getOrgFn(ctx, lowerName)
	}
	return variableHOrg(), nil
}

func (q *variableHQuerier) GetOrgMember(ctx context.Context, arg db.GetOrgMemberParams) (db.OrgMember, error) {
	if q.getOrgMemberFn != nil {
		return q.getOrgMemberFn(ctx, arg)
	}
	return db.OrgMember{OrganizationID: arg.OrganizationID, UserID: arg.UserID, Role: "owner"}, nil
}

func (q *variableHQuerier) IsOrgOwnerForRepoUser(ctx context.Context, arg db.IsOrgOwnerForRepoUserParams) (bool, error) {
	if q.isOrgOwnerFn != nil {
		return q.isOrgOwnerFn(ctx, arg)
	}
	return false, nil
}

func (q *variableHQuerier) GetHighestTeamPermissionForRepoUser(ctx context.Context, arg db.GetHighestTeamPermissionForRepoUserParams) (string, error) {
	if q.teamPermFn != nil {
		return q.teamPermFn(ctx, arg)
	}
	return "", nil
}

func (q *variableHQuerier) GetCollaboratorPermissionForRepoUser(ctx context.Context, arg db.GetCollaboratorPermissionForRepoUserParams) (string, error) {
	if q.collabPermFn != nil {
		return q.collabPermFn(ctx, arg)
	}
	return "", nil
}

func (q *variableHQuerier) CreateOrUpdateVariable(ctx context.Context, arg db.CreateOrUpdateVariableParams) (db.RepositoryVariable, error) {
	if q.createVariableFn != nil {
		return q.createVariableFn(ctx, arg)
	}
	now := time.Date(2026, 7, 7, 12, 0, 0, 0, time.UTC)
	return db.RepositoryVariable{RepositoryID: arg.RepositoryID, Name: arg.Name, Value: arg.Value, CreatedAt: now, UpdatedAt: now}, nil
}

func (q *variableHQuerier) GetVariableByName(ctx context.Context, arg db.GetVariableByNameParams) (db.RepositoryVariable, error) {
	if q.getVariableFn != nil {
		return q.getVariableFn(ctx, arg)
	}
	return db.RepositoryVariable{}, pgx.ErrNoRows
}

func (q *variableHQuerier) ListVariables(ctx context.Context, repositoryID int64) ([]db.RepositoryVariable, error) {
	if q.listVariablesFn != nil {
		return q.listVariablesFn(ctx, repositoryID)
	}
	return nil, nil
}

func (q *variableHQuerier) DeleteVariable(ctx context.Context, arg db.DeleteVariableParams) error {
	if q.deleteVariableFn != nil {
		return q.deleteVariableFn(ctx, arg)
	}
	return nil
}

func (q *variableHQuerier) CreateOrUpdateOrgVariable(ctx context.Context, arg db.CreateOrUpdateOrgVariableParams) (db.OrganizationVariable, error) {
	if q.createOrgVariableFn != nil {
		return q.createOrgVariableFn(ctx, arg)
	}
	now := time.Date(2026, 7, 7, 12, 0, 0, 0, time.UTC)
	return db.OrganizationVariable{OrganizationID: arg.OrganizationID, Name: arg.Name, Value: arg.Value, CreatedAt: now, UpdatedAt: now}, nil
}

func (q *variableHQuerier) GetOrgVariableByName(ctx context.Context, arg db.GetOrgVariableByNameParams) (db.OrganizationVariable, error) {
	if q.getOrgVariableFn != nil {
		return q.getOrgVariableFn(ctx, arg)
	}
	return db.OrganizationVariable{}, pgx.ErrNoRows
}

func (q *variableHQuerier) ListOrgVariables(ctx context.Context, organizationID int64) ([]db.OrganizationVariable, error) {
	if q.listOrgVariablesFn != nil {
		return q.listOrgVariablesFn(ctx, organizationID)
	}
	return nil, nil
}

func (q *variableHQuerier) DeleteOrgVariable(ctx context.Context, arg db.DeleteOrgVariableParams) error {
	if q.deleteOrgVariableFn != nil {
		return q.deleteOrgVariableFn(ctx, arg)
	}
	return nil
}

func variableHStatus(t *testing.T, err error) int {
	t.Helper()
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	return apiErr.Status
}

func TestVariable_H_RepositoryOperationsErrorsAndSuccess(t *testing.T) {
	ctx := context.Background()
	actor := variableHUser(1)

	_, err := NewVariableService(&variableHQuerier{getRepoFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
		return db.Repository{}, pgx.ErrNoRows
	}}).SetVariable(ctx, actor, "alice", "demo", "KEY", "value")
	require.Equal(t, 404, variableHStatus(t, err))

	_, err = NewVariableService(&variableHQuerier{createVariableFn: func(context.Context, db.CreateOrUpdateVariableParams) (db.RepositoryVariable, error) {
		return db.RepositoryVariable{}, assert.AnError
	}}).SetVariable(ctx, actor, "alice", "demo", "KEY", "value")
	require.Equal(t, 500, variableHStatus(t, err))

	privateRepo := variableHRepo()
	privateRepo.UserID = pgtype.Int8{Int64: 99, Valid: true}
	_, err = NewVariableService(&variableHQuerier{getRepoFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
		return privateRepo, nil
	}}).SetVariable(ctx, actor, "alice", "demo", "KEY", "value")
	require.Equal(t, 403, variableHStatus(t, err))

	valueTime := time.Date(2026, 7, 7, 13, 0, 0, 0, time.UTC)
	got, err := NewVariableService(&variableHQuerier{getVariableFn: func(context.Context, db.GetVariableByNameParams) (db.RepositoryVariable, error) {
		return db.RepositoryVariable{Name: "KEY", Value: "value", CreatedAt: valueTime, UpdatedAt: valueTime}, nil
	}}).GetVariable(ctx, actor, "alice", "demo", "KEY")
	require.NoError(t, err)
	assert.Equal(t, "KEY", got.Name)
	assert.Equal(t, "2026-07-07T13:00:00Z", got.CreatedAt)

	_, err = NewVariableService(&variableHQuerier{getVariableFn: func(context.Context, db.GetVariableByNameParams) (db.RepositoryVariable, error) {
		return db.RepositoryVariable{}, assert.AnError
	}}).GetVariable(ctx, actor, "alice", "demo", "KEY")
	require.Equal(t, 500, variableHStatus(t, err))

	_, err = NewVariableService(&variableHQuerier{getRepoFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
		return privateRepo, nil
	}}).GetVariable(ctx, variableHUser(2), "alice", "demo", "KEY")
	require.Equal(t, 403, variableHStatus(t, err))

	_, err = NewVariableService(&variableHQuerier{listVariablesFn: func(context.Context, int64) ([]db.RepositoryVariable, error) {
		return nil, assert.AnError
	}}).ListVariables(ctx, actor, "alice", "demo")
	require.Equal(t, 500, variableHStatus(t, err))

	list, err := NewVariableService(&variableHQuerier{listVariablesFn: func(context.Context, int64) ([]db.RepositoryVariable, error) {
		return []db.RepositoryVariable{{Name: "A", Value: "1", CreatedAt: valueTime, UpdatedAt: valueTime}}, nil
	}}).ListVariables(ctx, actor, "alice", "demo")
	require.NoError(t, err)
	require.Len(t, list, 1)

	err = NewVariableService(&variableHQuerier{deleteVariableFn: func(context.Context, db.DeleteVariableParams) error {
		return assert.AnError
	}}).DeleteVariable(ctx, actor, "alice", "demo", "KEY")
	require.Equal(t, 500, variableHStatus(t, err))

	err = NewVariableService(&variableHQuerier{}).DeleteVariable(ctx, actor, "alice", "demo", "KEY")
	require.NoError(t, err)
}

func TestVariable_H_OrganizationOperationsErrorsAndSuccess(t *testing.T) {
	ctx := context.Background()
	actor := variableHUser(1)

	_, err := NewVariableService(&variableHQuerier{}).SetOrgVariable(ctx, nil, "acme", "KEY", "value")
	require.Equal(t, 401, variableHStatus(t, err))

	_, err = NewVariableService(&variableHQuerier{}).SetOrgVariable(ctx, actor, "acme", "", "value")
	require.Equal(t, 422, variableHStatus(t, err))

	_, err = NewVariableService(&variableHQuerier{}).SetOrgVariable(ctx, actor, "acme", string(make([]byte, 256)), "value")
	require.Equal(t, 422, variableHStatus(t, err))

	_, err = NewVariableService(&variableHQuerier{getOrgFn: func(context.Context, string) (db.Organization, error) {
		return db.Organization{}, pgx.ErrNoRows
	}}).SetOrgVariable(ctx, actor, "missing", "KEY", "value")
	require.Equal(t, 404, variableHStatus(t, err))

	_, err = NewVariableService(&variableHQuerier{getOrgMemberFn: func(context.Context, db.GetOrgMemberParams) (db.OrgMember, error) {
		return db.OrgMember{Role: "member"}, nil
	}}).SetOrgVariable(ctx, actor, "acme", "KEY", "value")
	require.Equal(t, 403, variableHStatus(t, err))

	_, err = NewVariableService(&variableHQuerier{createOrgVariableFn: func(context.Context, db.CreateOrUpdateOrgVariableParams) (db.OrganizationVariable, error) {
		return db.OrganizationVariable{}, assert.AnError
	}}).SetOrgVariable(ctx, actor, "acme", "KEY", "value")
	require.Equal(t, 500, variableHStatus(t, err))

	resp, err := NewVariableService(&variableHQuerier{}).SetOrgVariable(ctx, actor, "acme", "KEY", "value")
	require.NoError(t, err)
	assert.Equal(t, "KEY", resp.Name)

	_, err = NewVariableService(&variableHQuerier{listOrgVariablesFn: func(context.Context, int64) ([]db.OrganizationVariable, error) {
		return nil, assert.AnError
	}}).ListOrgVariables(ctx, actor, "acme")
	require.Equal(t, 500, variableHStatus(t, err))

	list, err := NewVariableService(&variableHQuerier{listOrgVariablesFn: func(context.Context, int64) ([]db.OrganizationVariable, error) {
		return []db.OrganizationVariable{{Name: "A", Value: "1", CreatedAt: time.Now().UTC(), UpdatedAt: time.Now().UTC()}}, nil
	}}).ListOrgVariables(ctx, actor, "acme")
	require.NoError(t, err)
	require.Len(t, list, 1)

	err = NewVariableService(&variableHQuerier{}).DeleteOrgVariable(ctx, nil, "acme", "KEY")
	require.Equal(t, 401, variableHStatus(t, err))

	err = NewVariableService(&variableHQuerier{}).DeleteOrgVariable(ctx, actor, "acme", "")
	require.Equal(t, 400, variableHStatus(t, err))

	err = NewVariableService(&variableHQuerier{deleteOrgVariableFn: func(context.Context, db.DeleteOrgVariableParams) error {
		return assert.AnError
	}}).DeleteOrgVariable(ctx, actor, "acme", "KEY")
	require.Equal(t, 500, variableHStatus(t, err))

	err = NewVariableService(&variableHQuerier{}).DeleteOrgVariable(ctx, actor, "acme", "KEY")
	require.NoError(t, err)
}

func TestVariable_H_HelperPermissionBranches(t *testing.T) {
	ctx := context.Background()
	svc := NewVariableService(&variableHQuerier{})

	_, err := svc.resolveRepoByOwnerAndName(ctx, "", "repo")
	require.Equal(t, 400, variableHStatus(t, err))
	_, err = svc.resolveRepoByOwnerAndName(ctx, "owner", "")
	require.Equal(t, 400, variableHStatus(t, err))
	_, err = svc.requireOrgOwner(ctx, variableHUser(1), "")
	require.Equal(t, 400, variableHStatus(t, err))

	_, err = svc.requireOrgOwner(ctx, nil, "acme")
	require.Equal(t, 401, variableHStatus(t, err))
	admin := variableHUser(9)
	admin.IsAdmin = true
	_, err = svc.requireOrgOwner(ctx, admin, "acme")
	require.NoError(t, err)

	_, err = NewVariableService(&variableHQuerier{getOrgMemberFn: func(context.Context, db.GetOrgMemberParams) (db.OrgMember, error) {
		return db.OrgMember{}, pgx.ErrNoRows
	}}).requireOrgOwner(ctx, variableHUser(2), "acme")
	require.Equal(t, 403, variableHStatus(t, err))

	repo := variableHRepo()
	repo.UserID = pgtype.Int8{Int64: 99, Valid: true}
	err = NewVariableService(&variableHQuerier{collabPermFn: func(context.Context, db.GetCollaboratorPermissionForRepoUserParams) (string, error) {
		return "", assert.AnError
	}}).requireReadAccess(ctx, repo, variableHUser(1))
	require.Equal(t, 500, variableHStatus(t, err))

	err = NewVariableService(&variableHQuerier{}).requireWriteAccess(ctx, repo, nil)
	require.Equal(t, 401, variableHStatus(t, err))

	err = NewVariableService(&variableHQuerier{collabPermFn: func(context.Context, db.GetCollaboratorPermissionForRepoUserParams) (string, error) {
		return "", assert.AnError
	}}).requireWriteAccess(ctx, repo, variableHUser(1))
	require.Equal(t, 500, variableHStatus(t, err))

	permission, owner, err := repoPermissionForUser(ctx, &variableHQuerier{collabPermFn: func(context.Context, db.GetCollaboratorPermissionForRepoUserParams) (string, error) {
		return "write", nil
	}}, repo, 1)
	require.NoError(t, err)
	assert.False(t, owner)
	assert.Equal(t, "write", permission)
}
