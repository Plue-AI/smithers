package services

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/blob"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/webhooks"
)

type wikiDispatchCall struct {
	repoID    int64
	eventType webhooks.EventType
	payload   any
}

type mockWikiDispatcher struct {
	calls []wikiDispatchCall
}

func (m *mockWikiDispatcher) DispatchEvent(_ context.Context, repoID int64, eventType webhooks.EventType, payload any) error {
	m.calls = append(m.calls, wikiDispatchCall{
		repoID:    repoID,
		eventType: eventType,
		payload:   payload,
	})
	return nil
}

type mockWikiQuerier struct {
	getRepoByOwnerAndLowerNameFn          func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error)
	isOrgOwnerForRepoUserFn               func(ctx context.Context, arg db.IsOrgOwnerForRepoUserParams) (bool, error)
	getHighestTeamPermissionForRepoUserFn func(ctx context.Context, arg db.GetHighestTeamPermissionForRepoUserParams) (string, error)
	getCollaboratorPermissionForRepoFn    func(ctx context.Context, arg db.GetCollaboratorPermissionForRepoUserParams) (string, error)
	countWikiPagesByRepoFn                func(ctx context.Context, repositoryID int64) (int64, error)
	listWikiPagesByRepoFn                 func(ctx context.Context, arg db.ListWikiPagesByRepoParams) ([]db.ListWikiPagesByRepoRow, error)
	countSearchWikiPagesByRepoFn          func(ctx context.Context, arg db.CountSearchWikiPagesByRepoParams) (int64, error)
	searchWikiPagesByRepoFn               func(ctx context.Context, arg db.SearchWikiPagesByRepoParams) ([]db.SearchWikiPagesByRepoRow, error)
	getWikiPageBySlugFn                   func(ctx context.Context, arg db.GetWikiPageBySlugParams) (db.GetWikiPageBySlugRow, error)
	createWikiPageFn                      func(ctx context.Context, arg db.CreateWikiPageParams) (db.WikiPage, error)
	updateWikiPageFn                      func(ctx context.Context, arg db.UpdateWikiPageParams) (db.WikiPage, error)
	deleteWikiPageFn                      func(ctx context.Context, id int64) error

	lastCreateArg db.CreateWikiPageParams
	lastUpdateArg db.UpdateWikiPageParams
	lastListArg   db.ListWikiPagesByRepoParams
	lastSearchArg db.SearchWikiPagesByRepoParams
}

func (m *mockWikiQuerier) GetRepoByOwnerAndLowerName(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
	if m.getRepoByOwnerAndLowerNameFn != nil {
		return m.getRepoByOwnerAndLowerNameFn(ctx, arg)
	}
	return db.Repository{}, pgx.ErrNoRows
}

func (m *mockWikiQuerier) IsOrgOwnerForRepoUser(ctx context.Context, arg db.IsOrgOwnerForRepoUserParams) (bool, error) {
	if m.isOrgOwnerForRepoUserFn != nil {
		return m.isOrgOwnerForRepoUserFn(ctx, arg)
	}
	return false, nil
}

func (m *mockWikiQuerier) GetHighestTeamPermissionForRepoUser(ctx context.Context, arg db.GetHighestTeamPermissionForRepoUserParams) (string, error) {
	if m.getHighestTeamPermissionForRepoUserFn != nil {
		return m.getHighestTeamPermissionForRepoUserFn(ctx, arg)
	}
	return "", nil
}

func (m *mockWikiQuerier) GetCollaboratorPermissionForRepoUser(ctx context.Context, arg db.GetCollaboratorPermissionForRepoUserParams) (string, error) {
	if m.getCollaboratorPermissionForRepoFn != nil {
		return m.getCollaboratorPermissionForRepoFn(ctx, arg)
	}
	return "", nil
}

func (m *mockWikiQuerier) CountWikiPagesByRepo(ctx context.Context, arg db.CountWikiPagesByRepoParams) (int64, error) {
	if m.countWikiPagesByRepoFn != nil {
		return m.countWikiPagesByRepoFn(ctx, arg.RepositoryID)
	}
	return 0, nil
}

