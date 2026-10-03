package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/runtimeports"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
	"github.com/smithersai/smithers/packages/backend/internal/webhooks"
)

// ─── Mock querier for workflow run service ────────────────────────────────────

type mockWorkflowRunQuerier struct {
	getRepoByIDFn        func(ctx context.Context, id int64) (db.Repository, error)
	getUserByIDFn        func(ctx context.Context, id int64) (db.User, error)
	getOrgByIDFn         func(ctx context.Context, id int64) (db.Organization, error)
	listDefsFn           func(ctx context.Context, arg db.ListWorkflowDefinitionsByRepoParams) ([]db.WorkflowDefinition, error)
	getDefFn             func(ctx context.Context, arg db.GetWorkflowDefinitionParams) (db.WorkflowDefinition, error)
	ensureDefRefFn       func(ctx context.Context, arg db.EnsureWorkflowDefinitionReferenceParams) (db.WorkflowDefinition, error)
	createRunFn          func(ctx context.Context, arg db.CreateWorkflowRunParams) (db.WorkflowRun, error)
	createStepFn         func(ctx context.Context, arg db.CreateWorkflowStepParams) (db.WorkflowStep, error)
	createTaskFn         func(ctx context.Context, arg db.CreateWorkflowTaskParams) (db.WorkflowTask, error)
	createCommitStatusFn func(ctx context.Context, arg db.CreateCommitStatusParams) (db.CommitStatus, error)
	updateCheckRunFn     func(ctx context.Context, arg db.UpdateWorkflowRunCheckRunParams) (db.WorkflowRun, error)
	getRunFn             func(ctx context.Context, arg db.GetWorkflowRunParams) (db.WorkflowRun, error)
	updateTokenFn        func(ctx context.Context, arg db.UpdateWorkflowRunAgentTokenParams) (db.WorkflowRun, error)
	cancelRunFn          func(ctx context.Context, id int64) error
	cancelTaskFn         func(ctx context.Context, workflowRunID int64) error
	resumeRunFn          func(ctx context.Context, id int64) error
	resumeTasksFn        func(ctx context.Context, workflowRunID int64) error
	resumeStepsFn        func(ctx context.Context, workflowRunID int64) error
	notifyRunFn          func(ctx context.Context, arg db.NotifyWorkflowRunEventParams) error
	bindAlertRunFn       func(ctx context.Context, arg runtimeports.BindAlertRemediationJobWorkflowRunAtAttemptParams) (int64, error)
	getBookmarkCommitFn  func(ctx context.Context, arg db.GetRepositoryBookmarkCommitIDParams) (string, error)

	createRunCalls      []db.CreateWorkflowRunParams
	createStepCalls     []db.CreateWorkflowStepParams
	createTaskCalls     []db.CreateWorkflowTaskParams
	createStatusCalls   []db.CreateCommitStatusParams
	updateCheckRunCalls []db.UpdateWorkflowRunCheckRunParams
	updateTokenCalls    []db.UpdateWorkflowRunAgentTokenParams
	getRunCalls         []db.GetWorkflowRunParams
	cancelRunCalls      []int64
	failRunCalls        []int64
	cancelTaskCalls     []int64
	resumeRunCalls      []int64
	resumeTasksCalls    []int64
	resumeStepsCalls    []int64
	listDefsCount       int
	getDefCount         int
	bindAlertRunCalls   []runtimeports.BindAlertRemediationJobWorkflowRunAtAttemptParams
}

func (m *mockWorkflowRunQuerier) GetRepositoryBookmarkCommitID(ctx context.Context, arg db.GetRepositoryBookmarkCommitIDParams) (string, error) {
	if m.getBookmarkCommitFn != nil {
		return m.getBookmarkCommitFn(ctx, arg)
	}
	return strings.Repeat("c", 40), nil
}

func (m *mockWorkflowRunQuerier) GetRepoByID(ctx context.Context, id int64) (db.Repository, error) {
	if m.getRepoByIDFn != nil {
		return m.getRepoByIDFn(ctx, id)
	}
	return db.Repository{
		ID:              id,
		Name:            "demo",
		DefaultBookmark: "main",
		UserID:          pgtype.Int8{Int64: 1, Valid: true},
	}, nil
}

func (m *mockWorkflowRunQuerier) GetUserByID(ctx context.Context, id int64) (db.User, error) {
	if m.getUserByIDFn != nil {
		return m.getUserByIDFn(ctx, id)
	}
	return db.User{ID: id, Username: "testuser"}, nil
}

func (m *mockWorkflowRunQuerier) GetOrgByID(ctx context.Context, id int64) (db.Organization, error) {
	if m.getOrgByIDFn != nil {
		return m.getOrgByIDFn(ctx, id)
	}
	return db.Organization{ID: id, Name: "testorg"}, nil
}

func (m *mockWorkflowRunQuerier) ListWorkflowDefinitionsByRepo(ctx context.Context, arg db.ListWorkflowDefinitionsByRepoParams) ([]db.WorkflowDefinition, error) {
	m.listDefsCount++
	if m.listDefsFn != nil {
		return m.listDefsFn(ctx, arg)
	}
	return nil, nil
}

func (m *mockWorkflowRunQuerier) GetWorkflowDefinition(ctx context.Context, arg db.GetWorkflowDefinitionParams) (db.WorkflowDefinition, error) {
	m.getDefCount++
	if m.getDefFn != nil {
		return m.getDefFn(ctx, arg)
	}
	return db.WorkflowDefinition{}, pgx.ErrNoRows
}

func (m *mockWorkflowRunQuerier) EnsureWorkflowDefinitionReference(ctx context.Context, arg db.EnsureWorkflowDefinitionReferenceParams) (db.WorkflowDefinition, error) {
	if m.ensureDefRefFn != nil {
		return m.ensureDefRefFn(ctx, arg)
	}
	return db.WorkflowDefinition{
		ID:           999,
		RepositoryID: arg.RepositoryID,
		Name:         arg.Name,
		Path:         arg.Path,
		Config:       arg.Config,
		IsActive:     false,
	}, nil
}

func (m *mockWorkflowRunQuerier) CreateWorkflowRun(ctx context.Context, arg db.CreateWorkflowRunParams) (db.WorkflowRun, error) {
	m.createRunCalls = append(m.createRunCalls, arg)
	if m.createRunFn != nil {
		return m.createRunFn(ctx, arg)
	}
	return db.WorkflowRun{
		ID:                   int64(len(m.createRunCalls)),
		RepositoryID:         arg.RepositoryID,
		WorkflowDefinitionID: arg.WorkflowDefinitionID,
		Status:               arg.Status,
		TriggerEvent:         arg.TriggerEvent,
		TriggerRef:           arg.TriggerRef,
		TriggerCommitSha:     arg.TriggerCommitSha,
	}, nil
}

func (m *mockWorkflowRunQuerier) BindAlertRemediationJobWorkflowRunAtAttempt(ctx context.Context, arg runtimeports.BindAlertRemediationJobWorkflowRunAtAttemptParams) (int64, error) {
	m.bindAlertRunCalls = append(m.bindAlertRunCalls, arg)
	if m.bindAlertRunFn != nil {
		return m.bindAlertRunFn(ctx, arg)
	}
	return 1, nil
}

func (m *mockWorkflowRunQuerier) CreateWorkflowStep(ctx context.Context, arg db.CreateWorkflowStepParams) (db.WorkflowStep, error) {
	m.createStepCalls = append(m.createStepCalls, arg)
	if m.createStepFn != nil {
		return m.createStepFn(ctx, arg)
	}
	return db.WorkflowStep{ID: int64(len(m.createStepCalls))}, nil
}

func (m *mockWorkflowRunQuerier) CreateWorkflowTask(ctx context.Context, arg db.CreateWorkflowTaskParams) (db.WorkflowTask, error) {
	m.createTaskCalls = append(m.createTaskCalls, arg)
	if m.createTaskFn != nil {
		return m.createTaskFn(ctx, arg)
	}
	return db.WorkflowTask{ID: int64(len(m.createTaskCalls)), WorkflowStepID: arg.WorkflowStepID}, nil
}

func (m *mockWorkflowRunQuerier) CreateCommitStatus(ctx context.Context, arg db.CreateCommitStatusParams) (db.CommitStatus, error) {
	m.createStatusCalls = append(m.createStatusCalls, arg)
	if m.createCommitStatusFn != nil {
		return m.createCommitStatusFn(ctx, arg)
	}
	return db.CommitStatus{
		ID:            int64(len(m.createStatusCalls)),
		RepositoryID:  arg.RepositoryID,
		ChangeID:      arg.ChangeID,
		CommitSha:     arg.CommitSha,
		Context:       arg.Context,
		Status:        arg.Status,
		Description:   arg.Description,
		TargetUrl:     arg.TargetUrl,
		WorkflowRunID: arg.WorkflowRunID,
	}, nil
}

func (m *mockWorkflowRunQuerier) UpdateWorkflowRunCheckRun(ctx context.Context, arg db.UpdateWorkflowRunCheckRunParams) (db.WorkflowRun, error) {
	m.updateCheckRunCalls = append(m.updateCheckRunCalls, arg)
	if m.updateCheckRunFn != nil {
		return m.updateCheckRunFn(ctx, arg)
	}
	return db.WorkflowRun{ID: arg.ID}, nil
}

func (m *mockWorkflowRunQuerier) GetWorkflowRun(ctx context.Context, arg db.GetWorkflowRunParams) (db.WorkflowRun, error) {
	m.getRunCalls = append(m.getRunCalls, arg)
	if m.getRunFn != nil {
		return m.getRunFn(ctx, arg)
	}
	return db.WorkflowRun{}, pgx.ErrNoRows
}

func (m *mockWorkflowRunQuerier) UpdateWorkflowRunAgentToken(ctx context.Context, arg db.UpdateWorkflowRunAgentTokenParams) (db.WorkflowRun, error) {
	m.updateTokenCalls = append(m.updateTokenCalls, arg)
	if m.updateTokenFn != nil {
		return m.updateTokenFn(ctx, arg)
	}
	return db.WorkflowRun{ID: arg.ID}, nil
}

func (m *mockWorkflowRunQuerier) CancelWorkflowRun(ctx context.Context, id int64) error {
	m.cancelRunCalls = append(m.cancelRunCalls, id)
	if m.cancelRunFn != nil {
		return m.cancelRunFn(ctx, id)
	}
	return nil
}

func (m *mockWorkflowRunQuerier) FailWorkflowRun(_ context.Context, id int64) error {
	m.failRunCalls = append(m.failRunCalls, id)
	return nil
}

func (m *mockWorkflowRunQuerier) CancelWorkflowTasks(ctx context.Context, workflowRunID int64) error {
	m.cancelTaskCalls = append(m.cancelTaskCalls, workflowRunID)
	if m.cancelTaskFn != nil {
		return m.cancelTaskFn(ctx, workflowRunID)
	}
	return nil
}

func (m *mockWorkflowRunQuerier) ResumeWorkflowRun(ctx context.Context, id int64) error {
	m.resumeRunCalls = append(m.resumeRunCalls, id)
	if m.resumeRunFn != nil {
		return m.resumeRunFn(ctx, id)
	}
	return nil
}

func (m *mockWorkflowRunQuerier) ResumeWorkflowTasks(ctx context.Context, workflowRunID int64) error {
	m.resumeTasksCalls = append(m.resumeTasksCalls, workflowRunID)
	if m.resumeTasksFn != nil {
		return m.resumeTasksFn(ctx, workflowRunID)
	}
	return nil
}

func (m *mockWorkflowRunQuerier) ResumeWorkflowSteps(ctx context.Context, workflowRunID int64) error {
	m.resumeStepsCalls = append(m.resumeStepsCalls, workflowRunID)
	if m.resumeStepsFn != nil {
		return m.resumeStepsFn(ctx, workflowRunID)
	}
	return nil
}

