package services

import (
	"context"
	"encoding/json"
	"net/http"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/webhooks"
)

type linearSyncOperationsTestStore struct {
	*linearSyncCovQuerier

	mu           sync.Mutex
	ops          []db.LinearSyncOp
	run          db.LinearSyncRun
	nextOpID     int64
	completedOps chan db.LinearSyncOp
	finishedRuns chan db.LinearSyncRun
	lastListArg  db.ListLinearSyncOpsParams
}

func (s *linearSyncOperationsTestStore) ListLinearSyncOps(_ context.Context, arg db.ListLinearSyncOpsParams) ([]db.LinearSyncOp, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.lastListArg = arg
	result := make([]db.LinearSyncOp, 0, len(s.ops))
	for _, op := range s.ops {
		if op.IntegrationID != arg.IntegrationID || (arg.StatusFilter != "" && op.Status != arg.StatusFilter) {
			continue
		}
		if arg.Since.Valid && op.CreatedAt.Before(arg.Since.Time) {
			continue
		}
		if arg.CursorCreatedAt.Valid && (op.CreatedAt.After(arg.CursorCreatedAt.Time) ||
			(op.CreatedAt.Equal(arg.CursorCreatedAt.Time) && op.ID >= arg.CursorID.Int64)) {
			continue
		}
		result = append(result, op)
		if len(result) == int(arg.PageSize) {
			break
		}
	}
	return result, nil
}

func TestLinearSyncService_ListSyncOpsCursorIsStableAcrossNewRows(t *testing.T) {
	integration, _ := linearSyncCovIntegration(t)
	integration.IsActive = true
	base := time.Date(2026, 9, 2, 12, 0, 0, 0, time.UTC)
	store := &linearSyncOperationsTestStore{
		linearSyncCovQuerier: &linearSyncCovQuerier{integration: integration},
		ops: []db.LinearSyncOp{
			{ID: 3, IntegrationID: integration.ID, Status: "success", CreatedAt: base.Add(3 * time.Minute)},
			{ID: 2, IntegrationID: integration.ID, Status: "success", CreatedAt: base.Add(2 * time.Minute)},
			{ID: 1, IntegrationID: integration.ID, Status: "success", CreatedAt: base.Add(time.Minute)},
		},
	}
	svc := NewLinearSyncService(store, linearSyncOperationsIntegrationService(integration, "linear-sync-cover-secret"))

	first, err := svc.ListSyncOps(context.Background(), integration.UserID, integration.ID, LinearSyncOpsFilter{Limit: 2})
	require.NoError(t, err)
	require.Len(t, first.Ops, 2)
	assert.Equal(t, []int64{3, 2}, []int64{first.Ops[0].ID, first.Ops[1].ID})
	assert.NotEmpty(t, first.NextCursor)
	assert.Equal(t, int32(3), store.lastListArg.PageSize)

	store.mu.Lock()
	store.ops = append([]db.LinearSyncOp{{ID: 4, IntegrationID: integration.ID, Status: "success", CreatedAt: base.Add(4 * time.Minute)}}, store.ops...)
	store.mu.Unlock()
	second, err := svc.ListSyncOps(context.Background(), integration.UserID, integration.ID, LinearSyncOpsFilter{Cursor: first.NextCursor, Limit: 2})
	require.NoError(t, err)
	require.Len(t, second.Ops, 1)
	assert.Equal(t, int64(1), second.Ops[0].ID)
	assert.Empty(t, second.NextCursor)

	_, err = svc.ListSyncOps(context.Background(), integration.UserID, integration.ID, LinearSyncOpsFilter{Cursor: "not-a-cursor"})
	require.Error(t, err)
}

func (s *linearSyncOperationsTestStore) GetLinearSyncOp(_ context.Context, arg db.GetLinearSyncOpParams) (db.LinearSyncOp, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, op := range s.ops {
		if op.ID == arg.ID && op.IntegrationID == arg.IntegrationID {
			return op, nil
		}
	}
	return db.LinearSyncOp{}, pgx.ErrNoRows
}

