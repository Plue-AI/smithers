package services

import (
	"context"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/internal/repohostffi"
	"github.com/smithersai/smithers/packages/backend/internal/repohostserver"
	"github.com/stretchr/testify/require"
	"net/http/httptest"
	"os"
	"testing"
	"time"
)

func TestWikiCollaboration_PostgresNativeLifecycle(t *testing.T) {
	library := os.Getenv("SMITHERS_WIKI_TEST_FFI")
	if library == "" {
		t.Skip("SMITHERS_WIKI_TEST_FFI opts into native+Postgres integration")
	}
	ctx := context.Background()
	pool := getAgentTestPool(t)
	q := db.New(pool)
	userID, repoID := setupTestUserAndRepo(t, pool)
	actor, err := q.GetUserByID(ctx, userID)
	require.NoError(t, err)
	repository, err := q.GetRepoByID(ctx, repoID)
	require.NoError(t, err)
	native := repohostffi.New(library)
	require.NoError(t, native.Load())
	backend, err := repohostserver.NewWithFFI(repohostserver.Config{StoragePath: t.TempDir(), AuthToken: "wiki-test-secret", PushHookCallbackToken: "test-callback"}, native)
	require.NoError(t, err)
	server := httptest.NewServer(backend.Handler())
	defer server.Close()
	host := repohost.NewClient(&repohost.StaticStorageSetResolver{URL: server.URL}, "wiki-test-secret")
	service := newTestWikiService(q, nil, WithWikiCollaboration(q, host))
	page, err := service.CreateWikiPage(ctx, &actor, actor.Username, repository.Name, CreateWikiPageInput{Title: "Home", Body: "Hello 🌎"})
	require.NoError(t, err)
	doc, err := service.GetWikiDocument(ctx, &actor, actor.Username, repository.Name, page.Slug)
	require.NoError(t, err)
	require.Equal(t, int64(1), doc.Page.Revision)
	require.Equal(t, page.UpdatedAt, doc.Page.UpdatedAt)
	count, err := q.CountWikiRevisions(ctx, db.CountWikiRevisionsParams{RepositoryID: repoID, PageID: page.ID})
	require.NoError(t, err)
	require.Equal(t, int64(1), count)

	// Reopening uses the stored causal state and adds neither text nor revisions.
	require.NoError(t, q.RebuildWikiProjection(ctx, repoID, "public"))
	again, err := service.GetWikiDocument(ctx, &actor, actor.Username, repository.Name, page.Slug)
	require.NoError(t, err)
	require.Equal(t, doc.State, again.State)
	require.Equal(t, doc.StateVector, again.StateVector)
	replacement := "Updated 🦉"
	updated, err := service.UpdateWikiPage(ctx, &actor, actor.Username, repository.Name, page.Slug, UpdateWikiPageInput{Body: &replacement, ExpectedRevision: &page.Revision})
	require.NoError(t, err)
	require.Equal(t, int64(2), updated.Revision)
	// Revision fencing and historical reads survive retirement of POST updates.
	_, err = service.UpdateWikiPage(ctx, &actor, actor.Username, repository.Name, page.Slug, UpdateWikiPageInput{Body: &replacement, ExpectedRevision: &page.Revision})
	require.Equal(t, 409, apiStatus(t, err))
	history, total, err := service.ListWikiRevisions(ctx, &actor, actor.Username, repository.Name, page.Slug, 1, 100)
	require.NoError(t, err)
	require.Equal(t, int64(2), total)
	require.Equal(t, "Hello 🌎", history[1].Body)
	require.Equal(t, replacement, history[0].Body)
	reopened := newTestWikiService(q, nil, WithWikiCollaboration(q, host))
	final, err := reopened.GetWikiDocument(ctx, &actor, actor.Username, repository.Name, page.Slug)
	require.NoError(t, err)
	require.Equal(t, replacement, final.Page.Body)
	require.NotEqual(t, doc.State, final.State)
	require.Equal(t, int64(2), final.Page.Revision)
}

type wikiBlockingProjection struct {
	entered chan struct{}
	release chan struct{}
}

func (h wikiBlockingProjection) ProjectWikiRevision(ctx context.Context, _, _ string, _ repohost.WikiRevisionProjection) (string, error) {
	close(h.entered)
	select {
	case <-h.release:
		return "accepted-commit", nil
	case <-ctx.Done():
		return "", ctx.Err()
	}
}

func TestWikiCollaboration_ProjectionFencesParentRename(t *testing.T) {
	if os.Getenv("SMITHERS_WIKI_TEST_FFI") == "" {
		t.Skip("native integration opt-in")
	}
	ctx := context.Background()
	pool := getAgentTestPool(t)
	q := db.New(pool)
	user, repo := setupTestUserAndRepo(t, pool)
	page, err := q.CreateWikiPage(ctx, db.CreateWikiPageParams{RepositoryID: repo, AuthorID: user, Slug: "home", Title: "Home"})
	require.NoError(t, err)
	rows, err := q.ListWikiHistoryRecovery(ctx, 100)
	require.NoError(t, err)
	var row db.ListWikiHistoryRecoveryRow
	for _, r := range rows {
		if r.PageID == page.ID {
			row = r
		}
	}
	require.NotZero(t, row.ID)
	host := wikiBlockingProjection{entered: make(chan struct{}), release: make(chan struct{})}
	done := make(chan error, 1)
	go func() { done <- projectWikiHistoryRevision(ctx, pool, host, row) }()
	select {
	case <-host.entered:
	case <-time.After(5 * time.Second):
		t.Fatal("projection did not enter")
	}
	// SQL UPDATE must wait on the SHARE lock held by the remote projection.
	tx, err := pool.Begin(ctx)
	require.NoError(t, err)
	_, err = tx.Exec(ctx, `SET LOCAL lock_timeout = '100ms'`)
	require.NoError(t, err)
	_, err = tx.Exec(ctx, `UPDATE repositories SET description='concurrent rename/transfer metadata' WHERE id=$1`, repo)
	var pgErr *pgconn.PgError
	require.ErrorAs(t, err, &pgErr)
	require.Equal(t, "55P03", pgErr.Code)
	require.NoError(t, tx.Rollback(ctx))
	close(host.release)
	require.NoError(t, <-done)
	_, err = pool.Exec(ctx, `UPDATE repositories SET description='after projection' WHERE id=$1`, repo)
	require.NoError(t, err)
}
