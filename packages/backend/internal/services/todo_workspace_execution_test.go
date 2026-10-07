package services

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/stretchr/testify/require"
)

// Unit faults isolate storage failures; composed tests use real PostgreSQL.
type executionPinStore struct {
	lane             db.MythicalLane
	item             db.MythicalItem
	laneErr, itemErr error
	itemReads        int
}

func (s *executionPinStore) GetMythicalLane(context.Context, string) (db.MythicalLane, error) {
	return s.lane, s.laneErr
}
func (s *executionPinStore) GetMythicalItem(_ context.Context, id pgtype.UUID) (db.MythicalItem, error) {
	s.itemReads++
	if id != s.lane.ItemID {
		panic("untrusted item lookup")
	}
	return s.item, s.itemErr
}

func TestTodoWorkspaceExecutionBinding(t *testing.T) {
	id := pgtype.UUID{Bytes: uuid.New(), Valid: true}
	fixture := func() *executionPinStore {
		return &executionPinStore{lane: db.MythicalLane{WorkspaceID: "box", RepositoryID: 4, ItemID: id}, item: db.MythicalItem{ID: id, RepositoryID: 4, WorkspaceID: "box", Attempt: 2, FlowDigest: pgtype.Text{String: strings.Repeat("b", 64), Valid: true}, Checks: (mythicalChecks{FlowSource: strings.Repeat("a", 40)}).encode()}}
	}
	s := fixture()
	got, err := ResolveTodoWorkspaceExecution(t.Context(), s, 4, "box")
	require.NoError(t, err)
	require.Equal(t, uuid.UUID(id.Bytes).String(), got.ItemID)
	require.EqualValues(t, 2, got.Attempt)
	require.Equal(t, strings.Repeat("a", 40), got.Pin.SourceCommit)
	require.Equal(t, strings.Repeat("b", 64), got.Pin.ExecutionDigest)
	require.Equal(t, "todo", got.Pin.Flow)
	for _, tc := range []struct {
		name     string
		mutate   func(*executionPinStore)
		ordinary bool
		reads    int
	}{
		{"ordinary workspace", func(s *executionPinStore) { s.laneErr = pgx.ErrNoRows }, true, 0},
		{"lane read failed", func(s *executionPinStore) { s.laneErr = errors.New("offline") }, false, 0},
		{"foreign lane", func(s *executionPinStore) { s.lane.RepositoryID = 5 }, false, 0},
		{"other workspace", func(s *executionPinStore) { s.lane.WorkspaceID = "other" }, false, 0},
		{"retired lane", func(s *executionPinStore) { s.lane.RetiredAt.Valid = true }, false, 0},
		{"item missing", func(s *executionPinStore) { s.itemErr = pgx.ErrNoRows }, false, 1},
		{"item read failed", func(s *executionPinStore) { s.itemErr = errors.New("offline") }, false, 1},
		{"wrong item", func(s *executionPinStore) { s.item.ID.Bytes = uuid.New() }, false, 1},
		{"foreign item", func(s *executionPinStore) { s.item.RepositoryID = 5 }, false, 1},
		{"replaced attempt workspace", func(s *executionPinStore) { s.item.WorkspaceID = "new" }, false, 1},
		{"not admitted", func(s *executionPinStore) { s.item.Attempt = 0 }, false, 1},
		{"missing pin", func(s *executionPinStore) { s.item.FlowDigest.Valid = false }, false, 1},
		{"invalid digest", func(s *executionPinStore) { s.item.FlowDigest.String = "invalid" }, false, 1},
		{"invalid source", func(s *executionPinStore) { s.item.Checks = (mythicalChecks{FlowSource: "main"}).encode() }, false, 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := fixture()
			tc.mutate(s)
			got, err := ResolveTodoWorkspaceExecution(t.Context(), s, 4, "box")
			require.Nil(t, got)
			if tc.ordinary {
				require.NoError(t, err)
			} else {
				require.Error(t, err)
			}
			require.Equal(t, tc.reads, s.itemReads)
		})
	}
}
