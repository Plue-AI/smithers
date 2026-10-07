package live

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"strconv"
	"sync"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/livedocument"
	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
)

// WikiHost is the single install document owner. PostgreSQL alone receipts saves.
// Callbacks reuse the service's visibility, identity and revision fences.
type WikiHost struct {
	Acquire func(context.Context, int64) (func(), error)
	Library *livedocument.Library
	Open    func(context.Context, int64, int64, int64, bool) (db.GetWikiDocumentRow, error)
	Commit  func(context.Context, int64, db.GetWikiDocumentRow, []byte, []byte, string) (db.GetWikiDocumentRow, error)
	ctx     context.Context
	mu      sync.Mutex
	pages   map[int64]*wikiDocument
}
type wikiDocument struct {
	idle            *time.Timer
	release         func()
	host            *WikiHost
	mu              sync.Mutex
	row             db.GetWikiDocumentRow
	doc             *livedocument.Document
	peers           map[*wikiStream]bool
	timer           *time.Timer
	timerGeneration uint64
	oldest          time.Time
	actor           int64
	closed          bool
}
type wikiStream struct {
	page   *wikiDocument
	member int64
	client uint32
	seq    uint64
	saved  uint64
	ready  func() error
	ctx    context.Context
	cancel context.CancelFunc
	output chan []byte
}

func NewWikiHost(ctx context.Context, library *livedocument.Library) *WikiHost {
	return &WikiHost{Library: library, ctx: ctx, pages: map[int64]*wikiDocument{}}
}
func (h *WikiHost) Close() {
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, p := range h.pages {
		p.mu.Lock()
		p.closed = true
		if p.timer != nil {
			p.timer.Stop()
		}
		if p.idle != nil {
			p.idle.Stop()
		}
		for s := range p.peers {
			s.cancel()
		}
		p.doc.Close()
		if p.release != nil {
			p.release()
		}
		p.mu.Unlock()
	}
	h.pages = map[int64]*wikiDocument{}
}
func (h *WikiHost) Resolve(ctx context.Context, topic string, repository, member int64) (Source, string) {
	doc, ok := ParseDocumentTopic(topic)
	if !ok || doc.Kind != "wiki" {
		return Source{}, UnknownTopic
	}
	if h == nil || h.Library == nil || h.Open == nil || h.Commit == nil {
		return Source{}, Unsupported
	}
	page, err := strconv.ParseInt(doc.Page, 10, 64)
	if err != nil || page <= 0 {
		return Source{}, UnknownTopic
	}
	row, err := h.Open(ctx, repository, page, member, false)
	if err != nil {
		return Source{}, Forbidden
	}
	ready := func() error { _, e := h.Open(ctx, repository, page, member, false); return e }
	return Source{Key: topic, Document: &DocumentSource{Actor: []byte(strconv.FormatInt(member, 10)), Ready: ready, Sequenced: true, OpenClient: func(ctx context.Context, requested uint32) (DocumentStream, error) {
		h.mu.Lock()
		defer h.mu.Unlock()
		p := h.pages[page]
		if p == nil {
			var release func()
			if h.Acquire != nil {
				var e error
				release, e = h.Acquire(ctx, page)
				if e != nil {
					return nil, e
				}
			}
			fresh, e := h.Open(ctx, repository, page, member, false)
			if e != nil {
				if release != nil {
					release()
				}
				return nil, e
			}
			row = fresh
			native, e := h.Library.Open(livedocument.Wiki, row.CrdtState)
			if e != nil {
				if release != nil {
					release()
				}
				return nil, e
			}
			p = &wikiDocument{release: release, host: h, row: row, doc: native, peers: map[*wikiStream]bool{}}
			h.pages[page] = p
		}
		p.mu.Lock()
		defer p.mu.Unlock()
		if p.idle != nil {
			p.idle.Stop()
		}
		if p.closed {
			return nil, io.EOF
		}
		var b [4]byte
		var client uint32
		var delta []byte
		for i := 0; i < 8; i++ {
			if _, err = rand.Read(b[:]); err != nil {
				return nil, err
			}
			client = binary.BigEndian.Uint32(b[:])
			if requested != 0 {
				client = requested
			}
			if client == 0 {
				continue
			}
			for peer := range p.peers {
				if peer.client == client && peer.ctx.Err() == nil {
					return nil, errors.New("client already connected")
				}
			}
			delta, err = p.doc.SetAuthor(uint64(client), strconv.FormatInt(member, 10))
			if err == nil || requested != 0 {
				break
			}
		}
		if err != nil {
			return nil, err
		}
		streamctx, cancel := context.WithCancel(ctx)
		s := &wikiStream{page: p, member: member, client: client, ready: ready, ctx: streamctx, cancel: cancel, output: make(chan []byte, 128)}
		p.peers[s] = true
		epoch := sha256.Sum256([]byte(fmt.Sprintf("wiki:%d:%d", repository, page)))
		var e [16]byte
		copy(e[:], epoch[:16])
		s.emit(wire.Document{Msg: wire.DocumentEpoch, Epoch: e, ClientID: client})
		sv, err := p.doc.Sync1()
		if err != nil {
			delete(p.peers, s)
			cancel()
			return nil, err
		}
		_ = sv // Browser initiates sync; its retained author metadata is never an input.
		p.broadcast(wire.Document{Msg: wire.DocumentSync, Data: syncPayload(2, delta)})
		return s, nil
	}}}, ""
}
func (s *wikiStream) emit(d wire.Document) {
	b, e := wire.EncodeDocumentV2(d)
	if e != nil {
		s.cancel()
		return
	}
	select {
	case s.output <- b:
	default:
		s.cancel()
	}
}
func (p *wikiDocument) broadcast(d wire.Document) {
	for s := range p.peers {
		s.emit(d)
	}
}
func (s *wikiStream) Receive(ctx context.Context) ([]byte, error) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-s.ctx.Done():
			return nil, io.EOF
		case b := <-s.output:
			return b, nil
		case <-ticker.C:
			if s.ready() != nil {
				return wire.EncodeDocumentV2(wire.Document{Msg: 255, Refusal: 11})
			}
		}
	}
}

