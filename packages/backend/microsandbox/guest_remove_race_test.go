package microsandbox

import (
	"bufio"
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// The hook pauses the actual guest CLI immediately before its chosen filesystem
// operation. The parent then removes the same target through the real filesystem.
const guestRemoveRaceHarness = `import os, runpy, sys
script, root, target, rendezvous = sys.argv[1:]
target = os.path.join(os.path.realpath(root), os.path.basename(target))

def ready():
    sys.stdout.write("READY\n")
    sys.stdout.flush()
    if sys.stdin.buffer.read(1) != b"!":
        raise RuntimeError("remove rendezvous was not released")

if rendezvous == "before-selection":
    def trace(frame, event, arg):
        if (event == "line" and frame.f_code.co_name == "fs_remove"
                and frame.f_locals.get("target") == target):
            sys.settrace(None)
            ready()
        return trace
    sys.settrace(trace)
else:
    def audit(event, args):
        if event == rendezvous and args and args[0] == target:
            ready()
    sys.addaudithook(audit)

sys.argv = [script, "fs", "remove", root, "victim"]
runpy.run_path(script, run_name="__main__")
`

func TestGuestRemoveDeletionRace(t *testing.T) {
	python, err := exec.LookPath("python3")
	if err != nil {
		t.Skip("python3 is not installed")
	}

	cases := []struct {
		name           string
		hook           string
		create         func(t *testing.T, target string)
		remove         func(target string) error
		wantOtherError bool
	}{
		{
			name: "regular file at unlink", hook: "os.remove",
			create: func(t *testing.T, target string) { require.NoError(t, os.WriteFile(target, []byte("data"), 0o600)) },
			remove: os.Remove,
		},
		{
			name: "dangling symlink at unlink", hook: "os.remove",
			create: func(t *testing.T, target string) { require.NoError(t, os.Symlink("missing-link-target", target)) },
			remove: os.Remove,
		},
		{
			name: "directory at rmtree", hook: "shutil.rmtree",
			create: func(t *testing.T, target string) {
				require.NoError(t, os.Mkdir(target, 0o700))
				require.NoError(t, os.WriteFile(filepath.Join(target, "child"), []byte("data"), 0o600))
			},
			remove: os.RemoveAll,
		},
		{
			name: "replacement directory preserves other errors", hook: "os.remove",
			create: func(t *testing.T, target string) { require.NoError(t, os.WriteFile(target, []byte("data"), 0o600)) },
			remove: func(target string) error {
				if err := os.Remove(target); err != nil {
					return err
				}
				return os.Mkdir(target, 0o700)
			},
			wantOtherError: true,
		},
		{
			name: "disappears before type selection", hook: "before-selection",
			create: func(t *testing.T, target string) { require.NoError(t, os.WriteFile(target, []byte("data"), 0o600)) },
			remove: os.Remove,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			root := t.TempDir()
			target := filepath.Join(root, "victim")
			tc.create(t, target)
			code, stderr := runGuestRemoveAtRendezvous(t, python, root, target, tc.hook, tc.remove)
			if tc.wantOtherError {
				require.NotZero(t, code, "stderr: %s", stderr)
				// macOS reports EPERM for unlinking a directory; Linux reports EISDIR.
				require.Regexp(t, `(IsADirectoryError: \[Errno 21\]|PermissionError: \[Errno 1\])`, stderr)
				require.Contains(t, stderr, "victim")
				info, err := os.Stat(target)
				require.NoError(t, err)
				require.True(t, info.IsDir(), "replacement directory was removed")
				return
			}
			require.Equal(t, 2, code, "stderr: %s", stderr)
			require.Contains(t, strings.ToLower(stderr), "no such file or directory")
			_, err := os.Lstat(target)
			require.ErrorIs(t, err, os.ErrNotExist)
		})
	}
}