func (s *linearSyncOperationsTestStore) CreateLinearSyncOpRetry(_ context.Context, arg db.CreateLinearSyncOpRetryParams) (db.LinearSyncOp, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, original := range s.ops {
		if original.ID != arg.OpID || original.IntegrationID != arg.IntegrationID || original.Status != "failed" {
			continue
		}
		s.nextOpID++
		retry := original
		retry.ID = s.nextOpID
		retry.RunID = pgtype.Int8{}
		retry.RetryOfID = pgtype.Int8{Int64: original.ID, Valid: true}
		retry.Status = "pending"
		retry.ErrorMessage = ""
		retry.CreatedAt = original.CreatedAt.Add(time.Second)
		s.ops = append([]db.LinearSyncOp{retry}, s.ops...)
		return retry, nil
	}
	return db.LinearSyncOp{}, pgx.ErrNoRows
}

func (s *linearSyncOperationsTestStore) CompleteLinearSyncOpRetry(_ context.Context, arg db.CompleteLinearSyncOpRetryParams) (db.LinearSyncOp, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i := range s.ops {
		if s.ops[i].ID == arg.ID && s.ops[i].Status == "pending" {
			s.ops[i].Status = arg.Status
			s.ops[i].ErrorMessage = arg.ErrorMessage
			if s.completedOps != nil {
				s.completedOps <- s.ops[i]
			}
			return s.ops[i], nil
		}
	}
	return db.LinearSyncOp{}, pgx.ErrNoRows
}

func (s *linearSyncOperationsTestStore) CreateLinearSyncRun(_ context.Context, integrationID int64) (db.LinearSyncRun, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.run = db.LinearSyncRun{ID: 71, IntegrationID: integrationID, State: "pending", CreatedAt: time.Now().UTC()}
	return s.run, nil
}

func (s *linearSyncOperationsTestStore) GetLinearSyncRun(_ context.Context, arg db.GetLinearSyncRunParams) (db.LinearSyncRun, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.run.ID != arg.ID || s.run.IntegrationID != arg.IntegrationID {
		return db.LinearSyncRun{}, pgx.ErrNoRows
	}
	return s.run, nil
}

func (s *linearSyncOperationsTestStore) MarkLinearSyncRunRunning(_ context.Context, id int64) (db.LinearSyncRun, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.run.ID != id || s.run.State != "pending" {
		return db.LinearSyncRun{}, pgx.ErrNoRows
	}
	s.run.State = "running"
	s.run.StartedAt = pgtype.Timestamptz{Time: time.Now().UTC(), Valid: true}
	return s.run, nil
}

func (s *linearSyncOperationsTestStore) SetLinearSyncRunTotals(_ context.Context, arg db.SetLinearSyncRunTotalsParams) (db.LinearSyncRun, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.run.IssuesTotal = arg.IssuesTotal
	s.run.CommentsTotal = arg.CommentsTotal
	return s.run, nil
}

func (s *linearSyncOperationsTestStore) RecordLinearSyncRunResult(_ context.Context, arg db.RecordLinearSyncRunResultParams) (db.LinearSyncRun, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if arg.Entity == "issue" && arg.Failed {
		s.run.IssuesFailed++
	} else if arg.Entity == "issue" {
		s.run.IssuesDone++
	} else if arg.Failed {
		s.run.CommentsFailed++
	} else {
		s.run.CommentsDone++
	}
	return s.run, nil
}

func (s *linearSyncOperationsTestStore) FinishLinearSyncRun(_ context.Context, id int64) (db.LinearSyncRun, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.run.IssuesFailed > 0 || s.run.CommentsFailed > 0 {
		s.run.State = "failed"
	} else {
		s.run.State = "completed"
	}
	s.run.FinishedAt = pgtype.Timestamptz{Time: time.Now().UTC(), Valid: true}
	if s.finishedRuns != nil {
		s.finishedRuns <- s.run
	}
	return s.run, nil
}

