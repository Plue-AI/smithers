package db

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
)

// `%` and `_` in a search box are text, never LIKE wildcards: a wildcard
// query must not page through the whole user directory or wiki.
func TestSearchTreatsLikeWildcardsLiterally(t *testing.T) {
	ctx := context.Background()
	// User search is global: committed fixtures from other tests can match
	// the full-text token "100" in "100%" even without a literal percent sign.
	pool, _ := postgresfixture.NewProductDatabase(t)
	q := New(pool)

	for _, u := range []struct{ username, display string }{
		{"plainuser", "Plain User"},
		{"snake_case", "100% Real"},
	} {
		_, err := q.CreateUser(ctx, CreateUserParams{
			Username:      u.username,
			LowerUsername: u.username,
			Email:         pgtype.Text{String: u.username + "@example.com", Valid: true},
			LowerEmail:    pgtype.Text{String: u.username + "@example.com", Valid: true},
			DisplayName:   u.display,
		})
		require.NoError(t, err)
	}
	userCount := func(query string) int64 {
		t.Helper()
		total, err := q.CountSearchUsersFTS(ctx, query)
		require.NoError(t, err)
		rows, err := q.SearchUsersFTS(ctx, SearchUsersFTSParams{Query: query, PageSize: 50})
		require.NoError(t, err)
		require.Len(t, rows, int(total))
		return total
	}
	assert.Equal(t, int64(0), userCount("%"), "%% must not match every user")
	assert.Equal(t, int64(0), userCount("_"), "_ must not match every user")
	assert.Equal(t, int64(1), userCount("snake_"), "literal _ still matches")
	assert.Equal(t, int64(1), userCount("100%"), "literal %% still matches")
	assert.Equal(t, int64(1), userCount("plain"), "prefix still matches")

	userID := mustCreateUser(t, pool, "wiki-like-author")
	repoID := mustCreateRepo(t, pool, userID, "wiki-like-repo")
	for _, page := range []CreateWikiPageParams{
		{RepositoryID: repoID, Slug: "home", Title: "Home", Body: "overview", AuthorID: userID},
		{RepositoryID: repoID, Slug: "rates", Title: "Rates", Body: "50% off", AuthorID: userID},
	} {
		_, err := q.CreateWikiPage(ctx, page)
		require.NoError(t, err)
	}
	wikiCount := func(query string) int64 {
		t.Helper()
		total, err := q.CountSearchWikiPagesByRepo(ctx, CountSearchWikiPagesByRepoParams{RepositoryID: repoID, Query: query})
		require.NoError(t, err)
		rows, err := q.SearchWikiPagesByRepo(ctx, SearchWikiPagesByRepoParams{RepositoryID: repoID, Query: query, PageSize: 50})
		require.NoError(t, err)
		require.Len(t, rows, int(total))
		return total
	}
	assert.Equal(t, int64(0), wikiCount("_"), "_ must not match every page")
	assert.Equal(t, int64(1), wikiCount("%"), "%% matches only the page containing it")
	assert.Equal(t, int64(1), wikiCount("OVERVIEW"), "substring match stays case-insensitive")
}
