package services

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// ─── Mock querier for WorkflowAPIService ─────────────────────────────────────

type mockWorkflowAPIQuerier struct {
	listDefsByRepoFn           func(ctx context.Context, arg db.ListWorkflowDefinitionsByRepoParams) ([]db.WorkflowDefinition, error)
	getWorkflowDefinitionFn    func(ctx context.Context, arg db.GetWorkflowDefinitionParams) (db.WorkflowDefinition, error)
	listRunsByRepoFn           func(ctx context.Context, arg db.ListWorkflowRunsByRepoParams) ([]db.WorkflowRun, error)
	listRunsByDefFn            func(ctx context.Context, arg db.ListWorkflowRunsByDefinitionParams) ([]db.WorkflowRun, error)
	getRunFn                   func(ctx context.Context, arg db.GetWorkflowRunParams) (db.WorkflowRun, error)
	listWorkflowStepsByRunIDFn func(ctx context.Context, runID int64) ([]db.WorkflowStep, error)
	listWorkflowLogsSinceFn    func(ctx context.Context, arg db.ListWorkflowLogsSinceParams) ([]db.WorkflowLog, error)
}

func (m *mockWorkflowAPIQuerier) ListWorkflowDefinitionsByRepo(ctx context.Context, arg db.ListWorkflowDefinitionsByRepoParams) ([]db.WorkflowDefinition, error) {
	if m.listDefsByRepoFn != nil {
		return m.listDefsByRepoFn(ctx, arg)
	}
	return nil, nil
}

func (m *mockWorkflowAPIQuerier) GetWorkflowDefinition(ctx context.Context, arg db.GetWorkflowDefinitionParams) (db.WorkflowDefinition, error) {
	if m.getWorkflowDefinitionFn != nil {
		return m.getWorkflowDefinitionFn(ctx, arg)
	}
	return db.WorkflowDefinition{}, pgx.ErrNoRows
}

func (m *mockWorkflowAPIQuerier) ListWorkflowRunsByRepo(ctx context.Context, arg db.ListWorkflowRunsByRepoParams) ([]db.WorkflowRun, error) {
	if m.listRunsByRepoFn != nil {
		return m.listRunsByRepoFn(ctx, arg)
	}
	return nil, nil
}

func (m *mockWorkflowAPIQuerier) ListWorkflowRunsByDefinition(ctx context.Context, arg db.ListWorkflowRunsByDefinitionParams) ([]db.WorkflowRun, error) {
	if m.listRunsByDefFn != nil {
		return m.listRunsByDefFn(ctx, arg)
	}
	return nil, nil
}

func (m *mockWorkflowAPIQuerier) GetWorkflowRun(ctx context.Context, arg db.GetWorkflowRunParams) (db.WorkflowRun, error) {
	if m.getRunFn != nil {
		return m.getRunFn(ctx, arg)
	}
	return db.WorkflowRun{}, pgx.ErrNoRows
}

func (m *mockWorkflowAPIQuerier) ListWorkflowStepsByRunID(ctx context.Context, runID int64) ([]db.WorkflowStep, error) {
	if m.listWorkflowStepsByRunIDFn != nil {
		return m.listWorkflowStepsByRunIDFn(ctx, runID)
	}
	return nil, nil
}

func (m *mockWorkflowAPIQuerier) ListWorkflowLogsSince(ctx context.Context, arg db.ListWorkflowLogsSinceParams) ([]db.WorkflowLog, error) {
	if m.listWorkflowLogsSinceFn != nil {
		return m.listWorkflowLogsSinceFn(ctx, arg)
	}
	return nil, nil
}

var _ WorkflowAPIQuerier = (*mockWorkflowAPIQuerier)(nil)

// ─── Mock WorkflowRunService ──────────────────────────────────────────────────

type mockWorkflowRunService struct {
	dispatchFn func(ctx context.Context, input DispatchForEventInput) ([]WorkflowRunResult, error)
	cancelFn   func(ctx context.Context, repositoryID, runID int64) error
}

func (m *mockWorkflowRunService) DispatchForEvent(ctx context.Context, input DispatchForEventInput) ([]WorkflowRunResult, error) {
	if m.dispatchFn != nil {
		return m.dispatchFn(ctx, input)
	}
	return nil, nil
}

func (m *mockWorkflowRunService) CancelRun(ctx context.Context, repositoryID, runID int64) error {
	if m.cancelFn != nil {
		return m.cancelFn(ctx, repositoryID, runID)
	}
	return nil
}

