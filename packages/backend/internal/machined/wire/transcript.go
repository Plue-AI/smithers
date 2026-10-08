package wire

import (
	"encoding/binary"
	"strings"
)

// Transcript is data from one registry-bound process lifetime. No path, home,
// UID or executable crosses this event. Profile names the pinned host adapter.
// End includes the newline omitted from Record. Source survives reconnects;
// Generation changes only when that identified source is replaced/truncated.
type Transcript struct {
	Version                uint16
	Session                uint32
	Participant, Source    [16]byte
	Profile                string
	Generation, Start, End uint64
	Record                 string
	Skipped                *uint64
}

func (t Transcript) valid() bool {
	span := t.End > t.Start && t.End-t.Start-1 == uint64(len(t.Record))
	if t.Skipped != nil {
		span = t.End > t.Start && t.End-t.Start-1 == *t.Skipped && *t.Skipped >= 1024*1024 && len(t.Record) <= 1024 && !strings.HasPrefix(strings.TrimLeft(t.Record, " \t\r"), "{") && !strings.HasPrefix(strings.TrimLeft(t.Record, " \t\r"), "[")
	}
	return span && t.Version == 1 && t.Session > 0 && t.Session <= 0x7fffffff && t.Participant != ([16]byte{}) && t.Source != ([16]byte{}) && t.Profile != "" && t.Generation > 0
}

func EncodeTranscript(t Transcript) ([]byte, error) {
	if !t.valid() {
		return nil, BadValue
	}
	p := Union(5, Field(1, U16(t.Version)), Field(2, U32(t.Session)), Field(3, t.Participant[:]), Field(4, t.Source[:]), Field(5, String(t.Profile)), Field(6, U64(t.Generation)), Field(7, U64(t.Start)), Field(8, U64(t.End)), Field(9, Bytes([]byte(t.Record))))
	if t.Skipped != nil {
		p = append(p, Field(10, U64(*t.Skipped))...)
		binary.BigEndian.PutUint32(p[1:5], uint32(len(p)-5))
	}
	c := cursor{p}
	if err := c.value("event"); err != nil {
		return nil, err
	}
	return p, nil
}

func DecodeTranscript(p []byte) (Transcript, error) {
	c := cursor{p}
	if err := c.value("event"); err != nil {
		return Transcript{}, err
	}
	if len(c.b) != 0 {
		return Transcript{}, TrailingBytes
	}
	if p[0] != 5 {
		return Transcript{}, UnknownMessage
	}
	t := transcriptOf(p[5:])
	if !t.valid() {
		return Transcript{}, BadValue
	}
	return t, nil
}

// transcriptOf projects a transcript struct body (after its u32 length) whose
// tags and types the schema has already accepted.
func transcriptOf(body []byte) Transcript {
	c := cursor{body}
	f := map[byte][]byte{}
	for len(c.b) > 0 {
		tag, _ := c.number(1)
		before := c.b
		for _, x := range structures["transcript"] {
			if x.tag == byte(tag) {
				_ = c.value(x.typ)
			}
		}
		f[byte(tag)] = before[:len(before)-len(c.b)]
	}
	t := Transcript{Version: binary.BigEndian.Uint16(f[1]), Session: binary.BigEndian.Uint32(f[2]), Profile: textValue(f[5]), Generation: binary.BigEndian.Uint64(f[6]), Start: binary.BigEndian.Uint64(f[7]), End: binary.BigEndian.Uint64(f[8]), Record: string(f[9][4:])}
	if f[10] != nil {
		n := binary.BigEndian.Uint64(f[10])
		t.Skipped = &n
	}
	copy(t.Participant[:], f[3])
	copy(t.Source[:], f[4])
	return t
}
