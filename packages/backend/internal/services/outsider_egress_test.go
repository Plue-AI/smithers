package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/sandbox"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

type outsiderMarkedWorkspaceQuerier struct {
	mockWorkspaceQuerier
	marked map[string]bool
}

func (q *outsiderMarkedWorkspaceQuerier) IsOutsiderWorkspace(_ context.Context, id string) (bool, error) {
	return q.marked[id], nil
}

// A workspace that ran work started from an outsider's text reaches GitHub
// only for code, releases and archives: never an issue, comment or pull
// request conversation. A maintainer's workspace keeps the deployment's list.
func TestWorkspaceEgressWithholdsGitHubConversationFromOutsiderWorkspaces(t *testing.T) {
	t.Parallel()
	service := newWorkspaceServiceForTests(&outsiderMarkedWorkspaceQuerier{marked: map[string]bool{"ws-outsider": true}})
	ctx := context.Background()
	outsider, err := service.workspaceEgressProxy(ctx, 123, "ws-outsider")
	require.NoError(t, err)
	assert.Equal(t, sandbox.ConversationWithheldHostRules(), outsider.HostRules)
	require.NoError(t, outsider.Validate())
	maintainer, err := service.workspaceEgressProxy(ctx, 123, "ws-maintainer")
	require.NoError(t, err)
	assert.Empty(t, maintainer.HostRules)

	req, err := service.buildWorkspaceVMRequest(ctx, "", nil, 123, "ws-outsider", "container")
	require.NoError(t, err)
	require.NotNil(t, req.EgressProxy)
	assert.Equal(t, sandbox.ConversationWithheldHostRules(), req.EgressProxy.HostRules, "a fresh VM boots narrowed")
}

// An outsider's lane workspace is marked before it is provisioned, so the
// box boots with the narrowed egress and its credentials read no
// conversation; a maintainer's lane is not.
func TestMythicalOutsiderLaneIsMarkedBeforeItIsProvisioned(t *testing.T) {
	markedAtProvision := func(issue mythicalIssue, label gitHubLabelApplication) bool {
		o := newMythicalOrchestration(t)
		ctx := context.Background()
		marked := map[string]bool{}
		o.lanes.provision = func(id string) {
			outsider, err := o.service.queries().IsOutsiderWorkspace(ctx, id)
			require.NoError(t, err)
			marked[id] = outsider
		}
		require.NoError(t, o.service.ObserveIssue(ctx, o.repoID, issue, label))
		o.wake()
		item := o.item(issue.Number)
		require.NotEmpty(t, item.WorkspaceID, item.Reason)
		provisioned, ok := marked[item.WorkspaceID]
		require.True(t, ok, "the lane was provisioned")
		return provisioned
	}
	assert.True(t, markedAtProvision(mythicalIssue{Number: 51, Title: "Outsider", Body: "fix", State: "open", Labels: []string{"todo"}}, maintainerTodo))
	assert.False(t, markedAtProvision(mythicalIssue{Number: 52, Title: "Maintainer", Body: "fix", State: "open", TextByMaintainer: true, Labels: []string{"todo"}},
		maintainerTodo))
}

type recordingOutsiderEgress struct {
	narrowed []string
	err      error
}

func (r *recordingOutsiderEgress) NarrowOutsiderEgress(_ context.Context, workspaceID string) error {
	r.narrowed = append(r.narrowed, workspaceID)
	return r.err
}

