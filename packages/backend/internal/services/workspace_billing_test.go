package services

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

type sandboxPolicyStub struct {
	BillingPolicy
	entitlement SandboxEntitlement
	err         error
}

func (p sandboxPolicyStub) AuthorizeSandboxStart(context.Context, int64) error { return p.err }
func (p sandboxPolicyStub) SandboxEntitlement(context.Context, int64) (SandboxEntitlement, error) {
	return p.entitlement, p.err
}

type workspaceIdleStore struct {
	*mockWorkspaceQuerier
	stamped db.SetWorkspaceIdleTimeoutParams
}

func (q *workspaceIdleStore) SetWorkspaceIdleTimeout(_ context.Context, arg db.SetWorkspaceIdleTimeoutParams) (db.Workspace, error) {
	q.stamped = arg
	return db.Workspace{ID: arg.ID, IdleTimeoutSecs: arg.IdleTimeoutSecs}, nil
}

// Since de86a86992 (#3565) createWorkspaceRow reserves the branch machine in
// one PostgreSQL transaction behind the activation providers, so the plan's
// idle deadline is read back from the row that transaction inserted.
func TestWorkspacePlanIdleTimeoutStamping(t *testing.T) {
	pool := newProductTestPool(t)
	user, repo := setupTestUserAndRepo(t, pool)
	machines := func(q WorkspaceQuerier, opts ...WorkspaceServiceOption) *WorkspaceService {
		return NewWorkspaceService(q, append([]WorkspaceServiceOption{
			WithWorkspaceTransactions(pool), WithBranchMachineProviders(branchMachineTestProviders()),
		}, opts...)...)
	}
	for _, tc := range []struct {
		name           string
		plan           int64
		override, want int32
	}{
		{"free", 1800, 0, 1800}, {"pro", 14400, 0, 14400}, {"max", 0, 0, 0},
		{"override cannot raise", 1800, 14400, 1800}, {"override lowers", 14400, 900, 900}, {"max override lowers", 0, 900, 900},
	} {
		t.Run(tc.name, func(t *testing.T) {
			q := &workspaceIdleStore{mockWorkspaceQuerier: &mockWorkspaceQuerier{}}
			q.getRepoByIDFn = func(context.Context, int64) (db.Repository, error) {
				return db.Repository{WorkspaceIdleTimeoutSecs: tc.override}, nil
			}
			svc := machines(q, WithWorkspaceBillingPolicy(sandboxPolicyStub{entitlement: SandboxEntitlement{IdleTimeoutSecs: tc.plan}}))
			workspace, err := svc.createWorkspaceRow(context.Background(), db.CreateWorkspaceParams{UserID: user, RepositoryID: repo, TargetBookmark: "idle/" + strings.ReplaceAll(tc.name, " ", "-"), Kind: "container", Status: "starting"})
			require.NoError(t, err)
			assert.Equal(t, tc.want, workspace.IdleTimeoutSecs)
			stored, err := db.New(pool).GetWorkspace(context.Background(), workspace.ID)
			require.NoError(t, err)
			assert.Equal(t, tc.want, stored.IdleTimeoutSecs, "the reservation inserts the plan's deadline")
			resumed, err := svc.stampResumedWorkspaceIdleTimeout(context.Background(), workspace)
			require.NoError(t, err)
			assert.Equal(t, tc.want, q.stamped.IdleTimeoutSecs)
			assert.Equal(t, tc.want, resumed.IdleTimeoutSecs)
			scoped := svc.withWorkspaceIdleTimeout(workspace)
			assert.Equal(t, int64(tc.want), scoped.workspaceIdleTimeoutSeconds)
			assert.Equal(t, int64(1800), svc.workspaceIdleTimeoutSeconds)
		})
	}
	t.Run("nil keeps defaults", func(t *testing.T) {
		workspace, err := machines(&mockWorkspaceQuerier{}).createWorkspaceRow(context.Background(), db.CreateWorkspaceParams{UserID: user, RepositoryID: repo, TargetBookmark: "idle/no-billing", Kind: "container", Status: "starting"})
		require.NoError(t, err)
		assert.Equal(t, int32(1800), workspace.IdleTimeoutSecs, "without billing the column default applies")
	})
}

