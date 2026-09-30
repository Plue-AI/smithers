package services

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
	"github.com/smithersai/smithers/packages/backend/sandbox"
)

// #3175: a repository or organization workflow secret declares the hosts and
// request headers it may be sent to, with the agent-environment binding
// model. The binding is stored with the secret, survives a value rotation,
// is changed without the value, and keeps the secret out of every plain
// environment: only an egress proxy carries it.
func TestWorkflowSecretHostBindingsPostgres(t *testing.T) {
	pool := getAgentTestPool(t)
	ctx := context.Background()
	owner := createSecretIntegrationUser(t, "bindowner")
	suffix := time.Now().UnixNano()
	orgName := fmt.Sprintf("bindorg%d", suffix)
	var orgID, repositoryID int64
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO organizations (name, lower_name, description) VALUES ($1, $1, '') RETURNING id`, orgName).Scan(&orgID))
	_, err := pool.Exec(ctx, `INSERT INTO org_members (organization_id, user_id, role) VALUES ($1, $2, 'owner')`, orgID, owner.ID)
	require.NoError(t, err)
	repoName := fmt.Sprintf("bindrepo%d", suffix)
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO repositories (org_id, name, lower_name, default_bookmark) VALUES ($1, $2, $2, 'main') RETURNING id`, orgID, repoName).Scan(&repositoryID))
	codec, err := webhook.NewSecretCodec("host-binding-secret-key")
	require.NoError(t, err)
	service := NewSecretService(db.New(pool), codec)

	npm := &SecretBinding{Hosts: []string{" Registry.NPMJS.org ", "registry.npmjs.org"}, MatchHeaders: []string{"Authorization"}}
	created, err := service.SetSecret(ctx, owner, orgName, repoName, "NPM_TOKEN", "npm-1", nil, npm)
	require.NoError(t, err)
	assert.Equal(t, []string{"registry.npmjs.org"}, created.Hosts, "hosts are normalised and deduplicated")
	assert.Equal(t, []string{"authorization"}, created.MatchHeaders)

	rotated, err := service.SetSecret(ctx, owner, orgName, repoName, "NPM_TOKEN", "npm-2", nil, nil)
	require.NoError(t, err)
	assert.Equal(t, []string{"registry.npmjs.org"}, rotated.Hosts, "a rotation keeps the binding")

	_, err = service.SetSecret(ctx, owner, orgName, repoName, "PLAIN", "plain-value", nil, nil)
	require.NoError(t, err)
	listed, err := service.ListSecrets(ctx, owner, orgName, repoName)
	require.NoError(t, err)
	require.Len(t, listed, 2)
	assert.Equal(t, []string{"registry.npmjs.org"}, listed[0].Hosts)
	assert.Equal(t, []string{}, listed[1].Hosts, "an unbound secret lists empty lists, never null")
	assert.Equal(t, []string{}, listed[1].MatchHeaders)

	for _, bad := range []SecretBinding{
		{Hosts: []string{"api.example.com"}},
		{MatchHeaders: []string{"authorization"}},
		{Hosts: []string{"https://api.example.com"}, MatchHeaders: []string{"authorization"}},
		{Hosts: []string{"localhost"}, MatchHeaders: []string{"authorization"}},
		{Hosts: []string{"api.example.com"}, MatchHeaders: []string{"bad header"}},
	} {
		_, err := service.SetSecretBinding(ctx, owner, orgName, repoName, "PLAIN", bad)
		assert.Equal(t, http.StatusBadRequest, apiStatus(t, err), "%+v", bad)
		_, err = service.SetSecret(ctx, owner, orgName, repoName, "PLAIN", "plain-value", nil, &bad)
		assert.Equal(t, http.StatusBadRequest, apiStatus(t, err), "%+v", bad)
	}
	// A wildcard or address range would let the proxy swap the value into
	// requests to any host it covers; only exact host names bind (#3212).
	for _, host := range []string{"*.ngrok-free.app", " *.Example.COM ", "127.0.0.0/8", "10.0.0.1/32", "0.0.0.0/0", "::/0"} {
		broad := SecretBinding{Hosts: []string{"api.example.com", host}, MatchHeaders: []string{"authorization"}}
		mentions := strings.ToLower(strings.TrimSpace(host))
		_, err := service.SetSecretBinding(ctx, owner, orgName, repoName, "PLAIN", broad)
		assertSecretHostNotExact(t, err, mentions)
		_, err = service.SetSecret(ctx, owner, orgName, repoName, "BROAD", "broad-value", nil, &broad)
		assertSecretHostNotExact(t, err, mentions)
		_, err = service.SetOrgSecret(ctx, owner, orgName, "BROAD", "broad-value", &broad)
		assertSecretHostNotExact(t, err, mentions)
	}
	var broadRows int
	require.NoError(t, pool.QueryRow(ctx, `SELECT
		(SELECT count(*) FROM repository_secrets WHERE repository_id = $1 AND (name = 'BROAD' OR cardinality(hosts) > 1))
		+ (SELECT count(*) FROM organization_secrets WHERE organization_id = $2 AND name = 'BROAD')`, repositoryID, orgID).Scan(&broadRows))
	assert.Zero(t, broadRows, "a refused binding stores nothing")

	_, err = service.SetSecretBinding(ctx, owner, orgName, repoName, "MISSING", SecretBinding{Hosts: []string{"api.example.com"}, MatchHeaders: []string{"authorization"}})
	assert.Equal(t, http.StatusNotFound, apiStatus(t, err))
	stranger := createSecretIntegrationUser(t, "bindstranger")
	_, err = service.SetSecretBinding(ctx, stranger, orgName, repoName, "PLAIN", SecretBinding{})
	assert.Equal(t, http.StatusForbidden, apiStatus(t, err))

	orgSecret, err := service.SetOrgSecret(ctx, owner, orgName, "ORG_DEPLOY_KEY", "org-deploy",
		&SecretBinding{Hosts: []string{"api.deploy.example.com"}, MatchHeaders: []string{"x-api-key"}})
	require.NoError(t, err)
	assert.Equal(t, []string{"api.deploy.example.com"}, orgSecret.Hosts)
	orgSecret, err = service.SetOrgSecret(ctx, owner, orgName, "ORG_DEPLOY_KEY", "org-deploy-2", nil)
	require.NoError(t, err)
	assert.Equal(t, []string{"x-api-key"}, orgSecret.MatchHeaders, "an org rotation keeps the binding")
	orgListed, err := service.ListOrgSecrets(ctx, owner, orgName)
	require.NoError(t, err)
	require.Len(t, orgListed, 1)
	assert.Equal(t, []string{"api.deploy.example.com"}, orgListed[0].Hosts)

	injector := NewSecretInjector(db.New(pool), codec)
	snapshot, err := injector.RepositorySecrets(ctx, repositoryID, false)
	require.NoError(t, err)
	assert.Equal(t, map[string]string{"PLAIN": "plain-value"}, snapshot.Env)
	assert.Equal(t, map[string]string{"PLAIN": "plain-value"}, snapshot.Secrets)
	assert.Equal(t, []sandbox.EgressProxySecret{
		{Name: "NPM_TOKEN", Value: "npm-2", Hosts: []string{"registry.npmjs.org"}, MatchHeaders: []string{"authorization"}},
		{Name: "ORG_DEPLOY_KEY", Value: "org-deploy-2", Hosts: []string{"api.deploy.example.com"}, MatchHeaders: []string{"x-api-key"}},
	}, snapshot.Bound)
	env, err := injector.InjectRepositoryEnvironment(ctx, repositoryID, map[string]string{})
	require.NoError(t, err)
	assert.Equal(t, map[string]string{"PLAIN": "plain-value"}, env, "an agent's environment never holds a bound value")
	agent, err := service.ListDecryptedSecretsForRepo(ctx, repositoryID)
	require.NoError(t, err)
	assert.Equal(t, map[string]string{"PLAIN": "plain-value"}, agent)

	// A repository secret overrides the organization's of the same name,
	// binding and all; unbinding hands it back to the plain environment.
	_, err = service.SetSecret(ctx, owner, orgName, repoName, "ORG_DEPLOY_KEY", "repo-deploy", nil, nil)
	require.NoError(t, err)
	unbound, err := service.SetSecretBinding(ctx, owner, orgName, repoName, "NPM_TOKEN", SecretBinding{})
	require.NoError(t, err)
	assert.Equal(t, []string{}, unbound.Hosts)
	snapshot, err = injector.RepositorySecrets(ctx, repositoryID, false)
	require.NoError(t, err)
	assert.Empty(t, snapshot.Bound)
	assert.Equal(t, map[string]string{"NPM_TOKEN": "npm-2", "ORG_DEPLOY_KEY": "repo-deploy", "PLAIN": "plain-value"}, snapshot.Secrets)

	// A row stored with a wildcard before exact hosts were required fails
	// closed: nothing is injected, bound or plain.
	_, err = service.SetSecretBinding(ctx, owner, orgName, repoName, "NPM_TOKEN", *npm)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE repository_secrets SET hosts = '{*.npmjs.org}' WHERE repository_id = $1 AND name = 'NPM_TOKEN'`, repositoryID)
	require.NoError(t, err)
	_, err = injector.RepositorySecrets(ctx, repositoryID, false)
	require.ErrorIs(t, err, sandbox.ErrEgressSecretHostNotExact)
	assert.NotContains(t, err.Error(), "npm-2")
	_, err = injector.InjectRepositoryEnvironment(ctx, repositoryID, map[string]string{})
	require.ErrorIs(t, err, sandbox.ErrEgressSecretHostNotExact)
}
