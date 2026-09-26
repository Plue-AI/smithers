package services

import (
	"context"
	"errors"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/internal/repohostffi"
	"github.com/smithersai/smithers/packages/backend/internal/repohostserver"
)

type wikiLostProjectionAck struct {
	WikiHistoryHost
	fail bool
}

func (s *wikiLostProjectionAck) ProjectWikiRevision(ctx context.Context, owner, repo string, input repohost.WikiRevisionProjection) (string, error) {
	commit, err := s.WikiHistoryHost.ProjectWikiRevision(ctx, owner, repo, input)
	if err == nil && s.fail {
		s.fail = false
		return "", errors.New("simulated process loss after JJ commit")
	}
	return commit, err
}

type wikiRevokeDuringMerge struct {
	WikiDocumentHost
	revoke func()
}

func (h wikiRevokeDuringMerge) MergeWikiDocument(ctx context.Context, owner, repo string, input repohost.WikiDocumentRequest) (repohost.WikiDocumentResult, error) {
	result, err := h.WikiDocumentHost.MergeWikiDocument(ctx, owner, repo, input)
	if err == nil {
		h.revoke()
	}
	return result, err
}

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
	_, err = service.ApplyWikiUpdate(ctx, &actor, actor.Username, repository.Name, page.Slug, WikiUpdateInput{PageID: page.ID, UpdateID: uuid.NewString(), Update: "AA=="})
	require.Equal(t, 400, apiStatus(t, err), "native HTTP decode failure must remain a client error")
	// Rebuilding the derived SQL state retains the initialized causal seed.
	require.NoError(t, q.RebuildWikiProjection(ctx, repoID, "public"))
	// CAS initialization is stable for all readers and never duplicates seed text.
	again, err := service.GetWikiDocument(ctx, &actor, actor.Username, repository.Name, page.Slug)
	require.NoError(t, err)
	require.Equal(t, doc.State, again.State)
	replacement := "Updated 🦉"
	merged, err := host.MergeWikiDocument(ctx, actor.Username, repository.Name, repohost.WikiDocumentRequest{Operation: "replace", State: doc.State, Markdown: &replacement})
	require.NoError(t, err)
	input := WikiUpdateInput{PageID: page.ID, UpdateID: uuid.NewString(), Update: merged.State}
	// Race the same UUID. Both callers must receive the original accepted receipt.
	var results [2]WikiUpdateResponse
	var failures [2]error
	var wg sync.WaitGroup
	for i := range results {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			results[i], failures[i] = service.ApplyWikiUpdate(ctx, &actor, actor.Username, repository.Name, page.Slug, input)
		}(i)
	}
	wg.Wait()
	for i := range results {
		require.NoError(t, failures[i])
		require.Equal(t, int64(2), results[i].AcceptedRevision)
		require.Equal(t, replacement, results[i].Document.Page.Body)
	}
	different := input
	different.Update = doc.State
	_, err = service.ApplyWikiUpdate(ctx, &actor, actor.Username, repository.Name, page.Slug, different)
	require.Equal(t, 409, apiStatus(t, err))
	_, err = service.UpdateWikiPage(ctx, &actor, actor.Username, repository.Name, page.Slug, UpdateWikiPageInput{Body: &replacement})
	require.Equal(t, 409, apiStatus(t, err))
	wrongRevision := int64(1)
	_, err = service.UpdateWikiPage(ctx, &actor, actor.Username, repository.Name, page.Slug, UpdateWikiPageInput{Body: &replacement, ExpectedRevision: &wrongRevision})
	require.Equal(t, 409, apiStatus(t, err))
	collaboratorID, _ := setupTestUserAndRepo(t, pool)
	collaborator, err := q.GetUserByID(ctx, collaboratorID)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,'write')`, repoID, collaboratorID)
	require.NoError(t, err)
	revoking := wikiRevokeDuringMerge{WikiDocumentHost: host, revoke: func() {
		_, err := pool.Exec(ctx, `DELETE FROM collaborators WHERE repository_id=$1 AND user_id=$2`, repoID, collaboratorID)
		require.NoError(t, err)
	}}
	revokedService := newTestWikiService(q, nil, WithWikiCollaboration(q, revoking))
	_, err = revokedService.ApplyWikiUpdate(ctx, &collaborator, actor.Username, repository.Name, page.Slug, WikiUpdateInput{PageID: page.ID, UpdateID: uuid.NewString(), Update: merged.State})
	require.Equal(t, 403, apiStatus(t, err), "write permission must be rechecked after remote merge")
	changedSlug := "renamed"
	revision := int64(2)
	_, err = service.UpdateWikiPage(ctx, &actor, actor.Username, repository.Name, page.Slug, UpdateWikiPageInput{Slug: &changedSlug, ExpectedRevision: &revision})
	require.NoError(t, err)
	events, err := service.ListWikiUpdates(ctx, &actor, actor.Username, repository.Name, page.Slug, page.ID, 1)
	require.NoError(t, err)
	require.Len(t, events, 2)
	require.Equal(t, int64(2), events[0].ID)
	require.Equal(t, changedSlug, events[1].Slug)
	// JJ retry after lost DB acknowledgement must return the exact original commit.
	store := &wikiLostProjectionAck{WikiHistoryHost: host, fail: true}
	_, err = ReconcileWikiHistory(ctx, pool, store)
	require.Error(t, err)
	for range 4 {
		_, err = ReconcileWikiHistory(ctx, pool, store)
		require.NoError(t, err)
	}
	histories, _, err := service.ListWikiRevisions(ctx, &actor, actor.Username, repository.Name, changedSlug, 1, 100)
	require.NoError(t, err)
	require.Len(t, histories, 3)
	for _, h := range histories {
		require.NotEmpty(t, h.HistoryCommitID)
	}
	require.NoError(t, service.DeleteWikiPage(ctx, &actor, actor.Username, repository.Name, changedSlug))
	events, err = service.ListWikiUpdates(ctx, &actor, actor.Username, repository.Name, changedSlug, page.ID, 3)
	require.NoError(t, err)
	require.Len(t, events, 1)
	require.True(t, events[0].Deleted)
	for range 2 {
		_, err = ReconcileWikiHistory(ctx, pool, store)
		require.NoError(t, err)
	}
	recreated, err := service.CreateWikiPage(ctx, &actor, actor.Username, repository.Name, CreateWikiPageInput{Title: "Replacement", Slug: changedSlug})
	require.NoError(t, err)
	require.NotEqual(t, page.ID, recreated.ID)
	_, err = service.ApplyWikiUpdate(ctx, &actor, actor.Username, repository.Name, changedSlug, input)
	require.Equal(t, 409, apiStatus(t, err))
	_, err = service.ApplyWikiUpdate(ctx, nil, actor.Username, repository.Name, changedSlug, input)
	require.Equal(t, 401, apiStatus(t, err))
	// Parent deletion must cascade both pages and immutable revision rows cleanly.
	// The repository deletion fixture must honor the existing storage journal fence.
	tx, err := pool.Begin(ctx)
	require.NoError(t, err)
	defer tx.Rollback(ctx)
	token := strings.ReplaceAll(uuid.NewString()+uuid.NewString(), "-", "")
	_, err = tx.Exec(ctx, `INSERT INTO repository_storage_operations(repository_id,operation_type,token,storage_route_key,source_owner,source_repo,source_user_id)
 SELECT r.id,'delete',$2,'static',u.username,r.name,r.user_id FROM repositories r JOIN users u ON u.id=r.user_id WHERE r.id=$1`, repoID, token)
	require.NoError(t, err)
	_, err = tx.Exec(ctx, `SELECT set_config('smithers.repository_storage_operation_token',$1,true)`, token)
	require.NoError(t, err)
	require.NoError(t, db.New(tx).DeleteRepo(ctx, repoID))
	require.NoError(t, tx.Commit(ctx))
	_, err = q.GetWikiDocument(ctx, db.GetWikiDocumentParams{RepositoryID: repoID, Slug: changedSlug})
	require.ErrorIs(t, err, pgx.ErrNoRows)
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
