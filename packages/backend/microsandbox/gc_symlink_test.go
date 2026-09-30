package microsandbox

import (
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"

	"github.com/stretchr/testify/require"
	"golang.org/x/sys/unix"
)

// guestPlantedTree is a machine directory as a hostile guest leaves it: its
// runtime share holds one regular file of its own beside a link to a host
// file, a link to a host directory, a link to the share itself, and a FIFO.
// The host file and directory are far larger than anything under root, so any
// byte they contribute shows.
func guestPlantedTree(t *testing.T) (root, outside string) {
	t.Helper()
	outside = t.TempDir()
	secret := filepath.Join(outside, "secret")
	require.NoError(t, os.WriteFile(secret, []byte(strings.Repeat("h", 8<<20)), 0o600))
	require.NoError(t, os.MkdirAll(filepath.Join(outside, "tree"), 0o700))
	require.NoError(t, os.WriteFile(filepath.Join(outside, "tree", "big"), []byte(strings.Repeat("h", 8<<20)), 0o600))

	root = t.TempDir()
	share := filepath.Join(root, "runtime")
	require.NoError(t, os.MkdirAll(share, 0o700))
	require.NoError(t, os.WriteFile(filepath.Join(share, "heartbeat.json"), []byte(strings.Repeat("g", 64<<10)), 0o600))
	require.NoError(t, os.Symlink(secret, filepath.Join(share, "link")))
	require.NoError(t, os.Symlink(filepath.Join(outside, "tree"), filepath.Join(share, "dirlink")))
	require.NoError(t, os.Symlink("..", filepath.Join(share, "loop")))
	require.NoError(t, syscall.Mkfifo(filepath.Join(share, "fifo"), 0o600))
	return root, outside
}

// The walk counts only what lives under root: a link is counted as the link
// and never followed, into a file, a directory or a loop, and a FIFO is never
// opened (opening one for reading would block the walk forever).
func TestTreeSizesNeverFollowGuestLinks(t *testing.T) {
	root, _ := guestPlantedTree(t)
	private := privateBytes(root)
	allocated := allocatedBytes(root)
	require.Positive(t, private, "the guest's own regular file counts")
	require.Less(t, private, int64(1<<20), "no host file behind a link is counted")
	require.Less(t, allocated, int64(1<<20), "no host tree behind a link is counted")

	var seen []string
	walkTree(root, func(_ int, name string, _ *unix.Stat_t) { seen = append(seen, name) })
	require.ElementsMatch(t, []string{"runtime", "heartbeat.json", "link", "dirlink", "loop", "fifo"}, seen,
		"the walk visits each entry once and never descends through a link")
}

// A root that is itself a link is refused rather than resolved.
func TestTreeSizesRefuseALinkedRoot(t *testing.T) {
	root, _ := guestPlantedTree(t)
	linked := filepath.Join(t.TempDir(), "machine")
	require.NoError(t, os.Symlink(root, linked))
	require.Zero(t, privateBytes(linked))
	require.Zero(t, allocatedBytes(linked))
	require.Zero(t, privateBytes(filepath.Join(root, "missing")))
}

// A guest that swaps a directory for a link after the host has seen it still
// cannot lead the walk out of root: the child opens relative to its parent's
// descriptor with O_NOFOLLOW and fails.
func TestTreeWalkRefusesADirectorySwappedForALink(t *testing.T) {
	root, outside := guestPlantedTree(t)
	swapped := filepath.Join(root, "runtime", "work")
	require.NoError(t, os.MkdirAll(swapped, 0o700))
	var seen []string
	walkTree(root, func(_ int, name string, _ *unix.Stat_t) {
		seen = append(seen, name)
		if name == "work" {
			require.NoError(t, os.Remove(swapped))
			require.NoError(t, os.Symlink(filepath.Join(outside, "tree"), swapped))
		}
	})
	require.Contains(t, seen, "work")
	require.NotContains(t, seen, "big", "the walk never entered the host directory behind the swapped link")
}

// A regular file swapped for a link, FIFO or directory after the walk saw it
// frees nothing: the host sizes only a descriptor that still holds a regular
// file, and never opens the link's target.
func TestRegularFileBytesRefusesASwappedEntry(t *testing.T) {
	root, outside := guestPlantedTree(t)
	share := filepath.Join(root, "runtime")
	directory, err := unix.Open(share, unix.O_RDONLY|unix.O_DIRECTORY, 0)
	require.NoError(t, err)
	defer unix.Close(directory)

	require.Positive(t, regularFileBytes(directory, "heartbeat.json"))
	require.NoError(t, os.Remove(filepath.Join(share, "heartbeat.json")))
	require.NoError(t, os.Symlink(filepath.Join(outside, "secret"), filepath.Join(share, "heartbeat.json")))
	require.Zero(t, regularFileBytes(directory, "heartbeat.json"), "a link is never followed")
	require.Zero(t, regularFileBytes(directory, "fifo"), "a FIFO is never sized")
	require.Zero(t, regularFileBytes(directory, "missing"))
	require.NoError(t, os.MkdirAll(filepath.Join(share, "dir"), 0o700))
	require.Zero(t, regularFileBytes(directory, "dir"), "a directory is not a regular file")
}
