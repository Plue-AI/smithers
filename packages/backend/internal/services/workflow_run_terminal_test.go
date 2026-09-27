package services

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/sandbox"
	"github.com/smithersai/smithers/packages/backend/webhooks"
)

// Every CI run gets a pending commit status, an in-progress GitHub check run
// and a queued workflow_run webhook at creation. These tests pin that the
// sandbox scheduler's terminal transitions settle them through the workflow
// run service, and fire downstream workflow_run triggers.

// terminalRunQuerier adds the terminal-publication reads to the run querier.
type terminalRunQuerier struct {
	*mockWorkflowRunQuerier
	definitionName string
	logs           []db.WorkflowLog
}

func (q *terminalRunQuerier) GetWorkflowDefinitionNameByRunID(context.Context, int64) (string, error) {
	return q.definitionName, nil
}

func (q *terminalRunQuerier) ListWorkflowLogsSince(_ context.Context, arg db.ListWorkflowLogsSinceParams) ([]db.WorkflowLog, error) {
	page := make([]db.WorkflowLog, 0, len(q.logs))
	for _, row := range q.logs {
		if row.ID > arg.AfterID {
			page = append(page, row)
		}
	}
	return page, nil
}

// sandboxTerminalRun is the row a won terminal transition returns for run 42.
func sandboxTerminalRun(status string) db.WorkflowRun {
	return db.WorkflowRun{
		ID:               42,
		RepositoryID:     100,
		Status:           status,
		TriggerEvent:     "push",
		TriggerRef:       "main",
		TriggerCommitSha: "cafebabe",
		CheckRunID:       pgtype.Int8{Int64: 77, Valid: true},
		CreatedAt:        time.Now().Add(-time.Minute),
	}
}

type terminalSurfaces struct {
	queries        *terminalRunQuerier
	commitStatuses *mockWorkflowRunCommitStatusWriter
	checkRuns      *mockWorkflowRunCheckRunService
	webhooks       *mockWorkflowRunDispatcher
	metrics        *fakeWorkflowRunMetricsObserver
}

// newTerminalPublisher builds the production publisher (the workflow run
// service) over recording fakes. A "Deploy" definition follows "CI" through
// on.workflow_run, so a downstream dispatch shows up as a created run.
func newTerminalPublisher(t *testing.T) (WorkflowRunTerminalPublisher, *terminalSurfaces) {
	t.Helper()
	deployConfig, err := json.Marshal(map[string]any{
		"on":   map[string]any{"workflow_run": map[string]any{"workflows": []string{"CI"}}},
		"jobs": map[string]any{"deploy": map[string]any{"steps": []map[string]any{{"run": "make deploy"}}}},
	})
	require.NoError(t, err)
	surfaces := &terminalSurfaces{
		queries: &terminalRunQuerier{
			mockWorkflowRunQuerier: &mockWorkflowRunQuerier{
				listDefsFn: func(context.Context, db.ListWorkflowDefinitionsByRepoParams) ([]db.WorkflowDefinition, error) {
					return []db.WorkflowDefinition{{ID: 7, RepositoryID: 100, Name: "Deploy", Path: ".smithers/workflows/deploy.tsx", Config: deployConfig, IsActive: true}}, nil
				},
			},
			definitionName: "CI",
			logs: []db.WorkflowLog{
				{ID: 1, Entry: "::error file=/workspace/repo/main.go,line=3::undefined: x"},
				{ID: 2, Entry: "ok"},
			},
		},
		commitStatuses: &mockWorkflowRunCommitStatusWriter{},
		checkRuns:      &mockWorkflowRunCheckRunService{},
		webhooks:       &mockWorkflowRunDispatcher{},
		metrics:        &fakeWorkflowRunMetricsObserver{},
	}
	svc := NewWorkflowRunService(surfaces.queries,
		WithWorkflowRunCommitStatusWriter(surfaces.commitStatuses),
		WithWorkflowRunGitHubCheckRunService(surfaces.checkRuns),
		WithWorkflowRunGitHubInstallationResolver(&mockRunnerInstallationResolver{
			resolveFn: func(context.Context, int64, int64, string, string) (int64, error) { return 123, nil },
		}),
		WithWorkflowRunWebhookDispatcher(surfaces.webhooks),
		WithWorkflowRunMetrics(surfaces.metrics),
	)
	publisher, ok := svc.(WorkflowRunTerminalPublisher)
	require.True(t, ok, "the workflow run service publishes terminal outcomes")
	return publisher, surfaces
}