func (m *mockWorkflowRunService) RerunRun(ctx context.Context, input RerunInput) (*WorkflowRunResult, error) {
	return &WorkflowRunResult{WorkflowRunID: 999, WorkflowDefinitionID: input.RepositoryID}, nil
}

func (m *mockWorkflowRunService) ResumeRun(_ context.Context, _, _ int64) error {
	return nil
}

var _ WorkflowRunService = (*mockWorkflowRunService)(nil)

// ─── Helpers ──────────────────────────────────────────────────────────────────

func makeAPIWFDef(id, repoID int64, name string) db.WorkflowDefinition {
	return db.WorkflowDefinition{
		ID:           id,
		RepositoryID: repoID,
		Name:         name,
		Path:         ".smithers/workflows/" + name + ".tsx",
		Config:       []byte(`{"on":{"push":{}},"jobs":{}}`),
		IsActive:     true,
		CreatedAt:    time.Now(),
		UpdatedAt:    time.Now(),
	}
}

func makeAPIWFRun(id, repoID, defID int64, status string) db.WorkflowRun {
	return db.WorkflowRun{
		ID:                   id,
		RepositoryID:         repoID,
		WorkflowDefinitionID: defID,
		Status:               status,
		TriggerEvent:         "push",
		TriggerRef:           "main",
		TriggerCommitSha:     "abc123",
		CreatedAt:            time.Now(),
		UpdatedAt:            time.Now(),
	}
}

func wfAPIStatus(t *testing.T, err error) int {
	t.Helper()
	require.Error(t, err)
	apiErr, ok := err.(*pkgerrors.APIError)
	require.True(t, ok, "expected *pkgerrors.APIError, got %T: %v", err, err)
	return apiErr.Status
}

// ─── ListWorkflowDefinitions ──────────────────────────────────────────────────

func TestWorkflowAPIService_ListWorkflowDefinitions_NilQueries_ReturnsInternal(t *testing.T) {
	t.Parallel()
	svc := NewWorkflowAPIService(nil, &mockWorkflowRunService{})
	_, err := svc.ListWorkflowDefinitions(context.Background(), 1, 1, 30)
	assert.Equal(t, 500, wfAPIStatus(t, err))
}

func TestWorkflowAPIService_ListWorkflowDefinitions_ReturnsEmpty(t *testing.T) {
	t.Parallel()
	mock := &mockWorkflowAPIQuerier{
		listDefsByRepoFn: func(_ context.Context, arg db.ListWorkflowDefinitionsByRepoParams) ([]db.WorkflowDefinition, error) {
			assert.Equal(t, int64(42), arg.RepositoryID)
			assert.Equal(t, int32(0), arg.PageOffset)
			assert.Equal(t, int32(listWorkflowDefinitionsBatchSize), arg.PageSize)
			return []db.WorkflowDefinition{}, nil
		},
	}
	svc := NewWorkflowAPIService(mock, &mockWorkflowRunService{})
	defs, err := svc.ListWorkflowDefinitions(context.Background(), 42, 1, 30)
	require.NoError(t, err)
	assert.Empty(t, defs)
}

func TestWorkflowAPIService_ListWorkflowDefinitions_ReturnsDefs(t *testing.T) {
	t.Parallel()
	mock := &mockWorkflowAPIQuerier{
		listDefsByRepoFn: func(_ context.Context, _ db.ListWorkflowDefinitionsByRepoParams) ([]db.WorkflowDefinition, error) {
			return []db.WorkflowDefinition{
				makeAPIWFDef(1, 42, "ci"),
				makeAPIWFDef(2, 42, "deploy"),
			}, nil
		},
	}
	svc := NewWorkflowAPIService(mock, &mockWorkflowRunService{})
	defs, err := svc.ListWorkflowDefinitions(context.Background(), 42, 1, 30)
	require.NoError(t, err)
	assert.Len(t, defs, 2)
}

func TestWorkflowAPIService_ListWorkflowDefinitions_PaginationOffset(t *testing.T) {
	t.Parallel()
	all := make([]db.WorkflowDefinition, 0, 25)
	for i := int64(1); i <= 25; i++ {
		all = append(all, makeAPIWFDef(i, 42, "wf"))
	}
	mock := &mockWorkflowAPIQuerier{
		listDefsByRepoFn: func(_ context.Context, arg db.ListWorkflowDefinitionsByRepoParams) ([]db.WorkflowDefinition, error) {
			start := int(arg.PageOffset)
			if start >= len(all) {
				return nil, nil
			}
			end := start + int(arg.PageSize)
			if end > len(all) {
				end = len(all)
			}
			return all[start:end], nil
		},
	}
	svc := NewWorkflowAPIService(mock, &mockWorkflowRunService{})
	defs, err := svc.ListWorkflowDefinitions(context.Background(), 42, 3, 10)
	require.NoError(t, err)
	require.Len(t, defs, 5, "page=3, per_page=10 over 25 rows → last 5")
	assert.Equal(t, int64(21), defs[0].ID)
}

