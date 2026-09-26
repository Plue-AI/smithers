package services

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

func wikiZString(value string) *string {
	return &value
}

func wikiZPublicOwnedQuerier(actor *db.User) *mockWikiQuerier {
	return &mockWikiQuerier{
		getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			repo := sampleWikiRepository()
			repo.UserID = pgtype.Int8{Int64: actor.ID, Valid: true}
			return repo, nil
		},
		getWikiPageBySlugFn: func(context.Context, db.GetWikiPageBySlugParams) (db.GetWikiPageBySlugRow, error) {
			return sampleWikiPageRow(), nil
		},
		createWikiPageFn: func(_ context.Context, arg db.CreateWikiPageParams) (db.WikiPage, error) {
			now := sampleWikiPageRow().UpdatedAt
			return db.WikiPage{ID: 9, RepositoryID: arg.RepositoryID, Slug: arg.Slug, Title: arg.Title, Body: arg.Body, AuthorID: arg.AuthorID, CreatedAt: now, UpdatedAt: now}, nil
		},
		updateWikiPageFn: func(_ context.Context, arg db.UpdateWikiPageParams) (db.WikiPage, error) {
			now := sampleWikiPageRow().UpdatedAt
			return db.WikiPage{ID: arg.ID, RepositoryID: 42, Slug: arg.Slug, Title: arg.Title, Body: arg.Body, AuthorID: arg.AuthorID, CreatedAt: now, UpdatedAt: now}, nil
		},
	}
}

func TestWiki_Z_ResolveAndPermissionBranches(t *testing.T) {
	ctx := context.Background()
	actor := &db.User{ID: 1, Username: "alice"}
	viewer := &db.User{ID: 2, Username: "bob"}

	_, _, err := newTestWikiService(&mockWikiQuerier{}, nil).ListWikiPages(ctx, nil, "", "demo", ListWikiPagesInput{})
	assert.Equal(t, 400, apiStatus(t, err))
	_, _, err = newTestWikiService(&mockWikiQuerier{}, nil).ListWikiPages(ctx, nil, "alice", "", ListWikiPagesInput{})
	assert.Equal(t, 400, apiStatus(t, err))

	notFoundQ := &mockWikiQuerier{
		getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return db.Repository{}, pgx.ErrNoRows
		},
	}
	_, _, err = newTestWikiService(notFoundQ, nil).ListWikiPages(ctx, nil, "alice", "demo", ListWikiPagesInput{})
	assert.Equal(t, 404, apiStatus(t, err))

	internalQ := &mockWikiQuerier{
		getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return db.Repository{}, errors.New("repo lookup failed")
		},
	}
	_, _, err = newTestWikiService(internalQ, nil).ListWikiPages(ctx, nil, "alice", "demo", ListWikiPagesInput{})
	assert.Equal(t, 500, apiStatus(t, err))

	_, err = newTestWikiService(&mockWikiQuerier{}, nil).GetWikiPage(ctx, nil, "", "demo", "home")
	assert.Equal(t, 400, apiStatus(t, err))
	_, err = newTestWikiService(&mockWikiQuerier{}, nil).CreateWikiPage(ctx, actor, "", "demo", CreateWikiPageInput{Title: "Home"})
	assert.Equal(t, 400, apiStatus(t, err))
	_, err = newTestWikiService(&mockWikiQuerier{}, nil).UpdateWikiPage(ctx, actor, "", "demo", "home", UpdateWikiPageInput{})
	assert.Equal(t, 400, apiStatus(t, err))
	err = newTestWikiService(&mockWikiQuerier{}, nil).DeleteWikiPage(ctx, actor, "", "demo", "home")
	assert.Equal(t, 400, apiStatus(t, err))
	_, _, err = newTestWikiService(&mockWikiQuerier{}, nil).ListWikiRevisions(ctx, nil, "", "demo", "home", 1, 10)
	assert.Equal(t, 400, apiStatus(t, err))

	privateErrQ := &mockWikiQuerier{
		getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return db.Repository{ID: 42, Name: "demo", IsPublic: false, OrgID: pgtype.Int8{Int64: 9, Valid: true}}, nil
		},
		isOrgOwnerForRepoUserFn: func(context.Context, db.IsOrgOwnerForRepoUserParams) (bool, error) {
			return false, errors.New("permission lookup failed")
		},
	}
	_, err = newTestWikiService(privateErrQ, nil).GetWikiPage(ctx, viewer, "acme", "demo", "home")
	assert.Equal(t, 500, apiStatus(t, err))

	privateDeniedQ := &mockWikiQuerier{
		getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return db.Repository{ID: 42, Name: "demo", IsPublic: false, OrgID: pgtype.Int8{Int64: 9, Valid: true}}, nil
		},
	}
	_, err = newTestWikiService(privateDeniedQ, nil).GetWikiPage(ctx, viewer, "acme", "demo", "home")
	assert.Equal(t, 403, apiStatus(t, err))

	_, err = newTestWikiService(wikiZPublicOwnedQuerier(actor), nil).
		CreateWikiPage(ctx, nil, "alice", "demo", CreateWikiPageInput{Title: "Home"})
	assert.Equal(t, 401, apiStatus(t, err))

	_, err = newTestWikiService(privateErrQ, nil).
		CreateWikiPage(ctx, viewer, "acme", "demo", CreateWikiPageInput{Title: "Home"})
	assert.Equal(t, 500, apiStatus(t, err))

	_, err = newTestWikiService(wikiZPublicOwnedQuerier(actor), nil).
		CreateWikiPage(ctx, viewer, "alice", "demo", CreateWikiPageInput{Title: "Home"})
	assert.Equal(t, 403, apiStatus(t, err))

	permission, owner, err := repoPermissionForUser(ctx, wikiZPublicOwnedQuerier(actor), sampleWikiRepository(), 1)
	require.NoError(t, err)
	assert.True(t, owner)
	assert.Empty(t, permission)
}

