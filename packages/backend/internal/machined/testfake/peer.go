// Package testfake supplies a data-only, scripted ADR 0004 peer for component
// tests. It has no install registration, filesystem model or command execution.
package testfake

import (
	"bytes"
	"errors"
	"fmt"
	"io"

	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
)

var ErrUnscripted = errors.New("machined fake: unscripted frame")

// Step is one ordered exchange. Receive reads from the host; otherwise the
// peer sends Frame. A lost acknowledgement is modeled by omitting its receive
// step and ending the connection; a fresh Serve script models reconnect.
type Step struct {
	Receive bool
	Frame   wire.Frame
}

// Serve validates and snapshots the entire script before touching the stream.
// The caller owns the stream and must close it when Serve returns. Each call
// has independent state, allowing tests to script replacement connections.
// After the script ends, any additional host frame is refused rather than
// receiving an invented successful response.
func Serve(stream io.ReadWriter, script []Step) error {
	frames := make([][]byte, len(script))
	for i, step := range script {
		b, err := wire.Encode(step.Frame)
		if err != nil {
			return fmt.Errorf("script step %d: %w", i, err)
		}
		frames[i] = b
	}
	for i, step := range script {
		if step.Receive {
			got, err := wire.Read(stream)
			if err != nil {
				return fmt.Errorf("receive step %d: %w", i, err)
			}
			b, err := wire.Encode(got)
			if err != nil {
				return err
			}
			if !bytes.Equal(b, frames[i]) {
				return fmt.Errorf("step %d: %w", i, ErrUnscripted)
			}
		} else {
			f, err := wire.Decode(frames[i])
			if err != nil {
				return err
			}
			if err := wire.Write(stream, f); err != nil {
				return fmt.Errorf("send step %d: %w", i, err)
			}
		}
	}
	// Read distinguishes a clean host half-close from an extra request. wire.Read
	// maps EOF to Truncated, so peek without adding another frame decoder.
	var first [1]byte
	n, err := stream.Read(first[:])
	if n != 0 {
		return ErrUnscripted
	}
	if err == io.EOF {
		return nil
	}
	if err != nil {
		return err
	}
	return io.ErrNoProgress
}
