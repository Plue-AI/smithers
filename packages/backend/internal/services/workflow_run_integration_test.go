package services

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

func createWorkflowRunIntegrationRepo(t *testing.T, pool *pgxpool.Pool) int64 {
	t.Helper()

	ctx := context.Background()
	seq := time.Now().UnixNano()
	username := fmt.Sprintf("wfint_user_%d", seq)
	email := fmt.Sprintf("wfint_%d@example.com", seq)

	var userID int64
	err := pool.QueryRow(
		ctx,
		`INSERT INTO users (username, lower_username, email, lower_email, display_name)
		 VALUES ($1, $2, $3, $4, $5)
		 RETURNING id`,
		username,
		username,
		email,
		email,
		"Workflow Integration User",
	).Scan(&userID)
	require.NoError(t, err)

	repoName := fmt.Sprintf("wfint_repo_%d", seq)
	var repoID int64
	err = pool.QueryRow(
		ctx,
		`INSERT INTO repositories (user_id, name, lower_name, description, is_public, default_bookmark, next_issue_number, next_landing_number)
		 VALUES ($1, $2, $3, '', TRUE, 'main', 1, 1)
		 RETURNING id`,
		userID,
		repoName,
		repoName,
	).Scan(&repoID)
	require.NoError(t, err)
	return repoID
}

func TestWorkflowRunServiceIntegration_DispatchForEvent_LandingRequestCreatesRunStepsAndTasks(t *testing.T) {
	pool := getAgentTestPool(t)
	queries := db.New(pool)
	repoID := createWorkflowRunIntegrationRepo(t, pool)

	def, err := queries.CreateWorkflowDefinition(context.Background(), db.CreateWorkflowDefinitionParams{
		RepositoryID: repoID,
		Name:         "LandingChecks",
		Path:         ".smithers/workflows/landing-checks.tsx",
		Config: json.RawMessage(`{
			"on":{"landing_request":{"types":["opened"]}},
			"jobs":{
				"lint":{"runs-on":"ubuntu","steps":[{"run":"npm run lint"}]},
				"test":{"runs-on":"ubuntu","steps":[{"run":"npm test"}]}
			}
		}`),
	})
	require.NoError(t, err)

	svc := newCurrentPushTestService(queries)
	results, err := svc.DispatchForEvent(context.Background(), DispatchForEventInput{
		RepositoryID: repoID,
		Event: TriggerEvent{
			Type:      "landing_request",
			Action:    "opened",
			Ref:       "main",
			CommitSHA: "abc123abc123abc123abc123abc123abc123abcd",
		},
	})
	require.NoError(t, err)
	require.Len(t, results, 1)
	assert.Equal(t, def.ID, results[0].WorkflowDefinitionID)

	run, err := queries.GetWorkflowRun(context.Background(), db.GetWorkflowRunParams{
		ID:           results[0].WorkflowRunID,
		RepositoryID: repoID,
	})
	require.NoError(t, err)
	assert.Equal(t, "queued", run.Status)
	assert.Equal(t, "landing_request", run.TriggerEvent)
	assert.Equal(t, "main", run.TriggerRef)
	assert.Equal(t, "abc123abc123abc123abc123abc123abc123abcd", run.TriggerCommitSha)

	steps, err := queries.ListWorkflowStepsByRunID(context.Background(), run.ID)
	require.NoError(t, err)
	require.Len(t, steps, 2)

	stepNames := map[string]bool{}
	positions := map[int64]bool{}
	for _, step := range steps {
		stepNames[step.Name] = true
		positions[step.Position] = true
		assert.Equal(t, "queued", step.Status)
	}
	assert.True(t, stepNames["lint"])
	assert.True(t, stepNames["test"])
	assert.Equal(t, 2, len(positions))
	assert.True(t, positions[1])
	assert.True(t, positions[2])

	rows, err := pool.Query(
		context.Background(),
		`SELECT status, payload->>'job', payload->>'event', payload->>'ref'
		 FROM workflow_tasks
		 WHERE workflow_run_id = $1`,
		run.ID,
	)
	require.NoError(t, err)
	defer rows.Close()

	var taskCount int
	taskJobs := map[string]bool{}
	for rows.Next() {
		var status, job, eventType, ref string
		require.NoError(t, rows.Scan(&status, &job, &eventType, &ref))
		assert.Equal(t, "pending", status)
		assert.Equal(t, "landing_request", eventType)
		assert.Equal(t, "main", ref)
		taskJobs[job] = true
		taskCount++
	}
	require.NoError(t, rows.Err())
	assert.Equal(t, 2, taskCount)
	assert.True(t, taskJobs["lint"])
	assert.True(t, taskJobs["test"])
}