func (s *linearSyncOperationsTestStore) FailLinearSyncRun(_ context.Context, _ int64) (db.LinearSyncRun, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.run.State = "failed"
	s.run.FinishedAt = pgtype.Timestamptz{Time: time.Now().UTC(), Valid: true}
	if s.finishedRuns != nil {
		s.finishedRuns <- s.run
	}
	return s.run, nil
}

func (s *linearSyncOperationsTestStore) GetIssueByID(_ context.Context, id int64) (db.Issue, error) {
	return db.Issue{ID: id, RepositoryID: s.integration.JjhubRepoID}, nil
}

func (s *linearSyncOperationsTestStore) GetLinearCommentMapBySmithersCommentID(_ context.Context, _ db.GetLinearCommentMapBySmithersCommentIDParams) (db.LinearCommentMap, error) {
	return s.commentMap, nil
}

func (s *linearSyncOperationsTestStore) GetLinearIssueMapBySmithersCommentID(_ context.Context, _ db.GetLinearIssueMapBySmithersCommentIDParams) (db.LinearIssueMap, error) {
	return s.issueMap, nil
}

func linearSyncOperationsIntegrationService(integration db.LinearIntegration, secret string) *LinearIntegrationService {
	queries := &mockLinearIntegrationQuerier{
		getLinearIntegrationByUserAndID: func(_ context.Context, arg db.GetLinearIntegrationByUserAndIDParams) (db.LinearIntegration, error) {
			if arg.ID != integration.ID || arg.UserID != integration.UserID {
				return db.LinearIntegration{}, pgx.ErrNoRows
			}
			return integration, nil
		},
	}
	return NewLinearIntegrationService(queries, nil, secret)
}

func TestLinearSyncService_ListSyncOpsPreservesErrorAndHidesPayload(t *testing.T) {
	integration, _ := linearSyncCovIntegration(t)
	integration.IsActive = true
	now := time.Date(2026, 9, 2, 12, 0, 0, 0, time.UTC)
	store := &linearSyncOperationsTestStore{
		linearSyncCovQuerier: &linearSyncCovQuerier{integration: integration},
		nextOpID:             100,
		ops: []db.LinearSyncOp{{
			ID: 9, IntegrationID: integration.ID, Source: "jjhub", Target: "linear",
			Entity: "issue", EntityID: "44", Action: "update", Status: "failed",
			ErrorMessage: "Linear API: 422 exact provider failure", Payload: json.RawMessage(`{"secret":"private"}`), CreatedAt: now,
		}},
	}
	svc := NewLinearSyncService(store, linearSyncOperationsIntegrationService(integration, "linear-sync-cover-secret"))
	since := now.Add(-time.Hour)
	page, err := svc.ListSyncOps(context.Background(), integration.UserID, integration.ID, LinearSyncOpsFilter{Status: "failed", Since: &since, Limit: 10})
	require.NoError(t, err)
	require.Len(t, page.Ops, 1)
	assert.Equal(t, "Linear API: 422 exact provider failure", page.Ops[0].ErrorMessage)
	encoded, err := json.Marshal(page.Ops[0])
	require.NoError(t, err)
	assert.NotContains(t, string(encoded), "private")

	_, err = svc.ListSyncOps(context.Background(), integration.UserID, integration.ID, LinearSyncOpsFilter{Status: "running"})
	require.Error(t, err)
}

