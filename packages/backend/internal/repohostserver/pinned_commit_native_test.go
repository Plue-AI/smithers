package repohostserver

import (
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

// A workspace can fetch the exact commit it was pinned to after its bookmark
// advances. The raw SHA is no longer an advertised ref tip, including in v0.
func TestRepoHostPinnedCommit(t *testing.T) {
	h := newNativeRepoHost(t)
	client := h.initRepo()
	first := nativeGit(t, true, "-C", client, "rev-parse", "HEAD")
	var pinned string
	for _, message := range []string{"second", "third", "fourth"} {
		require.NoError(t, os.WriteFile(filepath.Join(client, "a.txt"), []byte(message+"\n"), 0o644))
		nativeGit(t, true, "-C", client, "add", "a.txt")
		nativeGit(t, true, "-C", client, "commit", "--quiet", "-m", message)
		if message == "third" {
			pinned = nativeGit(t, true, "-C", client, "rev-parse", "HEAD")
		}
	}
	nativeGit(t, true, "-C", client, "push", "--quiet", h.remote, "HEAD:refs/heads/feature")
	tip := nativeGit(t, true, "--git-dir", h.gitDir(), "rev-parse", "refs/heads/feature")
	require.NotEqual(t, pinned, tip)
	require.Equal(t, first, nativeGit(t, true, "--git-dir", h.gitDir(), "rev-parse", pinned+"~2"))

	t.Setenv("GIT_PROTOCOL", "version=2")
	// Both clients use repo-host's v0 transport; requesting v2 may downgrade.
	for _, version := range []string{"0", "2"} {
		t.Run("client_protocol_v"+version, func(t *testing.T) {
			for _, tc := range []struct {
				name  string
				depth string
				count string
			}{
				{name: "depth_200", depth: "200", count: "3"},
				{name: "depth_1", depth: "1", count: "1"},
				{name: "full_history", count: "3"},
			} {
				t.Run(tc.name, func(t *testing.T) {
					dir := filepath.Join(t.TempDir(), "fetch")
					nativeGit(t, true, "init", "--quiet", dir)
					args := []string{"-C", dir, "-c", "protocol.version=" + version, "fetch", "--quiet"}
					if tc.depth != "" {
						args = append(args, "--depth", tc.depth)
					}
					args = append(args, h.remote, pinned)
					nativeGit(t, true, args...)
					nativeGit(t, true, "-C", dir, "checkout", "--quiet", "--detach", "FETCH_HEAD")
					require.Equal(t, pinned, nativeGit(t, true, "-C", dir, "rev-parse", "HEAD"))
					content, err := os.ReadFile(filepath.Join(dir, "a.txt"))
					require.NoError(t, err)
					require.Equal(t, "third\n", string(content))
					require.Equal(t, tc.count, nativeGit(t, true, "-C", dir, "rev-list", "--count", "HEAD"))
					nativeGit(t, false, "-C", dir, "cat-file", "-e", tip+"^{commit}")
					if tc.depth == "1" {
						require.Equal(t, "true", nativeGit(t, true, "-C", dir, "rev-parse", "--is-shallow-repository"))
						nativeGit(t, false, "-C", dir, "cat-file", "-e", first+"^{commit}")
					} else {
						require.Equal(t, "false", nativeGit(t, true, "-C", dir, "rev-parse", "--is-shallow-repository"))
					}
				})
			}
		})
	}

	// A syntactically valid but absent object must not become fetchable.
	missing := strings.Repeat("f", 40)
	require.NotEqual(t, missing, pinned)
	for _, version := range []string{"0", "2"} {
		t.Run("unavailable_v"+version, func(t *testing.T) {
			dir := filepath.Join(t.TempDir(), "fetch")
			nativeGit(t, true, "init", "--quiet", dir)
			out := nativeGit(t, false, "-C", dir, "-c", "protocol.version="+version, "fetch", h.remote, missing)
			require.Contains(t, out, missing)
			nativeGit(t, false, "-C", dir, "cat-file", "-e", missing+"^{commit}")
		})
	}

	// These commits have no path from an advertised ref. Even a raw SHA want
	// must not expose jj retention pins or a different person's user ref.
	tree := nativeGit(t, true, "--git-dir", h.gitDir(), "rev-parse", pinned+"^{tree}")
	hidden := []struct {
		name string
		ref  string
	}{
		{name: "jj_pin", ref: "refs/jj/keep/pinned-commit-test"},
		{name: "other_user", ref: repohost.UserRef(43, "pinned-commit-test")},
	}
	h.headers.Set("X-Smithers-Pusher-Id", "42")
	for i, tc := range hidden {
		sha := nativeGit(t, true, "--git-dir", h.gitDir(), "commit-tree", tree, "-p", tip, "-m", tc.name+strconv.Itoa(i))
		nativeGit(t, true, "--git-dir", h.gitDir(), "update-ref", tc.ref, sha)
		require.NotEqual(t, pinned, sha)
		require.Equal(t, tc.ref, nativeGit(t, true, "--git-dir", h.gitDir(), "for-each-ref", "--format=%(refname)", "--points-at", sha))
		for _, version := range []string{"0", "2"} {
			t.Run(tc.name+"_v"+version, func(t *testing.T) {
				dir := filepath.Join(t.TempDir(), "fetch")
				nativeGit(t, true, "init", "--quiet", dir)
				out := nativeGit(t, false, "-C", dir, "-c", "protocol.version="+version, "fetch", h.remote, sha)
				require.Contains(t, out, sha)
				nativeGit(t, false, "-C", dir, "cat-file", "-e", sha+"^{commit}")
			})
		}
	}
}

// The visible-ref reachability check is a v0 stateless upload-pack policy.
// A process environment inherited from an operator must not bypass it.
func TestRepoHostAdvertisementIgnoresInheritedProtocol(t *testing.T) {
	h := newNativeRepoHost(t)
	h.initRepo()
	t.Setenv("GIT_PROTOCOL", "version=2")
	code, body := h.api(http.MethodGet, "/repos/alice/demo/git/info-refs?service=git-upload-pack", nil)
	require.Equal(t, http.StatusOK, code, body)
	require.NotContains(t, body, "version 2\n")
	require.Contains(t, body, "allow-reachable-sha1-in-want")
}