func TestWorkflowRunServiceIntegration_DispatchForEvent_ScheduleMatchesOnlyScheduleEvents(t *testing.T) {
	pool := getAgentTestPool(t)
	queries := db.New(pool)
	repoID := createWorkflowRunIntegrationRepo(t, pool)

	def, err := queries.CreateWorkflowDefinition(context.Background(), db.CreateWorkflowDefinitionParams{
		RepositoryID: repoID,
		Name:         "Nightly",
		Path:         ".smithers/workflows/nightly.tsx",
		Config:       json.RawMessage(`{"on":{"schedule":[{"cron":"0 0 * * *"}]},"jobs":{"nightly":{"runs-on":"ubuntu","steps":[{"run":"make nightly"}]}}}`),
	})
	require.NoError(t, err)

	svc := newCurrentPushTestService(queries)
	scheduleResults, err := svc.DispatchForEvent(context.Background(), DispatchForEventInput{
		RepositoryID: repoID,
		Event:        TriggerEvent{Type: "schedule"},
	})
	require.NoError(t, err)
	require.Len(t, scheduleResults, 1)
	assert.Equal(t, def.ID, scheduleResults[0].WorkflowDefinitionID)

	pushResults, err := svc.DispatchForEvent(context.Background(), DispatchForEventInput{
		RepositoryID: repoID,
		Event: TriggerEvent{
			Type: "push",
			Ref:  "main",
		},
	})
	require.NoError(t, err)
	assert.Empty(t, pushResults)

	runs, err := queries.ListWorkflowRunsByDefinition(context.Background(), db.ListWorkflowRunsByDefinitionParams{
		WorkflowDefinitionID: def.ID,
		RepositoryID:         repoID,
		PageOffset:           0,
		PageSize:             10,
	})
	require.NoError(t, err)
	require.Len(t, runs, 1)
	assert.Equal(t, "schedule", runs[0].TriggerEvent)

	steps, err := queries.ListWorkflowStepsByRunID(context.Background(), runs[0].ID)
	require.NoError(t, err)
	require.Len(t, steps, 1)
	assert.Equal(t, "nightly", steps[0].Name)
}

func TestWorkflowRunServiceIntegration_DispatchForEvent_PushCreatesRun(t *testing.T) {
	pool := getAgentTestPool(t)
	queries := db.New(pool)
	repoID := createWorkflowRunIntegrationRepo(t, pool)

	def, err := queries.CreateWorkflowDefinition(context.Background(), db.CreateWorkflowDefinitionParams{
		RepositoryID: repoID,
		Name:         "PushChecks",
		Path:         ".smithers/workflows/push-checks.tsx",
		Config: json.RawMessage(`{
			"on":{"push":{"branches":["main"]}},
			"jobs":{
				"build":{"runs-on":"ubuntu","steps":[{"run":"npm run build"}]}
			}
		}`),
	})
	require.NoError(t, err)

	svc := newCurrentPushTestService(queries)
	results, err := svc.DispatchForEvent(context.Background(), DispatchForEventInput{
		RepositoryID: repoID,
		Event: TriggerEvent{
			Type:      "push",
			Ref:       "refs/heads/main",
			CommitSHA: "xyz789xyz789xyz789xyz789xyz789xyz789xyzz",
		},
	})
	require.NoError(t, err)
	require.Len(t, results, 1)
	assert.Equal(t, def.ID, results[0].WorkflowDefinitionID)

	run, err := queries.GetWorkflowRun(context.Background(), db.GetWorkflowRunParams{
		ID:           results[0].WorkflowRunID,
		RepositoryID: repoID,
	})
	require.NoError(t, err)
	assert.Equal(t, "queued", run.Status)
	assert.Equal(t, "push", run.TriggerEvent)
	assert.Equal(t, "refs/heads/main", run.TriggerRef)
	assert.Equal(t, "xyz789xyz789xyz789xyz789xyz789xyz789xyzz", run.TriggerCommitSha)
}

