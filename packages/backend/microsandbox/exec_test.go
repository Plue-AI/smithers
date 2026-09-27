package microsandbox

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestExitTrailerIsParsedAndStripped(t *testing.T) {
	buffer := &limitedBuffer{limit: 1 << 10}
	_, _ = buffer.Write([]byte("warning\n"))
	_, _ = buffer.Write([]byte("\x00SMITHERS-EXIT 3\x00"))
	code, ok := buffer.exit()
	require.True(t, ok)
	require.Equal(t, 3, code)
	text, truncated := buffer.text()
	require.Equal(t, "warning\n", text)
	require.False(t, truncated)

	// Without the trailer the exit is unknown, never a guessed 0.
	missing := &limitedBuffer{limit: 1 << 10}
	_, _ = missing.Write([]byte("msb: sandbox not running\n"))
	_, ok = missing.exit()
	require.False(t, ok)
}

func TestTruncatedStreamStillReportsExit(t *testing.T) {
	buffer := &limitedBuffer{limit: 4}
	_, _ = buffer.Write([]byte("0123456789"))
	_, _ = buffer.Write([]byte("\x00SMITHERS-EXIT 0\x00"))
	code, ok := buffer.exit()
	require.True(t, ok)
	require.Equal(t, 0, code)
	text, truncated := buffer.text()
	require.Equal(t, "0123", text)
	require.True(t, truncated)
}

func TestCommandDirectoryStaysUnderRoot(t *testing.T) {
	for input, want := range map[string]string{"": "/workspace", ".": "/workspace", "apps/app": "/workspace/apps/app", "a/../b": "/workspace/b"} {
		got, err := commandDirectory(input)
		require.NoError(t, err)
		require.Equal(t, want, got)
	}
	for _, input := range []string{"/etc", "..", "../x", "a/../../x"} {
		_, err := commandDirectory(input)
		require.Error(t, err, input)
	}
}

func TestEveryNonTerminalExecStreams(t *testing.T) {
	client := &cli{binary: "/bin/true", home: "/tmp"}
	require.Equal(t, []string{"/bin/true", "exec", "--stream", "vm", "--", "cat"}, client.command("exec", "vm", "--", "cat").Args)
	require.Equal(t, []string{"/bin/true", "exec", "-t", "vm", "--", "sh"}, client.command("exec", "-t", "vm", "--", "sh").Args)
	require.Equal(t, []string{"/bin/true", "list", "--format", "json"}, client.command("list", "--format", "json").Args)
	require.Contains(t, client.command("list").Env, "MSB_BACKEND=local")
}

// A service that dies during startup reports why: its output's end, not the
// helper trailer or a truncation flag.
func TestServiceStartupErrorCarriesOutputTail(t *testing.T) {
	require.Equal(t, "Error: missing seat", outputTail("Error: missing seat\n\x00SMITHERS-EXIT 1\x00"))
	long := outputTail(strings.Repeat("x", 5000) + "end")
	require.True(t, strings.HasSuffix(long, "end"))
	require.Less(t, len(long), 2100)
}
