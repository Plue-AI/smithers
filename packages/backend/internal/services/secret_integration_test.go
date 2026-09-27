package services

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
)

func createSecretIntegrationUser(t *testing.T, prefix string) *db.User {
	t.Helper()

	pool := getAgentTestPool(t)
	unique := fmt.Sprintf("%s%d", prefix, time.Now().UnixNano())
	email := unique + "@example.com"
	var userID int64
	err := pool.QueryRow(
		context.Background(),
		`INSERT INTO users (username, lower_username, email, lower_email, display_name)
		 VALUES ($1, $1, $2, $2, $1)
		 RETURNING id`,
		unique,
		email,
	).Scan(&userID)
	require.NoError(t, err)
	return &db.User{ID: userID, Username: unique, LowerUsername: unique}
}

func TestSecretService_Integration_RepositoryRoundTripAndAuthorization(t *testing.T) {
	pool := getAgentTestPool(t)
	ctx := context.Background()
	owner := createSecretIntegrationUser(t, "secretowner")
	adminCollaborator := createSecretIntegrationUser(t, "secretadmin")
	stranger := createSecretIntegrationUser(t, "secretstranger")
	repoName := fmt.Sprintf("secretrepo%d", time.Now().UnixNano())

	var repositoryID int64
	err := pool.QueryRow(
		ctx,
		`INSERT INTO repositories
		 (user_id, name, lower_name, description, is_public, default_bookmark, next_issue_number, next_landing_number)
		 VALUES ($1, $2, $2, '', TRUE, 'main', 1, 1)
		 RETURNING id`,
		owner.ID,
		repoName,
	).Scan(&repositoryID)
	require.NoError(t, err)
	_, err = pool.Exec(
		ctx,
		`INSERT INTO collaborators (repository_id, user_id, permission) VALUES ($1, $2, 'admin')`,
		repositoryID,
		adminCollaborator.ID,
	)
	require.NoError(t, err)

	codec, err := webhook.NewSecretCodec("repository-secret-integration-key")
	require.NoError(t, err)
	service := NewSecretService(
		db.New(pool),
		codec,
		WithSecretOwnershipGuard(NewRepoOwnershipFence(pool)),
	)

	const secretName = "CONNECTOR_TOKEN"
	const plaintext = "connector-token-for-unattended-run"
	created, err := service.SetSecret(ctx, adminCollaborator, owner.Username, repoName, secretName, plaintext, nil)
	require.NoError(t, err)
	assert.Equal(t, secretName, created.Name)
	encoded, err := json.Marshal(created)
	require.NoError(t, err)
	assert.NotContains(t, string(encoded), plaintext)

	var stored []byte
	err = pool.QueryRow(
		ctx,
		`SELECT value_encrypted FROM repository_secrets WHERE repository_id = $1 AND name = $2`,
		repositoryID,
		secretName,
	).Scan(&stored)
	require.NoError(t, err)
	assert.NotEqual(t, plaintext, string(stored))

	listed, err := service.ListSecrets(ctx, adminCollaborator, owner.Username, repoName)
	require.NoError(t, err)
	require.Len(t, listed, 1)
	assert.Equal(t, secretName, listed[0].Name)
	encoded, err = json.Marshal(listed)
	require.NoError(t, err)
	assert.NotContains(t, string(encoded), plaintext)

	decrypted, err := service.ListDecryptedSecretsForRepo(ctx, repositoryID)
	require.NoError(t, err)
	assert.Equal(t, map[string]string{secretName: plaintext}, decrypted)
	runtimeEnv, runtimeSecrets, err := NewSecretInjector(db.New(pool), codec).
		RepositoryEnvironmentAndSecrets(ctx, repositoryID, false)
	require.NoError(t, err)
	assert.Equal(t, map[string]string{secretName: plaintext}, runtimeEnv)
	assert.Equal(t, map[string]string{secretName: plaintext}, runtimeSecrets)

	_, err = service.SetSecret(ctx, stranger, owner.Username, repoName, "STRANGER_TOKEN", "denied", nil)
	require.Error(t, err)
	assert.Equal(t, 403, apiStatus(t, err))
	_, err = service.ListSecrets(ctx, stranger, owner.Username, repoName)
	require.Error(t, err)
	assert.Equal(t, 403, apiStatus(t, err))
	err = service.DeleteSecret(ctx, stranger, owner.Username, repoName, secretName)
	require.Error(t, err)
	assert.Equal(t, 403, apiStatus(t, err))

	require.NoError(t, service.DeleteSecret(ctx, adminCollaborator, owner.Username, repoName, secretName))
	listed, err = service.ListSecrets(ctx, adminCollaborator, owner.Username, repoName)
	require.NoError(t, err)
	assert.Empty(t, listed)
	decrypted, err = service.ListDecryptedSecretsForRepo(ctx, repositoryID)
	require.NoError(t, err)
	assert.Empty(t, decrypted)
	runtimeEnv, runtimeSecrets, err = NewSecretInjector(db.New(pool), codec).
		RepositoryEnvironmentAndSecrets(ctx, repositoryID, false)
	require.NoError(t, err)
	assert.Empty(t, runtimeEnv)
	assert.Empty(t, runtimeSecrets)
}
