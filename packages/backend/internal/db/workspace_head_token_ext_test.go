package db

import (
	"context"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func headTokenTestToken(t *testing.T, pool DBTX, workspaceID, name string) pgtype.Int8 {
	t.Helper()
	var id int64
	require.NoError(t, pool.QueryRow(context.Background(), `
		INSERT INTO access_tokens (user_id, name, token_hash, token_last_eight, scopes)
		SELECT user_id, $2, md5(random()::text) || md5(random()::text), '01234567', 'write:repository'
		FROM workspaces WHERE id = $1 RETURNING id`, workspaceID, name).Scan(&id))
	return pgtype.Int8{Int64: id, Valid: true}
}

func headTokenExists(t *testing.T, pool DBTX, token pgtype.Int8) bool {
	t.Helper()
	var exists bool
	require.NoError(t, pool.QueryRow(context.Background(),
		`SELECT EXISTS (SELECT 1 FROM access_tokens WHERE id = $1)`, token).Scan(&exists))
	return exists
}

func workspaceUserID(t *testing.T, pool DBTX, id string) int64 {
	t.Helper()
	var userID int64
	require.NoError(t, pool.QueryRow(context.Background(), `SELECT user_id FROM workspaces WHERE id = $1`, id).Scan(&userID))
	return userID
}

func TestSwapWorkspaceHeadPushTokenID_RecordsOnlyOverTheExpectedToken(t *testing.T) {
	ctx := context.Background()
	q, pool := newQueries(t)
	id := casTestWorkspace(t, pool, "running", "vm-head")
	userID := workspaceUserID(t, pool, id)
	first := headTokenTestToken(t, pool, id, "first")
	second := headTokenTestToken(t, pool, id, "second")
	third := headTokenTestToken(t, pool, id, "third")

	won, err := q.SwapWorkspaceHeadPushTokenID(ctx, id, userID, pgtype.Int8{}, first)
	require.NoError(t, err)
	assert.True(t, won, "an empty column accepts the first token")

	won, err = q.SwapWorkspaceHeadPushTokenID(ctx, id, userID, pgtype.Int8{}, second)
	require.NoError(t, err)
	assert.False(t, won, "a caller that read the empty column loses once a token is recorded")
	assert.True(t, headTokenExists(t, pool, first), "a lost swap revokes nothing")
	assert.True(t, headTokenExists(t, pool, second), "a lost swap leaves the caller's token for the caller to revoke")

	won, err = q.SwapWorkspaceHeadPushTokenID(ctx, id, userID, first, third)
	require.NoError(t, err)
	assert.True(t, won)
	stored, err := q.GetWorkspace(ctx, id)
	require.NoError(t, err)
	assert.Equal(t, third, stored.HeadPushTokenID, "the replacement survives revoking its predecessor")
	assert.False(t, headTokenExists(t, pool, first), "the superseded token is revoked with the swap")

	won, err = q.SwapWorkspaceHeadPushTokenID(ctx, "00000000-0000-0000-0000-000000000000", userID, pgtype.Int8{}, first)
	require.NoError(t, err)
	assert.False(t, won, "a missing workspace records nothing")
}

// Exactly one of N replicas that read the same recorded token wins the swap.
func TestSwapWorkspaceHeadPushTokenID_ConcurrentOneWinner(t *testing.T) {
	ctx := context.Background()
	id := casTestWorkspace(t, sharedPool, "running", "vm-head-race")
	t.Cleanup(func() {
		_, _ = sharedPool.Exec(context.Background(), `DELETE FROM workspaces WHERE id = $1`, id)
	})
	userID := workspaceUserID(t, sharedPool, id)
	const racers = 8
	candidates := make([]pgtype.Int8, racers)
	for i := range candidates {
		candidates[i] = headTokenTestToken(t, sharedPool, id, "racer")
	}
	var wg sync.WaitGroup
	var mu sync.Mutex
	var winners []pgtype.Int8
	start := make(chan struct{})
	for _, candidate := range candidates {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			won, err := New(sharedPool).SwapWorkspaceHeadPushTokenID(ctx, id, userID, pgtype.Int8{}, candidate)
			if err != nil {
				t.Errorf("swap: %v", err)
				return
			}
			if won {
				mu.Lock()
				winners = append(winners, candidate)
				mu.Unlock()
			}
		}()
	}
	close(start)
	wg.Wait()
	require.Len(t, winners, 1)
	stored, err := New(sharedPool).GetWorkspace(ctx, id)
	require.NoError(t, err)
	assert.Equal(t, winners[0], stored.HeadPushTokenID)
}
