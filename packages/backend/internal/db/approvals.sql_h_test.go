package db

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type approvalsSQLHDB = chunk5SQLHDB
type approvalsSQLHRow = chunk5SQLHRow
type approvalsSQLHRows = chunk5SQLHRows

func TestApprovalsSQL_H_CreateListDecideAndMissing(t *testing.T) {
	ctx := context.Background()
	q, pool := newQueries(t)
	userID, repoID := mustCreateUserAndRepo(t, pool, uniqueTestUsername(t), uniqueTestRepoName(t))
	sessionID := uuid.NewString()
	_, err := q.CreateAgentSession(ctx, CreateAgentSessionParams{ID: sessionID, RepositoryID: repoID, UserID: userID, Title: "approvals h", Status: "active"})
	require.NoError(t, err)

	approvalID := uuid.NewString()
	approval, err := q.CreateApproval(ctx, CreateApprovalParams{
		ID: approvalID, SessionID: pgtype.Text{String: sessionID, Valid: true}, RepositoryID: repoID, Kind: "tool", Title: "Run command",
		Description: pgtype.Text{String: "approve it", Valid: true},
		ExpiresAt:   pgtype.Timestamptz{Time: time.Now().Add(time.Hour), Valid: true},
		Payload:     json.RawMessage(`{"command":"make test"}`),
	})
	require.NoError(t, err)
	assert.Equal(t, "pending", approval.State)

	got, err := q.GetApproval(ctx, approvalID)
	require.NoError(t, err)
	assert.Equal(t, approval.ID, got.ID)
	all, err := q.ListApprovalsByRepo(ctx, ListApprovalsByRepoParams{RepositoryID: repoID, State: "", PageOffset: 0, PageSize: 10})
	require.NoError(t, err)
	require.Len(t, all, 1)
	pending, err := q.ListPendingApprovalsBySession(ctx, ListPendingApprovalsBySessionParams{RepositoryID: repoID, SessionID: pgtype.Text{String: sessionID, Valid: true}})
	require.NoError(t, err)
	require.Len(t, pending, 1)

	decided, err := q.DecideApproval(ctx, DecideApprovalParams{
		ID: approvalID, State: "approved", DecidedBy: pgtype.Int8{Int64: userID, Valid: true}, RepositoryID: repoID,
	})
	require.NoError(t, err)
	assert.Equal(t, "approved", decided.State)
	_, err = q.DecideApproval(ctx, DecideApprovalParams{ID: approvalID, State: "rejected", RepositoryID: repoID})
	require.ErrorIs(t, err, pgx.ErrNoRows)
	pending, err = q.ListPendingApprovalsBySession(ctx, ListPendingApprovalsBySessionParams{RepositoryID: repoID, SessionID: pgtype.Text{String: sessionID, Valid: true}})
	require.NoError(t, err)
	assert.Empty(t, pending)

	approvedRows, err := q.ListApprovalsByRepo(ctx, ListApprovalsByRepoParams{RepositoryID: repoID, State: "approved", PageOffset: 0, PageSize: 10})
	require.NoError(t, err)
	require.Len(t, approvedRows, 1)
	_, err = q.GetApproval(ctx, uuid.NewString())
	require.ErrorIs(t, err, pgx.ErrNoRows)
	_, err = q.DecideApproval(ctx, DecideApprovalParams{ID: uuid.NewString(), State: "approved", RepositoryID: repoID})
	require.ErrorIs(t, err, pgx.ErrNoRows)

	_ = mustExpectQueryError(t, pool, func(spQ *Queries) error {
		_, err := spQ.CreateApproval(ctx, CreateApprovalParams{
			ID: uuid.NewString(), SessionID: pgtype.Text{String: sessionID, Valid: true}, RepositoryID: repoID, Kind: "bad", Title: "bad", Payload: json.RawMessage(`[]`),
		})
		return err
	})
}

func TestApprovalsSQL_H_ErrorBranches(t *testing.T) {
	sentinel := errors.New("approvals h failed")
	listCases := []struct {
		name string
		call func(*Queries) error
	}{
		{"ListApprovalsByRepo", func(q *Queries) error {
			_, err := q.ListApprovalsByRepo(context.Background(), ListApprovalsByRepoParams{RepositoryID: 1, PageSize: 1})
			return err
		}},
		{"ListPendingApprovalsBySession", func(q *Queries) error {
			_, err := q.ListPendingApprovalsBySession(context.Background(), ListPendingApprovalsBySessionParams{RepositoryID: 1, SessionID: pgtype.Text{String: uuid.NewString(), Valid: true}})
			return err
		}},
	}
	for _, tc := range listCases {
		require.ErrorIs(t, tc.call(New(approvalsSQLHDB{queryErr: sentinel})), sentinel, tc.name+" query")
		require.ErrorIs(t, tc.call(New(approvalsSQLHDB{rows: &approvalsSQLHRows{next: true, scanErr: sentinel}})), sentinel, tc.name+" scan")
		require.ErrorIs(t, tc.call(New(approvalsSQLHDB{rows: &approvalsSQLHRows{err: sentinel}})), sentinel, tc.name+" rows")
	}

	rowQ := New(approvalsSQLHDB{row: approvalsSQLHRow{err: sentinel}})
	_, err := rowQ.CreateApproval(context.Background(), CreateApprovalParams{})
	require.ErrorIs(t, err, sentinel)
	_, err = rowQ.DecideApproval(context.Background(), DecideApprovalParams{})
	require.ErrorIs(t, err, sentinel)
	_, err = rowQ.GetApproval(context.Background(), uuid.NewString())
	require.ErrorIs(t, err, sentinel)
}
