package sse

import (
	"context"
	"errors"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestDurableReplayUsesSourceOrderAndValidatesWholePages(t *testing.T) {
	ctx := context.Background()
	stream := &DurableStream{Load: func(_ context.Context, after int64, _ int) (DurablePage, error) {
		if after == 0 {
			return DurablePage{Events: []Event{{ID: "2", Data: `{"state":"starting"}`}, {ID: "4", Data: `{"state":"working"}`}}, Cursor: 4}, nil
		}
		return DurablePage{Cursor: after}, nil
	}}
	var applied []string
	require.NoError(t, stream.Replay(ctx, 0, func(event Event) error { applied = append(applied, event.ID); return nil }))
	require.Equal(t, []string{"2", "4"}, applied)
	require.NoError(t, stream.Replay(ctx, 4, func(event Event) error { t.Fatal("cursor replayed"); return nil }))
	stream.Load = func(context.Context, int64, int) (DurablePage, error) {
		return DurablePage{Events: []Event{{ID: "6"}, {ID: "5"}}, Cursor: 6}, nil
	}
	require.Error(t, stream.Replay(ctx, 4, func(Event) error { t.Fatal("partial invalid page delivered"); return nil }))
}

func TestDurableReplayDoesNotAdvancePastFailedDelivery(t *testing.T) {
	stream := &DurableStream{Load: func(context.Context, int64, int) (DurablePage, error) {
		return DurablePage{Events: []Event{{ID: "2"}, {ID: "4"}}, Cursor: 4}, nil
	}}
	failure := errors.New("send budget exhausted")
	require.ErrorIs(t, stream.Replay(context.Background(), 0, func(event Event) error {
		if event.ID == "4" {
			return failure
		}
		return nil
	}), failure)
	require.EqualValues(t, 2, stream.cursor)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	require.ErrorIs(t, stream.Replay(ctx, 2, func(Event) error { t.Fatal("cancelled delivery"); return nil }), context.Canceled)
}
