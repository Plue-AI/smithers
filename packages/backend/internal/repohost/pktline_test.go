package repohost

import (
	"bytes"
	"fmt"
	"io"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestPeekReceivePackCommands_Shallow(t *testing.T) {
	t.Parallel()
	const oldOID = "340ecc0ee56893ec516de12e72468ffe9a2886f0"
	const newOID = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
	for _, tc := range []struct {
		name    string
		shallow []string
		lf      string
		mixed   bool
	}{
		{name: "non-shallow"},
		{name: "one shallow root", shallow: []string{oldOID}},
		{name: "multiple shallow roots", shallow: []string{oldOID, newOID}},
		{name: "optional line feeds", shallow: []string{oldOID, newOID}, lf: "\n"},
		// Git's read_head_info accepts shallow lines between commands too.
		{name: "mixed after first command", shallow: []string{oldOID, newOID}, mixed: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var request strings.Builder
			for i, oid := range tc.shallow {
				if tc.mixed && i > 0 {
					continue
				}
				request.WriteString(pktlineCovPacket("shallow " + oid + tc.lf))
			}
			request.WriteString(pktlineCovPacket(oldOID + " " + newOID + " refs/heads/main\x00report-status side-band-64k" + tc.lf))
			if tc.mixed {
				request.WriteString(pktlineCovPacket("shallow " + tc.shallow[1]))
			}
			request.WriteString(pktlineCovPacket(newOID + " " + oldOID + " refs/heads/feature" + tc.lf))
			request.WriteString("0000PACK\x00\x00\x00\x02\xff\x00payload")
			input := request.String()

			commands, rebuilt, err := PeekReceivePackCommands(strings.NewReader(input))
			assert.Equal(t, input, pktlineCovReadAll(t, rebuilt))
			require.NoError(t, err)
			assert.Equal(t, []ReceivePackCommand{
				{OldOID: oldOID, NewOID: newOID, RefName: "refs/heads/main"},
				{OldOID: newOID, NewOID: oldOID, RefName: "refs/heads/feature"},
			}, commands)
			parsed, rebuilt, err := PeekReceivePackRequest(strings.NewReader(input))
			require.NoError(t, err)
			assert.Equal(t, commands, parsed.Commands)
			assert.Equal(t, tc.shallow, parsed.Shallow)
			assert.Equal(t, input, pktlineCovReadAll(t, rebuilt))

			update, rebuilt, err := PeekReceivePackUpdate(strings.NewReader(input))
			require.NoError(t, err)
			assert.Equal(t, ReceivePackUpdate{RefName: "refs/heads/main", NewOID: newOID}, update)
			assert.Equal(t, input, pktlineCovReadAll(t, rebuilt))
		})
	}
}

func TestPeekReceivePackCommands_MalformedShallow(t *testing.T) {
	t.Parallel()
	for _, line := range []string{
		"shallow", "shallow ", "shallow abc123",
		"shallow " + strings.Repeat("g", 40),
		"shallow " + strings.Repeat("a", 40) + " extra",
		"shallow " + strings.Repeat("a", 40) + "\x00report-status",
	} {
		t.Run(line, func(t *testing.T) {
			input := pktlineCovPacket(line) + "0000PACK"
			commands, rebuilt, err := PeekReceivePackCommands(strings.NewReader(input))
			require.Error(t, err)
			assert.Empty(t, commands)
			assert.Equal(t, input, pktlineCovReadAll(t, rebuilt))
		})
	}
}

func TestPeekReceivePackUpdate_ParsesRefAndNewOID_AndPreservesStream(t *testing.T) {
	t.Parallel()

	// Simulate a receive-pack pkt-line: "0000000000000000000000000000000000000000 abc123... refs/heads/main\x00caps"
	// Format: 4-char hex length (includes the 4 bytes) + payload
	payload := "0000000000000000000000000000000000000000 abc123def456abc123def456abc123def456abc1 refs/heads/main\x00report-status"
	pktLen := len(payload) + 4
	pktLine := fmt.Sprintf("%04x%s", pktLen, payload)
	input := strings.NewReader(pktLine)

	update, rebuilt, err := PeekReceivePackUpdate(input)
	require.NoError(t, err)

	assert.Equal(t, "refs/heads/main", update.RefName)
	assert.Equal(t, "abc123def456abc123def456abc123def456abc1", update.NewOID)

	// Verify the stream is preserved
	rebuiltBytes, err := io.ReadAll(rebuilt)
	require.NoError(t, err)
	assert.Equal(t, pktLine, string(rebuiltBytes))
}

