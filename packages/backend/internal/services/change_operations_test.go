package services

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

type changeOperationTestQueries struct {
	change     db.Change
	revision   db.ChangeRevision
	operations []db.JjOperation
	operation  db.JjOperation
	later      int64
	listParams db.ListJjOperationsForChangeParams
	created    []db.CreateJjOperationParams
	upserted   []db.UpsertChangeParams
	recorded   []db.RecordChangeRevisionParams
}

func (q *changeOperationTestQueries) GetChangeByChangeID(context.Context, db.GetChangeByChangeIDParams) (db.Change, error) {
	return q.change, nil
}

func (q *changeOperationTestQueries) GetChangeRevision(context.Context, db.GetChangeRevisionParams) (db.ChangeRevision, error) {
	return q.revision, nil
}

func (q *changeOperationTestQueries) ListJjOperationsForChange(_ context.Context, arg db.ListJjOperationsForChangeParams) ([]db.JjOperation, error) {
	q.listParams = arg
	return q.operations, nil
}

func (q *changeOperationTestQueries) GetJjOperationForWorkspace(context.Context, db.GetJjOperationForWorkspaceParams) (db.JjOperation, error) {
	return q.operation, nil
}

func (q *changeOperationTestQueries) CountLaterJjOperationsInWorkspace(context.Context, db.CountLaterJjOperationsInWorkspaceParams) (int64, error) {
	return q.later, nil
}

func (q *changeOperationTestQueries) CreateJjOperation(_ context.Context, arg db.CreateJjOperationParams) (db.JjOperation, error) {
	q.created = append(q.created, arg)
	return db.JjOperation{OperationID: arg.OperationID}, nil
}

func (q *changeOperationTestQueries) UpsertChange(_ context.Context, arg db.UpsertChangeParams) (db.Change, error) {
	q.upserted = append(q.upserted, arg)
	return db.Change{ChangeID: arg.ChangeID, CommitID: arg.CommitID}, nil
}

func (q *changeOperationTestQueries) RecordChangeRevision(_ context.Context, arg db.RecordChangeRevisionParams) (db.ChangeRevision, error) {
	q.recorded = append(q.recorded, arg)
	return db.ChangeRevision{
		Seq: arg.RepositoryID + int64(len(q.recorded)), ChangeID: arg.ChangeID,
		CommitID: arg.CommitID, ParentCommitID: arg.ParentCommitID, Source: arg.Source,
		OperationIds: arg.OperationIds, CreatedAt: time.Unix(100, 0).UTC(),
	}, nil
}

type changeOperationTestRepoHost struct{ changes map[string]repohost.Change }

func (r *changeOperationTestRepoHost) GetChange(_ context.Context, _, _, changeID string) (repohost.Change, error) {
	return r.changes[changeID], nil
}

type changeOperationTestWorkspace struct {
	previewState string
	previewCalls int
	undoCalls    int
	undo         WorkspaceUndoResult
}

func (w *changeOperationTestWorkspace) PreviewOperationUndo(context.Context, string, int64, int64, string, []string) (string, error) {
	w.previewCalls++
	return w.previewState, nil
}

func (w *changeOperationTestWorkspace) UndoOperation(context.Context, string, int64, int64, string) (WorkspaceUndoResult, error) {
	w.undoCalls++
	return w.undo, nil
}

func testOperationUUID(value string) pgtype.UUID {
	parsed := uuid.MustParse(value)
	return pgtype.UUID{Bytes: parsed, Valid: true}
}

func TestChangeOperationServiceListOperationsScopesRevisionAndCarriesBlastRadius(t *testing.T) {
	workspaceID := "11111111-1111-4111-8111-111111111111"
	now := time.Unix(50, 0).UTC()
	queries := &changeOperationTestQueries{
		revision: db.ChangeRevision{Seq: 4},
		operations: []db.JjOperation{{
			OperationID: "op-a", OperationType: "rebase", Description: "rebase 3 changes onto main",
			WorkspaceID: testOperationUUID(workspaceID), ChangeIds: []string{"a", "b", "c"}, CreatedAt: now,
		}},
	}
	revision := int64(4)
	got, err := NewChangeOperationService(queries, nil, nil, nil).ListOperations(context.Background(), 7, "b", &revision)
	require.NoError(t, err)
	require.Len(t, got, 1)
	assert.Equal(t, "op-a", got[0].OperationID)
	assert.Equal(t, "rebase", got[0].OperationType)
	assert.Equal(t, []string{"a", "b", "c"}, got[0].ChangeIDs)
	require.NotNil(t, got[0].WorkspaceID)
	assert.Equal(t, workspaceID, *got[0].WorkspaceID)
	assert.Equal(t, now, got[0].Timestamp)
	assert.True(t, queries.listParams.RevisionSeq.Valid)
	assert.Equal(t, int64(4), queries.listParams.RevisionSeq.Int64)
}

