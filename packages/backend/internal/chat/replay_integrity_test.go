package chat

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"
)

// A head that advertises batches the journal no longer holds is corruption,
// not a page with more to come: a reader that trusted "more" would query the
// same empty range forever.
func TestMissingBatchesFailReplay(t *testing.T) {
	store := needStore(t)
	ctx := context.Background()
	for _, missing := range []string{"tail", "all"} {
		t.Run(missing, func(t *testing.T) {
			scope, runID, journal := testScope(), uuid.NewString(), testJournal()
			accepted := admit(t, store, scope, runID, journal)
			grant, err := store.Claim(ctx, scope, accepted.TurnID, time.Minute)
			if err != nil {
				t.Fatal(err)
			}
			first, err := store.Commit(ctx, CommitInput{TurnID: grant.TurnID, Generation: grant.Generation, Token: grant.Token, Expected: grant.Cursor, Frames: []json.RawMessage{frame(runID, "output")}})
			if err != nil {
				t.Fatal(err)
			}
			if _, err = stopStoredTurn(store, ctx, scope, runID); err != nil {
				t.Fatal(err)
			}
			if _, err = store.pool.Exec(ctx, `DELETE FROM chat_turn_batches WHERE turn_id=$1 AND ($2='all' OR batch_number=2)`, accepted.TurnID, missing); err != nil {
				t.Fatal(err)
			}
			if missing == "tail" {
				page, err := store.Replay(ctx, ReplayInput{Scope: scope, RunID: runID, Journal: journal, Limit: 1})
				if err != nil || !page.More || !sameCursor(page.Next, first.Cursor) {
					t.Fatalf("intact bounded page: %#v %v", page, err)
				}
				if _, err = store.Replay(ctx, ReplayInput{Scope: scope, RunID: runID, Journal: journal, After: &first.Cursor, Limit: 1}); !errors.Is(err, ErrCorrupt) {
					t.Errorf("missing tail after boundary: %v", err)
				}
			}
			if page, err := store.Replay(ctx, ReplayInput{Scope: scope, RunID: runID, Journal: journal}); !errors.Is(err, ErrCorrupt) {
				t.Fatalf("missing %s: next=%d head=%d more=%v err=%v", missing, page.Next.Batch, page.Head.Batch, page.More, err)
			}
		})
	}
}
