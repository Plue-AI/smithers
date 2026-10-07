package wire

import "encoding/hex"

// Captured is the validated ADR 0004 capture event. Base is the host head the
// daemon reconciled against, not a head chosen by the guest for publication.
type Captured struct {
	Head, Tree, Base string
}

func DecodeCaptured(payload []byte) (Captured, error) {
	c := cursor{payload}
	if err := c.value("event"); err != nil {
		return Captured{}, err
	}
	if len(c.b) != 0 {
		return Captured{}, TrailingBytes
	}
	if payload[0] != 2 {
		return Captured{}, UnknownMessage
	}
	f := fields(payload[1:], "captured")
	return Captured{hex.EncodeToString(f[1]), hex.EncodeToString(f[2]), hex.EncodeToString(f[3])}, nil
}