func (m *mockWorkflowRunQuerier) NotifyWorkflowRunEvent(ctx context.Context, arg db.NotifyWorkflowRunEventParams) error {
	if m.notifyRunFn != nil {
		return m.notifyRunFn(ctx, arg)
	}
	return nil
}

var _ WorkflowRunQuerier = (*mockWorkflowRunQuerier)(nil)

type mockWorkflowRunCommitStatusWriter struct {
	updateFn func(ctx context.Context, workflowRunID int64, status string, description string, targetURL string) (db.CommitStatus, error)

	updateCalls []struct {
		workflowRunID int64
		status        string
		description   string
		targetURL     string
	}
	published []db.CommitStatus
}

func (m *mockWorkflowRunCommitStatusWriter) PublishCommitStatus(_ context.Context, status db.CommitStatus) {
	m.published = append(m.published, status)
}

type mockWorkflowRunCheckRunService struct {
	postFn func(
		ctx context.Context,
		installationID int64,
		owner string,
		repo string,
		input GitHubCheckRunInput,
	) (GitHubCheckRunResult, error)
	updateFn func(
		ctx context.Context,
		installationID int64,
		owner string,
		repo string,
		checkRunID int64,
		update GitHubCheckRunUpdate,
	) (GitHubCheckRunResult, error)

	postCalls []struct {
		installationID int64
		owner          string
		repo           string
		input          GitHubCheckRunInput
	}
	updateCalls []struct {
		installationID int64
		owner          string
		repo           string
		checkRunID     int64
		update         GitHubCheckRunUpdate
	}
}

func (m *mockWorkflowRunCheckRunService) PostCheckRun(
	ctx context.Context,
	installationID int64,
	owner string,
	repo string,
	input GitHubCheckRunInput,
) (GitHubCheckRunResult, error) {
	m.postCalls = append(m.postCalls, struct {
		installationID int64
		owner          string
		repo           string
		input          GitHubCheckRunInput
	}{
		installationID: installationID,
		owner:          owner,
		repo:           repo,
		input:          input,
	})
	if m.postFn != nil {
		return m.postFn(ctx, installationID, owner, repo, input)
	}
	return GitHubCheckRunResult{ID: 500, URL: "https://api.github.com/repos/testuser/demo/check-runs/500"}, nil
}

func (m *mockWorkflowRunCheckRunService) UpdateCheckRun(
	ctx context.Context,
	installationID int64,
	owner string,
	repo string,
	checkRunID int64,
	update GitHubCheckRunUpdate,
) (GitHubCheckRunResult, error) {
	m.updateCalls = append(m.updateCalls, struct {
		installationID int64
		owner          string
		repo           string
		checkRunID     int64
		update         GitHubCheckRunUpdate
	}{
		installationID: installationID,
		owner:          owner,
		repo:           repo,
		checkRunID:     checkRunID,
		update:         update,
	})
	if m.updateFn != nil {
		return m.updateFn(ctx, installationID, owner, repo, checkRunID, update)
	}
	return GitHubCheckRunResult{ID: checkRunID}, nil
}

func (m *mockWorkflowRunCommitStatusWriter) UpdateCommitStatusForWorkflowRun(ctx context.Context, workflowRunID int64, status string, description string, targetURL string) (db.CommitStatus, error) {
	m.updateCalls = append(m.updateCalls, struct {
		workflowRunID int64
		status        string
		description   string
		targetURL     string
	}{
		workflowRunID: workflowRunID,
		status:        status,
		description:   description,
		targetURL:     targetURL,
	})
	if m.updateFn != nil {
		return m.updateFn(ctx, workflowRunID, status, description, targetURL)
	}
	return db.CommitStatus{}, nil
}

func workflowRunAPIStatus(t *testing.T, err error) int {
	t.Helper()
	require.Error(t, err)
	apiErr, ok := err.(*pkgerrors.APIError)
	require.True(t, ok, "expected *pkgerrors.APIError, got %T: %v", err, err)
	return apiErr.Status
}

func makeWorkflowDef(id, repoID int64, name string, isActive bool, configJSON string) db.WorkflowDefinition {
	return db.WorkflowDefinition{
		ID:           id,
		RepositoryID: repoID,
		Name:         name,
		Path:         ".smithers/workflows/" + name + ".tsx",
		Config:       json.RawMessage(configJSON),
		IsActive:     isActive,
		CreatedAt:    time.Now(),
		UpdatedAt:    time.Now(),
	}
}

// ─── Validation ───────────────────────────────────────────────────────────────

func TestWorkflowRunService_DispatchForEvent_InvalidRepoID_ReturnsError(t *testing.T) {
	t.Parallel()
	svc := newCurrentPushTestService(&mockWorkflowRunQuerier{})
	_, err := svc.DispatchForEvent(context.Background(), DispatchForEventInput{
		RepositoryID: 0,
		Event:        TriggerEvent{Type: "push", Ref: "main"},
	})
	assert.Equal(t, 400, workflowRunAPIStatus(t, err))
}

func TestWorkflowRunService_DispatchForEvent_EmptyEventType_ReturnsError(t *testing.T) {
	t.Parallel()
	svc := newCurrentPushTestService(&mockWorkflowRunQuerier{})
	_, err := svc.DispatchForEvent(context.Background(), DispatchForEventInput{
		RepositoryID: 1,
		Event:        TriggerEvent{Ref: "main"},
	})
	assert.Equal(t, 400, workflowRunAPIStatus(t, err))
}

func TestWorkflowRunService_DispatchForEvent_NilQuerier_ReturnsInternalError(t *testing.T) {
	t.Parallel()
	svc := newCurrentPushTestService(nil)
	_, err := svc.DispatchForEvent(context.Background(), DispatchForEventInput{
		RepositoryID: 1,
		Event:        TriggerEvent{Type: "push", Ref: "main"},
	})
	assert.Equal(t, 500, workflowRunAPIStatus(t, err))
}

func TestWorkflowRunService_DispatchForEvent_ValidatesRepositorySecrets(t *testing.T) {
	t.Parallel()

	// Secret validation happens at task execution time, not dispatch time.
	// Verify that dispatch proceeds normally even with a secret injector
	// configured — secret names are validated when the runner picks up the
	// task, not when the workflow run is created.
	mock := &mockWorkflowRunQuerier{
		listDefsFn: func(_ context.Context, arg db.ListWorkflowDefinitionsByRepoParams) ([]db.WorkflowDefinition, error) {
			return []db.WorkflowDefinition{
				{
					ID:           1,
					RepositoryID: arg.RepositoryID,
					Name:         "ci",
					Path:         ".smithers/ci.ts",
					IsActive:     true,
					Config: json.RawMessage(`{
						"on":{"push":{}},
						"jobs":{"build":{"runs-on":"ubuntu-latest","steps":[{"run":"echo hi"}]}}
					}`),
				},
			}, nil
		},
	}

	svc := newCurrentPushTestService(
		mock,
		WithWorkflowRunSecretInjector(NewSecretInjector(&mockSecretInjectionQuerier{
			listSecretValuesFn: func(_ context.Context, repositoryID int64) ([]db.ListSecretValuesRow, error) {
				assert.Equal(t, int64(101), repositoryID)
				return []db.ListSecretValuesRow{
					{Name: "bad-secret-name", ValueEncrypted: []byte("secret")},
				}, nil
			},
		}, webhook.NoopSecretCodec{})),
	)

	results, err := svc.DispatchForEvent(context.Background(), DispatchForEventInput{
		RepositoryID: 101,
		Event:        TriggerEvent{Type: "push", Ref: "main"},
	})
	require.NoError(t, err)
	assert.Len(t, results, 1, "dispatch should succeed; secret validation is deferred to task execution")
	assert.NotEmpty(t, mock.createRunCalls)
}

// ─── No matching definitions ──────────────────────────────────────────────────

func TestWorkflowRunService_DispatchForEvent_NoDefinitions_ReturnsEmptyResults(t *testing.T) {
	t.Parallel()
	mock := &mockWorkflowRunQuerier{}
	svc := newCurrentPushTestService(mock)
	results, err := svc.DispatchForEvent(context.Background(), DispatchForEventInput{
		RepositoryID: 42,
		Event:        TriggerEvent{Type: "push", Ref: "main"},
	})
	require.NoError(t, err)
	assert.Empty(t, results)
	assert.Equal(t, 2, mock.listDefsCount)
}

func TestWorkflowRunService_DispatchForEvent_InactiveDefinitions_Skipped(t *testing.T) {
	t.Parallel()
	mock := &mockWorkflowRunQuerier{
		listDefsFn: func(_ context.Context, _ db.ListWorkflowDefinitionsByRepoParams) ([]db.WorkflowDefinition, error) {
			return []db.WorkflowDefinition{
				makeWorkflowDef(1, 42, "ci", false, `{"on":{"push":{}}}`),
			}, nil
		},
	}
	svc := newCurrentPushTestService(mock)
	results, err := svc.DispatchForEvent(context.Background(), DispatchForEventInput{
		RepositoryID: 42,
		Event:        TriggerEvent{Type: "push", Ref: "main"},
	})
	require.NoError(t, err)
	assert.Empty(t, results)
	assert.Empty(t, mock.createRunCalls, "inactive definition should not create a run")
}

func TestWorkflowRunService_DispatchForEvent_NoTriggerMatch_Skipped(t *testing.T) {
	t.Parallel()
	mock := &mockWorkflowRunQuerier{
		listDefsFn: func(_ context.Context, _ db.ListWorkflowDefinitionsByRepoParams) ([]db.WorkflowDefinition, error) {
			return []db.WorkflowDefinition{
				makeWorkflowDef(1, 42, "ci", true, `{"on":{"landing_request":{}}}`),
			}, nil
		},
	}
	svc := newCurrentPushTestService(mock)
	results, err := svc.DispatchForEvent(context.Background(), DispatchForEventInput{
		RepositoryID: 42,
		Event:        TriggerEvent{Type: "push", Ref: "main"},
	})
	require.NoError(t, err)
	assert.Empty(t, results)
	assert.Empty(t, mock.createRunCalls, "push event should not create runs for landing_request trigger")
}

// ─── Matching definitions → run creation ─────────────────────────────────────

func TestWorkflowRunService_DispatchForEvent_MatchingPush_CreatesRun(t *testing.T) {
	t.Parallel()
	mock := &mockWorkflowRunQuerier{
		listDefsFn: func(_ context.Context, arg db.ListWorkflowDefinitionsByRepoParams) ([]db.WorkflowDefinition, error) {
			assert.Equal(t, int64(42), arg.RepositoryID)
			return []db.WorkflowDefinition{
				makeWorkflowDef(1, 42, "ci", true, `{"on":{"push":{"branches":["main"]}},"jobs":{"build":{}}}`),
			}, nil
		},
	}
	svc := newCurrentPushTestService(mock)
	results, err := svc.DispatchForEvent(context.Background(), DispatchForEventInput{
		RepositoryID: 42,
		Event:        TriggerEvent{Type: "push", Ref: "main", CommitSHA: "abc123"},
	})
	require.NoError(t, err)
	require.Len(t, results, 1)
	assert.Equal(t, int64(1), results[0].WorkflowDefinitionID)
	assert.Greater(t, results[0].WorkflowRunID, int64(0))

	// Verify run creation params
	require.Len(t, mock.createRunCalls, 1)
	assert.Equal(t, int64(42), mock.createRunCalls[0].RepositoryID)
	assert.Equal(t, int64(1), mock.createRunCalls[0].WorkflowDefinitionID)
	assert.Equal(t, "queued", mock.createRunCalls[0].Status)
	assert.Equal(t, "push", mock.createRunCalls[0].TriggerEvent)
	assert.Equal(t, "main", mock.createRunCalls[0].TriggerRef)
	assert.Equal(t, "abc123", mock.createRunCalls[0].TriggerCommitSha)
}

