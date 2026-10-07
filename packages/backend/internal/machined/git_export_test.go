package machined

import (
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/smithersai/smithers/packages/backend/hostexec"
	"github.com/stretchr/testify/require"
)

func TestGitBundleExporterFreezesOnlyAuthoritativeHead(t *testing.T) {
	repo, bundle, base, head := bundleFixture(t)
	branch := "11111111-1111-4111-8111-111111111111"
	git := func(args ...string) string {
		t.Helper()
		out, err := hostexec.Git(t.Context(), args...).CombinedOutput()
		require.NoError(t, err, "%s", out)
		return strings.TrimSpace(string(out))
	}
	git("-C", repo, "bundle", "unbundle", bundle)
	ref := "refs/smithers/branches/" + branch + "/head"
	git("-C", repo, "update-ref", ref, base)
	export := GitBundleExporter(func(_ context.Context, id string) (string, error) { require.Equal(t, branch, id); return repo, nil })
	// Recover an abandoned private transfer ref under the maintenance exclusion.
	git("-C", repo, "update-ref", "refs/smithers/xfer/2147483648", head)
	source, err := export(t.Context(), branch, base, 0x80000000)
	require.NoError(t, err)
	snapshot := source.(*exportedBundle)
	path := snapshot.Name()
	stat, err := snapshot.Stat()
	require.NoError(t, err)
	require.Equal(t, os.FileMode(0600), stat.Mode().Perm())
	require.Empty(t, git("-C", repo, "for-each-ref", "refs/smithers/xfer"))
	require.Equal(t, base, git("-C", repo, "rev-parse", ref))
	// Moving the branch after export cannot change the completed snapshot.
	git("-C", repo, "update-ref", ref, head)
	bytes, err := io.ReadAll(source)
	require.NoError(t, err)
	require.Contains(t, string(bytes[:min(len(bytes), 200)]), base+" refs/smithers/xfer/2147483648\n")
	target := filepath.Join(t.TempDir(), "target")
	git("init", "--bare", target)
	require.Equal(t, base+" refs/smithers/xfer/2147483648", git("-C", target, "bundle", "unbundle", path))
	require.Equal(t, "before", git("-C", target, "show", base+":README.md"))
	require.Empty(t, git("-C", target, "for-each-ref"), "unbundle must not publish advertised refs")
	require.NoError(t, source.Close())
	_, err = os.Stat(path)
	require.True(t, os.IsNotExist(err))
	require.Equal(t, head, git("-C", repo, "rev-parse", ref))
	require.Equal(t, base, git("-C", repo, "rev-parse", "refs/heads/main"))
}

func TestGitBundleExporterRefusesForeignStaleAndCancelledRequests(t *testing.T) {
	repo, _, base, head := bundleFixture(t)
	branch := "11111111-1111-4111-8111-111111111111"
	out, err := hostexec.Git(t.Context(), "-C", repo, "update-ref", "refs/smithers/branches/"+branch+"/head", base).CombinedOutput()
	require.NoError(t, err, "%s", out)
	export := GitBundleExporter(func(_ context.Context, b string) (string, error) {
		if b != branch {
			return "", ErrUnauthorized
		}
		return repo, nil
	})
	for _, test := range []struct {
		branch, head string
		stream       uint32
	}{
		{"bad", base, 0x80000000}, {branch, "bad", 0x80000000}, {branch, base, 1}, {branch, head, 0x80000000}, {"22222222-2222-4222-8222-222222222222", base, 0x80000000},
	} {
		t.Run(fmt.Sprintf("%s/%s/%d", test.branch, test.head, test.stream), func(t *testing.T) {
			source, err := export(t.Context(), test.branch, test.head, test.stream)
			require.Error(t, err)
			require.Nil(t, source)
		})
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	source, err := export(ctx, branch, base, 0x80000000)
	require.Error(t, err)
	require.Nil(t, source)
	out, err = hostexec.Git(t.Context(), "-C", repo, "for-each-ref", "refs/smithers/xfer").Output()
	require.NoError(t, err)
	require.Empty(t, out)
	source, err = GitBundleExporter(func(context.Context, string) (string, error) { return "relative", nil })(t.Context(), branch, base, 0x80000000)
	require.ErrorIs(t, err, ErrUnauthorized)
	require.Nil(t, source)
}

func TestHostBundleFileLimitRefusesBeforeWritingExcess(t *testing.T) {
	file, err := os.CreateTemp(t.TempDir(), "limit")
	require.NoError(t, err)
	defer file.Close()
	writer := bundleLimit{file: file, remaining: 3}
	n, err := writer.Write([]byte("abc"))
	require.NoError(t, err)
	require.Equal(t, 3, n)
	n, err = writer.Write([]byte("d"))
	require.Error(t, err)
	require.Zero(t, n)
	stat, err := file.Stat()
	require.NoError(t, err)
	require.Equal(t, int64(3), stat.Size())
}
