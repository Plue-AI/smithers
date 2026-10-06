package live

import (
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
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
type outbound struct {
	data  []byte
	kind  websocket.MessageType
	valid func() bool
}

type outbox struct {
	mu     sync.Mutex
	frames []outbound
	bytes  int
	ready  chan struct{}
}

// push reserves 256 bytes for a gap; control frames share the same hard
// connection limit, so refused-subscription floods cannot grow the outbox.
func (o *outbox) push(b []byte, force bool) bool {
	return o.pushKind(b, force, websocket.MessageText)
}

func (o *outbox) pushKind(b []byte, force bool, kind websocket.MessageType) bool {
	return o.pushChecked(b, force, kind, nil)
}
func (o *outbox) pushChecked(b []byte, force bool, kind websocket.MessageType, valid func() bool) bool {
	o.mu.Lock()
	limit := SendBudget
	if !force {
		limit -= 256
	}
	if o.bytes+len(b) > limit {
		o.mu.Unlock()
		return false
	}
	o.frames = append(o.frames, outbound{data: b, kind: kind, valid: valid})
	o.bytes += len(b)
	o.mu.Unlock()
	select {
	case o.ready <- struct{}{}:
	default:
	}
	return true
}

func (o *outbox) take() []outbound {
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
	mu       sync.Mutex
	closed   bool
	gapped   bool
	leave    func()
	document DocumentStream
	source   *DocumentSource
}

func (s *subscription) close() {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
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
// PresenceSession binds operations to the authenticated socket, never a body identity.
// Close removes that socket's leases even when its reader was cancelled by revocation.
type PresenceSession struct {
	Move  func(context.Context, json.RawMessage) string
	Close func()
}

func (h *Hub) Serve(ctx context.Context, conn *websocket.Conn, resolve Resolver, presence ...PresenceSession) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	var session PresenceSession
	if len(presence) > 0 {
		session = presence[0]
	}
	if session.Close != nil {
		defer session.Close()
	}
	// The hub's end (the backend stopping) ends every socket.
	defer context.AfterFunc(h.ctx, cancel)()
	connections.Add(1)
	defer connections.Add(-1)
	conn.SetReadLimit(SendBudget + 1)
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
				if b.valid != nil && !b.valid() {
					out.sent(len(b.data))
					continue
				}
				write, stop := context.WithTimeout(ctx, 5*time.Second)
				err := conn.Write(write, b.kind, b.data)
				stop()
				out.sent(len(b.data))
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
			if len(raw) < 5 || (raw[0] != 1 && raw[0] != 2) || binary.BigEndian.Uint32(raw[1:5]) == 0 {
				_ = conn.Close(websocket.StatusInvalidFramePayloadData, "malformed_frame")
				return
			}
			id := binary.BigEndian.Uint32(raw[1:5])
			sub := subscriptions[id]
			if sub == nil || sub.document == nil {
				refuse(id, Unsupported)
				continue
			}
			sub.mu.Lock()
			inactive := sub.closed || sub.gapped
			sub.mu.Unlock()
			if inactive {
				continue
			}
			if len(raw) > SendBudget {
				sub.gap(out, id)
				continue
			}
			if sub.source.Ready() != nil {
				sub.close()
				refuse(id, Forbidden)
				continue
			}
			payload, err := documentInput(raw[0], sub.source.Actor, raw[5:])
			if err != nil || sub.document.Send(ctx, payload) != nil {
				sub.close()
				refuse(id, Unsupported)
			}
			continue
		}
		in, decodeErr := DecodeRequest(raw)
		if decodeErr != nil {
			_ = conn.Close(websocket.StatusInvalidFramePayloadData, "malformed_frame")
			return
		}
		if previous := subscriptions[in.ID]; previous != nil && (in.T == "sub" || in.T == "unsub") {
			previous.close()
			delete(subscriptions, in.ID)
		}
		switch in.T {
		case "unsub":
		case "presence":
			code := Unsupported
			if session.Move != nil {
				code = session.Move(ctx, in.Where)
			}
			if code != "" {
				refuse(in.ID, code)
			}
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
			if source.Document != nil {
				if source.Document.Open == nil || source.Document.Ready == nil || len(source.Document.Actor) == 0 || len(source.Document.Actor) > 1024 {
					refuse(in.ID, Unsupported)
					continue
				}
				subctx, stop := context.WithCancel(ctx)
				stream, err := source.Document.Open(subctx)
				if err != nil || stream == nil {
					stop()
					refuse(in.ID, Unsupported)
					continue
				}
				if ctx.Err() != nil || source.Document.Ready() != nil {
					stop()
					_ = stream.Close()
					refuse(in.ID, Forbidden)
					continue
				}
				sub := &subscription{document: stream, source: source.Document, leave: func() { stop(); _ = stream.Close() }}
				subscriptions[in.ID] = sub
				go sub.relay(subctx, out, in.ID, refuse)
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

// gap fences the old stream. Resubscription opens a fresh stream and restarts
// sync step 1, rather than replaying an incomplete old queue.
func (s *subscription) gap(out *outbox, id uint32) {
	s.mu.Lock()
	if s.closed || s.gapped {
		s.mu.Unlock()
		return
	}
	s.gapped = true
	out.push(encode(frame{T: "gap", ID: id}), true)
	leave := s.leave
	s.mu.Unlock()
	if leave != nil {
		leave()
	}
}

func (s *subscription) relay(ctx context.Context, out *outbox, id uint32, refuse func(uint32, string)) {
	hasEpoch := false
	for {
		raw, err := s.document.Receive(ctx)
		if ctx.Err() != nil {
			return
		}
		if err != nil {
			s.close()
			refuse(id, Unsupported)
			return
		}
		if s.source.Ready() != nil {
			s.close()
			refuse(id, Forbidden)
			return
		}
		d, err := wire.DecodeDocument(raw)
		if err != nil {
			s.close()
			refuse(id, Unsupported)
			return
		}
		var b []byte
		kind := websocket.MessageText
		switch d.Msg {
		case 0xff:
			s.close()
			code := Unsupported
			if d.Refusal == 11 {
				code = Forbidden
			}
			refuse(id, code)
			return
		case wire.DocumentSync, wire.DocumentAwareness:
			if !hasEpoch {
				s.close()
				refuse(id, Unsupported)
				return
			}
			k := byte(1)
			if d.Msg == wire.DocumentAwareness {
				k = 2
			}
			b = []byte{k}
			b = binary.BigEndian.AppendUint32(b, id)
			b = append(b, d.Data...)
			kind = websocket.MessageBinary
		case wire.DocumentEpoch:
			hasEpoch = true
			data, _ := json.Marshal(struct {
				Epoch    string `json:"epoch"`
				ClientID uint32 `json:"client_id"`
			}{hex.EncodeToString(d.Epoch[:]), d.ClientID})
			cursor := int64(0)
			b = encode(frame{T: "snap", ID: id, Cursor: &cursor, Data: data})
		case wire.DocumentSaved:
			if !hasEpoch {
				s.close()
				refuse(id, Unsupported)
				return
			}
			b, _ = json.Marshal(struct {
				T  string `json:"t"`
				ID uint32 `json:"id"`
				SV string `json:"sv"`
				At string `json:"at"`
			}{"saved", id, base64.StdEncoding.EncodeToString(d.Data), time.UnixMilli(int64(d.AtMS)).UTC().Format(time.RFC3339Nano)})
		case wire.DocumentGone:
			var data []byte
			if d.GoneKind == 1 {
				data, _ = json.Marshal(struct {
					Deleted bool   `json:"deleted"`
					By      string `json:"by"`
				}{true, d.GoneBy})
			} else {
				data, _ = json.Marshal(struct {
					Renamed bool   `json:"renamed"`
					To      string `json:"to"`
					By      string `json:"by"`
				}{true, d.GoneTo, d.GoneBy})
			}
			b, _ = json.Marshal(struct {
				T    string          `json:"t"`
				ID   uint32          `json:"id"`
				Data json.RawMessage `json:"data"`
			}{"gone", id, data})
		default:
			s.close()
			refuse(id, Unsupported)
			return
		}
		s.mu.Lock()
		if s.closed || s.gapped {
			s.mu.Unlock()
			return
		}
		ok := out.pushChecked(b, false, kind, func() bool { s.mu.Lock(); defer s.mu.Unlock(); return !s.closed && !s.gapped })
		s.mu.Unlock()
		if !ok {
			s.gap(out, id)
			return
		}
	}
}
