package live

import (
	"context"
	"encoding/json"
	"fmt"
	"math/rand"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/stretchr/testify/require"
)

// clientFrame reads whatever a browser sends: it accepts only sub with a
// topic, unsub or presence, with a positive id and no negative cursor.
func FuzzClientFrame(f *testing.F) {
	for _, seed := range []string{
		`{"t":"sub","id":7,"topic":"home"}`, `{"t":"sub","id":7,"topic":"todo:12","cursor":1043}`,
		`{"t":"unsub","id":7}`, `{"t":"presence","id":3}`, `{"t":"sub","id":0,"topic":"home"}`,
		`{"t":"sub","id":1}`, `{"t":"sub","id":1,"topic":"home","cursor":-1}`, `{"t":"snap","id":1}`,
		`{"t":"sub","id":4294967296,"topic":"home"}`, `{"t":"sub","id":1.5,"topic":"home"}`, `[]`, `null`, ``,
	} {
		f.Add([]byte(seed))
	}
	f.Fuzz(func(t *testing.T, raw []byte) {
		in, ok := clientFrame(raw)
		if !ok {
			return
		}
		if in.ID == 0 || (in.Cursor != nil && *in.Cursor < 0) {
			t.Fatalf("accepted id %d cursor %v from %q", in.ID, in.Cursor, raw)
		}
		switch in.T {
		case "unsub", "presence":
		case "sub":
			if in.Topic == "" {
				t.Fatalf("accepted a sub with no topic: %q", raw)
			}
		default:
			t.Fatalf("accepted frame kind %q from %q", in.T, raw)
		}
	})
}

// Property: however people join, leave and the facts change, every member
// of a topic sees strictly increasing cursors, one cursor always carries the
// same bytes for everyone, nobody hears the stream after leaving it, and
// everyone still on it ends at the last facts.
func TestHubDeliversOneSequenceToEveryMember(t *testing.T) {
	for seed := int64(1); seed <= 8; seed++ {
		t.Run(fmt.Sprint("seed ", seed), func(t *testing.T) {
			random := rand.New(rand.NewSource(seed))
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			hub := NewHub(ctx, nil)
			facts := &fakeFacts{value: `0`}
			source := Source{Key: "home", Every: time.Millisecond, Build: facts.build}
			type member struct {
				mu       sync.Mutex
				cursors  []int64
				payloads []string
				left     bool
				gone     bool
				late     int
				leave    func()
			}
			var members []*member
			join := func() {
				m := &member{}
				m.leave = hub.Join(source, func(cursor int64, data json.RawMessage, failed bool) {
					m.mu.Lock()
					defer m.mu.Unlock()
					if m.gone {
						m.late++
						return
					}
					if !failed {
						m.cursors = append(m.cursors, cursor)
						m.payloads = append(m.payloads, string(data))
					}
				})
				members = append(members, m)
			}
			join()
			last := 0
			for step := 0; step < 40; step++ {
				switch random.Intn(4) {
				case 0:
					join()
				case 1:
					if len(members) > 1 {
						m := members[random.Intn(len(members))]
						m.mu.Lock()
						already := m.left
						m.left = true
						m.mu.Unlock()
						if !already {
							m.leave()
							m.mu.Lock()
							m.gone = true
							m.mu.Unlock()
						}
					}
				default:
					last++
					facts.set(fmt.Sprint(last), nil)
				}
				time.Sleep(time.Duration(random.Intn(3)) * time.Millisecond)
			}
			byCursor := map[int64]string{}
			require.Eventually(t, func() bool {
				for _, m := range members {
					m.mu.Lock()
					done := m.left || (len(m.payloads) > 0 && m.payloads[len(m.payloads)-1] == fmt.Sprint(last))
					m.mu.Unlock()
					if !done {
						return false
					}
				}
				return true
			}, 2*time.Second, 5*time.Millisecond, "everyone on the stream ends at the last facts")
			for _, m := range members {
				m.mu.Lock()
				for i, cursor := range m.cursors {
					if i > 0 {
						require.Greater(t, cursor, m.cursors[i-1], "cursors only increase")
					}
					if seen, ok := byCursor[cursor]; ok {
						require.Equal(t, seen, m.payloads[i], "cursor %d carries one payload", cursor)
					}
					byCursor[cursor] = m.payloads[i]
				}
				require.Zero(t, m.late, "nothing reaches a member after it left")
				m.mu.Unlock()
				if !m.left {
					m.leave()
				}
			}
			require.Eventually(t, func() bool { return hub.Streams() == 0 }, time.Second, 5*time.Millisecond)
		})
	}
}

// The backend stopping (the hub's context ending) closes every socket.
func TestLiveSocketsEndWithTheHub(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	hub := NewHub(ctx, nil)
	c := dial(t, serve(t, hub, map[string]*fakeFacts{"home": {value: `1`}}))
	c.send(`{"t":"sub","id":1,"topic":"home"}`)
	require.Equal(t, "snap", c.next().T)
	cancel()
	select {
	case <-c.closed:
	case <-time.After(3 * time.Second):
		t.Fatal("the socket outlived the hub")
	}
}

// Duplicate input: subscribing an id again replaces its subscription, so
// one id never carries two topics; unsub of an unknown id, or twice, is
// harmless.
func TestLiveResubscribingAnIdReplacesItsTopic(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	home, flows := &fakeFacts{value: `"home"`}, &fakeFacts{value: `"flows"`}
	hub := NewHub(ctx, nil)
	c := dial(t, serve(t, hub, map[string]*fakeFacts{"home": home, "flows": flows}))
	c.send(`{"t":"sub","id":1,"topic":"home"}`)
	require.JSONEq(t, `"home"`, string(c.next().Data))
	c.send(`{"t":"sub","id":1,"topic":"flows"}`)
	require.JSONEq(t, `"flows"`, string(c.next().Data))
	require.Eventually(t, func() bool { return hub.Streams() == 1 }, time.Second, 5*time.Millisecond, "home's stream ended with its only member")
	home.set(`"home 2"`, nil)
	c.quiet(100 * time.Millisecond)
	c.send(`{"t":"unsub","id":9}`)
	c.send(`{"t":"unsub","id":1}`)
	c.send(`{"t":"unsub","id":1}`)
	require.Eventually(t, func() bool { return hub.Streams() == 0 }, time.Second, 5*time.Millisecond)
	c.send(`{"t":"sub","id":2,"topic":"home"}`)
	require.JSONEq(t, `"home 2"`, string(c.next().Data))
}

// A client that sends faster than frames it may: a burst of subs on many
// ids each gets its own snapshot, in no worse than the budget allows.
func TestLiveManySubscriptionsOnOneSocket(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	topics := map[string]*fakeFacts{}
	for i := range 50 {
		topics[fmt.Sprint("t", i)] = &fakeFacts{value: fmt.Sprintf(`%q`, strings.Repeat("x", 1000)+fmt.Sprint(i))}
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer conn.CloseNow()
		NewHub(ctx, nil).Serve(r.Context(), conn, func(_ context.Context, topic string) (Source, string) {
			return Source{Key: topic, Every: time.Hour, Build: topics[topic].build}, ""
		})
	}))
	defer server.Close()
	c := dial(t, "ws"+strings.TrimPrefix(server.URL, "http"))
	for i := range 50 {
		c.send(fmt.Sprintf(`{"t":"sub","id":%d,"topic":"t%d"}`, i+1, i))
	}
	got := map[uint32]bool{}
	for range 50 {
		frame := c.next()
		require.Equal(t, "snap", frame.T)
		got[frame.ID] = true
	}
	require.Len(t, got, 50)
}
