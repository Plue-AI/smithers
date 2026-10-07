package live

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/stretchr/testify/require"
)

func TestLiveLogRefusalsAndReplayBoundary(t *testing.T) {
	for _, tc := range []struct {
		name   string
		page   LogPage
		err    error
		cursor string
		want   string
	}{
		{"snapshot", LogPage{Cursor: 12, Data: json.RawMessage(`["one"]`)}, nil, "", "snap"},
		{"replay", LogPage{Cursor: 12, Data: json.RawMessage(`["two"]`)}, nil, `,"cursor":11`, "delta"},
		{"window", LogPage{Gap: true}, nil, `,"cursor":1`, "gap"},
		{"regression", LogPage{Cursor: 10, Data: json.RawMessage(`[]`)}, nil, `,"cursor":11`, "gap"},
		{"invalid-json", LogPage{Cursor: 12, Data: json.RawMessage(`bad`)}, nil, "", "err"},
		{"unavailable", LogPage{}, errors.New("store unavailable"), "", "err"},
		{"budget", LogPage{Cursor: 12, Data: json.RawMessage(`[` + `"` + strings.Repeat("x", SendBudget) + `"` + `]`)}, nil, "", "gap"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			hub := NewHub(ctx, nil)
			var calls atomic.Int64
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{Subprotocols: []string{Protocol}})
				if err != nil {
					return
				}
				defer conn.CloseNow()
				hub.Serve(r.Context(), conn, func(context.Context, string) (Source, string) {
					return Source{Key: "activity", Every: 10 * time.Millisecond, Log: &LogSource{Page: func(_ context.Context, after *int64) (LogPage, error) {
						calls.Add(1)
						if tc.cursor != "" && calls.Load() == 1 {
							require.NotNil(t, after)
						}
						return tc.page, tc.err
					}}}, ""
				})
			}))
			defer server.Close()
			c := dial(t, "ws"+strings.TrimPrefix(server.URL, "http"))
			c.send(`{"t":"sub","id":1,"topic":"activity"` + tc.cursor + `}`)
			frame := c.next()
			require.Equal(t, tc.want, frame.T)
			if tc.want == "snap" || tc.want == "delta" {
				require.Equal(t, int64(12), *frame.Cursor)
				require.JSONEq(t, string(tc.page.Data), string(frame.Data))
				require.Equal(t, 1, hub.Streams())
			}
			c.send(`{"t":"unsub","id":1}`)
			require.Eventually(t, func() bool { return hub.Streams() == 0 }, time.Second, time.Millisecond)
			c.conn.CloseNow()
		})
	}
}