func (s *terminalSurfaces) assertPublished(t *testing.T, status, conclusion, action string) {
	t.Helper()
	require.Len(t, s.commitStatuses.updateCalls, 1, "the pending commit status must be settled")
	assert.Equal(t, int64(42), s.commitStatuses.updateCalls[0].workflowRunID)
	assert.Equal(t, status, s.commitStatuses.updateCalls[0].status)

	require.Len(t, s.checkRuns.updateCalls, 1, "the in-progress check run must be completed")
	update := s.checkRuns.updateCalls[0]
	assert.Equal(t, int64(77), update.checkRunID)
	assert.Equal(t, "completed", update.update.Status)
	assert.Equal(t, conclusion, update.update.Conclusion)
	require.NotNil(t, update.update.Output)
	require.Len(t, update.update.Output.Annotations, 1, "log annotations reach the check run")
	assert.Equal(t, "main.go", update.update.Output.Annotations[0].Path)
	assert.Equal(t, "failure", update.update.Output.Annotations[0].AnnotationLevel)

	var terminal []webhooks.WorkflowRunEventPayload
	for _, call := range s.webhooks.calls {
		if payload, ok := call.payload.(webhooks.WorkflowRunEventPayload); ok && payload.WorkflowRun.ID == 42 {
			terminal = append(terminal, payload)
		}
	}
	require.Len(t, terminal, 1, "a terminal workflow_run webhook must be sent")
	assert.Equal(t, action, terminal[0].Action)

	require.Len(t, s.queries.createRunCalls, 1, "downstream workflow_run triggers must fire")
	assert.Equal(t, "workflow_run", s.queries.createRunCalls[0].TriggerEvent)
	assert.Equal(t, "cafebabe", s.queries.createRunCalls[0].TriggerCommitSha)

	assert.Equal(t, 1, s.metrics.count, "the completion is counted once")
	assert.Equal(t, status, s.metrics.status)
}

func (s *terminalSurfaces) assertNothingPublished(t *testing.T) {
	t.Helper()
	assert.Empty(t, s.commitStatuses.updateCalls)
	assert.Empty(t, s.checkRuns.updateCalls)
	assert.Empty(t, s.webhooks.calls)
	assert.Empty(t, s.queries.createRunCalls)
	assert.Zero(t, s.metrics.count)
}

func TestNixCIRun_TerminalOutcomePublishesCommitStatusCheckRunWebhookAndTriggers(t *testing.T) {
	for _, tc := range []struct {
		name       string
		exitCode   string
		status     string
		conclusion string
		action     string
	}{
		{name: "success", exitCode: "0", status: "success", conclusion: "success", action: "completed"},
		{name: "failure", exitCode: "2", status: "failure", conclusion: "failure", action: "failure"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			queries := nixCIQuerier([]db.WorkflowTask{nixCITaskRow(1, 11, "build", nil)})
			queries.markWorkflowRunSuccessFn = func(context.Context, int64) (db.WorkflowRun, error) {
				return sandboxTerminalRun("success"), nil
			}
			queries.markWorkflowRunFailureFn = func(context.Context, int64) (db.WorkflowRun, error) {
				return sandboxTerminalRun("failure"), nil
			}
			publisher, surfaces := newTerminalPublisher(t)
			guests := &fakeNixCIGuests{
				polls:   map[string]int{},
				scripts: map[string]nixCIGuestScript{"build": {chunks: []string{"make build\n"}, exitCode: tc.exitCode}},
			}
			worker := newRunnableWorkflowSandboxScheduler(t, queries, guests.client(t),
				WithWorkflowSandboxSchedulerGitBaseURL("https://git.example.test"),
				WithWorkflowSandboxSchedulerCIGuests(guests),
				WithWorkflowSandboxSchedulerCIPollInterval(time.Millisecond),
				WithWorkflowSandboxSchedulerTerminalPublisher(publisher),
			)

			require.NoError(t, worker.PollOnce(context.Background()))

			surfaces.assertPublished(t, tc.status, tc.conclusion, tc.action)
		})
	}
}

