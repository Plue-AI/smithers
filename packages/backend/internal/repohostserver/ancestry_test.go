package repohostserver

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/stretchr/testify/require"
)

func TestWorkflowPushCommitAncestry(t *testing.T) {
	srv := newTestServer(t)
	gitDir := filepath.Join(srv.config.StoragePath, "alice", "demo", ".jj", "repo", "store", "git")
	require.NoError(t, os.MkdirAll(gitDir, 0755))
	gitWithEnv(t, nil, "init", "--bare", "--quiet", gitDir)
	tip := commitChain(t, gitDir, 3, 0, time.Now(), time.Now())
	old := gitWithEnv(t, nil, "--git-dir", gitDir, "rev-parse", tip+"~2")
	tree := gitWithEnv(t, nil, "--git-dir", gitDir, "rev-parse", tip+"^{tree}")
	side := gitWithEnv(t, nil, "--git-dir", gitDir, "commit-tree", tree, "-p", old, "-m", "side")
	merge := gitWithEnv(t, nil, "--git-dir", gitDir, "commit-tree", tree, "-p", side, "-p", tip, "-m", "merge")
	server := httptest.NewServer(srv.Handler())
	defer server.Close()
	client := repohost.NewClient(&repohost.StaticStorageSetResolver{URL: server.URL}, testAuthToken)
	for _, tc := range []struct {
		name, ancestor, descendant string
		want                       bool
	}{
		{"equal", tip, tip, true}, {"old resolver", old, tip, true}, {"late delivery", tip, old, false},
		{"divergent", side, tip, false}, {"merge second parent", tip, merge, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := client.IsAncestor(t.Context(), "alice", "demo", tc.ancestor, tc.descendant)
			require.NoError(t, err)
			require.Equal(t, tc.want, got)
		})
	}
	for _, ancestor := range []string{"", "--all", "abc", strings.Repeat("f", 40)} {
		got, err := client.IsAncestor(t.Context(), "alice", "demo", ancestor, tip)
		require.Error(t, err)
		require.False(t, got)
	}
	req := httptest.NewRequest(http.MethodGet, "/repos/alice:demo/commits/ancestry?"+url.Values{"ancestor": {old}, "descendant": {tip}}.Encode(), nil)
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	require.Equal(t, http.StatusUnauthorized, rec.Code)
}
