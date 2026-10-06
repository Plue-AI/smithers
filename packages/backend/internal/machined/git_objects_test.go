package machined

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/smithersai/smithers/packages/backend/hostexec"
	"github.com/stretchr/testify/require"
)

func bundleFixture(t *testing.T) (string, string, string, string) {
	t.Helper()
	root := t.TempDir()
	source, target, bundle := filepath.Join(root, "source"), filepath.Join(root, "target"), filepath.Join(root, "capture.bundle")
	git := func(args ...string) string {
		out, err := hostexec.Git(t.Context(), append([]string{"-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "core.hooksPath=/dev/null"}, args...)...).CombinedOutput()
		require.NoError(t, err, "%s", out)
		return strings.TrimSpace(string(out))
	}
	git("init", "--initial-branch=main", source)
	require.NoError(t, os.WriteFile(filepath.Join(source, "README.md"), []byte("before\n"), 0600))
	git("-C", source, "add", ".")
	git("-C", source, "commit", "-m", "base")
	base := git("-C", source, "rev-parse", "HEAD")
	git("clone", "--bare", source, target)
	require.NoError(t, os.WriteFile(filepath.Join(source, "README.md"), []byte("acknowledged bytes\n"), 0600))
	git("-C", source, "add", ".")
	git("-C", source, "commit", "-m", "capture")
	head := git("-C", source, "rev-parse", "HEAD")
	git("-C", source, "bundle", "create", bundle, "--all")
	return target, bundle, base, head
}

func TestGitBundleImporterRetainsDataWithoutGuestRefs(t *testing.T) {
	repo, bundle, base, head := bundleFixture(t)
	branch := "11111111-1111-4111-8111-111111111111"
	file, err := os.Open(bundle)
	require.NoError(t, err)
	defer file.Close()
	importer := GitBundleImporter(func(_ context.Context, id string) (string, error) {
		if id != branch {
			return "", ErrUnauthorized
		}
		return repo, nil
	})
	for range 2 {
		require.NoError(t, importer(t.Context(), branch, file))
	}
	git := func(args ...string) string {
		out, err := hostexec.Git(t.Context(), append([]string{"-C", repo}, args...)...).CombinedOutput()
		require.NoError(t, err, "%s", out)
		return strings.TrimSpace(string(out))
	}
	require.Equal(t, base, git("rev-parse", "refs/heads/main"))
	require.Equal(t, head, git("rev-parse", "refs/smithers/branches/"+branch+"/incoming/"+head))
	// Incoming pins keep the acknowledged content through immediate GC.
	git("gc", "--prune=now")
	require.Equal(t, "acknowledged bytes", git("show", head+":README.md"))
	require.ErrorIs(t, importer(t.Context(), "foreign", file), ErrUnauthorized)
	bad := filepath.Join(t.TempDir(), "bad.bundle")
	require.NoError(t, os.WriteFile(bad, []byte("branch-controlled invalid bytes"), 0600))
	invalid, err := os.Open(bad)
	require.NoError(t, err)
	defer invalid.Close()
	require.ErrorContains(t, importer(t.Context(), branch, invalid), "invalid or incomplete")
	require.Equal(t, base, git("rev-parse", "refs/heads/main"))
}
