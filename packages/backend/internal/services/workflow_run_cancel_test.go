package services

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

type cancelRunQuerierMock struct {
	getRunFn       func(ctx context.Context, arg db.GetWorkflowRunParams) (db.WorkflowRun, error)
	cancelRunFn    func(ctx context.Context, id int64) error
	cancelTasksFn  func(ctx context.Context, workflowRunID int64) error
	notifyRunFn    func(ctx context.Context, arg db.NotifyWorkflowRunEventParams) error
	jjhubTokenIDFn func(ctx context.Context, id int64) (pgtype.Int8, error)

	getCalls               []db.GetWorkflowRunParams
	cancelRunCalls         []int64
	failRunCalls           []int64
	cancelTaskCalls        []int64
	updateAgentTokenCalls  []db.UpdateWorkflowRunAgentTokenParams
	deleteAccessTokenCalls []db.DeleteAccessTokenParams
	clearJJHubTokenCalls   []int64
}

func (m *cancelRunQuerierMock) GetRepoByID(_ context.Context, id int64) (db.Repository, error) {
	return db.Repository{
		ID:              id,
		DefaultBookmark: "main",
		Name:            "demo",
		UserID:          pgtype.Int8{Int64: 1, Valid: true},
	}, nil
}

func (m *cancelRunQuerierMock) GetUserByID(_ context.Context, id int64) (db.User, error) {
	return db.User{ID: id, Username: "testuser"}, nil
}

func (m *cancelRunQuerierMock) GetOrgByID(_ context.Context, id int64) (db.Organization, error) {
	return db.Organization{ID: id, Name: "testorg"}, nil
}

func (m *cancelRunQuerierMock) ListWorkflowDefinitionsByRepo(_ context.Context, _ db.ListWorkflowDefinitionsByRepoParams) ([]db.WorkflowDefinition, error) {
	return nil, nil
}

func (m *cancelRunQuerierMock) GetWorkflowDefinition(_ context.Context, _ db.GetWorkflowDefinitionParams) (db.WorkflowDefinition, error) {
	return db.WorkflowDefinition{}, pgx.ErrNoRows
}

func (m *cancelRunQuerierMock) EnsureWorkflowDefinitionReference(_ context.Context, arg db.EnsureWorkflowDefinitionReferenceParams) (db.WorkflowDefinition, error) {
	return db.WorkflowDefinition{ID: 1, RepositoryID: arg.RepositoryID, Path: arg.Path, Name: arg.Name}, nil
}

func (m *cancelRunQuerierMock) CreateWorkflowRun(_ context.Context, _ db.CreateWorkflowRunParams) (db.WorkflowRun, error) {
	return db.WorkflowRun{}, nil
}

func (m *cancelRunQuerierMock) CreateWorkflowStep(_ context.Context, _ db.CreateWorkflowStepParams) (db.WorkflowStep, error) {
	return db.WorkflowStep{}, nil
}

func (m *cancelRunQuerierMock) CreateWorkflowTask(_ context.Context, _ db.CreateWorkflowTaskParams) (db.WorkflowTask, error) {
	return db.WorkflowTask{}, nil
}

func (m *cancelRunQuerierMock) CreateCommitStatus(_ context.Context, _ db.CreateCommitStatusParams) (db.CommitStatus, error) {
	return db.CommitStatus{}, nil
}

func (m *cancelRunQuerierMock) GetWorkflowRun(ctx context.Context, arg db.GetWorkflowRunParams) (db.WorkflowRun, error) {
	m.getCalls = append(m.getCalls, arg)
	if m.getRunFn != nil {
		return m.getRunFn(ctx, arg)
	}
	return db.WorkflowRun{}, pgx.ErrNoRows
}

func (m *cancelRunQuerierMock) UpdateWorkflowRunAgentToken(_ context.Context, arg db.UpdateWorkflowRunAgentTokenParams) (db.WorkflowRun, error) {
	m.updateAgentTokenCalls = append(m.updateAgentTokenCalls, arg)
	return db.WorkflowRun{ID: arg.ID}, nil
}

func (m *cancelRunQuerierMock) GetWorkflowRunJJHubTokenID(ctx context.Context, id int64) (pgtype.Int8, error) {
	if m.jjhubTokenIDFn != nil {
		return m.jjhubTokenIDFn(ctx, id)
	}
	return pgtype.Int8{}, nil
}

func (m *cancelRunQuerierMock) ClearWorkflowRunJJHubTokenID(_ context.Context, id int64) error {
	m.clearJJHubTokenCalls = append(m.clearJJHubTokenCalls, id)
	return nil
}

func (m *cancelRunQuerierMock) DeleteAccessToken(_ context.Context, arg db.DeleteAccessTokenParams) error {
	m.deleteAccessTokenCalls = append(m.deleteAccessTokenCalls, arg)
	return nil
}

func (m *cancelRunQuerierMock) CancelWorkflowRun(ctx context.Context, id int64) error {
	m.cancelRunCalls = append(m.cancelRunCalls, id)
	if m.cancelRunFn != nil {
		return m.cancelRunFn(ctx, id)
	}
	return nil
}