func TestWorkflowRunServiceIntegration_DispatchForEvent_TargetedDispatch(t *testing.T) {
	pool := getAgentTestPool(t)
	queries := db.New(pool)
	repoID := createWorkflowRunIntegrationRepo(t, pool)

	_, err := queries.CreateWorkflowDefinition(context.Background(), db.CreateWorkflowDefinitionParams{
		RepositoryID: repoID,
		Name:         "Target1",
		Path:         ".smithers/workflows/target1.tsx",
		Config: json.RawMessage(`{
			"on":{"workflow_dispatch":{}},
			"jobs":{
				"job1":{"runs-on":"ubuntu","steps":[{"run":"echo 1"}]}
			}
		}`),
	})
	require.NoError(t, err)

	def2, err := queries.CreateWorkflowDefinition(context.Background(), db.CreateWorkflowDefinitionParams{
		RepositoryID: repoID,
		Name:         "Target2",
		Path:         ".smithers/workflows/target2.tsx",
		Config: json.RawMessage(`{
			"on":{"workflow_dispatch":{}},
			"jobs":{
				"job2":{"runs-on":"ubuntu","steps":[{"run":"echo 2"}]}
			}
		}`),
	})
	require.NoError(t, err)

	svc := newCurrentPushTestService(queries)
	results, err := svc.DispatchForEvent(context.Background(), DispatchForEventInput{
		RepositoryID:         repoID,
		WorkflowDefinitionID: &def2.ID,
		Event: TriggerEvent{
			Type: "workflow_dispatch",
			Ref:  "main",
		},
	})
	require.NoError(t, err)
	require.Len(t, results, 1)
	assert.Equal(t, def2.ID, results[0].WorkflowDefinitionID) // Only def2 triggered
}

func TestWorkflowRunServiceIntegration_DispatchForEvent_CreatesPendingCommitStatus(t *testing.T) {
	pool := getAgentTestPool(t)
	queries := db.New(pool)
	repoID := createWorkflowRunIntegrationRepo(t, pool)

	_, err := queries.CreateWorkflowDefinition(context.Background(), db.CreateWorkflowDefinitionParams{
		RepositoryID: repoID,
		Name:         "PushChecks",
		Path:         ".smithers/workflows/push-checks.tsx",
		Config:       json.RawMessage(`{"on":{"push":{}},"jobs":{"build":{"runs-on":"ubuntu","steps":[{"run":"echo hi"}]}}}`),
	})
	require.NoError(t, err)

	commitStatusService := NewCommitStatusService(queries)
	svc := newCurrentPushTestService(queries, WithWorkflowRunCommitStatusWriter(commitStatusService))

	results, err := svc.DispatchForEvent(context.Background(), DispatchForEventInput{
		RepositoryID: repoID,
		Event: TriggerEvent{
			Type:      "push",
			Ref:       "refs/heads/main",
			CommitSHA: "abc123abc123abc123abc123abc123abc123abcd",
		},
	})
	require.NoError(t, err)
	require.Len(t, results, 1)

	var status, contextName, commitSHA string
	var linkedRunID int64
	err = pool.QueryRow(
		context.Background(),
		`SELECT status, context, commit_sha, workflow_run_id
		 FROM commit_statuses
		 WHERE workflow_run_id = $1
		 ORDER BY id DESC
		 LIMIT 1`,
		results[0].WorkflowRunID,
	).Scan(&status, &contextName, &commitSHA, &linkedRunID)
	require.NoError(t, err)
	assert.Equal(t, "pending", status)
	assert.Equal(t, "smithers/PushChecks", contextName)
	assert.Equal(t, "abc123abc123abc123abc123abc123abc123abcd", commitSHA)
	assert.Equal(t, results[0].WorkflowRunID, linkedRunID)
}