// The plan check precedes the hard caps. Since c240bd3cf7 (#3568) a resume
// first passes machine admission and the activation providers, so the
// resume composes them to reach the plan check.
func TestSandboxPlanChecksPrecedeHardCaps(t *testing.T) {
	denied := pkgerrors.New(pkgerrors.CodePlanLimitExceeded, "plan denied")
	policy := sandboxPolicyStub{err: denied}
	workspace := NewWorkspaceService(nil, WithWorkspaceBillingPolicy(policy))
	require.ErrorIs(t, workspace.enforceWorkspaceQuota(context.Background(), 7), denied)
	resume := NewWorkspaceService(nil, WithWorkspaceBillingPolicy(policy), WithWorkspaceTransactions(unopenedBranchTransactions{t}), WithBranchMachineProviders(branchMachineTestProviders()))
	resume.EnableMachineAdmission(nil)
	_, err := resume.resumeWorkspaceVM(context.Background(), db.Workspace{UserID: 7})
	require.ErrorIs(t, err, denied)
	dispatch := &agentDispatch{ctx: context.Background(), input: DispatchAgentRunInput{UserID: 7}, svc: &AgentService{billing: policy}}
	require.ErrorIs(t, dispatch.enforceConcurrencyCap(), denied)
	assert.Same(t, denied, workspaceProvisioningError("resume sandbox", denied))
}

func TestAgentDispatchPlanIdleTimeout(t *testing.T) {
	for _, seconds := range []int64{0, 1800, 14400} {
		d := &agentDispatch{ctx: context.Background(), input: DispatchAgentRunInput{UserID: 7}, svc: &AgentService{billing: sandboxPolicyStub{entitlement: SandboxEntitlement{IdleTimeoutSecs: seconds}}, sandboxConfig: AgentSandboxConfig{IdleTimeout: 5 * time.Minute}}}
		require.NoError(t, d.enforceConcurrencyCap())
		want := 5 * time.Minute
		if seconds != 0 {
			want = time.Duration(seconds) * time.Second
		}
		assert.Equal(t, want, d.sandboxConfig.IdleTimeout)
		assert.Equal(t, 5*time.Minute, d.svc.sandboxConfig.IdleTimeout)
	}
}

func TestUnlimitedBillingPolicyIdleControlsRemainDeliberate(t *testing.T) {
	t.Parallel()

	policy := NewUnlimitedBillingPolicy()
	q := &workspaceIdleStore{mockWorkspaceQuerier: &mockWorkspaceQuerier{}}
	q.getRepoByIDFn = func(context.Context, int64) (db.Repository, error) {
		return db.Repository{WorkspaceIdleTimeoutSecs: 900}, nil
	}
	workspace := NewWorkspaceService(q, WithWorkspaceBillingPolicy(policy))
	idle, err := workspace.sandboxIdleTimeout(t.Context(), 7, 9)
	require.NoError(t, err)
	assert.Equal(t, int32(900), idle, "repository idle policy still lowers an unlimited billing entitlement")

	dispatch := &agentDispatch{
		ctx:   t.Context(),
		input: DispatchAgentRunInput{UserID: 7},
		svc: &AgentService{
			billing:       policy,
			sandboxConfig: AgentSandboxConfig{IdleTimeout: 5 * time.Minute},
		},
	}
	require.NoError(t, dispatch.enforceConcurrencyCap())
	assert.Equal(t, 5*time.Minute, dispatch.sandboxConfig.IdleTimeout,
		"no billing idle deadline preserves the operator-configured agent idle policy")
}
