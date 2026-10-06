// Package wire is the stdlib-only ADR 0004 codec shared by all daemon clients.
// Payloads are canonical tagged binary values, never JSON on the connection.
package wire

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/binary"
	"fmt"
	"io"
	"strings"
	"unicode/utf8"
)

const Protocol = 1
const MaxWorkspaceFileBytes = 1048576
const InitialCredit = 262144
const (
	Hello byte = iota
	Control
	Events
	Presence
	Documents
	Sessions
	Objects
)

type ProtocolError byte

const (
	Truncated ProtocolError = iota + 1
	FrameTooLarge
	UnknownKind
	BadStream
	UnknownMessage
	UnknownMethod
	UnknownField
	UnorderedField
	MissingField
	TrailingBytes
	BadUTF8
	BadValue
	VersionMismatch
	AuthFailed
	Superseded
	HandshakeOrder
)

func (e ProtocolError) Error() string {
	return []string{"", "truncated", "frame_too_large", "unknown_kind", "bad_stream", "unknown_message", "unknown_method", "unknown_field", "unordered_field", "missing_field", "trailing_bytes", "bad_utf8", "bad_value", "version_mismatch", "auth_failed", "superseded", "handshake_order"}[e]
}

// Frame has a validated canonical payload. Encode validates again to reject
// forged values; Decode never leaves bytes unaccounted for.
type Frame struct {
	Kind    byte
	Stream  uint32
	Payload []byte
}

func bound(kind byte, stream uint32, n uint32) error {
	limits := [...]uint32{8192, 1114112, 4194304, 65536, 4194304, 65552, 65552}
	if kind > Objects {
		return UnknownKind
	}
	if (kind < Documents) != (stream == 0) {
		return BadStream
	}
	if n > limits[kind] {
		return FrameTooLarge
	}
	return nil
}
func Read(r io.Reader) (Frame, error) {
	var h [9]byte
	if _, e := io.ReadFull(r, h[:]); e != nil {
		return Frame{}, Truncated
	}
	n := binary.BigEndian.Uint32(h[:4])
	f := Frame{Kind: h[4], Stream: binary.BigEndian.Uint32(h[5:])}
	if e := bound(f.Kind, f.Stream, n); e != nil {
		return Frame{}, e
	}
	f.Payload = make([]byte, n)
	if _, e := io.ReadFull(r, f.Payload); e != nil {
		return Frame{}, Truncated
	}
	if e := validate(f, false); e != nil {
		return Frame{}, e
	}
	return f, nil
}
func Decode(data []byte) (Frame, error) { return decode(data, false) }
func decode(data []byte, local bool) (Frame, error) {
	if len(data) < 9 {
		return Frame{}, Truncated
	}
	n := binary.BigEndian.Uint32(data)
	f := Frame{Kind: data[4], Stream: binary.BigEndian.Uint32(data[5:])}
	if e := bound(f.Kind, f.Stream, n); e != nil {
		return Frame{}, e
	}
	if uint64(len(data)-9) < uint64(n) {
		return Frame{}, Truncated
	}
	if uint64(len(data)-9) > uint64(n) {
		return Frame{}, TrailingBytes
	}
	f.Payload = append([]byte(nil), data[9:]...)
	if e := validate(f, local); e != nil {
		return Frame{}, e
	}
	return f, nil
}
func DecodeLocal(data []byte) (Frame, error) { return decode(data, true) }
func Encode(f Frame) ([]byte, error)         { return encode(f, false) }
func EncodeLocal(f Frame) ([]byte, error)    { return encode(f, true) }
func encode(f Frame, local bool) ([]byte, error) {
	if e := bound(f.Kind, f.Stream, uint32(len(f.Payload))); e != nil {
		return nil, e
	}
	if e := validate(f, local); e != nil {
		return nil, e
	}
	b := make([]byte, 9+len(f.Payload))
	binary.BigEndian.PutUint32(b, uint32(len(f.Payload)))
	b[4] = f.Kind
	binary.BigEndian.PutUint32(b[5:], f.Stream)
	copy(b[9:], f.Payload)
	return b, nil
}
func Write(w io.Writer, f Frame) error {
	b, e := Encode(f)
	if e != nil {
		return e
	}
	for len(b) > 0 {
		n, e := w.Write(b)
		if e != nil {
			return e
		}
		if n == 0 {
			return io.ErrShortWrite
		}
		b = b[n:]
	}
	return nil
}
func HostMAC(secret, boot, nonce []byte) [32]byte {
	m := hmac.New(sha256.New, secret)
	m.Write([]byte("smithers-machined/v1 host"))
	m.Write(boot)
	m.Write(nonce)
	var out [32]byte
	copy(out[:], m.Sum(nil))
	return out
}
func VerifyHostMAC(secret, boot, nonce, proof []byte) bool {
	m := HostMAC(secret, boot, nonce)
	return hmac.Equal(m[:], proof)
}

