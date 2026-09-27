package services

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
)

type secretCovCodec struct {
	encryptErr error
	decryptErr error
}

func (c secretCovCodec) EncryptString(plaintext string) (string, error) {
	if c.encryptErr != nil {
		return "", c.encryptErr
	}
	return "enc:" + plaintext, nil
}

func (c secretCovCodec) DecryptString(ciphertext string) (string, error) {
	if c.decryptErr != nil {
		return "", c.decryptErr
	}
	return "dec:" + ciphertext, nil
}

type secretCovQuerier struct {
	*mockSecretQuerier
	createOrgFn func(context.Context, db.CreateOrUpdateOrgSecretParams) (db.OrganizationSecret, error)
	listOrgFn   func(context.Context, int64) ([]db.ListOrgSecretsRow, error)
	deleteOrgFn func(context.Context, db.DeleteOrgSecretParams) error
}

func (q *secretCovQuerier) CreateOrUpdateOrgSecret(ctx context.Context, arg db.CreateOrUpdateOrgSecretParams) (db.OrganizationSecret, error) {
	if q.createOrgFn != nil {
		return q.createOrgFn(ctx, arg)
	}
	return q.mockSecretQuerier.CreateOrUpdateOrgSecret(ctx, arg)
}

func (q *secretCovQuerier) ListOrgSecrets(ctx context.Context, organizationID int64) ([]db.ListOrgSecretsRow, error) {
	if q.listOrgFn != nil {
		return q.listOrgFn(ctx, organizationID)
	}
	return q.mockSecretQuerier.ListOrgSecrets(ctx, organizationID)
}

func (q *secretCovQuerier) DeleteOrgSecret(ctx context.Context, arg db.DeleteOrgSecretParams) error {
	if q.deleteOrgFn != nil {
		return q.deleteOrgFn(ctx, arg)
	}
	return q.mockSecretQuerier.DeleteOrgSecret(ctx, arg)
}

func TestSecret_Cov_ListDecryptsAndSkipsBlankNames(t *testing.T) {
	svc := NewSecretService(&mockSecretQuerier{
		listSecretValuesFn: func(context.Context, int64) ([]db.ListSecretValuesForRepoRow, error) {
			return []db.ListSecretValuesForRepoRow{
				{Name: " API_KEY ", ValueEncrypted: []byte("cipher")},
				{Name: "   ", ValueEncrypted: []byte("ignored")},
			}, nil
		},
	}, secretCovCodec{})

	values, err := svc.ListDecryptedSecretsForRepo(context.Background(), 123)
	require.NoError(t, err)
	assert.Equal(t, map[string]string{"API_KEY": "dec:cipher"}, values)

	_, err = (*SecretService)(nil).ListDecryptedSecretsForRepo(context.Background(), 123)
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	svc = NewSecretService(&mockSecretQuerier{
		listSecretValuesFn: func(context.Context, int64) ([]db.ListSecretValuesForRepoRow, error) {
			return []db.ListSecretValuesForRepoRow{{Name: "KEY", ValueEncrypted: []byte("bad")}}, nil
		},
	}, secretCovCodec{decryptErr: errors.New("decrypt failed")})
	_, err = svc.ListDecryptedSecretsForRepo(context.Background(), 123)
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))
}

