package microsandbox

import (
	"errors"
	"strconv"
	"strings"
	"testing"

	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
)

func TestMicrosandboxUnitCommandResultPreservesStreamsAndExitEvidence(t *testing.T) {
	for _, row := range []struct {
		name, stdout, stderr string
		stdoutCap, stderrCap int
		want                 workspaceapi.CommandResult
		unavailable          bool
	}{
		{
			name: "stdout marker remains literal", stdout: "\x00SMITHERS-EXIT 9\x00", stderr: "diagnostic\n\x00SMITHERS-EXIT 0\x00",
			stdoutCap: 100, stderrCap: 11,
			want: workspaceapi.CommandResult{Stdout: "\x00SMITHERS-EXIT 9\x00", Stderr: "diagnostic\n"},
		},
		{
			name: "stdout loss", stdout: "output", stderr: "err\x00SMITHERS-EXIT 3\x00",
			stdoutCap: 3, stderrCap: 3,
			want: workspaceapi.CommandResult{ExitCode: 3, Stdout: "out", Stderr: "err", OutputTruncated: true},
		},
		{
			name: "stderr loss", stdout: "out", stderr: "error\x00SMITHERS-EXIT 3\x00",
			stdoutCap: 3, stderrCap: 3,
			want: workspaceapi.CommandResult{ExitCode: 3, Stdout: "out", Stderr: "err", OutputTruncated: true},
		},
		{
			name: "both streams lose payload", stdout: "output", stderr: "error\x00SMITHERS-EXIT -9\x00",
			stdoutCap: 3, stderrCap: 3,
			want: workspaceapi.CommandResult{ExitCode: -9, Stdout: "out", Stderr: "err", OutputTruncated: true},
		},
		{
			name: "missing receipt is not success", stdout: "out", stderr: "transport stopped",
			stdoutCap: 100, stderrCap: 100,
			want: workspaceapi.CommandResult{Stdout: "out", Stderr: "transport stopped"}, unavailable: true,
		},
		{
			name: "malformed receipt retains diagnostics", stdout: "", stderr: "\x00SMITHERS-EXIT nope\x00",
			stdoutCap: 100, stderrCap: 100,
			want: workspaceapi.CommandResult{Stderr: "\x00SMITHERS-EXIT nope\x00"}, unavailable: true,
		},
	} {
		t.Run(row.name, func(t *testing.T) {
			command := &guestCommand{
				stdout: &limitedBuffer{limit: row.stdoutCap}, stderr: &limitedBuffer{limit: row.stderrCap},
				waitErr: errors.New("host transport ended"),
			}
			_, err := command.stdout.Write([]byte(row.stdout))
			require.NoError(t, err)
			_, err = command.stderr.Write([]byte(row.stderr))
			require.NoError(t, err)
			for observation := 0; observation < 3; observation++ {
				result, err := command.result()
				require.Equal(t, row.want, result)
				if row.unavailable {
					require.ErrorIs(t, err, ErrUnavailable)
					require.Contains(t, err.Error(), "host transport ended")
					require.Contains(t, err.Error(), row.want.Stderr)
				} else {
					require.NoError(t, err, "a reported guest exit is authoritative even if its transport wait returned an error")
				}
			}
		})
	}
}

func TestMicrosandboxUnitCompletedStderrIsIndependentOfWriteSplitsAndReads(t *testing.T) {
	const raw = "diagnostic\n\x00SMITHERS-EXIT 3\x00"
	for _, row := range []struct {
		limit              int
		payload, rawPrefix string
		truncated          bool
	}{
		{0, "", "", true},
		{1, "d", "d", true},
		{10, "diagnostic", "diagnostic", true},
		{11, "diagnostic\n", "diagnostic\n", false},
		{12, "diagnostic\n", "diagnostic\n\x00", false},
		{28, "diagnostic\n", raw, false},
	} {
		// Every split includes the one-shot write (split zero), cuts within the
		// diagnostic and marker, and an empty final write (split len(raw)).
		for split := 0; split <= len(raw); split++ {
			t.Run("limit="+strconv.Itoa(row.limit)+"/split="+strconv.Itoa(split), func(t *testing.T) {
				buffer := &limitedBuffer{limit: row.limit}
				for _, chunk := range []string{raw[:split], raw[split:]} {
					n, err := buffer.Write([]byte(chunk))
					require.NoError(t, err)
					require.Equal(t, len(chunk), n)
				}
				rawText, rawTruncated := buffer.text()
				require.Equal(t, row.rawPrefix, rawText)
				for observation := 0; observation < 3; observation++ {
					require.Equal(t, stderrSnapshot{text: row.payload, truncated: row.truncated, exitCode: 3, hasExit: true}, buffer.completedStderr())
					unchangedText, unchangedTruncated := buffer.text()
					require.Equal(t, rawText, unchangedText, "stderr projection must not change raw stdout/live capture")
					require.Equal(t, rawTruncated, unchangedTruncated)
				}
			})
		}
	}
}