func (m *cancelRunQuerierMock) FailWorkflowRun(_ context.Context, id int64) error {
	m.failRunCalls = append(m.failRunCalls, id)
	return nil
}

func (m *cancelRunQuerierMock) CancelWorkflowTasks(ctx context.Context, workflowRunID int64) error {
	m.cancelTaskCalls = append(m.cancelTaskCalls, workflowRunID)
	if m.cancelTasksFn != nil {
		return m.cancelTasksFn(ctx, workflowRunID)
	}
	return nil
}

func (m *cancelRunQuerierMock) ResumeWorkflowRun(_ context.Context, _ int64) error {
	return nil
}

func (m *cancelRunQuerierMock) ResumeWorkflowTasks(_ context.Context, _ int64) error {
	return nil
}

func (m *cancelRunQuerierMock) ResumeWorkflowSteps(_ context.Context, _ int64) error {
	return nil
}

func (m *cancelRunQuerierMock) NotifyWorkflowRunEvent(ctx context.Context, arg db.NotifyWorkflowRunEventParams) error {
	if m.notifyRunFn != nil {
		return m.notifyRunFn(ctx, arg)
	}
	return nil
}

func cancelRunStatus(t *testing.T, err error) int {
	t.Helper()
	require.Error(t, err)
	apiErr, ok := err.(*pkgerrors.APIError)
	require.True(t, ok, "expected *pkgerrors.APIError, got %T", err)
	return apiErr.Status
}

func TestWorkflowRunService_CancelRun_DelegatesToQueries(t *testing.T) {
	t.Parallel()

	callOrder := make([]string, 0, 3)
	q := &cancelRunQuerierMock{
		getRunFn: func(_ context.Context, arg db.GetWorkflowRunParams) (db.WorkflowRun, error) {
			callOrder = append(callOrder, "get")
			return db.WorkflowRun{ID: arg.ID, RepositoryID: arg.RepositoryID, Status: "running"}, nil
		},
		cancelRunFn: func(_ context.Context, id int64) error {
			callOrder = append(callOrder, "cancel_run")
			assert.Equal(t, int64(7), id)
			return nil
		},
		cancelTasksFn: func(_ context.Context, id int64) error {
			callOrder = append(callOrder, "cancel_tasks")
			assert.Equal(t, int64(7), id)
			return nil
		},
	}

	svc := NewWorkflowRunService(q)
	err := svc.CancelRun(context.Background(), 42, 7)
	require.NoError(t, err)
	assert.Equal(t, []string{"get", "cancel_run", "cancel_tasks"}, callOrder)
}

func TestWorkflowRunService_CancelRun_NotFoundReturns404(t *testing.T) {
	t.Parallel()

	q := &cancelRunQuerierMock{
		getRunFn: func(_ context.Context, _ db.GetWorkflowRunParams) (db.WorkflowRun, error) {
			return db.WorkflowRun{}, pgx.ErrNoRows
		},
	}

	svc := NewWorkflowRunService(q)
	err := svc.CancelRun(context.Background(), 42, 7)
	assert.Equal(t, 404, cancelRunStatus(t, err))
	assert.Empty(t, q.cancelRunCalls)
	assert.Empty(t, q.cancelTaskCalls)
}

func TestWorkflowRunService_CancelRun_CancelRunErrorReturns500(t *testing.T) {
	t.Parallel()

	q := &cancelRunQuerierMock{
		getRunFn: func(_ context.Context, arg db.GetWorkflowRunParams) (db.WorkflowRun, error) {
			return db.WorkflowRun{ID: arg.ID, RepositoryID: arg.RepositoryID}, nil
		},
		cancelRunFn: func(_ context.Context, _ int64) error {
			return errors.New("db down")
		},
	}

	svc := NewWorkflowRunService(q)
	err := svc.CancelRun(context.Background(), 42, 7)
	assert.Equal(t, 500, cancelRunStatus(t, err))
	assert.Empty(t, q.cancelTaskCalls)
}

func TestWorkflowRunService_CancelRun_UpdatesCommitStatusForCancellableRun(t *testing.T) {
	t.Parallel()

	q := &cancelRunQuerierMock{
		getRunFn: func(_ context.Context, arg db.GetWorkflowRunParams) (db.WorkflowRun, error) {
			return db.WorkflowRun{ID: arg.ID, RepositoryID: arg.RepositoryID, Status: "running"}, nil
		},
	}
	statusWriter := &mockWorkflowRunCommitStatusWriter{}

	svc := NewWorkflowRunService(q, WithWorkflowRunCommitStatusWriter(statusWriter))
	err := svc.CancelRun(context.Background(), 42, 7)
	require.NoError(t, err)
	require.Len(t, statusWriter.updateCalls, 1)
	assert.Equal(t, int64(7), statusWriter.updateCalls[0].workflowRunID)
	assert.Equal(t, "cancelled", statusWriter.updateCalls[0].status)
	assert.Equal(t, "Workflow was cancelled", statusWriter.updateCalls[0].description)
}

