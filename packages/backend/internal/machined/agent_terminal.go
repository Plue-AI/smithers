package machined

import (
	"context"
	"encoding/binary"
	"errors"
	"io"
	"sync"
	"time"
)

// T-TRM-05 (spec §8.11.2a): the coding agent runs each bash command in its own
// local PTY on its machine (`smithers-machined client pty`). The broker keeps
// that command paused until the host attaches this read-only watcher, so the
// Terminal card receives every byte; AgentTerminal joins one run's commands
// into the one terminal members watch.

// ErrAgentTerminalReadOnly refuses input: the agent has no keyboard and a
// watcher never types into the agent's terminal (spec §8.11.2).
var ErrAgentTerminalReadOnly = errors.New("agent terminal is read-only")

// HasSession reports whether this link already carries stream id, either a
// session the host opened or one it already watches.
func (l *Link) HasSession(id uint32) bool {
	if l == nil {
		return false
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.sessions[id] != nil
}

// ObserveAgentTerminal attaches the host's watcher to a local agent command
// terminal the daemon listed in presence. The broker admits a watcher only on
// a local agent PTY and returns output credit only; it never grants input.
// A session the host opened itself has a durable spawn receipt and is refused
// here, as is any run not registered on this link.
func (l *Link) ObserveAgentTerminal(ctx context.Context, branch string, id uint32, run string) (*SessionStream, error) {
	if !validSession(id) || run == "" || !validString(run) {
		return nil, refused("malformed", "invalid agent terminal")
	}
	if err := l.RequireReady(branch); err != nil {
		return nil, err
	}
	if l.HasSession(id) {
		return nil, ErrUnauthorized
	}
	if l.identities == nil {
		return nil, ErrNotReady
	}
	if _, err := l.identities.Lookup(ctx, branch, l.boot.id, id); err == nil {
		return nil, ErrUnauthorized
	} else if !errors.Is(err, ErrNotReady) {
		return nil, err
	}
	if _, err := l.RunPresence(branch, run); err != nil {
		return nil, err
	}
	if _, err := NewSessions(l.Connection, branch, l.registry.Sessions(branch)).AttachSession(ctx, id, 0); err != nil {
		return nil, err
	}
	l.mu.Lock()
	peer := l.sessions[id]
	l.mu.Unlock()
	if peer == nil {
		return nil, ErrNotReady
	}
	peer.mu.Lock()
	// The run's own session attribution: presence skips it like the coding
	// host's session, and kill_sessions(run) ends this watch with the run.
	peer.user = &SessionUser{Login: "agent", UID: 19999}
	peer.run = run
	peer.via = "agent:" + run
	peer.mu.Unlock()
	return peer, nil
}

// Detach forgets a watched stream after its close frame, without asking the
// broker to close the agent's session. Detaching earlier would leave the
// broker sending frames for a stream this link no longer knows.
func (s *SessionStream) Detach() {
	s.mu.Lock()
	l := s.link
	s.closed = true
	s.queue = nil
	s.retained = nil
	s.notify()
	s.mu.Unlock()
	l.mu.Lock()
	if l.sessions[s.id] == s {
		delete(l.sessions, s.id)
	}
	l.mu.Unlock()
}

// AgentTerminal is one coding run's terminal: its commands' watched streams in
// order, as one read-only byte stream for the shared terminal manager.
type AgentTerminal struct {
	ctx     context.Context
	cancel  context.CancelFunc
	live    func() bool
	mu      sync.Mutex
	queue   []*SessionStream
	wake    chan struct{}
	closed  bool
	readMu  sync.Mutex
	current *SessionStream
	pending []byte
	last    byte
	done    chan struct{}
	once    sync.Once
	poll    time.Duration
}

// NewAgentTerminal ends when live reports false while no command is running.
func NewAgentTerminal(live func() bool) *AgentTerminal {
	ctx, cancel := context.WithCancel(context.Background())
	return &AgentTerminal{ctx: ctx, cancel: cancel, live: live, wake: make(chan struct{}, 1), done: make(chan struct{}), poll: time.Second}
}

// Append queues the run's next command. It reports false once the terminal
// ended; the caller then drains the stream itself.
func (t *AgentTerminal) Append(stream *SessionStream) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.closed {
		return false
	}
	t.queue = append(t.queue, stream)
	select {
	case t.wake <- struct{}{}:
	default:
	}
	return true
}

