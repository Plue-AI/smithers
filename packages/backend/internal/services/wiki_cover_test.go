package services

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/webhooks"
)

type wikiCovFailDispatcher struct {
	calls int
	err   error
}

func (d *wikiCovFailDispatcher) DispatchEvent(context.Context, int64, webhooks.EventType, any) error {
	d.calls++
	return d.err
}

func TestWiki_Cov_RevisionsPermissionsAndSlugging(t *testing.T) {
	ctx := context.Background()
	viewer := &db.User{ID: 7, Username: "reader"}

	t.Run("lists stored revision through private team read access", func(t *testing.T) {
		now := time.Date(2026, 7, 6, 14, 0, 0, 0, time.UTC)
		q := &mockWikiQuerier{
			getRepoByOwnerAndLowerNameFn: func(_ context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				assert.Equal(t, "acme", arg.Owner)
				assert.Equal(t, "demo", arg.LowerName)
				return db.Repository{ID: 42, Name: "demo", IsPublic: false, OrgID: pgtype.Int8{Int64: 9, Valid: true}}, nil
			},
			getHighestTeamPermissionForRepoUserFn: func(context.Context, db.GetHighestTeamPermissionForRepoUserParams) (string, error) {
				return "read", nil
			},
			getWikiPageBySlugFn: func(_ context.Context, arg db.GetWikiPageBySlugParams) (db.GetWikiPageBySlugRow, error) {
				assert.Equal(t, int64(42), arg.RepositoryID)
				assert.Equal(t, "home-page", arg.Slug)
				return db.GetWikiPageBySlugRow{
					ID:             99,
					RepositoryID:   arg.RepositoryID,
					Slug:           arg.Slug,
					Title:          "Home Page",
					AuthorID:       3,
					AuthorUsername: "alice",
					UpdatedAt:      now,
				}, nil
			},
		}

		history := &wikiHistoryFixture{rows: []db.WikiPageRevision{{PageID: 99, RepositoryID: 42, Revision: 1, Slug: "home-page", AuthorID: pgtype.Int8{Int64: 3, Valid: true}, AuthorUsername: "alice", CreatedAt: now}}}
		revisions, total, err := newTestWikiService(q, nil, WithWikiCollaboration(history, nil)).ListWikiRevisions(ctx, viewer, "Acme", "Demo", " Home Page! ", -4, 0)
		require.NoError(t, err)
		assert.Equal(t, int64(1), total)
		require.Len(t, revisions, 1)
		assert.Equal(t, "home-page", revisions[0].Slug)
		assert.Equal(t, "alice", revisions[0].Author.Login)
		assert.Equal(t, now, revisions[0].UpdatedAt)
	})

	t.Run("private repo without viewer is forbidden before listing", func(t *testing.T) {
		q := &mockWikiQuerier{
			getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				return db.Repository{ID: 42, Name: "demo", IsPublic: false, UserID: pgtype.Int8{Int64: 1, Valid: true}}, nil
			},
			countWikiPagesByRepoFn: func(context.Context, int64) (int64, error) {
				t.Fatal("wiki list query should not run without read access")
				return 0, nil
			},
		}

		_, _, err := newTestWikiService(q, nil).ListWikiPages(ctx, nil, "alice", "demo", ListWikiPagesInput{})
		assert.Equal(t, 403, apiStatus(t, err))
	})

	t.Run("org owner write access can delete", func(t *testing.T) {
		deletedID := int64(0)
		q := &mockWikiQuerier{
			getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				return db.Repository{ID: 42, Name: "demo", IsPublic: false, OrgID: pgtype.Int8{Int64: 9, Valid: true}}, nil
			},
			isOrgOwnerForRepoUserFn: func(context.Context, db.IsOrgOwnerForRepoUserParams) (bool, error) {
				return true, nil
			},
			getWikiPageBySlugFn: func(context.Context, db.GetWikiPageBySlugParams) (db.GetWikiPageBySlugRow, error) {
				return sampleWikiPageRow(), nil
			},
			deleteWikiPageFn: func(_ context.Context, id int64) error {
				deletedID = id
				return nil
			},
		}

		err := newTestWikiService(q, nil).DeleteWikiPage(ctx, &db.User{ID: 7, Username: "owner"}, "acme", "demo", "home")
		require.NoError(t, err)
		assert.Equal(t, int64(7), deletedID)
	})

	t.Run("slugify collapses punctuation and trims separators", func(t *testing.T) {
		assert.Equal(t, "hello-go-1-22", slugifyWikiTitle(" -- Hello, Go 1.22!!! "))
		assert.Equal(t, "", slugifyWikiTitle("!!!"))
		_, err := normalizeWikiSlug("!!!")
		assert.Equal(t, 422, apiStatus(t, err))
	})
}