func (m *mockWikiQuerier) ListWikiPagesByRepo(ctx context.Context, arg db.ListWikiPagesByRepoParams) ([]db.ListWikiPagesByRepoRow, error) {
	m.lastListArg = arg
	if m.listWikiPagesByRepoFn != nil {
		return m.listWikiPagesByRepoFn(ctx, arg)
	}
	return nil, nil
}

func (m *mockWikiQuerier) CountSearchWikiPagesByRepo(ctx context.Context, arg db.CountSearchWikiPagesByRepoParams) (int64, error) {
	if m.countSearchWikiPagesByRepoFn != nil {
		return m.countSearchWikiPagesByRepoFn(ctx, arg)
	}
	return 0, nil
}

func (m *mockWikiQuerier) SearchWikiPagesByRepo(ctx context.Context, arg db.SearchWikiPagesByRepoParams) ([]db.SearchWikiPagesByRepoRow, error) {
	m.lastSearchArg = arg
	if m.searchWikiPagesByRepoFn != nil {
		return m.searchWikiPagesByRepoFn(ctx, arg)
	}
	return nil, nil
}

func (m *mockWikiQuerier) GetWikiPageBySlug(ctx context.Context, arg db.GetWikiPageBySlugParams) (db.GetWikiPageBySlugRow, error) {
	if m.getWikiPageBySlugFn != nil {
		return m.getWikiPageBySlugFn(ctx, arg)
	}
	return db.GetWikiPageBySlugRow{}, pgx.ErrNoRows
}

func (m *mockWikiQuerier) CreateWikiPage(ctx context.Context, arg db.CreateWikiPageParams) (db.WikiPage, error) {
	m.lastCreateArg = arg
	if m.createWikiPageFn != nil {
		return m.createWikiPageFn(ctx, arg)
	}
	return db.WikiPage{}, nil
}

func (m *mockWikiQuerier) UpdateWikiPage(ctx context.Context, arg db.UpdateWikiPageParams) (db.WikiPage, error) {
	m.lastUpdateArg = arg
	if m.updateWikiPageFn != nil {
		return m.updateWikiPageFn(ctx, arg)
	}
	return db.WikiPage{}, nil
}

func (m *mockWikiQuerier) DeleteWikiPage(ctx context.Context, arg db.DeleteWikiPageParams) (int64, error) {
	if m.deleteWikiPageFn != nil {
		if err := m.deleteWikiPageFn(ctx, arg.ID); err != nil {
			return 0, err
		}
	}
	return 1, nil
}

func sampleWikiRepository() db.Repository {
	return db.Repository{
		ID:        42,
		Name:      "demo",
		LowerName: "demo",
		IsPublic:  true,
		UserID:    pgtypeInt8(1),
	}
}

func sampleWikiPageRow() db.GetWikiPageBySlugRow {
	now := time.Now().UTC().Truncate(time.Second)
	return db.GetWikiPageBySlugRow{
		ID:           7,
		RepositoryID: 42,
		Slug:         "home",
		Title:        "Home",
		Body:         "# Welcome", ContentDigest: wikiDigest([]byte("# Welcome")),
		AuthorID:       1,
		AuthorUsername: "alice",
		CreatedAt:      now,
		UpdatedAt:      now,
	}
}

func pgtypeInt8(value int64) pgtype.Int8 {
	return pgtype.Int8{Int64: value, Valid: true}
}

