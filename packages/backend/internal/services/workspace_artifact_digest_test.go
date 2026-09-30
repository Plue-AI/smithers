package services

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"math/rand/v2"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func writeArtifactSource(t testing.TB, path string, size int64, seed byte) {
	t.Helper()
	file, err := os.Create(path)
	require.NoError(t, err)
	_, err = io.CopyN(file, rand.NewChaCha8([32]byte{seed}), size)
	require.NoError(t, err)
	require.NoError(t, file.Close())
}

func artifactFileDigest(t testing.TB, path string) string {
	t.Helper()
	content, err := os.ReadFile(path)
	require.NoError(t, err)
	sum := sha256.Sum256(content)
	return hex.EncodeToString(sum[:])
}

func TestWorkspaceArtifactKeyReusesDigestOnlyForUnchangedFile(t *testing.T) {
	dir := t.TempDir()
	source := filepath.Join(dir, "cli.tar")
	writeArtifactSource(t, source, 1<<20, 1)
	sources := func() []workspaceArtifactSource {
		return []workspaceArtifactSource{{source: source, target: "cli.tar.b64", label: "npm CLI package"}}
	}

	first := sources()
	key, err := workspaceArtifactKey(t.Context(), "script", first)
	require.NoError(t, err)
	require.Equal(t, artifactFileDigest(t, source), first[0].digest)

	// Same bytes, same identity: the remembered digest answers.
	again := sources()
	repeated, err := workspaceArtifactKey(t.Context(), "script", again)
	require.NoError(t, err)
	require.Equal(t, key, repeated)

	// A rewrite that restores the size and modification time is served from
	// the cache, and the transfer's own digest check then refuses it.
	info, err := os.Stat(source)
	require.NoError(t, err)
	writeArtifactSource(t, source, 1<<20, 2)
	require.NoError(t, os.Chtimes(source, info.ModTime(), info.ModTime()))
	disguised := sources()
	_, err = workspaceArtifactKey(t.Context(), "script", disguised)
	require.NoError(t, err)
	require.Equal(t, first[0].digest, disguised[0].digest, "unchanged metadata reuses the remembered digest")
	client := &artifactRecordingClient{}
	err = streamWorkspaceArtifactChecked(t.Context(), client, "vm", source, "/guest/cli.tar.b64", disguised[0].digest)
	require.ErrorContains(t, err, "changed during transfer")

	// A visible rewrite (new modification time) is hashed again.
	later := info.ModTime().Add(time.Second)
	require.NoError(t, os.Chtimes(source, later, later))
	rewritten := sources()
	changed, err := workspaceArtifactKey(t.Context(), "script", rewritten)
	require.NoError(t, err)
	require.NotEqual(t, key, changed)
	require.Equal(t, artifactFileDigest(t, source), rewritten[0].digest)

	// A replaced file (new inode) with the same size and time is hashed again.
	replacement := filepath.Join(dir, "replacement.tar")
	writeArtifactSource(t, replacement, 1<<20, 3)
	require.NoError(t, os.Chtimes(replacement, later, later))
	require.NoError(t, os.Rename(replacement, source))
	replaced := sources()
	_, err = workspaceArtifactKey(t.Context(), "script", replaced)
	require.NoError(t, err)
	require.Equal(t, artifactFileDigest(t, source), replaced[0].digest)
}

func TestWorkspaceArtifactKeyConcurrentStartsAgree(t *testing.T) {
	source := filepath.Join(t.TempDir(), "cli.tar")
	writeArtifactSource(t, source, 4<<20, 4)
	want := artifactFileDigest(t, source)
	var wg sync.WaitGroup
	keys := make([]string, 16)
	digests := make([]string, 16)
	errs := make([]error, 16)
	for i := range keys {
		wg.Go(func() {
			sources := []workspaceArtifactSource{{source: source, target: "cli.tar.b64"}}
			keys[i], errs[i] = workspaceArtifactKey(t.Context(), "script", sources)
			digests[i] = sources[0].digest
		})
	}
	wg.Wait()
	for i := range keys {
		require.NoError(t, errs[i])
		require.Equal(t, keys[0], keys[i])
		require.Equal(t, want, digests[i])
	}
}

func TestWorkspaceArtifactKeyCanceledLeaderDoesNotFailFollowers(t *testing.T) {
	source := filepath.Join(t.TempDir(), "cli.tar")
	writeArtifactSource(t, source, 1<<20, 5)
	canceled, cancel := context.WithCancel(t.Context())
	cancel()
	_, err := workspaceArtifactKey(canceled, "script", []workspaceArtifactSource{{source: source, target: "cli.tar.b64"}})
	require.ErrorIs(t, err, context.Canceled)
	sources := []workspaceArtifactSource{{source: source, target: "cli.tar.b64"}}
	_, err = workspaceArtifactKey(t.Context(), "script", sources)
	require.NoError(t, err)
	require.Equal(t, artifactFileDigest(t, source), sources[0].digest, "a canceled read is never remembered")
}