func TestWiki_Cov_ErrorBranches(t *testing.T) {
	ctx := context.Background()
	actor := &db.User{ID: 1, Username: "alice"}
	publicRepo := func() db.Repository {
		return db.Repository{ID: 42, Name: "demo", IsPublic: true, UserID: pgtype.Int8{Int64: actor.ID, Valid: true}}
	}

	t.Run("list count and page failures", func(t *testing.T) {
		svc := newTestWikiService(&mockWikiQuerier{
			getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				return publicRepo(), nil
			},
			countWikiPagesByRepoFn: func(context.Context, int64) (int64, error) {
				return 0, errors.New("count failed")
			},
		}, nil)
		_, _, err := svc.ListWikiPages(ctx, nil, "alice", "demo", ListWikiPagesInput{})
		assert.Equal(t, 500, apiStatus(t, err))

		svc = newTestWikiService(&mockWikiQuerier{
			getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				return publicRepo(), nil
			},
			listWikiPagesByRepoFn: func(context.Context, db.ListWikiPagesByRepoParams) ([]db.ListWikiPagesByRepoRow, error) {
				return nil, errors.New("list failed")
			},
		}, nil)
		_, _, err = svc.ListWikiPages(ctx, nil, "alice", "demo", ListWikiPagesInput{})
		assert.Equal(t, 500, apiStatus(t, err))
	})

	t.Run("search count and page failures", func(t *testing.T) {
		svc := newTestWikiService(&mockWikiQuerier{
			getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				return publicRepo(), nil
			},
			countSearchWikiPagesByRepoFn: func(context.Context, db.CountSearchWikiPagesByRepoParams) (int64, error) {
				return 0, errors.New("search count failed")
			},
		}, nil)
		_, _, err := svc.ListWikiPages(ctx, nil, "alice", "demo", ListWikiPagesInput{Query: "run"})
		assert.Equal(t, 500, apiStatus(t, err))

		svc = newTestWikiService(&mockWikiQuerier{
			getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				return publicRepo(), nil
			},
			searchWikiPagesByRepoFn: func(context.Context, db.SearchWikiPagesByRepoParams) ([]db.SearchWikiPagesByRepoRow, error) {
				return nil, errors.New("search failed")
			},
		}, nil)
		_, _, err = svc.ListWikiPages(ctx, nil, "alice", "demo", ListWikiPagesInput{Query: "run"})
		assert.Equal(t, 500, apiStatus(t, err))
	})

	t.Run("get update delete error mapping", func(t *testing.T) {
		svc := newTestWikiService(&mockWikiQuerier{
			getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				return publicRepo(), nil
			},
			getWikiPageBySlugFn: func(context.Context, db.GetWikiPageBySlugParams) (db.GetWikiPageBySlugRow, error) {
				return db.GetWikiPageBySlugRow{}, errors.New("select failed")
			},
		}, nil)
		_, err := svc.GetWikiPage(ctx, nil, "alice", "demo", "home")
		assert.Equal(t, 500, apiStatus(t, err))

		svc = newTestWikiService(&mockWikiQuerier{
			getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				return publicRepo(), nil
			},
			getWikiPageBySlugFn: func(context.Context, db.GetWikiPageBySlugParams) (db.GetWikiPageBySlugRow, error) {
				return sampleWikiPageRow(), nil
			},
		}, nil)
		_, err = svc.UpdateWikiPage(ctx, actor, "alice", "demo", "home", UpdateWikiPageInput{})
		assert.Equal(t, 400, apiStatus(t, err))

		nextTitle := "Runbook"
		svc = newTestWikiService(&mockWikiQuerier{
			getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				return publicRepo(), nil
			},
			getWikiPageBySlugFn: func(context.Context, db.GetWikiPageBySlugParams) (db.GetWikiPageBySlugRow, error) {
				return sampleWikiPageRow(), nil
			},
			updateWikiPageFn: func(context.Context, db.UpdateWikiPageParams) (db.WikiPage, error) {
				return db.WikiPage{}, &pgconn.PgError{Code: "23505"}
			},
		}, nil)
		_, err = svc.UpdateWikiPage(ctx, actor, "alice", "demo", "home", UpdateWikiPageInput{Title: &nextTitle})
		assert.Equal(t, 409, apiStatus(t, err))

		svc = newTestWikiService(&mockWikiQuerier{
			getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				return publicRepo(), nil
			},
			getWikiPageBySlugFn: func(context.Context, db.GetWikiPageBySlugParams) (db.GetWikiPageBySlugRow, error) {
				return sampleWikiPageRow(), nil
			},
			deleteWikiPageFn: func(context.Context, int64) error {
				return errors.New("delete failed")
			},
		}, nil)
		err = svc.DeleteWikiPage(ctx, actor, "alice", "demo", "home")
		assert.Equal(t, 500, apiStatus(t, err))

		svc = newTestWikiService(&mockWikiQuerier{
			getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				return publicRepo(), nil
			},
			getWikiPageBySlugFn: func(context.Context, db.GetWikiPageBySlugParams) (db.GetWikiPageBySlugRow, error) {
				return db.GetWikiPageBySlugRow{}, errors.New("load failed")
			},
		}, nil)
		err = svc.DeleteWikiPage(ctx, actor, "alice", "demo", "home")
		assert.Equal(t, 500, apiStatus(t, err))
	})

	t.Run("dispatcher failure does not fail create", func(t *testing.T) {
		dispatcher := &wikiCovFailDispatcher{err: errors.New("webhook down")}
		svc := newTestWikiService(&mockWikiQuerier{
			getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				return publicRepo(), nil
			},
			createWikiPageFn: func(_ context.Context, arg db.CreateWikiPageParams) (db.WikiPage, error) {
				now := time.Now().UTC().Truncate(time.Second)
				return db.WikiPage{ID: 88, RepositoryID: arg.RepositoryID, Slug: arg.Slug, Title: arg.Title, Body: arg.Body, AuthorID: arg.AuthorID, CreatedAt: now, UpdatedAt: now}, nil
			},
		}, dispatcher)

		page, err := svc.CreateWikiPage(ctx, actor, "alice", "demo", CreateWikiPageInput{Title: "Ops Runbook", Body: "steps"})
		require.NoError(t, err)
		assert.Equal(t, "ops-runbook", page.Slug)
		assert.Equal(t, 1, dispatcher.calls)
	})

	t.Run("revision load errors are mapped", func(t *testing.T) {
		svc := newTestWikiService(&mockWikiQuerier{
			getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				return publicRepo(), nil
			},
			getWikiPageBySlugFn: func(context.Context, db.GetWikiPageBySlugParams) (db.GetWikiPageBySlugRow, error) {
				return db.GetWikiPageBySlugRow{}, pgx.ErrNoRows
			},
		}, nil)
		_, _, err := svc.ListWikiRevisions(ctx, nil, "alice", "demo", "home", 1, 10)
		assert.Equal(t, 404, apiStatus(t, err))
	})
}
