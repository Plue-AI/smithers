//go:build cgo

package configsync

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/internal/repohostffi"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
)

type nativeConfigFileClient struct {
	ffi  *repohostffi.Client
	root string
}

func (c nativeConfigFileClient) ListFilesAtChange(_ context.Context, _, _, changeID, prefix string) ([]repohost.ChangeFile, error) {
	return c.ffi.ListTreeFiles(c.root, changeID, prefix)
}

func (c nativeConfigFileClient) GetFileAtChange(_ context.Context, _, _, changeID, path string) (repohost.FileContent, error) {
	return c.ffi.GetFileContent(c.root, changeID, path)
}

// The full YAML still protects main. Only the native read cap makes the
// committed file incomplete, so a sync must fail and retain the SQL row.
func TestSyncFromCommitNativeOversizedValidProtectionPreservesPostgres(t *testing.T) {
	library := os.Getenv("SMITHERS_FFI_LIBRARY_PATH")
	if library == "" {
		t.Skip("set SMITHERS_FFI_LIBRARY_PATH to a built libsmithers_ffi")
	}
	if _, err := exec.LookPath("jj"); err != nil {
		t.Skip("jj is not installed")
	}
	ctx := context.Background()
	pool, _ := postgresfixture.NewProductDatabase(t)
	queries := db.New(pool)
	user, err := queries.CreateUser(ctx, db.CreateUserParams{Username: "alice", LowerUsername: "alice", DisplayName: "Alice"})
	require.NoError(t, err)
	repository, err := queries.CreateRepo(ctx, db.CreateRepoParams{
		UserID: pgtype.Int8{Int64: user.ID, Valid: true}, Name: "demo", LowerName: "demo", DefaultBookmark: "main",
	})
	require.NoError(t, err)
	_, err = queries.UpsertProtectedBookmark(ctx, db.UpsertProtectedBookmarkParams{
		RepositoryID: repository.ID, Pattern: "main", RequireReview: true, RequireHumanApprovals: 1,
	})
	require.NoError(t, err)

	root := filepath.Join(t.TempDir(), "repo")
	out, err := exec.Command("jj", "git", "init", "--no-colocate", root).CombinedOutput()
	require.NoError(t, err, "jj init: %s", out)
	runJJ := func(args ...string) string {
		t.Helper()
		cmd := exec.Command("jj", append([]string{
			"--config", "user.name=Config Test", "--config", "user.email=config@example.invalid", "-R", root,
		}, args...)...)
		output, runErr := cmd.CombinedOutput()
		require.NoError(t, runErr, "jj %v: %s", args, output)
		return strings.TrimSpace(string(output))
	}
	configPath := filepath.Join(root, protectedBookmarksFilePath)
	require.NoError(t, os.MkdirAll(filepath.Dir(configPath), 0o755))
	base := "protected_bookmarks:\n  - pattern: main\n    require_review: true\n    require_human_approvals: 1\n"
	require.NoError(t, os.WriteFile(configPath, []byte(base), 0o644))
	runJJ("describe", "-m", "small protection")
	smallCommit := runJJ("log", "-r", "@", "--no-graph", "-T", "commit_id")
	ffi := repohostffi.New(library)
	require.NoError(t, ffi.Load())
	native := nativeConfigFileClient{ffi: ffi, root: root}
	svc := NewService(queries, native, nil, nil)
	control, err := svc.SyncFromCommit(ctx, SyncInput{RepositoryID: repository.ID, CommitSHA: smallCommit})
	require.NoError(t, err)
	assert.Empty(t, control.Changes)

	// The content is valid YAML over the native 16 MiB file-read limit.
	large := base + "#" + strings.Repeat("x", 16*1024*1024) + "\n"
	require.NoError(t, os.WriteFile(configPath, []byte(large), 0o644))
	runJJ("describe", "-m", "oversized protection")
	largeCommit := runJJ("log", "-r", "@", "--no-graph", "-T", "commit_id")
	require.NotEqual(t, smallCommit, largeCommit)
	parsedFull, err := ParseConfigFiles(map[string][]byte{protectedBookmarksFilePath: []byte(large)})
	require.NoError(t, err)
	require.Len(t, parsedFull.ProtectedBookmarks, 1)
	assert.Equal(t, "main", parsedFull.ProtectedBookmarks[0].Pattern)
	assert.True(t, parsedFull.ProtectedBookmarks[0].RequireReview)
	content, err := native.GetFileAtChange(ctx, "alice", "demo", largeCommit, protectedBookmarksFilePath)
	require.NoError(t, err)
	require.True(t, content.TooLarge)
	assert.Empty(t, content.Content)

	result, err := svc.SyncFromCommit(ctx, SyncInput{RepositoryID: repository.ID, CommitSHA: largeCommit})
	assert.ErrorContains(t, err, protectedBookmarksFilePath)
	assert.Empty(t, result.Changes)
	rules, err := queries.ListAllProtectedBookmarksByRepo(ctx, repository.ID)
	require.NoError(t, err)
	require.Len(t, rules, 1)
	assert.Equal(t, "main", rules[0].Pattern)
	assert.True(t, rules[0].RequireReview)
	assert.Equal(t, int64(1), rules[0].RequireHumanApprovals)
}
