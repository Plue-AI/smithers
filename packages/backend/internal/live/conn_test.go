package live

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/sse"
)

// fakeFacts is a topic's committed facts; Build reads them.
type fakeFacts struct {
	mu     sync.Mutex
	value  string
	err    error
	builds atomic.Int64
}

func (f *fakeFacts) set(value string, err error) {
	f.mu.Lock()
	f.value, f.err = value, err
	f.mu.Unlock()
}

func (f *fakeFacts) build(context.Context) (json.RawMessage, error) {
	f.builds.Add(1)
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.err != nil {
		return nil, f.err
	}
	return json.RawMessage(f.value), nil
}

type received struct {
	T      string          `json:"t"`
	ID     uint32          `json:"id"`
	Cursor *int64          `json:"cursor"`
	Data   json.RawMessage `json:"data"`
	Code   string          `json:"code"`
}

// serve answers live sockets over hub with topics; "home" and "big" are
// served, "private:<n>" is forbidden, anything else unknown.
func serve(t *testing.T, hub *Hub, topics map[string]*fakeFacts) string {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{Subprotocols: []string{Protocol}})
		if err != nil {
			return
		}
		defer conn.CloseNow()
		hub.Serve(r.Context(), conn, func(_ context.Context, topic string) (Source, string) {
			if strings.HasPrefix(topic, "private:") {
				return Source{}, Forbidden
			}
			facts := topics[topic]
			if facts == nil {
				return Source{}, UnknownTopic
			}
			return Source{Key: topic, Every: 20 * time.Millisecond, Build: facts.build}, ""
		})
	}))
	t.Cleanup(server.Close)
	return "ws" + strings.TrimPrefix(server.URL, "http")
}

type client struct {
	t      *testing.T
	conn   *websocket.Conn
	frames chan received
	closed chan error
}

func dial(t *testing.T, url string) *client {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, url, &websocket.DialOptions{Subprotocols: []string{Protocol}})
	require.NoError(t, err)
	conn.SetReadLimit(8 << 20)
	t.Cleanup(func() { conn.CloseNow() })
	c := &client{t: t, conn: conn, frames: make(chan received, 64), closed: make(chan error, 1)}
	// One reader for the socket's life: a read whose context ends closes a
	// coder/websocket connection.
	go func() {
		for {
			_, raw, err := conn.Read(context.Background())
			if err != nil {
				c.closed <- err
				return
			}
			var frame received
			if json.Unmarshal(raw, &frame) == nil {
				c.frames <- frame
			}
		}
	}()
	return c
}

func (c *client) send(frame string) {
	c.t.Helper()
	require.NoError(c.t, c.conn.Write(context.Background(), websocket.MessageText, []byte(frame)))
}

func (c *client) next() received {
	c.t.Helper()
	select {
	case frame := <-c.frames:
		return frame
	case err := <-c.closed:
		c.t.Fatalf("socket closed: %v", err)
	case <-time.After(3 * time.Second):
		c.t.Fatal("no frame within 3 s")
	}
	return received{}
}

// quiet asserts no frame arrives within d.
func (c *client) quiet(d time.Duration) {
	c.t.Helper()
	select {
	case frame := <-c.frames:
		c.t.Fatalf("unexpected frame %+v", frame)
	case <-time.After(d):
	}
}

func TestLiveSnapshotsAreSharedAndSentOnlyWhenTheyChange(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	home := &fakeFacts{value: `{"items":[1]}`}
	hub := NewHub(ctx, nil)
	url := serve(t, hub, map[string]*fakeFacts{"home": home})

	alice, ben := dial(t, url), dial(t, url)
	alice.send(`{"t":"sub","id":7,"topic":"home"}`)
	first := alice.next()
	require.Equal(t, "snap", first.T)
	require.EqualValues(t, 7, first.ID)
	require.JSONEq(t, `{"items":[1]}`, string(first.Data))
	require.NotNil(t, first.Cursor)

	// A second person on the same topic joins the same stream: same cursor,
	// same bytes, one build per tick for both.
	ben.send(`{"t":"sub","id":3,"topic":"home"}`)
	joined := ben.next()
	require.EqualValues(t, 3, joined.ID)
	require.Equal(t, *first.Cursor, *joined.Cursor)
	require.Equal(t, string(first.Data), string(joined.Data))
	require.Equal(t, 1, hub.Streams())

	// Unchanged facts send nothing; a change sends the next cursor to both.
	alice.quiet(100 * time.Millisecond)
	home.set(`{"items":[1,2]}`, nil)
	for _, c := range []*client{alice, ben} {
		changed := c.next()
		require.Equal(t, "snap", changed.T)
		require.Equal(t, *first.Cursor+1, *changed.Cursor)
		require.JSONEq(t, `{"items":[1,2]}`, string(changed.Data))
	}

	// unsub stops one person's frames; the other keeps the stream.
	alice.send(`{"t":"unsub","id":7}`)
	home.set(`{"items":[3]}`, nil)
	require.EqualValues(t, *first.Cursor+2, *ben.next().Cursor)
	alice.quiet(100 * time.Millisecond)
	ben.send(`{"t":"unsub","id":3}`)
	require.Eventually(t, func() bool { return hub.Streams() == 0 }, time.Second, 10*time.Millisecond)
}

