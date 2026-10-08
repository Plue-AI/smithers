// Package live reserves document admission for the shared live-channel adapter.
// It owns no transport, wire codec, CRDT engine or working-copy access.
package live

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode"
	"unicode/utf8"
)

type DocumentTopic struct {
	Kind, Branch, Path, Page string
}

// ParseDocumentTopic reserves wiki topics without activating the wiki adapter.
func ParseDocumentTopic(topic string) (DocumentTopic, bool) {
	if strings.HasPrefix(topic, "doc:wiki:") {
		page := strings.TrimPrefix(topic, "doc:wiki:")
		if validID(page) {
			return DocumentTopic{Kind: "wiki", Page: page}, true
		}
		return DocumentTopic{}, false
	}
	parts := strings.SplitN(topic, ":", 4)
	if len(parts) != 4 || parts[0] != "doc" || parts[1] != "code" || !validID(parts[2]) {
		return DocumentTopic{}, false
	}
	p := parts[3]
	if len(p) == 0 || len(p) > 4096 || !utf8.ValidString(p) || strings.ContainsAny(p, "\\\x00") {
		return DocumentTopic{}, false
	}
	for _, component := range strings.Split(p, "/") {
		if component == "" || component == "." || component == ".." {
			return DocumentTopic{}, false
		}
	}
	return DocumentTopic{Kind: "code", Branch: parts[2], Path: p}, true
}

func validID(id string) bool {
	return id != "" && utf8.ValidString(id) && !strings.ContainsAny(id, ":/\\\x00") && strings.IndexFunc(id, unicode.IsSpace) < 0
}

// Shared daemon contracts live in machined; aliases preserve existing consumers.
type DocumentStream = machined.DocumentStream
type DocumentRPC = machined.DocumentRPC

type DocumentSource struct {
	OpenClient func(context.Context, uint32) (DocumentStream, error)
	Open       func(context.Context) (DocumentStream, error)
	Actor      []byte
	Sequenced  bool
	Ready      func() error
	Authors    func(context.Context) (map[string]json.RawMessage, error)
}

// errDocumentGap ends one subscription whose stream fell behind its budget.
var errDocumentGap = machined.ErrDocumentGap

// admissionMaxAge bounds a cached member admission. With the relay's 1 s idle
// check, a suspended member's frames stop within 5 s even without an event.
const admissionMaxAge = 4 * time.Second

// DocRelay relays code documents between subscribers and the branch daemon,
// which alone holds, saves and acknowledges them (ADR 0003). The host
// authenticates each subscriber, stamps its actor on every frame and passes
// document bytes through unparsed over one daemon stream per open topic.
type DocRelay struct {
	Authorize  func(context.Context, DocumentTopic, int64, int64) ([]byte, string)
	Connection func(context.Context, string) (*machined.Connection, DocumentRPC)
	// Now is the admission cache clock; nil uses time.Now.
	Now func() time.Time
	// Authors projects committed actor references for display, never admission.
	Authors    func(context.Context, DocumentTopic) (map[string]json.RawMessage, error)
	topics     codeTopics
	generation atomic.Uint64
}

// Invalidate ends every cached admission. Roster and grant changes call it.
func (r *DocRelay) Invalidate() { r.generation.Add(1) }

func (r *DocRelay) now() time.Time {
	if r.Now != nil {
		return r.Now()
	}
	return time.Now()
}

func (r *DocRelay) Resolve(ctx context.Context, topic string, repository, member int64) (Source, string) {
	doc, ok := ParseDocumentTopic(topic)
	if !ok {
		return Source{}, UnknownTopic
	}
	if r == nil || doc.Kind != "code" || r.Authorize == nil || r.Connection == nil {
		return Source{}, Unsupported
	}
	generation := r.generation.Load()
	actor, refusal := r.Authorize(ctx, doc, repository, member)
	if refusal != "" {
		return Source{}, refusal
	}
	if len(actor) == 0 || len(actor) > 1024 || ctx.Err() != nil {
		return Source{}, Forbidden
	}
	connection, rpc := r.Connection(ctx, doc.Branch)
	if connection == nil || rpc == nil {
		return Source{}, Unsupported
	}
	if err := connection.RequireReady(doc.Branch); err != nil {
		if errors.Is(err, machined.ErrNotReady) {
			return Source{}, Unsupported
		}
		return Source{}, Forbidden
	}
	actor = append([]byte(nil), actor...)
	// Admission is cached per subscription: membership, write share, lane and
	// machine are rechecked after admissionMaxAge or any roster/grant change.
	var mu sync.Mutex
	admitted, admittedGeneration := r.now(), generation
	ready := func() error {
		mu.Lock()
		defer mu.Unlock()
		if !admitted.IsZero() && admittedGeneration == r.generation.Load() && r.now().Sub(admitted) < admissionMaxAge {
			return connection.RequireReady(doc.Branch)
		}
		generation := r.generation.Load()
		current, code := r.Authorize(ctx, doc, repository, member)
		if code != "" || !bytes.Equal(current, actor) || ctx.Err() != nil {
			admitted = time.Time{}
			return machined.ErrUnauthorized
		}
		admitted, admittedGeneration = r.now(), generation
		return connection.RequireReady(doc.Branch)
	}
	var authors func(context.Context) (map[string]json.RawMessage, error)
	if r.Authors != nil {
		authors = func(ctx context.Context) (map[string]json.RawMessage, error) { return r.Authors(ctx, doc) }
	}
	return Source{Key: topic, Document: &DocumentSource{Actor: actor, Ready: ready, Authors: authors, Sequenced: true, OpenClient: func(ctx context.Context, requested uint32) (DocumentStream, error) {
		if err := ready(); err != nil {
			return nil, err
		}
		// Streams open only on the admitted connection, never its replacement.
		if current, _ := r.Connection(ctx, doc.Branch); current != connection {
			return nil, machined.ErrNotReady
		}
		return r.topics.subscribe(ctx, topicKey{topic: topic, connection: connection}, actor, requested, func(ctx context.Context, opener []byte) (DocumentStream, error) {
			return rpc.OpenDocument(ctx, doc.Path, opener)
		})
	}}}, ""
}

func documentInput(kind byte, actor, payload []byte) ([]byte, error) {
	msg := wire.DocumentInput
	if kind == 2 {
		msg = wire.DocumentAwarenessInput
	}
	return wire.EncodeDocument(wire.Document{Msg: msg, Actor: actor, Data: payload})
}