// Done closes when the terminal ended.
func (t *AgentTerminal) Done() <-chan struct{} { return t.done }

func (t *AgentTerminal) next() (*SessionStream, error) {
	ticker := time.NewTicker(t.poll)
	defer ticker.Stop()
	for {
		t.mu.Lock()
		if len(t.queue) > 0 {
			stream := t.queue[0]
			t.queue = t.queue[1:]
			t.mu.Unlock()
			return stream, nil
		}
		closed := t.closed
		t.mu.Unlock()
		if closed {
			return nil, io.EOF
		}
		select {
		case <-t.wake:
		case <-t.ctx.Done():
			return nil, io.EOF
		case <-ticker.C:
			if t.live != nil && !t.live() {
				_ = t.Close()
				return nil, io.EOF
			}
		}
	}
}

// Read returns the commands' terminal bytes, returning each frame's output
// credit to the broker as it is taken. A command that ended mid-line still
// starts the next command's echo line on a row of its own.
func (t *AgentTerminal) Read(dst []byte) (int, error) {
	t.readMu.Lock()
	defer t.readMu.Unlock()
	if len(dst) == 0 {
		return 0, nil
	}
	for {
		if len(t.pending) != 0 {
			n := copy(dst, t.pending)
			t.pending = t.pending[n:]
			t.last = dst[n-1]
			return n, nil
		}
		if t.current == nil {
			stream, err := t.next()
			if err != nil {
				return 0, err
			}
			t.current = stream
			if t.last != 0 && t.last != '\n' {
				t.pending = []byte("\r\n")
			}
			continue
		}
		frame, err := t.current.Receive(t.ctx)
		if err != nil {
			if t.ctx.Err() != nil {
				// Closed while a command runs: Close drains it to its end.
				return 0, io.EOF
			}
			// Ended by the run's kill or a lost link: nothing more will arrive.
			t.current.Detach()
			t.current = nil
			continue
		}
		switch frame[0] {
		case 1:
			t.pending = append([]byte(nil), frame[2:]...)
			credit := []byte{6, 0, 0, 0, 0}
			binary.BigEndian.PutUint32(credit[1:], uint32(len(frame)-2))
			if t.current.Send(t.ctx, credit) != nil {
				// The link ended; what was read still reaches the watchers.
				t.current.Detach()
				t.current = nil
			}
		case 7, 255:
			t.current.Detach()
			t.current = nil
		}
	}
}

// Write refuses: only the agent's own client writes to its terminal.
func (t *AgentTerminal) Write([]byte) (int, error) { return 0, ErrAgentTerminalReadOnly }

// Resize is a no-op: a watcher's window never resizes the agent's terminal.
func (t *AgentTerminal) Resize(context.Context, uint16, uint16) error { return nil }

// Close ends the terminal. Watched commands keep running for the agent; their
// remaining frames are drained here so the broker never sends to a forgotten
// stream, then each stream is forgotten after its close.
func (t *AgentTerminal) Close() error {
	t.once.Do(func() {
		t.mu.Lock()
		t.closed = true
		queued := t.queue
		t.queue = nil
		t.mu.Unlock()
		t.cancel()
		close(t.done)
		for _, stream := range queued {
			go DrainAgentTerminal(stream)
		}
		go func() {
			// Read returns once its Receive sees the cancellation.
			t.readMu.Lock()
			current := t.current
			t.current = nil
			t.readMu.Unlock()
			if current != nil {
				DrainAgentTerminal(current)
			}
		}()
	})
	return nil
}

// DrainAgentTerminal returns credit for a watched command nobody displays
// until the broker closes it (at most a command's timeout and grace), then
// forgets it.
func DrainAgentTerminal(stream *SessionStream) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
	defer cancel()
	defer stream.Detach()
	for {
		frame, err := stream.Receive(ctx)
		if err != nil {
			return
		}
		switch frame[0] {
		case 1:
			credit := []byte{6, 0, 0, 0, 0}
			binary.BigEndian.PutUint32(credit[1:], uint32(len(frame)-2))
			if stream.Send(ctx, credit) != nil {
				return
			}
		case 7, 255:
			return
		}
	}
}
