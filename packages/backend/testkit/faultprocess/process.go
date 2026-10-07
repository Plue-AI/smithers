package faultprocess

import (
	"bufio"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

const (
	ChildEnv = "SMITHERS_CRASH_CHILD"
	PointEnv = "SMITHERS_CRASH_POINT"
	DBEnv    = "SMITHERS_CRASH_DATABASE_URL"
	ArgsEnv  = "SMITHERS_CRASH_ARGS"
	Marker   = "CRASH-POINT "
)

func childFail(err error) { fmt.Fprintln(os.Stderr, "crash child:", err); os.Exit(3) }

// Reached announces a kill point and never returns: the parent kills the
// process here. The stale owner instead waits to be resumed.
func Reached(point string, detail ...string) {
	fmt.Println(Marker + strings.Join(append([]string{point}, detail...), " "))
	if point == "stale-owner" {
		// SIGSTOP freezes the whole process, heartbeats included; after
		// SIGCONT the parent writes one line to let the owner continue.
		if _, err := bufio.NewReader(os.Stdin).ReadString('\n'); err != nil {
			childFail(err)
		}
		return
	}
	select {}
}

type Child struct {
	cmd     *exec.Cmd
	stdin   io.WriteCloser
	lines   chan string
	stderr  *strings.Builder
	point   string
	reached bool
}

func Start(t *testing.T, test, subject, point, databaseURL string, args ...string) *Child {
	t.Helper()
	cmd := exec.Command(os.Args[0], "-test.run=^"+test+"$", "-test.count=1")
	cmd.Env = append(os.Environ(), ChildEnv+"="+subject, PointEnv+"="+point, DBEnv+"="+databaseURL, ArgsEnv+"="+strings.Join(args, "|"))
	stdout, err := cmd.StdoutPipe()
	require.NoError(t, err)
	stdin, err := cmd.StdinPipe()
	require.NoError(t, err)
	child := &Child{cmd: cmd, stdin: stdin, lines: make(chan string, 64), stderr: &strings.Builder{}, point: point}
	cmd.Stderr = child.stderr
	require.NoError(t, cmd.Start())
	go func() {
		defer close(child.lines)
		scanner := bufio.NewScanner(stdout)
		for scanner.Scan() {
			child.lines <- scanner.Text()
		}
	}()
	t.Cleanup(func() {
		_ = cmd.Process.Signal(syscall.SIGCONT)
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
	})
	return child
}

// Await returns the fields after prefix on the first matching line.
func (c *Child) Await(t *testing.T, prefix string) []string {
	t.Helper()
	timeout := time.After(2 * time.Minute)
	for {
		select {
		case line, ok := <-c.lines:
			if !ok {
				t.Fatalf("crash child exited before %q: %s", prefix, c.stderr.String())
			}
			if rest, found := LineFields(line, prefix); found {
				if prefix == Marker+c.point {
					c.reached = true
				}
				return rest
			}
		case <-timeout:
			t.Fatalf("crash child never reached %q: %s", prefix, c.stderr.String())
		}
	}
}

// Match a complete marker token, never a point with the requested point as
// its prefix. Outcome lines use the same whitespace-delimited protocol.
func LineFields(line, prefix string) ([]string, bool) {
	rest, found := strings.CutPrefix(line, prefix)
	if !found || (!strings.HasSuffix(prefix, " ") && rest != "" && rest[0] != ' ' && rest[0] != '\t') {
		return nil, false
	}
	return strings.Fields(rest), true
}

// Kill ends the child as a crash would: no deferred cleanup, no release.
func (c *Child) Kill(t *testing.T) {
	t.Helper()
	require.True(t, c.reached, "refusing crash without exact %s%s marker", Marker, c.point)
	require.NoError(t, c.cmd.Process.Signal(syscall.SIGKILL))
	err := c.cmd.Wait()
	var exit *exec.ExitError
	require.ErrorAs(t, err, &exit)
	require.Equal(t, syscall.SIGKILL, exit.Sys().(syscall.WaitStatus).Signal())
}

func (c *Child) Freeze(t *testing.T) {
	t.Helper()
	require.NoError(t, c.cmd.Process.Signal(syscall.SIGSTOP))
}

func (c *Child) Resume(t *testing.T) {
	t.Helper()
	require.NoError(t, c.cmd.Process.Signal(syscall.SIGCONT))
	_, err := io.WriteString(c.stdin, "continue\n")
	require.NoError(t, err)
}