func TestWorkflowAPIService_ListWorkflowDefinitions_NegativePerPage_DefaultsTo30(t *testing.T) {
	t.Parallel()
	all := make([]db.WorkflowDefinition, 0, 40)
	for i := int64(1); i <= 40; i++ {
		all = append(all, makeAPIWFDef(i, 42, "wf"))
	}
	mock := &mockWorkflowAPIQuerier{
		listDefsByRepoFn: func(_ context.Context, arg db.ListWorkflowDefinitionsByRepoParams) ([]db.WorkflowDefinition, error) {
			start := int(arg.PageOffset)
			if start >= len(all) {
				return nil, nil
			}
			end := start + int(arg.PageSize)
			if end > len(all) {
				end = len(all)
			}
			return all[start:end], nil
		},
	}
	svc := NewWorkflowAPIService(mock, &mockWorkflowRunService{})
	defs, err := svc.ListWorkflowDefinitions(context.Background(), 42, 1, 0)
	require.NoError(t, err)
	assert.Len(t, defs, 30, "perPage<=0 should default to 30")
}

func TestWorkflowAPIService_ListWorkflowDefinitions_FiltersInactive(t *testing.T) {
	t.Parallel()
	inactive := makeAPIWFDef(2, 42, "removed")
	inactive.IsActive = false
	mock := &mockWorkflowAPIQuerier{
		listDefsByRepoFn: func(_ context.Context, arg db.ListWorkflowDefinitionsByRepoParams) ([]db.WorkflowDefinition, error) {
			if arg.PageOffset > 0 {
				return nil, nil
			}
			return []db.WorkflowDefinition{
				makeAPIWFDef(1, 42, "ci"),
				inactive,
				makeAPIWFDef(3, 42, "deploy"),
			}, nil
		},
	}
	svc := NewWorkflowAPIService(mock, &mockWorkflowRunService{})
	defs, err := svc.ListWorkflowDefinitions(context.Background(), 42, 1, 30)
	require.NoError(t, err)
	require.Len(t, defs, 2, "soft-deleted (is_active=FALSE) definitions must not be listed")
	assert.Equal(t, int64(1), defs[0].ID)
	assert.Equal(t, int64(3), defs[1].ID)
}

func TestWorkflowAPIService_ListWorkflowDefinitions_DBError_ReturnsError(t *testing.T) {
	t.Parallel()
	mock := &mockWorkflowAPIQuerier{
		listDefsByRepoFn: func(_ context.Context, _ db.ListWorkflowDefinitionsByRepoParams) ([]db.WorkflowDefinition, error) {
			return nil, errors.New("db unavailable")
		},
	}
	svc := NewWorkflowAPIService(mock, &mockWorkflowRunService{})
	_, err := svc.ListWorkflowDefinitions(context.Background(), 42, 1, 30)
	require.Error(t, err)
}

// ─── GetWorkflowDefinition ────────────────────────────────────────────────────

func TestWorkflowAPIService_GetWorkflowDefinition_NilQueries_ReturnsInternal(t *testing.T) {
	t.Parallel()
	svc := NewWorkflowAPIService(nil, &mockWorkflowRunService{})
	_, err := svc.GetWorkflowDefinition(context.Background(), 1, 1)
	assert.Equal(t, 500, wfAPIStatus(t, err))
}

func TestWorkflowAPIService_GetWorkflowDefinition_NotFound_Returns404(t *testing.T) {
	t.Parallel()
	mock := &mockWorkflowAPIQuerier{
		getWorkflowDefinitionFn: func(_ context.Context, _ db.GetWorkflowDefinitionParams) (db.WorkflowDefinition, error) {
			return db.WorkflowDefinition{}, pgx.ErrNoRows
		},
	}
	svc := NewWorkflowAPIService(mock, &mockWorkflowRunService{})
	_, err := svc.GetWorkflowDefinition(context.Background(), 42, 99)
	assert.Equal(t, 404, wfAPIStatus(t, err))
}

