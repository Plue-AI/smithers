package chat

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
)

// refusingHost starts the provider for one turn and relays its refusal, the
// way the model host answers a 429 or 401 from the provider.
type refusingHost struct {
	store   *Store
	turnID  string
	refusal *ProviderRefusal
	calls   atomic.Int32
}

func (h *refusingHost) RunTurn(ctx context.Context, grant ProducerGrant) error {
	if grant.TurnID != h.turnID {
		return errors.New("not this test's turn")
	}
	h.calls.Add(1)
	if err := h.store.MarkProviderStarted(ctx, grant); err != nil {
		return err
	}
	return fmt.Errorf("chat model host refused grant with status 502: %w", h.refusal)
}

func TestDispatcherEndsProviderRefusalWithItsReasonOnce(t *testing.T) {
	for _, refusal := range []*ProviderRefusal{{Code: "provider_quota", Provider: "OpenAI"}, {Code: "provider_auth", Provider: "Cerebras"}} {
		t.Run(refusal.Code, func(t *testing.T) {
			store := needStore(t)
			scope, runID, journal := testScope(), "refused-"+uuid.NewString(), testJournal()
			accepted := admit(t, store, scope, runID, journal)
			host := &refusingHost{store: store, turnID: accepted.TurnID, refusal: refusal}
			dispatcher, err := NewDispatcher(store, host, 1, time.Minute)
			require.NoError(t, err)
			fastRetries(dispatcher)
			dispatcher.logger = slog.New(slog.DiscardHandler)
			// The provider answered, so the outcome is known even after it started.
			require.Equal(t, StateFailed, runDispatcherUntilTerminal(t, store, dispatcher, scope, accepted.TurnID))
			require.Equal(t, int32(1), host.calls.Load(), "a refused turn is not rerun")
			page, err := store.Replay(context.Background(), ReplayInput{Scope: scope, RunID: runID, Journal: journal})
			require.NoError(t, err)
			require.True(t, page.Terminal)
			frames := page.Batches[len(page.Batches)-1].Frames
			var done struct {
				Type  string `json:"type"`
				Error string `json:"error"`
				Code  string `json:"code"`
			}
			require.NoError(t, json.Unmarshal(frames[len(frames)-1], &done))
			require.Equal(t, "done", done.Type)
			require.Equal(t, refusal.Text(), done.Error)
			require.Empty(t, done.Code, "the agent frame schema names only credential_missing")
		})
	}
}