type cursor struct{ b []byte }

func (c *cursor) take(n int) ([]byte, error) {
	if n < 0 || n > len(c.b) {
		return nil, Truncated
	}
	b := c.b[:n]
	c.b = c.b[n:]
	return b, nil
}
func (c *cursor) number(n int) (uint64, error) {
	b, e := c.take(n)
	if e != nil {
		return 0, e
	}
	var v uint64
	for _, x := range b {
		v = v<<8 | uint64(x)
	}
	return v, nil
}
func (c *cursor) value(typ string) error {
	if variants, ok := unions[typ]; ok {
		v, e := c.number(1)
		if e != nil {
			return e
		}
		t, ok := variants[byte(v)]
		if !ok {
			if typ == "call" || typ == "local_call" {
				return UnknownMethod
			}
			if typ == "host_actor" {
				return BadValue
			}
			return UnknownMessage
		}
		return c.value(t)
	}
	if fields, ok := structures[typ]; ok {
		n, e := c.number(4)
		if e != nil {
			return e
		}
		body, e := c.take(int(n))
		if e != nil {
			return e
		}
		inner := cursor{body}
		var last byte
		seen := map[byte]bool{}
		for len(inner.b) > 0 {
			tag, _ := inner.number(1)
			if byte(tag) <= last {
				return UnorderedField
			}
			last = byte(tag)
			var f *field
			for i := range fields {
				if fields[i].tag == last {
					f = &fields[i]
					break
				}
			}
			if f == nil {
				return UnknownField
			}
			seen[last] = true
			if e := inner.value(f.typ); e != nil {
				return e
			}
		}
		for _, f := range fields {
			if f.required && !seen[f.tag] {
				return MissingField
			}
		}
		return nil
	}
	if strings.HasPrefix(typ, "list:") || typ == "sessions" {
		n, e := c.number(2)
		if e != nil {
			return e
		}
		t := strings.TrimPrefix(typ, "list:")
		if typ == "sessions" {
			if n > 512 {
				return BadValue
			}
			t = "u32"
		}
		for i := uint64(0); i < n; i++ {
			if e := c.value(t); e != nil {
				return e
			}
		}
		return nil
	}
	switch typ {
	case "oid":
		_, e := c.take(20)
		return e
	case "digest":
		_, e := c.take(32)
		return e
	case "id128":
		_, e := c.take(16)
		return e
	case "str", "str1024", "content", "bytes1024", "record":
		width, limit := 2, 4096
		if typ == "str1024" {
			limit = 1024
		}
		if typ == "content" || typ == "record" {
			width = 4
			limit = 1048576
		}
		if typ == "bytes1024" {
			width = 4
			limit = 1024
		}
		n, e := c.number(width)
		if e != nil {
			return e
		}
		if n > uint64(limit) {
			return BadValue
		}
		b, e := c.take(int(n))
		if e != nil {
			return e
		}
		if typ == "record" && (!utf8.Valid(b) || len(b) == 0 || bytes.ContainsAny(b, "\n\x00")) {
			return BadUTF8
		}
		if width == 2 && (!utf8.Valid(b) || strings.ContainsRune(string(b), 0)) {
			return BadUTF8
		}
		return nil
	}
	width, max, min := 1, uint64(255), uint64(0)
	switch typ {
	case "u16":
		width = 2
		max = 65535
	case "u32":
		width = 4
		max = 4294967295
	case "u64":
		width = 8
		max = ^uint64(0)
	case "magic":
		width = 4
		min = 0x534d4d44
		max = min
	case "version":
		width = 2
		min = 1
		max = SequencedDocumentProtocol
	case "state", "session_kind":
		min = 1
		max = 3
	case "change":
		min = 1
		max = 4
	case "reconcile_outcome":
		min = 1
		max = 2
	case "ack_outcome":
		min = 1
		max = 5
	case "error_code":
		min = 1
		max = 12
	case "protocol_error":
		min = 1
		max = 16
	default:
		return fmt.Errorf("unknown schema type %s", typ)
	}
	n, e := c.number(width)
	if e != nil {
		return e
	}
	if n < min || n > max {
		if typ == "version" {
			return VersionMismatch
		}
		return BadValue
	}
	return nil
}
func validate(f Frame, local bool) error {
	c := cursor{f.Payload}
	if f.Kind <= Presence {
		types := []string{"hello_message", "control", "events", "presence"}
		t := types[f.Kind]
		if local && f.Kind == Control {
			if e := c.value("local_control"); e != nil {
				return e
			}
		} else if e := c.value(t); e != nil {
			return e
		}
	} else {
		msg, e := c.number(1)
		if e != nil {
			return e
		}
		if f.Kind == Documents && msg != 255 {
			if msg == 0 {
				return BadValue
			}
			c.b = nil
			return nil
		}
		if msg == 255 {
			if e := c.value("error"); e != nil {
				return e
			}
		} else {
			if f.Kind == Objects && msg != 1 && msg != 2 && msg != 6 && msg != 7 {
				return BadValue
			}
			switch msg {
			case 1:
				fd, e := c.number(1)
				if e != nil {
					return e
				}
				if fd > 2 || (f.Kind == Objects && fd != 0) || len(c.b) > 65536 {
					return BadValue
				}
				c.b = nil
			case 2:
				fd, e := c.number(1)
				if e != nil {
					return e
				}
				if fd > 2 || (f.Kind == Objects && fd != 0) {
					return BadValue
				}
			case 3:
				if _, e := c.take(4); e != nil {
					return e
				}
			case 4:
				n, e := c.number(1)
				if e != nil {
					return e
				}
				if n < 1 || n > 7 {
					return BadValue
				}
			case 5:
				n, e := c.number(1)
				if e != nil {
					return e
				}
				if n == 0 {
					if _, e := c.take(4); e != nil {
						return e
					}
				} else if n == 1 {
					sig, e := c.number(1)
					if e != nil {
						return e
					}
					core, e := c.number(1)
					if e != nil {
						return e
					}
					if sig < 1 || sig > 7 || core > 1 {
						return BadValue
					}
				} else {
					return BadValue
				}
			case 6:
				n, e := c.number(4)
				if e != nil {
					return e
				}
				if n == 0 || n > 262144 {
					return BadValue
				}
			case 7:
			default:
				return UnknownMessage
			}
		}
	}
	if len(c.b) != 0 {
		return TrailingBytes
	}
	return nil
}

