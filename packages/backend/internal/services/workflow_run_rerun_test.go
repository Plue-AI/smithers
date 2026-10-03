package services

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// ─── RerunRun tests ───────────────────────────────────────────────────────────

func TestWorkflowRunService_RerunRun_NilQuerier_ReturnsInternalError(t *testing.T) {
	t.Parallel()
	svc := NewWorkflowRunService(nil)
	_, err := svc.RerunRun(context.Background(), RerunInput{
		RepositoryID: 1,
		RunID:        1,
		UserID:       1,
	})
	assert.Equal(t, 500, workflowRunAPIStatus(t, err))
}

func TestWorkflowRunService_RerunRun_RunNotFound_ReturnsNotFound(t *testing.T) {
	t.Parallel()
	mock := &mockWorkflowRunQuerier{
		getRunFn: func(_ context.Context, _ db.GetWorkflowRunParams) (db.WorkflowRun, error) {
			return db.WorkflowRun{}, pgx.ErrNoRows
		},
	}
	svc := NewWorkflowRunService(mock)
	_, err := svc.RerunRun(context.Background(), RerunInput{
		RepositoryID: 42,
		RunID:        999,
		UserID:       1,
	})
	assert.Equal(t, 404, workflowRunAPIStatus(t, err))
}

func TestWorkflowRunService_RerunRun_DefinitionNotFound_ReturnsNotFound(t *testing.T) {
	t.Parallel()
	mock := &mockWorkflowRunQuerier{
		getRunFn: func(_ context.Context, _ db.GetWorkflowRunParams) (db.WorkflowRun, error) {
			return db.WorkflowRun{
				ID:                   1,
				RepositoryID:         42,
				WorkflowDefinitionID: 999,
				TriggerEvent:         "push",
				TriggerRef:           "main",
				TriggerCommitSha:     strings.Repeat("a", 40),
			}, nil
		},
		getDefFn: func(_ context.Context, _ db.GetWorkflowDefinitionParams) (db.WorkflowDefinition, error) {
			return db.WorkflowDefinition{}, pgx.ErrNoRows
		},
	}
	svc := NewWorkflowRunService(mock)
	_, err := svc.RerunRun(context.Background(), RerunInput{
		RepositoryID: 42,
		RunID:        1,
		UserID:       1,
	})
	assert.Equal(t, 404, workflowRunAPIStatus(t, err))
}

func TestWorkflowRunService_RerunRun_RejectsInternalAlertRemediation(t *testing.T) {
	t.Parallel()
	mock := &mockWorkflowRunQuerier{
		getRunFn: func(_ context.Context, _ db.GetWorkflowRunParams) (db.WorkflowRun, error) {
			return db.WorkflowRun{
				ID: 1, RepositoryID: 42, WorkflowDefinitionID: 10,
				TriggerEvent: AlertRemediationTriggerEvent,
			}, nil
		},
		getDefFn: func(_ context.Context, _ db.GetWorkflowDefinitionParams) (db.WorkflowDefinition, error) {
			t.Fatal("definition lookup must not run for internal remediation")
			return db.WorkflowDefinition{}, nil
		},
	}

	_, err := NewWorkflowRunService(mock).RerunRun(context.Background(), RerunInput{
		RepositoryID: 42, RunID: 1, UserID: 5,
	})
	assert.Equal(t, 409, workflowRunAPIStatus(t, err))
	assert.Contains(t, err.Error(), "cannot be resumed or rerun")
	assert.Empty(t, mock.createRunCalls)
}

