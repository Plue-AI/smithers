package chat

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/smithersai/smithers/packages/backend/internal/chat/turncredential"
)

func modelCredential(grant ProducerGrant) string {
	return turncredential.Mint(grant.TurnID, grant.Generation, grant.Token)
}

func TestTurnModelCredentialVerifiesOnlyTheLiveProducerGeneration(t *testing.T) {
	store := needStore(t)
	ctx := context.Background()
	scope := testScope()
	refused := func(t *testing.T, name, token string) {
		t.Helper()
		if turn, err := turncredential.Verify(ctx, store.pool, token); !errors.Is(err, turncredential.ErrInvalid) {
			t.Fatalf("%s credential = %#v, %v; want refusal", name, turn, err)
		}
	}

	clocked, clock := clockedStore(store)
	runID := "model-credential-" + uuid.NewString()
	accepted := admit(t, clocked, scope, runID, testJournal())
	grant, err := clocked.Claim(ctx, scope, accepted.TurnID, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	credential := modelCredential(grant)
	if !strings.HasPrefix(credential, turncredential.Prefix) || strings.Contains(credential, grant.Token) {
		t.Fatalf("credential %q must carry the prefix and never the producer token", credential)
	}
	turn, err := turncredential.Verify(ctx, store.pool, credential)
	if err != nil || turn.TurnID != accepted.TurnID || turn.UserID != scope.UserID || turn.RepositoryID != scope.RepositoryID {
		t.Fatalf("live credential = %#v, %v", turn, err)
	}

	wrong := grant
	wrong.Token = strings.Repeat("b", len(grant.Token))
	refused(t, "wrong-token", modelCredential(wrong))
	refused(t, "tampered", credential[:len(credential)-2]+"AA")
	refused(t, "other-turn", strings.Replace(credential, accepted.TurnID, uuid.NewString(), 1))
	refused(t, "unprefixed", strings.TrimPrefix(credential, turncredential.Prefix))
	refused(t, "malformed", turncredential.Prefix+accepted.TurnID+".x.y")

	// A reclaimed turn rotates the producer token: the earlier generation's
	// credential is stale.
	clock.advance(2 * time.Minute)
	reclaimed, err := clocked.Claim(ctx, scope, accepted.TurnID, time.Hour)
	if err != nil || reclaimed.Generation != grant.Generation+1 {
		t.Fatalf("reclaim = %#v, %v", reclaimed, err)
	}
	refused(t, "stale-generation", credential)
	if _, err = turncredential.Verify(ctx, store.pool, modelCredential(reclaimed)); err != nil {
		t.Fatalf("reclaimed credential: %v", err)
	}

	// Cancellation makes the turn terminal and refuses its credential.
	if cancelled, err := clocked.Cancel(ctx, scope, runID); err != nil || cancelled.Count != 1 {
		t.Fatalf("cancel: %#v err=%v", cancelled, err)
	}
	refused(t, "cancelled", modelCredential(reclaimed))

	// A lease that lapsed without a reclaim is refused too.
	lapsed, _ := clockedStore(store)
	lapsed.now = func() time.Time { return time.Now().Add(-time.Hour) }
	runID = "model-credential-lapsed-" + uuid.NewString()
	accepted = admit(t, lapsed, scope, runID, testJournal())
	expired, err := lapsed.Claim(ctx, scope, accepted.TurnID, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	refused(t, "lapsed-lease", modelCredential(expired))

	// A completed turn is terminal.
	runID = "model-credential-done-" + uuid.NewString()
	accepted = admit(t, store, scope, runID, testJournal())
	finished, err := store.Claim(ctx, scope, accepted.TurnID, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if err = store.FailProducer(ctx, finished, "host_failed"); err != nil {
		t.Fatal(err)
	}
	refused(t, "terminal", modelCredential(finished))
}
