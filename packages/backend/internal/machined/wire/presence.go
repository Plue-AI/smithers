package wire

import "encoding/binary"

// PresenceLocation carries no identity: the host resolves each broker session.
type PresenceLocation struct {
	Session uint32
	Path    string
}

// PresenceSnapshot decodes the existing ADR 0004 kind-3 snapshot. Validation
// happens before indexing; no alternate JSON protocol or branch id is accepted.
func (f Frame) PresenceSnapshot() ([]PresenceLocation, error) {
	if f.Kind != Presence {
		return nil, BadValue
	}
	if _, err := Encode(f); err != nil {
		return nil, err
	}
	b := f.Payload
	count := int(binary.BigEndian.Uint16(b[6:8]))
	if count > 512 {
		return nil, BadValue
	}
	b = b[8:]
	locations := make([]PresenceLocation, 0, count)
	seen := make(map[uint32]bool, count)
	for i := 0; i < count; i++ {
		size := int(binary.BigEndian.Uint32(b[:4]))
		item := b[4 : 4+size]
		session := binary.BigEndian.Uint32(item[1:5])
		if session == 0 || session > 0x7fffffff || seen[session] {
			return nil, BadValue
		}
		seen[session] = true
		location := PresenceLocation{Session: session}
		if len(item) > 5 {
			length := int(binary.BigEndian.Uint16(item[6:8]))
			location.Path = string(item[8 : 8+length])
		}
		locations = append(locations, location)
		b = b[4+size:]
	}
	return locations, nil
}