func TestWiki_Z_PageOperationBranches(t *testing.T) {
	ctx := context.Background()
	actor := &db.User{ID: 1, Username: "alice"}

	page, err := newTestWikiService(wikiZPublicOwnedQuerier(actor), nil).GetWikiPage(ctx, nil, "alice", "demo", "home")
	require.NoError(t, err)
	assert.Equal(t, "home", page.Slug)

	_, err = newTestWikiService(wikiZPublicOwnedQuerier(actor), nil).GetWikiPage(ctx, nil, "alice", "demo", "!!!")
	assert.Equal(t, 422, apiStatus(t, err))

	noPageQ := wikiZPublicOwnedQuerier(actor)
	noPageQ.getWikiPageBySlugFn = func(context.Context, db.GetWikiPageBySlugParams) (db.GetWikiPageBySlugRow, error) {
		return db.GetWikiPageBySlugRow{}, pgx.ErrNoRows
	}
	_, err = newTestWikiService(noPageQ, nil).GetWikiPage(ctx, nil, "alice", "demo", "home")
	assert.Equal(t, 404, apiStatus(t, err))

	_, err = newTestWikiService(wikiZPublicOwnedQuerier(actor), nil).
		CreateWikiPage(ctx, actor, "alice", "demo", CreateWikiPageInput{Title: " "})
	assert.Equal(t, 422, apiStatus(t, err))

	_, err = newTestWikiService(wikiZPublicOwnedQuerier(actor), nil).
		CreateWikiPage(ctx, actor, "alice", "demo", CreateWikiPageInput{Title: "Home", Slug: "!!!"})
	assert.Equal(t, 422, apiStatus(t, err))

	_, err = newTestWikiService(wikiZPublicOwnedQuerier(actor), nil).
		UpdateWikiPage(ctx, actor, "alice", "demo", "!!!", UpdateWikiPageInput{})
	assert.Equal(t, 422, apiStatus(t, err))

	_, err = newTestWikiService(wikiZPublicOwnedQuerier(actor), nil).
		UpdateWikiPage(ctx, nil, "alice", "demo", "home", UpdateWikiPageInput{Body: wikiZString("body")})
	assert.Equal(t, 401, apiStatus(t, err))

	noPageQ = wikiZPublicOwnedQuerier(actor)
	noPageQ.getWikiPageBySlugFn = func(context.Context, db.GetWikiPageBySlugParams) (db.GetWikiPageBySlugRow, error) {
		return db.GetWikiPageBySlugRow{}, pgx.ErrNoRows
	}
	_, err = newTestWikiService(noPageQ, nil).UpdateWikiPage(ctx, actor, "alice", "demo", "home", UpdateWikiPageInput{Body: wikiZString("body")})
	assert.Equal(t, 404, apiStatus(t, err))

	loadErrQ := wikiZPublicOwnedQuerier(actor)
	loadErrQ.getWikiPageBySlugFn = func(context.Context, db.GetWikiPageBySlugParams) (db.GetWikiPageBySlugRow, error) {
		return db.GetWikiPageBySlugRow{}, errors.New("load failed")
	}
	_, err = newTestWikiService(loadErrQ, nil).UpdateWikiPage(ctx, actor, "alice", "demo", "home", UpdateWikiPageInput{Body: wikiZString("body")})
	assert.Equal(t, 500, apiStatus(t, err))

	_, err = newTestWikiService(wikiZPublicOwnedQuerier(actor), nil).
		UpdateWikiPage(ctx, actor, "alice", "demo", "home", UpdateWikiPageInput{Title: wikiZString(" ")})
	assert.Equal(t, 422, apiStatus(t, err))

	_, err = newTestWikiService(wikiZPublicOwnedQuerier(actor), nil).
		UpdateWikiPage(ctx, actor, "alice", "demo", "home", UpdateWikiPageInput{Slug: wikiZString("!!!")})
	assert.Equal(t, 422, apiStatus(t, err))

	updateErrQ := wikiZPublicOwnedQuerier(actor)
	updateErrQ.updateWikiPageFn = func(context.Context, db.UpdateWikiPageParams) (db.WikiPage, error) {
		return db.WikiPage{}, errors.New("update failed")
	}
	_, err = newTestWikiService(updateErrQ, nil).
		UpdateWikiPage(ctx, actor, "alice", "demo", "home", UpdateWikiPageInput{Body: wikiZString("body")})
	assert.Equal(t, 500, apiStatus(t, err))

	err = newTestWikiService(wikiZPublicOwnedQuerier(actor), nil).DeleteWikiPage(ctx, actor, "alice", "demo", "!!!")
	assert.Equal(t, 422, apiStatus(t, err))

	err = newTestWikiService(wikiZPublicOwnedQuerier(actor), nil).DeleteWikiPage(ctx, nil, "alice", "demo", "home")
	assert.Equal(t, 401, apiStatus(t, err))

	err = newTestWikiService(noPageQ, nil).DeleteWikiPage(ctx, actor, "alice", "demo", "home")
	assert.Equal(t, 404, apiStatus(t, err))
}