func TestWorkflowRunService_AlertRemediationRunBindsBeforeDispatchCommit(t *testing.T) {
	t.Parallel()

	definitionID := int64(1)
	mock := &mockWorkflowRunQuerier{
		getDefFn: func(_ context.Context, _ db.GetWorkflowDefinitionParams) (db.WorkflowDefinition, error) {
			return makeWorkflowDef(definitionID, 42, "remediate", true, `{"on":{"webhook":{"event":"monitoring_alert"}},"jobs":{"fix":{}}}`), nil
		},
	}
	svc := newCurrentPushTestService(mock, WithWorkflowRunDefinitionCommitLoader(&recordingWorkflowDefinitionCommitLoader{
		result: workflowLoadResultForPath(
			".smithers/workflows/remediate.tsx",
			`{"on":{"webhook":{"event":"monitoring_alert"}},"jobs":{"fix":{}}}`,
		),
	}))
	results, err := svc.DispatchForEvent(context.Background(), DispatchForEventInput{
		RepositoryID:         42,
		WorkflowDefinitionID: &definitionID,
		Event: TriggerEvent{
			Type:      "monitoring_alert",
			CommitSHA: strings.Repeat("c", 40),
			Inputs: map[string]any{
				"remediation_job_id":         int64(7),
				"remediation_dispatch_token": strings.Repeat("a", 64),
			},
		},
		AlertRemediationBinding: &AlertRemediationRunBinding{
			JobID:            7,
			IncidentRowID:    8,
			DispatchToken:    strings.Repeat("a", 64),
			ExpectedAttempts: 2,
		},
	})
	require.NoError(t, err)
	require.Len(t, results, 1)
	require.Len(t, mock.bindAlertRunCalls, 1)
	assert.Equal(t, results[0].WorkflowRunID, mock.bindAlertRunCalls[0].WorkflowRunID.Int64)
	assert.Equal(t, int64(7), mock.bindAlertRunCalls[0].JobID)
	assert.Equal(t, int64(8), mock.bindAlertRunCalls[0].IncidentRowID)
	assert.Equal(t, int32(2), mock.bindAlertRunCalls[0].ExpectedAttempts)
	assert.Len(t, mock.createTaskCalls, 1)
	require.Len(t, mock.createRunCalls, 1)
	assert.Equal(t, strings.Repeat("c", 40), mock.createRunCalls[0].TriggerCommitSha)
}

func TestWorkflowRunService_AlertRemediationBindingFailureAbortsRowCreation(t *testing.T) {
	t.Parallel()

	definitionID := int64(1)
	mock := &mockWorkflowRunQuerier{
		getDefFn: func(_ context.Context, _ db.GetWorkflowDefinitionParams) (db.WorkflowDefinition, error) {
			return makeWorkflowDef(definitionID, 42, "remediate", true, `{"on":{"webhook":{"event":"monitoring_alert"}},"jobs":{"fix":{}}}`), nil
		},
		bindAlertRunFn: func(context.Context, runtimeports.BindAlertRemediationJobWorkflowRunAtAttemptParams) (int64, error) {
			return 0, nil
		},
	}
	svc := newCurrentPushTestService(mock, WithWorkflowRunDefinitionCommitLoader(&recordingWorkflowDefinitionCommitLoader{
		result: workflowLoadResultForPath(
			".smithers/workflows/remediate.tsx",
			`{"on":{"webhook":{"event":"monitoring_alert"}},"jobs":{"fix":{}}}`,
		),
	}))
	_, err := svc.DispatchForEvent(context.Background(), DispatchForEventInput{
		RepositoryID:         42,
		WorkflowDefinitionID: &definitionID,
		Event: TriggerEvent{
			Type:      "monitoring_alert",
			CommitSHA: strings.Repeat("c", 40),
		},
		AlertRemediationBinding: &AlertRemediationRunBinding{
			JobID:            7,
			IncidentRowID:    8,
			DispatchToken:    strings.Repeat("b", 64),
			ExpectedAttempts: 1,
		},
	})
	require.ErrorContains(t, err, "failed to bind alert remediation workflow run")
	assert.Empty(t, mock.createTaskCalls, "binding failure must stop before any runnable task exists")
}

// denyWorkflowDispatchBillingPolicy denies AuthorizeWorkflowDispatchCommitted
// (the CI-minute cap) without running its insert, while allowing everything else.
type denyWorkflowDispatchBillingPolicy struct {
	stubBillingPolicy
	dispatchCalls int
}

func (p *denyWorkflowDispatchBillingPolicy) AuthorizeWorkflowDispatchCommitted(context.Context, int64, func(context.Context, pgx.Tx) error) error {
	p.dispatchCalls++
	return pkgerrors.New(pkgerrors.CodePlanLimitExceeded, "CI minutes quota exceeded for the current billing plan")
}

// Issue #126 regression: every non-agent workflow run creation must be gated
// by the owner's CI-minute billing cap. A denied dispatch must create no run,
// step, or task rows and no external side effects.
func TestWorkflowRunService_DispatchForEvent_BillingDenied_CreatesNoRun(t *testing.T) {
	t.Parallel()
	mock := &mockWorkflowRunQuerier{
		listDefsFn: func(_ context.Context, _ db.ListWorkflowDefinitionsByRepoParams) ([]db.WorkflowDefinition, error) {
			return []db.WorkflowDefinition{
				makeWorkflowDef(1, 42, "ci", true, `{"on":{"push":{"branches":["main"]}},"jobs":{"build":{}}}`),
			}, nil
		},
	}
	policy := &denyWorkflowDispatchBillingPolicy{}
	svc := newCurrentPushTestService(mock, WithWorkflowRunBillingPolicy(policy))
	_, err := svc.DispatchForEvent(context.Background(), DispatchForEventInput{
		RepositoryID: 42,
		Event:        TriggerEvent{Type: "push", Ref: "main", CommitSHA: "abc123"},
	})
	assert.Equal(t, 402, workflowRunAPIStatus(t, err))
	assert.Equal(t, 1, policy.dispatchCalls)
	assert.Empty(t, mock.createRunCalls)
	assert.Empty(t, mock.createStepCalls)
	assert.Empty(t, mock.createTaskCalls)
}

func TestWorkflowRunService_DispatchForEvent_PostsInProgressGitHubCheckRun(t *testing.T) {
	t.Parallel()

	mock := &mockWorkflowRunQuerier{
		getRepoByIDFn: func(_ context.Context, id int64) (db.Repository, error) {
			return db.Repository{
				ID:              id,
				Name:            "demo",
				DefaultBookmark: "main",
				UserID:          pgtype.Int8{Int64: 1, Valid: true},
			}, nil
		},
		getUserByIDFn: func(_ context.Context, id int64) (db.User, error) {
			return db.User{ID: id, Username: "acme"}, nil
		},
		listDefsFn: func(_ context.Context, _ db.ListWorkflowDefinitionsByRepoParams) ([]db.WorkflowDefinition, error) {
			return []db.WorkflowDefinition{
				makeWorkflowDef(1, 42, "ci", true, `{"on":{"push":{}},"jobs":{"build":{}}}`),
			}, nil
		},
	}
	checkRunService := &mockWorkflowRunCheckRunService{
		postFn: func(
			_ context.Context,
			installationID int64,
			owner string,
			repo string,
			input GitHubCheckRunInput,
		) (GitHubCheckRunResult, error) {
			assert.Equal(t, int64(99), installationID)
			assert.Equal(t, "acme", owner)
			assert.Equal(t, "demo", repo)
			assert.Equal(t, "smithers / ci", input.Name)
			assert.Equal(t, "abc123", input.HeadSHA)
			assert.Equal(t, "in_progress", input.Status)
			return GitHubCheckRunResult{
				ID:      1234,
				HTMLURL: "https://github.com/acme/demo/runs/1234",
				URL:     "https://api.github.com/repos/acme/demo/check-runs/1234",
			}, nil
		},
	}
	svc := newCurrentPushTestService(mock, WithWorkflowRunGitHubCheckRunService(checkRunService), WithWorkflowRunGitHubInstallationResolver(&mockRunnerInstallationResolver{
		resolveFn: func(_ context.Context, ownerUserID, ownerOrgID int64, owner, repo string) (int64, error) {
			assert.Equal(t, int64(1), ownerUserID)
			assert.Equal(t, int64(0), ownerOrgID)
			assert.Equal(t, "acme", owner)
			assert.Equal(t, "demo", repo)
			return 99, nil
		},
	}))

	results, err := svc.DispatchForEvent(context.Background(), DispatchForEventInput{
		RepositoryID: 42,
		Event:        TriggerEvent{Type: "push", Ref: "main", CommitSHA: "abc123"},
	})
	require.NoError(t, err)
	require.Len(t, results, 1)
	require.Len(t, checkRunService.postCalls, 1)
	require.Len(t, mock.updateCheckRunCalls, 1)
	assert.Equal(t, results[0].WorkflowRunID, mock.updateCheckRunCalls[0].ID)
	assert.Equal(t, int64(1234), mock.updateCheckRunCalls[0].CheckRunID.Int64)
	assert.True(t, mock.updateCheckRunCalls[0].CheckRunID.Valid)
	assert.Equal(t, "https://github.com/acme/demo/runs/1234", mock.updateCheckRunCalls[0].CheckRunUrl.String)
	assert.True(t, mock.updateCheckRunCalls[0].CheckRunUrl.Valid)
}

func TestWorkflowRunService_DispatchForEvent_MatchingPush_CreatesStepAndTask(t *testing.T) {
	t.Parallel()
	mock := &mockWorkflowRunQuerier{
		listDefsFn: func(_ context.Context, _ db.ListWorkflowDefinitionsByRepoParams) ([]db.WorkflowDefinition, error) {
			return []db.WorkflowDefinition{
				makeWorkflowDef(1, 42, "ci", true, `{"on":{"push":{}},"jobs":{"build":{"runs-on":"ubuntu","steps":[{"run":"go test ./..."}]}}}`),
			}, nil
		},
	}
	svc := newCurrentPushTestService(mock)
	results, err := svc.DispatchForEvent(context.Background(), DispatchForEventInput{
		RepositoryID: 42,
		Event:        TriggerEvent{Type: "push", Ref: "main"},
	})
	require.NoError(t, err)
	require.Len(t, results, 1)
	require.Len(t, results[0].Steps, 1, "should have created one step (for the 'build' job)")

	// Verify step creation
	require.Len(t, mock.createStepCalls, 1)
	assert.Equal(t, "build", mock.createStepCalls[0].Name)
	assert.Equal(t, int64(1), mock.createStepCalls[0].Position)
	assert.Equal(t, "queued", mock.createStepCalls[0].Status)

	// Verify task creation
	require.Len(t, mock.createTaskCalls, 1)
	assert.Equal(t, "pending", mock.createTaskCalls[0].Status)
	assert.Equal(t, int64(42), mock.createTaskCalls[0].RepositoryID)

	// Task payload should contain job and event info
	var payload map[string]any
	require.NoError(t, json.Unmarshal(mock.createTaskCalls[0].Payload, &payload))
	assert.Equal(t, "build", payload["job"])
	assert.Equal(t, "push", payload["event"])
	assert.Equal(t, "main", payload["ref"])
	assert.Equal(t, "main", payload["default_bookmark"])
	assert.Equal(t, "main", payload["resolved_bookmark"])
	assert.Equal(t, ".smithers/workflows/ci.tsx", payload["workflow_path"])
	assert.Equal(t, "demo", payload["repo_name"])
	assert.Equal(t, "testuser", payload["repo_owner"])
	assert.Empty(t, mock.updateTokenCalls, "CI dispatch must not mint an orphaned agent token")
}

