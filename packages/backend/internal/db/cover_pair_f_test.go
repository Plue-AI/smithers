package db

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestFCov_PairSessions_RoundTrip(t *testing.T) {
	ctx := context.Background()
	q, pool := newQueries(t)
	userID, repoID := mustCreateUserAndRepo(t, pool, uniqueTestUsername(t), uniqueTestRepoName(t))
	sourceWS := mustCreateWorkspace(t, pool, userID, repoID)
	session := mustCreatePairSession(t, q, userID, sourceWS)
	userInt8 := pgtype.Int8{Int64: userID, Valid: true}

	live, err := q.GetLivePairSessionForSource(ctx, sourceWS)
	require.NoError(t, err)
	assert.Equal(t, session.ID, live.ID)

	modeChanged, err := q.SetPairSessionAccessMode(ctx, SetPairSessionAccessModeParams{ID: session.ID, AccessMode: "link"})
	require.NoError(t, err)
	assert.Equal(t, "link", modeChanged.AccessMode)

	require.NoError(t, q.TouchPairSessionMemberSeen(ctx, TouchPairSessionMemberSeenParams{SessionID: session.ID, UserID: userID}))

	// Prompt queue: enqueue then cancel own queued prompt.
	prompt, err := q.EnqueuePairPrompt(ctx, EnqueuePairPromptParams{SessionID: session.ID, AuthorUserID: userID, Source: "solo", Body: "hello"})
	require.NoError(t, err)
	canceled, err := q.CancelOwnQueuedPairPrompt(ctx, CancelOwnQueuedPairPromptParams{CanceledBy: userInt8, ID: prompt.ID, SessionID: session.ID})
	require.NoError(t, err)
	assert.Equal(t, "canceled", canceled.Status)

	// Prompt lease renew: claim a prompt then renew its lease.
	leased, err := q.EnqueuePairPrompt(ctx, EnqueuePairPromptParams{SessionID: session.ID, AuthorUserID: userID, Source: "together", Body: "lease"})
	require.NoError(t, err)
	mustExec(t, pool, `UPDATE pair_prompt_queue SET status = 'claimed', executor_client_id = $2, claim_expires_at = NOW() + INTERVAL '1 minute' WHERE id = $1`, leased.ID, "exec-1")
	renewed, err := q.RenewPairPromptLease(ctx, RenewPairPromptLeaseParams{
		ClaimExpiresAt: pgtype.Timestamptz{Time: time.Now().Add(5 * time.Minute), Valid: true},
		ID:             leased.ID, SessionID: session.ID, ExecutorClientID: "exec-1",
	})
	require.NoError(t, err)
	assert.Equal(t, leased.ID, renewed.ID)

	// Draft: upsert then version-gated clear.
	draft, err := q.UpsertPairSessionDraft(ctx, UpsertPairSessionDraftParams{SessionID: session.ID, Content: "hi", Version: 1, UpdatedBy: userInt8})
	require.NoError(t, err)
	cleared, err := q.ClearPairSessionDraft(ctx, ClearPairSessionDraftParams{SessionID: session.ID, UpdatedBy: userInt8, ExpectedVersion: draft.Version})
	require.NoError(t, err)
	assert.Equal(t, "", cleared.Content)
}
