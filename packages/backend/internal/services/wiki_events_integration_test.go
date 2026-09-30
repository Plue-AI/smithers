package services

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/blob"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/stretchr/testify/require"
)

func TestWikiProduct_PostgresContentEventsAndAttachments(t *testing.T) {
	ctx := context.Background()
	pool := getAgentTestPool(t)
	q := db.New(pool)
	userID, repoID := setupTestUserAndRepo(t, pool)
	actor, err := q.GetUserByID(ctx, userID)
	require.NoError(t, err)
	repo, err := q.GetRepoByID(ctx, repoID)
	require.NoError(t, err)
	store := blob.NewMemoryStore()
	s := newTestWikiService(q, nil, WithWikiCollaboration(q, nil), WithWikiContent(store))
	private, err := WithWikiVisibility(ctx, "private")
	require.NoError(t, err)
	page, err := s.CreateWikiPage(private, &actor, actor.Username, repo.Name, CreateWikiPageInput{Title: "Home", Body: "![[assets/diagram.png]]"})
	require.NoError(t, err)
	image := []byte{137, 80, 78, 71, 13, 10, 26, 10}
	file, err := s.PutWikiAttachment(private, &actor, actor.Username, repo.Name, WikiAttachmentSlug("assets/diagram.png", wikiDigest(image)), PutWikiAttachmentInput{Path: "assets/diagram.png", MediaType: "image/png", Data: image})
	require.NoError(t, err)
	require.NotNil(t, file.Attachment)
	require.Equal(t, wikiDigest(image), file.ContentDigest)
	index, err := s.GetWikiIndex(private, &actor, actor.Username, repo.Name)
	require.NoError(t, err)
	for _, p := range index.Pages {
		if p.ID == page.ID {
			require.Equal(t, file.ID, *p.Metadata.Links[0].PageID)
		}
	}
	changed := append(append([]byte{}, image...), 1)
	file2, err := s.PutWikiAttachment(private, &actor, actor.Username, repo.Name, file.Slug, PutWikiAttachmentInput{Path: "assets/diagram.png", MediaType: "image/png", Data: changed, ExpectedRevision: file.Revision})
	require.NoError(t, err)
	require.Equal(t, int64(2), file2.Revision)
	_, err = s.PutWikiAttachment(private, &actor, actor.Username, repo.Name, file.Slug, PutWikiAttachmentInput{Path: "assets/diagram.png", MediaType: "image/png", Data: image, ExpectedRevision: file.Revision})
	require.Equal(t, 409, apiStatus(t, err))
	content, err := s.GetWikiRevisionContent(private, &actor, actor.Username, repo.Name, file.ID, 1)
	require.NoError(t, err)
	require.Equal(t, image, content.Data)
	content, err = s.GetWikiRevisionContent(private, &actor, actor.Username, repo.Name, file.ID, 2)
	require.NoError(t, err)
	require.Equal(t, changed, content.Data)
	_, err = s.GetWikiRevisionContent(ctx, &actor, actor.Username, repo.Name, file.ID, 1)
	require.Equal(t, 404, apiStatus(t, err))
	_, err = s.GetWikiRevisionContent(private, nil, actor.Username, repo.Name, file.ID, 1)
	require.Equal(t, 403, apiStatus(t, err))
	require.NoError(t, s.DeleteWikiPage(private, &actor, actor.Username, repo.Name, file.Slug))
	history, total, err := s.ListWikiPageHistory(private, &actor, actor.Username, repo.Name, file.ID, 1, 100)
	require.NoError(t, err)
	require.Equal(t, int64(3), total)
	require.True(t, history[0].Deleted)
	_, _, err = s.ListWikiPageHistory(ctx, &actor, actor.Username, repo.Name, file.ID, 1, 100)
	require.Equal(t, 404, apiStatus(t, err))
	content, err = s.GetWikiRevisionContent(private, &actor, actor.Username, repo.Name, file.ID, 1)
	require.NoError(t, err)
	require.Equal(t, image, content.Data)
	events, err := s.ListWikiEvents(private, &actor, actor.Username, repo.Name, 0)
	require.NoError(t, err)
	require.Len(t, events, 4)
	whole, err := FoldWikiEvents(WikiProjection{}, events)
	require.NoError(t, err)
	require.Len(t, whole.Pages, 1)
	require.Equal(t, page.ContentDigest, whole.Pages[page.ID].ContentDigest)
	prefix, err := FoldWikiEvents(WikiProjection{}, events[:2])
	require.NoError(t, err)
	encoded, err := json.Marshal(prefix)
	require.NoError(t, err)
	var checkpoint WikiProjection
	require.NoError(t, json.Unmarshal(encoded, &checkpoint))
	resumed, err := FoldWikiEvents(checkpoint, events[2:])
	require.NoError(t, err)
	require.Equal(t, whole, resumed)
	replayed, err := FoldWikiEvents(whole, events)
	require.NoError(t, err)
	require.Equal(t, whole, replayed)
	_, err = FoldWikiEvents(WikiProjection{}, events[1:])
	require.Error(t, err)
	suffix, err := s.ListWikiEvents(private, &actor, actor.Username, repo.Name, 2)
	require.NoError(t, err)
	require.Equal(t, events[2:], suffix)
	// Rebuild the actual SQL search/page projection from the retained events.
	before, err := s.GetWikiIndex(private, &actor, actor.Username, repo.Name)
	require.NoError(t, err)
	require.NoError(t, q.RebuildWikiProjection(ctx, repoID, "private"))
	afterIndex, err := s.GetWikiIndex(private, &actor, actor.Username, repo.Name)
	require.NoError(t, err)
	require.Equal(t, before, afterIndex)
	afterEvents, err := s.ListWikiEvents(private, &actor, actor.Username, repo.Name, 0)
	require.NoError(t, err)
	require.Equal(t, events, afterEvents)
	// Event contents cannot be silently rewritten, but projection receipts can.
	_, err = pool.Exec(ctx, `UPDATE wiki_page_revisions SET body='tampered' WHERE page_id=$1`, page.ID)
	require.Error(t, err)
	// Content corruption fails closed, including historical attachments.
	require.NoError(t, store.Put(ctx, wikiContentKey(repoID, "private", file.ContentDigest), "application/octet-stream", bytes.NewReader([]byte("corrupt"))))
	_, err = s.GetWikiRevisionContent(private, &actor, actor.Username, repo.Name, file.ID, 1)
	require.Equal(t, 503, apiStatus(t, err))
	// SQL snapshots from pre-CAS installations hydrate exact bytes on demand.
	require.NoError(t, store.Delete(ctx, wikiContentKey(repoID, "private", page.ContentDigest)))
	got, err := s.GetWikiPage(private, &actor, actor.Username, repo.Name, page.Slug)
	require.NoError(t, err)
	require.Equal(t, page.Body, got.Body)
	exists, err := store.Exists(ctx, wikiContentKey(repoID, "private", page.ContentDigest))
	require.NoError(t, err)
	require.True(t, exists)
}