func TestPeekReceivePackUpdate_InvalidPktLine_ReturnsEmptyAndPreservesStream(t *testing.T) {
	t.Parallel()

	invalidPktLine := "ZZZZ0000000000000000000000000000000000000000 abc123"
	input := strings.NewReader(invalidPktLine)

	update, rebuilt, err := PeekReceivePackUpdate(input)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "invalid pkt-line hex")

	assert.Equal(t, "", update.RefName)
	assert.Equal(t, "", update.NewOID)

	// Stream should still be preserved
	rebuiltBytes, err := io.ReadAll(rebuilt)
	require.NoError(t, err)
	assert.Equal(t, invalidPktLine, string(rebuiltBytes))
}

func TestPeekReceivePackUpdate_EmptyStream_ReturnsEmpty(t *testing.T) {
	t.Parallel()

	input := strings.NewReader("")

	update, rebuilt, err := PeekReceivePackUpdate(input)
	require.NoError(t, err)

	assert.Equal(t, "", update.RefName)
	assert.Equal(t, "", update.NewOID)

	rebuiltBytes, err := io.ReadAll(rebuilt)
	require.NoError(t, err)
	assert.Equal(t, "", string(rebuiltBytes))
}

func TestPeekReceivePackUpdate_FlushOnlyStream_ReturnsEmpty(t *testing.T) {
	t.Parallel()

	// "0000" is a flush packet
	flushPkt := "0000"
	input := strings.NewReader(flushPkt + flushPkt)

	update, rebuilt, err := PeekReceivePackUpdate(input)
	require.NoError(t, err)

	// Flush packets are skipped, so we return empty
	assert.Equal(t, "", update.RefName)
	assert.Equal(t, "", update.NewOID)

	// Stream should be preserved
	rebuiltBytes, err := io.ReadAll(rebuilt)
	require.NoError(t, err)
	assert.Equal(t, flushPkt+flushPkt, string(rebuiltBytes))
}

func TestPeekReceivePackUpdate_MultiplePackets_ReturnsFirstUpdate(t *testing.T) {
	t.Parallel()

	// First packet: ref update
	payload1 := "0000000000000000000000000000000000000000 abc123def456abc123def456abc123def456abc1 refs/heads/main\x00caps"
	pkt1 := fmt.Sprintf("%04x%s", len(payload1)+4, payload1)
	// Second packet: another ref update
	payload2 := "1111111111111111111111111111111111111111 def456abc123def456abc123def456abc123def4 refs/heads/dev\x00"
	pkt2 := fmt.Sprintf("%04x%s", len(payload2)+4, payload2)

	input := strings.NewReader(pkt1 + pkt2)

	update, rebuilt, err := PeekReceivePackUpdate(input)
	require.NoError(t, err)

	// Should only parse the first update
	assert.Equal(t, "refs/heads/main", update.RefName)
	assert.Equal(t, "abc123def456abc123def456abc123def456abc1", update.NewOID)

	// Stream should be fully preserved
	rebuiltBytes, err := io.ReadAll(rebuilt)
	require.NoError(t, err)
	assert.Equal(t, pkt1+pkt2, string(rebuiltBytes))
}

func TestPeekReceivePackUpdate_PartialRead_ReturnsEmptyAndPreservesStream(t *testing.T) {
	t.Parallel()

	// Only 2 bytes of the pkt-line length
	partialPkt := "00"
	input := strings.NewReader(partialPkt)

	update, rebuilt, err := PeekReceivePackUpdate(input)
	require.NoError(t, err) // Partial reads are gracefully handled

	assert.Equal(t, "", update.RefName)
	assert.Equal(t, "", update.NewOID)

	rebuiltBytes, err := io.ReadAll(rebuilt)
	require.NoError(t, err)
	assert.Equal(t, partialPkt, string(rebuiltBytes))
}

func TestPeekReceivePackUpdate_WithCapabilities_StripsNullByte(t *testing.T) {
	t.Parallel()

	// With capabilities after null byte
	payload := "0000000000000000000000000000000000000000 deadbeefdeadbeefdeadbeefdeadbeefdeadbeef refs/heads/feature\x00report-status side-band-64k"
	pktLine := fmt.Sprintf("%04x%s", len(payload)+4, payload)
	input := strings.NewReader(pktLine)

	update, rebuilt, err := PeekReceivePackUpdate(input)
	require.NoError(t, err)

	assert.Equal(t, "refs/heads/feature", update.RefName)
	assert.Equal(t, "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef", update.NewOID)

	rebuiltBytes, err := io.ReadAll(rebuilt)
	require.NoError(t, err)
	assert.Equal(t, pktLine, string(rebuiltBytes))
}

func TestPeekReceivePackUpdate_WithFlushBeforeData_SkipsFlush(t *testing.T) {
	t.Parallel()

	// Flush packet followed by actual ref update
	flushPkt := "0000"
	dataPayload := "0000000000000000000000000000000000000000 cafebabecafebabecafebabecafebabecafebabe refs/tags/v1.0\x00"
	dataPktLen := len(dataPayload) + 4
	dataPkt := fmt.Sprintf("%04x%s", dataPktLen, dataPayload)
	input := bytes.NewReader([]byte(flushPkt + dataPkt))

	update, rebuilt, err := PeekReceivePackUpdate(input)
	require.NoError(t, err)

	assert.Equal(t, "refs/tags/v1.0", update.RefName)
	assert.Equal(t, "cafebabecafebabecafebabecafebabecafebabe", update.NewOID)

	rebuiltBytes, err := io.ReadAll(rebuilt)
	require.NoError(t, err)
	assert.Equal(t, flushPkt+dataPkt, string(rebuiltBytes))
}