func TestWorkflowSandboxScheduler_OrchestratorTerminalOutcomePublishes(t *testing.T) {
	for _, tc := range []struct {
		name       string
		exitCode   int32
		status     string
		conclusion string
		action     string
	}{
		{name: "success", exitCode: 0, status: "success", conclusion: "success", action: "completed"},
		{name: "failure", exitCode: 1, status: "failure", conclusion: "failure", action: "failure"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			queries := newSandboxSchedulerRunQuerier(42, 14)
			queries.markWorkflowRunSuccessFn = func(context.Context, int64) (db.WorkflowRun, error) {
				return sandboxTerminalRun("success"), nil
			}
			queries.markWorkflowRunFailureFn = func(context.Context, int64) (db.WorkflowRun, error) {
				return sandboxTerminalRun("failure"), nil
			}
			publisher, surfaces := newTerminalPublisher(t)
			exitCode := tc.exitCode
			client := &mockWorkflowSandboxVMClient{
				execAwaitFn: func(context.Context, string, sandbox.ExecRequest) (sandbox.ExecResult, error) {
					return sandbox.ExecResult{StatusCode: &exitCode}, nil
				},
			}
			worker := newRunnableWorkflowSandboxScheduler(t, queries, client,
				WithWorkflowSandboxSchedulerGitBaseURL("https://api.smithers.test"),
				WithWorkflowSandboxSchedulerTerminalPublisher(publisher),
			)

			require.NoError(t, worker.PollOnce(context.Background()))

			surfaces.assertPublished(t, tc.status, tc.conclusion, tc.action)
		})
	}
}

// A run that left this claim (cancelled, resumed, or reclaimed) belongs to its
// new owner: the losing worker must not publish a terminal outcome for it.
func TestWorkflowSandboxScheduler_LostTerminalRaceDoesNotPublish(t *testing.T) {
	for _, tc := range []struct {
		name     string
		exitCode int32
	}{
		{name: "success", exitCode: 0},
		{name: "failure", exitCode: 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			queries := newSandboxSchedulerRunQuerier(42, 14)
			queries.markWorkflowRunSuccessFn = func(context.Context, int64) (db.WorkflowRun, error) {
				return db.WorkflowRun{}, pgx.ErrNoRows
			}
			queries.markWorkflowRunFailureFn = func(context.Context, int64) (db.WorkflowRun, error) {
				return db.WorkflowRun{}, pgx.ErrNoRows
			}
			publisher, surfaces := newTerminalPublisher(t)
			exitCode := tc.exitCode
			client := &mockWorkflowSandboxVMClient{
				execAwaitFn: func(context.Context, string, sandbox.ExecRequest) (sandbox.ExecResult, error) {
					return sandbox.ExecResult{StatusCode: &exitCode}, nil
				},
			}
			worker := newRunnableWorkflowSandboxScheduler(t, queries, client,
				WithWorkflowSandboxSchedulerGitBaseURL("https://api.smithers.test"),
				WithWorkflowSandboxSchedulerTerminalPublisher(publisher),
			)

			require.NoError(t, worker.PollOnce(context.Background()))

			surfaces.assertNothingPublished(t)
		})
	}
}

// A workflow_run-triggered run must not trigger further workflow_run runs.
func TestPublishWorkflowRunTerminal_WorkflowRunTriggeredRunDoesNotChain(t *testing.T) {
	publisher, surfaces := newTerminalPublisher(t)
	run := sandboxTerminalRun("success")
	run.TriggerEvent = "workflow_run"

	publisher.PublishWorkflowRunTerminal(context.Background(), run)

	require.Len(t, surfaces.commitStatuses.updateCalls, 1)
	assert.Empty(t, surfaces.queries.createRunCalls)
}

func TestPublishWorkflowRunTerminal_IgnoresNonTerminalRun(t *testing.T) {
	publisher, surfaces := newTerminalPublisher(t)

	publisher.PublishWorkflowRunTerminal(context.Background(), sandboxTerminalRun("running"))

	surfaces.assertNothingPublished(t)
}

func TestParseCheckRunAnnotationsFromLogEntry(t *testing.T) {
	got := parseCheckRunAnnotationsFromLogEntry(
		"::warning file=./pkg/a.go,line=4,endLine=6::slow%0Apath\r\n" +
			"/workspace/repo/cmd/b.ts:12:3: error: expected ';'\n" +
			"https://example.test:443: noise\n" +
			"plain output\n")
	require.Len(t, got, 2)
	assert.Equal(t, GitHubCheckRunAnnotation{Path: "pkg/a.go", StartLine: 4, EndLine: 6, AnnotationLevel: "warning", Message: "slow\npath"}, got[0])
	assert.Equal(t, GitHubCheckRunAnnotation{Path: "cmd/b.ts", StartLine: 12, EndLine: 12, AnnotationLevel: "failure", Message: "expected ';'"}, got[1])
}
