package services

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/stretchr/testify/require"
)

func TestWikiSyncObsidianMarkdownExtensionCase(t *testing.T) {
	for _, name := range []string{"Guide.md", "Guide.MD", "Guide.mD", "asset.bin"} {
		t.Run(name, func(t *testing.T) {
			ctx := context.Background()
			pool := newProductTestPool(t)
			actor, repo := issueCovSeedUserRepo(t, pool)
			q := db.New(pool)
			svc := newTestWikiService(q, nil, WithWikiCollaboration(q, nil))
			folder := t.TempDir()
			adapter, err := NewObsidianSync(folder)
			require.NoError(t, err)
			defer adapter.Close()
			body := []byte("# Guide\n")
			require.NoError(t, os.WriteFile(filepath.Join(folder, name), body, 0600))
			require.NoError(t, svc.SyncWiki(ctx, &actor, actor.Username, repo, "case", adapter))
			index, err := svc.GetWikiIndex(ctx, &actor, actor.Username, repo)
			require.NoError(t, err)
			require.Len(t, index.Pages, 1)
			require.Equal(t, name, index.Pages[0].Path)
			page, err := svc.GetWikiPage(ctx, &actor, actor.Username, repo, index.Pages[0].Slug)
			require.NoError(t, err)
			if name == "asset.bin" {
				require.NotNil(t, page.Attachment)
			} else {
				require.Nil(t, page.Attachment)
				require.Equal(t, string(body), page.Body)
			}
		})
	}
}

