package services

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
)

// Legacy runs carry no current person/role or ephemeral machine authority.
// Their trigger strings never authorize main-only secrets, even on main.
func TestMainOnlySecretsReachOnlyTrustedMainRunsPostgres(t *testing.T) {
	pool := getAgentTestPool(t)
	ctx := context.Background()
	owner := createSecretIntegrationUser(t, "mainonlyowner")
	repoName := fmt.Sprintf("mainonly%d", time.Now().UnixNano())
	var repositoryID int64
	require.NoError(t, pool.QueryRow(ctx,
		`INSERT INTO repositories (user_id, name, lower_name, description, is_public, default_bookmark, next_issue_number, next_landing_number)
		 VALUES ($1, $2, $2, '', FALSE, 'main', 1, 1) RETURNING id`, owner.ID, repoName).Scan(&repositoryID))
	codec, err := webhook.NewSecretCodec("main-only-secret-key")
	require.NoError(t, err)
	service := NewSecretService(db.New(pool), codec)
	yes := true

	created, err := service.SetSecret(ctx, owner, owner.Username, repoName, "DEPLOY_TOKEN", "deploy", &yes, nil)
	require.NoError(t, err)
	assert.True(t, created.MainOnly)
	_, err = service.SetSecret(ctx, owner, owner.Username, repoName, "LINT_TOKEN", "lint", nil, nil)
	require.NoError(t, err)
	// Replacing the value keeps the scope.
	replaced, err := service.SetSecret(ctx, owner, owner.Username, repoName, "DEPLOY_TOKEN", "deploy-2", nil, nil)
	require.NoError(t, err)
	assert.True(t, replaced.MainOnly)
	listed, err := service.ListSecrets(ctx, owner, owner.Username, repoName)
	require.NoError(t, err)
	require.Len(t, listed, 2)
	assert.Equal(t, []bool{true, false}, []bool{listed[0].MainOnly, listed[1].MainOnly})

	// An agent's run never holds it.
	agent, err := service.ListDecryptedSecretsForRepo(ctx, repositoryID)
	require.NoError(t, err)
	assert.Equal(t, map[string]string{"LINT_TOKEN": "lint"}, agent)
	injector := NewSecretInjector(db.New(pool), codec)
	env, err := injector.InjectRepositoryEnvironment(ctx, repositoryID, map[string]string{})
	require.NoError(t, err)
	assert.NotContains(t, env, "DEPLOY_TOKEN")

	repository, err := db.New(pool).GetRepoByID(ctx, repositoryID)
	require.NoError(t, err)
	for _, tc := range []struct {
		event, ref string
		trusted    bool
	}{
		{"push", "refs/heads/main", false},
		{"push", "main", false},
		{"schedule", "main", false},
		{"schedule", "", false},
		{"workflow_dispatch", "refs/heads/main", false},
		{"push", "refs/heads/feature", false},
		{"push", "refs/tags/main", false},
		{"workflow_dispatch", "feature", false},
		{"invoke", "main", false},
		{"system_push", "refs/heads/main", false},
		{"landing_request", "refs/heads/main", false},
		{"pull_request", "refs/heads/main", false},
		{"issue_comment", "main", false},
	} {
		run := db.WorkflowRun{RepositoryID: repositoryID, TriggerEvent: tc.event, TriggerRef: tc.ref}
		env, secrets, err := injector.RepositoryEnvironmentAndSecrets(ctx, repositoryID, workflowRunOnTrustedMain(run, repository))
		require.NoError(t, err)
		_, got := env["DEPLOY_TOKEN"]
		assert.Equal(t, tc.trusted, got, "%s on %q", tc.event, tc.ref)
		_, redacted := secrets["DEPLOY_TOKEN"]
		assert.Equal(t, tc.trusted, redacted, "%s on %q redaction", tc.event, tc.ref)
		assert.Equal(t, "lint", env["LINT_TOKEN"])
	}

	// The mark changes without the value; a run credential cannot change it.
	runCtx := middleware.ContextWithAuthInfo(ctx, &middleware.AuthInfo{User: owner, IsTokenAuth: true, TokenSystemIssued: true, RawScopes: "admin:repository"})
	_, err = service.UpdateSecret(runCtx, owner, owner.Username, repoName, "DEPLOY_TOKEN", boolPtr(false), nil)
	require.Error(t, err)
	assert.Equal(t, 403, apiStatus(t, err))
	cleared, err := service.UpdateSecret(ctx, owner, owner.Username, repoName, "DEPLOY_TOKEN", boolPtr(false), nil)
	require.NoError(t, err)
	assert.False(t, cleared.MainOnly)
	agent, err = service.ListDecryptedSecretsForRepo(ctx, repositoryID)
	require.NoError(t, err)
	assert.Equal(t, "deploy-2", agent["DEPLOY_TOKEN"])
	_, err = service.UpdateSecret(ctx, owner, owner.Username, repoName, "MISSING", boolPtr(true), nil)
	assert.Equal(t, 404, apiStatus(t, err))
}