func TestWorkflowRunService_RerunRun_Success_CreatesNewRun(t *testing.T) {
	t.Parallel()
	repoID := int64(42)
	originalRunID := int64(1)
	defID := int64(10)
	userID := int64(5)

	originalRun := db.WorkflowRun{
		ID:                   originalRunID,
		RepositoryID:         repoID,
		WorkflowDefinitionID: defID,
		Status:               "completed",
		TriggerEvent:         "push",
		TriggerRef:           "refs/heads/main",
		TriggerCommitSha:     strings.Repeat("d", 40),
		CreatedAt:            time.Now(),
		UpdatedAt:            time.Now(),
	}

	def := makeWorkflowDef(defID, repoID, "ci", true, `{"on":{"push":{}},"jobs":{"build":{}}}`)

	mock := &mockWorkflowRunQuerier{
		getRunFn: func(_ context.Context, arg db.GetWorkflowRunParams) (db.WorkflowRun, error) {
			assert.Equal(t, originalRunID, arg.ID)
			assert.Equal(t, repoID, arg.RepositoryID)
			return originalRun, nil
		},
		getDefFn: func(_ context.Context, arg db.GetWorkflowDefinitionParams) (db.WorkflowDefinition, error) {
			assert.Equal(t, defID, arg.ID)
			assert.Equal(t, repoID, arg.RepositoryID)
			return def, nil
		},
	}

	svc := NewWorkflowRunService(mock, WithWorkflowRunDefinitionCommitLoader(&recordingWorkflowDefinitionCommitLoader{result: workflowLoadResultForPath(def.Path, string(def.Config))}))
	result, err := svc.RerunRun(context.Background(), RerunInput{
		RepositoryID: repoID,
		RunID:        originalRunID,
		UserID:       userID,
	})

	require.NoError(t, err)
	require.NotNil(t, result)
	assert.Equal(t, defID, result.WorkflowDefinitionID)
	assert.Greater(t, result.WorkflowRunID, int64(0))

	// Verify new run was created with same trigger details
	require.Len(t, mock.createRunCalls, 1)
	assert.Equal(t, repoID, mock.createRunCalls[0].RepositoryID)
	assert.Equal(t, defID, mock.createRunCalls[0].WorkflowDefinitionID)
	assert.Equal(t, "push", mock.createRunCalls[0].TriggerEvent)
	assert.Equal(t, "refs/heads/main", mock.createRunCalls[0].TriggerRef)
	assert.Equal(t, strings.Repeat("d", 40), mock.createRunCalls[0].TriggerCommitSha)
}

func TestWorkflowRunService_RerunRun_PreservesTriggerEvent(t *testing.T) {
	t.Parallel()
	testCases := []struct {
		name         string
		triggerEvent string
		triggerRef   string
		commitSha    string
	}{
		{
			name:         "push event",
			triggerEvent: "push",
			triggerRef:   "refs/heads/feature-x",
			commitSha:    strings.Repeat("a", 40),
		},
		{
			name:         "workflow_dispatch event",
			triggerEvent: "workflow_dispatch",
			triggerRef:   "refs/tags/v1.0.0",
			commitSha:    strings.Repeat("d", 40),
		},
		{
			name:         "landing_request event",
			triggerEvent: "landing_request",
			triggerRef:   "refs/heads/main",
			commitSha:    strings.Repeat("b", 40),
		},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			repoID := int64(42)
			runID := int64(1)
			defID := int64(10)

			originalRun := db.WorkflowRun{
				ID:                   runID,
				RepositoryID:         repoID,
				WorkflowDefinitionID: defID,
				Status:               "failed",
				TriggerEvent:         tc.triggerEvent,
				TriggerRef:           tc.triggerRef,
				TriggerCommitSha:     tc.commitSha,
				CreatedAt:            time.Now(),
				UpdatedAt:            time.Now(),
			}

			def := makeWorkflowDef(defID, repoID, "ci", true, `{"on":{"push":{}},"jobs":{"build":{}}}`)

			mock := &mockWorkflowRunQuerier{
				getRunFn: func(_ context.Context, _ db.GetWorkflowRunParams) (db.WorkflowRun, error) {
					return originalRun, nil
				},
				getDefFn: func(_ context.Context, _ db.GetWorkflowDefinitionParams) (db.WorkflowDefinition, error) {
					return def, nil
				},
			}

			svc := NewWorkflowRunService(mock, WithWorkflowRunDefinitionCommitLoader(&recordingWorkflowDefinitionCommitLoader{result: workflowLoadResultForPath(def.Path, string(def.Config))}))
			_, err := svc.RerunRun(context.Background(), RerunInput{
				RepositoryID: repoID,
				RunID:        runID,
				UserID:       1,
			})

			require.NoError(t, err)
			require.Len(t, mock.createRunCalls, 1)
			assert.Equal(t, tc.triggerEvent, mock.createRunCalls[0].TriggerEvent)
			assert.Equal(t, tc.triggerRef, mock.createRunCalls[0].TriggerRef)
			assert.Equal(t, tc.commitSha, mock.createRunCalls[0].TriggerCommitSha)
		})
	}
}