func TestWikiSyncObsidianRoundTrip(t *testing.T) {
	ctx := context.Background()
	pool := newProductTestPool(t)
	actor, repo := issueCovSeedUserRepo(t, pool)
	q := db.New(pool)
	svc := newTestWikiService(q, nil, WithWikiCollaboration(q, nil))
	folder := t.TempDir()
	adapter, err := NewObsidianSync(folder)
	require.NoError(t, err)
	defer adapter.Close()
	run := func() {
		t.Helper()
		require.NoError(t, svc.SyncWiki(ctx, &actor, actor.Username, repo, "fixture", adapter))
	}
	markdown := "---\ntags: [test]\nunknown: retained\n---\n# Home\n[[Other#Heading|label]]\n"
	require.NoError(t, os.WriteFile(filepath.Join(folder, "Home.md"), []byte(markdown), 0600))
	run()
	pages, _, err := svc.ListWikiPages(ctx, &actor, actor.Username, repo, ListWikiPagesInput{})
	require.NoError(t, err)
	require.Len(t, pages, 1)
	page, err := svc.GetWikiPage(ctx, &actor, actor.Username, repo, pages[0].Slug)
	require.NoError(t, err)
	require.Equal(t, markdown, page.Body)
	run() // duplicate scan must not add a revision
	page2, err := svc.GetWikiPage(ctx, &actor, actor.Username, repo, page.Slug)
	require.NoError(t, err)
	require.Equal(t, page.Revision, page2.Revision)
	// Inbound edit and rename retain the wiki identity.
	require.NoError(t, os.WriteFile(filepath.Join(folder, "Home.md"), []byte(markdown+"local\n"), 0600))
	require.NoError(t, os.Rename(filepath.Join(folder, "Home.md"), filepath.Join(folder, "Renamed.md")))
	run()
	page, err = svc.GetWikiPage(ctx, &actor, actor.Username, repo, page.Slug)
	require.NoError(t, err)
	require.Equal(t, "Renamed.md", page.Path)
	require.Equal(t, markdown+"local\n", page.Body)
	// Outbound edit and rename, then reopen the adapter and service.
	body, path := markdown+"remote\n", "Guides/Remote.md"
	page, err = svc.UpdateWikiPage(ctx, &actor, actor.Username, repo, page.Slug, UpdateWikiPageInput{Body: &body, Path: &path, ExpectedRevision: &page.Revision})
	require.NoError(t, err)
	run()
	data, err := os.ReadFile(filepath.Join(folder, path))
	require.NoError(t, err)
	require.Equal(t, body, string(data))
	_, err = os.Stat(filepath.Join(folder, "Renamed.md"))
	require.True(t, os.IsNotExist(err))
	require.NoError(t, adapter.Close())
	adapter, err = NewObsidianSync(folder)
	require.NoError(t, err)
	defer adapter.Close()
	svc = newTestWikiService(q, nil, WithWikiCollaboration(q, nil), WithWikiContent(svc.content))
	run()
	// Byte-exact attachments in both directions.
	require.NoError(t, os.MkdirAll(filepath.Join(folder, "assets"), 0700))
	binary := []byte{0, 255, 1, 2, 3}
	require.NoError(t, os.WriteFile(filepath.Join(folder, "assets/a.bin"), binary, 0600))
	run()
	index, err := svc.GetWikiIndex(ctx, &actor, actor.Username, repo)
	require.NoError(t, err)
	require.Len(t, index.Pages, 2)
	// A concurrent edit refuses both overwrites and leaves the cursor replayable.
	require.NoError(t, os.WriteFile(filepath.Join(folder, path), []byte("local conflict"), 0600))
	newer := "remote conflict"
	page, err = svc.UpdateWikiPage(ctx, &actor, actor.Username, repo, page.Slug, UpdateWikiPageInput{Body: &newer, ExpectedRevision: &page.Revision})
	require.NoError(t, err)
	require.ErrorContains(t, svc.SyncWiki(ctx, &actor, actor.Username, repo, "fixture", adapter), "conflict")
	data, err = os.ReadFile(filepath.Join(folder, path))
	require.NoError(t, err)
	require.Equal(t, "local conflict", string(data))
	// Resolve by making the copies agree, then delete inbound.
	require.NoError(t, os.WriteFile(filepath.Join(folder, path), []byte(newer), 0600))
	run()
	require.NoError(t, os.Remove(filepath.Join(folder, path)))
	run()
	_, err = svc.GetWikiPage(ctx, &actor, actor.Username, repo, page.Slug)
	require.Error(t, err)
	// Outbound create/delete.
	remote, err := svc.CreateWikiPage(ctx, &actor, actor.Username, repo, CreateWikiPageInput{Title: "Remote", Path: "New.md", Body: markdown})
	require.NoError(t, err)
	run()
	data, err = os.ReadFile(filepath.Join(folder, "New.md"))
	require.NoError(t, err)
	require.Equal(t, markdown, string(data))
	require.NoError(t, svc.DeleteWikiPageAtRevision(ctx, &actor, actor.Username, repo, remote.Slug, remote.Revision))
	run()
	_, err = os.Stat(filepath.Join(folder, "New.md"))
	require.True(t, os.IsNotExist(err))
}

// Lose the provider receipt after the filesystem write. Restart must recognize
// its exact result and settle the original claim, not invent another delivery.
type lostWikiSyncReceipt struct {
	WikiSyncAdapter
	lost  bool
	calls int
}