func TestWorkflowRunService_DispatchForEvent_IncludesChangeIDInTaskPayload(t *testing.T) {
	t.Parallel()

	mock := &mockWorkflowRunQuerier{
		listDefsFn: func(_ context.Context, _ db.ListWorkflowDefinitionsByRepoParams) ([]db.WorkflowDefinition, error) {
			return []db.WorkflowDefinition{
				makeWorkflowDef(1, 42, "ci", true, `{"on":{"push":{}},"jobs":{"build":{"runs-on":"ubuntu","steps":[{"run":"go test ./..."}]}}}`),
			}, nil
		},
	}

	svc := newCurrentPushTestService(mock)
	results, err := svc.DispatchForEvent(context.Background(), DispatchForEventInput{
		RepositoryID: 42,
		Event: TriggerEvent{
			Type:      "push",
			Ref:       "main",
			CommitSHA: "abc123",
			ChangeID:  "change-abc123",
		},
	})
	require.NoError(t, err)
	require.Len(t, results, 1)
	require.Len(t, mock.createTaskCalls, 1)

	var payload map[string]any
	require.NoError(t, json.Unmarshal(mock.createTaskCalls[0].Payload, &payload))
	assert.Equal(t, "change-abc123", payload["change_id"])
}

func TestWorkflowRunService_DispatchForEvent_UsesRepositoryDefaultBookmarkWhenRefMissing(t *testing.T) {
	t.Parallel()

	mock := &mockWorkflowRunQuerier{
		getRepoByIDFn: func(_ context.Context, id int64) (db.Repository, error) {
			return db.Repository{ID: id, Name: "demo", DefaultBookmark: "trunk"}, nil
		},
		listDefsFn: func(_ context.Context, _ db.ListWorkflowDefinitionsByRepoParams) ([]db.WorkflowDefinition, error) {
			return []db.WorkflowDefinition{
				makeWorkflowDef(1, 42, "nightly", true, `{"on":{"schedule":[{"cron":"0 0 * * *"}]},"jobs":{"build":{"runs-on":"ubuntu","steps":[{"run":"echo hi"}]}}}`),
			}, nil
		},
	}

	svc := newCurrentPushTestService(mock)
	results, err := svc.DispatchForEvent(context.Background(), DispatchForEventInput{
		RepositoryID: 42,
		Event:        TriggerEvent{Type: "schedule"},
	})
	require.NoError(t, err)
	require.Len(t, results, 1)
	require.Len(t, mock.createRunCalls, 1)
	assert.Equal(t, "trunk", mock.createRunCalls[0].TriggerRef)

	var payload map[string]any
	require.NoError(t, json.Unmarshal(mock.createTaskCalls[0].Payload, &payload))
	assert.Equal(t, "trunk", payload["ref"])
	assert.Equal(t, "trunk", payload["default_bookmark"])
	assert.Equal(t, "trunk", payload["resolved_bookmark"])
}

func TestWorkflowRunService_DispatchForEvent_CreatesPendingCommitStatus(t *testing.T) {
	t.Parallel()

	mock := &mockWorkflowRunQuerier{
		listDefsFn: func(_ context.Context, _ db.ListWorkflowDefinitionsByRepoParams) ([]db.WorkflowDefinition, error) {
			return []db.WorkflowDefinition{
				makeWorkflowDef(1, 42, "ci", true, `{"on":{"push":{}},"jobs":{"build":{"runs-on":"ubuntu","steps":[{"run":"echo hi"}]}}}`),
			}, nil
		},
	}
	statusWriter := &mockWorkflowRunCommitStatusWriter{}
	svc := newCurrentPushTestService(mock, WithWorkflowRunCommitStatusWriter(statusWriter))

	results, err := svc.DispatchForEvent(context.Background(), DispatchForEventInput{
		RepositoryID: 42,
		Event: TriggerEvent{
			Type:      "push",
			Ref:       "refs/heads/main",
			CommitSHA: "abc123",
		},
	})
	require.NoError(t, err)
	require.Len(t, results, 1)
	require.Len(t, mock.createStatusCalls, 1)
	assert.Equal(t, int64(42), mock.createStatusCalls[0].RepositoryID)
	assert.Equal(t, "abc123", mock.createStatusCalls[0].CommitSha.String)
	assert.Equal(t, "smithers/ci", mock.createStatusCalls[0].Context)
	assert.Equal(t, "pending", mock.createStatusCalls[0].Status)
	assert.Equal(t, results[0].WorkflowRunID, mock.createStatusCalls[0].WorkflowRunID.Int64)
	require.Len(t, statusWriter.published, 1)
	assert.Equal(t, results[0].WorkflowRunID, statusWriter.published[0].WorkflowRunID.Int64)
}

func TestWorkflowRunService_DispatchForEvent_CreatesPendingCommitStatusForLandingRequestChange(t *testing.T) {
	t.Parallel()

	mock := &mockWorkflowRunQuerier{
		listDefsFn: func(_ context.Context, _ db.ListWorkflowDefinitionsByRepoParams) ([]db.WorkflowDefinition, error) {
			return []db.WorkflowDefinition{
				makeWorkflowDef(1, 42, "ci", true, `{"on":{"landing_request":{"types":["opened"]}},"jobs":{"build":{"runs-on":"ubuntu","steps":[{"run":"echo hi"}]}}}`),
			}, nil
		},
	}
	statusWriter := &mockWorkflowRunCommitStatusWriter{}
	svc := newCurrentPushTestService(mock, WithWorkflowRunCommitStatusWriter(statusWriter))

	results, err := svc.DispatchForEvent(context.Background(), DispatchForEventInput{
		RepositoryID: 42,
		Event: TriggerEvent{
			Type:     "landing_request",
			Action:   "opened",
			ChangeID: "change-abc123",
		},
	})
	require.NoError(t, err)
	require.Len(t, results, 1)
	require.Len(t, mock.createStatusCalls, 1)
	assert.False(t, mock.createStatusCalls[0].CommitSha.Valid)
	assert.True(t, mock.createStatusCalls[0].ChangeID.Valid)
	assert.Equal(t, "change-abc123", mock.createStatusCalls[0].ChangeID.String)
	require.Len(t, statusWriter.published, 1)
}

func TestWorkflowRunService_DispatchForEvent_ResolvesScheduledRunCommitBeforeCreatingStatus(t *testing.T) {
	t.Parallel()

	commitSHA := strings.Repeat("a", 40)
	mock := &mockWorkflowRunQuerier{
		listDefsFn: func(_ context.Context, _ db.ListWorkflowDefinitionsByRepoParams) ([]db.WorkflowDefinition, error) {
			return []db.WorkflowDefinition{
				makeWorkflowDef(1, 42, "canary", true, `{"on":{"schedule":[{"cron":"*/5 * * * *"}]},"jobs":{"probe":{"steps":[{"run":"echo ok"}]}}}`),
			}, nil
		},
		getRepoByIDFn: func(_ context.Context, id int64) (db.Repository, error) {
			return db.Repository{ID: id, Name: "demo", DefaultBookmark: "main", UserID: pgtype.Int8{Int64: 1, Valid: true}}, nil
		},
	}
	resolver := &recordingWorkflowBookmarkCommitResolver{commit: commitSHA}
	statusWriter := &mockWorkflowRunCommitStatusWriter{}
	svc := newCurrentPushTestService(
		mock,
		WithWorkflowRunCommitStatusWriter(statusWriter),
		WithWorkflowRunBookmarkCommitResolver(resolver),
	)

	results, err := svc.DispatchForEvent(context.Background(), DispatchForEventInput{
		RepositoryID: 42,
		Event:        TriggerEvent{Type: "schedule"},
	})
	require.NoError(t, err)
	require.Len(t, results, 1)
	require.Len(t, resolver.calls, 1)
	assert.Equal(t, "main", resolver.calls[0].bookmark)
	require.Len(t, mock.createRunCalls, 1)
	assert.Equal(t, commitSHA, mock.createRunCalls[0].TriggerCommitSha)
	require.Len(t, mock.createStatusCalls, 1)
	assert.Equal(t, commitSHA, mock.createStatusCalls[0].CommitSha.String)
	assert.Equal(t, "smithers/canary", mock.createStatusCalls[0].Context)
	assert.Equal(t, results[0].WorkflowRunID, mock.createStatusCalls[0].WorkflowRunID.Int64)
	require.Len(t, statusWriter.published, 1)
}

func TestWorkflowRunService_DispatchForEvent_StatusInsertFailureAbortsRun(t *testing.T) {
	t.Parallel()

	mock := &mockWorkflowRunQuerier{
		listDefsFn: func(_ context.Context, _ db.ListWorkflowDefinitionsByRepoParams) ([]db.WorkflowDefinition, error) {
			return []db.WorkflowDefinition{
				makeWorkflowDef(1, 42, "ci", true, `{"on":{"push":{}},"jobs":{"build":{"steps":[{"run":"echo ok"}]}}}`),
			}, nil
		},
		createCommitStatusFn: func(context.Context, db.CreateCommitStatusParams) (db.CommitStatus, error) {
			return db.CommitStatus{}, errors.New("status insert failed")
		},
	}
	statusWriter := &mockWorkflowRunCommitStatusWriter{}

	_, err := newCurrentPushTestService(mock, WithWorkflowRunCommitStatusWriter(statusWriter)).DispatchForEvent(
		context.Background(),
		DispatchForEventInput{
			RepositoryID: 42,
			Event:        TriggerEvent{Type: "push", Ref: "main", CommitSHA: strings.Repeat("b", 40)},
		},
	)
	assert.Equal(t, 500, workflowRunAPIStatus(t, err))
	// Dispatch aborts cancel the queued tasks and mark the run failed; they do
	// not use the user-facing CancelRun path, which would report 'cancelled'.
	assert.Empty(t, mock.cancelRunCalls)
	assert.Equal(t, []int64{1}, mock.failRunCalls)
	assert.Equal(t, []int64{1}, mock.cancelTaskCalls)
	assert.Empty(t, statusWriter.published)
}

func TestWorkflowRunService_DispatchForEvent_LoadedPushCannotCreateInactiveReference(t *testing.T) {
	t.Parallel()

	listCalled := false
	ensureCalled := false
	mock := &mockWorkflowRunQuerier{
		listDefsFn: func(_ context.Context, _ db.ListWorkflowDefinitionsByRepoParams) ([]db.WorkflowDefinition, error) {
			listCalled = true
			return nil, nil
		},
		ensureDefRefFn: func(_ context.Context, arg db.EnsureWorkflowDefinitionReferenceParams) (db.WorkflowDefinition, error) {
			ensureCalled = true
			assert.Equal(t, ".smithers/workflows/feature.tsx", arg.Path)
			return db.WorkflowDefinition{
				ID:           77,
				RepositoryID: arg.RepositoryID,
				Name:         arg.Name,
				Path:         arg.Path,
				IsActive:     false,
			}, nil
		},
	}
	svc := newCurrentPushTestService(mock)

	results, err := svc.DispatchForEvent(context.Background(), DispatchForEventInput{
		RepositoryID: 42,
		Event: TriggerEvent{
			Type:      "push",
			Ref:       "refs/heads/feature/test",
			CommitSHA: "abc123",
		},
		UseLoadedDefinitions: true,
		LoadedDefinitions: []LoadedWorkflowDefinition{
			{
				Name:   "feature",
				Path:   ".smithers/workflows/feature.tsx",
				Config: json.RawMessage(`{"on":{"push":{}},"jobs":{"build":{"runs-on":"ubuntu","steps":[{"run":"echo hi"}]}}}`),
			},
		},
	})
	require.NoError(t, err)
	assert.Empty(t, results)
	assert.False(t, ensureCalled)
	assert.True(t, listCalled)
	assert.Empty(t, mock.createRunCalls)
}

