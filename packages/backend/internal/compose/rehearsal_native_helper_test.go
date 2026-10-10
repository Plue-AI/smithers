package compose

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestRehearsalNativeHelperUsesCheckout(t *testing.T) {
	root := t.TempDir()
	bin := filepath.Join(root, "bin")
	require.NoError(t, os.MkdirAll(bin, 0700))
	// Both old discovery locations contain executable but incompatible helpers.
	stale := filepath.Join(root, "target", "release", "smithers-jj-export")
	require.NoError(t, os.MkdirAll(filepath.Dir(stale), 0700))
	require.NoError(t, os.WriteFile(stale, []byte("#!/bin/sh\nexit 99\n"), 0700))
	t.Setenv("SMITHERS_FFI_LIBRARY_PATH", filepath.Join(filepath.Dir(stale), "libsmithers_ffi.so"))
	t.Setenv("SMITHERS_WORKSPACE_JJ_EXPORT_BINARY", "")
	t.Setenv("SMITHERS_REHEARSAL_JJ_EXPORT_BINARY", "")
	// Only replace the build tool in this selection test. J1/J2 exercise the
	// real Cargo build and helper through the composed install's TODO boundary.
	require.NoError(t, os.WriteFile(filepath.Join(bin, "cargo"), []byte("#!/bin/sh\npwd > build.cwd\nprintf '%s\\n' \"$@\" >> build.args\n"), 0700))
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	want := filepath.Join(root, ".artifacts", "rehearsal-machined", "debug", "smithers-jj-export")
	require.Equal(t, want, rehearsalJJExport(t, root))
	cwd, err := os.ReadFile(filepath.Join(root, "build.cwd"))
	require.NoError(t, err)
	require.Equal(t, root+"\n", string(cwd))
	args, err := os.ReadFile(filepath.Join(root, "build.args"))
	require.NoError(t, err)
	require.Equal(t, "build\n--locked\n-p\nsmithers-ffi\n--bin\nsmithers-jj-export\n--features\ntrusted-process-binding\n--target-dir\n"+filepath.Dir(filepath.Dir(want))+"\n", string(args))
	// Re-enter Cargo so an existing binary cannot hide subsequent source edits.
	require.Equal(t, want, rehearsalJJExport(t, root))
	repeated, err := os.ReadFile(filepath.Join(root, "build.args"))
	require.NoError(t, err)
	require.Equal(t, string(args)+string(args), string(repeated))
	// An explicitly pinned executable remains available to reference hosts.
	t.Setenv("SMITHERS_WORKSPACE_JJ_EXPORT_BINARY", stale)
	require.Equal(t, stale, rehearsalJJExport(t, root))
	after, err := os.ReadFile(filepath.Join(root, "build.args"))
	require.NoError(t, err)
	require.Equal(t, repeated, after)
	// A confined suite's prebuilt rehearsal helper wins over the installed
	// release helper, which cannot bind a trusted process, and builds nothing.
	rehearsal := filepath.Join(root, ".rehearsal-native", "smithers-jj-export")
	t.Setenv("SMITHERS_REHEARSAL_JJ_EXPORT_BINARY", rehearsal)
	require.Equal(t, rehearsal, rehearsalJJExport(t, root))
	after, err = os.ReadFile(filepath.Join(root, "build.args"))
	require.NoError(t, err)
	require.Equal(t, repeated, after)
}
