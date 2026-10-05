package compose

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
)

// liveFrame is one frame a rehearsal browser received on /api/live, and
// when it arrived.
type liveFrame struct {
	T      string          `json:"t"`
	ID     uint32          `json:"id"`
	Cursor *int64          `json:"cursor"`
	Data   json.RawMessage `json:"data"`
	Code   string          `json:"code"`
	At     time.Time       `json:"-"`
}

// liveSocket is one browser's /api/live socket: it records every frame.
type liveSocket struct {
	conn    *websocket.Conn
	mu      sync.Mutex
	frames  []liveFrame
	topics  map[uint32]string
	nextID  uint32
	arrived chan struct{}
	err     error
}

// openLive opens /api/live as the browser that holds jar, from the
// install's own page (its Origin), with the app's subprotocol.
func (r *rehearsal) openLive(jar http.CookieJar) (*liveSocket, error) {
	origin, err := url.Parse(r.origin)
	if err != nil {
		return nil, err
	}
	header := http.Header{"Origin": {r.origin}}
	var cookies []string
	for _, cookie := range jar.Cookies(origin) {
		cookies = append(cookies, cookie.Name+"="+cookie.Value)
	}
	header.Set("Cookie", strings.Join(cookies, "; "))
	ctx, cancel := context.WithTimeout(r.ctx, 10*time.Second)
	defer cancel()
	conn, response, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(r.origin, "http")+"/api/live", &websocket.DialOptions{Subprotocols: []string{"smithers.live.v1"}, HTTPHeader: header})
	if err != nil {
		status := 0
		if response != nil {
			status = response.StatusCode
		}
		return nil, fmt.Errorf("GET /api/live: HTTP %d: %w", status, err)
	}
	conn.SetReadLimit(32 << 20)
	socket := &liveSocket{conn: conn, topics: map[uint32]string{}, arrived: make(chan struct{}, 1)}
	r.t.Cleanup(func() { _ = conn.Close(websocket.StatusNormalClosure, "") })
	go func() {
		for {
			_, raw, err := conn.Read(context.Background())
			socket.mu.Lock()
			if err != nil {
				socket.err = err
				socket.mu.Unlock()
				return
			}
			var frame liveFrame
			if json.Unmarshal(raw, &frame) == nil {
				frame.At = time.Now()
				socket.frames = append(socket.frames, frame)
			}
			socket.mu.Unlock()
			select {
			case socket.arrived <- struct{}{}:
			default:
			}
		}
	}()
	return socket, nil
}

// subscribe sends sub for topic and answers its id.
func (s *liveSocket) subscribe(topic string) (uint32, error) {
	s.mu.Lock()
	s.nextID++
	id := s.nextID
	s.topics[id] = topic
	s.mu.Unlock()
	frame, _ := json.Marshal(map[string]any{"t": "sub", "id": id, "topic": topic})
	return id, s.conn.Write(context.Background(), websocket.MessageText, frame)
}

// received is every frame of topic so far, in arrival order.
func (s *liveSocket) received(topic string) []liveFrame {
	s.mu.Lock()
	defer s.mu.Unlock()
	var frames []liveFrame
	for _, frame := range s.frames {
		if s.topics[frame.ID] == topic {
			frames = append(frames, frame)
		}
	}
	return frames
}

// wait answers the first snap of topic that satisfies ok, waiting up to
// within; an err frame for topic fails at once.
func (s *liveSocket) wait(topic string, within time.Duration, ok func(liveFrame) bool) (liveFrame, error) {
	deadline := time.After(within)
	for {
		for _, frame := range s.received(topic) {
			if frame.T == "err" {
				return frame, fmt.Errorf("%s refused: %s", topic, frame.Code)
			}
			if frame.T == "snap" && ok(frame) {
				return frame, nil
			}
		}
		s.mu.Lock()
		err := s.err
		s.mu.Unlock()
		if err != nil {
			return liveFrame{}, fmt.Errorf("/api/live closed: %w", err)
		}
		select {
		case <-s.arrived:
		case <-time.After(100 * time.Millisecond):
		case <-deadline:
			return liveFrame{}, fmt.Errorf("no %s snapshot as wanted within %s (%d frames)", topic, within, len(s.received(topic)))
		}
	}
}