func TestWorkflowRunService_DispatchForEvent_PersistsExplicitTaskSecretPolicies(t *testing.T) {
	t.Parallel()

	mock := &mockWorkflowRunQuerier{
		listDefsFn: func(context.Context, db.ListWorkflowDefinitionsByRepoParams) ([]db.WorkflowDefinition, error) {
			return []db.WorkflowDefinition{makeWorkflowDef(1, 42, "ci", true, `{
				"on":{"push":{}},
				"jobs":{
					"none":{"secrets":[],"steps":[{"run":"true"}]},
					"provider":{"secrets":["ANTHROPIC_API_KEY"],"steps":[{"run":"true"}]},
					"legacy":{"steps":[{"run":"true"}]}
				}
			}`)}, nil
		},
	}
	_, err := newCurrentPushTestService(mock).DispatchForEvent(context.Background(), DispatchForEventInput{
		RepositoryID: 42,
		Event:        TriggerEvent{Type: "push", Ref: "main", CommitSHA: strings.Repeat("a", 40)},
	})
	require.NoError(t, err)
	require.Len(t, mock.createTaskCalls, 3)

	policies := make(map[string]any, 3)
	for _, call := range mock.createTaskCalls {
		var payload map[string]any
		require.NoError(t, json.Unmarshal(call.Payload, &payload))
		name := payload["job"].(string)
		policy, present := payload["secret_names"]
		if present {
			policies[name] = policy
		} else {
			policies[name] = nil
		}
	}
	assert.Equal(t, []any{}, policies["none"])
	assert.Equal(t, []any{"ANTHROPIC_API_KEY"}, policies["provider"])
	assert.Nil(t, policies["legacy"], "omission is the explicit legacy compatibility mode")
}

func TestWorkflowRunService_DispatchForEvent_RejectsInvalidTaskSecretPolicyBeforeRunCreation(t *testing.T) {
	t.Parallel()

	mock := &mockWorkflowRunQuerier{
		listDefsFn: func(context.Context, db.ListWorkflowDefinitionsByRepoParams) ([]db.WorkflowDefinition, error) {
			return []db.WorkflowDefinition{makeWorkflowDef(1, 42, "ci", true, `{
				"on":{"push":{}},
				"jobs":{"build":{"secrets":["BAD NAME"],"steps":[{"run":"true"}]}}
			}`)}, nil
		},
	}
	_, err := newCurrentPushTestService(mock).DispatchForEvent(context.Background(), DispatchForEventInput{
		RepositoryID: 42,
		Event:        TriggerEvent{Type: "push", Ref: "main", CommitSHA: strings.Repeat("a", 40)},
	})
	require.ErrorContains(t, err, "invalid secret name")
	assert.Empty(t, mock.createRunCalls)
	assert.Empty(t, mock.createTaskCalls)
}

func TestWorkflowRunService_DispatchForEvent_EmptyLoadedSnapshotDoesNotFallbackToPersistedDefinitions(t *testing.T) {
	t.Parallel()

	listCalled := false
	ensureCalled := false
	mock := &mockWorkflowRunQuerier{
		listDefsFn: func(_ context.Context, _ db.ListWorkflowDefinitionsByRepoParams) ([]db.WorkflowDefinition, error) {
			listCalled = true
			return []db.WorkflowDefinition{
				makeWorkflowDef(1, 42, "persisted", true, `{"on":{"push":{}},"jobs":{"build":{"runs-on":"ubuntu","steps":[{"run":"echo hi"}]}}}`),
			}, nil
		},
		ensureDefRefFn: func(_ context.Context, _ db.EnsureWorkflowDefinitionReferenceParams) (db.WorkflowDefinition, error) {
			ensureCalled = true
			return db.WorkflowDefinition{}, nil
		},
	}
	svc := newCurrentPushTestService(mock)

	results, err := svc.DispatchForEvent(context.Background(), DispatchForEventInput{
		RepositoryID:         42,
		UseLoadedDefinitions: true,
		Event: TriggerEvent{
			Type:      "push",
			Ref:       "refs/heads/feature/test",
			CommitSHA: "abc123",
		},
	})
	require.NoError(t, err)
	assert.Empty(t, results)
	assert.True(t, listCalled)
	assert.False(t, ensureCalled)
}

func TestWorkflowRunService_DispatchForEvent_IfFalse_CreatesSkippedStepAndTask(t *testing.T) {
	t.Parallel()
	mock := &mockWorkflowRunQuerier{
		listDefsFn: func(_ context.Context, _ db.ListWorkflowDefinitionsByRepoParams) ([]db.WorkflowDefinition, error) {
			return []db.WorkflowDefinition{
				makeWorkflowDef(1, 42, "ci", true, `{
					"on":{"push":{}},
					"jobs":{
						"build":{
							"if":"trigger.type == \"landing_request\"",
							"runs-on":"ubuntu",
							"steps":[{"run":"go test ./..."}]
						}
					}
				}`),
			}, nil
		},
	}
	svc := newCurrentPushTestService(mock)

	results, err := svc.DispatchForEvent(context.Background(), DispatchForEventInput{
		RepositoryID: 42,
		Event:        TriggerEvent{Type: "push", Ref: "main"},
	})
	require.NoError(t, err)
	require.Len(t, results, 1)
	require.Len(t, mock.createStepCalls, 1)
	require.Len(t, mock.createTaskCalls, 1)

	assert.Equal(t, "skipped", mock.createStepCalls[0].Status)
	assert.Equal(t, "skipped", mock.createTaskCalls[0].Status)
}

func TestWorkflowRunService_DispatchForEvent_Needs_CreateBlockedDependentTask(t *testing.T) {
	t.Parallel()
	mock := &mockWorkflowRunQuerier{
		listDefsFn: func(_ context.Context, _ db.ListWorkflowDefinitionsByRepoParams) ([]db.WorkflowDefinition, error) {
			return []db.WorkflowDefinition{
				makeWorkflowDef(1, 42, "ci", true, `{
					"on":{"push":{}},
					"jobs":{
						"build":{"runs-on":"ubuntu","steps":[{"run":"go test ./..."}]},
						"deploy":{"needs":["build"],"runs-on":"ubuntu","steps":[{"run":"./deploy.sh"}]}
					}
				}`),
			}, nil
		},
	}
	svc := newCurrentPushTestService(mock)

	results, err := svc.DispatchForEvent(context.Background(), DispatchForEventInput{
		RepositoryID: 42,
		Event:        TriggerEvent{Type: "push", Ref: "main"},
	})
	require.NoError(t, err)
	require.Len(t, results, 1)
	require.Len(t, mock.createStepCalls, 2)
	require.Len(t, mock.createTaskCalls, 2)

	stepNameByID := make(map[int64]string)
	for i, stepCall := range mock.createStepCalls {
		stepID := int64(i + 1)
		stepNameByID[stepID] = stepCall.Name
	}
	taskStatusByStep := make(map[string]string)
	for _, taskCall := range mock.createTaskCalls {
		taskStatusByStep[stepNameByID[taskCall.WorkflowStepID]] = taskCall.Status
	}

	assert.Equal(t, "pending", taskStatusByStep["build"])
	assert.Equal(t, "blocked", taskStatusByStep["deploy"])
}

func TestWorkflowRunService_DispatchForEvent_NeedsIf_IsDeferredUntilDependenciesResolve(t *testing.T) {
	t.Parallel()
	mock := &mockWorkflowRunQuerier{
		listDefsFn: func(_ context.Context, _ db.ListWorkflowDefinitionsByRepoParams) ([]db.WorkflowDefinition, error) {
			return []db.WorkflowDefinition{
				makeWorkflowDef(1, 42, "issue-pipeline", true, `{
					"on":{"push":{}},
					"jobs":{
						"ci":{"steps":[{"run":"make test"}]},
						"review":{"needs":["ci"],"if":"needs.ci.result == \"success\"","steps":[{"run":"echo review"}]}
					}
				}`),
			}, nil
		},
	}
	svc := newCurrentPushTestService(mock)

	results, err := svc.DispatchForEvent(context.Background(), DispatchForEventInput{
		RepositoryID: 42,
		Event:        TriggerEvent{Type: "push", Ref: "main"},
	})
	require.NoError(t, err)
	require.Len(t, results, 1)
	require.Len(t, mock.createStepCalls, 2)
	require.Len(t, mock.createTaskCalls, 2)

	stepNameByID := make(map[int64]string)
	for i, stepCall := range mock.createStepCalls {
		stepID := int64(i + 1)
		stepNameByID[stepID] = stepCall.Name
	}
	stepStatusByName := make(map[string]string)
	taskStatusByStep := make(map[string]string)
	for i, stepCall := range mock.createStepCalls {
		stepStatusByName[stepCall.Name] = mock.createStepCalls[i].Status
	}
	for _, taskCall := range mock.createTaskCalls {
		taskStatusByStep[stepNameByID[taskCall.WorkflowStepID]] = taskCall.Status
	}

	assert.Equal(t, "queued", stepStatusByName["review"])
	assert.Equal(t, "blocked", taskStatusByStep["review"])
}

func TestWorkflowRunService_DispatchForEvent_MultipleJobs_CreatesMultipleStepsTasks(t *testing.T) {
	t.Parallel()
	mock := &mockWorkflowRunQuerier{
		listDefsFn: func(_ context.Context, _ db.ListWorkflowDefinitionsByRepoParams) ([]db.WorkflowDefinition, error) {
			return []db.WorkflowDefinition{
				makeWorkflowDef(1, 42, "ci", true, `{
					"on":{"push":{}},
					"jobs":{
						"lint":{},
						"test":{}
					}
				}`),
			}, nil
		},
	}
	svc := newCurrentPushTestService(mock)
	results, err := svc.DispatchForEvent(context.Background(), DispatchForEventInput{
		RepositoryID: 42,
		Event:        TriggerEvent{Type: "push", Ref: "main"},
	})
	require.NoError(t, err)
	require.Len(t, results, 1)
	assert.Len(t, results[0].Steps, 2, "should have created steps for both jobs")
	assert.Len(t, mock.createStepCalls, 2)
	assert.Len(t, mock.createTaskCalls, 2)
}

func TestWorkflowRunService_DispatchForEvent_SortsStepPositionsByJobName(t *testing.T) {
	t.Parallel()
	mock := &mockWorkflowRunQuerier{
		listDefsFn: func(_ context.Context, _ db.ListWorkflowDefinitionsByRepoParams) ([]db.WorkflowDefinition, error) {
			return []db.WorkflowDefinition{
				makeWorkflowDef(1, 42, "ci", true, `{
					"on":{"push":{}},
					"jobs":{
						"test":{},
						"build":{},
						"deploy":{}
					}
				}`),
			}, nil
		},
	}
	svc := newCurrentPushTestService(mock)
	_, err := svc.DispatchForEvent(context.Background(), DispatchForEventInput{
		RepositoryID: 42,
		Event:        TriggerEvent{Type: "push", Ref: "main"},
	})
	require.NoError(t, err)
	require.Len(t, mock.createStepCalls, 3)

	assert.Equal(t, "build", mock.createStepCalls[0].Name)
	assert.Equal(t, int64(1), mock.createStepCalls[0].Position)
	assert.Equal(t, "deploy", mock.createStepCalls[1].Name)
	assert.Equal(t, int64(2), mock.createStepCalls[1].Position)
	assert.Equal(t, "test", mock.createStepCalls[2].Name)
	assert.Equal(t, int64(3), mock.createStepCalls[2].Position)
}

func TestWorkflowRunService_DispatchForEvent_MultipleMatchingDefs_CreatesMultipleRuns(t *testing.T) {
	t.Parallel()
	mock := &mockWorkflowRunQuerier{
		listDefsFn: func(_ context.Context, _ db.ListWorkflowDefinitionsByRepoParams) ([]db.WorkflowDefinition, error) {
			return []db.WorkflowDefinition{
				makeWorkflowDef(1, 42, "ci", true, `{"on":{"push":{}},"jobs":{"build":{}}}`),
				makeWorkflowDef(2, 42, "deploy", true, `{"on":{"push":{"branches":["main"]}},"jobs":{"deploy":{}}}`),
				makeWorkflowDef(3, 42, "staging", true, `{"on":{"push":{"branches":["staging"]}},"jobs":{"deploy-staging":{}}}`),
			}, nil
		},
	}
	svc := newCurrentPushTestService(mock)
	results, err := svc.DispatchForEvent(context.Background(), DispatchForEventInput{
		RepositoryID: 42,
		Event:        TriggerEvent{Type: "push", Ref: "main"},
	})
	require.NoError(t, err)
	// "ci" matches all branches, "deploy" matches main, "staging" doesn't match main
	assert.Len(t, results, 2, "should have created runs for ci and deploy, not staging")
	assert.Len(t, mock.createRunCalls, 2)
}

