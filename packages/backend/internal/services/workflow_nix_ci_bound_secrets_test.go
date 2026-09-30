package services

import (
	"context"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
	"github.com/smithersai/smithers/packages/backend/sandbox"
)

// #3175: a repository or organization secret bound to hosts reaches a NixOS
// CI guest only through its egress proxy. The job sees its placeholder; no
// machine file, exec or log ever holds its value or the job token.
func TestNixCIRun_DeliversBoundWorkflowSecretsAsPlaceholders(t *testing.T) {
	t.Parallel()
	queries := newSandboxSchedulerRunQuerier(71, 41)
	injector := NewSecretInjector(&mockSecretInjectionQuerier{
		getRepoFn: func(_ context.Context, id int64) (db.Repository, error) {
			return db.Repository{ID: id, OrgID: pgtype.Int8{Int64: 7, Valid: true}}, nil
		},
		listOrgSecretsFn: func(context.Context, int64) ([]db.ListOrgSecretValuesRow, error) {
			return []db.ListOrgSecretValuesRow{
				{Name: "ORG_DEPLOY_KEY", ValueEncrypted: []byte("org-deploy-real-value"), Hosts: []string{"deploy.example.com"}, MatchHeaders: []string{"x-api-key"}},
			}, nil
		},
		listSecretValuesFn: func(context.Context, int64) ([]db.ListSecretValuesRow, error) {
			return []db.ListSecretValuesRow{
				{Name: "NPM_TOKEN", ValueEncrypted: []byte("npm-real-value"), Hosts: []string{"registry.npmjs.org"}, MatchHeaders: []string{"authorization"}},
			}, nil
		},
	}, webhook.NoopSecretCodec{})
	guests := sandboxSchedulerGuests("0", "npm: npm-real-value\norg: org-deploy-real-value\n")
	client := guests.client(t)
	creds := &fakeCIJobCredentials{}
	worker := newSandboxSchedulerNixCIWorker(queries, client,
		WithWorkflowSandboxSchedulerCIGuests(guests),
		WithWorkflowSandboxSchedulerAPIBaseURL("https://api.smithers.test/api"),
		WithWorkflowSandboxSchedulerCIJobCredentials(creds, "https://api.smithers.test/internal"),
		WithWorkflowSandboxSchedulerSecretInjector(injector))

	require.NoError(t, worker.PollOnce(context.Background()))

	assert.Equal(t, []int64{71}, queries.markSuccessIDs)
	require.Len(t, client.createCalls, 1)
	policy := client.createCalls[0].EgressProxy
	require.NotNil(t, policy)
	assert.Equal(t, []string{"NPM_TOKEN", "ORG_DEPLOY_KEY", "SMITHERS_CI_JOB_TOKEN", "SMITHERS_JJHUB_TOKEN"}, policy.SecretNames())
	byName := map[string]sandbox.EgressProxySecret{}
	for _, secret := range policy.Secrets {
		byName[secret.Name] = secret
	}
	assert.Equal(t, sandbox.EgressProxySecret{Name: "NPM_TOKEN", Value: "npm-real-value", Hosts: []string{"registry.npmjs.org"}, MatchHeaders: []string{"authorization"}}, byName["NPM_TOKEN"])
	assert.Equal(t, sandbox.EgressProxySecret{Name: "ORG_DEPLOY_KEY", Value: "org-deploy-real-value", Hosts: []string{"deploy.example.com"}, MatchHeaders: []string{"x-api-key"}}, byName["ORG_DEPLOY_KEY"])
	jobToken := byName[nixCIJobTokenEnv].Value
	require.NotEmpty(t, jobToken)

	start := nixCIStartExec(t, client)
	assert.Contains(t, start.Command, `export NPM_TOKEN='\''NPM_TOKEN'\''`)
	assert.Contains(t, start.Command, `export ORG_DEPLOY_KEY='\''ORG_DEPLOY_KEY'\''`)
	client.mu.Lock()
	for _, req := range client.execCalls {
		assert.Empty(t, req.Secrets, "no exec carries a secret")
		for _, value := range []string{"npm-real-value", "org-deploy-real-value", jobToken} {
			assert.NotContains(t, req.Command, value, "no machine file or exec holds a bound value or the job token")
		}
	}
	client.mu.Unlock()
	for _, entry := range nixCILogEntriesForStep(queries, 41) {
		assert.NotContains(t, entry, "npm-real-value")
		assert.NotContains(t, entry, "org-deploy-real-value")
	}
	assert.Equal(t, []string{"npm: ********", "org: ********"}, nixCILogEntriesForStep(queries, 41))
}