// A repository job's box may be running when its first outsider event
// arrives: the run is admitted only after the box's egress is narrowed.
func TestRepositoryJobOutsiderRunNarrowsItsBoxBeforeLaunch(t *testing.T) {
	_, _, service, gateway, input := repositoryJobFixture(t)
	ctx := context.Background()
	egress := &recordingOutsiderEgress{}
	service.SetOutsiderEgress(egress)
	input.Events = []RepositoryJobEventRule{{Type: "issues", Actions: []string{"opened", "labeled"}}}
	_, err := service.Register(ctx, "gateway", "token", "issues", input)
	require.NoError(t, err)
	admit := func(delivery string, number int, byMaintainer bool) {
		body := json.RawMessage(fmt.Sprintf(`{"action":"labeled","label":{"name":"smithers","smithers_applied_by_maintainer":true},"sender":{"id":7,"login":"maintainer","type":"User"},
			"issue":{"id":%d,"number":%d,"user":{"id":9,"login":"author"},"smithers_text_by_maintainer":%t,"labels":[{"name":"smithers"}]}}`, 100+number, number, byMaintainer))
		require.NoError(t, service.AdmitGitHubEvent(ctx, gateway.target.RepositoryID, db.GithubWebhookJob{DeliveryID: delivery, Payload: body},
			TriggerEvent{Type: "issues", Action: "labeled"}))
	}
	admit("maintainer", 41, true)
	repositoryJobPoll(t, service, gateway)
	assert.Empty(t, egress.narrowed, "a maintainer's run leaves the box alone")
	launched := len(gateway.launches)

	egress.err = errors.New("the box could not be reauthorized")
	admit("outsider", 42, false)
	_ = service.PollOnce(ctx)
	require.NoError(t, gateway.projectPending(ctx))
	assert.Equal(t, []string{input.WorkspaceID}, egress.narrowed)
	assert.Equal(t, launched, len(gateway.launches), "no outsider run starts on a box whose egress is not narrowed")
}

type outsiderSealQuerier struct {
	mockWorkspaceQuerier
	sealed bool
}

func (q *outsiderSealQuerier) IsOutsiderWorkspace(context.Context, string) (bool, error) {
	return true, nil
}

func (q *outsiderSealQuerier) IsOutsiderWorkspaceEgressSealed(context.Context, string) (bool, error) {
	return q.sealed, nil
}

func (q *outsiderSealQuerier) SealOutsiderWorkspaceEgress(context.Context, string) error {
	q.sealed = true
	return nil
}

// A box that booted before its workspace was marked runs the deployment's
// full egress: it is suspended once, so its next start is narrowed, and the
// workspace is sealed. A boot in flight is waited for, never sealed.
func TestNarrowOutsiderEgressSuspendsABoxThatBootedBeforeTheMark(t *testing.T) {
	t.Parallel()
	status, suspended := "running", 0
	q := &outsiderSealQuerier{mockWorkspaceQuerier: mockWorkspaceQuerier{
		getWorkspaceFn: func(_ context.Context, id string) (db.Workspace, error) {
			workspace := sampleDBWorkspace(id)
			workspace.Status, workspace.VmID = status, "vm-box"
			return workspace, nil
		},
		getWorkspaceByRepoFn: func(_ context.Context, arg db.GetWorkspaceByRepoParams) (db.Workspace, error) {
			workspace := sampleDBWorkspace(arg.ID)
			workspace.Status, workspace.VmID = status, "vm-box"
			return workspace, nil
		},
		suspendRunningWorkspaceFn: func(_ context.Context, id string) (db.Workspace, error) {
			status = "suspended"
			workspace := sampleDBWorkspace(id)
			workspace.Status, workspace.VmID = status, "vm-box"
			return workspace, nil
		},
	}}
	service := newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
		suspendVMFn: func(context.Context, string) (sandbox.SuspendResult, error) {
			suspended++
			return sandbox.SuspendResult{}, nil
		},
	}))
	ctx := context.Background()

	status = "starting"
	require.Error(t, service.NarrowOutsiderEgress(ctx, "ws-box"))
	assert.False(t, q.sealed, "a boot in flight may have computed its policy before the mark")

	status = "running"
	require.NoError(t, service.NarrowOutsiderEgress(ctx, "ws-box"))
	assert.Equal(t, 1, suspended)
	assert.True(t, q.sealed)

	status = "running"
	require.NoError(t, service.NarrowOutsiderEgress(ctx, "ws-box"))
	assert.Equal(t, 1, suspended, "a sealed workspace's boxes all booted narrowed")
}

type markingWorkspaceQuerier struct {
	mockWorkspaceQuerier
	// markedAfter is how many mark reads answer false first.
	markedAfter int
	reads       int
}

func (q *markingWorkspaceQuerier) IsOutsiderWorkspace(context.Context, string) (bool, error) {
	q.reads++
	return q.reads > q.markedAfter, nil
}