func TestLinearSyncService_StartInitialSyncRunTracksLiveCounts(t *testing.T) {
	integration, _ := linearSyncCovIntegration(t)
	integration.IsActive = true
	store := &linearSyncOperationsTestStore{
		linearSyncCovQuerier: &linearSyncCovQuerier{integration: integration},
		nextOpID:             100,
		finishedRuns:         make(chan db.LinearSyncRun, 1),
	}
	svc := NewLinearSyncService(store, linearSyncOperationsIntegrationService(integration, "linear-sync-cover-secret"))
	svc.httpClient = linearSyncCovHTTPClient(t, nil, func(string) (int, string, error) {
		return http.StatusOK, `{"data":{"issues":{"nodes":[{"id":"lin-1","identifier":"PLT-1","title":"One","description":"Body"},{"id":"lin-2","identifier":"PLT-2","title":"Two","description":"Body"}],"pageInfo":{"hasNextPage":false}}}}`, nil
	})

	runID, err := svc.StartInitialSyncRun(context.Background(), integration.UserID, integration.ID)
	require.NoError(t, err)
	assert.Equal(t, int64(71), runID)
	select {
	case run := <-store.finishedRuns:
		assert.Equal(t, "completed", run.State)
		assert.Equal(t, int32(2), run.IssuesTotal)
		assert.Equal(t, int32(2), run.IssuesDone)
		assert.Equal(t, int32(0), run.CommentsTotal)
	case <-time.After(2 * time.Second):
		t.Fatal("sync run did not finish")
	}

	status, err := svc.GetInitialSyncRun(context.Background(), integration.UserID, integration.ID, runID)
	require.NoError(t, err)
	assert.Equal(t, "completed", status.State)
	assert.Equal(t, LinearSyncCount{Done: 2, Total: 2, Failed: 0}, status.Counts.Issues)
	assert.Equal(t, LinearSyncCount{}, status.Counts.Comments)
	require.NotNil(t, status.StartedAt)
	require.NotNil(t, status.FinishedAt)
}

func TestLinearSyncService_RetrySyncOpReplaysStoredPayload(t *testing.T) {
	integration, _ := linearSyncCovIntegration(t)
	integration.IsActive = true
	event := webhooks.IssueEventPayload{
		Action: "edited",
		Issue:  webhooks.IssuePayload{ID: 44, Number: 5, Title: "Updated", Body: "Exact retry body"},
	}
	payload, err := json.Marshal(event)
	require.NoError(t, err)
	store := &linearSyncOperationsTestStore{
		linearSyncCovQuerier: &linearSyncCovQuerier{
			integration: integration,
			issueMap: db.LinearIssueMap{
				ID: 2, IntegrationID: integration.ID, JjhubIssueID: 44, LinearIssueID: "lin-44",
			},
		},
		nextOpID:     100,
		completedOps: make(chan db.LinearSyncOp, 1),
		ops: []db.LinearSyncOp{{
			ID: 9, IntegrationID: integration.ID, Source: "jjhub", Target: "linear",
			Entity: "issue", EntityID: "44", Action: "update", Status: "failed",
			ErrorMessage: "provider failed", Payload: payload, CreatedAt: time.Now().UTC(),
		}},
	}
	svc := NewLinearSyncService(store, linearSyncOperationsIntegrationService(integration, "linear-sync-cover-secret"))
	var captured []string
	svc.httpClient = linearSyncCovHTTPClient(t, &captured, func(string) (int, string, error) {
		return http.StatusOK, `{"data":{"issueUpdate":{"success":true}}}`, nil
	})

	retry, err := svc.RetrySyncOp(context.Background(), integration.UserID, integration.ID, 9)
	require.NoError(t, err)
	assert.Equal(t, int64(101), retry.ID)
	assert.Equal(t, "pending", retry.Status)
	select {
	case completed := <-store.completedOps:
		assert.Equal(t, "success", completed.Status)
		assert.Empty(t, completed.ErrorMessage)
	case <-time.After(2 * time.Second):
		t.Fatal("sync retry did not finish")
	}
	require.Len(t, captured, 1)
	assert.Contains(t, captured[0], "Exact retry body")
}