// Binding one secret does not open a channel for the rest: a run that still
// holds an unbound secret refuses before any guest boots, naming only the
// unbound one. A repository secret overrides an organization secret of the
// same name, binding and all, so an unbound repository copy is refused too.
func TestNixCIRun_RefusesUnboundSecretsBesideBoundOnes(t *testing.T) {
	t.Parallel()
	queries := newSandboxSchedulerRunQuerier(72, 42)
	injector := NewSecretInjector(&mockSecretInjectionQuerier{
		getRepoFn: func(_ context.Context, id int64) (db.Repository, error) {
			return db.Repository{ID: id, OrgID: pgtype.Int8{Int64: 7, Valid: true}}, nil
		},
		listOrgSecretsFn: func(context.Context, int64) ([]db.ListOrgSecretValuesRow, error) {
			return []db.ListOrgSecretValuesRow{
				{Name: "SHARED_KEY", ValueEncrypted: []byte("org-bound-value"), Hosts: []string{"org.example.com"}, MatchHeaders: []string{"authorization"}},
			}, nil
		},
		listSecretValuesFn: func(context.Context, int64) ([]db.ListSecretValuesRow, error) {
			return []db.ListSecretValuesRow{
				{Name: "NPM_TOKEN", ValueEncrypted: []byte("npm-real-value"), Hosts: []string{"registry.npmjs.org"}, MatchHeaders: []string{"authorization"}},
				{Name: "SHARED_KEY", ValueEncrypted: []byte("repo-unbound-value")},
			}, nil
		},
	}, webhook.NoopSecretCodec{})
	guests := sandboxSchedulerGuests("0")
	client := guests.client(t)
	worker := newSandboxSchedulerNixCIWorker(queries, client,
		WithWorkflowSandboxSchedulerCIGuests(guests),
		WithWorkflowSandboxSchedulerSecretInjector(injector))

	require.NoError(t, worker.PollOnce(context.Background()))

	assert.Equal(t, []int64{72}, queries.markFailureIDs)
	assert.Empty(t, client.createCalls, "no guest boots for a job whose secrets cannot reach it")
	system := nixCISystemLogs(queries)
	require.Len(t, system, 1)
	assert.True(t, strings.HasPrefix(system[0], "SHARED_KEY cannot reach the NixOS CI guest: "), system[0])
	for _, insert := range queries.logInserts {
		for _, value := range []string{"npm-real-value", "org-bound-value", "repo-unbound-value"} {
			assert.NotContains(t, insert.Entry, value)
		}
	}
}

// A workflow secret bound under a platform credential's name would give the
// proxy two values for one placeholder: the job refuses, typed and named.
func TestNixCIRun_RefusesBoundSecretNamedLikeAPlatformCredential(t *testing.T) {
	t.Parallel()
	queries := newSandboxSchedulerRunQuerier(73, 43)
	injector := NewSecretInjector(&mockSecretInjectionQuerier{
		listSecretValuesFn: func(context.Context, int64) ([]db.ListSecretValuesRow, error) {
			return []db.ListSecretValuesRow{
				{Name: nixCIJobTokenEnv, ValueEncrypted: []byte("attacker-chosen"), Hosts: []string{"evil.example.com"}, MatchHeaders: []string{"authorization"}},
			}, nil
		},
	}, webhook.NoopSecretCodec{})
	guests := sandboxSchedulerGuests("0")
	client := guests.client(t)
	creds := &fakeCIJobCredentials{}
	worker := newSandboxSchedulerNixCIWorker(queries, client,
		WithWorkflowSandboxSchedulerCIGuests(guests),
		WithWorkflowSandboxSchedulerCIJobCredentials(creds, "https://api.smithers.test/internal"),
		WithWorkflowSandboxSchedulerSecretInjector(injector))

	require.NoError(t, worker.PollOnce(context.Background()))

	assert.Equal(t, []int64{73}, queries.markFailureIDs)
	assert.Empty(t, client.createCalls)
	assert.Equal(t, []int64{1}, creds.revoked, "the minted job token dies with the refused job")
	assert.Equal(t, []string{"SMITHERS_CI_JOB_TOKEN cannot reach the NixOS CI guest: a platform credential uses the same name"}, nixCISystemLogs(queries))

	_, err := bindNixCIGuestSecrets(&sandbox.CreateRequest{EgressProxy: &sandbox.EgressProxyPolicy{Enabled: true}}, []sandbox.EgressProxySecret{
		nixCIEgressSecret("B", "one", "b.example.com"), nixCIEgressSecret("A", "two", "a.example.com"),
		nixCIEgressSecret("B", "three", "b.example.com"), nixCIEgressSecret("A", "four", "a.example.com"),
	})
	var typed *CISecretChannelError
	require.ErrorAs(t, err, &typed)
	assert.Equal(t, []string{"A", "B"}, typed.Names)
	assert.NotContains(t, err.Error(), "one")
}
