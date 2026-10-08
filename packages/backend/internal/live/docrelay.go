// Package live reserves document admission for the shared live-channel adapter.
// It owns no transport, wire codec, CRDT engine or working-copy access.
package live

import (
	"bytes"
	"context"
	"errors"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
	"strings"
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
}

// errDocumentGap ends one subscription whose stream fell behind its budget.
var errDocumentGap = machined.ErrDocumentGap

// DocRelay relays code documents between each subscriber and the branch
// daemon, which alone holds, saves and acknowledges them (ADR 0003). The host
// authenticates the subscriber, stamps its actor on every frame and passes
// document payloads through unparsed. It keeps no document replica.
type DocRelay struct {
	Authorize  func(context.Context, DocumentTopic, int64, int64) ([]byte, string)
	Connection func(context.Context, string) (*machined.Connection, DocumentRPC)
}

func (r *DocRelay) Resolve(ctx context.Context, topic string, repository, member int64) (Source, string) {
	doc, ok := ParseDocumentTopic(topic)
	if !ok {
		return Source{}, UnknownTopic
	}
	if r == nil || doc.Kind != "code" || r.Authorize == nil || r.Connection == nil {
		return Source{}, Unsupported
	}
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
	// Each check repeats admission: membership, write share, lane and machine
	// can change while the subscription is open.
	ready := func() error {
		current, code := r.Authorize(ctx, doc, repository, member)
		if code != "" || !bytes.Equal(current, actor) || ctx.Err() != nil {
			return machined.ErrUnauthorized
		}
		return connection.RequireReady(doc.Branch)
	}
	return Source{Key: topic, Document: &DocumentSource{Actor: actor, Ready: ready, Sequenced: true, Open: func(ctx context.Context) (DocumentStream, error) {
		if err := ready(); err != nil {
			return nil, err
		}
		// One daemon stream per subscription, on the admitted connection only.
		if current, _ := r.Connection(ctx, doc.Branch); current != connection {
			return nil, machined.ErrNotReady
		}
		return rpc.OpenDocument(ctx, doc.Path, actor)
	}}}, ""
}

func documentInput(kind byte, actor, payload []byte) ([]byte, error) {
	msg := wire.DocumentInput
	if kind == 2 {
		msg = wire.DocumentAwarenessInput
	}
	return wire.EncodeDocument(wire.Document{Msg: msg, Actor: actor, Data: payload})
}
