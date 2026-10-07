// Package wire owns ADR 0004 payload encoding. Document payloads do not
// allocate streams or implement a second machine transport.
package wire

import (
	"bytes"
	"encoding/binary"
	"errors"
	"unicode/utf8"
)

const (
	DocumentInput          byte = 1
	DocumentAwarenessInput byte = 2
	DocumentSync           byte = 3
	DocumentAwareness      byte = 4
	DocumentEpoch          byte = 5
	DocumentSaved          byte = 6
	DocumentGone           byte = 7
)

// Document is the fixed-layout S3 payload, inside kind 0x04. Actor is an
// opaque host-resolved principal; only input messages carry it. Sync bytes
// are the unchanged y-protocols payload, never interpreted by the host.
type Document struct {
	Msg             byte
	Actor           []byte
	Data            []byte
	Epoch           [16]byte
	ClientID        uint32
	AtMS            uint64
	Seq, ThroughSeq uint64
	Refusal         byte
	RefusalBody     []byte
	GoneKind        byte
	GoneBy, GoneTo  string
}

var ErrDocumentPayload = errors.New("bad document payload")

// EncodeDocument preserves protocol 1 recordings.
func EncodeDocument(d Document) ([]byte, error) { return encodeDocument(d, false) }

// EncodeDocumentV2 requires a protocol 2 connection; never infer the layout from bytes.
func EncodeDocumentV2(d Document) ([]byte, error) { return encodeDocument(d, true) }

func encodeDocument(d Document, sequenced bool) ([]byte, error) {
	// A caller must not silently drop a new receipt on a legacy connection.
	if !sequenced && (d.Seq != 0 || d.ThroughSeq != 0) {
		return nil, ErrDocumentPayload
	}
	b := []byte{d.Msg}
	switch d.Msg {
	case 0xff:
		body := d.RefusalBody
		if body == nil {
			body = []byte{0, 0, 0, 2, 1, d.Refusal}
		}
		if _, err := documentRefusal(body); err != nil {
			return nil, err
		}
		b = append(b, body...)
	case DocumentInput, DocumentAwarenessInput:
		if len(d.Actor) == 0 || len(d.Actor) > 1024 {
			return nil, ErrDocumentPayload
		}
		// Canonical Actor.principal union: variant, struct length, tag, bytes.
		b = append(b, Union(1, Field(1, Bytes(d.Actor)))...)
		if sequenced && d.Msg == DocumentInput {
			b = binary.BigEndian.AppendUint64(b, d.Seq)
		}
		b = append(b, d.Data...)
	case DocumentSync, DocumentAwareness:
		b = append(b, d.Data...)
	case DocumentGone:
		if d.GoneKind != 1 && d.GoneKind != 2 {
			return nil, ErrDocumentPayload
		}
		b = append(b, d.GoneKind)
		if !documentString(d.GoneBy) {
			return nil, ErrDocumentPayload
		}
		b = binary.BigEndian.AppendUint16(b, uint16(len(d.GoneBy)))
		b = append(b, d.GoneBy...)
		if d.GoneKind == 2 {
			if !documentString(d.GoneTo) || d.GoneTo == "" {
				return nil, ErrDocumentPayload
			}
			b = binary.BigEndian.AppendUint16(b, uint16(len(d.GoneTo)))
			b = append(b, d.GoneTo...)
		}
	case DocumentEpoch:
		if d.ClientID == 0 {
			return nil, ErrDocumentPayload
		}
		b = append(b, d.Epoch[:]...)
		b = binary.BigEndian.AppendUint32(b, d.ClientID)
	case DocumentSaved:
		b = binary.BigEndian.AppendUint64(b, d.AtMS)
		if sequenced {
			b = binary.BigEndian.AppendUint64(b, d.ThroughSeq)
		}
		b = append(b, d.Data...)
	default:
		return nil, ErrDocumentPayload
	}
	if len(b) > 4<<20 {
		return nil, ErrDocumentPayload
	}
	return b, nil
}

func DecodeDocument(b []byte) (Document, error) { return decodeDocument(b, false) }

