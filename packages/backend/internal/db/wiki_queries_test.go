package db

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestWikiPages_CRUDAndLookup(t *testing.T) {
	q, pool := newQueries(t)

	userID := mustCreateUser(t, pool, "wiki-author")
	repoID := mustCreateRepo(t, pool, userID, "wiki-repo")

	created, err := q.CreateWikiPage(context.Background(), CreateWikiPageParams{
		RepositoryID: repoID,
		Slug:         "home",
		Title:        "Home",
		Body:         "# Welcome",
		AuthorID:     userID,
	})
	require.NoError(t, err)
	assert.Equal(t, "home", created.Slug)
	assert.Equal(t, "Home", created.Title)

	got, err := q.GetWikiPageBySlug(context.Background(), GetWikiPageBySlugParams{
		RepositoryID: repoID,
		Slug:         "home",
	})
	require.NoError(t, err)
	assert.Equal(t, created.ID, got.ID)
	assert.Equal(t, "# Welcome", got.Body)
	assert.Equal(t, "wiki-author", got.AuthorUsername)

	updated, err := q.UpdateWikiPage(context.Background(), UpdateWikiPageParams{
		ID:               created.ID,
		ExpectedRevision: created.Revision,
		Slug:             "start-here",
		Title:            "Start Here",
		Body:             "Updated content",
		AuthorID:         userID,
	})
	require.NoError(t, err)
	assert.Equal(t, "start-here", updated.Slug)
	assert.Equal(t, "Start Here", updated.Title)
	assert.Equal(t, "Updated content", updated.Body)

	deleted, err := q.DeleteWikiPage(context.Background(), DeleteWikiPageParams{ID: updated.ID})
	require.EqualValues(t, 1, deleted)
	require.NoError(t, err)

	_, err = q.GetWikiPageBySlug(context.Background(), GetWikiPageBySlugParams{
		RepositoryID: repoID,
		Slug:         "start-here",
	})
	require.Error(t, err)
}

func TestWikiPages_ListAndSearch(t *testing.T) {
	q, pool := newQueries(t)

	userID := mustCreateUser(t, pool, "wiki-search-author")
	repoID := mustCreateRepo(t, pool, userID, "wiki-search-repo")

	for _, page := range []CreateWikiPageParams{
		{RepositoryID: repoID, Slug: "home", Title: "Home", Body: "General overview", AuthorID: userID},
		{RepositoryID: repoID, Slug: "runbook", Title: "Runbook", Body: "Operational guide", AuthorID: userID},
		{RepositoryID: repoID, Slug: "adr", Title: "Architecture Decision Record", Body: "Design guide", AuthorID: userID},
	} {
		_, err := q.CreateWikiPage(context.Background(), page)
		require.NoError(t, err)
	}

	total, err := q.CountWikiPagesByRepo(context.Background(), CountWikiPagesByRepoParams{RepositoryID: repoID})
	require.NoError(t, err)
	assert.Equal(t, int64(3), total)

	pageOne, err := q.ListWikiPagesByRepo(context.Background(), ListWikiPagesByRepoParams{
		RepositoryID: repoID,
		Limit:        2,
		Offset:       0,
	})
	require.NoError(t, err)
	require.Len(t, pageOne, 2)

	searchTotal, err := q.CountSearchWikiPagesByRepo(context.Background(), CountSearchWikiPagesByRepoParams{
		RepositoryID: repoID,
		Query:        "guide",
	})
	require.NoError(t, err)
	assert.Equal(t, int64(2), searchTotal)

	searchRows, err := q.SearchWikiPagesByRepo(context.Background(), SearchWikiPagesByRepoParams{
		RepositoryID: repoID,
		Query:        "guide",
		PageOffset:   0,
		PageSize:     10,
	})
	require.NoError(t, err)
	require.Len(t, searchRows, 2)
	assert.Equal(t, "adr", searchRows[0].Slug)
	assert.Equal(t, "runbook", searchRows[1].Slug)
}