// latest waits up to within for topic's newest snap to satisfy ok.
func (s *liveSocket) latest(topic string, within time.Duration, ok func(liveFrame) bool) (liveFrame, error) {
	var newest liveFrame
	return s.wait(topic, within, func(frame liveFrame) bool {
		frames := s.received(topic)
		for i := len(frames) - 1; i >= 0; i-- {
			if frames[i].T == "snap" {
				newest = frames[i]
				break
			}
		}
		return frame.Cursor != nil && newest.Cursor != nil && *frame.Cursor == *newest.Cursor && ok(frame)
	})
}

// liveHome is what the rows read of a home snapshot.
type liveHome struct {
	Items  []liveHomeItem `json:"items"`
	Counts map[string]int `json:"counts"`
}

// liveHomeItem is one Home row.
type liveHomeItem struct {
	N     int64  `json:"n"`
	State string `json:"state"`
	Place int64  `json:"place"`
}

func decodeHome(frame liveFrame) liveHome {
	var home liveHome
	_ = json.Unmarshal(frame.Data, &home)
	return home
}

// liveTodo is what the rows read of a todo:<n> snapshot.
type liveTodo struct {
	State string     `json:"state"`
	Waits []liveWait `json:"waits"`
	Run   *struct {
		Attempt int `json:"attempt"`
	} `json:"run"`
}

func decodeTodo(frame liveFrame) liveTodo {
	var todo liveTodo
	_ = json.Unmarshal(frame.Data, &todo)
	return todo
}

// liveWait is one open question or approval on a TODO card.
type liveWait struct {
	ID string `json:"id"`
}

// stepKey is one state a run's step showed: started, running or ended.
func stepKey(node, status string, ended bool) string {
	return fmt.Sprintf("%s|%s|%t", node, status, ended)
}

// watchSteps polls run's steps (run-tree) on box through the browser relay
// every 100 ms, as the owner, until the answer it returns is called: when
// each step state first showed at the source, the lane's host.
func (r *rehearsal) watchSteps(repo, box, run string) func() map[string]time.Time {
	seen := map[string]time.Time{}
	done := make(chan struct{})
	finished := make(chan struct{})
	body := fmt.Sprintf(`{"repo":%q,"workspaceId":%q,"procedure":"Projection.Snapshot","payload":{"selector":{"_tag":"run-tree","runId":%q}}}`, repo, box, run)
	client := &http.Client{Jar: r.jar, Timeout: 5 * time.Second}
	go func() {
		defer close(finished)
		for n := 0; ; n++ {
			select {
			case <-done:
				return
			case <-time.After(100 * time.Millisecond):
			}
			request, err := http.NewRequest("POST", r.origin+"/api/workflow/rpc", strings.NewReader(body))
			if err != nil {
				continue
			}
			request.Header.Set("Content-Type", "application/json")
			request.Header.Set("Origin", r.origin)
			request.Header.Set("Idempotency-Key", fmt.Sprintf("%swatch-%d-%d", r.keyPrefix, time.Now().UnixNano(), n))
			for _, cookie := range r.jar.Cookies(request.URL) {
				if cookie.Name == "__csrf" {
					request.Header.Set("X-CSRF-Token", cookie.Value)
				}
			}
			response, err := client.Do(request)
			if err != nil {
				continue
			}
			var answer struct {
				Payload struct {
					Rows []struct {
						NodeID  string   `json:"nodeId"`
						Status  string   `json:"status"`
						EndedAt *float64 `json:"endedAt"`
					} `json:"rows"`
				} `json:"payload"`
			}
			at := time.Now()
			_ = json.NewDecoder(response.Body).Decode(&answer)
			_ = response.Body.Close()
			for _, row := range answer.Payload.Rows {
				key := stepKey(row.NodeID, row.Status, row.EndedAt != nil)
				if _, ok := seen[key]; !ok {
					seen[key] = at
				}
			}
		}
	}()
	return func() map[string]time.Time {
		close(done)
		<-finished
		return seen
	}
}