func TestWiki_Z_RevisionAndNameValidationBranches(t *testing.T) {
	ctx := context.Background()
	actor := &db.User{ID: 1, Username: "alice"}

	privateQ := &mockWikiQuerier{
		getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return db.Repository{ID: 42, Name: "demo", IsPublic: false, UserID: pgtype.Int8{Int64: 1, Valid: true}}, nil
		},
	}
	_, _, err := newTestWikiService(privateQ, nil).ListWikiRevisions(ctx, nil, "alice", "demo", "home", 1, 10)
	assert.Equal(t, 403, apiStatus(t, err))

	_, _, err = newTestWikiService(wikiZPublicOwnedQuerier(actor), nil).ListWikiRevisions(ctx, nil, "alice", "demo", "!!!", 1, 10)
	assert.Equal(t, 422, apiStatus(t, err))

	loadErrQ := wikiZPublicOwnedQuerier(actor)
	loadErrQ.getWikiPageBySlugFn = func(context.Context, db.GetWikiPageBySlugParams) (db.GetWikiPageBySlugRow, error) {
		return db.GetWikiPageBySlugRow{}, errors.New("load failed")
	}
	_, _, err = newTestWikiService(loadErrQ, nil).ListWikiRevisions(ctx, nil, "alice", "demo", "home", 1, 10)
	assert.Equal(t, 500, apiStatus(t, err))

	assert.Equal(t, 422, apiStatus(t, validateWikiName(string([]byte{0xff}), "title")))
	_, err = normalizeWikiTitle("")
	assert.Equal(t, 422, apiStatus(t, err))
	_, err = normalizeWikiTitle("bad\x00title")
	assert.Equal(t, 422, apiStatus(t, err))
}
