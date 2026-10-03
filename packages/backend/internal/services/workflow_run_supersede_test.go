package services

import (
	"context"
	"encoding/json"
	"sort"
	"strconv"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// supersedeQuerierMock is a run store whose ListSupersededWorkflowRuns applies
// the same predicate as db/product/queries/workflows.sql, so "a different ref is
// untouched" is a real behavioural assertion rather than a parameter check.
type supersedeQuerierMock struct {
	*cancelRunQuerierMock

	runs        map[int64]*db.WorkflowRun
	nextRunID   int64
	definitions map[int64]db.WorkflowDefinition
	listCalls   []db.ListSupersededWorkflowRunsParams
	listErr     error
}

func newSupersedeQuerierMock() *supersedeQuerierMock {
	return &supersedeQuerierMock{
		cancelRunQuerierMock: &cancelRunQuerierMock{},
		runs:                 map[int64]*db.WorkflowRun{},
		nextRunID:            1000,
		definitions:          map[int64]db.WorkflowDefinition{},
	}
}

func (m *supersedeQuerierMock) seedRun(run db.WorkflowRun) db.WorkflowRun {
	copied := run
	m.runs[run.ID] = &copied
	return copied
}

func (m *supersedeQuerierMock) run(t *testing.T, id int64) db.WorkflowRun {
	t.Helper()
	stored, ok := m.runs[id]
	require.True(t, ok, "run %d not found", id)
	return *stored
}

func (m *supersedeQuerierMock) GetWorkflowRun(_ context.Context, arg db.GetWorkflowRunParams) (db.WorkflowRun, error) {
	stored, ok := m.runs[arg.ID]
	if !ok || stored.RepositoryID != arg.RepositoryID {
		return db.WorkflowRun{}, pgx.ErrNoRows
	}
	return *stored, nil
}

func (m *supersedeQuerierMock) CancelWorkflowRun(_ context.Context, id int64) error {
	m.cancelRunCalls = append(m.cancelRunCalls, id)
	stored, ok := m.runs[id]
	if !ok {
		return nil
	}
	if IsTerminalWorkflowRunStatus(stored.Status) {
		return nil
	}
	stored.Status = "cancelled"
	return nil
}

func (m *supersedeQuerierMock) ListSupersededWorkflowRuns(
	_ context.Context,
	arg db.ListSupersededWorkflowRunsParams,
) ([]int64, error) {
	m.listCalls = append(m.listCalls, arg)
	if m.listErr != nil {
		return nil, m.listErr
	}
	var ids []int64
	for id, stored := range m.runs {
		if stored.RepositoryID != arg.RepositoryID ||
			stored.WorkflowDefinitionID != arg.WorkflowDefinitionID ||
			stored.TriggerRef != arg.TriggerRef ||
			stored.TriggerEvent != arg.TriggerEvent ||
			id >= arg.NewerRunID {
			continue
		}
		if stored.Status != "queued" && stored.Status != "running" {
			continue
		}
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	return ids, nil
}

func (m *supersedeQuerierMock) MarkWorkflowRunSuperseded(_ context.Context, arg db.MarkWorkflowRunSupersededParams) error {
	stored, ok := m.runs[arg.ID]
	if !ok {
		return nil
	}
	if stored.Status != "cancelled" || stored.CancelReason != "" {
		return nil
	}
	stored.CancelReason = arg.CancelReason
	return nil
}

func (m *supersedeQuerierMock) CreateWorkflowRun(_ context.Context, arg db.CreateWorkflowRunParams) (db.WorkflowRun, error) {
	m.nextRunID++
	run := db.WorkflowRun{
		ID:                   m.nextRunID,
		RepositoryID:         arg.RepositoryID,
		WorkflowDefinitionID: arg.WorkflowDefinitionID,
		Status:               arg.Status,
		TriggerEvent:         arg.TriggerEvent,
		TriggerRef:           arg.TriggerRef,
		TriggerCommitSha:     arg.TriggerCommitSha,
		ExecutionPlane:       arg.ExecutionPlane,
	}
	m.runs[run.ID] = &run
	return run, nil
}

func (m *supersedeQuerierMock) GetWorkflowDefinition(_ context.Context, arg db.GetWorkflowDefinitionParams) (db.WorkflowDefinition, error) {
	def, ok := m.definitions[arg.ID]
	if !ok || def.RepositoryID != arg.RepositoryID {
		return db.WorkflowDefinition{}, pgx.ErrNoRows
	}
	return def, nil
}

func (m *supersedeQuerierMock) ListWorkflowDefinitionsByRepo(
	_ context.Context,
	arg db.ListWorkflowDefinitionsByRepoParams,
) ([]db.WorkflowDefinition, error) {
	var defs []db.WorkflowDefinition
	for _, def := range m.definitions {
		if def.RepositoryID == arg.RepositoryID {
			defs = append(defs, def)
		}
	}
	sort.Slice(defs, func(i, j int) bool { return defs[i].ID < defs[j].ID })
	return defs, nil
}

const supersedePushWorkflowConfig = `{"on":{"push":{"branches":["main"]}},"jobs":{"ci":{"steps":[{"name":"ci","run":"echo hi"}]}}}`

func supersedeRun(id, defID int64, ref, event, status string) db.WorkflowRun {
	return db.WorkflowRun{
		ID:                   id,
		RepositoryID:         42,
		WorkflowDefinitionID: defID,
		Status:               status,
		TriggerEvent:         event,
		TriggerRef:           ref,
	}
}

func newSupersedeService(q *supersedeQuerierMock) *workflowRunService {
	return NewWorkflowRunService(q).(*workflowRunService)
}

// The 2026-09-15 incident: seven pushes to main queued runs 11751-11757 at
// once. The newest must reap both the queued and the running older runs.
func TestCancelSupersededRuns_NewerPushCancelsOlderQueuedAndRunningRuns(t *testing.T) {
	t.Parallel()

	q := newSupersedeQuerierMock()
	q.seedRun(supersedeRun(11751, 7, "refs/heads/main", "push", "running"))
	q.seedRun(supersedeRun(11752, 7, "refs/heads/main", "push", "queued"))
	newest := q.seedRun(supersedeRun(11757, 7, "refs/heads/main", "push", "queued"))

	newSupersedeService(q).cancelSupersededRuns(context.Background(), newest, json.RawMessage(supersedePushWorkflowConfig))

	assert.Equal(t, "cancelled", q.run(t, 11751).Status)
	assert.Equal(t, "cancelled", q.run(t, 11752).Status)
	assert.Equal(t, "queued", q.run(t, 11757).Status, "the newest run must not cancel itself")
	assert.Equal(t, []int64{11751, 11752}, q.cancelRunCalls)
	assert.Equal(t, []int64{11751, 11752}, q.cancelTaskCalls,
		"cancellation must route through CancelRun so pending tasks leave the claim predicate")
}

func TestCancelSupersededRuns_RecordsSupersededByCancelReason(t *testing.T) {
	t.Parallel()

	q := newSupersedeQuerierMock()
	q.seedRun(supersedeRun(11753, 7, "refs/heads/main", "push", "queued"))
	newest := q.seedRun(supersedeRun(11763, 7, "refs/heads/main", "push", "queued"))

	newSupersedeService(q).cancelSupersededRuns(context.Background(), newest, json.RawMessage(supersedePushWorkflowConfig))

	assert.Equal(t, "superseded_by_run:11763", q.run(t, 11753).CancelReason)
	assert.Equal(t, "", q.run(t, 11763).CancelReason)
}

func TestCancelSupersededRuns_LeavesOtherRefsAndWorkflowsUntouched(t *testing.T) {
	t.Parallel()

	q := newSupersedeQuerierMock()
	q.seedRun(supersedeRun(11740, 7, "refs/heads/release", "push", "queued"))
	q.seedRun(supersedeRun(11741, 9, "refs/heads/main", "push", "queued"))
	q.seedRun(supersedeRun(11742, 7, "refs/heads/main", "push", "queued"))
	newest := q.seedRun(supersedeRun(11757, 7, "refs/heads/main", "push", "queued"))

	newSupersedeService(q).cancelSupersededRuns(context.Background(), newest, json.RawMessage(supersedePushWorkflowConfig))

	assert.Equal(t, "queued", q.run(t, 11740).Status, "a different ref is a different concurrency group")
	assert.Equal(t, "queued", q.run(t, 11741).Status, "a different workflow is a different concurrency group")
	assert.Equal(t, "cancelled", q.run(t, 11742).Status)
}

func TestCancelSupersededRuns_LeavesNewerAndTerminalRunsUntouched(t *testing.T) {
	t.Parallel()

	q := newSupersedeQuerierMock()
	q.seedRun(supersedeRun(11750, 7, "refs/heads/main", "push", "success"))
	q.seedRun(supersedeRun(11751, 7, "refs/heads/main", "push", "failure"))
	q.seedRun(supersedeRun(11790, 7, "refs/heads/main", "push", "queued"))
	newest := q.seedRun(supersedeRun(11757, 7, "refs/heads/main", "push", "queued"))

	newSupersedeService(q).cancelSupersededRuns(context.Background(), newest, json.RawMessage(supersedePushWorkflowConfig))

	assert.Equal(t, "success", q.run(t, 11750).Status)
	assert.Equal(t, "failure", q.run(t, 11751).Status)
	assert.Equal(t, "queued", q.run(t, 11790).Status, "a newer run is never superseded by an older one")
	assert.Empty(t, q.cancelRunCalls)
}

func TestCancelSupersededRuns_ManualDispatchAndScheduleRunsAreNeverCancelled(t *testing.T) {
	t.Parallel()

	for _, event := range []string{"manual_dispatch", "workflow_dispatch", "schedule"} {
		event := event
		t.Run(event, func(t *testing.T) {
			t.Parallel()

			q := newSupersedeQuerierMock()
			q.seedRun(supersedeRun(11751, 7, "refs/heads/main", event, "queued"))
			q.seedRun(supersedeRun(11752, 7, "refs/heads/main", "push", "queued"))
			newest := q.seedRun(supersedeRun(11757, 7, "refs/heads/main", event, "queued"))

			newSupersedeService(q).cancelSupersededRuns(context.Background(), newest, json.RawMessage(supersedePushWorkflowConfig))

			assert.Empty(t, q.listCalls, "a non-push run must not open a supersede sweep at all")
			assert.Equal(t, "queued", q.run(t, 11751).Status)
			assert.Equal(t, "queued", q.run(t, 11752).Status,
				"a manual or scheduled run must not cancel push runs either")
		})
	}
}

func TestCancelSupersededRuns_OptOutHonoured(t *testing.T) {
	t.Parallel()

	optOut := `{"on":{"push":{"branches":["main"]}},"concurrency":{"cancelSuperseded":false},"jobs":{}}`

	q := newSupersedeQuerierMock()
	q.seedRun(supersedeRun(11751, 7, "refs/heads/main", "push", "queued"))
	newest := q.seedRun(supersedeRun(11757, 7, "refs/heads/main", "push", "queued"))

	newSupersedeService(q).cancelSupersededRuns(context.Background(), newest, json.RawMessage(optOut))

	assert.Empty(t, q.listCalls)
	assert.Equal(t, "queued", q.run(t, 11751).Status)
}

func TestCancelSupersededRuns_ExplicitOptInIsHonoured(t *testing.T) {
	t.Parallel()

	optIn := `{"on":{"push":{"branches":["main"]}},"concurrency":{"cancelSuperseded":true},"jobs":{}}`

	q := newSupersedeQuerierMock()
	q.seedRun(supersedeRun(11751, 7, "refs/heads/main", "push", "queued"))
	newest := q.seedRun(supersedeRun(11757, 7, "refs/heads/main", "push", "queued"))

	newSupersedeService(q).cancelSupersededRuns(context.Background(), newest, json.RawMessage(optIn))

	assert.Equal(t, "cancelled", q.run(t, 11751).Status)
}

func TestCancelSupersededRuns_EmptyTriggerRefIsNotAConcurrencyGroup(t *testing.T) {
	t.Parallel()

	q := newSupersedeQuerierMock()
	q.seedRun(supersedeRun(11751, 7, "", "push", "queued"))
	newest := q.seedRun(supersedeRun(11757, 7, "", "push", "queued"))

	newSupersedeService(q).cancelSupersededRuns(context.Background(), newest, json.RawMessage(supersedePushWorkflowConfig))

	assert.Empty(t, q.listCalls)
	assert.Equal(t, "queued", q.run(t, 11751).Status)
}

func TestWorkflowCancelsSupersededRuns_Defaults(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name   string
		config string
		event  string
		want   bool
	}{
		{"push defaults on", supersedePushWorkflowConfig, "push", true},
		{"push with empty config defaults on", "", "push", true},
		{"push with unparseable config defaults on", "{not json", "push", true},
		{"snake_case opt-out is honoured", `{"concurrency":{"cancel_superseded":false}}`, "push", false},
		{"camelCase opt-out is honoured", `{"concurrency":{"cancelSuperseded":false}}`, "push", false},
		{"empty concurrency block defaults on", `{"concurrency":{}}`, "push", true},
		{"manual dispatch never supersedes", supersedePushWorkflowConfig, "manual_dispatch", false},
		{"schedule never supersedes", supersedePushWorkflowConfig, "schedule", false},
		{"landing request never supersedes", supersedePushWorkflowConfig, "landing_request", false},
		{"opt-out cannot re-enable a manual run", `{"concurrency":{"cancelSuperseded":true}}`, "schedule", false},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			got := workflowCancelsSupersededRuns(json.RawMessage(tc.config), tc.event)
			assert.Equal(t, tc.want, got)
		})
	}
}

