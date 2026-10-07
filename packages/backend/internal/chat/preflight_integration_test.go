package chat

import (
	"context"
	"encoding/json"
	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
	"strings"
	"testing"
	"time"
)

// This proves the existing PostgreSQL journal stores and replays the packaged
// host's first step. SharedEntries prompt-route admission remains T-APP-16's
// prerequisite; this fixture does not substitute account history for it.
func TestContextPreflightPostgresJournalReplay(t *testing.T) {
	store := needStore(t)
	ctx := context.Background()
	scope, runID, journal := testScope(), "preflight-"+uuid.NewString(), testJournal()
	admitted := admit(t, store, scope, runID, journal)
	grant, err := store.Claim(ctx, scope, admitted.TurnID, time.Minute)
	require.NoError(t, err)
	require.NoError(t, store.MarkProviderStarted(ctx, grant))
	selected := json.RawMessage(strings.Replace(literalPreflight, `"runId":"run"`, `"runId":"`+runID+`"`, 1))
	input := CommitInput{TurnID: admitted.TurnID, Generation: grant.Generation, Token: grant.Token, Expected: grant.Cursor,
		Frames: []json.RawMessage{selected, frame(runID, "Retries three times"), done(runID, "stop")}}
	committed, err := store.Commit(ctx, input)
	require.NoError(t, err)
	require.Equal(t, "committed", committed.Status)
	duplicate, err := store.Commit(ctx, input)
	require.NoError(t, err)
	require.Equal(t, "duplicate", duplicate.Status)
	page, err := store.Replay(ctx, ReplayInput{Scope: scope, RunID: runID, Journal: journal})
	require.NoError(t, err)
	require.True(t, page.Terminal)
	require.Len(t, page.Batches, 1)
	require.Len(t, page.Batches[0].Frames, 3)
	require.JSONEq(t, string(selected), string(page.Batches[0].Frames[0]))
}
