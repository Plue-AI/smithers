package services

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
)

type mockSecretQuerier struct {
	getRepoFn          func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error)
	getOrgFn           func(ctx context.Context, lowerName string) (db.Organization, error)
	getOrgMemberFn     func(ctx context.Context, arg db.GetOrgMemberParams) (db.OrgMember, error)
	isOrgOwnerFn       func(ctx context.Context, arg db.IsOrgOwnerForRepoUserParams) (bool, error)
	teamPermFn         func(ctx context.Context, arg db.GetHighestTeamPermissionForRepoUserParams) (string, error)
	collabPermFn       func(ctx context.Context, arg db.GetCollaboratorPermissionForRepoUserParams) (string, error)
	createOrUpdateFn   func(ctx context.Context, arg db.CreateOrUpdateSecretParams) (db.RepositorySecret, error)
	listSecretsFn      func(ctx context.Context, repositoryID int64) ([]db.ListSecretsRow, error)
	listSecretValuesFn func(ctx context.Context, repositoryID int64) ([]db.ListSecretValuesForRepoRow, error)
	deleteSecretFn     func(ctx context.Context, arg db.DeleteSecretParams) error
	listOrgSecretsFn   func(ctx context.Context, organizationID int64) ([]db.ListOrgSecretsRow, error)
	createOrgSecretFn  func(ctx context.Context, arg db.CreateOrUpdateOrgSecretParams) (db.OrganizationSecret, error)
}

func (m *mockSecretQuerier) GetRepoByOwnerAndLowerName(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
	if m.getRepoFn != nil {
		return m.getRepoFn(ctx, arg)
	}
	return db.Repository{ID: 1, UserID: pgtype.Int8{Int64: 1, Valid: true}}, nil
}

func (m *mockSecretQuerier) GetOrgByLowerName(ctx context.Context, lowerName string) (db.Organization, error) {
	if m.getOrgFn != nil {
		return m.getOrgFn(ctx, lowerName)
	}
	return db.Organization{ID: 1, Name: lowerName, LowerName: lowerName}, nil
}

func (m *mockSecretQuerier) GetOrgMember(ctx context.Context, arg db.GetOrgMemberParams) (db.OrgMember, error) {
	if m.getOrgMemberFn != nil {
		return m.getOrgMemberFn(ctx, arg)
	}
	return db.OrgMember{OrganizationID: arg.OrganizationID, UserID: arg.UserID, Role: "owner"}, nil
}

func (m *mockSecretQuerier) IsOrgOwnerForRepoUser(ctx context.Context, arg db.IsOrgOwnerForRepoUserParams) (bool, error) {
	if m.isOrgOwnerFn != nil {
		return m.isOrgOwnerFn(ctx, arg)
	}
	return false, nil
}

func (m *mockSecretQuerier) GetHighestTeamPermissionForRepoUser(ctx context.Context, arg db.GetHighestTeamPermissionForRepoUserParams) (string, error) {
	if m.teamPermFn != nil {
		return m.teamPermFn(ctx, arg)
	}
	return "", nil
}

func (m *mockSecretQuerier) GetCollaboratorPermissionForRepoUser(ctx context.Context, arg db.GetCollaboratorPermissionForRepoUserParams) (string, error) {
	if m.collabPermFn != nil {
		return m.collabPermFn(ctx, arg)
	}
	return "", nil
}

func (m *mockSecretQuerier) UpdateSecretSettings(_ context.Context, arg db.UpdateSecretSettingsParams) (db.RepositorySecret, error) {
	return db.RepositorySecret{Name: arg.Name, MainOnly: arg.MainOnly.Bool, Hosts: arg.Hosts, MatchHeaders: arg.MatchHeaders}, nil
}

func (m *mockSecretQuerier) CreateOrUpdateSecret(ctx context.Context, arg db.CreateOrUpdateSecretParams) (db.RepositorySecret, error) {
	if m.createOrUpdateFn != nil {
		return m.createOrUpdateFn(ctx, arg)
	}
	now := time.Now()
	return db.RepositorySecret{Name: arg.Name, CreatedAt: now, UpdatedAt: now}, nil
}

func (m *mockSecretQuerier) ListSecrets(ctx context.Context, repositoryID int64) ([]db.ListSecretsRow, error) {
	if m.listSecretsFn != nil {
		return m.listSecretsFn(ctx, repositoryID)
	}
	return nil, nil
}