func TestWorkflowRunService_RerunRun_PreservesDispatchInputs(t *testing.T) {
	t.Parallel()
	repoID := int64(42)
	runID := int64(1)
	defID := int64(10)

	dispatchInputs := map[string]interface{}{
		"env":     "production",
		"version": "2.0.0",
	}
	inputsJSON, err := json.Marshal(dispatchInputs)
	require.NoError(t, err)

	originalRun := db.WorkflowRun{
		ID:                   runID,
		RepositoryID:         repoID,
		WorkflowDefinitionID: defID,
		Status:               "failure",
		TriggerEvent:         "workflow_dispatch",
		TriggerRef:           "refs/heads/main",
		TriggerCommitSha:     strings.Repeat("a", 40),
		DispatchInputs:       inputsJSON,
		CreatedAt:            time.Now(),
		UpdatedAt:            time.Now(),
	}

	def := makeWorkflowDef(defID, repoID, "deploy", true, `{"on":{"workflow_dispatch":{}},"jobs":{"deploy":{}}}`)

	mock := &mockWorkflowRunQuerier{
		getRunFn: func(_ context.Context, _ db.GetWorkflowRunParams) (db.WorkflowRun, error) {
			return originalRun, nil
		},
		getDefFn: func(_ context.Context, _ db.GetWorkflowDefinitionParams) (db.WorkflowDefinition, error) {
			return def, nil
		},
	}

	svc := NewWorkflowRunService(mock, WithWorkflowRunDefinitionCommitLoader(&recordingWorkflowDefinitionCommitLoader{result: workflowLoadResultForPath(def.Path, string(def.Config))}))
	_, err = svc.RerunRun(context.Background(), RerunInput{
		RepositoryID: repoID,
		RunID:        runID,
		UserID:       1,
	})

	require.NoError(t, err)
	require.Len(t, mock.createRunCalls, 1)

	// Verify dispatch inputs are persisted on the new run record.
	assert.NotNil(t, mock.createRunCalls[0].DispatchInputs)
	var storedInputs map[string]interface{}
	require.NoError(t, json.Unmarshal(mock.createRunCalls[0].DispatchInputs, &storedInputs))
	assert.Equal(t, "production", storedInputs["env"])
	assert.Equal(t, "2.0.0", storedInputs["version"])

	// Verify dispatch inputs are propagated into task payloads.
	require.Len(t, mock.createTaskCalls, 1)
	var payload map[string]interface{}
	require.NoError(t, json.Unmarshal(mock.createTaskCalls[0].Payload, &payload))
	taskInputs, ok := payload["inputs"].(map[string]interface{})
	require.True(t, ok, "task payload should contain inputs")
	assert.Equal(t, "production", taskInputs["env"])
	assert.Equal(t, "2.0.0", taskInputs["version"])
}