func (s *wikiStream) Close() error {
	s.cancel()
	p := s.page
	p.mu.Lock()
	delete(p.peers, s)
	if len(p.peers) == 0 && !p.closed {
		p.idle = time.AfterFunc(60*time.Second, func() {
			p.host.mu.Lock()
			defer p.host.mu.Unlock()
			p.mu.Lock()
			defer p.mu.Unlock()
			if len(p.peers) != 0 || p.closed || !p.oldest.IsZero() {
				return
			}
			p.closed = true
			p.doc.Close()
			if p.release != nil {
				p.release()
			}
			delete(p.host.pages, p.row.ID)
		})
	}
	p.mu.Unlock()
	return nil
}
func (s *wikiStream) Send(ctx context.Context, raw []byte) error {
	input, err := wire.DecodeDocumentV2(raw)
	if err != nil {
		return err
	}
	p := s.page
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed || s.ctx.Err() != nil {
		return io.EOF
	}
	if input.Msg == wire.DocumentAwarenessInput {
		stamped, err := stampDocumentAwareness(input.Data, s.client, []byte(strconv.FormatInt(s.member, 10)), p.doc)
		if err != nil {
			return err
		}
		p.broadcast(wire.Document{Msg: wire.DocumentAwareness, Data: stamped})
		return nil
	}
	if input.Msg != wire.DocumentInput {
		return errors.New("invalid input")
	}
	kind, data, err := parseSync(input.Data)
	if len(data) > 1<<20 {
		return errors.New("wiki update exceeds 1 MiB")
	}
	if err != nil {
		return err
	}
	if kind == 0 {
		update, e := p.doc.Sync2(data)
		if e != nil {
			return e
		}
		s.emit(wire.Document{Msg: wire.DocumentSync, Data: syncPayload(1, update)})
		if p.oldest.IsZero() {
			s.emit(wire.Document{Msg: wire.DocumentSaved, AtMS: uint64(time.Now().UnixMilli()), ThroughSeq: s.saved, Data: p.row.CrdtVector})
		}
		return nil
	}
	if _, err = p.host.Open(ctx, p.row.RepositoryID, p.row.ID, s.member, true); err != nil {
		return err
	}
	update, err := p.doc.Apply(uint64(s.client), data)
	if err != nil {
		return err
	}
	s.seq = input.Seq
	p.actor = s.member
	p.broadcast(wire.Document{Msg: wire.DocumentSync, Data: syncPayload(2, update)})
	now := time.Now()
	if p.oldest.IsZero() {
		p.oldest = now
	}
	delay := 2 * time.Second
	if remaining := 10*time.Second - now.Sub(p.oldest); remaining < delay {
		delay = remaining
	}
	if p.timer != nil {
		p.timer.Stop()
	}
	p.scheduleFlush(delay)
	return nil
}

// Caller holds p.mu. Stop cannot retract a callback already waiting on it.
func (p *wikiDocument) scheduleFlush(delay time.Duration) {
	p.timerGeneration++
	generation := p.timerGeneration
	p.timer = time.AfterFunc(delay, func() { p.flush(generation) })
}
func (p *wikiDocument) flush(generation uint64) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if generation != p.timerGeneration || p.closed || p.oldest.IsZero() {
		return
	}
	state, err := p.doc.State()
	if err != nil {
		return
	}
	if len(state) > 8<<20 {
		return
	}
	vector, err := p.doc.Sync1()
	if err != nil {
		return
	}
	text, err := p.doc.Text("markdown")
	if err != nil {
		return
	}
	ctx, cancel := context.WithTimeout(p.host.ctx, 10*time.Second)
	defer cancel()
	row, err := p.host.Commit(ctx, p.actor, p.row, state, vector, text)
	if err != nil {
		p.scheduleFlush(time.Second)
		return
	}
	// A CAS conflict can add persisted concurrent operations. Merge them while
	// input is fenced by this mutex, then fan out the winning state.
	if _, err = p.doc.Peer(row.CrdtState); err != nil {
		return
	}
	p.row = row
	p.oldest = time.Time{}
	p.broadcast(wire.Document{Msg: wire.DocumentSync, Data: syncPayload(2, row.CrdtState)})
	for s := range p.peers {
		s.saved = s.seq
		s.emit(wire.Document{Msg: wire.DocumentSaved, AtMS: uint64(time.Now().UnixMilli()), ThroughSeq: s.saved, Data: row.CrdtVector})
	}
}