func (m *mockSecretQuerier) ListSecretValuesForRepo(ctx context.Context, repositoryID int64) ([]db.ListSecretValuesForRepoRow, error) {
	if m.listSecretValuesFn != nil {
		return m.listSecretValuesFn(ctx, repositoryID)
	}
	return nil, nil
}

func (m *mockSecretQuerier) DeleteSecret(ctx context.Context, arg db.DeleteSecretParams) error {
	if m.deleteSecretFn != nil {
		return m.deleteSecretFn(ctx, arg)
	}
	return nil
}

func (m *mockSecretQuerier) CreateOrUpdateOrgSecret(ctx context.Context, arg db.CreateOrUpdateOrgSecretParams) (db.OrganizationSecret, error) {
	if m.createOrgSecretFn != nil {
		return m.createOrgSecretFn(ctx, arg)
	}
	now := time.Now()
	return db.OrganizationSecret{Name: arg.Name, CreatedAt: now, UpdatedAt: now}, nil
}

func (m *mockSecretQuerier) ListOrgSecrets(ctx context.Context, organizationID int64) ([]db.ListOrgSecretsRow, error) {
	if m.listOrgSecretsFn != nil {
		return m.listOrgSecretsFn(ctx, organizationID)
	}
	return nil, nil
}

func (m *mockSecretQuerier) ListOrgSecretValues(ctx context.Context, organizationID int64) ([]db.ListOrgSecretValuesRow, error) {
	return nil, nil
}

func (m *mockSecretQuerier) DeleteOrgSecret(ctx context.Context, arg db.DeleteOrgSecretParams) error {
	return nil
}

func TestSecretService_SetSecret_NilActor(t *testing.T) {
	t.Parallel()

	svc := NewSecretService(&mockSecretQuerier{}, webhook.NoopSecretCodec{})
	_, err := svc.SetSecret(context.Background(), nil, "alice", "demo", "KEY", "val", nil, nil)
	require.Error(t, err)
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, 401, apiErr.Status)
}

func TestSecretService_SetSecret_EmptyName(t *testing.T) {
	t.Parallel()

	svc := NewSecretService(&mockSecretQuerier{}, webhook.NoopSecretCodec{})
	actor := &db.User{ID: 1}
	_, err := svc.SetSecret(context.Background(), actor, "alice", "demo", "", "val", nil, nil)
	require.Error(t, err)
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, 422, apiErr.Status)
}

func TestSecretService_SetSecret_EmptyValue(t *testing.T) {
	t.Parallel()

	svc := NewSecretService(&mockSecretQuerier{}, webhook.NoopSecretCodec{})
	actor := &db.User{ID: 1}
	_, err := svc.SetSecret(context.Background(), actor, "alice", "demo", "KEY", "", nil, nil)
	require.Error(t, err)
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, 422, apiErr.Status)
}

func TestSecretService_SetSecret_Success(t *testing.T) {
	t.Parallel()

	svc := NewSecretService(&mockSecretQuerier{}, webhook.NoopSecretCodec{})
	actor := &db.User{ID: 1}
	resp, err := svc.SetSecret(context.Background(), actor, "alice", "demo", "API_KEY", "secret-val", nil, nil)
	require.NoError(t, err)
	assert.Equal(t, "API_KEY", resp.Name)
}

func TestSecretService_ListSecrets_NilActor(t *testing.T) {
	t.Parallel()

	svc := NewSecretService(&mockSecretQuerier{}, webhook.NoopSecretCodec{})
	_, err := svc.ListSecrets(context.Background(), nil, "alice", "demo")
	require.Error(t, err)
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, 401, apiErr.Status)
}

func TestSecretService_DeleteSecret_NilActor(t *testing.T) {
	t.Parallel()

	svc := NewSecretService(&mockSecretQuerier{}, webhook.NoopSecretCodec{})
	err := svc.DeleteSecret(context.Background(), nil, "alice", "demo", "KEY")
	require.Error(t, err)
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, 401, apiErr.Status)
}

func TestSecretService_DeleteSecret_EmptyName(t *testing.T) {
	t.Parallel()

	svc := NewSecretService(&mockSecretQuerier{}, webhook.NoopSecretCodec{})
	actor := &db.User{ID: 1}
	err := svc.DeleteSecret(context.Background(), actor, "alice", "demo", "")
	require.Error(t, err)
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, 400, apiErr.Status)
}