// ─── LandingRequest trigger dispatch ─────────────────────────────────────────

func TestWorkflowRunService_DispatchForEvent_LandingRequest_CreatesRun(t *testing.T) {
	t.Parallel()
	mock := &mockWorkflowRunQuerier{
		listDefsFn: func(_ context.Context, _ db.ListWorkflowDefinitionsByRepoParams) ([]db.WorkflowDefinition, error) {
			return []db.WorkflowDefinition{
				makeWorkflowDef(1, 42, "ci", true, `{"on":{"landing_request":{"types":["opened"]}},"jobs":{"test":{}}}`),
			}, nil
		},
	}
	svc := newCurrentPushTestService(mock)
	results, err := svc.DispatchForEvent(context.Background(), DispatchForEventInput{
		RepositoryID: 42,
		Event:        TriggerEvent{Type: "landing_request", Action: "opened"},
	})
	require.NoError(t, err)
	require.Len(t, results, 1)
	assert.Equal(t, "landing_request", mock.createRunCalls[0].TriggerEvent)
}

func TestWorkflowRunService_DispatchForEvent_LandingRequest_WrongAction_NoRun(t *testing.T) {
	t.Parallel()
	mock := &mockWorkflowRunQuerier{
		listDefsFn: func(_ context.Context, _ db.ListWorkflowDefinitionsByRepoParams) ([]db.WorkflowDefinition, error) {
			return []db.WorkflowDefinition{
				makeWorkflowDef(1, 42, "ci", true, `{"on":{"landing_request":{"types":["opened"]}},"jobs":{"test":{}}}`),
			}, nil
		},
	}
	svc := newCurrentPushTestService(mock)
	results, err := svc.DispatchForEvent(context.Background(), DispatchForEventInput{
		RepositoryID: 42,
		Event:        TriggerEvent{Type: "landing_request", Action: "closed"},
	})
	require.NoError(t, err)
	assert.Empty(t, results)
	assert.Empty(t, mock.createRunCalls)
}

func TestWorkflowRunService_DispatchForEvent_Issue_CreatesRun(t *testing.T) {
	t.Parallel()
	mock := &mockWorkflowRunQuerier{
		listDefsFn: func(_ context.Context, _ db.ListWorkflowDefinitionsByRepoParams) ([]db.WorkflowDefinition, error) {
			return []db.WorkflowDefinition{
				makeWorkflowDef(1, 42, "issue-pipeline", true, `{"on":{"issue":{"types":["opened"]}},"jobs":{"research":{}}}`),
			}, nil
		},
	}
	svc := newCurrentPushTestService(mock)
	results, err := svc.DispatchForEvent(context.Background(), DispatchForEventInput{
		RepositoryID: 42,
		Event:        TriggerEvent{Type: "issues", Action: "opened"},
	})
	require.NoError(t, err)
	require.Len(t, results, 1)
	require.Len(t, mock.createRunCalls, 1)
	assert.Equal(t, "issues", mock.createRunCalls[0].TriggerEvent)
}

func TestWorkflowRunService_DispatchForEvent_WorkflowDispatch_CreatesRun(t *testing.T) {
	t.Parallel()
	mock := &mockWorkflowRunQuerier{
		listDefsFn: func(_ context.Context, _ db.ListWorkflowDefinitionsByRepoParams) ([]db.WorkflowDefinition, error) {
			return []db.WorkflowDefinition{
				makeWorkflowDef(1, 42, "manual", true, `{"on":{"workflow_dispatch":{}},"jobs":{"deploy":{}}}`),
			}, nil
		},
	}
	svc := newCurrentPushTestService(mock)
	results, err := svc.DispatchForEvent(context.Background(), DispatchForEventInput{
		RepositoryID: 42,
		Event:        TriggerEvent{Type: "workflow_dispatch", Ref: "refs/heads/release-1"},
	})
	require.NoError(t, err)
	require.Len(t, results, 1)
	require.Len(t, mock.createRunCalls, 1)
	assert.Equal(t, "workflow_dispatch", mock.createRunCalls[0].TriggerEvent)
	assert.Equal(t, "refs/heads/release-1", mock.createRunCalls[0].TriggerRef)
}

func TestWorkflowRunService_DispatchForEvent_WorkflowDispatch_NoTrigger_NoRun(t *testing.T) {
	t.Parallel()
	mock := &mockWorkflowRunQuerier{
		listDefsFn: func(_ context.Context, _ db.ListWorkflowDefinitionsByRepoParams) ([]db.WorkflowDefinition, error) {
			return []db.WorkflowDefinition{
				makeWorkflowDef(1, 42, "push-only", true, `{"on":{"push":{"branches":["main"]}},"jobs":{"build":{}}}`),
			}, nil
		},
	}
	svc := newCurrentPushTestService(mock)
	results, err := svc.DispatchForEvent(context.Background(), DispatchForEventInput{
		RepositoryID: 42,
		Event:        TriggerEvent{Type: "workflow_dispatch", Ref: "main"},
	})
	require.NoError(t, err)
	assert.Empty(t, results)
	assert.Empty(t, mock.createRunCalls)
}

// ─── Error propagation ────────────────────────────────────────────────────────

func TestWorkflowRunService_DispatchForEvent_ListDefsError_ReturnsInternalError(t *testing.T) {
	t.Parallel()
	mock := &mockWorkflowRunQuerier{
		listDefsFn: func(_ context.Context, _ db.ListWorkflowDefinitionsByRepoParams) ([]db.WorkflowDefinition, error) {
			return nil, errors.New("db unavailable")
		},
	}
	svc := newCurrentPushTestService(mock)
	_, err := svc.DispatchForEvent(context.Background(), DispatchForEventInput{
		RepositoryID: 42,
		Event:        TriggerEvent{Type: "push", Ref: "main"},
	})
	assert.Equal(t, 500, workflowRunAPIStatus(t, err))
}

func TestWorkflowRunService_DispatchForEvent_CreateRunError_ReturnsInternalError(t *testing.T) {
	t.Parallel()
	mock := &mockWorkflowRunQuerier{
		listDefsFn: func(_ context.Context, _ db.ListWorkflowDefinitionsByRepoParams) ([]db.WorkflowDefinition, error) {
			return []db.WorkflowDefinition{
				makeWorkflowDef(1, 42, "ci", true, `{"on":{"push":{}},"jobs":{"build":{}}}`),
			}, nil
		},
		createRunFn: func(_ context.Context, _ db.CreateWorkflowRunParams) (db.WorkflowRun, error) {
			return db.WorkflowRun{}, errors.New("insert failed")
		},
	}
	svc := newCurrentPushTestService(mock)
	_, err := svc.DispatchForEvent(context.Background(), DispatchForEventInput{
		RepositoryID: 42,
		Event:        TriggerEvent{Type: "push", Ref: "main"},
	})
	assert.Equal(t, 500, workflowRunAPIStatus(t, err))
}

func TestWorkflowRunService_DispatchForEvent_CreateStepError_ReturnsInternalError(t *testing.T) {
	t.Parallel()
	mock := &mockWorkflowRunQuerier{
		listDefsFn: func(_ context.Context, _ db.ListWorkflowDefinitionsByRepoParams) ([]db.WorkflowDefinition, error) {
			return []db.WorkflowDefinition{
				makeWorkflowDef(1, 42, "ci", true, `{"on":{"push":{}},"jobs":{"build":{}}}`),
			}, nil
		},
		createStepFn: func(_ context.Context, _ db.CreateWorkflowStepParams) (db.WorkflowStep, error) {
			return db.WorkflowStep{}, errors.New("step insert failed")
		},
	}
	svc := newCurrentPushTestService(mock)
	_, err := svc.DispatchForEvent(context.Background(), DispatchForEventInput{
		RepositoryID: 42,
		Event:        TriggerEvent{Type: "push", Ref: "main"},
	})
	assert.Equal(t, 500, workflowRunAPIStatus(t, err))
}

func TestWorkflowRunService_DispatchForEvent_CreateTaskError_ReturnsInternalError(t *testing.T) {
	t.Parallel()
	mock := &mockWorkflowRunQuerier{
		listDefsFn: func(_ context.Context, _ db.ListWorkflowDefinitionsByRepoParams) ([]db.WorkflowDefinition, error) {
			return []db.WorkflowDefinition{
				makeWorkflowDef(1, 42, "ci", true, `{"on":{"push":{}},"jobs":{"build":{}}}`),
			}, nil
		},
		createTaskFn: func(_ context.Context, _ db.CreateWorkflowTaskParams) (db.WorkflowTask, error) {
			return db.WorkflowTask{}, errors.New("task insert failed")
		},
	}
	svc := newCurrentPushTestService(mock)
	_, err := svc.DispatchForEvent(context.Background(), DispatchForEventInput{
		RepositoryID: 42,
		Event:        TriggerEvent{Type: "push", Ref: "main"},
	})
	assert.Equal(t, 500, workflowRunAPIStatus(t, err))
}

// ─── Malformed config ─────────────────────────────────────────────────────────

func TestWorkflowRunService_DispatchForEvent_MalformedJobsConfig_IsRejectedBeforeRunCreation(t *testing.T) {
	t.Parallel()
	// Config has valid trigger but jobs field has a malformed step structure
	// (jobs.build is a string rather than an object with steps/runs-on).
	mock := &mockWorkflowRunQuerier{
		listDefsFn: func(_ context.Context, _ db.ListWorkflowDefinitionsByRepoParams) ([]db.WorkflowDefinition, error) {
			return []db.WorkflowDefinition{
				// valid on trigger, but steps inside the job are malformed strings
				makeWorkflowDef(1, 42, "ci", true, `{"on":{"push":{}},"jobs":{"build":{"steps":"not-array"}}}`),
			}, nil
		},
	}
	svc := newCurrentPushTestService(mock)
	_, err := svc.DispatchForEvent(context.Background(), DispatchForEventInput{
		RepositoryID: 42,
		Event:        TriggerEvent{Type: "push", Ref: "main"},
	})
	assert.Equal(t, 400, workflowRunAPIStatus(t, err))
	assert.Empty(t, mock.createRunCalls, "malformed config must not create a run")
}

func TestWorkflowRunService_DispatchForEvent_EmptyJobsConfig_IsRejectedBeforeRunCreation(t *testing.T) {
	t.Parallel()
	mock := &mockWorkflowRunQuerier{
		listDefsFn: func(_ context.Context, _ db.ListWorkflowDefinitionsByRepoParams) ([]db.WorkflowDefinition, error) {
			return []db.WorkflowDefinition{
				makeWorkflowDef(1, 42, "ci", true, `{"on":{"push":{}},"jobs":{}}`),
			}, nil
		},
	}
	svc := newCurrentPushTestService(mock)
	_, err := svc.DispatchForEvent(context.Background(), DispatchForEventInput{
		RepositoryID: 42,
		Event:        TriggerEvent{Type: "push", Ref: "main"},
	})
	assert.Equal(t, 400, workflowRunAPIStatus(t, err))
	assert.Empty(t, mock.createRunCalls, "an empty workflow must not create a queued run")
}

// ─── parseJobsFromConfig ──────────────────────────────────────────────────────