func TestWorkflowAPIService_GetWorkflowDefinition_DBError_ReturnsInternal(t *testing.T) {
	t.Parallel()
	mock := &mockWorkflowAPIQuerier{
		getWorkflowDefinitionFn: func(_ context.Context, _ db.GetWorkflowDefinitionParams) (db.WorkflowDefinition, error) {
			return db.WorkflowDefinition{}, errors.New("connection reset")
		},
	}
	svc := NewWorkflowAPIService(mock, &mockWorkflowRunService{})
	_, err := svc.GetWorkflowDefinition(context.Background(), 42, 5)
	assert.Equal(t, 500, wfAPIStatus(t, err))
}

func TestWorkflowAPIService_GetWorkflowDefinition_ReturnsDef(t *testing.T) {
	t.Parallel()
	mock := &mockWorkflowAPIQuerier{
		getWorkflowDefinitionFn: func(_ context.Context, arg db.GetWorkflowDefinitionParams) (db.WorkflowDefinition, error) {
			assert.Equal(t, int64(42), arg.RepositoryID)
			assert.Equal(t, int64(5), arg.ID)
			return makeAPIWFDef(5, 42, "ci"), nil
		},
	}
	svc := NewWorkflowAPIService(mock, &mockWorkflowRunService{})
	def, err := svc.GetWorkflowDefinition(context.Background(), 42, 5)
	require.NoError(t, err)
	assert.Equal(t, int64(5), def.ID)
	assert.Equal(t, "ci", def.Name)
}

// ─── ListWorkflowRunsByRepo ───────────────────────────────────────────────────

func TestWorkflowAPIService_ListWorkflowRunsByRepo_NilQueries_ReturnsInternal(t *testing.T) {
	t.Parallel()
	svc := NewWorkflowAPIService(nil, &mockWorkflowRunService{})
	_, err := svc.ListWorkflowRunsByRepo(context.Background(), 1, 1, 30)
	assert.Equal(t, 500, wfAPIStatus(t, err))
}

func TestWorkflowAPIService_ListWorkflowRunsByRepo_ReturnsRuns(t *testing.T) {
	t.Parallel()
	mock := &mockWorkflowAPIQuerier{
		listRunsByRepoFn: func(_ context.Context, arg db.ListWorkflowRunsByRepoParams) ([]db.WorkflowRun, error) {
			assert.Equal(t, int64(42), arg.RepositoryID)
			return []db.WorkflowRun{
				makeAPIWFRun(1, 42, 5, "done"),
				makeAPIWFRun(2, 42, 5, "running"),
			}, nil
		},
	}
	svc := NewWorkflowAPIService(mock, &mockWorkflowRunService{})
	runs, err := svc.ListWorkflowRunsByRepo(context.Background(), 42, 1, 30)
	require.NoError(t, err)
	assert.Len(t, runs, 2)
}

func TestWorkflowAPIService_ListWorkflowRunsByRepo_PaginationOffset(t *testing.T) {
	t.Parallel()
	var capturedArg db.ListWorkflowRunsByRepoParams
	mock := &mockWorkflowAPIQuerier{
		listRunsByRepoFn: func(_ context.Context, arg db.ListWorkflowRunsByRepoParams) ([]db.WorkflowRun, error) {
			capturedArg = arg
			return nil, nil
		},
	}
	svc := NewWorkflowAPIService(mock, &mockWorkflowRunService{})
	_, err := svc.ListWorkflowRunsByRepo(context.Background(), 42, 2, 15)
	require.NoError(t, err)
	assert.Equal(t, int32(15), capturedArg.PageOffset, "page=2, per_page=15 → offset=15")
	assert.Equal(t, int32(15), capturedArg.PageSize)
}

// ─── ListWorkflowRunsByDefinition ────────────────────────────────────────────

func TestWorkflowAPIService_ListWorkflowRunsByDefinition_NilQueries_ReturnsInternal(t *testing.T) {
	t.Parallel()
	svc := NewWorkflowAPIService(nil, &mockWorkflowRunService{})
	_, err := svc.ListWorkflowRunsByDefinition(context.Background(), 1, 1, 1, 30)
	assert.Equal(t, 500, wfAPIStatus(t, err))
}

