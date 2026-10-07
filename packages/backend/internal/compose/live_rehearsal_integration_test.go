package compose

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

// liveFrame is a committed view the shipped LiveChannel delivered to a
// rehearsal browser, and when that browser observed it.
type liveFrame struct {
	T      string          `json:"t"`
	ID     uint32          `json:"id"`
	Cursor *int64          `json:"cursor"`
	Data   json.RawMessage `json:"data"`
	Code   string          `json:"code"`
	At     time.Time       `json:"-"`
}

// liveSocket records the shipped client's views, including its recovery from
// unknown deltas and gaps. It does not implement a second projection client.
type liveSocket struct {
	send func([]byte) error
	// stop closes the browser tab: the channel disposes and its socket closes.
	stop    func()
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
	var cookies []string
	for _, cookie := range jar.Cookies(origin) {
		cookies = append(cookies, cookie.Name+"="+cookie.Value)
	}
	bun, err := exec.LookPath("bun")
	if err != nil {
		return nil, err
	}
	_, source, _, _ := runtime.Caller(0)
	ctx, cancel := context.WithCancel(r.ctx)
	command := exec.CommandContext(ctx, bun, filepath.Join(filepath.Dir(source), "testdata/live/rehearsal-client.mjs"), r.origin)
	command.Env = append(os.Environ(), "SMITHERS_LIVE_REHEARSAL_COOKIE="+strings.Join(cookies, "; "))
	var diagnostics bytes.Buffer
	command.Stderr = &diagnostics
	input, err := command.StdinPipe()
	if err != nil {
		cancel()
		return nil, err
	}
	output, err := command.StdoutPipe()
	if err != nil {
		cancel()
		_ = input.Close()
		return nil, err
	}
	if err = command.Start(); err != nil {
		cancel()
		_ = input.Close()
		return nil, err
	}
	var sending sync.Mutex
	socket := &liveSocket{topics: map[uint32]string{}, arrived: make(chan struct{}, 1), send: func(frame []byte) error {
		sending.Lock()
		defer sending.Unlock()
		_, err := input.Write(append(frame, '\n'))
		return err
	}, stop: func() { _ = input.Close() }}
	done := make(chan struct{})
	r.t.Cleanup(func() {
		_ = input.Close()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			cancel()
			<-done
		}
		cancel()
	})
	go func() {
		defer close(done)
		lines := bufio.NewScanner(output)
		lines.Buffer(make([]byte, 64<<10), 32<<20)
		var readErr error
		for lines.Scan() {
			var frame liveFrame
			if err := json.Unmarshal(lines.Bytes(), &frame); err != nil {
				readErr = fmt.Errorf("LiveChannel fixture output: %w", err)
				cancel()
				break
			}
			frame.At = time.Now()
			socket.mu.Lock()
			socket.frames = append(socket.frames, frame)
			socket.mu.Unlock()
			select {
			case socket.arrived <- struct{}{}:
			default:
			}
		}
		if readErr == nil {
			readErr = lines.Err()
		}
		waitErr := command.Wait()
		socket.mu.Lock()
		socket.err = fmt.Errorf("LiveChannel fixture exited: read=%v process=%v %s", readErr, waitErr, diagnostics.String())
		socket.mu.Unlock()
		select {
		case socket.arrived <- struct{}{}:
		default:
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
	return id, s.send(frame)
}

// presence moves this tab's location as the Branch card does
// (LiveChannel.trackPresence); a nil where releases its lease.
func (s *liveSocket) presence(where map[string]any) error {
	frame, _ := json.Marshal(map[string]any{"t": "presence", "where": where})
	return s.send(frame)
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
