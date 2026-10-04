package services

import (
	"os"
	"os/exec"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

// No database or service replay: these checks prove the shared controller's
// non-vacuous marker boundary, not TODO recovery acceptance (T-REL-04).
func TestCrashMarkerTokenBoundary(t *testing.T) {
	for _, tc := range []struct {
		line   string
		found  bool
		fields []string
	}{
		{"CRASH-POINT pre-launch", true, []string{}},
		{"CRASH-POINT pre-launch subject run-1", true, []string{"subject", "run-1"}},
		{"CRASH-POINT pre-launch\tsubject", true, []string{"subject"}},
		{"CRASH-POINT pre-launch-extra", false, nil},
		{"CRASH-POINT pre-launching", false, nil},
		{"CRASH-POINT post-launch", false, nil},
		{"noise CRASH-POINT pre-launch", false, nil},
		{"", false, nil},
	} {
		t.Run(tc.line, func(t *testing.T) {
			fields, found := crashLineFields(tc.line, crashMarker+"pre-launch")
			require.Equal(t, tc.found, found)
			require.Equal(t, tc.fields, fields)
		})
	}
}

func TestCrashMarkerChild(t *testing.T) {
	if os.Getenv("SMITHERS_MARKER_CHILD") != "1" {
		return
	}
	crashReached(os.Getenv(crashPointEnv))
}

func TestCrashMarkerObservedBeforeSIGKILL(t *testing.T) {
	t.Setenv("SMITHERS_MARKER_CHILD", "1")
	// Reuse the durable harness process controller; only its test selector differs.
	child := startCrashProcess(t, "TestCrashMarkerChild", "marker", "pre-launch", "")
	require.False(t, child.reached)
	require.Empty(t, child.await(t, crashMarker+"pre-launch"))
	require.True(t, child.reached)
	child.kill(t)
}

// A deliberately failed nested test must exit nonzero: refusal cannot become
// a green test merely because the controller never reached its target.
func TestCrashMarkerRefusalChild(t *testing.T) {
	mode := os.Getenv("SMITHERS_MARKER_REFUSAL")
	if mode == "" {
		return
	}
	child := &crashChild{point: "pre-launch", lines: make(chan string, 1), stderr: &strings.Builder{}}
	if mode == "unobserved-kill" {
		child.kill(t)
		return
	}
	if mode == "wrong-marker" {
		child.lines <- "CRASH-POINT pre-launch-extra"
	}
	close(child.lines)
	child.await(t, crashMarker+"pre-launch")
}

func TestCrashMarkerRefusalsExitNonzero(t *testing.T) {
	for _, mode := range []string{"missing-marker", "wrong-marker", "unobserved-kill"} {
		t.Run(mode, func(t *testing.T) {
			cmd := exec.Command(os.Args[0], "-test.run=^TestCrashMarkerRefusalChild$", "-test.count=1")
			cmd.Env = append(os.Environ(), "SMITHERS_MARKER_REFUSAL="+mode)
			output, err := cmd.CombinedOutput()
			var exit *exec.ExitError
			require.ErrorAs(t, err, &exit)
			require.NotZero(t, exit.ExitCode())
			if mode == "unobserved-kill" {
				require.Contains(t, string(output), "refusing crash without exact CRASH-POINT pre-launch marker")
			} else {
				require.Contains(t, string(output), "crash child exited before")
			}
		})
	}
}

func TestCrashMarkerOutcomeProtocol(t *testing.T) {
	fields, found := crashLineFields("CRASH-OUTCOME true", crashOutcome)
	require.True(t, found)
	require.Equal(t, []string{"true"}, fields)
}
