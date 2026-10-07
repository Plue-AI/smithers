package wire

import (
	"encoding/binary"
	"encoding/hex"
)

// Actor is an attribution reference, never an authorization credential.
type Actor struct {
	Kind      byte
	Principal []byte
	Session   uint32
	Run       string
}

type BurstFile struct {
	Path       string `json:"path"`
	Change     string `json:"change"`
	RenamedTo  string `json:"renamed_to,omitempty"`
	BeforeBlob string `json:"before_blob,omitempty"`
	AfterBlob  string `json:"after_blob,omitempty"`
	PostDigest string `json:"post_digest,omitempty"`
}

type Burst struct {
	ID          [16]byte
	Actor       Actor
	Files       []BurstFile
	Versions    string
	Part, Parts uint16
}

// DurableEvent projects the validated event envelope consumed by the host pump.
type DurableEvent struct {
	Seq     uint64
	ID      [16]byte
	Payload []byte
}

func DecodeDurableEvent(frame Frame) (DurableEvent, error) {
	if frame.Kind != Events || frame.Stream != 0 {
		return DurableEvent{}, BadValue
	}
	if err := validate(frame, false); err != nil {
		return DurableEvent{}, err
	}
	if frame.Payload[0] != 1 {
		return DurableEvent{}, UnknownMessage
	}
	f := fields(frame.Payload[1:], "durable")
	e := DurableEvent{Seq: binary.BigEndian.Uint64(f[1]), Payload: append([]byte(nil), f[3]...)}
	copy(e.ID[:], f[2])
	return e, nil
}

// fields projects values through the shared schema/field reader. Callers have
// already validated the enclosing union before projecting its fields.
func fields(body []byte, name string) map[byte][]byte {
	result, _ := Fields(name, body)
	return result
}

func textValue(b []byte) string {
	if len(b) == 0 {
		return ""
	}
	return string(b[2:])
}

// DecodeBurst consumes the Event union carried by Client.Events. The shared
// schema validates every byte before projection, including trailing bytes.
func DecodeBurst(payload []byte) (Burst, error) {
	c := cursor{payload}
	if err := c.value("event"); err != nil {
		return Burst{}, err
	}
	if len(c.b) != 0 {
		return Burst{}, TrailingBytes
	}
	if payload[0] != 1 {
		return Burst{}, UnknownMessage
	}
	f := fields(payload[1:], "burst")
	b := Burst{Versions: hex.EncodeToString(f[4])}
	copy(b.ID[:], f[1])
	b.Actor = decodeActor(f[2])
	list := cursor{f[3]}
	n, _ := list.number(2)
	for i := uint64(0); i < n; i++ {
		start := list.b
		_ = list.value("burst_file")
		v := fields(start[:len(start)-len(list.b)], "burst_file")
		b.Files = append(b.Files, BurstFile{Path: textValue(v[1]), Change: []string{"", "added", "modified", "deleted", "renamed"}[v[2][0]], RenamedTo: textValue(v[3]), BeforeBlob: hex.EncodeToString(v[4]), AfterBlob: hex.EncodeToString(v[5]), PostDigest: hex.EncodeToString(v[6])})
	}
	if f[5] != nil {
		b.Part = binary.BigEndian.Uint16(f[5])
	}
	if f[6] != nil {
		b.Parts = binary.BigEndian.Uint16(f[6])
	}
	return b, nil
}

// decodeActor projects a union only after its enclosing message validates.
func decodeActor(raw []byte) Actor {
	actor := Actor{Kind: raw[0]}
	switch actor.Kind {
	case 1:
		value := fields(raw[1:], "principal")[1]
		actor.Principal = append([]byte(nil), value[4:]...)
	case 2:
		actor.Session = binary.BigEndian.Uint32(fields(raw[1:], "session_actor")[1])
	case 3:
		actor.Run = textValue(fields(raw[1:], "run_actor")[1])
	}
	return actor
}