func TestChangeOperationServicePreviewReportsLaterOperationsAndConflicts(t *testing.T) {
	queries := &changeOperationTestQueries{
		operation: db.JjOperation{ID: 9, OperationID: "target", ChangeIds: []string{"a", "b"}},
		later:     3,
	}
	workspace := &changeOperationTestWorkspace{previewState: "conflicts"}
	got, err := NewChangeOperationService(queries, nil, workspace, nil).PreviewUndo(
		context.Background(), 7, 11, "11111111-1111-4111-8111-111111111111", "target",
	)
	require.NoError(t, err)
	assert.Equal(t, OperationUndoPreview{AffectsChanges: []string{"a", "b"}, LaterOperations: 3, State: "conflicts"}, got)
	assert.Equal(t, 1, workspace.previewCalls)
}

func TestChangeOperationServiceUndoRecordsEveryTouchedChangeAsUndo(t *testing.T) {
	workspaceID := "11111111-1111-4111-8111-111111111111"
	queries := &changeOperationTestQueries{
		operation: db.JjOperation{ID: 9, OperationID: "target", ChangeIds: []string{"a", "b"}},
		later:     2,
	}
	workspace := &changeOperationTestWorkspace{
		previewState: "clean",
		undo:         WorkspaceUndoResult{OperationID: "undo-op", ParentOperationID: "head-op"},
	}
	repoHost := &changeOperationTestRepoHost{changes: map[string]repohost.Change{
		"a": {ChangeID: "a", CommitID: "commit-a", ParentCommitID: "parent-a", ParentChangeIDs: []string{}},
		"b": {ChangeID: "b", CommitID: "commit-b", ParentCommitID: "parent-b", ParentChangeIDs: []string{"a"}},
	}}
	got, err := NewChangeOperationService(queries, repoHost, workspace, nil).Undo(
		context.Background(), 7, 11, "alice", "demo", workspaceID, "target",
	)
	require.NoError(t, err)
	assert.Equal(t, "undo-op", got.OperationID)
	assert.Equal(t, []string{"a", "b"}, got.AffectsChanges)
	require.Len(t, got.Revisions, 2)
	assert.Equal(t, "undo", got.Revisions[0].Source)
	assert.Equal(t, "undo", got.Revisions[1].Source)
	require.Len(t, queries.created, 1)
	assert.Equal(t, workspaceID, queries.created[0].WorkspaceID)
	assert.Equal(t, []string{"a", "b"}, queries.created[0].ChangeIds)
	require.Len(t, queries.recorded, 2)
	for _, revision := range queries.recorded {
		assert.Equal(t, "undo", revision.Source)
		assert.Equal(t, []string{"undo-op"}, revision.OperationIds)
	}
	assert.Equal(t, 1, workspace.undoCalls)
}

func TestChangeOperationServiceUndoRefusesConflictingPreview(t *testing.T) {
	queries := &changeOperationTestQueries{operation: db.JjOperation{ID: 1, OperationID: "target", ChangeIds: []string{"a"}}}
	workspace := &changeOperationTestWorkspace{previewState: "conflicts"}
	_, err := NewChangeOperationService(queries, &changeOperationTestRepoHost{}, workspace, nil).Undo(
		context.Background(), 7, 11, "alice", "demo", "11111111-1111-4111-8111-111111111111", "target",
	)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "would conflict")
	assert.Zero(t, workspace.undoCalls)
}

func TestWorkspaceOperationCommandsUseDryRunCopyAndRepoOnlyRevert(t *testing.T) {
	preview := buildWorkspaceUndoPreviewCommand(defaultWorkspaceClonePath, "op'quoted", []string{"change-a", `change\"b`})
	assert.Contains(t, preview, "mktemp -d")
	assert.Contains(t, preview, "cp -a --reflink=auto")
	assert.Contains(t, preview, "op revert --what repo")
	assert.Contains(t, preview, "target='op'\\''quoted'")
	assert.Contains(t, preview, `change_id("change-a")`)
	undo := buildWorkspaceUndoCommand(defaultWorkspaceClonePath, "op-a")
	assert.Contains(t, undo, "op revert --what repo")
	assert.Contains(t, undo, "git push --all")
}
