package machined

import (
	"context"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/smithersai/smithers/packages/backend/hostexec"
	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
	"github.com/stretchr/testify/require"
)

func TestGitCaptureObjects(t *testing.T) {
	repo, bundle, base, head := bundleFixture(t)
	branch := "11111111-1111-4111-8111-111111111111"
	resolve := func(_ context.Context, id string) (string, error) {
		if id != branch {
			return "", ErrUnauthorized
		}
		return repo, nil
	}
	store := GitCaptureObjects{Resolve: resolve}
	git := func(args ...string) string {
		out, err := hostexec.Git(t.Context(), append([]string{"-C", repo}, args...)...).CombinedOutput()
		require.NoError(t, err, "%s", out)
		return strings.TrimSpace(string(out))
	}
	capture := wire.Captured{Head: head, Tree: base, Base: base}
	missing, err := store.VerifyCapture(t.Context(), branch, capture)
	require.NoError(t, err)
	require.Equal(t, []string{head}, missing)
	_, err = store.PublishCapture(t.Context(), branch, capture)
	require.ErrorContains(t, err, "missing capture object")
	file, err := os.Open(bundle)
	require.NoError(t, err)
	defer file.Close()
	require.NoError(t, GitBundleImporter(resolve)(t.Context(), branch, file))
	_, err = store.VerifyCapture(t.Context(), branch, capture)
	require.ErrorIs(t, err, wire.BadValue, "claimed tree must match the commit")
	capture.Tree = git("rev-parse", head+"^{tree}")
	_, err = store.VerifyCapture(t.Context(), "foreign", capture)
	require.ErrorIs(t, err, ErrUnauthorized)
	_, err = (GitCaptureObjects{}).VerifyCapture(t.Context(), branch, capture)
	require.ErrorIs(t, err, ErrUnauthorized)
	bad := capture
	bad.Head = "--all"
	_, err = store.VerifyCapture(t.Context(), branch, bad)
	require.ErrorIs(t, err, wire.BadValue)
	bad.Head = capture.Tree
	_, err = store.VerifyCapture(t.Context(), branch, bad)
	require.ErrorIs(t, err, wire.BadValue, "a tree is not a captured commit")
	// Immutable metadata readers reject options, foreign stores and noncommits.
	tree, err := store.CommitTree(t.Context(), branch, head)
	require.NoError(t, err)
	require.Equal(t, capture.Tree, tree)
	for _, oid := range []string{"--all", capture.Tree, strings.Repeat("f", 40)} {
		_, err = store.CommitTree(t.Context(), branch, oid)
		require.Error(t, err)
	}
	_, err = store.CommitTree(t.Context(), "foreign", head)
	require.ErrorIs(t, err, ErrUnauthorized)
	_, err = store.BranchHead(t.Context(), branch)
	require.Error(t, err, "absent branch head is not a capture identity")
	_, err = store.BranchHead(t.Context(), "foreign")
	require.ErrorIs(t, err, ErrUnauthorized)
	ref := "refs/smithers/branches/" + branch + "/head"
	git("update-ref", ref, base)
	observed, err := store.BranchHead(t.Context(), branch)
	require.NoError(t, err)
	require.Equal(t, base, observed)
	lock := filepath.Join(repo, ref+".lock")
	require.NoError(t, os.WriteFile(lock, nil, 0600))
	_, err = store.PublishCapture(t.Context(), branch, capture)
	require.Error(t, err, "a storage failure is not a stale-base receipt")
	require.Equal(t, base, git("rev-parse", ref))
	require.NoError(t, os.Remove(lock))
	for range 2 {
		applied, err := store.PublishCapture(t.Context(), branch, capture)
		require.NoError(t, err)
		require.True(t, applied)
	}
	git("update-ref", ref, base)
	capture.Base = head
	applied, err := store.PublishCapture(t.Context(), branch, capture)
	require.NoError(t, err)
	require.False(t, applied)
	git("update-ref", "-d", "refs/smithers/branches/"+branch+"/incoming/"+head)
	git("gc", "--prune=now")
	require.Equal(t, base, git("rev-parse", ref))
	require.Equal(t, base, git("rev-parse", "refs/heads/main"))
	require.Equal(t, "acknowledged bytes", git("show", "refs/smithers/branches/"+branch+"/captures/"+head+":README.md"))
	git("update-ref", "-d", ref)
	capture.Base = strings.Repeat("0", 40)
	applied, err = store.PublishCapture(t.Context(), branch, capture)
	require.NoError(t, err)
	require.True(t, applied, "a fresh branch has an absent host head")
	// A commit with a missing reachable tree must never obtain a pin.
	fakeTree := strings.Repeat("1", 40)
	cmd := hostexec.Git(t.Context(), "-C", repo, "hash-object", "-w", "-t", "commit", "--stdin")
	cmd.Stdin = strings.NewReader("tree " + fakeTree + "\nauthor Test <test@example.com> 1 +0000\ncommitter Test <test@example.com> 1 +0000\n\nincomplete\n")
	out, err := cmd.CombinedOutput()
	require.NoError(t, err, "%s", out)
	incomplete := wire.Captured{Head: strings.TrimSpace(string(out)), Tree: fakeTree, Base: head}
	_, err = store.PublishCapture(t.Context(), branch, incomplete)
	require.ErrorContains(t, err, "verify capture graph")
	require.Equal(t, head, git("rev-parse", ref))
	decode := func(s string) []byte { b, err := hex.DecodeString(s); require.NoError(t, err); return b }
	payload := wire.Union(2, wire.Field(1, decode(head)), wire.Field(2, decode(capture.Tree)), wire.Field(3, decode(base)))
	decoded, err := wire.DecodeCaptured(payload)
	require.NoError(t, err)
	require.Equal(t, wire.Captured{Head: head, Tree: capture.Tree, Base: base}, decoded)
	for _, malformed := range [][]byte{nil, {}, payload[:len(payload)-1], append(append([]byte(nil), payload...), 0), wire.Union(4)} {
		_, err := wire.DecodeCaptured(malformed)
		require.Error(t, err)
	}
	cancelled, cancel := context.WithCancel(t.Context())
	cancel()
	_, err = store.VerifyCapture(cancelled, branch, capture)
	require.ErrorIs(t, err, context.Canceled)
}
