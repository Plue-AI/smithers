package live

import (
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
		if got := (DocRelay{}).Subscribe(topic); got != "unknown_topic" {
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

// Component evidence only; composed-route proofs must not be claimed before
// the real live handler, authorization middleware and daemon codec land.
func TestDocumentAdmissionDark(t *testing.T) {
	for _, topic := range []string{"doc:code:b:a", "doc:wiki:page", "doc:code:b:$(touch marker);echo text"} {
		if got := (DocRelay{}).Subscribe(topic); got != "unsupported" {
			t.Fatal(got)
		}
	}
}