func (a *lostWikiSyncReceipt) Apply(ctx context.Context, key string, before, after *SyncDocument, data []byte) (*SyncDocument, error) {
	a.calls++
	result, err := a.WikiSyncAdapter.Apply(ctx, key, before, after, data)
	if err == nil && !a.lost {
		a.lost = true
		return nil, fmt.Errorf("simulated lost receipt")
	}
	return result, err
}
func TestWikiSyncReplayAndScopes(t *testing.T) {
	ctx := context.Background()
	pool := newProductTestPool(t)
	actor, repo := issueCovSeedUserRepo(t, pool)
	q := db.New(pool)
	svc := newTestWikiService(q, nil, WithWikiCollaboration(q, nil))
	folder := t.TempDir()
	local, err := NewObsidianSync(folder)
	require.NoError(t, err)
	defer local.Close()
	page, err := svc.CreateWikiPage(ctx, &actor, actor.Username, repo, CreateWikiPageInput{Title: "Page", Path: "Page.md", Body: "public"})
	require.NoError(t, err)
	private, err := WithWikiVisibility(ctx, "private")
	require.NoError(t, err)
	_, err = svc.CreateWikiPage(private, &actor, actor.Username, repo, CreateWikiPageInput{Title: "Page", Path: "Page.md", Body: "private"})
	require.NoError(t, err)
	fault := &lostWikiSyncReceipt{WikiSyncAdapter: local}
	require.ErrorContains(t, svc.SyncWiki(ctx, &actor, actor.Username, repo, "replay", fault), "simulated")
	data, err := os.ReadFile(filepath.Join(folder, "Page.md"))
	require.NoError(t, err)
	require.Equal(t, "public", string(data))
	require.NoError(t, svc.SyncWiki(ctx, &actor, actor.Username, repo, "replay", fault))
	require.Equal(t, 2, fault.calls)
	require.NoError(t, svc.SyncWiki(ctx, &actor, actor.Username, repo, "replay", fault))
	require.Equal(t, 2, fault.calls)
	var count int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM issue_sync_deliveries WHERE document_scope IS NOT NULL`).Scan(&count))
	require.Equal(t, 1, count)
	current, err := svc.GetWikiPage(ctx, &actor, actor.Username, repo, page.Slug)
	require.NoError(t, err)
	require.Equal(t, page.Revision, current.Revision)
	other, _ := issueCovSeedUserRepo(t, pool)
	require.Error(t, svc.SyncWiki(private, &other, actor.Username, repo, "replay", local))
	// Outbound binary content uses the same page/revision stream.
	binary := []byte{0, 255, 128, 10}
	asset, err := svc.PutWikiAttachment(ctx, &actor, actor.Username, repo, "asset", PutWikiAttachmentInput{Path: "asset.bin", MediaType: "application/octet-stream", Data: binary})
	require.NoError(t, err)
	require.NoError(t, svc.SyncWiki(ctx, &actor, actor.Username, repo, "replay", local))
	data, err = os.ReadFile(filepath.Join(folder, "asset.bin"))
	require.NoError(t, err)
	require.Equal(t, binary, data)
	renamed := "renamed.bin"
	_, err = svc.UpdateWikiPage(ctx, &actor, actor.Username, repo, asset.Slug, UpdateWikiPageInput{Path: &renamed, ExpectedRevision: &asset.Revision})
	require.NoError(t, err)
	require.NoError(t, svc.SyncWiki(ctx, &actor, actor.Username, repo, "replay", local))
	data, err = os.ReadFile(filepath.Join(folder, renamed))
	require.NoError(t, err)
	require.Equal(t, binary, data)
}
func TestObsidianSyncBoundaries(t *testing.T) {
	folder := t.TempDir()
	a, err := NewObsidianSync(folder)
	require.NoError(t, err)
	defer a.Close()
	data := []byte("x")
	for _, p := range []string{"../escape.md", "/absolute.md", ".git/config", "dir\\escape.md"} {
		_, err = a.Apply(context.Background(), "key", nil, &SyncDocument{Path: p, Digest: wikiDigest(data)}, data)
		require.Error(t, err)
	}
	outside := t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(outside, "secret.md"), data, 0600))
	require.NoError(t, os.Symlink(outside, filepath.Join(folder, "link")))
	_, err = a.Scan(context.Background())
	require.ErrorContains(t, err, "symlink")
	_, err = a.Apply(context.Background(), "key", nil, &SyncDocument{Path: "link/secret.md", Digest: wikiDigest(data)}, data)
	require.Error(t, err)
}

type unknownWikiSyncAdapter struct{ WikiSyncAdapter }

func (a unknownWikiSyncAdapter) Apply(context.Context, string, *SyncDocument, *SyncDocument, []byte) (*SyncDocument, error) {
	return nil, ErrSyncOutcomeUnknown
}
func TestWikiSyncUnknownReceiptResolution(t *testing.T) {
	ctx := context.Background()
	pool := newProductTestPool(t)
	actor, repo := issueCovSeedUserRepo(t, pool)
	q := db.New(pool)
	svc := newTestWikiService(q, nil, WithWikiCollaboration(q, nil))
	local, err := NewObsidianSync(t.TempDir())
	require.NoError(t, err)
	defer local.Close()
	_, err = svc.CreateWikiPage(ctx, &actor, actor.Username, repo, CreateWikiPageInput{Title: "First", Path: "First.md", Body: "first"})
	require.NoError(t, err)
	require.ErrorIs(t, svc.SyncWiki(ctx, &actor, actor.Username, repo, "unknown", unknownWikiSyncAdapter{local}), ErrSyncOutcomeUnknown)
	rows, err := svc.WikiSyncDeliveries(ctx, &actor, actor.Username, repo)
	require.NoError(t, err)
	require.Len(t, rows, 1)
	receipt := IssueSyncReceipt{Resolution: "retry", State: "pending", ExpectedToken: rows[0].ClaimToken, Error: "accept duplicate risk"}
	require.NotEmpty(t, receipt.ExpectedToken)
	outsider, _ := issueCovSeedUserRepo(t, pool)
	require.Error(t, svc.ResolveWikiSyncDelivery(ctx, &outsider, actor.Username, repo, rows[0].ID, receipt))
	wrong := receipt
	wrong.ExpectedToken = "wrong"
	require.Error(t, svc.ResolveWikiSyncDelivery(ctx, &actor, actor.Username, repo, rows[0].ID, wrong))
	require.NoError(t, svc.ResolveWikiSyncDelivery(ctx, &actor, actor.Username, repo, rows[0].ID, receipt))
	require.Error(t, svc.ResolveWikiSyncDelivery(ctx, &actor, actor.Username, repo, rows[0].ID, receipt))
	require.NoError(t, svc.SyncWiki(ctx, &actor, actor.Username, repo, "unknown", local))
	var raw []byte
	require.NoError(t, pool.QueryRow(ctx, `SELECT document_payload FROM issue_sync_deliveries WHERE id=$1`, rows[0].ID).Scan(&raw))
	require.Contains(t, string(raw), "accept duplicate risk")
	require.NotContains(t, string(raw), receipt.ExpectedToken)
}

func TestWikiSyncSkipUnblocksNextDocument(t *testing.T) {
	ctx := context.Background()
	pool := newProductTestPool(t)
	actor, repo := issueCovSeedUserRepo(t, pool)
	q := db.New(pool)
	svc := newTestWikiService(q, nil, WithWikiCollaboration(q, nil))
	local, err := NewObsidianSync(t.TempDir())
	require.NoError(t, err)
	defer local.Close()
	_, err = svc.CreateWikiPage(ctx, &actor, actor.Username, repo, CreateWikiPageInput{Title: "First", Path: "First.md", Body: "first"})
	require.NoError(t, err)
	require.ErrorIs(t, svc.SyncWiki(ctx, &actor, actor.Username, repo, "skip", unknownWikiSyncAdapter{local}), ErrSyncOutcomeUnknown)
	rows, err := svc.WikiSyncDeliveries(ctx, &actor, actor.Username, repo)
	require.NoError(t, err)
	require.Len(t, rows, 1)
	require.NoError(t, svc.ResolveWikiSyncDelivery(ctx, &actor, actor.Username, repo, rows[0].ID, IssueSyncReceipt{Resolution: "skip", State: "unsupported", ExpectedToken: rows[0].ClaimToken, Error: "owner skips this copy"}))
	_, err = svc.CreateWikiPage(ctx, &actor, actor.Username, repo, CreateWikiPageInput{Title: "Second", Path: "Second.md", Body: "second"})
	require.NoError(t, err)
	require.NoError(t, svc.SyncWiki(ctx, &actor, actor.Username, repo, "skip", local))
	require.NoError(t, svc.SyncWiki(ctx, &actor, actor.Username, repo, "skip", local))
	docs, err := local.Scan(ctx)
	require.NoError(t, err)
	require.Len(t, docs, 1)
	require.Equal(t, "Second.md", docs[0].Path)
}
