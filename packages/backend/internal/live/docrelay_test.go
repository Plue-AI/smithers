package live

import (
	"bytes"
	"context"
	"github.com/smithersai/smithers/packages/backend/internal/livedocument"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"strings"
	"testing"
)

func TestDocumentTopic(t *testing.T) {
	for _, topic := range []string{"doc:code:branch:src/main.go", "doc:code:b:a:b", "doc:wiki:page"} {
		doc, ok := ParseDocumentTopic(topic)
		if !ok || doc.Kind == "" {
			t.Fatalf("valid topic refused: %q", topic)
		}
	}
	for _, topic := range []string{"", "branch:b", "doc:wiki:", "doc:wiki:p:q", "doc:wiki:p/q", "doc:wiki:p\x00", "doc:code::a", "doc:code:b:", "doc:code:b:/a", "doc:code:b:a//b", "doc:code:b:../a", "doc:code:b:a/./b", "doc:code:b:a\\b", "doc:code:b:a\x00", "doc:code:b:\xff", "doc:code:b:" + strings.Repeat("a", 4097)} {
		if _, ok := ParseDocumentTopic(topic); ok {
			t.Fatalf("invalid topic admitted: %q", topic)
		}
		if _, got := (&DocRelay{}).Resolve(context.Background(), topic, 1, 1); got != "unknown_topic" {
			t.Fatal(got)
		}
	}
	doc, ok := ParseDocumentTopic("doc:code:b:" + strings.Repeat("a", 4096))
	if !ok || doc.Branch != "b" || len(doc.Path) != 4096 {
		t.Fatal("path boundary")
	}
	doc, _ = ParseDocumentTopic("doc:wiki:page")
	if doc.Page != "page" || doc.Branch != "" {
		t.Fatal(doc)
	}
}

// Missing providers refuse at admission; the composed-route tests cover the
// same resolver through authentication and the shared live socket.
func TestDocumentAdmissionDark(t *testing.T) {
	for _, topic := range []string{"doc:code:b:a", "doc:wiki:page", "doc:code:b:$(touch marker);echo text"} {
		if _, got := (&DocRelay{}).Resolve(context.Background(), topic, 1, 1); got != "unsupported" {
			t.Fatal(got)
		}
	}
}

func TestDocumentPayloadDirections(t *testing.T) {
	for _, kind := range []byte{1, 2} {
		b, err := documentInput(kind, []byte("Be"), []byte{0, 1, 0})
		if err != nil {
			t.Fatal(err)
		}
		want := []byte{kind, 1, 0, 0, 0, 7, 1, 0, 0, 0, 2, 66, 101, 0, 1, 0}
		if !bytes.Equal(b, want) {
			t.Fatalf("%x != %x", b, want)
		}
	}
	_, err := documentInput(1, nil, nil)
	if err == nil {
		t.Fatal("missing principal accepted")
	}
}
func TestDocumentAdmissionProviders(t *testing.T) {
	var relay *DocRelay
	for _, topic := range []string{"doc:wiki:page", "doc:code:b:a"} {
		_, code := relay.Resolve(context.Background(), topic, 1, 1)
		if code != Unsupported {
			t.Fatal(code)
		}
	}
	_, code := relay.Resolve(context.Background(), "doc:bad", 1, 1)
	if code != UnknownTopic {
		t.Fatal(code)
	}
	auth := func(context.Context, DocumentTopic, int64, int64) ([]byte, string) { return []byte("Be"), "" }
	connection := func(context.Context, string) (*machined.Connection, DocumentRPC) { return nil, nil }
	for _, tc := range []struct {
		r    DocRelay
		want string
	}{
		{DocRelay{Host: &CodeDocuments{}, Authorize: auth, Connection: connection}, Unsupported},
		{DocRelay{Host: &CodeDocuments{Library: &livedocument.Library{}}, Connection: connection}, Unsupported},
		{DocRelay{Host: &CodeDocuments{Library: &livedocument.Library{}}, Authorize: auth}, Unsupported},
		{DocRelay{Host: &CodeDocuments{Library: &livedocument.Library{}}, Authorize: auth, Connection: connection}, Unsupported},
		{DocRelay{Host: &CodeDocuments{Library: &livedocument.Library{}}, Authorize: func(context.Context, DocumentTopic, int64, int64) ([]byte, string) { return nil, Forbidden }, Connection: connection}, Forbidden},
		{DocRelay{Host: &CodeDocuments{Library: &livedocument.Library{}}, Authorize: func(context.Context, DocumentTopic, int64, int64) ([]byte, string) { return nil, "" }, Connection: connection}, Forbidden},
		{DocRelay{Host: &CodeDocuments{Library: &livedocument.Library{}}, Authorize: func(context.Context, DocumentTopic, int64, int64) ([]byte, string) { return make([]byte, 1025), "" }, Connection: connection}, Forbidden},
	} {
		_, code := tc.r.Resolve(context.Background(), "doc:code:b:a", 1, 1)
		if code != tc.want {
			t.Fatalf("%s != %s", code, tc.want)
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	r := DocRelay{Host: &CodeDocuments{Library: &livedocument.Library{}}, Authorize: auth, Connection: connection}
	_, code = r.Resolve(ctx, "doc:code:b:a", 1, 1)
	if code != Forbidden {
		t.Fatal(code)
	}
}
