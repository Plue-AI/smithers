package services

import (
	"context"
	"fmt"
	"net/http"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
)

// #3175 review: a secret's main-only mark and binding change in one write, so
// an unbind never lands without the scope that came with it, and a blank
// entry is refused rather than normalised into an unbind.
func TestUpdateSecretChangesScopeAndBindingTogetherPostgres(t *testing.T) {
	pool := getAgentTestPool(t)
	ctx := context.Background()
	owner := createSecretIntegrationUser(t, "updowner")
	repoName := fmt.Sprintf("updrepo%d", time.Now().UnixNano())
	var repositoryID int64
	require.NoError(t, pool.QueryRow(ctx,
		`INSERT INTO repositories (user_id, name, lower_name, description, is_public, default_bookmark, next_issue_number, next_landing_number)
		 VALUES ($1, $2, $2, '', FALSE, 'main', 1, 1) RETURNING id`, owner.ID, repoName).Scan(&repositoryID))
	codec, err := webhook.NewSecretCodec("update-secret-key")
	require.NoError(t, err)
	service := NewSecretService(db.New(pool), codec)
	npm := &SecretBinding{Hosts: []string{"registry.npmjs.org"}, MatchHeaders: []string{"authorization"}}
	_, err = service.SetSecret(ctx, owner, owner.Username, repoName, "NPM_TOKEN", "npm-1", nil, npm)
	require.NoError(t, err)

	yes := true
	updated, err := service.UpdateSecret(ctx, owner, owner.Username, repoName, "NPM_TOKEN", &yes, &SecretBinding{Hosts: []string{}, MatchHeaders: []string{}})
	require.NoError(t, err)
	assert.True(t, updated.MainOnly)
	assert.Equal(t, []string{}, updated.Hosts)
	var mainOnly bool
	var hosts []string
	require.NoError(t, pool.QueryRow(ctx, `SELECT main_only, hosts FROM repository_secrets WHERE repository_id = $1 AND name = 'NPM_TOKEN'`, repositoryID).Scan(&mainOnly, &hosts))
	assert.True(t, mainOnly)
	assert.Empty(t, hosts)
	env, err := NewSecretInjector(db.New(pool), codec).InjectRepositoryEnvironment(ctx, repositoryID, map[string]string{})
	require.NoError(t, err)
	assert.NotContains(t, env, "NPM_TOKEN", "the unbound secret is main-only in the same write")

	kept, err := service.UpdateSecret(ctx, owner, owner.Username, repoName, "NPM_TOKEN", nil, npm)
	require.NoError(t, err)
	assert.True(t, kept.MainOnly, "an omitted scope is kept")
	assert.Equal(t, []string{"registry.npmjs.org"}, kept.Hosts)

	for _, blank := range []SecretBinding{
		{Hosts: []string{" "}, MatchHeaders: []string{" "}},
		{Hosts: []string{"registry.npmjs.org", ""}, MatchHeaders: []string{"authorization"}},
		{Hosts: []string{"registry.npmjs.org"}, MatchHeaders: []string{"\t"}},
	} {
		_, err := service.UpdateSecret(ctx, owner, owner.Username, repoName, "NPM_TOKEN", nil, &blank)
		assert.Equal(t, http.StatusBadRequest, apiStatus(t, err), "%+v", blank)
		_, err = service.SetSecret(ctx, owner, owner.Username, repoName, "NPM_TOKEN", "npm-2", nil, &blank)
		assert.Equal(t, http.StatusBadRequest, apiStatus(t, err), "%+v", blank)
	}
	_, err = service.UpdateSecret(ctx, owner, owner.Username, repoName, "NPM_TOKEN", nil, nil)
	assert.Equal(t, http.StatusBadRequest, apiStatus(t, err))
	_, err = service.UpdateSecret(ctx, owner, owner.Username, repoName, "MISSING", &yes, nil)
	assert.Equal(t, http.StatusNotFound, apiStatus(t, err))
	stranger := createSecretIntegrationUser(t, "updstranger")
	_, err = service.UpdateSecret(ctx, stranger, owner.Username, repoName, "NPM_TOKEN", &yes, nil)
	assert.Equal(t, http.StatusForbidden, apiStatus(t, err))
	require.NoError(t, pool.QueryRow(ctx, `SELECT hosts FROM repository_secrets WHERE repository_id = $1 AND name = 'NPM_TOKEN'`, repositoryID).Scan(&hosts))
	assert.Equal(t, []string{"registry.npmjs.org"}, hosts, "no refused write changed the binding")
}