func TestSecret_Cov_RepoSecretsSuccessAndFailures(t *testing.T) {
	now := time.Date(2026, 7, 7, 12, 0, 0, 0, time.UTC)
	var stored db.CreateOrUpdateSecretParams
	svc := NewSecretService(&mockSecretQuerier{
		createOrUpdateFn: func(_ context.Context, arg db.CreateOrUpdateSecretParams) (db.RepositorySecret, error) {
			stored = arg
			return db.RepositorySecret{Name: arg.Name, CreatedAt: now, UpdatedAt: now}, nil
		},
	}, secretCovCodec{})
	resp, err := svc.SetSecret(context.Background(), &db.User{ID: 1}, "alice", "demo", " TOKEN ", "value", nil)
	require.NoError(t, err)
	assert.Equal(t, "TOKEN", resp.Name)
	assert.Equal(t, []byte("enc:value"), stored.ValueEncrypted)

	svc = NewSecretService(&mockSecretQuerier{}, secretCovCodec{encryptErr: errors.New("encrypt failed")})
	_, err = svc.SetSecret(context.Background(), &db.User{ID: 1}, "alice", "demo", "KEY", "value", nil)
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	_, err = NewSecretService(&mockSecretQuerier{}, webhook.NoopSecretCodec{}).SetSecret(context.Background(), &db.User{ID: 1}, "alice", "demo", string(make([]byte, 256)), "value", nil)
	require.Error(t, err)
	assert.Equal(t, 422, apiStatus(t, err))

	svc = NewSecretService(&mockSecretQuerier{
		listSecretsFn: func(context.Context, int64) ([]db.ListSecretsRow, error) {
			return []db.ListSecretsRow{{Name: "A", CreatedAt: now, UpdatedAt: now}}, nil
		},
		collabPermFn: func(context.Context, db.GetCollaboratorPermissionForRepoUserParams) (string, error) {
			return "write", nil
		},
	}, webhook.NoopSecretCodec{})
	rows, err := svc.ListSecrets(context.Background(), &db.User{ID: 2}, "alice", "demo")
	require.NoError(t, err)
	require.Len(t, rows, 1)
	assert.Equal(t, "A", rows[0].Name)

	svc = NewSecretService(&mockSecretQuerier{deleteSecretFn: func(context.Context, db.DeleteSecretParams) error {
		return errors.New("delete failed")
	}}, webhook.NoopSecretCodec{})
	err = svc.DeleteSecret(context.Background(), &db.User{ID: 1}, "alice", "demo", "KEY")
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))
}

func TestSecret_Cov_OrgSecretsAndOrgPermissions(t *testing.T) {
	now := time.Date(2026, 7, 7, 12, 0, 0, 0, time.UTC)
	q := &secretCovQuerier{
		mockSecretQuerier: &mockSecretQuerier{},
		createOrgFn: func(_ context.Context, arg db.CreateOrUpdateOrgSecretParams) (db.OrganizationSecret, error) {
			assert.Equal(t, int64(1), arg.OrganizationID)
			assert.Equal(t, []byte("org-value"), arg.ValueEncrypted)
			return db.OrganizationSecret{Name: arg.Name, CreatedAt: now, UpdatedAt: now}, nil
		},
		listOrgFn: func(context.Context, int64) ([]db.ListOrgSecretsRow, error) {
			return []db.ListOrgSecretsRow{{Name: "ORG_KEY", CreatedAt: now, UpdatedAt: now}}, nil
		},
	}
	svc := NewSecretService(q, webhook.NoopSecretCodec{})
	resp, err := svc.SetOrgSecret(context.Background(), &db.User{ID: 2}, "Acme", "ORG_KEY", "org-value")
	require.NoError(t, err)
	assert.Equal(t, "ORG_KEY", resp.Name)

	rows, err := svc.ListOrgSecrets(context.Background(), &db.User{ID: 2}, "Acme")
	require.NoError(t, err)
	require.Len(t, rows, 1)
	assert.Equal(t, "ORG_KEY", rows[0].Name)

	var deleted db.DeleteOrgSecretParams
	q.deleteOrgFn = func(_ context.Context, arg db.DeleteOrgSecretParams) error {
		deleted = arg
		return nil
	}
	require.NoError(t, svc.DeleteOrgSecret(context.Background(), &db.User{ID: 2}, "Acme", " ORG_KEY "))
	assert.Equal(t, "ORG_KEY", deleted.Name)

	_, err = svc.SetOrgSecret(context.Background(), nil, "Acme", "KEY", "value")
	require.Error(t, err)
	assert.Equal(t, 401, apiStatus(t, err))

	q.mockSecretQuerier.getOrgMemberFn = func(context.Context, db.GetOrgMemberParams) (db.OrgMember, error) {
		return db.OrgMember{}, pgx.ErrNoRows
	}
	_, err = svc.ListOrgSecrets(context.Background(), &db.User{ID: 3}, "Acme")
	require.Error(t, err)
	assert.Equal(t, 403, apiStatus(t, err))

	_, err = svc.ListOrgSecrets(context.Background(), &db.User{ID: 3, IsAdmin: true}, "")
	require.Error(t, err)
	assert.Equal(t, 400, apiStatus(t, err))
}
