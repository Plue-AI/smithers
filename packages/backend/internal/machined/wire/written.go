package wire

import "encoding/hex"

// FileWritten is a transient invalidation, never a durable change entry.
type FileWritten struct {
	Path       string
	Actor      Actor
	PostDigest string
}

func DecodeFileWritten(payload []byte) (FileWritten, error) {
	c := cursor{payload}
	if err := c.value("hint"); err != nil {
		return FileWritten{}, err
	}
	if len(c.b) != 0 {
		return FileWritten{}, TrailingBytes
	}
	if payload[0] != 1 {
		return FileWritten{}, UnknownMessage
	}
	f := fields(payload[1:], "written")
	digest := "absent"
	if len(f[3]) != 0 {
		digest = hex.EncodeToString(f[3])
	}
	return FileWritten{Path: textValue(f[1]), Actor: decodeActor(f[2]), PostDigest: digest}, nil
}
