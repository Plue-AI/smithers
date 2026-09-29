package services

import (
	"context"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// TestPairQueueRechecksAuthorityAfterQueueLock parks a real editor request on
// the queue lock after its initial role check. The owner's service mutation
// completes before the request can persist a prompt or clear the shared draft.
func TestPairQueueRechecksAuthorityAfterQueueLock(t *testing.T) {
	for _, operation := range []string{"enqueue", "submit draft"} {
		for _, change := range []string{"revoke", "demote", "end", "unchanged"} {
			t.Run(operation+"/"+change, func(t *testing.T) {
				ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
				defer cancel()
				fx := newPairFixture(t)
				owner := mkPairUser(t, fx.pool, "queued-owner")
				editor := mkPairUser(t, fx.pool, "queued-editor")
				ws := mkPairWorkspace(t, fx.pool, owner, fx.repoID)
				svc := newPairService(fx, map[int64]bool{owner: true, editor: true}, false, nil)
				session, err := svc.CreateSession(ctx, owner, fx.repoID, ws)
				require.NoError(t, err)
				link, err := svc.MintLink(ctx, session.ID, owner, PairRoleEditor)
				require.NoError(t, err)
				_, err = svc.ResolveByLink(ctx, link.Slug, editor)
				require.NoError(t, err)

				const draftText = "owner draft must survive"
				if operation == "submit draft" {
					_, err = svc.PutDraft(ctx, session.ID, owner, draftText, 1)
					require.NoError(t, err)
				}

				blocker, err := fx.pool.Begin(ctx)
				require.NoError(t, err)
				_, err = blocker.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext($1))`, session.ID)
				require.NoError(t, err)

				result := make(chan error, 1)
				var finished atomic.Bool
				defer func() {
					cancel()
					_ = blocker.Rollback(context.Background())
					if !finished.Load() {
						select {
						case <-result:
						case <-time.After(2 * time.Second):
						}
					}
				}()
				go func() {
					if operation == "enqueue" {
						_, err := svc.Enqueue(ctx, session.ID, editor, pairPromptSourceSolo, "queued editor prompt")
						result <- err
						return
					}
					_, err := svc.SubmitDraft(ctx, session.ID, editor)
					result <- err
				}()
				require.Eventually(t, func() bool {
					var waiting bool
					err := fx.pool.QueryRow(ctx, `SELECT EXISTS (
      SELECT 1 FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
      WHERE a.datname = current_database() AND l.locktype = 'advisory'
        AND l.mode = 'ExclusiveLock' AND NOT l.granted
        AND l.classid = ((hashtext($1)::bigint >> 32) & 4294967295)::oid
        AND l.objid = (hashtext($1)::bigint & 4294967295)::oid AND l.objsubid = 1
     )`, session.ID).Scan(&waiting)
					return err == nil && waiting
				}, 5*time.Second, 10*time.Millisecond, "editor request never reached the queue lock")

				switch change {
				case "revoke":
					require.NoError(t, svc.RevokeMember(ctx, session.ID, owner, editor))
				case "demote":
					_, err = svc.SetMemberRole(ctx, session.ID, owner, editor, PairRoleViewer)
					require.NoError(t, err)
				case "end":
					require.NoError(t, svc.EndSession(ctx, session.ID, owner))
				}
				require.NoError(t, blocker.Commit(ctx))

				select {
				case err = <-result:
					finished.Store(true)
				case <-ctx.Done():
					t.Fatal("queued editor request did not finish after lock release")
				}
				if change == "unchanged" {
					require.NoError(t, err, "unchanged editor authority must still submit")
				} else if change == "end" {
					assert.Equal(t, 404, httpStatus(err), "ended session must reject queued write")
				} else {
					assert.Equal(t, 403, httpStatus(err), "revoked or demoted editor must not write")
				}

				rows, err := fx.store.ListPairPromptQueue(ctx, session.ID)
				require.NoError(t, err)
				if change == "unchanged" {
					require.Len(t, rows, 1)
					require.Equal(t, editor, rows[0].AuthorUserID)
					require.Equal(t, "queued", rows[0].Status)
				} else {
					assert.Empty(t, rows, "rejected request must not persist a prompt")
				}
				if operation == "submit draft" {
					draft, err := fx.store.GetPairSessionDraft(ctx, session.ID)
					require.NoError(t, err)
					if change == "unchanged" {
						require.Empty(t, draft.Content)
						require.Equal(t, int64(2), draft.Version)
						require.Equal(t, pairPromptSourceTogether, rows[0].Source)
						require.Equal(t, draftText, rows[0].Body)
					} else {
						assert.Equal(t, draftText, draft.Content, "rejected submit must preserve the owner's draft")
						assert.Equal(t, int64(1), draft.Version)
					}
				}
			})
		}
	}
}

// TestPairSessionEndAndRevokeWaitForMutationLock verifies both owner mutations
// join the same session-level ordering used by queued writes. In particular,
// ending a session must not bypass the lock while a mutation is in progress.
func TestPairSessionEndAndRevokeWaitForMutationLock(t *testing.T) {
	for _, change := range []string{"end", "revoke"} {
		t.Run(change, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			defer cancel()
			fx := newPairFixture(t)
			owner := mkPairUser(t, fx.pool, "mutation-owner")
			editor := mkPairUser(t, fx.pool, "mutation-editor")
			ws := mkPairWorkspace(t, fx.pool, owner, fx.repoID)
			svc := newPairService(fx, map[int64]bool{owner: true, editor: true}, false, nil)
			session, err := svc.CreateSession(ctx, owner, fx.repoID, ws)
			require.NoError(t, err)
			link, err := svc.MintLink(ctx, session.ID, owner, PairRoleEditor)
			require.NoError(t, err)
			_, err = svc.ResolveByLink(ctx, link.Slug, editor)
			require.NoError(t, err)

			key := "pair-session:" + session.ID
			blocker, err := fx.pool.Begin(ctx)
			require.NoError(t, err)
			_, err = blocker.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext($1))`, key)
			require.NoError(t, err)
			result := make(chan error, 1)
			var finished atomic.Bool
			defer func() {
				cancel()
				_ = blocker.Rollback(context.Background())
				if !finished.Load() {
					select {
					case <-result:
					case <-time.After(2 * time.Second):
					}
				}
			}()
			go func() {
				if change == "end" {
					result <- svc.EndSession(ctx, session.ID, owner)
					return
				}
				result <- svc.RevokeMember(ctx, session.ID, owner, editor)
			}()
			require.Eventually(t, func() bool {
				select {
				case err := <-result:
					t.Errorf("%s completed before the mutation lock was released: %v", change, err)
					finished.Store(true)
					return true
				default:
				}
				var waiting bool
				err := fx.pool.QueryRow(ctx, `SELECT EXISTS (
					SELECT 1 FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
					WHERE a.datname = current_database() AND l.locktype = 'advisory'
					  AND l.mode = 'ExclusiveLock' AND NOT l.granted
					  AND l.classid = ((hashtext($1)::bigint >> 32) & 4294967295)::oid
					  AND l.objid = (hashtext($1)::bigint & 4294967295)::oid AND l.objsubid = 1
				)`, key).Scan(&waiting)
				return err == nil && waiting
			}, 5*time.Second, 10*time.Millisecond, "owner mutation never waited for its session lock")
			require.NoError(t, blocker.Commit(ctx))
			if !finished.Load() {
				select {
				case err = <-result:
					finished.Store(true)
					require.NoError(t, err)
				case <-ctx.Done():
					t.Fatal("owner mutation did not finish after lock release")
				}
			}
			if change == "end" {
				_, err = svc.ResolveSession(ctx, session.ID, owner)
				require.Equal(t, 404, httpStatus(err))
			} else {
				_, err = fx.store.GetLivePairSessionMember(ctx, db.GetLivePairSessionMemberParams{SessionID: session.ID, UserID: editor})
				require.ErrorIs(t, err, pgx.ErrNoRows)
			}
		})
	}
}