func TestWikiProduct_PostgresCursorCommitOrder(t *testing.T) {
	ctx := context.Background()
	pool := getAgentTestPool(t)
	q := db.New(pool)
	userID, repoID := setupTestUserAndRepo(t, pool)
	tx, err := pool.Begin(ctx)
	require.NoError(t, err)
	defer tx.Rollback(ctx)
	first, err := db.New(tx).CreateWikiPage(ctx, db.CreateWikiPageParams{RepositoryID: repoID, AuthorID: userID, Slug: "first", Title: "First"})
	require.NoError(t, err)
	started := make(chan struct{})
	done := make(chan error, 1)
	go func() {
		close(started)
		_, err := q.CreateWikiPage(ctx, db.CreateWikiPageParams{RepositoryID: repoID, AuthorID: userID, Slug: "second", Title: "Second"})
		done <- err
	}()
	<-started
	select {
	case err := <-done:
		t.Fatalf("second write escaped commit-order fence: %v", err)
	case <-time.After(100 * time.Millisecond):
	}
	rows, err := q.ListWikiEvents(ctx, db.ListWikiEventsParams{RepositoryID: repoID, Visibility: "public", Limit: 100})
	require.NoError(t, err)
	require.Empty(t, rows)
	require.NoError(t, tx.Commit(ctx))
	require.NoError(t, <-done)
	rows, err = q.ListWikiEvents(ctx, db.ListWikiEventsParams{RepositoryID: repoID, Visibility: "public", Limit: 100})
	require.NoError(t, err)
	require.Len(t, rows, 2)
	require.Equal(t, first.ID, rows[0].PageID)
	require.Equal(t, int64(1), rows[0].Sequence)
	require.Equal(t, int64(2), rows[1].Sequence)
}

