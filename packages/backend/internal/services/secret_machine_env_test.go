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

func TestSecretMachineEnvTrustedMainAuthority(t *testing.T) {
	run := db.WorkflowRun{ID: 1, RepositoryID: 7, TriggerEvent: "invoke", TriggerRef: "main"}
	repo := db.Repository{ID: 7, DefaultBookmark: "main"}
	good := trustedMainEvidence{PersonID: 3, Active: true, Role: InstallMaintainer, Manual: true, BackgroundWorkspace: "background", Workspace: "background", SourceRevision: "0123456789012345678901234567890123456789", TrustedRevision: "0123456789012345678901234567890123456789"}
	cases := []struct {
		name    string
		mutate  func(*db.WorkflowRun, *trustedMainEvidence)
		allowed bool
	}{
		{"maintainer manual main", func(*db.WorkflowRun, *trustedMainEvidence) {}, true},
		{"owner manual main", func(_ *db.WorkflowRun, e *trustedMainEvidence) { e.Role = InstallOwner }, true},
		{"heads main", func(r *db.WorkflowRun, _ *trustedMainEvidence) { r.TriggerRef = "refs/heads/main" }, true},
		{"member", func(_ *db.WorkflowRun, e *trustedMainEvidence) { e.Role = InstallMember }, false},
		{"removed", func(_ *db.WorkflowRun, e *trustedMainEvidence) { e.Role = "" }, false},
		{"inactive", func(_ *db.WorkflowRun, e *trustedMainEvidence) { e.Active = false }, false},
		{"agent", func(r *db.WorkflowRun, e *trustedMainEvidence) { r.TriggerEvent = "agent"; e.Manual = false }, false},
		{"outsider", func(_ *db.WorkflowRun, e *trustedMainEvidence) { e.Outsider = true }, false},
		{"push", func(r *db.WorkflowRun, _ *trustedMainEvidence) { r.TriggerEvent = "push" }, false},
		{"schedule", func(r *db.WorkflowRun, _ *trustedMainEvidence) { r.TriggerEvent = "schedule" }, false},
		{"empty ref", func(r *db.WorkflowRun, _ *trustedMainEvidence) { r.TriggerRef = "" }, false},
		{"item", func(r *db.WorkflowRun, _ *trustedMainEvidence) { r.TriggerRef = "smithers/item" }, false},
		{"scratch", func(r *db.WorkflowRun, _ *trustedMainEvidence) { r.TriggerRef = "scratch/alice/work" }, false},
		{"main tag", func(r *db.WorkflowRun, _ *trustedMainEvidence) { r.TriggerRef = "refs/tags/main" }, false},
		{"branch machine", func(_ *db.WorkflowRun, e *trustedMainEvidence) { e.BackgroundWorkspace = "" }, false},
		{"other machine", func(_ *db.WorkflowRun, e *trustedMainEvidence) { e.Workspace = "scratch" }, false},
		{"shared machine", func(_ *db.WorkflowRun, e *trustedMainEvidence) { e.Shared = true }, false},
		{"unresolved", func(_ *db.WorkflowRun, e *trustedMainEvidence) { e.TrustedRevision = "" }, false},
		{"wrong source", func(_ *db.WorkflowRun, e *trustedMainEvidence) {
			e.SourceRevision = "ffffffffffffffffffffffffffffffffffffffff"
		}, false},
		{"no person", func(_ *db.WorkflowRun, e *trustedMainEvidence) { e.PersonID = 0 }, false},
		{"other repository", func(r *db.WorkflowRun, _ *trustedMainEvidence) { r.RepositoryID = 8 }, false},
		{"no stored run", func(r *db.WorkflowRun, _ *trustedMainEvidence) { r.ID = 0 }, false},
		{"delegated origin", func(_ *db.WorkflowRun, e *trustedMainEvidence) { e.Manual = false }, false},
	}
	injector := NewSecretInjector(&mockSecretInjectionQuerier{listSecretValuesFn: func(context.Context, int64) ([]db.ListSecretValuesRow, error) {
		return []db.ListSecretValuesRow{{Name: "ALL", ValueEncrypted: []byte("all")}, {Name: "MAIN", ValueEncrypted: []byte("main"), MainOnly: true}, {Name: "BOUND", ValueEncrypted: []byte("bound"), Hosts: []string{"api.example.com"}, MatchHeaders: []string{"authorization"}}}, nil
	}}, webhook.NoopSecretCodec{})
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r, e := run, good
			tc.mutate(&r, &e)
			trusted := workflowRunOnTrustedMain(r, repo, e)
			require.Equal(t, tc.allowed, trusted)
			snapshot, err := injector.RepositorySecrets(t.Context(), 7, trusted)
			require.NoError(t, err)
			require.Equal(t, "all", snapshot.Env["ALL"])
			_, main := snapshot.Env["MAIN"]
			require.Equal(t, tc.allowed, main)
			require.NotContains(t, snapshot.Env, "BOUND")
			require.Len(t, snapshot.Bound, 1)
			require.Equal(t, "bound", snapshot.Bound[0].Value)
		})
	}
}
