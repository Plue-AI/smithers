package measure

import (
	"encoding/binary"
	"fmt"
	"io"
)

// MaxFrame bounds the payload before allocation or any write.
const MaxFrame = 1 << 20

// WriteFrame writes a four-byte big-endian length followed by a nonempty payload.
func WriteFrame(w io.Writer, payload []byte) error {
	if len(payload) == 0 || len(payload) > MaxFrame {
		return fmt.Errorf("invalid frame length: %d", len(payload))
	}
	frame := make([]byte, 4+len(payload))
	binary.BigEndian.PutUint32(frame[:4], uint32(len(payload)))
	copy(frame[4:], payload)
	return writeAll(w, frame)
}

func writeAll(w io.Writer, p []byte) error {
	for len(p) > 0 {
		n, err := w.Write(p)
		if err != nil {
			return err
		}
		if n <= 0 || n > len(p) {
			return io.ErrShortWrite
		}
		p = p[n:]
	}
	return nil
}

// ReadFrame rejects invalid lengths before allocating the payload. EOF and
// truncation errors retain their io package identities for stream callers.
func ReadFrame(r io.Reader) ([]byte, error) {
	var prefix [4]byte
	if _, err := io.ReadFull(r, prefix[:]); err != nil {
		return nil, err
	}
	n := binary.BigEndian.Uint32(prefix[:])
	if n == 0 || n > MaxFrame {
		return nil, fmt.Errorf("invalid frame length: %d", n)
	}
	payload := make([]byte, int(n))
	if _, err := io.ReadFull(r, payload); err != nil {
		return nil, err
	}
	return payload, nil
}
