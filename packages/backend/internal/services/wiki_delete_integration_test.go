package services

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// A delete at a revision removes the page only while it is still at that
// revision, in storage: a save that lands after the caller read the page is
// kept (smithersai/smithers#2175).
func TestWikiDeleteAtRevisionKeepsALaterSave(t *testing.T) {
	ctx := context.Background()
	pool := getAgentTestPool(t)
	q := db.New(pool)
	userID, repoID := setupTestUserAndRepo(t, pool)
	actor, err := q.GetUserByID(ctx, userID)
	require.NoError(t, err)
	repository, err := q.GetRepoByID(ctx, repoID)
	require.NoError(t, err)
	service := NewWikiService(q, nil)
	page, err := service.CreateWikiPage(ctx, &actor, actor.Username, repository.Name, CreateWikiPageInput{Title: "Generated", Body: "v1"})
	require.NoError(t, err)
	read := page.Revision

	body := "a person's edit"
	edited, err := service.UpdateWikiPage(ctx, &actor, actor.Username, repository.Name, page.Slug, UpdateWikiPageInput{Body: &body})
	require.NoError(t, err)
	require.Greater(t, edited.Revision, read)

	// Storage refuses the stale revision even when the caller's check passed.
	for _, deleted := range []func() (int64, error){
		func() (int64, error) {
			return q.DeleteWikiPage(ctx, db.DeleteWikiPageParams{ID: page.ID, ExpectedRevision: pgtype.Int8{Int64: read, Valid: true}})
		},
		func() (int64, error) {
			return q.DeleteWikiPageAsActor(ctx, db.DeleteWikiPageAsActorParams{PageID: page.ID, ActorID: actor.ID, ExpectedRevision: pgtype.Int8{Int64: read, Valid: true}})
		},
	} {
		n, err := deleted()
		require.NoError(t, err)
		require.Zero(t, n)
	}
	require.Equal(t, 409, apiStatus(t, service.DeleteWikiPageAtRevision(ctx, &actor, actor.Username, repository.Name, page.Slug, read)))
	kept, err := service.GetWikiPage(ctx, &actor, actor.Username, repository.Name, page.Slug)
	require.NoError(t, err)
	require.Equal(t, body, kept.Body)

	require.NoError(t, service.DeleteWikiPageAtRevision(ctx, &actor, actor.Username, repository.Name, page.Slug, edited.Revision))
	_, err = service.GetWikiPage(ctx, &actor, actor.Username, repository.Name, page.Slug)
	require.Equal(t, 404, apiStatus(t, err))
}
