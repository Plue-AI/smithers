package services

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/stretchr/testify/require"
)

func TestWikiImportTitleYAMLSemantics(t *testing.T) {
	for _, row := range []struct{ body, want string }{
		{"---\ntitle: >-\n  Engineering guide\n---\n# Skill", "Engineering guide"},
		{"---\ntitle: |\n  Engineering guide\n---\n# Skill", "Engineering guide"},
		{"---\ntitle: 'A: quoted title'\n---\n# Skill", "A: quoted title"},
		{"---\ntitle: 42\n---\n# Heading", "Heading"},
		{"---\ntitle: [broken\n---\n# Heading", "Heading"},
		{"```md\n# Not a heading\n```\n# Real heading", "Real heading"},
		{"No heading", "Home.md"},
	} {
		t.Run(row.want, func(t *testing.T) { require.Equal(t, row.want, importedWikiTitle("Home.md", row.body)) })
	}
}

func TestWikiSyncTitleProvenance(t *testing.T) {
	for _, explicit := range []string{"Person's chosen title", "Home.md", "home", "Original heading"} {
		t.Run(explicit, func(t *testing.T) {
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
				require.NoError(t, svc.SyncWiki(ctx, &actor, actor.Username, repo, "titles", adapter))
			}
			write := func(body string) {
				t.Helper()
				require.NoError(t, os.WriteFile(filepath.Join(folder, "Home.md"), []byte(body), 0600))
			}
			write("# Original heading\n")
			run()
			pages, _, err := svc.ListWikiPages(ctx, &actor, actor.Username, repo, ListWikiPagesInput{})
			require.NoError(t, err)
			require.Len(t, pages, 1)
			page, err := svc.GetWikiPage(ctx, &actor, actor.Username, repo, pages[0].Slug)
			require.NoError(t, err)
			require.Equal(t, "Original heading", page.Title)
			require.Equal(t, "imported", page.TitleSource)
			page, err = svc.UpdateWikiPage(ctx, &actor, actor.Username, repo, page.Slug, UpdateWikiPageInput{Title: &explicit, ExpectedRevision: &page.Revision})
			require.NoError(t, err)
			require.Equal(t, "explicit", page.TitleSource)
			var repositoryID int64
			require.NoError(t, pool.QueryRow(ctx, "SELECT repository_id FROM wiki_pages WHERE id=$1", page.ID).Scan(&repositoryID))
			require.NoError(t, q.RebuildWikiProjection(ctx, repositoryID, "public"))
			run() // Even a filename/previous-heading match is an explicit choice.
			write("# External heading\n")
			run()
			page, err = svc.GetWikiPage(ctx, &actor, actor.Username, repo, page.Slug)
			require.NoError(t, err)
			require.Equal(t, explicit, page.Title)
			require.Equal(t, "explicit", page.TitleSource)
		})
	}
}

func TestWikiSyncImportedTitleUpdatesAndUnknownLegacyPreserved(t *testing.T) {
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
		require.NoError(t, svc.SyncWiki(ctx, &actor, actor.Username, repo, "titles", adapter))
	}
	write := func(body string) {
		t.Helper()
		require.NoError(t, os.WriteFile(filepath.Join(folder, "Home.md"), []byte(body), 0600))
	}
	write("# Original\n")
	run()
	pages, _, err := svc.ListWikiPages(ctx, &actor, actor.Username, repo, ListWikiPagesInput{})
	require.NoError(t, err)
	write("---\ntitle: >-\n  Engineering guide\n---\n# External\n")
	run()
	page, err := svc.GetWikiPage(ctx, &actor, actor.Username, repo, pages[0].Slug)
	require.NoError(t, err)
	require.Equal(t, "Engineering guide", page.Title)
	require.Equal(t, "imported", page.TitleSource)
	index, err := svc.GetWikiIndex(ctx, &actor, actor.Username, repo)
	require.NoError(t, err)
	require.Equal(t, page.Title, index.Pages[0].Title)
	// Pre-migration rows have no reliable title ownership history. Preserve exact
	// bytes rather than treating filename equality as permission to overwrite.
	_, err = pool.Exec(ctx, "UPDATE wiki_pages SET title='Home.md', title_source='unknown' WHERE id=$1", page.ID)
	require.NoError(t, err)
	run() // Establish the baseline after the simulated legacy metadata write.
	write("# Later heading\n")
	run()
	page, err = svc.GetWikiPage(ctx, &actor, actor.Username, repo, page.Slug)
	require.NoError(t, err)
	require.Equal(t, "Home.md", page.Title)
	require.Equal(t, "unknown", page.TitleSource)
	before := page.Revision
	run()
	page, err = svc.GetWikiPage(ctx, &actor, actor.Username, repo, page.Slug)
	require.NoError(t, err)
	require.Equal(t, before, page.Revision)
}