func TestWorkflowAPIService_ListWorkflowRunsByDefinition_PassesCorrectParams(t *testing.T) {
	t.Parallel()
	var capturedArg db.ListWorkflowRunsByDefinitionParams
	mock := &mockWorkflowAPIQuerier{
		listRunsByDefFn: func(_ context.Context, arg db.ListWorkflowRunsByDefinitionParams) ([]db.WorkflowRun, error) {
			capturedArg = arg
			return []db.WorkflowRun{makeAPIWFRun(1, 42, 5, "done")}, nil
		},
	}
	svc := NewWorkflowAPIService(mock, &mockWorkflowRunService{})
	runs, err := svc.ListWorkflowRunsByDefinition(context.Background(), 42, 5, 1, 30)
	require.NoError(t, err)
	assert.Len(t, runs, 1)
	assert.Equal(t, int64(42), capturedArg.RepositoryID)
	assert.Equal(t, int64(5), capturedArg.WorkflowDefinitionID)
}

func TestWorkflowAPIService_ListWorkflowRunsByDefinition_DBError_ReturnsError(t *testing.T) {
	t.Parallel()
	mock := &mockWorkflowAPIQuerier{
		listRunsByDefFn: func(_ context.Context, _ db.ListWorkflowRunsByDefinitionParams) ([]db.WorkflowRun, error) {
			return nil, errors.New("timeout")
		},
	}
	svc := NewWorkflowAPIService(mock, &mockWorkflowRunService{})
	_, err := svc.ListWorkflowRunsByDefinition(context.Background(), 42, 5, 1, 30)
	require.Error(t, err)
}

// ─── GetWorkflowRun ───────────────────────────────────────────────────────────

func TestWorkflowAPIService_GetWorkflowRun_NilQueries_ReturnsInternal(t *testing.T) {
	t.Parallel()
	svc := NewWorkflowAPIService(nil, &mockWorkflowRunService{})
	_, err := svc.GetWorkflowRun(context.Background(), 1, 1)
	assert.Equal(t, 500, wfAPIStatus(t, err))
}

func TestWorkflowAPIService_GetWorkflowRun_NotFound_Returns404(t *testing.T) {
	t.Parallel()
	mock := &mockWorkflowAPIQuerier{
		getRunFn: func(_ context.Context, _ db.GetWorkflowRunParams) (db.WorkflowRun, error) {
			return db.WorkflowRun{}, pgx.ErrNoRows
		},
	}
	svc := NewWorkflowAPIService(mock, &mockWorkflowRunService{})
	_, err := svc.GetWorkflowRun(context.Background(), 42, 99)
	assert.Equal(t, 404, wfAPIStatus(t, err))
}

func TestWorkflowAPIService_GetWorkflowRun_DBError_ReturnsInternal(t *testing.T) {
	t.Parallel()
	mock := &mockWorkflowAPIQuerier{
		getRunFn: func(_ context.Context, _ db.GetWorkflowRunParams) (db.WorkflowRun, error) {
			return db.WorkflowRun{}, errors.New("connection refused")
		},
	}
	svc := NewWorkflowAPIService(mock, &mockWorkflowRunService{})
	_, err := svc.GetWorkflowRun(context.Background(), 42, 5)
	assert.Equal(t, 500, wfAPIStatus(t, err))
}

func TestWorkflowAPIService_GetWorkflowRun_ReturnsRun(t *testing.T) {
	t.Parallel()
	mock := &mockWorkflowAPIQuerier{
		getRunFn: func(_ context.Context, arg db.GetWorkflowRunParams) (db.WorkflowRun, error) {
			assert.Equal(t, int64(42), arg.RepositoryID)
			assert.Equal(t, int64(7), arg.ID)
			return makeAPIWFRun(7, 42, 5, "pending"), nil
		},
	}
	svc := NewWorkflowAPIService(mock, &mockWorkflowRunService{})
	run, err := svc.GetWorkflowRun(context.Background(), 42, 7)
	require.NoError(t, err)
	assert.Equal(t, int64(7), run.ID)
	assert.Equal(t, "pending", run.Status)
}

// ─── DispatchForEvent (delegates to runner) ───────────────────────────────────

func TestWorkflowAPIService_DispatchForEvent_NilRunner_ReturnsInternal(t *testing.T) {
	t.Parallel()
	svc := NewWorkflowAPIService(&mockWorkflowAPIQuerier{}, nil)
	_, err := svc.DispatchForEvent(context.Background(), DispatchForEventInput{
		RepositoryID: 1,
		Event:        TriggerEvent{Type: "push", Ref: "main"},
	})
	assert.Equal(t, 500, wfAPIStatus(t, err))
}

