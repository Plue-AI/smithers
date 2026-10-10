package repohostserver

import (
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// Git's automatic maintenance runs outside the repository lock (git 2.55's
// receive-pack detaches it), so receive-pack never starts it, even in a
// repository whose own config does not turn it off yet.
func TestReceivePackNeverStartsAutomaticMaintenance(t *testing.T) {
	f := newLaneHTTPFixture(t, nil)
	// Thresholds every push crosses, in the foreground where git honors it.
	for _, setting := range [][2]string{{"gc.auto", "1"}, {"gc.autoPackLimit", "1"}, {"gc.autoDetach", "false"}, {"maintenance.autoDetach", "false"}} {
		gitOut(t, f.repo.gitDir, "config", setting[0], setting[1])
	}
	// One pack already, so the push's pack exceeds gc.autoPackLimit.
	gitOut(t, f.repo.gitDir, "repack", "-q")
	packs := func() int {
		matches, err := filepath.Glob(filepath.Join(f.repo.gitDir, "objects", "pack", "*.pack"))
		require.NoError(t, err)
		return len(matches)
	}
	require.Equal(t, 1, packs())

	tip := f.commit("work", func(dir string) {
		require.NoError(t, os.WriteFile(filepath.Join(dir, "work.txt"), []byte("work\n"), 0o644))
	})
	create := f.pushBody(f.base, tip, "refs/heads/feature")
	copy(create[4:44], laneZeroOID)
	rec := postReceivePack(t, f, create)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.Equal(t, tip, f.repo.refs()["refs/heads/feature"])

	require.Equal(t, 2, packs(), "automatic maintenance repacked the push's pack")
	// git 2.55 detaches it whatever maintenance.autoDetach says.
	require.Never(t, func() bool { return packs() != 2 }, 3*time.Second, 50*time.Millisecond, "detached automatic maintenance repacked the push's pack")
}
