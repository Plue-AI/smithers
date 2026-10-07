package services

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/require"
)

func TestOrderAttentionAppendRevisionPostgres(t *testing.T) {
	h := newMergeHarness(t)
	h.first("First")
	appendEntry := func(entry OrderAttentionEntry) {
		require.NoError(t, pgx.BeginFunc(h.ctx, h.service.store, func(tx pgx.Tx) error {
			_, err := tx.Exec(h.ctx, `SELECT 1 FROM mythical_stacks WHERE repository_id=$1 FOR UPDATE`, h.repoID)
			if err != nil {
				return err
			}
			return appendOrderAttention(h.ctx, tx, h.repoID, entry)
		}))
	}
	appendEntry(OrderAttentionEntry{Pull: 3, Commit: "abc", Text: "first"})
	rows, err := h.service.StackAttention(h.ctx, h.repoID, h.userID)
	require.NoError(t, err)
	require.Len(t, rows, 1)
	id := rows[0].ID
	require.Equal(t, int64(1), rows[0].Revision)
	appendEntry(OrderAttentionEntry{Pull: 3, Commit: "abc", Text: "duplicate"})
	appendEntry(OrderAttentionEntry{Pull: 4, Commit: "def", Text: "second"})
	err = h.service.OrderOK(h.ctx, h.repoID, id, 1)
	require.ErrorContains(t, err, "Stack attention changed")
	rows, err = h.service.StackAttention(h.ctx, h.repoID, h.userID)
	require.NoError(t, err)
	require.Len(t, rows, 1)
	require.Equal(t, int64(2), rows[0].Revision)
	require.Equal(t, "first\nsecond", rows[0].Text)
	require.Len(t, rows[0].Entries, 2)
	require.NoError(t, h.service.OrderOK(h.ctx, h.repoID, id, 2))
	appendEntry(OrderAttentionEntry{Pull: 3, Commit: "abc", Text: "old delivery"})
	rows, err = h.service.StackAttention(context.Background(), h.repoID, h.userID)
	require.NoError(t, err)
	require.Empty(t, rows)
	appendEntry(OrderAttentionEntry{Pull: 5, Commit: "ghi", Text: "third"})
	rows, err = h.service.StackAttention(h.ctx, h.repoID, h.userID)
	require.NoError(t, err)
	require.Len(t, rows, 1)
	require.NotEqual(t, id, rows[0].ID)
}
