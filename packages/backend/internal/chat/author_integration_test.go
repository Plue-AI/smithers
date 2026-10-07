package chat

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestInstallAuthorRevocation(t *testing.T) {
	for _, status := range []string{"account", "active", "removed", "suspended", "prohibited", "other_repository"} {
		t.Run(status, func(t *testing.T) {
			f := newContextFixture(t)
			store, scope := f.handler.Store, f.scope
			ctx := t.Context()
			if status == "account" {
				_, err := store.pool.Exec(ctx, `DELETE FROM install_settings WHERE key='github.repository'`)
				require.NoError(t, err)
				scope.RepositoryID = 0
			}
			if status == "other_repository" {
				scope.RepositoryID++
			}
			runID := "author-" + status
			request := requestFor(runID)
			if status != "account" && status != "other_repository" {
				request = json.RawMessage(`{"runId":"` + runID + `","conversationId":"main","sharedConversation":true,"instructions":"","messages":[{"role":"user","content":"hello"}]}`)
			}
			journal := testJournal()
			admitted, err := store.Admit(ctx, AdmitInput{Scope: scope, RunID: runID, Journal: journal, Request: request})
			require.NoError(t, err)
			grant, err := store.Claim(ctx, scope, admitted.TurnID, time.Minute)
			require.NoError(t, err)
			switch status {
			case "removed":
				_, err = store.pool.Exec(ctx, `DELETE FROM collaborators WHERE repository_id=$1 AND user_id=$2`, f.scope.RepositoryID, scope.UserID)
			case "suspended":
				_, err = store.pool.Exec(ctx, `UPDATE collaborators SET suspended_at=now() WHERE repository_id=$1 AND user_id=$2`, f.scope.RepositoryID, scope.UserID)
			case "prohibited":
				_, err = store.pool.Exec(ctx, `UPDATE users SET prohibit_login=true WHERE id=$1`, scope.UserID)
			}
			require.NoError(t, err)
			revoked := status == "removed" || status == "suspended" || status == "prohibited"
			startErr := store.MarkProviderStarted(ctx, grant)
			_, renewErr := store.RenewProducer(ctx, grant, time.Minute)
			_, producerErr := store.Producer(ctx, grant.TurnID, grant.Generation, grant.Token)
			if revoked {
				require.ErrorIs(t, startErr, ErrProducerFenced)
				require.ErrorIs(t, renewErr, ErrProducerFenced)
				require.ErrorIs(t, producerErr, ErrProducerFenced)
			} else {
				require.NoError(t, startErr)
				require.NoError(t, renewErr)
				require.NoError(t, producerErr)
			}
			require.NoError(t, store.RevokeInactiveAuthors(ctx))
			if revoked {
				_, err = store.Commit(ctx, CommitInput{TurnID: grant.TurnID, Generation: grant.Generation, Token: grant.Token, Expected: grant.Cursor, Frames: []json.RawMessage{done(runID, "stop")}})
				require.ErrorIs(t, err, ErrProducerFenced)
				var state string
				require.NoError(t, store.pool.QueryRow(ctx, `SELECT state FROM chat_turns WHERE id=$1`, grant.TurnID).Scan(&state))
				require.Equal(t, string(StateCancelled), state)
				replay, err := store.Replay(ctx, ReplayInput{Scope: scope, RunID: runID, Journal: journal})
				require.NoError(t, err)
				raw, err := json.Marshal(replay)
				require.NoError(t, err)
				require.Contains(t, string(raw), "author_revoked")
			} else {
				_, err = store.Commit(ctx, CommitInput{TurnID: grant.TurnID, Generation: grant.Generation, Token: grant.Token, Expected: grant.Cursor, Frames: []json.RawMessage{frame(runID, "answer"), done(runID, "stop")}})
				require.NoError(t, err)
			}
		})
	}
}
