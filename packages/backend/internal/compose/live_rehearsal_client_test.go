package compose

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/stretchr/testify/require"
)

// Literal wire frames exercise the shipped client, including the unknown-delta
// recovery that the old Go rehearsal browser silently omitted.
func TestRehearsalUsesLiveChannelSnapshotRecovery(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
	defer cancel()
	var connections atomic.Int32
	outcome := make(chan error, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		connections.Add(1)
		if request.Header.Get("Origin") != "http://"+request.Host || request.Header.Get("Cookie") != "smithers_session=rehearsal-client" {
			http.Error(w, "missing browser authentication", http.StatusUnauthorized)
			outcome <- fmt.Errorf("browser Origin or cookie missing")
			return
		}
		conn, err := websocket.Accept(w, request, &websocket.AcceptOptions{Subprotocols: []string{"smithers.live.v1"}})
		if err != nil {
			outcome <- err
			return
		}
		defer conn.CloseNow()
		for _, frames := range [][]string{
			{`{"t":"snap","id":1,"cursor":11,"data":{"state":"needs_you","waits":[{"id":"question"}]}}`, `{"t":"delta","id":1,"cursor":12,"data":{"event_type":"todo.answered"}}`},
			{`{"t":"snap","id":1,"cursor":12,"data":{"state":"working","waits":[]}}`, `{"t":"gap","id":1}`},
			{`{"t":"snap","id":1,"cursor":3,"data":{"state":"merged","waits":[]}}`},
		} {
			_, raw, err := conn.Read(ctx)
			if err != nil {
				outcome <- err
				return
			}
			var sub map[string]any
			if err := json.Unmarshal(raw, &sub); err != nil || sub["t"] != "sub" || sub["id"] != float64(1) || sub["topic"] != "todo:2" || len(sub) != 3 {
				outcome <- fmt.Errorf("expected fresh subscription without cursor, got %s", raw)
				return
			}
			for _, frame := range frames {
				if err := conn.Write(ctx, websocket.MessageText, []byte(frame)); err != nil {
					outcome <- err
					return
				}
			}
		}
		outcome <- nil
		<-ctx.Done()
	}))
	t.Cleanup(server.Close)
	jar, err := cookiejar.New(nil)
	require.NoError(t, err)
	origin, err := url.Parse(server.URL)
	require.NoError(t, err)
	jar.SetCookies(origin, []*http.Cookie{{Name: "smithers_session", Value: "rehearsal-client"}})
	r := &rehearsal{t: t, ctx: ctx, origin: server.URL}
	browser, err := r.openLive(jar)
	require.NoError(t, err)
	_, err = browser.subscribe("todo:2")
	require.NoError(t, err)
	_, err = browser.wait("todo:2", 15*time.Second, func(frame liveFrame) bool { return decodeTodo(frame).State == "merged" })
	require.NoError(t, err)
	select {
	case err := <-outcome:
		require.NoError(t, err)
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	frames := browser.received("todo:2")
	require.Len(t, frames, 3, "unprojectable events never become card state")
	for i, want := range []struct {
		cursor int64
		state  string
		waits  int
	}{{11, "needs_you", 1}, {12, "working", 0}, {3, "merged", 0}} {
		require.Equal(t, want.cursor, *frames[i].Cursor)
		require.Equal(t, want.state, decodeTodo(frames[i]).State)
		require.Len(t, decodeTodo(frames[i]).Waits, want.waits)
	}
	require.EqualValues(t, 1, connections.Load(), "one browser retains one live socket")
}