func TestWorkflowAPIService_DispatchForEvent_DelegatesToRunner(t *testing.T) {
	t.Parallel()
	var capturedInput DispatchForEventInput
	runner := &mockWorkflowRunService{
		dispatchFn: func(_ context.Context, input DispatchForEventInput) ([]WorkflowRunResult, error) {
			capturedInput = input
			return []WorkflowRunResult{{WorkflowRunID: 100}}, nil
		},
	}
	svc := NewWorkflowAPIService(&mockWorkflowAPIQuerier{}, runner)
	results, err := svc.DispatchForEvent(context.Background(), DispatchForEventInput{
		RepositoryID: 42,
		Event:        TriggerEvent{Type: "push", Ref: "main", CommitSHA: "abc123"},
	})
	require.NoError(t, err)
	assert.Len(t, results, 1)
	assert.Equal(t, int64(100), results[0].WorkflowRunID)
	assert.Equal(t, int64(42), capturedInput.RepositoryID)
	assert.Equal(t, "push", capturedInput.Event.Type)
	assert.Equal(t, "main", capturedInput.Event.Ref)
}

func TestWorkflowAPIService_DispatchForEvent_RunnerError_Propagates(t *testing.T) {
	t.Parallel()
	runner := &mockWorkflowRunService{
		dispatchFn: func(_ context.Context, _ DispatchForEventInput) ([]WorkflowRunResult, error) {
			return nil, pkgerrors.Internal("runner unavailable")
		},
	}
	svc := NewWorkflowAPIService(&mockWorkflowAPIQuerier{}, runner)
	_, err := svc.DispatchForEvent(context.Background(), DispatchForEventInput{
		RepositoryID: 42,
		Event:        TriggerEvent{Type: "push", Ref: "main"},
	})
	assert.Equal(t, 500, wfAPIStatus(t, err))
}

// CancelWorkflowRun tests verify the cancel workflow functionality.

func TestWorkflowAPIService_CancelWorkflowRun_NilRunner_ReturnsInternal(t *testing.T) {
	t.Parallel()
	svc := NewWorkflowAPIService(&mockWorkflowAPIQuerier{}, nil)
	err := svc.CancelWorkflowRun(context.Background(), 1, 1)
	assert.Equal(t, 500, wfAPIStatus(t, err))
}

func TestWorkflowAPIService_CancelWorkflowRun_DelegatesToRunner(t *testing.T) {
	t.Parallel()
	var capturedRepoID int64
	var capturedRunID int64
	runner := &mockWorkflowRunService{
		cancelFn: func(_ context.Context, repositoryID, runID int64) error {
			capturedRepoID = repositoryID
			capturedRunID = runID
			return nil
		},
	}
	svc := NewWorkflowAPIService(&mockWorkflowAPIQuerier{}, runner)
	err := svc.CancelWorkflowRun(context.Background(), 42, 9)
	require.NoError(t, err)
	assert.Equal(t, int64(42), capturedRepoID)
	assert.Equal(t, int64(9), capturedRunID)
}

func TestWorkflowAPIService_CancelWorkflowRun_RunnerError_Propagates(t *testing.T) {
	t.Parallel()
	runner := &mockWorkflowRunService{
		cancelFn: func(_ context.Context, _, _ int64) error {
			return pkgerrors.NotFound("workflow run not found")
		},
	}
	svc := NewWorkflowAPIService(&mockWorkflowAPIQuerier{}, runner)
	err := svc.CancelWorkflowRun(context.Background(), 42, 9)
	assert.Equal(t, 404, wfAPIStatus(t, err))
}

// ─── ListWorkflowSteps ────────────────────────────────────────────────────────

func TestWorkflowAPIService_ListWorkflowSteps_NilQueries_ReturnsInternal(t *testing.T) {
	t.Parallel()
	svc := NewWorkflowAPIService(nil, &mockWorkflowRunService{})
	_, err := svc.ListWorkflowSteps(context.Background(), 1)
	assert.Equal(t, 500, wfAPIStatus(t, err))
}

func TestWorkflowAPIService_ListWorkflowSteps_DelegatesToQuerier(t *testing.T) {
	t.Parallel()
	var capturedRunID int64
	expectedSteps := []db.WorkflowStep{
		{ID: 1, WorkflowRunID: 42, Name: "build", Position: 1, Status: "done"},
		{ID: 2, WorkflowRunID: 42, Name: "test", Position: 2, Status: "running"},
	}
	mock := &mockWorkflowAPIQuerier{
		listWorkflowStepsByRunIDFn: func(_ context.Context, runID int64) ([]db.WorkflowStep, error) {
			capturedRunID = runID
			return expectedSteps, nil
		},
	}
	svc := NewWorkflowAPIService(mock, &mockWorkflowRunService{})
	steps, err := svc.ListWorkflowSteps(context.Background(), 42)
	require.NoError(t, err)
	assert.Equal(t, int64(42), capturedRunID)
	assert.Len(t, steps, 2)
	assert.Equal(t, "build", steps[0].Name)
	assert.Equal(t, "test", steps[1].Name)
}

