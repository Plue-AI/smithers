package services

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
)

func TestSecret_Z_RepositorySecretErrorsAndPermissions(t *testing.T) {
	ctx := context.Background()
	actor := &db.User{ID: 1}
	other := &db.User{ID: 2}

	_, err := NewSecretService(&mockSecretQuerier{}, webhook.NoopSecretCodec{}).
		SetSecret(ctx, other, "alice", "demo", "KEY", "value", nil, nil)
	require.Error(t, err)
	assert.Equal(t, 403, apiStatus(t, err))

	_, err = NewSecretService(&mockSecretQuerier{
		createOrUpdateFn: func(context.Context, db.CreateOrUpdateSecretParams) (db.RepositorySecret, error) {
			return db.RepositorySecret{}, errors.New("insert failed")
		},
	}, webhook.NoopSecretCodec{}).SetSecret(ctx, actor, "alice", "demo", "KEY", "value", nil, nil)
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	_, err = NewSecretService(&mockSecretQuerier{}, webhook.NoopSecretCodec{}).
		ListSecrets(ctx, actor, "", "demo")
	require.Error(t, err)
	assert.Equal(t, 400, apiStatus(t, err))

	_, err = NewSecretService(&mockSecretQuerier{
		getRepoFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return db.Repository{ID: 10, OrgID: pgtype.Int8{Int64: 3, Valid: true}}, nil
		},
		teamPermFn: func(context.Context, db.GetHighestTeamPermissionForRepoUserParams) (string, error) {
			return "", errors.New("team lookup failed")
		},
	}, webhook.NoopSecretCodec{}).ListSecrets(ctx, other, "alice", "demo")
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	_, err = NewSecretService(&mockSecretQuerier{}, webhook.NoopSecretCodec{}).
		ListSecrets(ctx, other, "alice", "demo")
	require.Error(t, err)
	assert.Equal(t, 403, apiStatus(t, err))

	_, err = NewSecretService(&mockSecretQuerier{
		listSecretsFn: func(context.Context, int64) ([]db.ListSecretsRow, error) {
			return nil, errors.New("list failed")
		},
	}, webhook.NoopSecretCodec{}).ListSecrets(ctx, actor, "alice", "demo")
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	_, err = NewSecretService(&mockSecretQuerier{
		listSecretValuesFn: func(context.Context, int64) ([]db.ListSecretValuesForRepoRow, error) {
			return nil, errors.New("list values failed")
		},
	}, webhook.NoopSecretCodec{}).ListDecryptedSecretsForRepo(ctx, 10)
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	err = NewSecretService(&mockSecretQuerier{}, webhook.NoopSecretCodec{}).
		DeleteSecret(ctx, actor, "", "demo", "KEY")
	require.Error(t, err)
	assert.Equal(t, 400, apiStatus(t, err))

	err = NewSecretService(&mockSecretQuerier{
		collabPermFn: func(context.Context, db.GetCollaboratorPermissionForRepoUserParams) (string, error) {
			return "", errors.New("permission failed")
		},
	}, webhook.NoopSecretCodec{}).DeleteSecret(ctx, other, "alice", "demo", "KEY")
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	require.NoError(t, NewSecretService(&mockSecretQuerier{}, webhook.NoopSecretCodec{}).
		DeleteSecret(ctx, actor, "alice", "demo", "KEY"))
}

