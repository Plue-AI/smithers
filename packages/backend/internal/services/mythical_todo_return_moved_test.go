package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/stretchr/testify/require"
)

type movedReturnFixture struct {
	calls int
	ready error
	head  string
}

func (r *movedReturnFixture) RequireReady(string) error { return r.ready }
func (r *movedReturnFixture) ReturnToItem(context.Context, string, []byte) (machined.RewriteResult, error) {
	r.calls++
	return machined.RewriteResult{Head: r.head}, nil
}

// This is worker/recovery evidence with real SQL and Git; the daemon/broker is
// a dependency fixture, not TestReturnToItemBrokerValidatesFreezeInputs evidence.
func TestMovedOffReturnWorkerRechecksCredentialAndKeepsIndependentWait(t *testing.T) {
	for _, mode := range []string{"success", "expired", "unavailable", "rebound", "wrong_head"} {
		t.Run(mode, func(t *testing.T) {
			o, session := newTodoAdmission(t)
			item := o.fileTodo(session, "moved-return")
			branch := "5a1b0000-0000-4000-8000-000000000006"
			const target = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
			_, err := o.pool.Exec(t.Context(), `INSERT INTO workspaces(id,repository_id,user_id,name,status,head_commit_id) VALUES($1,$2,$3,'moved','running',$4)`, branch, o.repoID, o.userID, target)
			require.NoError(t, err)
			_, _, err = db.New(o.pool).BindMythicalLane(t.Context(), db.MythicalLane{WorkspaceID: branch, RepositoryID: o.repoID, ItemID: item.ID, Name: "moved"})
			require.NoError(t, err)
			checks := mythicalChecksOf(item)
			checks.Waits = []TodoWait{{ID: "other", Kind: "question", Prompt: "Which?", Since: time.Now()}, {ID: "moved", Kind: "moved_off", Prompt: "Moved", Since: time.Now(), SHA: target}}
			_, err = o.pool.Exec(t.Context(), `UPDATE mythical_items SET state='running',workspace_id=$2,checks=$3 WHERE id=$1`, item.ID, branch, checks.encode())
			require.NoError(t, err)
			raw, _ := json.Marshal(workspaceMovedOff{Item: uint64(item.Number.Int64), PreMoveCommit: target, Wait: "moved", By: json.RawMessage(`{"kind":"outside","color_index":7}`)})
			_, err = o.pool.Exec(t.Context(), `UPDATE workspaces SET moved_off=$2 WHERE id=$1`, branch, raw)
			require.NoError(t, err)
			provider := &movedReturnFixture{head: target}
			o.service.SetMovedOffReturn(provider)
			receipt, err := o.service.ControlTodo(session, item.Number.Int64, TodoControlInput{Op: "return-to-item", Wait: "moved", Repository: o.repoID, Actor: o.userID, Request: "return-once"})
			require.NoError(t, err)
			require.Equal(t, "accepted", receipt.State)
			require.Zero(t, provider.calls, "admission must never wait for or invoke the broker")
			switch mode {
			case "expired":
				_, err = o.pool.Exec(t.Context(), `UPDATE auth_sessions SET expires_at=NOW()-interval '1 minute' WHERE session_key=$1`, middleware.AuthInfoFromContext(session).SessionHash)
			case "unavailable":
				provider.ready = errors.New("unavailable")
			case "rebound":
				_, err = o.pool.Exec(t.Context(), `UPDATE mythical_lanes SET retired_at=NOW() WHERE workspace_id=$1`, branch)
			case "wrong_head":
				provider.head = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
			}
			require.NoError(t, err)
			o.wake()
			saved := o.byID(uuidString(item.ID))
			waits := mythicalChecksOf(saved).Waits
			require.Len(t, waits, 2)
			require.Nil(t, waits[0].SettledAt)
			require.Nil(t, waits[1].SettledAt)
			require.Equal(t, "needs_you", todoState(saved))
			if mode == "success" {
				require.Equal(t, 1, provider.calls)
				require.True(t, waits[1].Return.Executed)
				require.Empty(t, waits[1].Return.Error)
			} else {
				require.Equal(t, "Return failed.", waits[1].Return.Error)
				require.False(t, waits[1].Return.Executed)
				if mode == "wrong_head" {
					require.Equal(t, 1, provider.calls)
				} else {
					require.Zero(t, provider.calls)
				}
			}
			if mode == "expired" {
				refreshed := registerTestInstallCredential(t, o.pool, middleware.ContextWithAuthInfo(t.Context(), &middleware.AuthInfo{User: &db.User{ID: o.userID}, SessionHash: "refreshed-owner-session"}), o.repoID)
				receipt, err = o.service.ControlTodo(refreshed, item.Number.Int64, TodoControlInput{Op: "return-to-item", Wait: "moved", Repository: o.repoID, Actor: o.userID, Request: "return-after-sign-in"})
				require.NoError(t, err)
				require.Equal(t, "accepted", receipt.State)
				require.Zero(t, provider.calls)
				o.wake()
				require.Equal(t, 1, provider.calls, "the winner can retry with fresh credentials")
				saved = o.byID(uuidString(item.ID))
				require.True(t, mythicalChecksOf(saved).Waits[1].Return.Executed)
				require.Nil(t, mythicalChecksOf(saved).Waits[0].SettledAt)
			}

			before := provider.calls
			o.wake()
			require.Equal(t, before, provider.calls, fmt.Sprintf("%s must not rewrite twice", mode))
		})
	}
}

func TestMovedOffWaitParksStackAdvancementUntilMetadataSettlement(t *testing.T) {
	o, session := newTodoAdmission(t)
	item := o.fileTodo(session, "moved-before-launch")
	checks := mythicalChecksOf(item)
	checks.Waits = []TodoWait{{ID: "moved", Kind: "moved_off", SHA: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", Since: time.Now()}}
	_, err := o.pool.Exec(t.Context(), `UPDATE mythical_items SET checks=$2 WHERE id=$1`, item.ID, checks.encode())
	require.NoError(t, err)
	for i := 0; i < 2; i++ {
		o.wake()
		parked := o.byID(uuidString(item.ID))
		require.Equal(t, "queued", parked.State)
		require.Empty(t, parked.RequestRunID)
		require.Equal(t, "needs_you", todoState(parked))
		require.Equal(t, item.Attempt, parked.Attempt)
	}
	now := time.Now()
	checks.Waits[0].SettledAt = &now
	_, err = o.pool.Exec(t.Context(), `UPDATE mythical_items SET checks=$2 WHERE id=$1`, item.ID, checks.encode())
	require.NoError(t, err)
	o.wake()
	released := o.byID(uuidString(item.ID))
	require.NotEqual(t, "queued", released.State, "only metadata settlement releases the durable branch hold")
}
