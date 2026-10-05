// Package bundletest gives tests a directory an installed bundle or its
// state may live in: one reached through a protected chain.
package bundletest

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/smithersai/smithers/packages/backend/installbundle"
)

// ProtectedTempDir is a fresh directory, removed when t ends, whose every
// component from / passes installbundle's trust rule. The test temporary
// directory qualifies on macOS (/var/folders); a world-writable /tmp (Linux)
// does not, so the user's cache directory is used there.
func ProtectedTempDir(t testing.TB) string {
	t.Helper()
	directory, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := installbundle.ProtectedDirectory("test directory", directory); err == nil {
		return directory
	}
	cache, err := os.UserCacheDir()
	if err != nil {
		t.Fatalf("no protected test directory: %v", err)
	}
	base := filepath.Join(cache, "smithers-protected-test")
	if err := os.MkdirAll(base, 0o700); err != nil {
		t.Fatal(err)
	}
	directory, err = os.MkdirTemp(base, "dir-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(directory) })
	if directory, err = filepath.EvalSymlinks(directory); err != nil {
		t.Fatal(err)
	}
	if _, err := installbundle.ProtectedDirectory("test directory", directory); err != nil {
		t.Fatalf("no protected test directory: %v", err)
	}
	return directory
}