func TestWorkflowRunService_RerunRun_NilDispatchInputs_OmitsFromRun(t *testing.T) {
	t.Parallel()
	repoID := int64(42)
	runID := int64(1)
	defID := int64(10)

	originalRun := db.WorkflowRun{
		ID:                   runID,
		RepositoryID:         repoID,
		WorkflowDefinitionID: defID,
		Status:               "failure",
		TriggerEvent:         "push",
		TriggerRef:           "refs/heads/main",
		TriggerCommitSha:     strings.Repeat("a", 40),
		DispatchInputs:       nil, // no dispatch inputs on original
		CreatedAt:            time.Now(),
		UpdatedAt:            time.Now(),
	}

	def := makeWorkflowDef(defID, repoID, "ci", true, `{"on":{"push":{}},"jobs":{"build":{}}}`)

	mock := &mockWorkflowRunQuerier{
		getRunFn: func(_ context.Context, _ db.GetWorkflowRunParams) (db.WorkflowRun, error) {
			return originalRun, nil
		},
		getDefFn: func(_ context.Context, _ db.GetWorkflowDefinitionParams) (db.WorkflowDefinition, error) {
			return def, nil
		},
	}

	svc := NewWorkflowRunService(mock, WithWorkflowRunDefinitionCommitLoader(&recordingWorkflowDefinitionCommitLoader{result: workflowLoadResultForPath(def.Path, string(def.Config))}))
	_, err := svc.RerunRun(context.Background(), RerunInput{
		RepositoryID: repoID,
		RunID:        runID,
		UserID:       1,
	})

	require.NoError(t, err)
	require.Len(t, mock.createRunCalls, 1)

	// Verify no dispatch inputs stored when original had none.
	assert.Nil(t, mock.createRunCalls[0].DispatchInputs)

	// Verify task payload has no inputs key.
	require.Len(t, mock.createTaskCalls, 1)
	var payload map[string]interface{}
	require.NoError(t, json.Unmarshal(mock.createTaskCalls[0].Payload, &payload))
	_, hasInputs := payload["inputs"]
	assert.False(t, hasInputs, "task payload should not contain inputs when original had none")
}

func TestWorkflowRunService_DispatchForEvent_PersistsDispatchInputs(t *testing.T) {
	t.Parallel()
	repoID := int64(42)
	defID := int64(10)

	def := makeWorkflowDef(defID, repoID, "deploy", true, `{"on":{"workflow_dispatch":{}},"jobs":{"deploy":{}}}`)

	mock := &mockWorkflowRunQuerier{
		listDefsFn: func(_ context.Context, _ db.ListWorkflowDefinitionsByRepoParams) ([]db.WorkflowDefinition, error) {
			return []db.WorkflowDefinition{def}, nil
		},
	}

	svc := NewWorkflowRunService(mock)
	_, err := svc.DispatchForEvent(context.Background(), DispatchForEventInput{
		RepositoryID: repoID,
		UserID:       1,
		Event: TriggerEvent{
			Type:      "workflow_dispatch",
			Ref:       "refs/heads/main",
			CommitSHA: "abc123",
			Inputs: map[string]interface{}{
				"env":     "staging",
				"version": "1.0.0",
			},
		},
	})

	require.NoError(t, err)
	require.Len(t, mock.createRunCalls, 1)

	// Verify dispatch inputs are persisted in the run record.
	assert.NotNil(t, mock.createRunCalls[0].DispatchInputs)
	var storedInputs map[string]interface{}
	require.NoError(t, json.Unmarshal(mock.createRunCalls[0].DispatchInputs, &storedInputs))
	assert.Equal(t, "staging", storedInputs["env"])
	assert.Equal(t, "1.0.0", storedInputs["version"])
}

func TestWorkflowRunService_DispatchForEvent_NilInputs_StoresNilDispatchInputs(t *testing.T) {
	t.Parallel()
	repoID := int64(42)
	defID := int64(10)

	def := makeWorkflowDef(defID, repoID, "ci", true, `{"on":{"push":{}},"jobs":{"build":{}}}`)

	mock := &mockWorkflowRunQuerier{
		listDefsFn: func(_ context.Context, _ db.ListWorkflowDefinitionsByRepoParams) ([]db.WorkflowDefinition, error) {
			return []db.WorkflowDefinition{def}, nil
		},
	}

	svc := newCurrentPushTestService(mock)
	_, err := svc.DispatchForEvent(context.Background(), DispatchForEventInput{
		RepositoryID: repoID,
		UserID:       1,
		Event: TriggerEvent{
			Type:      "push",
			Ref:       "refs/heads/main",
			CommitSHA: "abc123",
		},
	})

	require.NoError(t, err)
	require.Len(t, mock.createRunCalls, 1)

	// Verify no dispatch inputs stored for non-dispatch events.
	assert.Nil(t, mock.createRunCalls[0].DispatchInputs)
}