func TestWorkspaceBootstrapDiagnosticKeepsTailAndRedacts(t *testing.T) {
	for _, tc := range []struct {
		name, log  string
		want       []string
		wantAbsent []string
	}{
		{name: "empty", log: "", want: nil},
		{name: "blank lines only", log: "\n\n \t\n", want: nil},
		{
			name: "last lines in order",
			log:  "one\ntwo\nthree\nfour\nfive\nsix\nseven\nerror: nix build failed\n",
			want: []string{"three | four | five | six | seven | error: nix build failed"}, wantAbsent: []string{"two"},
		},
		{
			name: "assignments and headers", log: "export GITHUB_TOKEN=ghp_abcdefghijklmnop123456\nAuthorization: Bearer abc.def.ghi-jkl\npassword: hunter2hunter2\n",
			want:       []string{"GITHUB_TOKEN=[redacted]", "Bearer [redacted]", "password: [redacted]"},
			wantAbsent: []string{"ghp_abcdefghijklmnop123456", "abc.def.ghi-jkl", "hunter2hunter2"},
		},
		{
			name: "url credentials", log: "fatal: unable to access 'https://x-access-token:s3cr3tvalue@github.com/o/r.git/'\n",
			want: []string{"https://[redacted]@github.com/o/r.git/"}, wantAbsent: []string{"s3cr3tvalue", "x-access-token"},
		},
		{
			name: "opaque strings", log: "key 0123456789abcdef0123456789abcdef01 and sk-proj-abcdefghij\n",
			want: []string{"key [redacted] and [redacted]"}, wantAbsent: []string{"0123456789abcdef0123456789abcdef01", "sk-proj-abcdefghij"},
		},
		{
			name: "subscription token", log: "CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-" + strings.Repeat("a", 40) + "\nfailed\n",
			wantAbsent: []string{"sk-ant-oat01"},
		},
		{
			name: "control characters", log: "\x1b[31mred\x1b[0m\ttabbed\x00\n",
			want: []string{"[31mred[0m tabbed"},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := workspaceBootstrapDiagnostic(tc.log)
			if tc.want == nil && tc.wantAbsent == nil {
				require.Empty(t, got)
			}
			for _, want := range tc.want {
				require.Contains(t, got, want)
			}
			for _, absent := range tc.wantAbsent {
				require.NotContains(t, got, absent)
			}
		})
	}
}

func TestWorkspaceBootstrapDiagnosticIsBounded(t *testing.T) {
	line := strings.Repeat("é", 400)
	got := workspaceBootstrapDiagnostic(line + "\n" + line + "\n")
	require.LessOrEqual(t, len(got), workspaceBootstrapDiagnosticBytes+len("…"))
	require.True(t, strings.HasPrefix(got, "…"))
	require.True(t, strings.HasSuffix(got, "é"))
	require.True(t, strings.ToValidUTF8(got, "?") == got, "truncation keeps whole runes")
}

// BenchmarkWorkspaceArtifactKey measures the per-start cost of keying a
// release-sized archive: cold rehashes it, warm reuses the remembered digest.
func BenchmarkWorkspaceArtifactKey(b *testing.B) {
	source := filepath.Join(b.TempDir(), "cli.tar")
	writeArtifactSource(b, source, 64<<20, 6)
	sources := func() []workspaceArtifactSource {
		return []workspaceArtifactSource{{source: source, target: "cli.tar.b64"}}
	}
	b.Run("cold", func(b *testing.B) {
		b.SetBytes(64 << 20)
		for b.Loop() {
			workspaceArtifactDigests.Delete(source)
			if _, err := workspaceArtifactKey(context.Background(), "script", sources()); err != nil {
				b.Fatal(err)
			}
		}
	})
	b.Run("warm", func(b *testing.B) {
		if _, err := workspaceArtifactKey(context.Background(), "script", sources()); err != nil {
			b.Fatal(err)
		}
		for b.Loop() {
			if _, err := workspaceArtifactKey(context.Background(), "script", sources()); err != nil {
				b.Fatal(err)
			}
		}
	})
	b.Run("concurrent-cold", func(b *testing.B) {
		for b.Loop() {
			workspaceArtifactDigests.Delete(source)
			var wg sync.WaitGroup
			for range 8 {
				wg.Go(func() { _, _ = workspaceArtifactKey(context.Background(), "script", sources()) })
			}
			wg.Wait()
		}
	})
}
