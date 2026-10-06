package live

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/sse"
	"github.com/stretchr/testify/require"
)

func TestLiveResubscribeSourceCursorsFault(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	// Source log deliberately has numeric gaps. Expected delivered IDs below
	// come from this independent committed log, not the codec or adapter.
	log := []sse.Event{{ID: "2", Data: `{"state":"queued"}`}, {ID: "4", Data: `{"state":"starting"}`}, {ID: "9", Data: `{"state":"working"}`}}
	var replayReads atomic.Int32
	hub := NewHub(ctx, nil)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer conn.CloseNow()
		hub.Serve(r.Context(), conn, func(context.Context, string) (Source, string) {
			return Source{Key: "home", Every: 20 * time.Millisecond,
				Snapshot: func(context.Context) (int64, json.RawMessage, error) {
					return 9, json.RawMessage(`{"state":"working"}`), nil
				},
				Durable: &sse.DurableStream{
					Validate: func(_ context.Context, c int64) error {
						if c != 2 && c != 4 && c != 9 {
							return pkgerrors.UnknownCursor("expired")
						}
						return nil
					},
					Load: func(_ context.Context, after int64, _ int) (sse.DurablePage, error) {
						if replayReads.Add(1) == 1 {
							return sse.DurablePage{}, errors.New("temporary replay read failure")
						}
						page := sse.DurablePage{Cursor: after}
						for _, event := range log {
							id, _ := strconv.ParseInt(event.ID, 10, 64)
							if id > after {
								page.Events = append(page.Events, event)
								page.Cursor = id
							}
						}
						return page, nil
					},
				},
			}, ""
		})
	}))
	defer server.Close()
	url := "ws" + strings.TrimPrefix(server.URL, "http")
	first := dial(t, url)
	first.send(`{"t":"sub","id":7,"topic":"home","cursor":2}`)
	a, b := first.next(), first.next()
	require.Equal(t, "delta", a.T)
	require.Equal(t, "delta", b.T)
	require.EqualValues(t, 4, *a.Cursor)
	require.EqualValues(t, 9, *b.Cursor)
	first.conn.CloseNow()
	resumed := dial(t, url)
	resumed.send(`{"t":"sub","id":7,"topic":"home","cursor":4}`)
	final := resumed.next()
	require.EqualValues(t, 9, *final.Cursor)
	require.JSONEq(t, `{"state":"working"}`, string(final.Data))
	resumed.quiet(30 * time.Millisecond)
	resumed.send(`{"t":"sub","id":7,"topic":"home","cursor":1}`)
	snap := resumed.next()
	require.Equal(t, "snap", snap.T)
	require.EqualValues(t, 9, *snap.Cursor)
	require.JSONEq(t, `{"state":"working"}`, string(snap.Data))
	resumed.send(`{"t":"sub","id":7,"topic":"home"}`)
	require.Equal(t, "snap", resumed.next().T)
}