func TestWikiService_ListWikiPages_ListAndSearch(t *testing.T) {
	t.Run("lists pages with pagination", func(t *testing.T) {
		mockQ := &mockWikiQuerier{
			getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				return sampleWikiRepository(), nil
			},
			countWikiPagesByRepoFn: func(ctx context.Context, repositoryID int64) (int64, error) {
				return 2, nil
			},
			listWikiPagesByRepoFn: func(ctx context.Context, arg db.ListWikiPagesByRepoParams) ([]db.ListWikiPagesByRepoRow, error) {
				now := time.Now().UTC().Truncate(time.Second)
				return []db.ListWikiPagesByRepoRow{
					{ID: 1, RepositoryID: 42, Slug: "home", Title: "Home", AuthorID: 1, AuthorUsername: "alice", CreatedAt: now, UpdatedAt: now},
					{ID: 2, RepositoryID: 42, Slug: "runbook", Title: "Runbook", AuthorID: 1, AuthorUsername: "alice", CreatedAt: now, UpdatedAt: now},
				}, nil
			},
		}

		svc := newTestWikiService(mockQ, nil)
		items, total, err := svc.ListWikiPages(context.Background(), nil, "alice", "demo", ListWikiPagesInput{
			Page:    2,
			PerPage: 10,
		})
		require.NoError(t, err)
		assert.Equal(t, int64(2), total)
		assert.Len(t, items, 2)
		assert.Equal(t, int32(10), mockQ.lastListArg.Limit)
		assert.Equal(t, int32(10), mockQ.lastListArg.Offset)
		assert.Equal(t, "home", items[0].Slug)
		assert.Equal(t, "Home", items[0].Title)
	})

	t.Run("searches pages when query is present", func(t *testing.T) {
		mockQ := &mockWikiQuerier{
			getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				return sampleWikiRepository(), nil
			},
			countSearchWikiPagesByRepoFn: func(ctx context.Context, arg db.CountSearchWikiPagesByRepoParams) (int64, error) {
				assert.Equal(t, "run", arg.Query)
				return 1, nil
			},
			searchWikiPagesByRepoFn: func(ctx context.Context, arg db.SearchWikiPagesByRepoParams) ([]db.SearchWikiPagesByRepoRow, error) {
				now := time.Now().UTC().Truncate(time.Second)
				return []db.SearchWikiPagesByRepoRow{
					{ID: 2, RepositoryID: 42, Slug: "runbook", Title: "Runbook", AuthorID: 1, AuthorUsername: "alice", CreatedAt: now, UpdatedAt: now},
				}, nil
			},
		}

		svc := newTestWikiService(mockQ, nil)
		items, total, err := svc.ListWikiPages(context.Background(), nil, "alice", "demo", ListWikiPagesInput{
			Query:   "run",
			Page:    1,
			PerPage: 20,
		})
		require.NoError(t, err)
		assert.Equal(t, int64(1), total)
		assert.Len(t, items, 1)
		assert.Equal(t, int32(20), mockQ.lastSearchArg.PageSize)
		assert.Equal(t, int32(0), mockQ.lastSearchArg.PageOffset)
		assert.Equal(t, "runbook", items[0].Slug)
	})
}

func TestWikiService_GetWikiPage_RequiresReadAccessForPrivateRepos(t *testing.T) {
	mockQ := &mockWikiQuerier{
		getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			repo := sampleWikiRepository()
			repo.IsPublic = false
			repo.UserID = pgtypeInt8(99)
			return repo, nil
		},
	}

	svc := newTestWikiService(mockQ, nil)
	_, err := svc.GetWikiPage(context.Background(), nil, "alice", "demo", "home")
	require.Error(t, err)
	apiErr := &pkgerrors.APIError{}
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, 403, apiErr.Status)
}

func TestWikiService_CreateWikiPage_CreatesPageAndDispatches(t *testing.T) {
	actor := &db.User{ID: 1, Username: "alice"}
	dispatcher := &mockWikiDispatcher{}
	mockQ := &mockWikiQuerier{
		getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return sampleWikiRepository(), nil
		},
		createWikiPageFn: func(ctx context.Context, arg db.CreateWikiPageParams) (db.WikiPage, error) {
			now := time.Now().UTC().Truncate(time.Second)
			return db.WikiPage{
				ID:           9,
				RepositoryID: arg.RepositoryID,
				Slug:         arg.Slug,
				Title:        arg.Title,
				Body:         arg.Body,
				AuthorID:     arg.AuthorID,
				CreatedAt:    now,
				UpdatedAt:    now,
			}, nil
		},
	}

	svc := newTestWikiService(mockQ, dispatcher)
	created, err := svc.CreateWikiPage(context.Background(), actor, "alice", "demo", CreateWikiPageInput{
		Title: "Getting Started",
		Body:  "# Welcome",
	})
	require.NoError(t, err)
	assert.Equal(t, "getting-started", mockQ.lastCreateArg.Slug)
	assert.Equal(t, "Getting Started", created.Title)
	assert.Equal(t, "getting-started", created.Slug)
	assert.Equal(t, "# Welcome", created.Body)
	require.Len(t, dispatcher.calls, 1)
	assert.Equal(t, webhooks.EventWiki, dispatcher.calls[0].eventType)
}