func TestParseJobsFromConfig_ValidJobs(t *testing.T) {
	t.Parallel()
	raw := json.RawMessage(`{
		"jobs": {
			"build": {
				"runs-on": "ubuntu",
				"steps": [{"run": "make build"}]
			},
			"test": {
				"runs-on": "ubuntu",
				"needs": ["build"]
			}
		}
	}`)
	jobs, err := parseJobsFromConfig(raw)
	require.NoError(t, err)
	assert.Len(t, jobs, 2)

	jobsByName := make(map[string]JobConfig)
	for _, j := range jobs {
		jobsByName[j.Name] = j
	}
	assert.Contains(t, jobsByName, "build")
	assert.Equal(t, "ubuntu", jobsByName["build"].RunsOn)
	assert.Len(t, jobsByName["build"].Steps, 1)
	assert.Contains(t, jobsByName, "test")
	assert.Equal(t, []string{"build"}, jobsByName["test"].Needs)
}

func TestParseJobsFromConfig_SortsJobsByName(t *testing.T) {
	t.Parallel()
	raw := json.RawMessage(`{
		"jobs": {
			"test": {},
			"build": {},
			"deploy": {},
			"lint": {}
		}
	}`)

	for i := 0; i < 25; i++ {
		jobs, err := parseJobsFromConfig(raw)
		require.NoError(t, err)
		require.Len(t, jobs, 4)

		assert.Equal(t, "build", jobs[0].Name)
		assert.Equal(t, "deploy", jobs[1].Name)
		assert.Equal(t, "lint", jobs[2].Name)
		assert.Equal(t, "test", jobs[3].Name)
	}
}

func TestParseJobsFromConfig_EmptyConfig_ReturnsNil(t *testing.T) {
	t.Parallel()
	jobs, err := parseJobsFromConfig(nil)
	require.NoError(t, err)
	assert.Empty(t, jobs)
}

func TestParseJobsFromConfig_InvalidJSON_ReturnsError(t *testing.T) {
	t.Parallel()
	_, err := parseJobsFromConfig(json.RawMessage(`{bad`))
	require.Error(t, err)
}

func TestParseJobsFromConfig_EmptyJobs_ReturnsEmpty(t *testing.T) {
	t.Parallel()
	jobs, err := parseJobsFromConfig(json.RawMessage(`{"jobs":{}}`))
	require.NoError(t, err)
	assert.Empty(t, jobs)
}

// ─── DAG validation ───────────────────────────────────────────────────────────

func TestWorkflowRunService_DispatchForEvent_InvalidDAG_ReturnsError(t *testing.T) {
	t.Parallel()
	mock := &mockWorkflowRunQuerier{
		listDefsFn: func(_ context.Context, _ db.ListWorkflowDefinitionsByRepoParams) ([]db.WorkflowDefinition, error) {
			return []db.WorkflowDefinition{
				makeWorkflowDef(1, 42, "ci", true, `{
					"on":{"push":{}},
					"jobs":{
						"a":{"needs":["b"]},
						"b":{"needs":["a"]}
					}
				}`),
			}, nil
		},
	}
	svc := newCurrentPushTestService(mock)
	_, err := svc.DispatchForEvent(context.Background(), DispatchForEventInput{
		RepositoryID: 42,
		Event:        TriggerEvent{Type: "push", Ref: "main"},
	})
	require.Error(t, err)
	assert.Equal(t, 400, workflowRunAPIStatus(t, err))
	assert.Empty(t, mock.createRunCalls, "invalid DAG must be rejected before run creation")
}

func TestWorkflowRunService_DispatchForEvent_InvalidIfExpression_IsRejectedBeforeRunCreation(t *testing.T) {
	t.Parallel()
	mock := &mockWorkflowRunQuerier{
		listDefsFn: func(_ context.Context, _ db.ListWorkflowDefinitionsByRepoParams) ([]db.WorkflowDefinition, error) {
			return []db.WorkflowDefinition{
				makeWorkflowDef(1, 42, "ci", true, `{"on":{"push":{}},"jobs":{"build":{"if":"unsupported()"}}}`),
			}, nil
		},
	}

	_, err := newCurrentPushTestService(mock).DispatchForEvent(context.Background(), DispatchForEventInput{
		RepositoryID: 42,
		Event:        TriggerEvent{Type: "push", Ref: "main"},
	})
	assert.Equal(t, 400, workflowRunAPIStatus(t, err))
	assert.Empty(t, mock.createRunCalls)
}

func TestWorkflowRunService_DispatchForEvent_JobLimit_IsRejectedBeforeRunCreation(t *testing.T) {
	t.Parallel()
	jobs := make(map[string]JobConfig, maxWorkflowJobs+1)
	for i := 0; i <= maxWorkflowJobs; i++ {
		jobs[fmt.Sprintf("job-%d", i)] = JobConfig{}
	}
	config, err := json.Marshal(map[string]any{
		"on":   map[string]any{"push": map[string]any{}},
		"jobs": jobs,
	})
	require.NoError(t, err)

	mock := &mockWorkflowRunQuerier{
		listDefsFn: func(_ context.Context, _ db.ListWorkflowDefinitionsByRepoParams) ([]db.WorkflowDefinition, error) {
			return []db.WorkflowDefinition{makeWorkflowDef(1, 42, "ci", true, string(config))}, nil
		},
	}
	_, err = newCurrentPushTestService(mock).DispatchForEvent(context.Background(), DispatchForEventInput{
		RepositoryID: 42,
		Event:        TriggerEvent{Type: "push", Ref: "main"},
	})
	assert.Equal(t, 400, workflowRunAPIStatus(t, err))
	assert.Empty(t, mock.createRunCalls)
}

// ─── DAG scheduling ──────────────────────────────────────────────────────────

func TestWorkflowRunService_DispatchForEvent_RootJobsPending_DependentJobsBlocked(t *testing.T) {
	t.Parallel()
	mock := &mockWorkflowRunQuerier{
		listDefsFn: func(_ context.Context, _ db.ListWorkflowDefinitionsByRepoParams) ([]db.WorkflowDefinition, error) {
			return []db.WorkflowDefinition{
				makeWorkflowDef(1, 42, "ci", true, `{
					"on":{"push":{}},
					"jobs":{
						"build":{},
						"test":{"needs":["build"]},
						"deploy":{"needs":["test"]}
					}
				}`),
			}, nil
		},
	}
	svc := newCurrentPushTestService(mock)
	results, err := svc.DispatchForEvent(context.Background(), DispatchForEventInput{
		RepositoryID: 42,
		Event:        TriggerEvent{Type: "push", Ref: "main"},
	})
	require.NoError(t, err)
	require.Len(t, results, 1)
	assert.Len(t, results[0].Steps, 3)

	// Verify task statuses: root jobs are pending, dependent jobs are blocked.
	taskStatusByJob := make(map[string]string)
	for _, call := range mock.createTaskCalls {
		var payload map[string]any
		_ = json.Unmarshal(call.Payload, &payload)
		jobName, _ := payload["job"].(string)
		taskStatusByJob[jobName] = call.Status
	}

	assert.Equal(t, "pending", taskStatusByJob["build"])
	assert.Equal(t, "blocked", taskStatusByJob["test"])
	assert.Equal(t, "blocked", taskStatusByJob["deploy"])
}

func TestWorkflowRunService_DispatchForEvent_NeedsInPayload(t *testing.T) {
	t.Parallel()
	mock := &mockWorkflowRunQuerier{
		listDefsFn: func(_ context.Context, _ db.ListWorkflowDefinitionsByRepoParams) ([]db.WorkflowDefinition, error) {
			return []db.WorkflowDefinition{
				makeWorkflowDef(1, 42, "ci", true, `{
					"on":{"push":{}},
					"jobs":{
						"build":{},
						"test":{"needs":["build"]}
					}
				}`),
			}, nil
		},
	}
	svc := newCurrentPushTestService(mock)
	_, err := svc.DispatchForEvent(context.Background(), DispatchForEventInput{
		RepositoryID: 42,
		Event:        TriggerEvent{Type: "push", Ref: "main"},
	})
	require.NoError(t, err)

	// Verify needs is stored in the payload for the dependent task.
	for _, call := range mock.createTaskCalls {
		var payload map[string]any
		_ = json.Unmarshal(call.Payload, &payload)
		jobName, _ := payload["job"].(string)
		if jobName == "test" {
			needs, ok := payload["needs"].([]any)
			require.True(t, ok, "test job payload should have needs array")
			assert.Equal(t, []any{"build"}, needs)
		}
		if jobName == "build" {
			_, ok := payload["needs"]
			assert.False(t, ok, "build job payload should not have needs")
		}
	}
}

func TestWorkflowRunService_DispatchForEvent_AllRootJobs_AllPending(t *testing.T) {
	t.Parallel()
	mock := &mockWorkflowRunQuerier{
		listDefsFn: func(_ context.Context, _ db.ListWorkflowDefinitionsByRepoParams) ([]db.WorkflowDefinition, error) {
			return []db.WorkflowDefinition{
				makeWorkflowDef(1, 42, "ci", true, `{
					"on":{"push":{}},
					"jobs":{
						"lint":{},
						"test":{}
					}
				}`),
			}, nil
		},
	}
	svc := newCurrentPushTestService(mock)
	_, err := svc.DispatchForEvent(context.Background(), DispatchForEventInput{
		RepositoryID: 42,
		Event:        TriggerEvent{Type: "push", Ref: "main"},
	})
	require.NoError(t, err)

	for _, call := range mock.createTaskCalls {
		assert.Equal(t, "pending", call.Status, "all root jobs should be pending")
	}
}

// ─── Webhook dispatch ─────────────────────────────────────────────────────────

type mockWorkflowRunDispatcher struct {
	calls []struct {
		repoID    int64
		eventType string
		payload   any
	}
}

func (m *mockWorkflowRunDispatcher) DispatchEvent(ctx context.Context, repoID int64, eventType webhooks.EventType, payload any) error {
	m.calls = append(m.calls, struct {
		repoID    int64
		eventType string
		payload   any
	}{repoID: repoID, eventType: string(eventType), payload: payload})
	return nil
}

func (m *mockWorkflowRunDispatcher) DispatchOrgEvent(ctx context.Context, orgID int64, eventType webhooks.EventType, payload any) error {
	return nil
}

func TestWorkflowRunService_DispatchesWorkflowRunWebhookOnCreate(t *testing.T) {
	t.Parallel()
	dispatcher := &mockWorkflowRunDispatcher{}
	mock := &mockWorkflowRunQuerier{
		listDefsFn: func(_ context.Context, _ db.ListWorkflowDefinitionsByRepoParams) ([]db.WorkflowDefinition, error) {
			return []db.WorkflowDefinition{
				makeWorkflowDef(1, 42, "ci", true, `{"on":{"push":{}},"jobs":{"build":{}}}`),
			}, nil
		},
	}
	svc := newCurrentPushTestService(mock, WithWorkflowRunWebhookDispatcher(dispatcher))
	results, err := svc.DispatchForEvent(context.Background(), DispatchForEventInput{
		RepositoryID: 42,
		Event:        TriggerEvent{Type: "push", Ref: "main"},
	})
	require.NoError(t, err)
	require.Len(t, results, 1)

	// One "workflow_run" webhook event should be dispatched.
	require.Len(t, dispatcher.calls, 1)
	call := dispatcher.calls[0]
	assert.EqualValues(t, 42, call.repoID)
	assert.Equal(t, "workflow_run", call.eventType)
}

func TestWorkflowRunService_NoWebhookDispatchWithoutDispatcher(t *testing.T) {
	t.Parallel()
	// When no dispatcher is configured, DispatchForEvent should not panic.
	mock := &mockWorkflowRunQuerier{
		listDefsFn: func(_ context.Context, _ db.ListWorkflowDefinitionsByRepoParams) ([]db.WorkflowDefinition, error) {
			return []db.WorkflowDefinition{
				makeWorkflowDef(1, 42, "ci", true, `{"on":{"push":{}},"jobs":{"build":{}}}`),
			}, nil
		},
	}
	svc := newCurrentPushTestService(mock)
	results, err := svc.DispatchForEvent(context.Background(), DispatchForEventInput{
		RepositoryID: 42,
		Event:        TriggerEvent{Type: "push", Ref: "main"},
	})
	require.NoError(t, err)
	require.Len(t, results, 1)
}