func TestGuestRemoveRetainsDirectoryReplacementError(t *testing.T) {
	python, err := exec.LookPath("python3")
	if err != nil {
		t.Skip("python3 is not installed")
	}
	root := t.TempDir()
	target := filepath.Join(root, "victim")
	require.NoError(t, os.Mkdir(target, 0o700))
	code, stderr := runGuestRemoveAtRendezvous(t, python, root, target, "shutil.rmtree", func(target string) error {
		if err := os.Remove(target); err != nil {
			return err
		}
		return os.WriteFile(target, []byte("replacement"), 0o600)
	})
	require.Equal(t, 1, code, "stderr: %s", stderr)
	require.Contains(t, stderr, "NotADirectoryError")
	data, err := os.ReadFile(target)
	require.NoError(t, err)
	require.Equal(t, "replacement", string(data))
}

func TestGuestRemoveInitiallyMissing(t *testing.T) {
	python, err := exec.LookPath("python3")
	if err != nil {
		t.Skip("python3 is not installed")
	}
	cases := []struct {
		name  string
		path  string
		setup func(t *testing.T, root string)
		check func(t *testing.T, root string)
	}{
		{
			name: "missing leaf", path: "victim",
			check: func(t *testing.T, root string) {
				_, err := os.Lstat(filepath.Join(root, "victim"))
				require.ErrorIs(t, err, os.ErrNotExist)
			},
		},
		{
			name: "missing parent", path: "parent/child",
			check: func(t *testing.T, root string) {
				_, err := os.Lstat(filepath.Join(root, "parent"))
				require.ErrorIs(t, err, os.ErrNotExist)
			},
		},
		{
			name: "regular-file parent", path: "parent/child",
			setup: func(t *testing.T, root string) {
				require.NoError(t, os.WriteFile(filepath.Join(root, "parent"), []byte("parent contents"), 0o600))
			},
			check: func(t *testing.T, root string) {
				data, err := os.ReadFile(filepath.Join(root, "parent"))
				require.NoError(t, err)
				require.Equal(t, []byte("parent contents"), data)
			},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			root := t.TempDir()
			if tc.setup != nil {
				tc.setup(t, root)
			}
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			cmd := exec.CommandContext(ctx, python, filepath.Join("guest", "smithers-guest.py"), "fs", "remove", root, tc.path)
			cmd.Env = append(os.Environ(), "SMITHERS_GUEST_USER=")
			output, err := cmd.CombinedOutput()
			tc.check(t, root)
			var exit *exec.ExitError
			require.ErrorAs(t, err, &exit, "guest output: %s", output)
			require.Equal(t, 2, exit.ExitCode(), "guest output: %s", output)
			require.Contains(t, strings.ToLower(string(output)), "no such file or directory")
		})
	}
}

func runGuestRemoveAtRendezvous(t *testing.T, python, root, target, hook string, mutate func(string) error) (int, string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, python, "-u", "-c", guestRemoveRaceHarness,
		filepath.Join("guest", "smithers-guest.py"), root, target, hook)
	cmd.Env = append(os.Environ(), "SMITHERS_GUEST_USER=")
	cmd.WaitDelay = time.Second
	stdin, err := cmd.StdinPipe()
	require.NoError(t, err)
	stdout, err := cmd.StdoutPipe()
	require.NoError(t, err)
	stderr, err := cmd.StderrPipe()
	require.NoError(t, err)
	require.NoError(t, cmd.Start())

	waited := false
	defer func() {
		_ = stdin.Close()
		if !waited {
			_ = cmd.Process.Kill()
			_ = cmd.Wait()
		}
	}()
	stderrDone := make(chan []byte, 1)
	go func() {
		data, _ := io.ReadAll(stderr)
		stderrDone <- data
	}()

	reader := bufio.NewReader(stdout)
	line, err := reader.ReadString('\n')
	if err != nil {
		t.Fatalf("guest exited before rendezvous: %v; stderr: %s", err, <-stderrDone)
	}
	require.Equal(t, "READY\n", line)
	require.NoError(t, mutate(target))
	_, err = stdin.Write([]byte{'!'})
	require.NoError(t, err)
	require.NoError(t, stdin.Close())
	remaining, err := io.ReadAll(reader)
	require.NoError(t, err)
	require.Empty(t, remaining)
	data := <-stderrDone
	err = cmd.Wait()
	waited = true
	if err == nil {
		return 0, string(data)
	}
	var exit *exec.ExitError
	if !errors.As(err, &exit) {
		t.Fatalf("guest wait: %v; stderr: %s", err, data)
	}
	return exit.ExitCode(), string(data)
}
