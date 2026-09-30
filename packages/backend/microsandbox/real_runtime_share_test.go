package microsandbox

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
	"golang.org/x/sys/unix"

	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

// Every guest mounts a host directory of its machine read-write at /.msb, and
// the guest may plant links there. After the machine stops, the host sizes its
// directory (Doctor): that walk must see the guest's links as links and never
// reach the host file or directory they name.
func TestRealMicroVMRuntimeShareLinksAreNeverFollowed(t *testing.T) {
	r := realRuntime(t, t.TempDir())
	ctx := operation("runtime-share")
	const id = "microvm-runtime-share"
	outside := t.TempDir()
	sentinel := "host-only-" + digest(outside)[:12]
	require.NoError(t, os.WriteFile(filepath.Join(outside, sentinel), []byte(strings.Repeat("h", 8<<20)), 0o600))

	_, err := r.CreateWorkspace(ctx, workspaceapi.WorkspaceSpec{ID: id})
	require.NoError(t, err)
	defer func() { require.NoError(t, r.DeleteWorkspace(operation("delete"), id)) }()
	machine := r.machineName(id)
	plant := "ln -s /etc/passwd /.msb/link && ln -s " + outside + " /.msb/hostdir && ln -s " +
		filepath.Join(outside, sentinel) + " /.msb/hostfile && ln -s .. /.msb/loop && echo planted"
	out, err := r.cli.run(ctx, nil, "exec", machine, "--", "sh", "-c", plant)
	require.NoError(t, err, "%s", out)
	require.Contains(t, string(out), "planted")
	require.NoError(t, r.StopWorkspace(ctx, id))

	directory := machineDirectory(r.cli.home, machine)
	links := map[string]bool{}
	var seen []string
	walkTree(directory, func(_ int, name string, stat *unix.Stat_t) {
		seen = append(seen, name)
		if stat.Mode&unix.S_IFMT == unix.S_IFLNK {
			links[name] = true
		}
	})
	for _, name := range []string{"link", "hostdir", "hostfile", "loop"} {
		require.True(t, links[name], "the guest's %s reached the host as a link", name)
	}
	require.NotContains(t, seen, sentinel, "the walk never entered the host directory a guest link names")
	require.NotContains(t, seen, "passwd")

	// The sizes the doctor reports are those of the tree itself: pointing a
	// link at 8 MiB of host data adds nothing.
	private := privateBytes(directory)
	require.NoError(t, os.WriteFile(filepath.Join(outside, sentinel), []byte(strings.Repeat("h", 64<<20)), 0o600))
	require.Equal(t, private, privateBytes(directory))
}