func TestWorkflowRunService_DispatchesWebhookForEachMatchingRun(t *testing.T) {
	t.Parallel()
	dispatcher := &mockWorkflowRunDispatcher{}
	mock := &mockWorkflowRunQuerier{
		listDefsFn: func(_ context.Context, _ db.ListWorkflowDefinitionsByRepoParams) ([]db.WorkflowDefinition, error) {
			return []db.WorkflowDefinition{
				makeWorkflowDef(1, 42, "ci", true, `{"on":{"push":{}},"jobs":{"build":{}}}`),
				makeWorkflowDef(2, 42, "lint", true, `{"on":{"push":{}},"jobs":{"lint":{}}}`),
			}, nil
		},
	}
	svc := newCurrentPushTestService(mock, WithWorkflowRunWebhookDispatcher(dispatcher))
	results, err := svc.DispatchForEvent(context.Background(), DispatchForEventInput{
		RepositoryID: 42,
		Event:        TriggerEvent{Type: "push", Ref: "main"},
	})
	require.NoError(t, err)
	require.Len(t, results, 2)

	// One dispatch per matching run.
	assert.Len(t, dispatcher.calls, 2)
	for _, call := range dispatcher.calls {
		assert.Equal(t, "workflow_run", call.eventType)
		assert.EqualValues(t, 42, call.repoID)
	}
}

// ─── Targeted Dispatch ────────────────────────────────────────────────────────

func TestDispatchForEvent_WithDefinitionID_TargetsSingleDefinition(t *testing.T) {
	t.Parallel()
	repoID := int64(100)
	defID := int64(10)
	def := makeWorkflowDef(defID, repoID, "targeted", true, `{"on": {"push": {}}, "jobs": {"build": {}}}`)

	q := &mockWorkflowRunQuerier{
		getDefFn: func(ctx context.Context, arg db.GetWorkflowDefinitionParams) (db.WorkflowDefinition, error) {
			assert.Equal(t, defID, arg.ID)
			assert.Equal(t, repoID, arg.RepositoryID)
			return def, nil
		},
	}
	svc := newCurrentPushTestService(q)

	results, err := svc.DispatchForEvent(context.Background(), DispatchForEventInput{
		RepositoryID:         repoID,
		WorkflowDefinitionID: &defID,
		Event:                TriggerEvent{Type: "push"},
	})
	require.NoError(t, err)
	require.Len(t, results, 1)
	assert.Equal(t, defID, results[0].WorkflowDefinitionID)
	assert.Equal(t, 0, q.listDefsCount) // should not list all defs
}

func TestDispatchForEvent_WithDefinitionID_InactiveDefinition_ReturnsEmpty(t *testing.T) {
	t.Parallel()
	repoID := int64(100)
	defID := int64(10)
	def := makeWorkflowDef(defID, repoID, "targeted", false, `{"on": {"push": {}}}`) // inactive

	q := &mockWorkflowRunQuerier{
		getDefFn: func(ctx context.Context, arg db.GetWorkflowDefinitionParams) (db.WorkflowDefinition, error) {
			return def, nil
		},
	}
	svc := newCurrentPushTestService(q)

	results, err := svc.DispatchForEvent(context.Background(), DispatchForEventInput{
		RepositoryID:         repoID,
		WorkflowDefinitionID: &defID,
		Event:                TriggerEvent{Type: "push"},
	})
	require.NoError(t, err)
	assert.Empty(t, results)
}

func TestDispatchForEvent_WithDefinitionID_NoTriggerMatch_ReturnsEmpty(t *testing.T) {
	t.Parallel()
	repoID := int64(100)
	defID := int64(10)
	def := makeWorkflowDef(defID, repoID, "targeted", true, `{"on": {"push": {"branches": ["main"]}}}`)

	q := &mockWorkflowRunQuerier{
		getDefFn: func(ctx context.Context, arg db.GetWorkflowDefinitionParams) (db.WorkflowDefinition, error) {
			return def, nil
		},
	}
	svc := newCurrentPushTestService(q)

	results, err := svc.DispatchForEvent(context.Background(), DispatchForEventInput{
		RepositoryID:         repoID,
		WorkflowDefinitionID: &defID,
		Event:                TriggerEvent{Type: "push", Ref: "refs/heads/feature"}, // doesn't match
	})
	require.NoError(t, err)
	assert.Empty(t, results)
}

func TestDispatchForEvent_WithoutDefinitionID_MatchesAll(t *testing.T) {
	t.Parallel()
	repoID := int64(100)
	q := &mockWorkflowRunQuerier{
		listDefsFn: func(ctx context.Context, arg db.ListWorkflowDefinitionsByRepoParams) ([]db.WorkflowDefinition, error) {
			return []db.WorkflowDefinition{
				makeWorkflowDef(1, repoID, "def1", true, `{"on": {"push": {}}, "jobs": {"build": {}}}`),
				makeWorkflowDef(2, repoID, "def2", true, `{"on": {"push": {}}, "jobs": {"deploy": {}}}`),
			}, nil
		},
	}
	svc := newCurrentPushTestService(q)

	results, err := svc.DispatchForEvent(context.Background(), DispatchForEventInput{
		RepositoryID: repoID,
		Event:        TriggerEvent{Type: "push"},
	})
	require.NoError(t, err)
	require.Len(t, results, 2)
	assert.Equal(t, 2, q.listDefsCount)
	assert.Equal(t, 0, q.getDefCount) // should not get single def
}

// ─── Targeted dispatch surfaces trigger-config problems ──────────────────────

// Regression: targeted dispatch (workflow_dispatch against an explicit
// definition ID) silently skipped definitions whose trigger config was
// unparseable or lacked a workflow_dispatch trigger, so the route returned
// 201 {"runs":[]}. Those cases must surface as errors.
func TestWorkflowRunService_DispatchForEvent_TargetedUnparseableConfig_ReturnsError(t *testing.T) {
	t.Parallel()
	mock := &mockWorkflowRunQuerier{
		getDefFn: func(_ context.Context, arg db.GetWorkflowDefinitionParams) (db.WorkflowDefinition, error) {
			return makeWorkflowDef(arg.ID, arg.RepositoryID, "ci", true, `{"on":`), nil
		},
	}
	svc := newCurrentPushTestService(mock)
	defID := int64(9)
	_, err := svc.DispatchForEvent(context.Background(), DispatchForEventInput{
		RepositoryID:         42,
		WorkflowDefinitionID: &defID,
		Event:                TriggerEvent{Type: "workflow_dispatch", Ref: "main"},
	})
	assert.Equal(t, 422, workflowRunAPIStatus(t, err))
	assert.Empty(t, mock.createRunCalls)
}

func TestWorkflowRunService_DispatchForEvent_TargetedMissingWorkflowDispatchTrigger_ReturnsError(t *testing.T) {
	t.Parallel()
	mock := &mockWorkflowRunQuerier{
		getDefFn: func(_ context.Context, arg db.GetWorkflowDefinitionParams) (db.WorkflowDefinition, error) {
			return makeWorkflowDef(arg.ID, arg.RepositoryID, "ci", true, `{"on":{"push":{}}}`), nil
		},
	}
	svc := newCurrentPushTestService(mock)
	defID := int64(9)
	_, err := svc.DispatchForEvent(context.Background(), DispatchForEventInput{
		RepositoryID:         42,
		WorkflowDefinitionID: &defID,
		Event:                TriggerEvent{Type: "workflow_dispatch", Ref: "main"},
	})
	assert.Equal(t, 422, workflowRunAPIStatus(t, err))
	assert.Empty(t, mock.createRunCalls)
}

func TestWorkflowRunService_DispatchForEvent_BroadcastUnparseableConfig_StillSkipped(t *testing.T) {
	t.Parallel()
	mock := &mockWorkflowRunQuerier{
		listDefsFn: func(_ context.Context, _ db.ListWorkflowDefinitionsByRepoParams) ([]db.WorkflowDefinition, error) {
			return []db.WorkflowDefinition{
				makeWorkflowDef(1, 42, "broken", true, `{"on":`),
			}, nil
		},
	}
	svc := newCurrentPushTestService(mock)
	results, err := svc.DispatchForEvent(context.Background(), DispatchForEventInput{
		RepositoryID: 42,
		Event:        TriggerEvent{Type: "push", Ref: "main"},
	})
	require.NoError(t, err, "broadcast dispatch must keep skipping broken definitions")
	assert.Empty(t, results)
}

// ─── Transactional path wiring ───────────────────────────────────────────────

// txBeginErrWorkflowRunQuerier makes the workflow-run service take the
// transactional branch (it implements BeginTx + WithTx like *db.Queries) and
// fails at BeginTx. This pins the wiring: when the store supports
// transactions, CancelRun/ResumeRun/dispatch must use them rather than fall
// back to the racy multi-statement path (issues #333, #334, #210).
type txBeginErrWorkflowRunQuerier struct {
	*mockWorkflowRunQuerier
	beginTxCalls int
}

func (q *txBeginErrWorkflowRunQuerier) BeginTx(context.Context) (pgx.Tx, error) {
	q.beginTxCalls++
	return nil, errors.New("begin tx unavailable")
}

func (q *txBeginErrWorkflowRunQuerier) RebindWorkflowRunQueries(pgx.Tx) WorkflowRunQuerier {
	panic("WithTx must not be called when BeginTx fails")
}

func TestWorkflowRunService_CancelRun_UsesTransactionWhenSupported(t *testing.T) {
	t.Parallel()
	mock := &txBeginErrWorkflowRunQuerier{mockWorkflowRunQuerier: &mockWorkflowRunQuerier{}}
	err := newCurrentPushTestService(mock).CancelRun(context.Background(), 42, 7)
	assert.Equal(t, 500, workflowRunAPIStatus(t, err))
	assert.Equal(t, 1, mock.beginTxCalls)
	assert.Empty(t, mock.cancelRunCalls, "cancel must not proceed without the transaction")
}

func TestWorkflowRunService_ResumeRun_UsesTransactionWhenSupported(t *testing.T) {
	t.Parallel()
	mock := &txBeginErrWorkflowRunQuerier{mockWorkflowRunQuerier: &mockWorkflowRunQuerier{}}
	err := newCurrentPushTestService(mock).ResumeRun(context.Background(), 42, 7)
	assert.Equal(t, 500, workflowRunAPIStatus(t, err))
	assert.Equal(t, 1, mock.beginTxCalls)
	assert.Empty(t, mock.resumeRunCalls, "resume must not proceed without the transaction")
}

func TestWorkflowRunService_DispatchForEvent_UsesTransactionWhenSupported(t *testing.T) {
	t.Parallel()
	mock := &txBeginErrWorkflowRunQuerier{mockWorkflowRunQuerier: &mockWorkflowRunQuerier{
		listDefsFn: func(_ context.Context, _ db.ListWorkflowDefinitionsByRepoParams) ([]db.WorkflowDefinition, error) {
			return []db.WorkflowDefinition{
				makeWorkflowDef(1, 42, "ci", true, `{"on":{"push":{}},"jobs":{"build":{}}}`),
			}, nil
		},
	}}
	_, err := newCurrentPushTestService(mock).DispatchForEvent(context.Background(), DispatchForEventInput{
		RepositoryID: 42,
		Event:        TriggerEvent{Type: "push", Ref: "main"},
	})
	assert.Equal(t, 500, workflowRunAPIStatus(t, err))
	assert.Equal(t, 1, mock.beginTxCalls)
	assert.Empty(t, mock.createRunCalls, "run rows must only be created inside the transaction")
}
