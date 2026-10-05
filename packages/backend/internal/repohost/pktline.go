package repohost

import (
	"bytes"
	"fmt"
	"io"
	"strings"
)

const (
	// maxCommandSectionPeekBytes caps how much of a receive-pack stream
	// PeekReceivePackCommands will tee into memory before failing closed.
	// Every consumed byte is buffered for replay, so without a ceiling a
	// client could stream endless keepalive/command packets and exhaust
	// memory before the request ever reaches git. 16 MiB is roughly 80k ref
	// updates — far beyond any legitimate push.
	maxCommandSectionPeekBytes = 16 * 1024 * 1024
	// maxUpdatePeekBytes caps the best-effort metadata peek in
	// PeekReceivePackUpdate. The first ref-update command sits within the
	// first few hundred bytes of a well-formed stream; anything that makes us
	// buffer more than this (e.g. an endless run of flush packets) is not
	// going to yield metadata, so we give up and forward the stream to git
	// unchanged.
	maxUpdatePeekBytes = 64 * 1024
)

// ReceivePackUpdate holds the ref and new commit OID extracted from a
// git receive-pack pkt-line header.
type ReceivePackUpdate struct {
	RefName string
	NewOID  string
}

// ReceivePackCommand is one ref-update command from a git receive-pack
// request ("<old-oid> <new-oid> <ref-name>").
type ReceivePackCommand struct {
	OldOID  string
	NewOID  string
	RefName string
}

// ReceivePackRequest is the command section of a receive-pack request.
// Shallow contains the client's shallow boundary OIDs, in wire order.
type ReceivePackRequest struct {
	Commands []ReceivePackCommand
	Shallow  []string
}

// PeekReceivePackCommands reads the full command list (every pkt-line up to
// the flush packet that terminates the command section) from a receive-pack
// request stream. It returns the parsed commands plus a reader that
// reproduces the original bytes verbatim, so the request can still be
// forwarded to git unchanged. Unlike the best-effort peek helpers below it
// returns an error on malformed pkt-lines or command lines, and on a command
// whose ref ValidateRefName refuses: callers enforcing policy on the commands
// must fail closed.
func PeekReceivePackCommands(r io.Reader) ([]ReceivePackCommand, io.Reader, error) {
	request, rebuilt, err := PeekReceivePackRequest(r)
	return request.Commands, rebuilt, err
}

// PeekReceivePackRequest also collects shallow boundaries. Like
// PeekReceivePackCommands, it replays every consumed byte unchanged.
func PeekReceivePackRequest(r io.Reader) (ReceivePackRequest, io.Reader, error) {
	var buf bytes.Buffer
	tr := io.TeeReader(r, &buf)

	pktLenBuf := make([]byte, 4)
	var request ReceivePackRequest

	for {
		if buf.Len() > maxCommandSectionPeekBytes {
			return ReceivePackRequest{}, io.MultiReader(&buf, r), fmt.Errorf("receive-pack command section exceeds %d bytes", maxCommandSectionPeekBytes)
		}
		if _, err := io.ReadFull(tr, pktLenBuf); err != nil {
			if err == io.EOF || err == io.ErrUnexpectedEOF {
				// Truncated command section. git receive-pack will reject the
				// same truncated stream, so no unseen command can execute.
				return request, io.MultiReader(&buf, r), nil
			}
			return ReceivePackRequest{}, io.MultiReader(&buf, r), fmt.Errorf("read pkt-line length: %w", err)
		}

		pktLen, ok := parsePktLen(pktLenBuf)
		if !ok {
			return ReceivePackRequest{}, io.MultiReader(&buf, r), fmt.Errorf("invalid pkt-line hex: %q", pktLenBuf)
		}

		if pktLen == 0 {
			// Flush packet terminates the command section.
			return request, io.MultiReader(&buf, r), nil
		}

		payloadLen := pktLen - 4
		if payloadLen <= 0 {
			continue
		}

		payload := make([]byte, payloadLen)
		if _, err := io.ReadFull(tr, payload); err != nil {
			return ReceivePackRequest{}, io.MultiReader(&buf, r), fmt.Errorf("read pkt-line payload: %w", err)
		}

		// send-pack sends shallow boundaries before commands; receive-pack
		// also accepts them interspersed with commands before the flush.
		if oid, ok := strings.CutPrefix(strings.TrimSuffix(string(payload), "\n"), "shallow "); ok {
			if !validShallowOID(oid) {
				return ReceivePackRequest{}, io.MultiReader(&buf, r), fmt.Errorf("malformed receive-pack shallow line: %q", payload)
			}
			request.Shallow = append(request.Shallow, oid)
			continue
		}

		// Payload format: "<oldOID> <newOID> <refName>\x00[capabilities]"
		line := string(payload)
		if nullIdx := strings.IndexByte(line, '\x00'); nullIdx != -1 {
			line = line[:nullIdx]
		}
		line = strings.TrimSuffix(line, "\n")

		parts := strings.SplitN(line, " ", 3)
		if len(parts) != 3 || parts[0] == "" || parts[1] == "" || parts[2] == "" {
			return ReceivePackRequest{}, io.MultiReader(&buf, r), fmt.Errorf("malformed receive-pack command: %q", line)
		}
		// Every door and the engine read commands here, so a name git would
		// resolve through HEAD never reaches git or a rollback (ValidateRefName).
		if err := ValidateRefName(parts[2]); err != nil {
			return ReceivePackRequest{}, io.MultiReader(&buf, r), fmt.Errorf("malformed receive-pack command: %w", err)
		}
		request.Commands = append(request.Commands, ReceivePackCommand{
			OldOID:  parts[0],
			NewOID:  parts[1],
			RefName: parts[2],
		})
	}
}