// DecodeDocumentV2 decodes the explicitly selected protocol 2 layout.
func DecodeDocumentV2(b []byte) (Document, error) { return decodeDocument(b, true) }

func decodeDocument(b []byte, sequenced bool) (Document, error) {
	if len(b) == 0 || len(b) > 4<<20 {
		return Document{}, ErrDocumentPayload
	}
	d := Document{Msg: b[0]}
	p := b[1:]
	switch d.Msg {
	case 0xff:
		code, err := documentRefusal(p)
		if err != nil {
			return Document{}, err
		}
		d.Refusal = code
		d.RefusalBody = append([]byte(nil), p...)
	case DocumentInput, DocumentAwarenessInput:
		if len(p) < 10 || p[0] != 1 || p[5] != 1 {
			return Document{}, ErrDocumentPayload
		}
		n := binary.BigEndian.Uint32(p[6:10])
		if n == 0 || n > 1024 || binary.BigEndian.Uint32(p[1:5]) != n+5 || uint64(n)+10 > uint64(len(p)) {
			return Document{}, ErrDocumentPayload
		}
		d.Actor = append([]byte(nil), p[10:10+int(n)]...)
		tail := p[10+int(n):]
		if sequenced && d.Msg == DocumentInput {
			if len(tail) < 8 {
				return Document{}, ErrDocumentPayload
			}
			d.Seq = binary.BigEndian.Uint64(tail[:8])
			tail = tail[8:]
		}
		d.Data = append([]byte(nil), tail...)
	case DocumentSync, DocumentAwareness:
		d.Data = append([]byte(nil), p...)
	case DocumentGone:
		if len(p) < 1 || (p[0] != 1 && p[0] != 2) {
			return Document{}, ErrDocumentPayload
		}
		d.GoneKind = p[0]
		p = p[1:]
		var err error
		d.GoneBy, p, err = takeDocumentString(p)
		if err != nil {
			return Document{}, err
		}
		if d.GoneKind == 2 {
			d.GoneTo, p, err = takeDocumentString(p)
			if err != nil || d.GoneTo == "" {
				return Document{}, ErrDocumentPayload
			}
		}
		if len(p) != 0 {
			return Document{}, ErrDocumentPayload
		}
	case DocumentEpoch:
		if len(p) != 20 {
			return Document{}, ErrDocumentPayload
		}
		copy(d.Epoch[:], p[:16])
		d.ClientID = binary.BigEndian.Uint32(p[16:])
		if d.ClientID == 0 {
			return Document{}, ErrDocumentPayload
		}
	case DocumentSaved:
		if len(p) < 8 {
			return Document{}, ErrDocumentPayload
		}
		d.AtMS = binary.BigEndian.Uint64(p[:8])
		tail := p[8:]
		if sequenced {
			if len(tail) < 8 {
				return Document{}, ErrDocumentPayload
			}
			d.ThroughSeq = binary.BigEndian.Uint64(tail[:8])
			tail = tail[8:]
		}
		d.Data = append([]byte(nil), tail...)
	default:
		return Document{}, ErrDocumentPayload
	}
	return d, nil
}

// The reserved refused message retains the canonical ADR Error body, including
// optional digest, detail and stream fields. Unknown or reordered tags refuse.
func documentRefusal(p []byte) (byte, error) {
	if err := validate(Frame{Kind: Documents, Stream: 1, Payload: append([]byte{255}, p...)}, false); err != nil {
		return 0, err
	}
	return p[5], nil
}

func documentString(s string) bool {
	return len(s) <= 4096 && utf8.ValidString(s) && !bytes.ContainsRune([]byte(s), 0)
}
func takeDocumentString(p []byte) (string, []byte, error) {
	if len(p) < 2 {
		return "", nil, ErrDocumentPayload
	}
	n := int(binary.BigEndian.Uint16(p[:2]))
	if len(p) < 2+n {
		return "", nil, ErrDocumentPayload
	}
	v := string(p[2 : 2+n])
	if !documentString(v) {
		return "", nil, ErrDocumentPayload
	}
	return v, p[2+n:], nil
}