func TestSecret_Z_OrgSecretErrorsAndHelpers(t *testing.T) {
	ctx := context.Background()
	actor := &db.User{ID: 2}
	now := time.Date(2026, 7, 7, 12, 0, 0, 0, time.UTC)

	svc := NewSecretService(&secretCovQuerier{mockSecretQuerier: &mockSecretQuerier{}}, webhook.NoopSecretCodec{})
	for _, tc := range []struct {
		name  string
		org   string
		key   string
		value string
		want  int
	}{
		{name: "blank name", org: "acme", key: " ", value: "value", want: 422},
		{name: "long name", org: "acme", key: strings.Repeat("x", 256), value: "value", want: 422},
		{name: "blank value", org: "acme", key: "KEY", value: "", want: 422},
		{name: "blank org", org: " ", key: "KEY", value: "value", want: 400},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := svc.SetOrgSecret(ctx, actor, tc.org, tc.key, tc.value, nil)
			require.Error(t, err)
			assert.Equal(t, tc.want, apiStatus(t, err))
		})
	}

	_, err := NewSecretService(&secretCovQuerier{
		mockSecretQuerier: &mockSecretQuerier{
			getOrgMemberFn: func(context.Context, db.GetOrgMemberParams) (db.OrgMember, error) {
				return db.OrgMember{Role: "member"}, nil
			},
		},
	}, webhook.NoopSecretCodec{}).SetOrgSecret(ctx, actor, "acme", "KEY", "value", nil)
	require.Error(t, err)
	assert.Equal(t, 403, apiStatus(t, err))

	_, err = NewSecretService(&secretCovQuerier{mockSecretQuerier: &mockSecretQuerier{}}, secretCovCodec{encryptErr: errors.New("encrypt failed")}).
		SetOrgSecret(ctx, actor, "acme", "KEY", "value", nil)
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	_, err = NewSecretService(&secretCovQuerier{
		mockSecretQuerier: &mockSecretQuerier{},
		createOrgFn: func(context.Context, db.CreateOrUpdateOrgSecretParams) (db.OrganizationSecret, error) {
			return db.OrganizationSecret{}, errors.New("insert failed")
		},
	}, webhook.NoopSecretCodec{}).SetOrgSecret(ctx, actor, "acme", "KEY", "value", nil)
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	_, err = NewSecretService(&secretCovQuerier{
		mockSecretQuerier: &mockSecretQuerier{},
		listOrgFn: func(context.Context, int64) ([]db.ListOrgSecretsRow, error) {
			return nil, errors.New("list failed")
		},
	}, webhook.NoopSecretCodec{}).ListOrgSecrets(ctx, actor, "acme")
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	_, err = NewSecretService(&mockSecretQuerier{
		getOrgFn: func(context.Context, string) (db.Organization, error) {
			return db.Organization{}, pgx.ErrNoRows
		},
	}, webhook.NoopSecretCodec{}).requireOrgOwner(ctx, actor, "acme")
	require.Error(t, err)
	assert.Equal(t, 404, apiStatus(t, err))

	err = svc.DeleteOrgSecret(ctx, nil, "acme", "KEY")
	require.Error(t, err)
	assert.Equal(t, 401, apiStatus(t, err))
	err = svc.DeleteOrgSecret(ctx, actor, "acme", " ")
	require.Error(t, err)
	assert.Equal(t, 400, apiStatus(t, err))
	err = svc.DeleteOrgSecret(ctx, actor, " ", "KEY")
	require.Error(t, err)
	assert.Equal(t, 400, apiStatus(t, err))

	err = NewSecretService(&secretCovQuerier{
		mockSecretQuerier: &mockSecretQuerier{
			getOrgMemberFn: func(context.Context, db.GetOrgMemberParams) (db.OrgMember, error) {
				return db.OrgMember{}, pgx.ErrNoRows
			},
		},
	}, webhook.NoopSecretCodec{}).DeleteOrgSecret(ctx, actor, "acme", "KEY")
	require.Error(t, err)
	assert.Equal(t, 403, apiStatus(t, err))

	err = NewSecretService(&secretCovQuerier{
		mockSecretQuerier: &mockSecretQuerier{},
		deleteOrgFn: func(context.Context, db.DeleteOrgSecretParams) error {
			return errors.New("delete failed")
		},
	}, webhook.NoopSecretCodec{}).DeleteOrgSecret(ctx, actor, "acme", "KEY")
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	q := &secretCovQuerier{
		mockSecretQuerier: &mockSecretQuerier{},
		createOrgFn: func(_ context.Context, arg db.CreateOrUpdateOrgSecretParams) (db.OrganizationSecret, error) {
			return db.OrganizationSecret{Name: arg.Name, CreatedAt: now, UpdatedAt: now}, nil
		},
	}
	resp, err := NewSecretService(q, webhook.NoopSecretCodec{}).SetOrgSecret(ctx, actor, "acme", "KEY", "value", nil)
	require.NoError(t, err)
	assert.Equal(t, "KEY", resp.Name)
}

func TestSecret_Z_DirectPermissionHelpers(t *testing.T) {
	ctx := context.Background()
	repo := db.Repository{ID: 10, UserID: pgtype.Int8{Int64: 1, Valid: true}}
	otherRepo := db.Repository{ID: 10, UserID: pgtype.Int8{Int64: 99, Valid: true}}
	svc := NewSecretService(&mockSecretQuerier{}, webhook.NoopSecretCodec{})

	_, err := svc.resolveRepoByOwnerAndName(ctx, "", "repo")
	require.Error(t, err)
	assert.Equal(t, 400, apiStatus(t, err))
	_, err = svc.resolveRepoByOwnerAndName(ctx, "owner", "")
	require.Error(t, err)
	assert.Equal(t, 400, apiStatus(t, err))

	_, err = svc.requireOrgOwner(ctx, nil, "acme")
	require.Error(t, err)
	assert.Equal(t, 401, apiStatus(t, err))
	_, err = svc.requireOrgOwner(ctx, &db.User{ID: 99, IsAdmin: true}, "acme")
	require.NoError(t, err)

	err = svc.requireAdminAccess(ctx, repo, nil)
	require.Error(t, err)
	assert.Equal(t, 401, apiStatus(t, err))
	err = svc.requireAdminAccess(ctx, otherRepo, &db.User{ID: 2})
	require.Error(t, err)
	assert.Equal(t, 403, apiStatus(t, err))

	err = svc.requireWriteAccess(ctx, repo, nil)
	require.Error(t, err)
	assert.Equal(t, 401, apiStatus(t, err))
	err = svc.requireWriteAccess(ctx, otherRepo, &db.User{ID: 2})
	require.Error(t, err)
	assert.Equal(t, 403, apiStatus(t, err))

	err = NewSecretService(&mockSecretQuerier{
		collabPermFn: func(context.Context, db.GetCollaboratorPermissionForRepoUserParams) (string, error) {
			return "", errors.New("permission failed")
		},
	}, webhook.NoopSecretCodec{}).requireWriteAccess(ctx, otherRepo, &db.User{ID: 2})
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))
}