func TestWikiService_CreateWikiPage_MapsUniqueViolationToConflict(t *testing.T) {
	actor := &db.User{ID: 1, Username: "alice"}
	mockQ := &mockWikiQuerier{
		getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return sampleWikiRepository(), nil
		},
		createWikiPageFn: func(ctx context.Context, arg db.CreateWikiPageParams) (db.WikiPage, error) {
			return db.WikiPage{}, &pgconn.PgError{Code: "23505"}
		},
	}

	svc := newTestWikiService(mockQ, nil)
	_, err := svc.CreateWikiPage(context.Background(), actor, "alice", "demo", CreateWikiPageInput{
		Title: "Home",
		Body:  "",
	})
	require.Error(t, err)
	apiErr := &pkgerrors.APIError{}
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, 409, apiErr.Status)
}

func TestWikiService_UpdateWikiPage_UpdatesRequestedFields(t *testing.T) {
	actor := &db.User{ID: 2, Username: "bob"}
	existing := sampleWikiPageRow()
	mockQ := &mockWikiQuerier{
		getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			repo := sampleWikiRepository()
			repo.UserID = pgtypeInt8(actor.ID)
			return repo, nil
		},
		getWikiPageBySlugFn: func(ctx context.Context, arg db.GetWikiPageBySlugParams) (db.GetWikiPageBySlugRow, error) {
			return existing, nil
		},
		updateWikiPageFn: func(ctx context.Context, arg db.UpdateWikiPageParams) (db.WikiPage, error) {
			return db.WikiPage{
				ID:           arg.ID,
				RepositoryID: existing.RepositoryID,
				Slug:         arg.Slug,
				Title:        arg.Title,
				Body:         arg.Body,
				AuthorID:     arg.AuthorID,
				CreatedAt:    existing.CreatedAt,
				UpdatedAt:    existing.UpdatedAt.Add(time.Minute),
			}, nil
		},
	}

	svc := newTestWikiService(mockQ, nil)
	newTitle := "Start Here"
	newBody := "Updated body"
	updated, err := svc.UpdateWikiPage(context.Background(), actor, "alice", "demo", "home", UpdateWikiPageInput{
		Title: &newTitle,
		Body:  &newBody,
	})
	require.NoError(t, err)
	assert.Equal(t, "home", mockQ.lastUpdateArg.Slug)
	assert.Equal(t, "Start Here", mockQ.lastUpdateArg.Title)
	assert.Equal(t, "Updated body", mockQ.lastUpdateArg.Body)
	assert.Equal(t, actor.ID, mockQ.lastUpdateArg.AuthorID)
	assert.Equal(t, "Start Here", updated.Title)
	assert.Equal(t, "home", updated.Slug)
	assert.Equal(t, "bob", updated.Author.Login)
}

func TestWikiService_CreateWikiPage_RejectsOversizedBody(t *testing.T) {
	actor := &db.User{ID: 1, Username: "alice"}
	mockQ := &mockWikiQuerier{
		getRepoByOwnerAndLowerNameFn: func(_ context.Context, _ db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return sampleWikiRepository(), nil
		},
	}

	svc := newTestWikiService(mockQ, nil)
	bigBody := strings.Repeat("x", 1<<20+1) // 1 MB + 1 byte
	_, err := svc.CreateWikiPage(context.Background(), actor, "alice", "demo", CreateWikiPageInput{
		Title: "Big Page",
		Body:  bigBody,
	})
	require.Error(t, err)
	apiErr := &pkgerrors.APIError{}
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, 422, apiErr.Status)
}