// Builders encode ADR primitives; all complete frames still pass schema validation.
func U16(v uint16) []byte                 { b := make([]byte, 2); binary.BigEndian.PutUint16(b, v); return b }
func U32(v uint32) []byte                 { b := make([]byte, 4); binary.BigEndian.PutUint32(b, v); return b }
func U64(v uint64) []byte                 { b := make([]byte, 8); binary.BigEndian.PutUint64(b, v); return b }
func Bytes(b []byte) []byte               { return append(U32(uint32(len(b))), b...) }
func String(s string) []byte              { return append(U16(uint16(len(s))), []byte(s)...) }
func Field(tag byte, value []byte) []byte { return append([]byte{tag}, value...) }
func Struct(fields ...[]byte) []byte {
	var b []byte
	for _, f := range fields {
		b = append(b, f...)
	}
	return Bytes(b)
}
func Union(variant byte, fields ...[]byte) []byte {
	return append([]byte{variant}, Struct(fields...)...)
}

// Request identifies a decoded host call without another framing implementation.
func (f Frame) Request() (id uint32, method byte, args []byte, err error) {
	if f.Kind != Control || len(f.Payload) < 16 || f.Payload[0] != 1 {
		return 0, 0, nil, BadValue
	}
	return binary.BigEndian.Uint32(f.Payload[6:10]), f.Payload[11], f.Payload[12:], nil
}
func Unsupported(id uint32) Frame {
	return Frame{Kind: Control, Payload: Union(2, Field(1, U32(id)), Field(2, Union(255, Field(1, []byte{2}))))}
}
