package wire

import (
	"encoding/binary"
	"encoding/hex"
)

// Burst is the decoded ADR 0004 event, not a second wire envelope.
type Burst struct {
	Sequence       uint64
	EventID        [16]byte
	ID             [16]byte
	Actor          Actor
	Files          []BurstFile
	VersionsCommit string
	Part           uint16
	Parts          uint16
}
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

// fields reads already validated values using the canonical schema itself.
func fields(body []byte, typ string) map[byte][]byte {
	c := cursor{body}
	n, _ := c.number(4)
	b, _ := c.take(int(n))
	c.b = b
	out := map[byte][]byte{}
	for len(c.b) > 0 {
		tag, _ := c.number(1)
		for _, f := range structures[typ] {
			if f.tag == byte(tag) {
				before := c.b
				_ = c.value(f.typ)
				out[f.tag] = before[:len(before)-len(c.b)]
				break
			}
		}
	}
	return out
}
func wireString(b []byte) string {
	if len(b) == 0 {
		return ""
	}
	return string(b[2:])
}
func wireHex(b []byte) string { return hex.EncodeToString(b) }

// BurstEvent rejects hints and other events before the host can append facts.
// Encode validates a caller-constructed Frame as strictly as received bytes.
func (f Frame) BurstEvent() (Burst, error) {
	if _, err := Encode(f); err != nil {
		return Burst{}, err
	}
	if f.Kind != Events || f.Payload[0] != 1 {
		return Burst{}, UnknownMessage
	}
	d := fields(f.Payload[1:], "durable")
	if d[3][0] != 1 {
		return Burst{}, UnknownMessage
	}
	b := fields(d[3][1:], "burst")
	out := Burst{Sequence: binary.BigEndian.Uint64(d[1]), VersionsCommit: wireHex(b[4])}
	if len(b[5]) > 0 {
		out.Part = binary.BigEndian.Uint16(b[5])
	}
	if len(b[6]) > 0 {
		out.Parts = binary.BigEndian.Uint16(b[6])
	}
	copy(out.EventID[:], d[2])
	copy(out.ID[:], b[1])
	out.Actor.Kind = b[2][0]
	a := fields(b[2][1:], unions["actor"][out.Actor.Kind])
	switch out.Actor.Kind {
	case 1:
		out.Actor.Principal = append([]byte(nil), a[1][4:]...)
	case 2:
		out.Actor.Session = binary.BigEndian.Uint32(a[1])
	case 3:
		out.Actor.Run = wireString(a[1])
	}
	c := cursor{b[3]}
	count, _ := c.number(2)
	out.Files = make([]BurstFile, 0, int(count))
	for i := uint64(0); i < count; i++ {
		before := c.b
		_ = c.value("burst_file")
		v := fields(before[:len(before)-len(c.b)], "burst_file")
		out.Files = append(out.Files, BurstFile{Path: wireString(v[1]), Change: []string{"", "added", "modified", "deleted", "renamed"}[v[2][0]], RenamedTo: wireString(v[3]), BeforeBlob: wireHex(v[4]), AfterBlob: wireHex(v[5]), PostDigest: wireHex(v[6])})
	}
	return out, nil
}

// BurstAck is sent only after the host transaction commits (or for a refusal).
func BurstAck(seq uint64, outcome byte, missing []string) (Frame, error) {
	if len(missing) > 65535 {
		return Frame{}, BadValue
	}
	args := [][]byte{Field(1, U64(seq)), Field(2, []byte{outcome})}
	if len(missing) > 0 {
		list := U16(uint16(len(missing)))
		for _, oid := range missing {
			b, e := hex.DecodeString(oid)
			if e != nil || len(b) != 20 {
				return Frame{}, BadValue
			}
			list = append(list, b...)
		}
		args = append(args, Field(3, list))
	}
	f := Frame{Kind: Events, Payload: Union(3, args...)}
	_, err := Encode(f)
	return f, err
}
