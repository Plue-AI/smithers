package services

import (
	"context"
	"testing"
	"time"

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

func TestOrderAttentionPreservesOtherOwnersPayloadPostgres(t *testing.T) {
	h := newMergeHarness(t)
	h.first("First")
	original := `{"id":"foreign","kind":"force_push","revision":"abc","text":"Main moved","actions":[{"tag":"main.reset-to-github","label":"Reset to GitHub main","args":{"revision":"abc"}}],"owner_receipt":{"head":"def"}}`
	h.exec(`UPDATE mythical_stacks SET attention=jsonb_build_array($2::jsonb) WHERE repository_id=$1`, h.repoID, original)
	require.NoError(t, pgx.BeginFunc(h.ctx, h.service.store, func(tx pgx.Tx) error {
		_, err := tx.Exec(h.ctx, `SELECT 1 FROM mythical_stacks WHERE repository_id=$1 FOR UPDATE`, h.repoID)
		if err != nil {
			return err
		}
		return appendOrderAttention(h.ctx, tx, h.repoID, OrderAttentionEntry{Pull: 3, Commit: "abc", Text: "Order changed"})
	}))
	rows, err := h.service.StackAttention(h.ctx, h.repoID, h.userID)
	require.NoError(t, err)
	require.Len(t, rows, 2)
	require.ErrorContains(t, h.service.OrderOK(h.ctx, h.repoID, "foreign", 0), "Stack attention changed")
	require.NoError(t, h.service.OrderOK(h.ctx, h.repoID, rows[1].ID, 1))
	var retained []byte
	require.NoError(t, h.pool.QueryRow(h.ctx, `SELECT attention->0 FROM mythical_stacks WHERE repository_id=$1`, h.repoID).Scan(&retained))
	require.JSONEq(t, original, string(retained))
	require.ErrorContains(t, requireNoStackAttention(h.ctx, h.service.store, h.repoID), "foreign")
}

func TestOrderAttentionAppendWinsAgainstWaitingOKPostgres(t *testing.T) {
	h := newMergeHarness(t)
	h.first("First")
	tx, err := h.service.store.Begin(h.ctx)
	require.NoError(t, err)
	defer tx.Rollback(h.ctx)
	_, err = tx.Exec(h.ctx, `SELECT 1 FROM mythical_stacks WHERE repository_id=$1 FOR UPDATE`, h.repoID)
	require.NoError(t, err)
	require.NoError(t, appendOrderAttention(h.ctx, tx, h.repoID, OrderAttentionEntry{Pull: 3, Commit: "one", Text: "first"}))
	require.NoError(t, tx.Commit(h.ctx))
	rows, err := h.service.StackAttention(h.ctx, h.repoID, h.userID)
	require.NoError(t, err)
	require.Len(t, rows, 1)
	id := rows[0].ID
	tx, err = h.service.store.Begin(h.ctx)
	require.NoError(t, err)
	defer tx.Rollback(h.ctx)
	_, err = tx.Exec(h.ctx, `SELECT 1 FROM mythical_stacks WHERE repository_id=$1 FOR UPDATE`, h.repoID)
	require.NoError(t, err)
	done := make(chan error, 1)
	go func() { done <- h.service.OrderOK(h.ctx, h.repoID, id, 1) }()
	select {
	case err := <-done:
		t.Fatalf("OK crossed the locked append: %v", err)
	case <-time.After(50 * time.Millisecond):
	}
	require.NoError(t, appendOrderAttention(h.ctx, tx, h.repoID, OrderAttentionEntry{Pull: 4, Commit: "two", Text: "second"}))
	require.NoError(t, tx.Commit(h.ctx))
	select {
	case err := <-done:
		require.ErrorContains(t, err, "Stack attention changed")
	case <-time.After(5 * time.Second):
		t.Fatal("OK did not resume")
	}
	rows, err = h.service.StackAttention(h.ctx, h.repoID, h.userID)
	require.NoError(t, err)
	require.Len(t, rows, 1)
	require.Equal(t, int64(2), rows[0].Revision)
	require.Len(t, rows[0].Entries, 2)
	require.NoError(t, h.service.OrderOK(h.ctx, h.repoID, id, 2))
}
