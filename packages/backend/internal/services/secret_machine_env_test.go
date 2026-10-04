package services

import (
	"context"
	"errors"
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
	"github.com/smithersai/smithers/packages/backend/sandbox"
	"github.com/stretchr/testify/require"
)

func TestSecretMachineEnvLegacyRunsLackAuthority(t *testing.T) {
	for _, event := range []string{"workflow_dispatch", "push", "schedule", "invoke", "agent", "pull_request", "issue_comment"} {
		for _, ref := range []string{"", "main", "refs/heads/main", "scratch/alice/work", "smithers/item", "refs/tags/main", "feature"} {
			t.Run(event+"/"+ref, func(t *testing.T) {
				require.False(t, workflowRunOnTrustedMain(db.WorkflowRun{ID: 1, TriggerEvent: event, TriggerRef: ref, TriggerCommitSha: "0123456789012345678901234567890123456789"}, db.Repository{ID: 7, DefaultBookmark: "main"}))
			})
		}
	}
}

func TestSecretMachineEnvBranchSnapshotAndBootRefusal(t *testing.T) {
	q := &mockSecretInjectionQuerier{listSecretValuesFn: func(context.Context, int64) ([]db.ListSecretValuesRow, error) {
		return []db.ListSecretValuesRow{
			{Name: "CANARY_TOKEN", ValueEncrypted: []byte("unbound-sentinel")},
			{Name: "DEPLOY_KEY", ValueEncrypted: []byte("main-sentinel"), MainOnly: true},
			{Name: "HOST_TOKEN", ValueEncrypted: []byte("bound-sentinel"), Hosts: []string{"api.example.com"}, MatchHeaders: []string{"authorization"}},
		}, nil
	}}
	injector := NewSecretInjector(q, webhook.NoopSecretCodec{})
	snapshot, err := injector.RepositorySecrets(context.Background(), 7, false)
	require.NoError(t, err)
	require.Equal(t, map[string]string{"CANARY_TOKEN": "unbound-sentinel"}, snapshot.Secrets)
	require.Equal(t, map[string]string{"CANARY_TOKEN": "unbound-sentinel"}, snapshot.Env)
	require.Equal(t, []sandbox.EgressProxySecret{{Name: "HOST_TOKEN", Value: "bound-sentinel", Hosts: []string{"api.example.com"}, MatchHeaders: []string{"authorization"}}}, snapshot.Bound)
	service := &WorkspaceService{repositorySecrets: injector}
	policy, err := service.workspaceEgressProxy(context.Background(), 7, "")
	require.ErrorContains(t, err, "machine secret environment is unavailable")
	require.Nil(t, policy)
	// A bound-only snapshot can reach only the existing relay, never request env.
	q.listSecretValuesFn = func(context.Context, int64) ([]db.ListSecretValuesRow, error) {
		return []db.ListSecretValuesRow{{Name: "HOST_TOKEN", ValueEncrypted: []byte("bound-sentinel"), Hosts: []string{"api.example.com"}, MatchHeaders: []string{"authorization"}}, {Name: "DEPLOY_KEY", ValueEncrypted: []byte("main-sentinel"), MainOnly: true}}, nil
	}
	policy, err = service.workspaceEgressProxy(context.Background(), 7, "")
	require.NoError(t, err)
	require.Equal(t, snapshot.Bound, policy.Secrets)
	q.listSecretValuesFn = func(context.Context, int64) ([]db.ListSecretValuesRow, error) {
		return nil, errors.New("database unavailable")
	}
	policy, err = service.workspaceEgressProxy(context.Background(), 7, "")
	require.Error(t, err)
	require.Nil(t, policy)
}