func TestWorkflowAPIService_ListWorkflowSteps_DBError_Propagates(t *testing.T) {
	t.Parallel()
	mock := &mockWorkflowAPIQuerier{
		listWorkflowStepsByRunIDFn: func(_ context.Context, _ int64) ([]db.WorkflowStep, error) {
			return nil, errors.New("db timeout")
		},
	}
	svc := NewWorkflowAPIService(mock, &mockWorkflowRunService{})
	_, err := svc.ListWorkflowSteps(context.Background(), 1)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "db timeout")
}

// ─── ListWorkflowLogsSince ────────────────────────────────────────────────────

func TestWorkflowAPIService_ListWorkflowLogsSince_NilQueries_ReturnsInternal(t *testing.T) {
	t.Parallel()
	svc := NewWorkflowAPIService(nil, &mockWorkflowRunService{})
	_, err := svc.ListWorkflowLogsSince(context.Background(), 1, 0, 100)
	assert.Equal(t, 500, wfAPIStatus(t, err))
}

func TestWorkflowAPIService_ListWorkflowLogsSince_DelegatesToQuerier(t *testing.T) {
	t.Parallel()
	var capturedParams db.ListWorkflowLogsSinceParams
	expectedLogs := []db.WorkflowLog{
		{ID: 10, WorkflowRunID: 42, Sequence: 1, Entry: "step started"},
		{ID: 11, WorkflowRunID: 42, Sequence: 2, Entry: "compiling..."},
	}
	mock := &mockWorkflowAPIQuerier{
		listWorkflowLogsSinceFn: func(_ context.Context, arg db.ListWorkflowLogsSinceParams) ([]db.WorkflowLog, error) {
			capturedParams = arg
			return expectedLogs, nil
		},
	}
	svc := NewWorkflowAPIService(mock, &mockWorkflowRunService{})
	logs, err := svc.ListWorkflowLogsSince(context.Background(), 42, 5, 100)
	require.NoError(t, err)
	assert.Equal(t, int64(42), capturedParams.RunID, "RunID must match")
	assert.Equal(t, int64(5), capturedParams.AfterID, "AfterID must match")
	assert.Equal(t, int32(100), capturedParams.PageSize, "PageSize must match")
	assert.Len(t, logs, 2)
	assert.Equal(t, "step started", logs[0].Entry)
	assert.Equal(t, "compiling...", logs[1].Entry)
}

func TestWorkflowAPIService_ListWorkflowLogsSince_DBError_Propagates(t *testing.T) {
	t.Parallel()
	mock := &mockWorkflowAPIQuerier{
		listWorkflowLogsSinceFn: func(_ context.Context, _ db.ListWorkflowLogsSinceParams) ([]db.WorkflowLog, error) {
			return nil, errors.New("connection refused")
		},
	}
	svc := NewWorkflowAPIService(mock, &mockWorkflowRunService{})
	_, err := svc.ListWorkflowLogsSince(context.Background(), 42, 0, 50)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "connection refused")
}

func TestWorkflowAPIService_ListWorkflowLogsSince_ParamMapping_AfterIDZero(t *testing.T) {
	t.Parallel()
	var capturedParams db.ListWorkflowLogsSinceParams
	mock := &mockWorkflowAPIQuerier{
		listWorkflowLogsSinceFn: func(_ context.Context, arg db.ListWorkflowLogsSinceParams) ([]db.WorkflowLog, error) {
			capturedParams = arg
			return nil, nil
		},
	}
	svc := NewWorkflowAPIService(mock, &mockWorkflowRunService{})
	_, err := svc.ListWorkflowLogsSince(context.Background(), 99, 0, 1000)
	require.NoError(t, err)
	assert.Equal(t, int64(99), capturedParams.RunID)
	assert.Equal(t, int64(0), capturedParams.AfterID, "zero afterID must be passed through (get all logs)")
	assert.Equal(t, int32(1000), capturedParams.PageSize)
}

// ─── ValidateDispatchInputs ───────────────────────────────────────────────────

func TestValidateDispatchInputs_NilConfig_AcceptsNilInputs(t *testing.T) {
	t.Parallel()
	_, err := ValidateDispatchInputs(nil, nil)
	require.NoError(t, err)
}

