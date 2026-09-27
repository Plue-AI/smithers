package services

import (
	"bytes"
	"context"
	"log/slog"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/internal/repohostffi"
	"github.com/smithersai/smithers/packages/backend/internal/repohostserver"
)

// #2237: case variants made before repo-host refused them block the
// canonical refs. The repair runs against real Postgres rows and a real
// repo-host (jj + git stores), and a second run changes nothing.
func TestRefCaseCollisionRepair_PostgresNative(t *testing.T) {
	library := os.Getenv("SMITHERS_FFI_LIBRARY_PATH")
	if library == "" {
		t.Skip("set SMITHERS_FFI_LIBRARY_PATH to the built smithers-ffi library")
	}
	ctx := context.Background()
	pool := getAgentTestPool(t)
	q := db.New(pool)
	_, repoID := setupTestUserAndRepo(t, pool)
	repository, err := q.GetRepoByID(ctx, repoID)
	require.NoError(t, err)
	owner, err := q.GetUserByID(ctx, repository.UserID.Int64)
	require.NoError(t, err)
	_, err = q.UpsertProtectedBookmark(ctx, db.UpsertProtectedBookmarkParams{RepositoryID: repoID, Pattern: "release/*", RequiredChecks: []string{}, RequiredStatusContexts: []string{}})
	require.NoError(t, err)
	// A repository row without a store is counted, not failed.
	setupTestUserAndRepo(t, pool)

	cfg := repohostserver.Config{StoragePath: t.TempDir(), AuthToken: "case-collision", FFILibraryPath: library}
	native := repohostffi.New(library)
	require.NoError(t, native.Load())
	repoPath := cfg.RepoPath(owner.Username, repository.Name)
	gitDir := cfg.GitBackendPath(owner.Username, repository.Name)
	_, err = native.InitRepo(repoPath)
	require.NoError(t, err)
	git := func(args ...string) string {
		t.Helper()
		cmd := exec.Command("git", append([]string{"--git-dir", gitDir}, args...)...)
		cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@example.invalid", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@example.invalid")
		out, err := cmd.CombinedOutput()
		require.NoError(t, err, "git %v: %s", args, out)
		return strings.TrimSpace(string(out))
	}
	git("symbolic-ref", "HEAD", "refs/heads/main")
	empty := git("mktree")
	commit := func(message string) string { return git("commit-tree", empty, "-m", message) }
	oids := map[string]string{
		"refs/heads/Mythical":  commit("legacy mythical"),
		"refs/notes/Mythical":  commit("legacy notes"),
		"refs/heads/MAIN":      commit("legacy main"),
		"refs/heads/Release/1": commit("legacy release"),
		"refs/heads/release/1": commit("release"),
		"refs/heads/Feature":   commit("Feature"),
		"refs/heads/feature":   commit("feature"),
	}
	// Loose refs are files, and a case-insensitive filesystem holds one of
	// each pair, so the legacy refs are written as packed refs.
	var packed bytes.Buffer
	packed.WriteString("# pack-refs with: peeled fully-peeled sorted \n")
	for _, ref := range sortedKeys(oids) {
		packed.WriteString(oids[ref] + " " + ref + "\n")
	}
	require.NoError(t, os.WriteFile(filepath.Join(gitDir, "packed-refs"), packed.Bytes(), 0o644))
	require.NoError(t, native.ImportGitRefs(repoPath))

	backend, err := repohostserver.NewWithFFI(cfg, native)
	require.NoError(t, err)
	server := httptest.NewServer(backend.Handler())
	defer server.Close()
	host := repohost.NewClient(&repohost.StaticStorageSetResolver{URL: server.URL}, cfg.AuthToken)
	var logs bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&logs, nil))

	counts, err := RepairRefCaseCollisions(ctx, q, host, logger)
	require.NoError(t, err)
	require.GreaterOrEqual(t, counts.Repositories, int64(2))
	require.GreaterOrEqual(t, counts.Missing, int64(1))
	require.Zero(t, counts.Failed)
	require.Equal(t, RefCaseCollisionCounts{Affected: 1, Collisions: 5, Removed: 3, Renamed: 1, Reported: 1},
		RefCaseCollisionCounts{Affected: counts.Affected, Collisions: counts.Collisions, Removed: counts.Removed, Renamed: counts.Renamed, Reported: counts.Reported})
	require.Contains(t, logs.String(), `"action":"renamed"`)

	refs := map[string]string{}
	for _, line := range strings.Split(git("for-each-ref", "--format=%(refname) %(objectname)"), "\n") {
		name, oid, _ := strings.Cut(line, " ")
		refs[name] = oid
	}
	// Every variant's commit is kept by a backup; nothing else moved.
	backups := map[string]string{}
	for name, oid := range refs {
		if rest, ok := strings.CutPrefix(name, repohost.RefCaseCollisionPrefix); ok {
			_, variant, _ := strings.Cut(rest, "/")
			backups["refs/"+variant] = oid
		}
	}
	require.Equal(t, map[string]string{
		"refs/heads/Mythical":  oids["refs/heads/Mythical"],
		"refs/notes/Mythical":  oids["refs/notes/Mythical"],
		"refs/heads/MAIN":      oids["refs/heads/MAIN"],
		"refs/heads/Release/1": oids["refs/heads/Release/1"],
	}, backups)
	for _, gone := range []string{"refs/heads/Mythical", "refs/notes/Mythical", "refs/heads/MAIN", "refs/heads/Release/1"} {
		_, present := refs[gone]
		require.False(t, present, gone)
	}
	require.Equal(t, oids["refs/heads/MAIN"], refs["refs/heads/main"])
	require.Equal(t, oids["refs/heads/release/1"], refs["refs/heads/release/1"])
	require.Equal(t, oids["refs/heads/Feature"], refs["refs/heads/Feature"])
	require.Equal(t, oids["refs/heads/feature"], refs["refs/heads/feature"])

	// jj follows: the removed bookmarks are gone and main is a bookmark.
	bookmarks, err := native.ListBookmarks(repoPath, 1, 100)
	require.NoError(t, err)
	var names []string
	for _, bookmark := range bookmarks.Items {
		names = append(names, bookmark.Name)
	}
	require.ElementsMatch(t, []string{"main", "release/1", "Feature", "feature"}, names)

	// The canonical refs are no longer blocked.
	_, err = host.CreateBookmark(ctx, owner.Username, repository.Name, repohost.CreateBookmarkRequest{Name: "mythical", TargetChangeID: oids["refs/heads/MAIN"]})
	require.NoError(t, err)

	again, err := RepairRefCaseCollisions(ctx, q, host, logger)
	require.NoError(t, err)
	require.Equal(t, int64(1), again.Collisions)
	require.Equal(t, int64(1), again.Reported)
	after := git("for-each-ref", "--format=%(refname)", repohost.RefCaseCollisionPrefix)
	require.Len(t, strings.Split(after, "\n"), 4, "a second run made more backups")
}