func TestLiveRefusesTopicsAndKeepsTheSocketOpen(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	url := serve(t, NewHub(ctx, nil), map[string]*fakeFacts{"home": {value: `{}`}})
	c := dial(t, url)
	c.send(`{"t":"sub","id":1,"topic":"nope"}`)
	require.Equal(t, received{T: "err", ID: 1, Code: UnknownTopic}, c.next())
	c.send(`{"t":"sub","id":2,"topic":"private:9"}`)
	require.Equal(t, received{T: "err", ID: 2, Code: Forbidden}, c.next())
	c.send(`{"t":"presence","id":3}`)
	require.Equal(t, received{T: "err", ID: 3, Code: Unsupported}, c.next())
	// A document frame is dark: refused by its sub id, socket open.
	require.NoError(t, c.conn.Write(context.Background(), websocket.MessageBinary, []byte{1, 0, 0, 0, 4, 9}))
	require.Equal(t, received{T: "err", ID: 4, Code: Unsupported}, c.next())
	c.send(`{"t":"sub","id":5,"topic":"home"}`)
	require.Equal(t, "snap", c.next().T)
	// A malformed frame closes the socket.
	c.send(`{"t":"sub","id":0,"topic":"home"}`)
	select {
	case err := <-c.closed:
		require.Equal(t, websocket.StatusInvalidFramePayloadData, websocket.CloseStatus(err))
	case <-time.After(3 * time.Second):
		t.Fatal("a malformed frame left the socket open")
	}
}

func TestLiveFailedBuildFallsBackThenServes(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	facts := &fakeFacts{err: errors.New("database away")}
	c := dial(t, serve(t, NewHub(ctx, nil), map[string]*fakeFacts{"home": facts}))
	c.send(`{"t":"sub","id":1,"topic":"home"}`)
	require.Equal(t, received{T: "err", ID: 1, Code: Unsupported}, c.next())
	facts.set(`{"ok":true}`, nil)
	served := c.next()
	require.Equal(t, "snap", served.T)
	require.JSONEq(t, `{"ok":true}`, string(served.Data))
	// A later failure keeps the last snapshot: nothing is sent.
	facts.set("", errors.New("database away again"))
	c.quiet(100 * time.Millisecond)
}

func TestLiveOverBudgetGetsGapAndResubscribes(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	big := &fakeFacts{value: `"` + strings.Repeat("x", SendBudget) + `"`}
	small := &fakeFacts{value: `1`}
	c := dial(t, serve(t, NewHub(ctx, nil), map[string]*fakeFacts{"big": big, "small": small}))
	c.send(`{"t":"sub","id":1,"topic":"big"}`)
	require.Equal(t, received{T: "gap", ID: 1}, c.next())
	// Another topic on the same socket still serves.
	c.send(`{"t":"sub","id":2,"topic":"small"}`)
	require.Equal(t, "snap", c.next().T)
	// Resubscribing after the gap, with a snapshot that fits, serves it.
	big.set(`"fits"`, nil)
	time.Sleep(60 * time.Millisecond)
	c.send(`{"t":"sub","id":1,"topic":"big"}`)
	again := c.next()
	require.Equal(t, "snap", again.T)
	require.EqualValues(t, 1, again.ID)
	require.JSONEq(t, `"fits"`, string(again.Data))
}

func TestLiveCursorNeverRepeatsWhenAStreamRestarts(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	hub := NewHub(ctx, nil)
	frozen := time.UnixMilli(1_000)
	hub.now = func() time.Time { return frozen }
	facts := &fakeFacts{value: `1`}
	url := serve(t, hub, map[string]*fakeFacts{"home": facts})
	c := dial(t, url)
	c.send(`{"t":"sub","id":1,"topic":"home"}`)
	first := c.next()
	c.send(`{"t":"unsub","id":1}`)
	require.Eventually(t, func() bool { return hub.Streams() == 0 }, time.Second, 10*time.Millisecond)
	c.send(`{"t":"sub","id":1,"topic":"home"}`)
	second := c.next()
	require.Greater(t, *second.Cursor, *first.Cursor)
}

func TestLiveHintRebuildsAtOnce(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	facts := &fakeFacts{value: `1`}
	hints := &fakeHints{}
	hub := NewHub(ctx, hints)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer conn.CloseNow()
		hub.Serve(r.Context(), conn, func(context.Context, string) (Source, string) {
			// Ticks too slow to matter: only the hint rebuilds.
			return Source{Key: "home", Hints: []string{"mythical_1"}, Every: time.Hour, Build: facts.build}, ""
		})
	}))
	defer server.Close()
	c := dial(t, "ws"+strings.TrimPrefix(server.URL, "http"))
	c.send(`{"t":"sub","id":1,"topic":"home"}`)
	require.Equal(t, "snap", c.next().T)
	require.Eventually(t, func() bool { return hints.subscribed.Load() == 1 }, time.Second, 5*time.Millisecond)
	facts.set(`2`, nil)
	began := time.Now()
	hints.notify()
	changed := c.next()
	require.JSONEq(t, `2`, string(changed.Data))
	require.Less(t, time.Since(began), time.Second)
}

// fakeHints is a notification source the test fires.
type fakeHints struct {
	subscribed atomic.Int64
	out        chan sse.Event
}

func (f *fakeHints) Listen(context.Context, []string) (<-chan sse.Event, func(), error) {
	f.out = make(chan sse.Event, 1)
	f.subscribed.Add(1)
	return f.out, func() {}, nil
}

func (f *fakeHints) notify() { f.out <- sse.Event{Data: `{"kind":"item"}`} }
