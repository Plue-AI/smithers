package services

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	api "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/stretchr/testify/require"
)

func requireWikiSyncCode(t *testing.T, err error, code api.Code) {
	t.Helper()
	var apiErr *api.APIError
	require.True(t, errors.As(err, &apiErr), "want %s, got %v", code, err)
	require.Equal(t, code, apiErr.Code)
}

func TestWikiFolderSyncHostPass(t *testing.T) {
	ctx := context.Background()
	pool := newProductTestPool(t)
	actor, repo := issueCovSeedUserRepo(t, pool)
	outsider, _ := issueCovSeedUserRepo(t, pool)
	q := db.New(pool)
	svc := newTestWikiService(q, nil, WithWikiCollaboration(q, nil))
	vault, other := t.TempDir(), t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(vault, "Home.md"), []byte("# Home\n[[Other]]\n"), 0600))
	require.NoError(t, os.WriteFile(filepath.Join(other, "Lost.md"), []byte("# Lost\n"), 0600))
	ghost := WikiFolderSync{Owner: actor.Username, Repo: repo, Login: "no-such-user", Visibility: "private", Connection: "vault", Folder: other}
	reader := WikiFolderSync{Owner: actor.Username, Repo: repo, Login: outsider.Username, Visibility: "public", Connection: "vault", Folder: other}
	vaultSync := WikiFolderSync{Owner: actor.Username, Repo: repo, Login: actor.Username, Visibility: "private", Connection: "vault", Folder: vault}
	missing := WikiFolderSync{Owner: actor.Username, Repo: repo, Login: actor.Username, Visibility: "private", Connection: "missing", Folder: filepath.Join(vault, "absent")}

	// One failing folder never blocks the others; failures sharing a connection name stay distinct.
	failures := svc.SyncWikiFolders(ctx, []WikiFolderSync{ghost, reader, vaultSync, missing})
	require.Len(t, failures, 3)
	requireWikiSyncCode(t, failures[ghost], api.CodeForbidden)
	requireWikiSyncCode(t, failures[reader], api.CodeForbidden)
	require.ErrorIs(t, failures[missing], os.ErrNotExist)
	private, err := WithWikiVisibility(ctx, "private")
	require.NoError(t, err)
	index, err := svc.GetWikiIndex(private, &actor, actor.Username, repo)
	require.NoError(t, err)
	require.Len(t, index.Pages, 1)
	require.Equal(t, "Home.md", index.Pages[0].Path)
	public, err := svc.GetWikiIndex(ctx, &actor, actor.Username, repo)
	require.NoError(t, err)
	require.Empty(t, public.Pages, "a private connection never writes the public scope")

	// Outbound: a page created in the wiki reaches the folder on the next pass.
	_, err = svc.CreateWikiPage(private, &actor, actor.Username, repo, CreateWikiPageInput{Title: "Other", Body: "# Other\n"})
	require.NoError(t, err)
	require.Empty(t, svc.SyncWikiFolders(ctx, []WikiFolderSync{vaultSync}))
	data, err := os.ReadFile(filepath.Join(vault, "other.md"))
	require.NoError(t, err)
	require.Equal(t, "# Other\n", string(data))
	page, err := svc.GetWikiPage(private, &actor, actor.Username, repo, index.Pages[0].Slug)
	require.NoError(t, err)
	require.Empty(t, svc.SyncWikiFolders(ctx, []WikiFolderSync{vaultSync}), "replay is idempotent")
	again, err := svc.GetWikiPage(private, &actor, actor.Username, repo, page.Slug)
	require.NoError(t, err)
	require.Equal(t, page.Revision, again.Revision)

	// Each pass resolves the account again: a login-prohibited or deactivated account stops sync.
	for _, change := range []string{`UPDATE users SET prohibit_login=true WHERE id=$1`, `UPDATE users SET prohibit_login=false, is_active=false WHERE id=$1`} {
		_, err = pool.Exec(ctx, change, actor.ID)
		require.NoError(t, err)
		requireWikiSyncCode(t, svc.SyncWikiFolders(ctx, []WikiFolderSync{vaultSync})[vaultSync], api.CodeForbidden)
	}
}

func TestRunWikiFolderSyncPassesUntilCancelled(t *testing.T) {
	ctx := context.Background()
	pool := newProductTestPool(t)
	actor, repo := issueCovSeedUserRepo(t, pool)
	q := db.New(pool)
	svc := newTestWikiService(q, nil, WithWikiCollaboration(q, nil))
	vault := t.TempDir()
	folders := []WikiFolderSync{{Owner: actor.Username, Repo: repo, Login: actor.Username, Visibility: "public", Connection: "vault", Folder: vault}}
	run, cancel := context.WithCancel(ctx)
	done := make(chan struct{})
	go func() { RunWikiFolderSync(run, svc, folders, 10*time.Millisecond); close(done) }()
	// The channel row commits with the first pass, so the file below needs a later scheduled pass.
	require.Eventually(t, func() bool {
		var count int
		err := pool.QueryRow(ctx, `SELECT count(*) FROM issue_sync_channels WHERE owner_id=$1 AND provider='obsidian'`, actor.ID).Scan(&count)
		return err == nil && count == 1
	}, 10*time.Second, 10*time.Millisecond)
	require.NoError(t, os.WriteFile(filepath.Join(vault, "Later.md"), []byte("# Later\n"), 0600))
	require.Eventually(t, func() bool {
		index, err := svc.GetWikiIndex(ctx, &actor, actor.Username, repo)
		return err == nil && len(index.Pages) == 1
	}, 10*time.Second, 20*time.Millisecond, "a file added after the first pass syncs on a later scheduled pass")
	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("RunWikiFolderSync did not stop after cancellation")
	}
}
