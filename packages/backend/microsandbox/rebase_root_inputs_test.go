package microsandbox

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/smithersai/smithers/packages/backend/installbundle/bundletest"
	"github.com/stretchr/testify/require"
)

// T-REL-04 supplemental host acceptance: exercise the installed runtime's New
// boundary, including a forged replacement manifest after the backend pinned
// approval. These tests execute no privileged code and do not qualify C-SEC-02.
func TestRebaseApprovedRootArtifactSubstitutionRefused(t *testing.T) {
	require.NotZero(t, os.Geteuid())
	for _, artifact := range []string{"bin/msb", "lib/libkrunfw.5.dylib", "bin/linux-arm64/smithers-jj-export", "bin/linux-arm64/jj", "bin/smithers-coding-host"} {
		for _, attack := range []string{"bytes", "forged-manifest", "symlink"} {
			t.Run(artifact+"/"+attack, func(t *testing.T) {
				root, files := approvedBundleFixture(t)
				approved := pinned(t, root)
				target := filepath.Join(root, filepath.FromSlash(artifact))
				mode := os.FileMode(0755)
				if artifact == "lib/libkrunfw.5.dylib" {
					mode = 0644
				}
				substituted := append([]byte(nil), files[artifact]...)
				substituted[len(substituted)-1] ^= 1 // same size, distinct bytes
				switch attack {
				case "bytes":
					require.NoError(t, os.WriteFile(target, substituted, mode))
				case "forged-manifest":
					approveBundleFile(t, root, artifact, substituted, mode)
				case "symlink":
					outside := filepath.Join(t.TempDir(), "branch-artifact")
					require.NoError(t, os.WriteFile(outside, files[artifact], mode))
					require.NoError(t, os.Remove(target))
					require.NoError(t, os.Symlink(outside, target))
				}
				state := filepath.Join(bundletest.ProtectedTempDir(t), "unstarted-state")
				machine, err := New(t.Context(), Config{Root: state, CPUs: 1, MemoryMiB: 1024, DiskMiB: 1024, MaxRunningVMs: 1, Bundle: approved, BundlePrograms: []string{filepath.Join(root, "bin/smithers-coding-host")}})
				require.ErrorIs(t, err, ErrUnapprovedArtifact)
				require.Nil(t, machine)
				require.NoFileExists(t, filepath.Join(filepath.Dir(root), "msb-ran"), "refusal must precede executable use")
				_, err = os.Lstat(state)
				require.ErrorIs(t, err, os.ErrNotExist, "refusal must precede machine state creation")
				if attack == "symlink" {
					require.NoError(t, os.Remove(target))
				}
				require.NoError(t, os.WriteFile(target, files[artifact], mode))
				// The pinned approval is unchanged by the forged manifest. Restoring the
				// actual approved bytes must reach msb, whose literal unsupported version
				// refuses qualification, rather than conceal an unconditional rejection.
				machine, err = New(t.Context(), Config{Root: state, CPUs: 1, MemoryMiB: 1024, DiskMiB: 1024, MaxRunningVMs: 1, Bundle: approved, BundlePrograms: []string{filepath.Join(root, "bin/smithers-coding-host")}})
				require.Nil(t, machine)
				require.ErrorIs(t, err, ErrUnavailable)
				require.NotErrorIs(t, err, ErrUnapprovedArtifact)
				require.FileExists(t, filepath.Join(filepath.Dir(root), "msb-ran"))
			})
		}
	}
}
