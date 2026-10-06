package wire

import (
	"encoding/binary"
	"strings"
)

// Value exposes a validated ADR value. Variant belongs to a union, Fields to
// a struct, Items to a list, Data to byte/string values, and Number to integers.
// Parsing uses the same schema and validation as Read, never a client codec.
type Value struct {
	Variant byte
	Fields  map[byte]Value
	Items   []Value
	Data    []byte
	Number  uint64
}

// Message decodes tagged singleton payloads. Stream bodies remain fixed-layout
// frames and are handled by their stream consumers.
func (f Frame) Message() (Value, error) {
	if f.Kind > Presence {
		return Value{}, BadValue
	}
	if err := validate(f, false); err != nil {
		return Value{}, err
	}
	c := cursor{f.Payload}
	return c.decoded([]string{"hello_message", "control", "events", "presence"}[f.Kind]), nil
}

// decoded is called only after validation: all widths, lengths, tags and
// discriminants have already been checked by cursor.value.
func (c *cursor) decoded(typ string) Value {
	if variants, ok := unions[typ]; ok {
		variant, _ := c.number(1)
		v := c.decoded(variants[byte(variant)])
		v.Variant = byte(variant)
		return v
	}
	if fields, ok := structures[typ]; ok {
		n, _ := c.number(4)
		body, _ := c.take(int(n))
		inner := cursor{body}
		v := Value{Fields: make(map[byte]Value)}
		for len(inner.b) > 0 {
			tag, _ := inner.number(1)
			for _, f := range fields {
				if f.tag == byte(tag) {
					v.Fields[f.tag] = inner.decoded(f.typ)
					break
				}
			}
		}
		return v
	}
	if strings.HasPrefix(typ, "list:") || typ == "sessions" {
		n, _ := c.number(2)
		itemType := strings.TrimPrefix(typ, "list:")
		if typ == "sessions" {
			itemType = "u32"
		}
		v := Value{Items: make([]Value, int(n))}
		for i := range v.Items {
			v.Items[i] = c.decoded(itemType)
		}
		return v
	}
	// Let the validator consume the primitive, preserving its single width and
	// length contract. The validated span then supplies its semantic value.
	before := c.b
	_ = c.value(typ)
	span := before[:len(before)-len(c.b)]
	switch typ {
	case "oid", "digest", "id128":
		return Value{Data: append([]byte(nil), span...)}
	case "str", "str1024":
		return Value{Data: append([]byte(nil), span[2:]...)}
	case "content", "bytes1024":
		return Value{Data: append([]byte(nil), span[4:]...)}
	default:
		var padded [8]byte
		copy(padded[8-len(span):], span)
		return Value{Number: binary.BigEndian.Uint64(padded[:])}
	}
}
