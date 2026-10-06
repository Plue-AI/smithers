package live

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
)

// Protocol is the live channel's WebSocket subprotocol (spec §7.1).
const Protocol = "smithers.live.v1"

// SendBudget is a connection's unsent bytes before its subscriptions get
// gap (spec §7.1.1).
const SendBudget = 2 << 20

// Refusal codes an err frame carries; the socket stays open.
const (
	UnknownTopic = "unknown_topic"
	Forbidden    = "forbidden"
	Unsupported  = "unsupported"
)

// Resolver answers topic's shared source for this connection's person, or
// the refusal code.
type Resolver func(ctx context.Context, topic string) (Source, string)

var connections atomic.Int64

// Connections is the number of open live sockets in this process (§20.3).
func Connections() int64 { return connections.Load() }

// outbox is a connection's unsent frames, bounded by SendBudget.
type outbox struct {
	mu     sync.Mutex
	frames [][]byte
	bytes  int
	ready  chan struct{}
}

// push reserves 256 bytes for a gap; control frames share the same hard
// connection limit, so refused-subscription floods cannot grow the outbox.
func (o *outbox) push(b []byte, force bool) bool {
	o.mu.Lock()
	limit := SendBudget
	if !force {
		limit -= 256
	}
	if o.bytes+len(b) > limit {
		o.mu.Unlock()
		return false
	}
	o.frames = append(o.frames, b)
	o.bytes += len(b)
	o.mu.Unlock()
	select {
	case o.ready <- struct{}{}:
	default:
	}
	return true
}

func (o *outbox) take() [][]byte {
	o.mu.Lock()
	defer o.mu.Unlock()
	frames := o.frames
	o.frames = nil
	return frames
}

func (o *outbox) sent(n int) {
	o.mu.Lock()
	o.bytes -= n
	o.mu.Unlock()
}

// subscription is one sub id's membership of a stream.
type subscription struct {
	mu     sync.Mutex
	closed bool
	gapped bool
	leave  func()
}

func (s *subscription) close() {
	s.mu.Lock()
	s.closed = true
	leave := s.leave
	s.mu.Unlock()
	if leave != nil {
		leave()
	}
}

func encode(f frame) []byte {
	b, _ := json.Marshal(f)
	return b
}

// Serve runs one live socket until ctx ends or the peer leaves: each sub
// joins its topic's stream and receives that stream's snapshots as snap
// frames; a refused topic gets err and the socket stays open. The caller
// closes conn.
func (h *Hub) Serve(ctx context.Context, conn *websocket.Conn, resolve Resolver) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	// The hub's end (the backend stopping) ends every socket.
	defer context.AfterFunc(h.ctx, cancel)()
	connections.Add(1)
	defer connections.Add(-1)
	conn.SetReadLimit(64 << 10)
	out := &outbox{ready: make(chan struct{}, 1)}
	var writer sync.WaitGroup
	writer.Add(1)
	go func() {
		defer writer.Done()
		defer cancel()
		for {
			select {
			case <-ctx.Done():
				return
			case <-out.ready:
			}
			for _, b := range out.take() {
				write, stop := context.WithTimeout(ctx, 5*time.Second)
				err := conn.Write(write, websocket.MessageText, b)
				stop()
				out.sent(len(b))
				if err != nil {
					return
				}
			}
		}
	}()
	subscriptions := map[uint32]*subscription{}
	defer func() {
		for _, sub := range subscriptions {
			sub.close()
		}
		cancel()
		writer.Wait()
	}()
	refuse := func(id uint32, code string) {
		if !out.push(encode(frame{T: "err", ID: id, Code: code}), true) {
			cancel()
		}
	}
	for {
		kind, raw, err := conn.Read(ctx)
		if err != nil {
			return
		}
		if kind == websocket.MessageBinary {
			// Document frames are dark until live documents land (§7.4).
			if len(raw) >= 5 && (raw[0] == 1 || raw[0] == 2) {
				id := binary.BigEndian.Uint32(raw[1:5])
				if id == 0 {
					_ = conn.Close(websocket.StatusInvalidFramePayloadData, "malformed_frame")
					return
				}
				refuse(id, Unsupported)
				continue
			}
			_ = conn.Close(websocket.StatusUnsupportedData, "malformed_frame")
			return
		}
		in, decodeErr := DecodeRequest(raw)
		if decodeErr != nil {
			_ = conn.Close(websocket.StatusInvalidFramePayloadData, "malformed_frame")
			return
		}
		if in.T == "presence" {
			refuse(in.ID, Unsupported)
			continue
		}
		if previous := subscriptions[in.ID]; previous != nil {
			previous.close()
			delete(subscriptions, in.ID)
		}
		switch in.T {
		case "unsub":
		case "sub":
			if in.Topic == "" {
				_ = conn.Close(websocket.StatusInvalidFramePayloadData, "malformed_frame")
				return
			}
			source, code := resolve(ctx, in.Topic)
			if code != "" {
				refuse(in.ID, code)
				continue
			}
			if source.Durable != nil && source.Snapshot != nil {
				id := in.ID
				sub := &subscription{}
				streamCtx, stop := context.WithCancel(ctx)
				sub.leave = stop
				subscriptions[id] = sub
				go h.serveDurable(streamCtx, source, in.Cursor, func(f frame) bool {
					sub.mu.Lock()
					defer sub.mu.Unlock()
					if sub.closed || sub.gapped {
						return false
					}
					f.ID = id
					if out.push(encode(f), f.T == "err" || f.T == "gap") {
						return true
					}
					sub.gapped = true
					if !out.push(encode(frame{T: "gap", ID: id}), true) {
						cancel()
					}
					return false
				})
				continue
			}
			if source.Build == nil || source.Key == "" {
				refuse(in.ID, Unsupported)
				continue
			}
			id, sub := in.ID, &subscription{}
			leave := h.Join(source, func(cursor int64, data json.RawMessage, failed bool) {
				sub.mu.Lock()
				defer sub.mu.Unlock()
				if sub.closed || sub.gapped {
					return
				}
				if failed {
					refuse(id, Unsupported)
					return
				}
				if !out.push(encode(frame{T: "snap", ID: id, Cursor: &cursor, Data: data}), false) {
					// Over budget: the client resubscribes for a fresh snapshot.
					sub.gapped = true
					if !out.push(encode(frame{T: "gap", ID: id}), true) {
						cancel()
					}
				}
			})
			sub.mu.Lock()
			sub.leave = leave
			sub.mu.Unlock()
			subscriptions[in.ID] = sub
		default:
			_ = conn.Close(websocket.StatusInvalidFramePayloadData, "malformed_frame")
			return
		}
	}
}