func TestMicrosandboxUnitCompletedStderrKeepsBoundedLossAndUnknownEvidence(t *testing.T) {
	for _, row := range []struct {
		name     string
		raw      string
		limit    int
		expected stderrSnapshot
	}{
		{"discard64", strings.Repeat("x", 100) + "\n\x00SMITHERS-EXIT 3\x00", 54, stderrSnapshot{text: strings.Repeat("x", 54), truncated: true, exitCode: 3, hasExit: true}},
		{"discard65", strings.Repeat("x", 100) + "\n\x00SMITHERS-EXIT 3\x00", 53, stderrSnapshot{text: strings.Repeat("x", 53), truncated: true, exitCode: 3, hasExit: true}},
		{"discard66", strings.Repeat("x", 100) + "\n\x00SMITHERS-EXIT 3\x00", 52, stderrSnapshot{text: strings.Repeat("x", 52), truncated: true, exitCode: 3, hasExit: true}},
		{"large write", strings.Repeat("x", 8_388_608) + "\x00SMITHERS-EXIT 3\x00", 4, stderrSnapshot{text: "xxxx", truncated: true, exitCode: 3, hasExit: true}},
		{"only protocol fits zero payload cap", "\x00SMITHERS-EXIT 0\x00", 0, stderrSnapshot{exitCode: 0, hasExit: true}},
		{"malformed integer", "warning\n\x00SMITHERS-EXIT nope\x00", 1024, stderrSnapshot{text: "warning\n\x00SMITHERS-EXIT nope\x00"}},
		{"overflow integer", "\x00SMITHERS-EXIT 99999999999999999999999999\x00", 1024, stderrSnapshot{text: "\x00SMITHERS-EXIT 99999999999999999999999999\x00"}},
		{"nonterminal marker", "warning\n\x00SMITHERS-EXIT 0\x00continued", 1024, stderrSnapshot{text: "warning\n\x00SMITHERS-EXIT 0\x00continued"}},
		{"missing marker and real payload loss", "abcdefghijk", 5, stderrSnapshot{text: "abcde", truncated: true}},
	} {
		t.Run(row.name, func(t *testing.T) {
			buffer := &limitedBuffer{limit: row.limit}
			_, err := buffer.Write([]byte(row.raw))
			require.NoError(t, err)
			require.Equal(t, row.expected, buffer.completedStderr())
			require.Equal(t, row.expected, buffer.completedStderr())
		})
	}
}

func TestExitTrailerIsParsedAndStripped(t *testing.T) {
	buffer := &limitedBuffer{limit: 1 << 10}
	_, _ = buffer.Write([]byte("warning\n"))
	_, _ = buffer.Write([]byte("\x00SMITHERS-EXIT 3\x00"))
	snapshot := buffer.completedStderr()
	require.True(t, snapshot.hasExit)
	require.Equal(t, 3, snapshot.exitCode)
	text, truncated := snapshot.text, snapshot.truncated
	require.Equal(t, "warning\n", text)
	require.False(t, truncated)

	// Without the trailer the exit is unknown, never a guessed 0.
	missing := &limitedBuffer{limit: 1 << 10}
	_, _ = missing.Write([]byte("msb: sandbox not running\n"))
	require.False(t, missing.completedStderr().hasExit)
}

func TestTruncatedStreamStillReportsExit(t *testing.T) {
	buffer := &limitedBuffer{limit: 4}
	_, _ = buffer.Write([]byte("0123456789"))
	_, _ = buffer.Write([]byte("\x00SMITHERS-EXIT 0\x00"))
	snapshot := buffer.completedStderr()
	require.True(t, snapshot.hasExit)
	require.Equal(t, 0, snapshot.exitCode)
	text, truncated := snapshot.text, snapshot.truncated
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
