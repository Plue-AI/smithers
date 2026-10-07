package services

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
)

// The declared path through the real migration and queries: stored, kept on
// a replace that names none, cleared by "", one path per repository even
// against a writer that skipped the pre-check, and delivered to the branch
// machine snapshot as a placeholder for a host-bound key.
func TestSecretPathStoredAndDeliveredPostgres(t *testing.T) {
	pool := getAgentTestPool(t)
	ctx := context.Background()
	owner := createSecretIntegrationUser(t, "pathowner")
	repoName := fmt.Sprintf("pathrepo%d", time.Now().UnixNano())
	var repositoryID int64
	require.NoError(t, pool.QueryRow(ctx,
		`INSERT INTO repositories (user_id, name, lower_name, description, is_public, default_bookmark, next_issue_number, next_landing_number)
		 VALUES ($1, $2, $2, '', FALSE, 'main', 1, 1) RETURNING id`, owner.ID, repoName).Scan(&repositoryID))
	codec, err := webhook.NewSecretCodec("secret-path-key")
	require.NoError(t, err)
	queries := db.New(pool)
	service := NewSecretService(queries, codec)

	path := "~/.config/anthropic/key"
	anthropic := &SecretBinding{Hosts: []string{"api.anthropic.com"}, MatchHeaders: []string{"x-api-key"}}
	created, err := service.SetSecret(ctx, owner, owner.Username, repoName, "ANTHROPIC_API_KEY", "sk-ant-api03-real", nil, anthropic, &path)
	require.NoError(t, err)
	require.Equal(t, path, created.Path)
	replaced, err := service.SetSecret(ctx, owner, owner.Username, repoName, "ANTHROPIC_API_KEY", "sk-ant-api03-rotated", nil, nil, nil)
	require.NoError(t, err)
	require.Equal(t, path, replaced.Path, "a replace that names no path keeps it")
	listed, err := service.ListSecrets(ctx, owner, owner.Username, repoName)
	require.NoError(t, err)
	require.Len(t, listed, 1)
	require.Equal(t, path, listed[0].Path)

	_, err = service.SetSecret(ctx, owner, owner.Username, repoName, "OTHER", "v", nil, nil, &path)
	var refusal *AccessError
	require.ErrorAs(t, err, &refusal)
	require.Equal(t, "path_taken", refusal.Code)
	// The index holds even for a writer that skipped the service's pre-check.
	_, err = queries.CreateOrUpdateSecret(ctx, db.CreateOrUpdateSecretParams{RepositoryID: repositoryID, Name: "RACER", ValueEncrypted: []byte("x"),
		Path: pgTextForTest(path)})
	require.True(t, isSecretPathTaken(err), "%v", err)

	snapshot, err := NewSecretInjector(queries, codec).RepositorySecrets(ctx, repositoryID, false)
	require.NoError(t, err)
	require.Equal(t, map[string]string{path: "ANTHROPIC_API_KEY"}, snapshot.Files)
	require.Len(t, snapshot.Bound, 1)
	require.Equal(t, "sk-ant-api03-rotated", snapshot.Bound[0].Value)

	cleared := ""
	_, err = service.SetSecret(ctx, owner, owner.Username, repoName, "ANTHROPIC_API_KEY", "sk-ant-api03-third", nil, nil, &cleared)
	require.NoError(t, err)
	snapshot, err = NewSecretInjector(queries, codec).RepositorySecrets(ctx, repositoryID, false)
	require.NoError(t, err)
	require.Empty(t, snapshot.Files)
	// The freed path can be declared by another secret.
	_, err = service.SetSecret(ctx, owner, owner.Username, repoName, "OTHER", "other-literal", nil, nil, &path)
	require.NoError(t, err)
	snapshot, err = NewSecretInjector(queries, codec).RepositorySecrets(ctx, repositoryID, false)
	require.NoError(t, err)
	require.Equal(t, map[string]string{path: "other-literal"}, snapshot.Files)

	var stored string
	require.Error(t, pool.QueryRow(ctx, `UPDATE repository_secrets SET path = repeat('a', 513) WHERE repository_id = $1 AND name = 'OTHER' RETURNING path`, repositoryID).Scan(&stored))
}

func pgTextForTest(value string) pgtype.Text { return pgtype.Text{String: value, Valid: true} }
