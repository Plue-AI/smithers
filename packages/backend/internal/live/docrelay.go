// Package live reserves document admission for the shared live-channel adapter.
// It owns no transport, wire codec, CRDT engine or working-copy access.
package live

import (
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

// DocumentStream is a document stream on the authenticated daemon link. Close
// sends close_doc(stream); implementations must unblock Receive on cancellation.
type DocumentStream interface {
	Send(context.Context, []byte) error
	Receive(context.Context) ([]byte, error)
	Close() error
}

// DocumentRPC is supplied by the machine connection, never a host-file fallback.
// Open binds the principal to the daemon-allocated stream before returning it.
type DocumentRPC interface {
	OpenDocument(context.Context, string, []byte) (DocumentStream, error)
}

type DocumentSource struct {
	Open  func(context.Context) (DocumentStream, error)
	Actor []byte
	Ready func() error
}

// DocRelay selects only an explicitly accepted relay topology. Mirror activation
// belongs to the shared Yrs binding; absent adapters remain unsupported.
type DocRelay struct {
	Topology   string
	Authorize  func(context.Context, DocumentTopic, int64, int64) ([]byte, string)
	Connection func(context.Context, string) (*machined.Connection, DocumentRPC)
}

func (r *DocRelay) Resolve(ctx context.Context, topic string, repository, member int64) (Source, string) {
	doc, ok := ParseDocumentTopic(topic)
	if !ok {
		return Source{}, UnknownTopic
	}
	if r == nil || r.Topology != "relay" || doc.Kind != "code" || r.Authorize == nil || r.Connection == nil {
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
	ready := func() error { return connection.RequireReady(doc.Branch) }
	if err := ready(); err != nil {
		if errors.Is(err, machined.ErrNotReady) {
			return Source{}, Unsupported
		}
		return Source{}, Forbidden
	}
	actor = append([]byte(nil), actor...)
	return Source{Key: topic, Document: &DocumentSource{Actor: actor, Ready: ready, Open: func(ctx context.Context) (DocumentStream, error) {
		if err := ready(); err != nil {
			return nil, err
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