func TestWikiProduct_PostgresFilesystemRestart(t *testing.T) {
	ctx := context.Background()
	pool := getAgentTestPool(t)
	q := db.New(pool)
	userID, repoID := setupTestUserAndRepo(t, pool)
	actor, err := q.GetUserByID(ctx, userID)
	require.NoError(t, err)
	repo, err := q.GetRepoByID(ctx, repoID)
	require.NoError(t, err)
	config := blob.FilesystemConfig{Root: t.TempDir(), PublicBaseURL: "http://127.0.0.1:8080"}
	store, err := blob.NewFilesystemStore(config)
	require.NoError(t, err)
	s := NewWikiService(q, nil, WithWikiContent(store), WithWikiCollaboration(q, nil))
	page, err := s.CreateWikiPage(ctx, &actor, actor.Username, repo.Name, CreateWikiPageInput{Title: "Persisted", Body: "---\ntags: [restart]\n---\n[[Other]]"})
	require.NoError(t, err)
	file, err := s.PutWikiAttachment(ctx, &actor, actor.Username, repo.Name, WikiAttachmentSlug("assets/file.bin", wikiDigest([]byte{0, 1, 2, 255})), PutWikiAttachmentInput{Path: "assets/file.bin", MediaType: "application/octet-stream", Data: []byte{0, 1, 2, 255}})
	require.NoError(t, err)
	require.NoError(t, store.Close())
	reopened, err := blob.NewFilesystemStore(config)
	require.NoError(t, err)
	defer reopened.Close()
	s = NewWikiService(q, nil, WithWikiContent(reopened), WithWikiCollaboration(q, nil))
	body, err := s.GetWikiRevisionContent(ctx, &actor, actor.Username, repo.Name, page.ID, 1)
	require.NoError(t, err)
	require.Equal(t, page.Body, string(body.Data))
	asset, err := s.GetWikiRevisionContent(ctx, &actor, actor.Username, repo.Name, file.ID, 1)
	require.NoError(t, err)
	require.Equal(t, []byte{0, 1, 2, 255}, asset.Data)
	require.NoError(t, q.RebuildWikiProjection(ctx, repoID, "public"))
	restored, err := s.GetWikiPage(ctx, &actor, actor.Username, repo.Name, file.Slug)
	require.NoError(t, err)
	require.Equal(t, file.Attachment, restored.Attachment)
}

// A delayed content read must not publish data after collaborator revocation.
type wikiRevokingReader struct {
	blob.Store
	revoke func()
}