// git's hexval accepts upper-case pkt-line lengths, so the policy peek must
// parse them too: a stream the peek refuses still reaches git and applies.
func TestPeekReceivePackCommands_UppercaseLengthParses(t *testing.T) {
	t.Parallel()
	const zero = "0000000000000000000000000000000000000000"
	const oid = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
	ref := "refs/smithers/workspaces/evil"
	line := ""
	for {
		line = zero + " " + oid + " " + ref + "\x00report-status\n"
		if strings.ContainsAny(fmt.Sprintf("%04X", len(line)+4), "ABCDEF") {
			break
		}
		ref += "x"
	}
	stream := fmt.Sprintf("%04X%s0000PACK", len(line)+4, line)

	commands, rebuilt, err := PeekReceivePackCommands(strings.NewReader(stream))
	require.NoError(t, err)
	require.Len(t, commands, 1)
	assert.Equal(t, ref, commands[0].RefName)
	replayed, err := io.ReadAll(rebuilt)
	require.NoError(t, err)
	assert.Equal(t, stream, string(replayed))
}

// The metadata peek must read the same upper-case lengths git accepts.
func TestPeekReceivePackUpdate_UppercaseLengthParses(t *testing.T) {
	t.Parallel()
	const zero = "0000000000000000000000000000000000000000"
	const oid = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
	ref := "refs/heads/main"
	line := ""
	for {
		line = zero + " " + oid + " " + ref + "\x00report-status\n"
		if strings.ContainsAny(fmt.Sprintf("%04X", len(line)+4), "ABCDEF") {
			break
		}
		ref += "x"
	}
	stream := fmt.Sprintf("%04X%s0000PACK", len(line)+4, line)

	update, rebuilt, err := PeekReceivePackUpdate(strings.NewReader(stream))
	require.NoError(t, err)
	assert.Equal(t, ref, update.RefName)
	assert.Equal(t, oid, update.NewOID)
	replayed, err := io.ReadAll(rebuilt)
	require.NoError(t, err)
	assert.Equal(t, stream, string(replayed))
}

// Astra round 3, B1: a command naming HEAD, another pseudoref or any name
// outside refs/ reached git, which resolves it through HEAD, and the
// fallback rollback deleted the branch HEAD names. The command list now
// fails to parse, so every door and the engine refuse the push before git
// runs, whatever credential sent it; the stream still replays unchanged.
func TestPeekReceivePackCommandsRefusesNamesGitResolvesThroughHEAD(t *testing.T) {
	t.Parallel()
	const oldOID = "340ecc0ee56893ec516de12e72468ffe9a2886f0"
	const newOID = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
	for _, name := range []string{
		"HEAD", "FETCH_HEAD", "ORIG_HEAD", "MERGE_HEAD", "CHERRY_PICK_HEAD", "main", "heads/main",
		"refs", "refs/", "refs/heads/", "refs//heads/main", "/refs/heads/main", "refs/heads/a..b",
		"refs/heads/x.lock", "refs/heads/.x", "refs/heads/x.", "refs/heads/a@{1}", "refs/heads/a b",
		"refs/heads/a~1", "refs/heads/a^", "refs/heads/a:b", "refs/heads/a?", "refs/heads/a*",
		"refs/heads/a[", "refs/heads/a\\b", "refs/heads/a\x01",
	} {
		t.Run(name, func(t *testing.T) {
			input := pktlineCovPacket(oldOID+" "+newOID+" refs/tags/v1\x00report-status") +
				pktlineCovPacket(oldOID+" "+newOID+" "+name) + "0000PACK"
			commands, rebuilt, err := PeekReceivePackCommands(strings.NewReader(input))
			require.Error(t, err)
			assert.Empty(t, commands)
			assert.Equal(t, input, pktlineCovReadAll(t, rebuilt))
		})
	}
	for _, name := range []string{
		"refs/heads/main", "refs/heads/feature/login", "refs/tags/v1.0", "refs/smithers/users/7/x",
		"refs/notes/commits", "refs/stash", "refs/heads/@", "refs/heads/a@b",
	} {
		input := pktlineCovPacket(oldOID+" "+newOID+" "+name+"\x00report-status") + "0000PACK"
		commands, _, err := PeekReceivePackCommands(strings.NewReader(input))
		require.NoError(t, err, name)
		assert.Equal(t, []ReceivePackCommand{{OldOID: oldOID, NewOID: newOID, RefName: name}}, commands)
	}
}