func TestWikiService_UpdateWikiPage_RejectsOversizedBody(t *testing.T) {
	actor := &db.User{ID: 1, Username: "alice"}
	existing := sampleWikiPageRow()
	mockQ := &mockWikiQuerier{
		getRepoByOwnerAndLowerNameFn: func(_ context.Context, _ db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return sampleWikiRepository(), nil
		},
		getWikiPageBySlugFn: func(_ context.Context, _ db.GetWikiPageBySlugParams) (db.GetWikiPageBySlugRow, error) {
			return existing, nil
		},
	}

	svc := newTestWikiService(mockQ, nil)
	bigBody := strings.Repeat("x", 1<<20+1) // 1 MB + 1 byte
	_, err := svc.UpdateWikiPage(context.Background(), actor, "alice", "demo", "home", UpdateWikiPageInput{
		Body: &bigBody,
	})
	require.Error(t, err)
	apiErr := &pkgerrors.APIError{}
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, 422, apiErr.Status)
}

func TestValidateWikiName_RejectsPathTraversalAndDangerousInputs(t *testing.T) {
	cases := []struct {
		name  string
		input string
	}{
		{"path traversal relative", "../secret"},
		{"path traversal mid-path", "foo/../bar"},
		{"path traversal suffix", "foo/.."},
		{"double slash", "foo//bar"},
		{"null byte", "foo\x00bar"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := validateWikiName(tc.input, "title")
			require.Error(t, err, "expected error for input %q", tc.input)
			apiErr := &pkgerrors.APIError{}
			require.ErrorAs(t, err, &apiErr)
			assert.Equal(t, 422, apiErr.Status)
		})
	}
}

func TestValidateWikiName_AcceptsNormalNames(t *testing.T) {
	cases := []string{
		"home",
		"Getting Started",
		"foo/bar",
		"runbook-2024",
		"Architecture Overview",
	}
	for _, name := range cases {
		t.Run(name, func(t *testing.T) {
			assert.NoError(t, validateWikiName(name, "title"))
		})
	}
}

func TestWikiService_CreateWikiPage_AtomicityOnDBFailure(t *testing.T) {
	// Verifies that when the DB write fails, no event is dispatched and the
	// error is propagated to the caller (no partial-success state).
	actor := &db.User{ID: 1, Username: "alice"}
	dispatcher := &mockWikiDispatcher{}
	dbErr := &pgconn.PgError{Code: "40001"} // serialization failure
	mockQ := &mockWikiQuerier{
		getRepoByOwnerAndLowerNameFn: func(_ context.Context, _ db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return sampleWikiRepository(), nil
		},
		createWikiPageFn: func(_ context.Context, _ db.CreateWikiPageParams) (db.WikiPage, error) {
			return db.WikiPage{}, dbErr
		},
	}

	svc := newTestWikiService(mockQ, dispatcher)
	_, err := svc.CreateWikiPage(context.Background(), actor, "alice", "demo", CreateWikiPageInput{
		Title: "Atomic Test",
		Body:  "content",
	})
	require.Error(t, err)
	assert.Len(t, dispatcher.calls, 0, "no event should be dispatched on DB failure")
}

func TestWikiService_DeleteWikiPage_DeletesExistingPage(t *testing.T) {
	actor := &db.User{ID: 1, Username: "alice"}
	deletedID := int64(0)
	mockQ := &mockWikiQuerier{
		getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return sampleWikiRepository(), nil
		},
		getWikiPageBySlugFn: func(ctx context.Context, arg db.GetWikiPageBySlugParams) (db.GetWikiPageBySlugRow, error) {
			return sampleWikiPageRow(), nil
		},
		deleteWikiPageFn: func(ctx context.Context, id int64) error {
			deletedID = id
			return nil
		},
	}

	svc := newTestWikiService(mockQ, nil)
	err := svc.DeleteWikiPage(context.Background(), actor, "alice", "demo", "home")
	require.NoError(t, err)
	assert.Equal(t, int64(7), deletedID)
}

func newTestWikiService(q WikiQuerier, d WikiDispatcher, options ...WikiServiceOption) *WikiService {
	options = append([]WikiServiceOption{WithWikiContent(blob.NewMemoryStore())}, options...)
	return NewWikiService(q, d, options...)
}