func TestValidateDispatchInputs_EmptyConfig_AcceptsNilInputs(t *testing.T) {
	t.Parallel()
	_, err := ValidateDispatchInputs(json.RawMessage(`{}`), nil)
	require.NoError(t, err)
}

func TestValidateDispatchInputs_NoInputSchema_AcceptsAnyInputs(t *testing.T) {
	t.Parallel()
	cfg := json.RawMessage(`{"on":{"workflow_dispatch":{}}}`)
	_, err := ValidateDispatchInputs(cfg, map[string]interface{}{"foo": "bar"})
	require.NoError(t, err)
}

func TestValidateDispatchInputs_RequiredInputMissing_ReturnsValidationError(t *testing.T) {
	t.Parallel()
	cfg := json.RawMessage(`{
		"on":{"workflow_dispatch":{"inputs":{
			"env":{"required":true,"description":"Target environment"}
		}}}
	}`)
	_, err := ValidateDispatchInputs(cfg, nil)
	require.Error(t, err)
	apiErr, ok := err.(*pkgerrors.APIError)
	require.True(t, ok)
	assert.Equal(t, 422, apiErr.Status)
	// Should reference the missing field
	found := false
	for _, fe := range apiErr.Errors {
		if fe.Field == "env" && fe.Code == "missing_field" {
			found = true
		}
	}
	assert.True(t, found, "expected validation error for 'env'")
}

func TestValidateDispatchInputs_RequiredInputProvided_NoError(t *testing.T) {
	t.Parallel()
	cfg := json.RawMessage(`{
		"on":{"workflow_dispatch":{"inputs":{
			"env":{"required":true,"description":"Target environment"}
		}}}
	}`)
	merged, err := ValidateDispatchInputs(cfg, map[string]interface{}{"env": "production"})
	require.NoError(t, err)
	assert.Equal(t, "production", merged["env"])
}

func TestValidateDispatchInputs_OptionalInputOmitted_NoError(t *testing.T) {
	t.Parallel()
	cfg := json.RawMessage(`{
		"on":{"workflow_dispatch":{"inputs":{
			"env":{"required":false,"default":"staging"}
		}}}
	}`)
	merged, err := ValidateDispatchInputs(cfg, map[string]interface{}{})
	require.NoError(t, err)
	assert.Equal(t, "staging", merged["env"], "default value should be applied")
}

func TestValidateDispatchInputs_UnknownInput_ReturnsValidationError(t *testing.T) {
	t.Parallel()
	cfg := json.RawMessage(`{
		"on":{"workflow_dispatch":{"inputs":{
			"env":{"required":false}
		}}}
	}`)
	_, err := ValidateDispatchInputs(cfg, map[string]interface{}{"env": "prod", "unknown_key": "val"})
	require.Error(t, err)
	apiErr, ok := err.(*pkgerrors.APIError)
	require.True(t, ok)
	assert.Equal(t, 422, apiErr.Status)
	found := false
	for _, fe := range apiErr.Errors {
		if fe.Field == "unknown_key" {
			found = true
		}
	}
	assert.True(t, found, "expected validation error for 'unknown_key'")
}

func TestValidateDispatchInputs_MultipleRequired_AllPresent(t *testing.T) {
	t.Parallel()
	cfg := json.RawMessage(`{
		"on":{"workflow_dispatch":{"inputs":{
			"env":{"required":true},
			"version":{"required":true}
		}}}
	}`)
	merged, err := ValidateDispatchInputs(cfg, map[string]interface{}{"env": "prod", "version": "1.0"})
	require.NoError(t, err)
	assert.Equal(t, "prod", merged["env"])
	assert.Equal(t, "1.0", merged["version"])
}

func TestValidateDispatchInputs_MultipleRequired_SomeMissing(t *testing.T) {
	t.Parallel()
	cfg := json.RawMessage(`{
		"on":{"workflow_dispatch":{"inputs":{
			"env":{"required":true},
			"version":{"required":true}
		}}}
	}`)
	_, err := ValidateDispatchInputs(cfg, map[string]interface{}{"env": "prod"})
	require.Error(t, err)
	apiErr, ok := err.(*pkgerrors.APIError)
	require.True(t, ok)
	assert.Equal(t, 422, apiErr.Status)
	found := false
	for _, fe := range apiErr.Errors {
		if fe.Field == "version" && fe.Code == "missing_field" {
			found = true
		}
	}
	assert.True(t, found, "expected validation error for 'version'")
}
