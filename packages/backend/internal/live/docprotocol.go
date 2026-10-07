package live

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"github.com/smithersai/smithers/packages/backend/internal/livedocument"
	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
)

func stampDocumentAwareness(raw []byte, clientID uint32, actor []byte, doc *livedocument.Document) ([]byte, error) {
	if len(raw) > 64<<10 {
		return nil, wire.ErrDocumentPayload
	}
	read := func() (uint64, error) {
		v, n := binary.Uvarint(raw)
		if n <= 0 {
			return 0, wire.ErrDocumentPayload
		}
		raw = raw[n:]
		return v, nil
	}
	count, e := read()
	if e != nil || count != 1 {
		return nil, wire.ErrDocumentPayload
	}
	client, e := read()
	if e != nil || client != uint64(clientID) {
		return nil, wire.ErrDocumentPayload
	}
	clock, e := read()
	if e != nil {
		return nil, e
	}
	size, e := read()
	if e != nil || size != uint64(len(raw)) {
		return nil, wire.ErrDocumentPayload
	}
	var state map[string]json.RawMessage
	if e = json.Unmarshal(raw, &state); e != nil {
		return nil, e
	}
	if state != nil {
		allowed := make(map[string]json.RawMessage)
		for _, key := range []string{"line", "anchor", "head", "cursor"} {
			if v, ok := state[key]; ok {
				allowed[key] = v
			}
		}
		allowed["actor"], _ = json.Marshal(map[string]string{"id": hex.EncodeToString(actor), "kind": "person", "via": "app"})
		colour := sha256.Sum256(actor)
		allowed["colour"], _ = json.Marshal(fmt.Sprintf("#%02x%02x%02x", colour[0], colour[1], colour[2]))
		raw, e = json.Marshal(allowed)
		if e != nil {
			return nil, e
		}
	}
	out := binary.AppendUvarint([]byte{1}, client)
	out = binary.AppendUvarint(out, clock)
	out = binary.AppendUvarint(out, uint64(len(raw)))
	out = append(out, raw...)
	return doc.Awareness(out)
}

func syncPayload(kind uint64, payload []byte) []byte {
	b := binary.AppendUvarint(nil, kind)
	b = binary.AppendUvarint(b, uint64(len(payload)))
	return append(b, payload...)
}
func parseSync(b []byte) (uint64, []byte, error) {
	kind, n := binary.Uvarint(b)
	if n <= 0 || kind > 2 {
		return 0, nil, wire.ErrDocumentPayload
	}
	b = b[n:]
	size, n := binary.Uvarint(b)
	if n <= 0 || size != uint64(len(b)-n) {
		return 0, nil, wire.ErrDocumentPayload
	}
	return kind, b[n:], nil
}