func (s wikiRevokingReader) NewReader(ctx context.Context, key string) (io.ReadCloser, error) {
	reader, err := s.Store.NewReader(ctx, key)
	if err == nil {
		s.revoke()
	}
	return reader, err
}
func TestWikiProduct_PostgresRevocationDuringContentRead(t *testing.T) {
	ctx := context.Background()
	pool := getAgentTestPool(t)
	q := db.New(pool)
	userID, repoID := setupTestUserAndRepo(t, pool)
	readerID, _ := setupTestUserAndRepo(t, pool)
	actor, err := q.GetUserByID(ctx, userID)
	require.NoError(t, err)
	reader, err := q.GetUserByID(ctx, readerID)
	require.NoError(t, err)
	repo, err := q.GetRepoByID(ctx, repoID)
	require.NoError(t, err)
	private, err := WithWikiVisibility(ctx, "private")
	require.NoError(t, err)
	store := blob.NewMemoryStore()
	s := NewWikiService(q, nil, WithWikiContent(store), WithWikiCollaboration(q, nil))
	page, err := s.CreateWikiPage(private, &actor, actor.Username, repo.Name, CreateWikiPageInput{Title: "Private", Body: "secret"})
	require.NoError(t, err)
	s = NewWikiService(q, nil, WithWikiContent(wikiRevokingReader{Store: store, revoke: func() {
		_, err := pool.Exec(ctx, `DELETE FROM collaborators WHERE repository_id=$1 AND user_id=$2`, repoID, readerID)
		require.NoError(t, err)
	}}), WithWikiCollaboration(q, nil))
	for _, operation := range []string{"page", "events", "revision"} {
		t.Run(operation, func(t *testing.T) {
			_, err := pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,'read')`, repoID, readerID)
			require.NoError(t, err)
			switch operation {
			case "page":
				_, err = s.GetWikiPage(private, &reader, actor.Username, repo.Name, page.Slug)
			case "events":
				_, err = s.ListWikiEvents(private, &reader, actor.Username, repo.Name, 0)
			case "revision":
				_, err = s.GetWikiRevisionContent(private, &reader, actor.Username, repo.Name, page.ID, 1)
			}
			require.Equal(t, 403, apiStatus(t, err))
		})
	}
}

func TestWikiProduct_PostgresIndexCheckpoint(t *testing.T) {
	ctx := context.Background()
	pool := getAgentTestPool(t)
	q := db.New(pool)
	userID, repoID := setupTestUserAndRepo(t, pool)
	actor, err := q.GetUserByID(ctx, userID)
	require.NoError(t, err)
	repo, err := q.GetRepoByID(ctx, repoID)
	require.NoError(t, err)
	s := newTestWikiService(q, nil, WithWikiCollaboration(q, nil), WithWikiContent(blob.NewMemoryStore()))
	private, err := WithWikiVisibility(ctx, "private")
	require.NoError(t, err)

	empty, err := s.GetWikiIndex(private, &actor, actor.Username, repo.Name)
	require.NoError(t, err)
	require.Zero(t, empty.Checkpoint)

	first, err := s.CreateWikiPage(private, &actor, actor.Username, repo.Name, CreateWikiPageInput{Title: "Home", Body: "one"})
	require.NoError(t, err)
	_, err = s.CreateWikiPage(private, &actor, actor.Username, repo.Name, CreateWikiPageInput{Title: "Guide", Body: "two"})
	require.NoError(t, err)
	index, err := s.GetWikiIndex(private, &actor, actor.Username, repo.Name)
	require.NoError(t, err)
	events, err := s.ListWikiEvents(private, &actor, actor.Username, repo.Name, 0)
	require.NoError(t, err)
	require.Len(t, events, 2)
	require.Equal(t, events[len(events)-1].Sequence, index.Checkpoint)
	after, err := s.ListWikiEvents(private, &actor, actor.Username, repo.Name, index.Checkpoint)
	require.NoError(t, err)
	require.Empty(t, after)

	// The scopes count separately: the public wiki has no events yet.
	public, err := s.GetWikiIndex(ctx, &actor, actor.Username, repo.Name)
	require.NoError(t, err)
	require.Zero(t, public.Checkpoint)

	changed := "changed"
	// An edit after the checkpoint is exactly the events a resumed fold reads.
	_, err = s.UpdateWikiPage(private, &actor, actor.Username, repo.Name, first.Slug, UpdateWikiPageInput{Body: &changed, ExpectedRevision: &first.Revision})
	require.NoError(t, err)
	tail, err := s.ListWikiEvents(private, &actor, actor.Username, repo.Name, index.Checkpoint)
	require.NoError(t, err)
	require.Len(t, tail, 1)
	require.Equal(t, index.Checkpoint+1, tail[0].Sequence)
	moved, err := s.GetWikiIndex(private, &actor, actor.Username, repo.Name)
	require.NoError(t, err)
	require.Equal(t, tail[0].Sequence, moved.Checkpoint)
}