func TestSecretService_SetSecret_ValueTooLarge(t *testing.T) {
	t.Parallel()

	svc := NewSecretService(&mockSecretQuerier{}, webhook.NoopSecretCodec{})
	actor := &db.User{ID: 1}
	oversized := strings.Repeat("x", maxSecretValueBytes+1)
	_, err := svc.SetSecret(context.Background(), actor, "alice", "demo", "KEY", oversized, nil, nil)
	require.Error(t, err)
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, 422, apiErr.Status)
}

func TestSecretService_SetSecret_QuotaExceeded(t *testing.T) {
	t.Parallel()

	rows := make([]db.ListSecretsRow, maxSecretsPerRepo)
	for i := range rows {
		rows[i] = db.ListSecretsRow{Name: fmt.Sprintf("EXISTING_%d", i)}
	}
	svc := NewSecretService(&mockSecretQuerier{
		listSecretsFn: func(ctx context.Context, repositoryID int64) ([]db.ListSecretsRow, error) {
			return rows, nil
		},
	}, webhook.NoopSecretCodec{})
	actor := &db.User{ID: 1}
	_, err := svc.SetSecret(context.Background(), actor, "alice", "demo", "NEW_NAME", "val", nil, nil)
	require.Error(t, err)
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, pkgerrors.CodeQuotaExceeded, apiErr.Code)
}

func TestSecretService_SetSecret_QuotaAllowsUpdateOfExistingName(t *testing.T) {
	t.Parallel()

	rows := make([]db.ListSecretsRow, maxSecretsPerRepo)
	for i := range rows {
		rows[i] = db.ListSecretsRow{Name: fmt.Sprintf("EXISTING_%d", i)}
	}
	rows[0] = db.ListSecretsRow{Name: "TARGET_NAME"}
	svc := NewSecretService(&mockSecretQuerier{
		listSecretsFn: func(ctx context.Context, repositoryID int64) ([]db.ListSecretsRow, error) {
			return rows, nil
		},
	}, webhook.NoopSecretCodec{})
	actor := &db.User{ID: 1}
	resp, err := svc.SetSecret(context.Background(), actor, "alice", "demo", "TARGET_NAME", "val", nil, nil)
	require.NoError(t, err)
	assert.Equal(t, "TARGET_NAME", resp.Name)
}

func TestSecretService_SetOrgSecret_ValueTooLarge(t *testing.T) {
	t.Parallel()

	svc := NewSecretService(&mockSecretQuerier{}, webhook.NoopSecretCodec{})
	actor := &db.User{ID: 1}
	oversized := strings.Repeat("x", maxSecretValueBytes+1)
	_, err := svc.SetOrgSecret(context.Background(), actor, "acme", "KEY", oversized, nil)
	require.Error(t, err)
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, 422, apiErr.Status)
}

func TestSecretService_SetOrgSecret_QuotaExceeded(t *testing.T) {
	t.Parallel()

	rows := make([]db.ListOrgSecretsRow, maxSecretsPerOrg)
	for i := range rows {
		rows[i] = db.ListOrgSecretsRow{Name: fmt.Sprintf("EXISTING_%d", i)}
	}
	svc := NewSecretService(&mockSecretQuerier{
		listOrgSecretsFn: func(ctx context.Context, organizationID int64) ([]db.ListOrgSecretsRow, error) {
			return rows, nil
		},
	}, webhook.NoopSecretCodec{})
	actor := &db.User{ID: 1}
	_, err := svc.SetOrgSecret(context.Background(), actor, "acme", "NEW_NAME", "val", nil)
	require.Error(t, err)
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, pkgerrors.CodeQuotaExceeded, apiErr.Code)
}

func TestSecretService_RepoNotFound(t *testing.T) {
	t.Parallel()

	svc := NewSecretService(&mockSecretQuerier{
		getRepoFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return db.Repository{}, pgx.ErrNoRows
		},
	}, webhook.NoopSecretCodec{})
	actor := &db.User{ID: 1}
	_, err := svc.SetSecret(context.Background(), actor, "alice", "missing", "KEY", "val", nil, nil)
	require.Error(t, err)
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, 404, apiErr.Status)
}