// End-to-end through the dispatch path: creating a push run must reap the
// previous push run for the same ref without the caller asking for it.
func TestDispatchForEvent_PushRunCancelsPreviousPushRunForSameRef(t *testing.T) {
	t.Parallel()

	q := newSupersedeQuerierMock()
	q.definitions[7] = db.WorkflowDefinition{
		ID:           7,
		RepositoryID: 42,
		Name:         "ci",
		Path:         ".smithers/workflows/ci.tsx",
		Config:       json.RawMessage(supersedePushWorkflowConfig),
		IsActive:     true,
	}
	q.seedRun(supersedeRun(11756, 7, "refs/heads/main", "push", "queued"))
	q.nextRunID = 11762

	svc := newCurrentPushTestService(q)
	results, err := svc.DispatchForEvent(context.Background(), DispatchForEventInput{
		RepositoryID: 42,
		Event:        TriggerEvent{Type: "push", Ref: "refs/heads/main", CommitSHA: "abc123"},
	})
	require.NoError(t, err)
	require.Len(t, results, 1)

	newRunID := results[0].WorkflowRunID
	assert.Greater(t, newRunID, int64(11756))
	assert.Equal(t, "cancelled", q.run(t, 11756).Status)
	assert.Equal(t, "superseded_by_run:"+strconv.FormatInt(newRunID, 10), q.run(t, 11756).CancelReason)
	assert.Equal(t, "queued", q.run(t, newRunID).Status)
}
