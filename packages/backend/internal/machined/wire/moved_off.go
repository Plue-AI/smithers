package wire

import (
	"encoding/binary"
	"encoding/hex"
)

// MovedOffEvent names the item observed by the authenticated daemon. The host must
// check that item against the connection's branch; Actor is attribution only.
type MovedOffEvent struct {
	Actor         Actor
	Item          uint64
	PreMoveCommit string
	Returned      bool
}

func DecodeMovedOff(payload []byte) (MovedOffEvent, error) {
	c := cursor{payload}
	if err := c.value("event"); err != nil {
		return MovedOffEvent{}, err
	}
	if len(c.b) != 0 {
		return MovedOffEvent{}, TrailingBytes
	}
	if payload[0] != 4 {
		return MovedOffEvent{}, UnknownMessage
	}
	f := fields(payload[1:], "moved_off")
	m := MovedOffEvent{Actor: decodeActor(f[1]), Item: binary.BigEndian.Uint64(f[2]), PreMoveCommit: hex.EncodeToString(f[3])}
	if returned := f[4]; len(returned) != 0 {
		m.Returned = returned[0] == 1
	}
	if m.Item == 0 {
		return MovedOffEvent{}, BadValue
	}
	return m, nil
}

func decodeActor(payload []byte) Actor {
	a := Actor{Kind: payload[0]}
	switch a.Kind {
	case 1:
		value := fields(payload[1:], "principal")[1]
		a.Principal = append([]byte(nil), value[4:]...)
	case 2:
		a.Session = binary.BigEndian.Uint32(fields(payload[1:], "session_actor")[1])
	case 3:
		a.Run = textValue(fields(payload[1:], "run_actor")[1])
	}
	return a
}