func TestWorkflowRunService_CancelRun_DoesNotRewriteCommitStatusForTerminalRun(t *testing.T) {
	t.Parallel()

	q := &cancelRunQuerierMock{
		getRunFn: func(_ context.Context, arg db.GetWorkflowRunParams) (db.WorkflowRun, error) {
			return db.WorkflowRun{ID: arg.ID, RepositoryID: arg.RepositoryID, Status: "success"}, nil
		},
	}
	statusWriter := &mockWorkflowRunCommitStatusWriter{}
	checkRunService := &mockWorkflowRunCheckRunService{}

	svc := NewWorkflowRunService(
		q,
		WithWorkflowRunCommitStatusWriter(statusWriter),
		WithWorkflowRunGitHubCheckRunService(checkRunService),
	)
	err := svc.CancelRun(context.Background(), 42, 7)
	require.NoError(t, err)
	assert.Empty(t, statusWriter.updateCalls)
	assert.Empty(t, checkRunService.updateCalls)
}

func TestWorkflowRunService_CancelRun_RevokesAgentTokenAndJJHubToken(t *testing.T) {
	t.Parallel()

	q := &cancelRunQuerierMock{
		getRunFn: func(_ context.Context, arg db.GetWorkflowRunParams) (db.WorkflowRun, error) {
			return db.WorkflowRun{ID: arg.ID, RepositoryID: arg.RepositoryID, Status: "running"}, nil
		},
		jjhubTokenIDFn: func(_ context.Context, _ int64) (pgtype.Int8, error) {
			return pgtype.Int8{Int64: 999, Valid: true}, nil
		},
	}

	svc := NewWorkflowRunService(q)
	err := svc.CancelRun(context.Background(), 42, 7)
	require.NoError(t, err)

	require.Len(t, q.updateAgentTokenCalls, 1)
	assert.False(t, q.updateAgentTokenCalls[0].AgentTokenHash.Valid)
	require.True(t, q.updateAgentTokenCalls[0].AgentTokenExpiresAt.Valid)
	assert.True(t, q.updateAgentTokenCalls[0].AgentTokenExpiresAt.Time.Before(time.Now()))
	assert.Equal(t, int64(7), q.updateAgentTokenCalls[0].ID)

	require.Len(t, q.deleteAccessTokenCalls, 1)
	assert.Equal(t, int64(999), q.deleteAccessTokenCalls[0].ID)
	assert.Equal(t, int64(1), q.deleteAccessTokenCalls[0].UserID) // repo-owner user id from GetRepoByID mock
	require.Len(t, q.clearJJHubTokenCalls, 1)
	assert.Equal(t, int64(7), q.clearJJHubTokenCalls[0])
}

func TestWorkflowRunService_CancelRun_TerminalRunDoesNotRevoke(t *testing.T) {
	t.Parallel()

	q := &cancelRunQuerierMock{
		getRunFn: func(_ context.Context, arg db.GetWorkflowRunParams) (db.WorkflowRun, error) {
			return db.WorkflowRun{ID: arg.ID, RepositoryID: arg.RepositoryID, Status: "success"}, nil
		},
	}

	svc := NewWorkflowRunService(q)
	err := svc.CancelRun(context.Background(), 42, 7)
	require.NoError(t, err)
	assert.Empty(t, q.updateAgentTokenCalls)
	assert.Empty(t, q.deleteAccessTokenCalls)
	assert.Empty(t, q.clearJJHubTokenCalls)
}

func TestWorkflowRunService_CancelRun_CompletesGitHubCheckRunForActiveRun(t *testing.T) {
	t.Parallel()

	q := &cancelRunQuerierMock{
		getRunFn: func(_ context.Context, arg db.GetWorkflowRunParams) (db.WorkflowRun, error) {
			return db.WorkflowRun{
				ID:           arg.ID,
				RepositoryID: arg.RepositoryID,
				Status:       "running",
				CheckRunID:   pgtype.Int8{Int64: 1234, Valid: true},
			}, nil
		},
	}
	checkRunService := &mockWorkflowRunCheckRunService{}

	svc := NewWorkflowRunService(q, WithWorkflowRunGitHubCheckRunService(checkRunService), WithWorkflowRunGitHubInstallationResolver(&mockRunnerInstallationResolver{
		resolveFn: func(_ context.Context, _, _ int64, owner, repo string) (int64, error) {
			assert.Equal(t, "testuser", owner)
			assert.Equal(t, "demo", repo)
			return 99, nil
		},
	}))
	err := svc.CancelRun(context.Background(), 42, 7)
	require.NoError(t, err)

	require.Len(t, checkRunService.updateCalls, 1)
	call := checkRunService.updateCalls[0]
	assert.Equal(t, int64(99), call.installationID)
	assert.Equal(t, "testuser", call.owner)
	assert.Equal(t, "demo", call.repo)
	assert.Equal(t, int64(1234), call.checkRunID)
	assert.Equal(t, "completed", call.update.Status)
	assert.Equal(t, "cancelled", call.update.Conclusion)
	require.NotNil(t, call.update.Output)
	assert.Equal(t, "Workflow cancelled", call.update.Output.Title)
	assert.Contains(t, call.update.Output.Summary, "run #7")
}