func validShallowOID(oid string) bool {
	// Support both SHA-1 and SHA-256 repositories. Git checks which object
	// format the repository actually uses when it receives the replay.
	if len(oid) != 40 && len(oid) != 64 {
		return false
	}
	for _, c := range oid {
		if (c < '0' || c > '9') && (c < 'a' || c > 'f') && (c < 'A' || c > 'F') {
			return false
		}
	}
	return true
}

// PeekReceivePackUpdate reads the minimum bytes from r needed to extract the
// first ref update (ref name + new OID) from a receive-pack pkt-line stream.
// It always returns a reconstructed io.Reader that will reproduce the original
// bytes verbatim, so callers can forward the full packfile to git unchanged.
func PeekReceivePackUpdate(r io.Reader) (ReceivePackUpdate, io.Reader, error) {
	var buf bytes.Buffer
	tr := io.TeeReader(r, &buf)

	pktLenBuf := make([]byte, 4)

	for {
		if buf.Len() > maxUpdatePeekBytes {
			// Best-effort peek: give up rather than buffering an unbounded
			// prefix (e.g. endless flush packets) and forward the stream
			// unchanged — git enforces its own protocol limits.
			return ReceivePackUpdate{}, io.MultiReader(&buf, r), nil
		}
		if _, err := io.ReadFull(tr, pktLenBuf); err != nil {
			// EOF or partial read – nothing useful to parse.
			return ReceivePackUpdate{}, io.MultiReader(&buf, r), nil
		}

		pktLen, valid := parsePktLen(pktLenBuf)
		if !valid {
			// Not a valid pkt-line; preserve stream and return empty.
			return ReceivePackUpdate{}, io.MultiReader(&buf, r), fmt.Errorf("invalid pkt-line hex: %q", pktLenBuf)
		}

		if pktLen == 0 {
			continue // flush packet – skip
		}

		payloadLen := pktLen - 4
		if payloadLen <= 0 {
			continue
		}

		payload := make([]byte, payloadLen)
		if _, err := io.ReadFull(tr, payload); err != nil {
			return ReceivePackUpdate{}, io.MultiReader(&buf, r), fmt.Errorf("read pkt-line payload: %w", err)
		}
		if oid, ok := strings.CutPrefix(strings.TrimSuffix(string(payload), "\n"), "shallow "); ok && validShallowOID(oid) {
			continue
		}

		// Payload format: "<oldOID> <newOID> <refName>\x00[capabilities]"
		line := string(payload)
		if nullIdx := strings.IndexByte(line, '\x00'); nullIdx != -1 {
			line = line[:nullIdx]
		}
		line = strings.TrimSpace(line)

		parts := strings.Split(line, " ")
		if len(parts) >= 3 {
			return ReceivePackUpdate{
				RefName: parts[2],
				NewOID:  parts[1],
			}, io.MultiReader(&buf, r), nil
		}

		// Non-flush packet but doesn't match expected format.
		return ReceivePackUpdate{}, io.MultiReader(&buf, r), nil
	}
}

// parsePktLen decodes a 4-byte pkt-line length. It accepts upper- and
// lower-case hex like git's hexval: a stream git applies must parse here too,
// or the policy peek would forward it unchecked.
func parsePktLen(hex []byte) (int, bool) {
	n := 0
	for _, b := range hex {
		n <<= 4
		switch {
		case b >= '0' && b <= '9':
			n |= int(b - '0')
		case b >= 'a' && b <= 'f':
			n |= int(b-'a') + 10
		case b >= 'A' && b <= 'F':
			n |= int(b-'A') + 10
		default:
			return 0, false
		}
	}
	return n, true
}
