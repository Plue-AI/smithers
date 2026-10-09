package wire

import (
	"encoding/binary"
	"unicode"
)

// PresenceLocation is bound to an authenticated broker session. Participant
// identifies an external process, shared with transcript conversation records.
type PresenceLocation struct {
	Session     uint32
	Path        string
	Command     string
	Participant [16]byte
	Agent       string
}

func (f Frame) PresenceSnapshot() ([]PresenceLocation, error) {
	if f.Kind != Presence {
		return nil, BadValue
	}
	if _, err := Encode(f); err != nil {
		return nil, err
	}
	fields, err := Fields("snapshot", f.Payload[1:])
	if err != nil {
		return nil, err
	}
	b := fields[1]
	count := int(binary.BigEndian.Uint16(b))
	b = b[2:]
	locations := make([]PresenceLocation, 0, count)
	seen := make(map[uint32]bool, count)
	for i := 0; i < count; i++ {
		size := int(binary.BigEndian.Uint32(b))
		item := b[:4+size]
		fields, err := Fields("where", item)
		if err != nil {
			return nil, err
		}
		session := binary.BigEndian.Uint32(fields[1])
		if session == 0 || session > 0x7fffffff || seen[session] {
			return nil, BadValue
		}
		seen[session] = true
		location := PresenceLocation{Session: session}
		if path := fields[2]; path != nil {
			location.Path = string(path[2:])
		}
		if command := fields[3]; command != nil {
			location.Command = string(command[2:])
			if len(location.Command) == 0 || len(location.Command) > 64 {
				return nil, BadValue
			}
			for _, c := range location.Command {
				if unicode.IsControl(c) {
					return nil, BadValue
				}
			}
		}
		locations = append(locations, location)
		b = b[4+size:]
	}
	b = fields[2]
	if b == nil {
		return locations, nil
	}
	count = int(binary.BigEndian.Uint16(b))
	b = b[2:]
	if count > 64 {
		return nil, BadValue
	}
	participants := map[[16]byte]bool{}
	for i := 0; i < count; i++ {
		size := int(binary.BigEndian.Uint32(b))
		fields, err := Fields("process_where", b[:4+size])
		if err != nil {
			return nil, err
		}
		location := PresenceLocation{Session: binary.BigEndian.Uint32(fields[1])}
		copy(location.Participant[:], fields[2])
		if !seen[location.Session] || location.Participant == ([16]byte{}) || participants[location.Participant] {
			return nil, BadValue
		}
		participants[location.Participant] = true
		switch fields[3][0] {
		case 1:
			location.Agent = "codex"
		case 2:
			location.Agent = "claude-code"
		default:
			return nil, BadValue
		}
		locations = append(locations, location)
		b = b[4+size:]
	}
	return locations, nil
}
