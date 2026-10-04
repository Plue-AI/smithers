// Package live reserves document admission for the shared live-channel adapter.
// It owns no transport, wire codec, CRDT engine or working-copy access.
package live

import (
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

// DocRelay is deliberately unmounted until T-COL-02 supplies authenticated
// /api/live and T-COL-03r supplies the sole daemon codec. No boolean or fake
// provider can activate it. The former terminal socket cannot serve documents.
type DocRelay struct{}

func (DocRelay) Subscribe(topic string) string {
	if _, ok := ParseDocumentTopic(topic); !ok {
		return "unknown_topic"
	}
	return "unsupported"
}
