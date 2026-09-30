package services

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

// replaceRepository makes owner/name name another repository than repoID, the
// two ways a canonical write can: the repository is deleted and a new one is
// created at its name, or it is transferred away and a new one takes the name.
// Both go through the storage journal, as the product's delete and transfer do.
func replaceRepository(t *testing.T, pool *pgxpool.Pool, how string, ownerID, repoID int64, owner, name string) {
	t.Helper()
	ctx := context.Background()
	tx, err := pool.Begin(ctx)
	require.NoError(t, err)
	defer func() { _ = tx.Rollback(ctx) }()
	token := strings.Repeat(fmt.Sprintf("%x", repoID%16), 64)
	_, err = tx.Exec(ctx, `SELECT set_config('smithers.repository_storage_operation_token', $1, true)`, token)
	require.NoError(t, err)
	switch how {
	case "deleted and recreated":
		_, err = tx.Exec(ctx, `INSERT INTO repository_storage_operations
			(repository_id, operation_type, token, storage_route_key, source_owner, source_repo, source_user_id)
			VALUES ($1, 'delete', $2, 'local', $3, $4, $5)`, repoID, token, owner, name, ownerID)
		require.NoError(t, err)
		_, err = tx.Exec(ctx, `DELETE FROM repositories WHERE id = $1`, repoID)
		require.NoError(t, err)
	case "transferred":
		var other int64
		require.NoError(t, tx.QueryRow(ctx, `INSERT INTO users(username, lower_username) VALUES ('new-owner', 'new-owner') RETURNING id`).Scan(&other))
		_, err = tx.Exec(ctx, `INSERT INTO repository_storage_operations
			(repository_id, operation_type, token, storage_route_key, source_owner, source_repo, source_user_id, target_owner, target_repo, target_user_id)
			VALUES ($1, 'move', $2, 'local', $3, $4, $5, 'new-owner', $4, $6)`, repoID, token, owner, name, ownerID, other)
		require.NoError(t, err)
		_, err = tx.Exec(ctx, `UPDATE repositories SET user_id = $1 WHERE id = $2`, other, repoID)
		require.NoError(t, err)
	default:
		t.Fatalf("unknown replacement %q", how)
	}
	_, err = tx.Exec(ctx, `DELETE FROM repository_storage_operations WHERE repository_id = $1`, repoID)
	require.NoError(t, err)
	var replacement int64
	require.NoError(t, tx.QueryRow(ctx, `INSERT INTO repositories(user_id, name, lower_name, default_bookmark) VALUES ($1, $2::text, lower($2::text), 'main') RETURNING id`,
		ownerID, name).Scan(&replacement))
	require.NotEqual(t, repoID, replacement)
	require.NoError(t, tx.Commit(ctx))
}

var repositoryReplacements = []string{"deleted and recreated", "transferred"}

// The main pull's write is bound to the repository under repo-host's lock, not
// before it: a repository replaced after the pull authorized the write gets
// nothing, and the pull sees the existing 409 (#3145).
func TestGitHubMainPullBridgeBindsTheWriteUnderTheLock(t *testing.T) {
	for _, how := range append([]string{"unchanged"}, repositoryReplacements...) {
		t.Run(how, func(t *testing.T) {
			pool := newProductTestPool(t)
			ctx := context.Background()
			var userID, repoID int64
			require.NoError(t, pool.QueryRow(ctx, `INSERT INTO users(username, lower_username) VALUES ('smithers-canary', 'smithers-canary') RETURNING id`).Scan(&userID))
			require.NoError(t, pool.QueryRow(ctx, `INSERT INTO repositories(user_id, name, lower_name) VALUES ($1, 'Smithers', 'smithers') RETURNING id`, userID).Scan(&repoID))
			host := &fakeMainPullHost{bookmarks: map[string]string{"main": pullOld}}
			locks := 0
			host.locked = func() {
				locks++
				if how != "unchanged" {
					replaceRepository(t, pool, how, userID, repoID, "smithers-canary", "Smithers")
				}
			}
			bridge, err := startGitHubMainPullBridge(ctx, host, "Smithers-Canary", "Smithers",
				gitHubMainPullUpdate{repositoryID: repoID, ref: "refs/heads/main", old: pullOld, new: pullNew},
				RepositoryStillAt(db.New(pool), repoID, "Smithers-Canary", "Smithers"))
			require.NoError(t, err)
			defer bridge.Close()

			status, body, err := postReceivePack(ctx, bridge.URL(), "", []repohost.ReceivePackCommand{{OldOID: pullOld, NewOID: pullNew, RefName: "refs/heads/main"}})
			require.NoError(t, err)
			assert.Equal(t, 1, locks, "the identity is checked once repo-host holds the lock")
			if how == "unchanged" {
				assert.Equal(t, http.StatusOK, status, body)
				require.Len(t, host.meta, 1)
				assert.Equal(t, repoID, host.meta[0].RepositoryID)
				assert.Equal(t, []repohost.ReceivePackCommand{{OldOID: pullOld, NewOID: pullNew, RefName: "refs/heads/main"}}, host.received)
				assert.Equal(t, pullNew, host.bookmarks["main"])
				return
			}
			assert.Equal(t, http.StatusConflict, status, body)
			assert.Contains(t, body, "repository changed during the pull")
			assert.Empty(t, host.received, "nothing reaches the storage the name now selects")
			assert.Empty(t, host.meta)
			assert.Equal(t, pullOld, host.bookmarks["main"])
		})
	}
}

// Every stack write is bound to the repository the run loaded, under
// repo-host's lock: a repository replaced between the run's claim and the
// write's lock keeps its refs, whatever the old stack prepared (#3145).
func TestMythicalStackWriteBindsTheRepositoryUnderTheLock(t *testing.T) {
	for _, how := range repositoryReplacements {
		t.Run(how, func(t *testing.T) {
			f := newMythicalServiceFixture(t)
			pool := f.pool.(*pgxpool.Pool)
			ctx := context.Background()
			f.commit("✨ feat: one", "a.txt", "a")
			f.publish()
			_, err := f.service.RequestBootstrap(ctx, f.repoID, f.userID, 100, false)
			require.NoError(t, err)
			row := f.poll()
			require.Equal(t, "active", row.State, row.LastError)
			tip, notes := f.hostRef(repohost.MythicalBookmarkRef), f.hostRef(repohost.MythicalNotesRef)
			require.NotEmpty(t, tip)
			writes := len(f.host.metas)

			// Main moves; the fold's push takes the lock after the repository
			// was replaced at smithers-canary/smithers.
			f.commit("🔧 chore: outside", "b.txt", "b")
			f.publish()
			f.service.MainMoved(ctx, f.repoID)
			replaced := false
			f.host.locked = func() {
				if !replaced {
					replaced = true
					replaceRepository(t, pool, how, f.userID, f.repoID, "smithers-canary", "smithers")
				}
			}
			_ = f.service.PollOnce(ctx)
			require.True(t, replaced, "the fold reached the lock")
			require.Greater(t, len(f.host.metas), writes)
			for _, meta := range f.host.metas[writes:] {
				assert.Equal(t, f.repoID, meta.RepositoryID)
				assert.NotNil(t, meta.VerifyLocked, "every stack write is checked under the lock")
			}
			assert.Equal(t, tip, f.hostRef(repohost.MythicalBookmarkRef), "the replacement's stack is untouched")
			assert.Equal(t, notes, f.hostRef(repohost.MythicalNotesRef))
		})
	}
}
