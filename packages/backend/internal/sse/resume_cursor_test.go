package sse

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

func TestDurableStreamValidatesOnlyAPositiveResumeCursor(t *testing.T) {
	var validated []int64
	newStream := func(validate func(context.Context, int64) error) *DurableStream {
		return &DurableStream{
			Head: func(context.Context) (int64, error) { return 9, nil },
			Load: func(_ context.Context, after int64, _ int) (DurablePage, error) {
				return DurablePage{Cursor: after}, nil
			},
			Validate: validate,
		}
	}
	record := func(_ context.Context, cursor int64) error {
		validated = append(validated, cursor)
		return nil
	}
	for _, header := range []string{"", "0", "-4", "not-a-number"} {
		request := httptest.NewRequest(http.MethodGet, "/stream", nil)
		request.Header.Set("Last-Event-ID", header)
		require.NoError(t, newStream(record).initialize(request), header)
	}
	require.Empty(t, validated, "a fresh subscription has no cursor to validate")

	request := httptest.NewRequest(http.MethodGet, "/stream", nil)
	request.Header.Set("Last-Event-ID", "5")
	stream := newStream(record)
	require.NoError(t, stream.initialize(request))
	require.Equal(t, []int64{5}, validated)
	require.Equal(t, int64(5), stream.cursor, "a validated cursor is resumed, not replaced by the head")

	refusal := pkgerrors.UnknownCursor("gone")
	require.ErrorIs(t, newStream(func(context.Context, int64) error { return refusal }).initialize(request), refusal)
}

func TestServeBrokerSSERefusesAnUnknownResumeCursorBeforeTheStream(t *testing.T) {
	broker := newRunningBroker()
	t.Cleanup(broker.Stop)
	var loaded atomic.Bool
	stream := &DurableStream{
		Head: func(context.Context) (int64, error) { return 3, nil },
		Load: func(_ context.Context, after int64, _ int) (DurablePage, error) {
			loaded.Store(true)
			return DurablePage{Cursor: after}, nil
		},
		Validate: func(context.Context, int64) error { return pkgerrors.UnknownCursor("cursor is ahead of the stream") },
	}
	request := httptest.NewRequest(http.MethodGet, "/stream", nil)
	request.Header.Set("Last-Event-ID", "99")
	rec := httptest.NewRecorder()
	ServeBrokerSSE(rec, request, BrokerStreamConfig{Broker: broker, Channel: "unknown_cursor", UserID: 1, Durable: stream})
	require.Equal(t, http.StatusConflict, rec.Code)
	require.Contains(t, rec.Body.String(), `"reason":"cursor_unknown"`)
	require.Contains(t, rec.Body.String(), `"resync":true`)
	require.NotContains(t, rec.Body.String(), ": connected")
	require.False(t, loaded.Load(), "no event may be read for a cursor that was refused")

	// Any other validation failure is an unavailable stream, not a cursor verdict.
	stream.Validate = func(context.Context, int64) error { return errors.New("database offline") }
	rec = httptest.NewRecorder()
	ServeBrokerSSE(rec, request, BrokerStreamConfig{Broker: broker, Channel: "unknown_cursor", UserID: 1, Durable: stream})
	require.Equal(t, http.StatusServiceUnavailable, rec.Code)
}

func TestServeBrokerSSERepairRunsOnItsIntervalUntilTheStreamEnds(t *testing.T) {
	broker := newRunningBroker()
	t.Cleanup(broker.Stop)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var repairs atomic.Int32
	rec := handlerCovNewRecorder()
	done := make(chan struct{})
	go func() {
		defer close(done)
		ServeBrokerSSE(rec, httptest.NewRequest(http.MethodGet, "/stream", nil).WithContext(ctx), BrokerStreamConfig{
			Broker: broker, Channel: "repair_stream", UserID: 1, KeepAlive: time.Hour, RepairInterval: 5 * time.Millisecond,
			Repair: func(w http.ResponseWriter, _ *http.Request, flusher http.Flusher) {
				if repairs.Add(1) == 2 {
					_, _ = w.Write([]byte("event: repaired\ndata: {}\n\n"))
					flusher.Flush()
				}
			},
		})
	}()
	handlerCovWaitBodyContains(t, rec, "event: repaired")
	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("stream did not end")
	}
	settled := repairs.Load()
	time.Sleep(30 * time.Millisecond)
	require.Equal(t, settled, repairs.Load(), "a finished stream must stop repairing")
}