// A marked workspace's box resumes with the narrowed egress; a resume whose
// policy predates the mark is suspended again once the box is visibly
// running, so it never keeps the deployment's full egress.
func TestResumeNarrowsAMarkedBoxAndRefusesOneThatPredatesTheMark(t *testing.T) {
	t.Parallel()
	resume := func(markedAfter int) (*sandbox.EgressProxyPolicy, int, error) {
		var applied *sandbox.EgressProxyPolicy
		suspended := 0
		q := &markingWorkspaceQuerier{markedAfter: markedAfter}
		service := newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
			startVMFn: func(_ context.Context, _ string, req sandbox.StartRequest) (sandbox.StartResult, error) {
				applied = req.EgressProxy
				return sandbox.StartResult{}, nil
			},
			suspendVMFn: func(context.Context, string) (sandbox.SuspendResult, error) {
				suspended++
				return sandbox.SuspendResult{}, nil
			},
		}))
		workspace := sampleDBWorkspace("ws-box")
		workspace.Status = "suspended"
		_, err := service.resumeWorkspaceVM(context.Background(), workspace)
		return applied, suspended, err
	}
	applied, suspended, err := resume(0)
	require.NoError(t, err)
	require.NotNil(t, applied)
	assert.Equal(t, sandbox.ConversationWithheldHostRules(), applied.HostRules)
	assert.Zero(t, suspended)

	applied, suspended, err = resume(1)
	require.Error(t, err)
	assert.Nil(t, applied, "the policy was computed before the mark")
	assert.Equal(t, 1, suspended)
}

type conversationRuntime struct {
	workspaceapi.WorkspaceRuntime
	calls []string
}

func (r *conversationRuntime) InspectWorkspace(_ context.Context, id string) (workspaceapi.Workspace, error) {
	return workspaceapi.Workspace{ID: id, State: workspaceapi.WorkspaceStopped}, nil
}

func (r *conversationRuntime) Capabilities() workspaceapi.WorkspaceCapabilities {
	return workspaceapi.WorkspaceCapabilities{}
}

func (r *conversationRuntime) StartWorkspace(_ context.Context, id string) (workspaceapi.Workspace, error) {
	r.calls = append(r.calls, "start "+id)
	return workspaceapi.Workspace{ID: id, State: workspaceapi.WorkspaceRunning}, nil
}

type withholdingRuntime struct{ conversationRuntime }

func (r *withholdingRuntime) WithholdConversationEgress(_ context.Context, id string) error {
	r.calls = append(r.calls, "withhold "+id)
	return nil
}

// On a workspace runtime the runtime owns the box's proxy: a marked
// workspace starts only after the runtime withholds GitHub conversation
// from its egress, and a runtime that cannot refuses the start. A repository
// job's running box is narrowed by the runtime, then sealed.
func TestWorkspaceRuntimeWithholdsConversationBeforeAMarkedBoxStarts(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	row := sampleDBWorkspace("ws-box")
	row.Status, row.VmID = "suspended", "vm-box"

	plain := &conversationRuntime{}
	q := &outsiderSealQuerier{}
	service := newWorkspaceServiceForTests(q, WithWorkspaceRuntime(plain))
	_, err := service.ensureRuntimeWorkspaceRunningLocked(ctx, row, row.UserID)
	require.Error(t, err)
	assert.Empty(t, plain.calls, "no box starts without the narrowed egress")
	require.Error(t, service.NarrowOutsiderEgress(ctx, row.ID))
	assert.False(t, q.sealed)

	withholding := &withholdingRuntime{}
	q = &outsiderSealQuerier{}
	service = newWorkspaceServiceForTests(q, WithWorkspaceRuntime(withholding))
	// The fake runtime starts the box and stops short of a repository.
	_, _ = service.ensureRuntimeWorkspaceRunningLocked(ctx, row, row.UserID)
	require.NoError(t, service.NarrowOutsiderEgress(ctx, row.ID))
	assert.True(t, q.sealed)
	assert.Equal(t, []string{"withhold ws-box", "start ws-box", "withhold ws-box"}, withholding.calls)

	maintainer := &conversationRuntime{}
	service = newWorkspaceServiceForTests(&mockWorkspaceQuerier{}, WithWorkspaceRuntime(maintainer))
	_, _ = service.ensureRuntimeWorkspaceRunningLocked(ctx, row, row.UserID)
	assert.Equal(t, []string{"start ws-box"}, maintainer.calls, "an unmarked workspace needs nothing of its runtime")
}
