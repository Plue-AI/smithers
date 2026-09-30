package services

import (
	"context"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/internal/webhooks"
)

type repoDispatchCall struct {
	repoID    int64
	eventType webhooks.EventType
	payload   any
}

type mockRepoDispatcher struct {
	dispatchFn func(ctx context.Context, repoID int64, eventType webhooks.EventType, payload any) error
	calls      []repoDispatchCall
}

func (m *mockRepoDispatcher) DispatchEvent(ctx context.Context, repoID int64, eventType webhooks.EventType, payload any) error {
	m.calls = append(m.calls, repoDispatchCall{
		repoID:    repoID,
		eventType: eventType,
		payload:   payload,
	})
	if m.dispatchFn != nil {
		return m.dispatchFn(ctx, repoID, eventType, payload)
	}
	return nil
}

func (m *mockRepoDispatcher) DispatchOrgEvent(_ context.Context, _ int64, _ webhooks.EventType, _ any) error {
	return nil
}

// mockRepoQuerier implements RepoQuerier for testing.
type mockRepoQuerier struct {
	createRepoFn                     func(ctx context.Context, arg db.CreateRepoParams) (db.Repository, error)
	createOrgRepoFn                  func(ctx context.Context, arg db.CreateOrgRepoParams) (db.Repository, error)
	createForkRepoFn                 func(ctx context.Context, arg db.CreateForkRepoParams) (db.Repository, error)
	deleteRepoFn                     func(ctx context.Context, id int64) error
	getRepoByIDFn                    func(ctx context.Context, id int64) (db.Repository, error)
	getRepoByOwnerAndLowerNameFn     func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error)
	updateRepoFn                     func(ctx context.Context, arg db.UpdateRepoParams) (db.Repository, error)
	isOrgOwnerForRepoUserFn          func(ctx context.Context, arg db.IsOrgOwnerForRepoUserParams) (bool, error)
	getHighestTeamPermissionForRepo  func(ctx context.Context, arg db.GetHighestTeamPermissionForRepoUserParams) (string, error)
	getCollaboratorPermissionForRepo func(ctx context.Context, arg db.GetCollaboratorPermissionForRepoUserParams) (string, error)
	getUserByLowerUsernameFn         func(ctx context.Context, lowerUsername string) (db.User, error)
	getOrgByLowerNameFn              func(ctx context.Context, lowerName string) (db.Organization, error)
	getOrgMemberFn                   func(ctx context.Context, arg db.GetOrgMemberParams) (db.OrgMember, error)
	updateRepoTopicsFn               func(ctx context.Context, arg db.UpdateRepoTopicsParams) (db.Repository, error)
	listRepoStargazersFn             func(ctx context.Context, arg db.ListRepoStargazersParams) ([]db.User, error)
	countRepoStarsFn                 func(ctx context.Context, repositoryID int64) (int64, error)
	isRepoStarredFn                  func(ctx context.Context, arg db.IsRepoStarredParams) (bool, error)
	starRepoFn                       func(ctx context.Context, arg db.StarRepoParams) (db.Star, error)
	unstarRepoFn                     func(ctx context.Context, arg db.UnstarRepoParams) (int64, error)
	transferRepoToUserFn             func(ctx context.Context, arg db.TransferRepoToUserParams) (db.Repository, error)
	transferRepoToOrgFn              func(ctx context.Context, arg db.TransferRepoToOrgParams) (db.Repository, error)
	deleteCollaboratorsByRepoFn      func(ctx context.Context, repositoryID int64) error
	deleteTeamReposByRepoFn          func(ctx context.Context, repositoryID int64) error
	listCollaboratorsByRepoFn        func(ctx context.Context, repositoryID int64) ([]db.Collaborator, error)
	listTeamReposByRepoFn            func(ctx context.Context, repositoryID int64) ([]db.TeamRepo, error)
	addCollaboratorFn                func(ctx context.Context, arg db.AddCollaboratorParams) (db.Collaborator, error)
	addTeamRepoFn                    func(ctx context.Context, arg db.AddTeamRepoParams) (db.TeamRepo, error)
	deleteCalled                     bool
	updateCalled                     bool
	updateTopicsCalled               bool
	starCalled                       bool
	unstarCalled                     bool
	transferToUserCalled             bool
	transferToOrgCalled              bool
}

func (m *mockRepoQuerier) CreateRepo(ctx context.Context, arg db.CreateRepoParams) (db.Repository, error) {
	if m.createRepoFn != nil {
		return m.createRepoFn(ctx, arg)
	}
	return db.Repository{
		ID:              1,
		UserID:          arg.UserID,
		Name:            arg.Name,
		LowerName:       arg.LowerName,
		Description:     arg.Description,
		IsPublic:        arg.IsPublic,
		DefaultBookmark: "main",
	}, nil
}

func (m *mockRepoQuerier) CreateOrgRepo(ctx context.Context, arg db.CreateOrgRepoParams) (db.Repository, error) {
	if m.createOrgRepoFn != nil {
		return m.createOrgRepoFn(ctx, arg)
	}
	return db.Repository{
		ID:              2,
		OrgID:           arg.OrgID,
		Name:            arg.Name,
		LowerName:       arg.LowerName,
		Description:     arg.Description,
		IsPublic:        arg.IsPublic,
		DefaultBookmark: "main",
	}, nil
}

func (m *mockRepoQuerier) DeleteRepo(ctx context.Context, id int64) error {
	m.deleteCalled = true
	if m.deleteRepoFn != nil {
		return m.deleteRepoFn(ctx, id)
	}
	return nil
}

func (m *mockRepoQuerier) GetRepoByID(ctx context.Context, id int64) (db.Repository, error) {
	if m.getRepoByIDFn != nil {
		return m.getRepoByIDFn(ctx, id)
	}
	return db.Repository{}, pgx.ErrNoRows
}

func (m *mockRepoQuerier) GetRepoByOwnerAndLowerName(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
	if m.getRepoByOwnerAndLowerNameFn != nil {
		return m.getRepoByOwnerAndLowerNameFn(ctx, arg)
	}
	return db.Repository{}, pgx.ErrNoRows
}

func (m *mockRepoQuerier) UpdateRepo(ctx context.Context, arg db.UpdateRepoParams) (db.Repository, error) {
	m.updateCalled = true
	if m.updateRepoFn != nil {
		return m.updateRepoFn(ctx, arg)
	}
	return db.Repository{
		ID:              arg.ID,
		Name:            arg.Name,
		LowerName:       arg.LowerName,
		Description:     arg.Description,
		IsPublic:        arg.IsPublic,
		DefaultBookmark: arg.DefaultBookmark,
		Topics:          arg.Topics,
	}, nil
}

func (m *mockRepoQuerier) IsOrgOwnerForRepoUser(ctx context.Context, arg db.IsOrgOwnerForRepoUserParams) (bool, error) {
	if m.isOrgOwnerForRepoUserFn != nil {
		return m.isOrgOwnerForRepoUserFn(ctx, arg)
	}
	return false, nil
}

func (m *mockRepoQuerier) GetHighestTeamPermissionForRepoUser(ctx context.Context, arg db.GetHighestTeamPermissionForRepoUserParams) (string, error) {
	if m.getHighestTeamPermissionForRepo != nil {
		return m.getHighestTeamPermissionForRepo(ctx, arg)
	}
	return "", nil
}

func (m *mockRepoQuerier) GetCollaboratorPermissionForRepoUser(ctx context.Context, arg db.GetCollaboratorPermissionForRepoUserParams) (string, error) {
	if m.getCollaboratorPermissionForRepo != nil {
		return m.getCollaboratorPermissionForRepo(ctx, arg)
	}
	return "", nil
}

func (m *mockRepoQuerier) GetOrgByLowerName(ctx context.Context, lowerName string) (db.Organization, error) {
	if m.getOrgByLowerNameFn != nil {
		return m.getOrgByLowerNameFn(ctx, lowerName)
	}
	return db.Organization{}, pgx.ErrNoRows
}

func (m *mockRepoQuerier) GetOrgMember(ctx context.Context, arg db.GetOrgMemberParams) (db.OrgMember, error) {
	if m.getOrgMemberFn != nil {
		return m.getOrgMemberFn(ctx, arg)
	}
	return db.OrgMember{}, pgx.ErrNoRows
}

func (m *mockRepoQuerier) UpdateRepoTopics(ctx context.Context, arg db.UpdateRepoTopicsParams) (db.Repository, error) {
	m.updateTopicsCalled = true
	if m.updateRepoTopicsFn != nil {
		return m.updateRepoTopicsFn(ctx, arg)
	}
	return db.Repository{
		ID:     arg.ID,
		Topics: arg.Topics,
	}, nil
}

func (m *mockRepoQuerier) ListRepoStargazers(ctx context.Context, arg db.ListRepoStargazersParams) ([]db.User, error) {
	if m.listRepoStargazersFn != nil {
		return m.listRepoStargazersFn(ctx, arg)
	}
	return nil, nil
}

func (m *mockRepoQuerier) CountRepoStars(ctx context.Context, repositoryID int64) (int64, error) {
	if m.countRepoStarsFn != nil {
		return m.countRepoStarsFn(ctx, repositoryID)
	}
	return 0, nil
}

func (m *mockRepoQuerier) IsRepoStarred(ctx context.Context, arg db.IsRepoStarredParams) (bool, error) {
	if m.isRepoStarredFn != nil {
		return m.isRepoStarredFn(ctx, arg)
	}
	return false, nil
}

func (m *mockRepoQuerier) StarRepo(ctx context.Context, arg db.StarRepoParams) (db.Star, error) {
	m.starCalled = true
	if m.starRepoFn != nil {
		return m.starRepoFn(ctx, arg)
	}
	return db.Star{}, nil
}

func (m *mockRepoQuerier) UnstarRepo(ctx context.Context, arg db.UnstarRepoParams) (int64, error) {
	m.unstarCalled = true
	if m.unstarRepoFn != nil {
		return m.unstarRepoFn(ctx, arg)
	}
	return 1, nil
}

func (m *mockRepoQuerier) ArchiveRepo(ctx context.Context, id int64) (db.Repository, error) {
	return db.Repository{ID: id, IsArchived: true}, nil
}

func (m *mockRepoQuerier) UnarchiveRepo(ctx context.Context, id int64) (db.Repository, error) {
	return db.Repository{ID: id, IsArchived: false}, nil
}

func (m *mockRepoQuerier) CreateForkRepo(ctx context.Context, arg db.CreateForkRepoParams) (db.Repository, error) {
	if m.createForkRepoFn != nil {
		return m.createForkRepoFn(ctx, arg)
	}
	return db.Repository{}, nil
}

func (m *mockRepoQuerier) CountRepoForks(ctx context.Context, forkID pgtype.Int8) (int64, error) {
	return 0, nil
}

func (m *mockRepoQuerier) GetUserByLowerUsername(ctx context.Context, lowerUsername string) (db.User, error) {
	if m.getUserByLowerUsernameFn != nil {
		return m.getUserByLowerUsernameFn(ctx, lowerUsername)
	}
	return db.User{}, nil
}

func (m *mockRepoQuerier) TransferRepoToUser(ctx context.Context, arg db.TransferRepoToUserParams) (db.Repository, error) {
	m.transferToUserCalled = true
	if m.transferRepoToUserFn != nil {
		return m.transferRepoToUserFn(ctx, arg)
	}
	return db.Repository{}, nil
}

func (m *mockRepoQuerier) TransferRepoToOrg(ctx context.Context, arg db.TransferRepoToOrgParams) (db.Repository, error) {
	m.transferToOrgCalled = true
	if m.transferRepoToOrgFn != nil {
		return m.transferRepoToOrgFn(ctx, arg)
	}
	return db.Repository{}, nil
}

func (m *mockRepoQuerier) DeleteCollaboratorsByRepo(ctx context.Context, repositoryID int64) error {
	if m.deleteCollaboratorsByRepoFn != nil {
		return m.deleteCollaboratorsByRepoFn(ctx, repositoryID)
	}
	return nil
}

func (m *mockRepoQuerier) DeleteTeamReposByRepo(ctx context.Context, repositoryID int64) error {
	if m.deleteTeamReposByRepoFn != nil {
		return m.deleteTeamReposByRepoFn(ctx, repositoryID)
	}
	return nil
}

func (m *mockRepoQuerier) ListCollaboratorsByRepo(ctx context.Context, repositoryID int64) ([]db.Collaborator, error) {
	if m.listCollaboratorsByRepoFn != nil {
		return m.listCollaboratorsByRepoFn(ctx, repositoryID)
	}
	return nil, nil
}

func (m *mockRepoQuerier) ListTeamReposByRepo(ctx context.Context, repositoryID int64) ([]db.TeamRepo, error) {
	if m.listTeamReposByRepoFn != nil {
		return m.listTeamReposByRepoFn(ctx, repositoryID)
	}
	return nil, nil
}

func (m *mockRepoQuerier) AddCollaborator(ctx context.Context, arg db.AddCollaboratorParams) (db.Collaborator, error) {
	if m.addCollaboratorFn != nil {
		return m.addCollaboratorFn(ctx, arg)
	}
	return db.Collaborator{
		RepositoryID: arg.RepositoryID,
		UserID:       arg.UserID,
		Permission:   arg.Permission,
	}, nil
}

func (m *mockRepoQuerier) AddTeamRepo(ctx context.Context, arg db.AddTeamRepoParams) (db.TeamRepo, error) {
	if m.addTeamRepoFn != nil {
		return m.addTeamRepoFn(ctx, arg)
	}
	return db.TeamRepo{
		TeamID:       arg.TeamID,
		RepositoryID: arg.RepositoryID,
	}, nil
}

// mockRepoHostClient implements RepoHostClient for testing.
type pagedRepoHostClient struct {
	*mockRepoHostClient
	pages        map[string][]repohost.TreeEntry
	seenChanges  []string
	changeCommit string
	changeError  error
}

func (m *pagedRepoHostClient) GetChange(_ context.Context, _, _, _ string) (repohost.Change, error) {
	return repohost.Change{CommitID: m.changeCommit}, m.changeError
}

func (m *pagedRepoHostClient) ListDirectory(_ context.Context, _, _, change, prefix, after string, limit int) ([]repohost.TreeEntry, error) {
	m.seenChanges = append(m.seenChanges, change)
	entries := m.pages[prefix]
	page := make([]repohost.TreeEntry, 0, limit)
	for _, entry := range entries {
		if entry.Path > after {
			page = append(page, entry)
			if len(page) == limit {
				break
			}
		}
	}
	return page, nil
}

type mockRepoHostClient struct {
	getBookmarkFn        func(context.Context, string, string, string) (repohost.Bookmark, error)
	initRepoFn           func(ctx context.Context, owner, repo, defaultBookmark string, autoInit bool) error
	setDefaultBookmarkFn func(ctx context.Context, owner, repo, name string) error
	deleteRepoFn         func(ctx context.Context, owner, repo string) error
	stageDeleteRepoFn    func(ctx context.Context, owner, repo string) (repohost.StagedDelete, error)
	restoreDeleteRepoFn  func(ctx context.Context, staged repohost.StagedDelete) error
	finalizeDeleteRepoFn func(ctx context.Context, staged repohost.StagedDelete) error
	forkRepoFn           func(ctx context.Context, srcOwner, srcRepo, dstOwner, dstRepo string) error
	moveRepoFn           func(ctx context.Context, srcOwner, srcRepo, dstOwner, dstRepo string) error
	stageMoveRepoFn      func(ctx context.Context, srcOwner, srcRepo, dstOwner, dstRepo string) (repohost.StagedMove, error)
	rollbackMoveRepoFn   func(ctx context.Context, staged repohost.StagedMove) error
	finalizeMoveRepoFn   func(ctx context.Context, staged repohost.StagedMove) error
	getFileAtChangeFn    func(ctx context.Context, owner, repo, changeID, path string) (repohost.FileContent, error)
	listFilesAtChangeFn  func(ctx context.Context, owner, repo, changeID, prefix string) ([]repohost.ChangeFile, error)
	listNotesRefsFn      func(context.Context, string, string) ([]repohost.NotesRef, error)
	listBookmarksFn      func(ctx context.Context, owner, repo, cursor string, limit int) ([]repohost.Bookmark, string, error)
	deleteRepoCalls      int
	stageDeleteCalls     int
	restoreDeleteCalls   int
	finalizeDeleteCalls  int
	forkRepoCalls        int
	moveRepoCalls        int
	stageMoveCalls       int
	rollbackMoveCalls    int
	finalizeMoveCalls    int
}

func (m *mockRepoHostClient) InitRepo(ctx context.Context, owner, repo, defaultBookmark string, autoInit bool) error {
	if m.initRepoFn != nil {
		return m.initRepoFn(ctx, owner, repo, defaultBookmark, autoInit)
	}
	return nil
}

func (m *mockRepoHostClient) SetDefaultBookmark(ctx context.Context, owner, repo, name string) error {
	if m.setDefaultBookmarkFn != nil {
		return m.setDefaultBookmarkFn(ctx, owner, repo, name)
	}
	return nil
}

func (m *mockRepoHostClient) DeleteRepo(ctx context.Context, owner, repo string) error {
	m.deleteRepoCalls++
	if m.deleteRepoFn != nil {
		return m.deleteRepoFn(ctx, owner, repo)
	}
	return nil
}

func (m *mockRepoHostClient) StageDeleteRepo(ctx context.Context, owner, repo string) (repohost.StagedDelete, error) {
	m.deleteRepoCalls++
	m.stageDeleteCalls++
	if m.stageDeleteRepoFn != nil {
		return m.stageDeleteRepoFn(ctx, owner, repo)
	}
	staged := repohost.StagedDelete{BaseURL: "http://repo-host.test", Token: "test-delete-stage"}
	if m.deleteRepoFn != nil {
		if err := m.deleteRepoFn(ctx, owner, repo); err != nil {
			return staged, err
		}
	}
	return staged, nil
}

func (m *mockRepoHostClient) RestoreStagedDelete(ctx context.Context, staged repohost.StagedDelete) error {
	m.restoreDeleteCalls++
	if m.restoreDeleteRepoFn != nil {
		return m.restoreDeleteRepoFn(ctx, staged)
	}
	return nil
}

func (m *mockRepoHostClient) FinalizeStagedDelete(ctx context.Context, staged repohost.StagedDelete) error {
	m.finalizeDeleteCalls++
	if m.finalizeDeleteRepoFn != nil {
		return m.finalizeDeleteRepoFn(ctx, staged)
	}
	return nil
}

func (m *mockRepoHostClient) ForkRepo(ctx context.Context, srcOwner, srcRepo, dstOwner, dstRepo string) error {
	m.forkRepoCalls++
	if m.forkRepoFn != nil {
		return m.forkRepoFn(ctx, srcOwner, srcRepo, dstOwner, dstRepo)
	}
	return nil
}

func (m *mockRepoHostClient) MoveRepo(ctx context.Context, srcOwner, srcRepo, dstOwner, dstRepo string) error {
	m.moveRepoCalls++
	if m.moveRepoFn != nil {
		return m.moveRepoFn(ctx, srcOwner, srcRepo, dstOwner, dstRepo)
	}
	return nil
}

func (m *mockRepoHostClient) StageMoveRepo(ctx context.Context, srcOwner, srcRepo, dstOwner, dstRepo string) (repohost.StagedMove, error) {
	m.moveRepoCalls++
	m.stageMoveCalls++
	if m.stageMoveRepoFn != nil {
		return m.stageMoveRepoFn(ctx, srcOwner, srcRepo, dstOwner, dstRepo)
	}
	staged := repohost.StagedMove{
		BaseURL:  "http://repo-host.test",
		Token:    "test-move-stage",
		SrcOwner: srcOwner,
		SrcRepo:  srcRepo,
		DstOwner: dstOwner,
		DstRepo:  dstRepo,
	}
	if m.moveRepoFn != nil {
		if err := m.moveRepoFn(ctx, srcOwner, srcRepo, dstOwner, dstRepo); err != nil {
			return staged, err
		}
	}
	return staged, nil
}

func (m *mockRepoHostClient) RollbackStagedMove(ctx context.Context, staged repohost.StagedMove) error {
	m.rollbackMoveCalls++
	if m.rollbackMoveRepoFn != nil {
		return m.rollbackMoveRepoFn(ctx, staged)
	}
	return nil
}

func (m *mockRepoHostClient) FinalizeStagedMove(ctx context.Context, staged repohost.StagedMove) error {
	m.finalizeMoveCalls++
	if m.finalizeMoveRepoFn != nil {
		return m.finalizeMoveRepoFn(ctx, staged)
	}
	return nil
}

func (m *mockRepoHostClient) GetFileAtChange(ctx context.Context, owner, repo, changeID, path string) (repohost.FileContent, error) {
	if m.getFileAtChangeFn != nil {
		return m.getFileAtChangeFn(ctx, owner, repo, changeID, path)
	}
	return repohost.FileContent{}, nil
}

func (m *mockRepoHostClient) ListBookmarks(ctx context.Context, owner, repo, cursor string, limit int) ([]repohost.Bookmark, string, error) {
	if m.listBookmarksFn != nil {
		return m.listBookmarksFn(ctx, owner, repo, cursor, limit)
	}
	return nil, "", nil
}

func TestRepoService_RollbackProvisionedRepoCleanupOrdering(t *testing.T) {
	t.Run("deletes the database row after storage", func(t *testing.T) {
		calls := []string{}
		q := &mockRepoQuerier{deleteRepoFn: func(context.Context, int64) error {
			calls = append(calls, "database")
			return nil
		}}
		rh := &mockRepoHostClient{deleteRepoFn: func(context.Context, string, string) error {
			calls = append(calls, "storage")
			return nil
		}}

		NewRepoService(q, rh, "s1").rollbackProvisionedRepo(context.Background(), 42, "alice", "demo")

		assert.Equal(t, []string{"storage", "database"}, calls)
	})

	t.Run("preserves the database row when storage cleanup fails", func(t *testing.T) {
		calls := []string{}
		q := &mockRepoQuerier{deleteRepoFn: func(context.Context, int64) error {
			calls = append(calls, "database")
			return nil
		}}
		rh := &mockRepoHostClient{deleteRepoFn: func(context.Context, string, string) error {
			calls = append(calls, "storage")
			return fmt.Errorf("repo-host unavailable")
		}}

		NewRepoService(q, rh, "s1").rollbackProvisionedRepo(context.Background(), 42, "alice", "demo")

		assert.Equal(t, []string{"storage"}, calls)
		assert.False(t, q.deleteCalled, "the row must remain while repo-host still needs it to resolve storage")
	})
}

func (m *mockRepoHostClient) ListFilesAtChange(ctx context.Context, owner, repo, changeID, prefix string) ([]repohost.ChangeFile, error) {
	if m.listFilesAtChangeFn != nil {
		return m.listFilesAtChangeFn(ctx, owner, repo, changeID, prefix)
	}
	return nil, nil
}

func testUser() *db.User {
	return &db.User{ID: 1, Username: "testuser"}
}

func testRepo(overrides func(*db.Repository)) db.Repository {
	now := time.Now().UTC().Truncate(time.Second)
	r := db.Repository{
		ID:              42,
		UserID:          pgtype.Int8{Int64: 1, Valid: true},
		Name:            "demo",
		LowerName:       "demo",
		Description:     "seed repo",
		IsPublic:        false,
		DefaultBookmark: "main",
		Topics:          []string{"backend"},
		CreatedAt:       now,
		UpdatedAt:       now,
	}
	if overrides != nil {
		overrides(&r)
	}
	return r
}

func stringPtr(v string) *string { return &v }
func boolPtr(v bool) *bool       { return &v }
func topicsPtr(v []string) *[]string {
	return &v
}

func apiStatus(t *testing.T, err error) int {
	t.Helper()
	require.Error(t, err)
	apiErr, ok := err.(*errors.APIError)
	require.True(t, ok)
	return apiErr.Status
}

func apiError(t *testing.T, err error) *errors.APIError {
	t.Helper()
	require.Error(t, err)
	apiErr, ok := err.(*errors.APIError)
	require.True(t, ok)
	return apiErr
}

func assertInvalidRepoNameError(t *testing.T, err error) {
	t.Helper()
	apiErr := apiError(t, err)
	assert.Equal(t, http.StatusUnprocessableEntity, apiErr.Status)
	require.NotEmpty(t, apiErr.Errors)
	assert.Equal(t, "invalid", apiErr.Errors[0].Code)
}

func TestCreateRepo_Success(t *testing.T) {
	q := &mockRepoQuerier{}
	rh := &mockRepoHostClient{}
	svc := NewRepoService(q, rh, "smithers-repo-host-0")

	repo, err := svc.CreateRepo(context.Background(), testUser(), "my-repo", "A test repo", true, "", false)
	require.NoError(t, err)
	assert.Equal(t, "my-repo", repo.Name)
	assert.Equal(t, "main", repo.DefaultBookmark)
	assert.True(t, repo.IsPublic)
	assert.Equal(t, pgtype.Int8{Int64: 1, Valid: true}, repo.UserID)
}

func TestCreateRepo_EmptyName(t *testing.T) {
	svc := NewRepoService(&mockRepoQuerier{}, &mockRepoHostClient{}, "smithers-repo-host-0")

	_, err := svc.CreateRepo(context.Background(), testUser(), "", "desc", true, "", false)
	require.Error(t, err)
	apiErr, ok := err.(*errors.APIError)
	require.True(t, ok)
	assert.Equal(t, 422, apiErr.Status)
	require.Len(t, apiErr.Errors, 1)
	assert.Equal(t, "missing_field", apiErr.Errors[0].Code)
}

func TestCreateRepo_NameTooLong(t *testing.T) {
	svc := NewRepoService(&mockRepoQuerier{}, &mockRepoHostClient{}, "smithers-repo-host-0")

	longName := strings.Repeat("a", 101)
	_, err := svc.CreateRepo(context.Background(), testUser(), longName, "", true, "", false)
	require.Error(t, err)
	apiErr, ok := err.(*errors.APIError)
	require.True(t, ok)
	assert.Equal(t, 422, apiErr.Status)
	assert.Equal(t, "invalid", apiErr.Errors[0].Code)
}

func TestCreateRepo_InvalidChars(t *testing.T) {
	svc := NewRepoService(&mockRepoQuerier{}, &mockRepoHostClient{}, "smithers-repo-host-0")

	_, err := svc.CreateRepo(context.Background(), testUser(), "bad repo name!", "", true, "", false)
	require.Error(t, err)
	apiErr, ok := err.(*errors.APIError)
	require.True(t, ok)
	assert.Equal(t, 422, apiErr.Status)
}

func TestCreateRepo_InvalidDefaultBookmark(t *testing.T) {
	svc := NewRepoService(&mockRepoQuerier{}, &mockRepoHostClient{}, "smithers-repo-host-0")

	_, err := svc.CreateRepo(context.Background(), testUser(), "repo", "", true, "bad branch", false)
	apiErr := apiError(t, err)
	assert.Equal(t, http.StatusUnprocessableEntity, apiErr.Status)
	require.Len(t, apiErr.Errors, 1)
	assert.Equal(t, "default_bookmark", apiErr.Errors[0].Field)
	assert.Equal(t, "invalid", apiErr.Errors[0].Code)
}

func TestCreateRepo_ReservedNames(t *testing.T) {
	svc := NewRepoService(&mockRepoQuerier{}, &mockRepoHostClient{}, "smithers-repo-host-0")
	// Keep this set aligned with reservedRepoNames in repo.go (REPO-003).
	names := []string{
		"issues",
		"pulls",
		"settings",
		"labels",
		"milestones",
		"landings",
		"changes",
		"bookmarks",
		"operations",
		"workflows",
		"agent",
		"commits",
		"stargazers",
		"watchers",
		"contributors",
		"Issues",
		"SETTINGS",
		"WoRkFlOwS",
	}

	for _, name := range names {
		t.Run(name, func(t *testing.T) {
			_, err := svc.CreateRepo(context.Background(), testUser(), name, "", true, "", false)
			assertInvalidRepoNameError(t, err)
		})
	}
}

func TestCreateRepo_GitSuffixRejected(t *testing.T) {
	svc := NewRepoService(&mockRepoQuerier{}, &mockRepoHostClient{}, "smithers-repo-host-0")
	names := []string{
		"repo.git",
		"repo.GIT",
		"repo.Git",
		"repo.v1.git",
	}

	for _, name := range names {
		t.Run(name, func(t *testing.T) {
			_, err := svc.CreateRepo(context.Background(), testUser(), name, "", true, "", false)
			assertInvalidRepoNameError(t, err)
		})
	}
}

func TestCreateRepo_ValidNamesNotBlocked(t *testing.T) {
	svc := NewRepoService(&mockRepoQuerier{}, &mockRepoHostClient{}, "smithers-repo-host-0")
	names := []string{
		"repo",
		"my-repo",
		"my_repo",
		"my.repo",
		"issue-tracker",
		"settings-ui",
		"workflow-agent",
		"a",
		strings.Repeat("a", 100),
		"v1.2.3",
	}

	for _, name := range names {
		t.Run(name, func(t *testing.T) {
			_, err := svc.CreateRepo(context.Background(), testUser(), name, "", true, "", false)
			require.NoError(t, err)
		})
	}
}

func TestCreateRepo_DuplicateName(t *testing.T) {
	q := &mockRepoQuerier{
		createRepoFn: func(ctx context.Context, arg db.CreateRepoParams) (db.Repository, error) {
			return db.Repository{}, fmt.Errorf("duplicate key value violates unique constraint")
		},
	}
	svc := NewRepoService(q, &mockRepoHostClient{}, "smithers-repo-host-0")

	_, err := svc.CreateRepo(context.Background(), testUser(), "my-repo", "", true, "", false)
	require.Error(t, err)
	apiErr, ok := err.(*errors.APIError)
	require.True(t, ok)
	assert.Equal(t, 409, apiErr.Status)
}

func TestCreateRepo_RepoHostFailure(t *testing.T) {
	q := &mockRepoQuerier{}
	rh := &mockRepoHostClient{
		initRepoFn: func(ctx context.Context, owner, repo, defaultBookmark string, autoInit bool) error {
			return fmt.Errorf("connection refused")
		},
	}
	svc := NewRepoService(q, rh, "smithers-repo-host-0")

	_, err := svc.CreateRepo(context.Background(), testUser(), "my-repo", "", true, "", false)
	require.Error(t, err)
	apiErr, ok := err.(*errors.APIError)
	require.True(t, ok)
	assert.Equal(t, 500, apiErr.Status)
	assert.Equal(t, 1, rh.deleteRepoCalls, "should remove any partially-created repo-host data")
	assert.True(t, q.deleteCalled, "should rollback DB record on repo-host failure")
}

func TestCreateRepo_RepoHostFailureCleanupIsOrderedAndDetached(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	var calls []string
	q := &mockRepoQuerier{
		deleteRepoFn: func(cleanupCtx context.Context, _ int64) error {
			require.NoError(t, cleanupCtx.Err())
			calls = append(calls, "db")
			return nil
		},
	}
	rh := &mockRepoHostClient{
		initRepoFn: func(context.Context, string, string, string, bool) error {
			t.Fatal("repo-host init must not start after request cancellation")
			return nil
		},
		deleteRepoFn: func(cleanupCtx context.Context, owner, repo string) error {
			require.NoError(t, cleanupCtx.Err())
			assert.Equal(t, "testuser", owner)
			assert.Equal(t, "my-repo", repo)
			calls = append(calls, "repo-host")
			return nil
		},
	}

	_, err := NewRepoService(q, rh, "s1").CreateRepo(ctx, testUser(), "my-repo", "", true, "", false)
	require.Error(t, err)
	assert.Equal(t, []string{"repo-host", "db"}, calls)
}

func TestCreateOrgRepo_Success(t *testing.T) {
	q := &mockRepoQuerier{
		getOrgByLowerNameFn: func(ctx context.Context, lowerName string) (db.Organization, error) {
			assert.Equal(t, "acme", lowerName)
			return db.Organization{ID: 77, Name: "acme", LowerName: "acme"}, nil
		},
		getOrgMemberFn: func(ctx context.Context, arg db.GetOrgMemberParams) (db.OrgMember, error) {
			assert.Equal(t, int64(77), arg.OrganizationID)
			assert.Equal(t, int64(1), arg.UserID)
			return db.OrgMember{OrganizationID: 77, UserID: 1, Role: "owner"}, nil
		},
		createOrgRepoFn: func(ctx context.Context, arg db.CreateOrgRepoParams) (db.Repository, error) {
			assert.Equal(t, pgtype.Int8{Int64: 77, Valid: true}, arg.OrgID)
			assert.Equal(t, "my-org-repo", arg.Name)
			assert.Equal(t, "my-org-repo", arg.LowerName)
			assert.Equal(t, "desc", arg.Description)
			assert.False(t, arg.IsPublic)
			return db.Repository{
				ID:              15,
				OrgID:           arg.OrgID,
				Name:            arg.Name,
				LowerName:       arg.LowerName,
				Description:     arg.Description,
				IsPublic:        arg.IsPublic,
				DefaultBookmark: "main",
			}, nil
		},
	}
	rh := &mockRepoHostClient{
		initRepoFn: func(ctx context.Context, owner, repo, defaultBookmark string, autoInit bool) error {
			assert.Equal(t, "acme", owner)
			assert.Equal(t, "my-org-repo", repo)
			assert.Equal(t, "main", defaultBookmark)
			assert.False(t, autoInit)
			return nil
		},
	}
	svc := NewRepoService(q, rh, "smithers-repo-host-0")

	repo, err := svc.CreateOrgRepo(context.Background(), testUser(), "acme", "my-org-repo", "desc", false, "", false)
	require.NoError(t, err)
	assert.Equal(t, int64(15), repo.ID)
	assert.Equal(t, "my-org-repo", repo.Name)
	assert.False(t, repo.IsPublic)
}

func TestCreateOrgRepo_RequiresAuthentication(t *testing.T) {
	svc := NewRepoService(&mockRepoQuerier{}, &mockRepoHostClient{}, "smithers-repo-host-0")
	_, err := svc.CreateOrgRepo(context.Background(), nil, "acme", "repo", "", true, "", false)
	assert.Equal(t, 401, apiStatus(t, err))
}

func TestCreateOrgRepo_InvalidDefaultBookmark(t *testing.T) {
	orgLookups := 0
	q := &mockRepoQuerier{
		getOrgByLowerNameFn: func(context.Context, string) (db.Organization, error) {
			orgLookups++
			return db.Organization{}, nil
		},
	}

	_, err := NewRepoService(q, &mockRepoHostClient{}, "smithers-repo-host-0").CreateOrgRepo(
		context.Background(), testUser(), "acme", "repo", "", true, "topic..branch", false,
	)
	apiErr := apiError(t, err)
	assert.Equal(t, http.StatusUnprocessableEntity, apiErr.Status)
	require.Len(t, apiErr.Errors, 1)
	assert.Equal(t, "default_bookmark", apiErr.Errors[0].Field)
	assert.Zero(t, orgLookups, "invalid bookmark must fail before database or storage work")
}

func TestCreateOrgRepo_OrganizationNotFound(t *testing.T) {
	q := &mockRepoQuerier{
		getOrgByLowerNameFn: func(ctx context.Context, lowerName string) (db.Organization, error) {
			return db.Organization{}, pgx.ErrNoRows
		},
	}
	svc := NewRepoService(q, &mockRepoHostClient{}, "smithers-repo-host-0")

	_, err := svc.CreateOrgRepo(context.Background(), testUser(), "acme", "repo", "", true, "", false)
	assert.Equal(t, 404, apiStatus(t, err))
}

func TestCreateOrgRepo_RequiresOrgOwnerRole(t *testing.T) {
	q := &mockRepoQuerier{
		getOrgByLowerNameFn: func(ctx context.Context, lowerName string) (db.Organization, error) {
			return db.Organization{ID: 77, Name: "acme", LowerName: "acme"}, nil
		},
		getOrgMemberFn: func(ctx context.Context, arg db.GetOrgMemberParams) (db.OrgMember, error) {
			return db.OrgMember{OrganizationID: 77, UserID: 1, Role: "member"}, nil
		},
	}
	svc := NewRepoService(q, &mockRepoHostClient{}, "smithers-repo-host-0")

	_, err := svc.CreateOrgRepo(context.Background(), testUser(), "acme", "repo", "", true, "", false)
	assert.Equal(t, 403, apiStatus(t, err))
}

func TestRepoService_GetRepo_AccessMatrix(t *testing.T) {
	tests := []struct {
		name          string
		viewer        *db.User
		repo          db.Repository
		isOrgOwner    bool
		teamPerm      string
		expectedCode  int
		expectSuccess bool
	}{
		{
			name:          "public repo allows anonymous",
			viewer:        nil,
			repo:          testRepo(func(r *db.Repository) { r.IsPublic = true; r.UserID = pgtype.Int8{Int64: 99, Valid: true} }),
			expectSuccess: true,
		},
		{
			name:          "private user repo allows owner",
			viewer:        &db.User{ID: 99, Username: "alice"},
			repo:          testRepo(func(r *db.Repository) { r.IsPublic = false; r.UserID = pgtype.Int8{Int64: 99, Valid: true} }),
			expectSuccess: true,
		},
		{
			name:          "private org repo allows org owner",
			viewer:        &db.User{ID: 7, Username: "alice"},
			repo:          testRepo(func(r *db.Repository) { r.OrgID = pgtype.Int8{Int64: 4, Valid: true}; r.UserID = pgtype.Int8{} }),
			isOrgOwner:    true,
			expectSuccess: true,
		},
		{
			name:          "private org repo allows team read",
			viewer:        &db.User{ID: 8, Username: "bob"},
			repo:          testRepo(func(r *db.Repository) { r.OrgID = pgtype.Int8{Int64: 4, Valid: true}; r.UserID = pgtype.Int8{} }),
			teamPerm:      "read",
			expectSuccess: true,
		},
		{
			name:         "private repo denies unauthorized viewer",
			viewer:       &db.User{ID: 500, Username: "outsider"},
			repo:         testRepo(func(r *db.Repository) { r.IsPublic = false; r.UserID = pgtype.Int8{Int64: 99, Valid: true} }),
			expectedCode: 403,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			q := &mockRepoQuerier{
				getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
					assert.Equal(t, "owner", arg.Owner)
					assert.Equal(t, "repo", arg.LowerName)
					return tc.repo, nil
				},
				isOrgOwnerForRepoUserFn: func(ctx context.Context, arg db.IsOrgOwnerForRepoUserParams) (bool, error) {
					assert.Equal(t, tc.repo.ID, arg.RepositoryID)
					if tc.viewer != nil {
						assert.Equal(t, tc.viewer.ID, arg.UserID)
					}
					return tc.isOrgOwner, nil
				},
				getHighestTeamPermissionForRepo: func(ctx context.Context, arg db.GetHighestTeamPermissionForRepoUserParams) (string, error) {
					assert.Equal(t, tc.repo.ID, arg.RepositoryID)
					if tc.viewer != nil {
						assert.Equal(t, tc.viewer.ID, arg.UserID)
					}
					return tc.teamPerm, nil
				},
			}
			svc := NewRepoService(q, &mockRepoHostClient{}, "smithers-repo-host-0")

			repo, err := svc.GetRepo(context.Background(), tc.viewer, "OWNER", "Repo")
			if tc.expectSuccess {
				require.NoError(t, err)
				assert.Equal(t, tc.repo.ID, repo.ID)
				return
			}

			assert.Equal(t, tc.expectedCode, apiStatus(t, err))
		})
	}
}

func TestRepoService_GetRepo_NotFoundMapsTo404(t *testing.T) {
	q := &mockRepoQuerier{
		getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return db.Repository{}, pgx.ErrNoRows
		},
	}
	svc := NewRepoService(q, &mockRepoHostClient{}, "smithers-repo-host-0")

	_, err := svc.GetRepo(context.Background(), nil, "alice", "missing")
	assert.Equal(t, 404, apiStatus(t, err))
}

func TestRepoService_UpdateRepo_RequiresAuthentication(t *testing.T) {
	svc := NewRepoService(&mockRepoQuerier{}, &mockRepoHostClient{}, "smithers-repo-host-0")
	_, err := svc.UpdateRepo(context.Background(), nil, "alice", "repo", UpdateRepoRequest{})
	assert.Equal(t, 401, apiStatus(t, err))
}

func TestRepoService_UpdateRepo_ValidatesName(t *testing.T) {
	tests := []struct {
		name      string
		newName   string
		expStatus int
	}{
		{name: "empty", newName: "", expStatus: 422},
		{name: "too long", newName: strings.Repeat("a", 101), expStatus: 422},
		{name: "invalid chars", newName: "bad name!", expStatus: 422},
		{name: "reserved", newName: "issues", expStatus: 422},
		{name: "reserved mixed case", newName: "WoRkFlOwS", expStatus: 422},
		{name: "git suffix", newName: "repo.git", expStatus: 422},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			svc := NewRepoService(&mockRepoQuerier{}, &mockRepoHostClient{}, "smithers-repo-host-0")
			_, err := svc.UpdateRepo(context.Background(), testUser(), "alice", "repo", UpdateRepoRequest{Name: stringPtr(tc.newName)})
			assert.Equal(t, tc.expStatus, apiStatus(t, err))
		})
	}
}

func TestRepoService_UpdateRepo_RequiresAdminPermission(t *testing.T) {
	tests := []struct {
		name         string
		actorID      int64
		repo         db.Repository
		isOrgOwner   bool
		teamPerm     string
		expectedCode int
		allowUpdate  bool
	}{
		{
			name:        "user owner allowed",
			actorID:     1,
			repo:        testRepo(func(r *db.Repository) { r.UserID = pgtype.Int8{Int64: 1, Valid: true}; r.OrgID = pgtype.Int8{} }),
			allowUpdate: true,
		},
		{
			name:        "org owner allowed",
			actorID:     2,
			repo:        testRepo(func(r *db.Repository) { r.UserID = pgtype.Int8{}; r.OrgID = pgtype.Int8{Int64: 9, Valid: true} }),
			isOrgOwner:  true,
			allowUpdate: true,
		},
		{
			name:        "team admin allowed",
			actorID:     3,
			repo:        testRepo(func(r *db.Repository) { r.UserID = pgtype.Int8{}; r.OrgID = pgtype.Int8{Int64: 9, Valid: true} }),
			teamPerm:    "admin",
			allowUpdate: true,
		},
		{
			name:         "team write denied",
			actorID:      4,
			repo:         testRepo(func(r *db.Repository) { r.UserID = pgtype.Int8{}; r.OrgID = pgtype.Int8{Int64: 9, Valid: true} }),
			teamPerm:     "write",
			expectedCode: 403,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			q := &mockRepoQuerier{
				getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
					return tc.repo, nil
				},
				isOrgOwnerForRepoUserFn: func(ctx context.Context, arg db.IsOrgOwnerForRepoUserParams) (bool, error) {
					return tc.isOrgOwner, nil
				},
				getHighestTeamPermissionForRepo: func(ctx context.Context, arg db.GetHighestTeamPermissionForRepoUserParams) (string, error) {
					return tc.teamPerm, nil
				},
				updateRepoFn: func(ctx context.Context, arg db.UpdateRepoParams) (db.Repository, error) {
					assert.Equal(t, tc.repo.ID, arg.ID)
					return tc.repo, nil
				},
			}
			svc := NewRepoService(q, &mockRepoHostClient{}, "smithers-repo-host-0")

			_, err := svc.UpdateRepo(context.Background(), &db.User{ID: tc.actorID, Username: "actor"}, "owner", "repo", UpdateRepoRequest{Description: stringPtr("new desc")})
			if tc.allowUpdate {
				require.NoError(t, err)
				assert.True(t, q.updateCalled)
				return
			}

			assert.False(t, q.updateCalled)
			assert.Equal(t, tc.expectedCode, apiStatus(t, err))
		})
	}
}

func TestRepoService_UpdateRepo_AppliesPartialMetadataUpdate(t *testing.T) {
	existing := testRepo(func(r *db.Repository) {
		r.Name = "old-name"
		r.LowerName = "old-name"
		r.Description = "old desc"
		r.IsPublic = true
		r.DefaultBookmark = "main"
		r.Topics = []string{"old"}
		r.UserID = pgtype.Int8{Int64: 15, Valid: true}
	})

	q := &mockRepoQuerier{
		getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return existing, nil
		},
		updateRepoFn: func(ctx context.Context, arg db.UpdateRepoParams) (db.Repository, error) {
			assert.Equal(t, "old-name", arg.Name)
			assert.Equal(t, "old-name", arg.LowerName)
			assert.Equal(t, "updated desc", arg.Description)
			assert.False(t, arg.IsPublic)
			assert.Equal(t, "trunk", arg.DefaultBookmark)
			assert.Equal(t, []string{"jj", "stacked"}, arg.Topics)
			updated := existing
			updated.Description = arg.Description
			updated.IsPublic = arg.IsPublic
			updated.DefaultBookmark = arg.DefaultBookmark
			updated.Topics = arg.Topics
			return updated, nil
		},
	}
	var headBookmark string
	service := NewRepoService(q, &mockRepoHostClient{
		setDefaultBookmarkFn: func(_ context.Context, owner, repo, name string) error {
			assert.Equal(t, "alice", owner)
			assert.Equal(t, "old-name", repo)
			headBookmark = name
			return nil
		},
	}, "smithers-repo-host-0")

	updated, err := service.UpdateRepo(context.Background(), &db.User{ID: 15, Username: "alice"}, "alice", "old-name", UpdateRepoRequest{
		Description:     stringPtr("updated desc"),
		Private:         boolPtr(true),
		DefaultBookmark: stringPtr("trunk"),
		Topics:          topicsPtr([]string{"jj", "stacked"}),
	})
	require.NoError(t, err)
	assert.Equal(t, "updated desc", updated.Description)
	assert.False(t, updated.IsPublic)
	assert.Equal(t, "trunk", updated.DefaultBookmark)
	assert.Equal(t, []string{"jj", "stacked"}, updated.Topics)
	assert.Equal(t, "trunk", headBookmark)
}

func TestRepoService_UpdateRepo_DefaultBookmarkRepoHostFailureLeavesDatabaseUnchanged(t *testing.T) {
	existing := testRepo(nil)
	q := &mockRepoQuerier{
		getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return existing, nil
		},
		updateRepoFn: func(context.Context, db.UpdateRepoParams) (db.Repository, error) {
			t.Fatal("database update must not run when repo-host cannot update HEAD")
			return db.Repository{}, nil
		},
	}
	rh := &mockRepoHostClient{
		setDefaultBookmarkFn: func(context.Context, string, string, string) error {
			return fmt.Errorf("repo-host unavailable")
		},
	}

	_, err := NewRepoService(q, rh, "s1").UpdateRepo(
		context.Background(),
		&db.User{ID: 1, Username: "testuser"},
		"testuser",
		"demo",
		UpdateRepoRequest{DefaultBookmark: stringPtr("trunk")},
	)
	require.Error(t, err)
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))
}

func TestRepoService_UpdateRepo_DatabaseFailureRestoresRepoHostDefaultBookmark(t *testing.T) {
	existing := testRepo(nil)
	q := &mockRepoQuerier{
		getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return existing, nil
		},
		updateRepoFn: func(context.Context, db.UpdateRepoParams) (db.Repository, error) {
			return db.Repository{}, fmt.Errorf("database unavailable")
		},
	}
	var headBookmarks []string
	rh := &mockRepoHostClient{
		setDefaultBookmarkFn: func(_ context.Context, _, _, name string) error {
			headBookmarks = append(headBookmarks, name)
			return nil
		},
	}

	_, err := NewRepoService(q, rh, "s1").UpdateRepo(
		context.Background(),
		&db.User{ID: 1, Username: "testuser"},
		"testuser",
		"demo",
		UpdateRepoRequest{DefaultBookmark: stringPtr("trunk")},
	)
	require.Error(t, err)
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))
	assert.Equal(t, []string{"trunk", "main"}, headBookmarks)
}

func TestRepoService_UpdateRepo_RejectsRename(t *testing.T) {
	existing := testRepo(func(r *db.Repository) { r.Name = "repo"; r.LowerName = "repo" })
	q := &mockRepoQuerier{
		getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return existing, nil
		},
		updateRepoFn: func(ctx context.Context, arg db.UpdateRepoParams) (db.Repository, error) {
			t.Fatalf("rename requests must not hit UpdateRepo query")
			return db.Repository{}, nil
		},
	}
	svc := NewRepoService(q, &mockRepoHostClient{}, "smithers-repo-host-0")

	_, err := svc.UpdateRepo(context.Background(), &db.User{ID: 1, Username: "alice"}, "alice", "repo", UpdateRepoRequest{Name: stringPtr("renamed")})
	assert.Equal(t, 422, apiStatus(t, err))
}

func TestRepoService_UpdateRepo_NotFoundMapsTo404(t *testing.T) {
	q := &mockRepoQuerier{
		getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return db.Repository{}, pgx.ErrNoRows
		},
	}
	svc := NewRepoService(q, &mockRepoHostClient{}, "smithers-repo-host-0")

	_, err := svc.UpdateRepo(context.Background(), &db.User{ID: 1, Username: "alice"}, "alice", "missing", UpdateRepoRequest{})
	assert.Equal(t, 404, apiStatus(t, err))
}

func TestRepoService_DeleteRepo_RequiresAuthentication(t *testing.T) {
	svc := NewRepoService(&mockRepoQuerier{}, &mockRepoHostClient{}, "smithers-repo-host-0")
	err := svc.DeleteRepo(context.Background(), nil, "alice", "repo")
	assert.Equal(t, 401, apiStatus(t, err))
}

func TestRepoService_DeleteRepo_RequiresOwnerPermission(t *testing.T) {
	tests := []struct {
		name         string
		actorID      int64
		repo         db.Repository
		isOrgOwner   bool
		teamPerm     string
		expectedCode int
		allowDelete  bool
	}{
		{
			name:        "user owner allowed",
			actorID:     11,
			repo:        testRepo(func(r *db.Repository) { r.UserID = pgtype.Int8{Int64: 11, Valid: true}; r.OrgID = pgtype.Int8{} }),
			allowDelete: true,
		},
		{
			name:        "org owner allowed",
			actorID:     12,
			repo:        testRepo(func(r *db.Repository) { r.UserID = pgtype.Int8{}; r.OrgID = pgtype.Int8{Int64: 22, Valid: true} }),
			isOrgOwner:  true,
			allowDelete: true,
		},
		{
			name:         "team admin denied",
			actorID:      13,
			repo:         testRepo(func(r *db.Repository) { r.UserID = pgtype.Int8{}; r.OrgID = pgtype.Int8{Int64: 22, Valid: true} }),
			teamPerm:     "admin",
			expectedCode: 403,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			q := &mockRepoQuerier{
				getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
					return tc.repo, nil
				},
				isOrgOwnerForRepoUserFn: func(ctx context.Context, arg db.IsOrgOwnerForRepoUserParams) (bool, error) {
					return tc.isOrgOwner, nil
				},
				getHighestTeamPermissionForRepo: func(ctx context.Context, arg db.GetHighestTeamPermissionForRepoUserParams) (string, error) {
					return tc.teamPerm, nil
				},
				deleteRepoFn: func(ctx context.Context, id int64) error {
					assert.Equal(t, tc.repo.ID, id)
					return nil
				},
			}
			svc := NewRepoService(q, &mockRepoHostClient{}, "smithers-repo-host-0")

			err := svc.DeleteRepo(context.Background(), &db.User{ID: tc.actorID, Username: "actor"}, "owner", "repo")
			if tc.allowDelete {
				require.NoError(t, err)
				assert.True(t, q.deleteCalled)
				return
			}

			assert.False(t, q.deleteCalled)
			assert.Equal(t, tc.expectedCode, apiStatus(t, err))
		})
	}
}

func TestRepoService_DeleteRepo_NotFoundMapsTo404(t *testing.T) {
	q := &mockRepoQuerier{
		getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return db.Repository{}, pgx.ErrNoRows
		},
	}
	svc := NewRepoService(q, &mockRepoHostClient{}, "smithers-repo-host-0")

	err := svc.DeleteRepo(context.Background(), &db.User{ID: 1, Username: "alice"}, "owner", "repo")
	assert.Equal(t, 404, apiStatus(t, err))
}

func TestRepoService_DeleteRepo_DeleteFailureMapsTo500(t *testing.T) {
	repository := testRepo(func(r *db.Repository) { r.UserID = pgtype.Int8{Int64: 1, Valid: true} })
	q := &mockRepoQuerier{
		getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return repository, nil
		},
		getRepoByIDFn: func(context.Context, int64) (db.Repository, error) {
			return repository, nil
		},
		deleteRepoFn: func(ctx context.Context, id int64) error {
			return fmt.Errorf("database unavailable")
		},
	}
	svc := NewRepoService(q, &mockRepoHostClient{}, "smithers-repo-host-0")

	err := svc.DeleteRepo(context.Background(), &db.User{ID: 1, Username: "alice"}, "owner", "repo")
	assert.Equal(t, 500, apiStatus(t, err))
}

func TestRepoService_DeleteRepo_RepoHostFailureMapsTo500(t *testing.T) {
	repository := testRepo(func(r *db.Repository) {
		r.UserID = pgtype.Int8{Int64: 1, Valid: true}
		r.Name = "repo"
	})
	q := &mockRepoQuerier{
		getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return repository, nil
		},
		deleteRepoFn: func(ctx context.Context, id int64) error {
			t.Fatalf("db delete must not run when repo-host delete fails")
			return nil
		},
	}
	rh := &mockRepoHostClient{
		deleteRepoFn: func(ctx context.Context, owner, repo string) error {
			assert.Equal(t, "owner", owner)
			assert.Equal(t, "repo", repo)
			return fmt.Errorf("repo-host unavailable")
		},
	}
	svc := NewRepoService(q, rh, "smithers-repo-host-0")

	err := svc.DeleteRepo(context.Background(), &db.User{ID: 1, Username: "alice"}, "owner", "repo")
	assert.Equal(t, 500, apiStatus(t, err))
	assert.False(t, q.deleteCalled)
	assert.Equal(t, 1, rh.deleteRepoCalls)
}

func TestRepoService_DeleteRepo_RemovesRepoHostDataBeforeDBDelete(t *testing.T) {
	repository := testRepo(func(r *db.Repository) {
		r.UserID = pgtype.Int8{Int64: 1, Valid: true}
		r.Name = "repo"
	})

	callOrder := make([]string, 0, 2)
	q := &mockRepoQuerier{
		getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return repository, nil
		},
		deleteRepoFn: func(ctx context.Context, id int64) error {
			callOrder = append(callOrder, "db")
			assert.Equal(t, repository.ID, id)
			return nil
		},
	}
	rh := &mockRepoHostClient{
		deleteRepoFn: func(ctx context.Context, owner, repo string) error {
			callOrder = append(callOrder, "repo-host")
			assert.Equal(t, "owner", owner)
			assert.Equal(t, "repo", repo)
			return nil
		},
	}
	svc := NewRepoService(q, rh, "smithers-repo-host-0")

	err := svc.DeleteRepo(context.Background(), &db.User{ID: 1, Username: "alice"}, "owner", "repo")
	require.NoError(t, err)
	assert.True(t, q.deleteCalled)
	assert.Equal(t, []string{"repo-host", "db"}, callOrder)
}

func TestRepoService_TransferRepo_RequiresOwnerPermission(t *testing.T) {
	tests := []struct {
		name             string
		actorID          int64
		repo             db.Repository
		isOrgOwner       bool
		teamPerm         string
		collaboratorPerm string
		expectedCode     int
		allowTransfer    bool
		targetOwner      string
		targetUser       db.User
	}{
		{
			name:          "user owner allowed",
			actorID:       11,
			repo:          testRepo(func(r *db.Repository) { r.UserID = pgtype.Int8{Int64: 11, Valid: true}; r.OrgID = pgtype.Int8{} }),
			targetOwner:   "bob",
			targetUser:    db.User{ID: 21, Username: "bob", LowerUsername: "bob"},
			allowTransfer: true,
		},
		{
			name:             "collaborator admin denied",
			actorID:          12,
			repo:             testRepo(func(r *db.Repository) { r.UserID = pgtype.Int8{Int64: 99, Valid: true}; r.OrgID = pgtype.Int8{} }),
			collaboratorPerm: "admin",
			targetOwner:      "bob",
			expectedCode:     403,
		},
		{
			name:         "team admin denied",
			actorID:      13,
			repo:         testRepo(func(r *db.Repository) { r.UserID = pgtype.Int8{}; r.OrgID = pgtype.Int8{Int64: 22, Valid: true} }),
			teamPerm:     "admin",
			targetOwner:  "bob",
			expectedCode: 403,
		},
		{
			name:          "org owner allowed",
			actorID:       14,
			repo:          testRepo(func(r *db.Repository) { r.UserID = pgtype.Int8{}; r.OrgID = pgtype.Int8{Int64: 22, Valid: true} }),
			isOrgOwner:    true,
			targetOwner:   "bob",
			targetUser:    db.User{ID: 22, Username: "bob", LowerUsername: "bob"},
			allowTransfer: true,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			q := &mockRepoQuerier{
				getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
					if arg.Owner == "owner" && arg.LowerName == "repo" {
						return tc.repo, nil
					}
					return db.Repository{}, pgx.ErrNoRows
				},
				isOrgOwnerForRepoUserFn: func(ctx context.Context, arg db.IsOrgOwnerForRepoUserParams) (bool, error) {
					return tc.isOrgOwner, nil
				},
				getHighestTeamPermissionForRepo: func(ctx context.Context, arg db.GetHighestTeamPermissionForRepoUserParams) (string, error) {
					return tc.teamPerm, nil
				},
				getCollaboratorPermissionForRepo: func(ctx context.Context, arg db.GetCollaboratorPermissionForRepoUserParams) (string, error) {
					return tc.collaboratorPerm, nil
				},
				getUserByLowerUsernameFn: func(ctx context.Context, lowerUsername string) (db.User, error) {
					assert.Equal(t, strings.ToLower(tc.targetOwner), lowerUsername)
					if tc.allowTransfer {
						return tc.targetUser, nil
					}
					t.Fatalf("authorization failure should short-circuit before target owner lookup")
					return db.User{}, nil
				},
				deleteCollaboratorsByRepoFn: func(ctx context.Context, repositoryID int64) error {
					assert.Equal(t, tc.repo.ID, repositoryID)
					return nil
				},
				deleteTeamReposByRepoFn: func(ctx context.Context, repositoryID int64) error {
					assert.Equal(t, tc.repo.ID, repositoryID)
					return nil
				},
				transferRepoToUserFn: func(ctx context.Context, arg db.TransferRepoToUserParams) (db.Repository, error) {
					t.Fatal("creating a transfer request must not change repository ownership")
					return db.Repository{}, nil
				},
			}
			svc := NewRepoService(q, &mockRepoHostClient{}, "smithers-repo-host-0")
			tx := &fakeOwnershipTx{q: q, getByIDFn: func(context.Context, int64) (db.Repository, error) { return tc.repo, nil }}
			svc.ownershipTx = &fakeOwnershipTxManager{tx: tx}

			result, err := svc.TransferRepo(context.Background(), &db.User{ID: tc.actorID, Username: "actor"}, "owner", "repo", tc.targetOwner)
			if tc.allowTransfer {
				require.NoError(t, err)
				require.NotNil(t, result.PendingTransfer)
				assert.Equal(t, tc.repo.ID, result.ID)
				assert.Equal(t, tc.repo.UserID, result.UserID)
				assert.Equal(t, tc.targetUser.ID, result.PendingTransfer.RecipientID)
				assert.True(t, tx.committed)
				assert.False(t, q.transferToUserCalled)
				assert.False(t, q.transferToOrgCalled)
				return
			}

			assert.Equal(t, tc.expectedCode, apiStatus(t, err))
			assert.False(t, q.transferToUserCalled)
			assert.False(t, q.transferToOrgCalled)
		})
	}
}

// --- Coverage gap tests for CreateOrgRepo ---

func TestCreateOrgRepo_EmptyOrgName(t *testing.T) {
	svc := NewRepoService(&mockRepoQuerier{}, &mockRepoHostClient{}, "smithers-repo-host-0")
	_, err := svc.CreateOrgRepo(context.Background(), testUser(), "  ", "repo", "", true, "", false)
	assert.Equal(t, 400, apiStatus(t, err))
}

func TestCreateOrgRepo_InvalidRepoName(t *testing.T) {
	svc := NewRepoService(&mockRepoQuerier{}, &mockRepoHostClient{}, "smithers-repo-host-0")
	_, err := svc.CreateOrgRepo(context.Background(), testUser(), "acme", "bad name!", "", true, "", false)
	assert.Equal(t, 422, apiStatus(t, err))
}

func TestCreateOrgRepo_ReservedRepoName(t *testing.T) {
	svc := NewRepoService(&mockRepoQuerier{}, &mockRepoHostClient{}, "smithers-repo-host-0")
	_, err := svc.CreateOrgRepo(context.Background(), testUser(), "acme", "issues", "", true, "", false)
	assertInvalidRepoNameError(t, err)
}

func TestCreateOrgRepo_OrgLookupInternalError(t *testing.T) {
	q := &mockRepoQuerier{
		getOrgByLowerNameFn: func(ctx context.Context, lowerName string) (db.Organization, error) {
			return db.Organization{}, fmt.Errorf("db unavailable")
		},
	}
	svc := NewRepoService(q, &mockRepoHostClient{}, "smithers-repo-host-0")
	_, err := svc.CreateOrgRepo(context.Background(), testUser(), "acme", "repo", "", true, "", false)
	assert.Equal(t, 500, apiStatus(t, err))
}

func TestCreateOrgRepo_MemberLookupNotMember(t *testing.T) {
	q := &mockRepoQuerier{
		getOrgByLowerNameFn: func(ctx context.Context, lowerName string) (db.Organization, error) {
			return db.Organization{ID: 1, Name: "acme", LowerName: "acme"}, nil
		},
		getOrgMemberFn: func(ctx context.Context, arg db.GetOrgMemberParams) (db.OrgMember, error) {
			return db.OrgMember{}, pgx.ErrNoRows
		},
	}
	svc := NewRepoService(q, &mockRepoHostClient{}, "smithers-repo-host-0")
	_, err := svc.CreateOrgRepo(context.Background(), testUser(), "acme", "repo", "", true, "", false)
	assert.Equal(t, 403, apiStatus(t, err))
}

func TestCreateOrgRepo_MemberLookupInternalError(t *testing.T) {
	q := &mockRepoQuerier{
		getOrgByLowerNameFn: func(ctx context.Context, lowerName string) (db.Organization, error) {
			return db.Organization{ID: 1, Name: "acme", LowerName: "acme"}, nil
		},
		getOrgMemberFn: func(ctx context.Context, arg db.GetOrgMemberParams) (db.OrgMember, error) {
			return db.OrgMember{}, fmt.Errorf("db unavailable")
		},
	}
	svc := NewRepoService(q, &mockRepoHostClient{}, "smithers-repo-host-0")
	_, err := svc.CreateOrgRepo(context.Background(), testUser(), "acme", "repo", "", true, "", false)
	assert.Equal(t, 500, apiStatus(t, err))
}

func TestCreateOrgRepo_DuplicateRepoName(t *testing.T) {
	q := &mockRepoQuerier{
		getOrgByLowerNameFn: func(ctx context.Context, lowerName string) (db.Organization, error) {
			return db.Organization{ID: 1, Name: "acme", LowerName: "acme"}, nil
		},
		getOrgMemberFn: func(ctx context.Context, arg db.GetOrgMemberParams) (db.OrgMember, error) {
			return db.OrgMember{OrganizationID: 1, UserID: 1, Role: "owner"}, nil
		},
		createOrgRepoFn: func(ctx context.Context, arg db.CreateOrgRepoParams) (db.Repository, error) {
			return db.Repository{}, fmt.Errorf("duplicate key value violates unique constraint")
		},
	}
	svc := NewRepoService(q, &mockRepoHostClient{}, "smithers-repo-host-0")
	_, err := svc.CreateOrgRepo(context.Background(), testUser(), "acme", "repo", "", true, "", false)
	assert.Equal(t, 409, apiStatus(t, err))
}

func TestCreateOrgRepo_CreateDBError(t *testing.T) {
	q := &mockRepoQuerier{
		getOrgByLowerNameFn: func(ctx context.Context, lowerName string) (db.Organization, error) {
			return db.Organization{ID: 1, Name: "acme", LowerName: "acme"}, nil
		},
		getOrgMemberFn: func(ctx context.Context, arg db.GetOrgMemberParams) (db.OrgMember, error) {
			return db.OrgMember{OrganizationID: 1, UserID: 1, Role: "owner"}, nil
		},
		createOrgRepoFn: func(ctx context.Context, arg db.CreateOrgRepoParams) (db.Repository, error) {
			return db.Repository{}, fmt.Errorf("other db error")
		},
	}
	svc := NewRepoService(q, &mockRepoHostClient{}, "smithers-repo-host-0")
	_, err := svc.CreateOrgRepo(context.Background(), testUser(), "acme", "repo", "", true, "", false)
	assert.Equal(t, 500, apiStatus(t, err))
}

func TestCreateOrgRepo_RepoHostFailureRollsBack(t *testing.T) {
	q := &mockRepoQuerier{
		getOrgByLowerNameFn: func(ctx context.Context, lowerName string) (db.Organization, error) {
			return db.Organization{ID: 1, Name: "acme", LowerName: "acme"}, nil
		},
		getOrgMemberFn: func(ctx context.Context, arg db.GetOrgMemberParams) (db.OrgMember, error) {
			return db.OrgMember{OrganizationID: 1, UserID: 1, Role: "owner"}, nil
		},
		createOrgRepoFn: func(ctx context.Context, arg db.CreateOrgRepoParams) (db.Repository, error) {
			return db.Repository{ID: 100, Name: arg.Name}, nil
		},
	}
	rh := &mockRepoHostClient{
		initRepoFn: func(ctx context.Context, owner, repo, defaultBookmark string, autoInit bool) error {
			return fmt.Errorf("repo-host unavailable")
		},
	}
	svc := NewRepoService(q, rh, "smithers-repo-host-0")
	_, err := svc.CreateOrgRepo(context.Background(), testUser(), "acme", "repo", "", true, "", false)
	assert.Equal(t, 500, apiStatus(t, err))
	assert.Equal(t, 1, rh.deleteRepoCalls, "should remove any partially-created repo-host data")
	assert.True(t, q.deleteCalled, "should rollback DB record on repo-host failure")
}

// --- Coverage gaps for resolveRepoByOwnerAndName ---

func TestResolveRepoByOwnerAndName_EmptyOwner(t *testing.T) {
	svc := NewRepoService(&mockRepoQuerier{}, &mockRepoHostClient{}, "smithers-repo-host-0")
	_, err := svc.GetRepo(context.Background(), nil, "", "repo")
	assert.Equal(t, 400, apiStatus(t, err))
}

func TestResolveRepoByOwnerAndName_EmptyRepo(t *testing.T) {
	svc := NewRepoService(&mockRepoQuerier{}, &mockRepoHostClient{}, "smithers-repo-host-0")
	_, err := svc.GetRepo(context.Background(), nil, "alice", "")
	assert.Equal(t, 400, apiStatus(t, err))
}

func TestResolveRepoByOwnerAndName_DBError(t *testing.T) {
	q := &mockRepoQuerier{
		getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return db.Repository{}, fmt.Errorf("db unavailable")
		},
	}
	svc := NewRepoService(q, &mockRepoHostClient{}, "smithers-repo-host-0")
	_, err := svc.GetRepo(context.Background(), nil, "alice", "repo")
	assert.Equal(t, 500, apiStatus(t, err))
}

// --- Coverage gaps for GetRepo (private repo + nil viewer) ---

func TestGetRepo_PrivateRepoAnonymousViewerForbidden(t *testing.T) {
	q := &mockRepoQuerier{
		getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return testRepo(func(r *db.Repository) {
				r.IsPublic = false
				r.UserID = pgtype.Int8{Int64: 99, Valid: true}
			}), nil
		},
	}
	svc := NewRepoService(q, &mockRepoHostClient{}, "smithers-repo-host-0")
	_, err := svc.GetRepo(context.Background(), nil, "alice", "private-repo")
	assert.Equal(t, 403, apiStatus(t, err))
}

// --- Coverage gaps for repoPermissionForUser (DB error paths) ---

func TestRepoService_GetRepo_OrgOwnerLookupError(t *testing.T) {
	repo := testRepo(func(r *db.Repository) {
		r.IsPublic = false
		r.UserID = pgtype.Int8{}
		r.OrgID = pgtype.Int8{Int64: 5, Valid: true}
	})
	q := &mockRepoQuerier{
		getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return repo, nil
		},
		isOrgOwnerForRepoUserFn: func(ctx context.Context, arg db.IsOrgOwnerForRepoUserParams) (bool, error) {
			return false, fmt.Errorf("db unavailable")
		},
	}
	svc := NewRepoService(q, &mockRepoHostClient{}, "smithers-repo-host-0")
	_, err := svc.GetRepo(context.Background(), &db.User{ID: 7, Username: "bob"}, "org", "repo")
	assert.Equal(t, 500, apiStatus(t, err))
}

func TestRepoService_GetRepo_TeamPermLookupError(t *testing.T) {
	repo := testRepo(func(r *db.Repository) {
		r.IsPublic = false
		r.UserID = pgtype.Int8{}
		r.OrgID = pgtype.Int8{Int64: 5, Valid: true}
	})
	q := &mockRepoQuerier{
		getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return repo, nil
		},
		isOrgOwnerForRepoUserFn: func(ctx context.Context, arg db.IsOrgOwnerForRepoUserParams) (bool, error) {
			return false, nil
		},
		getHighestTeamPermissionForRepo: func(ctx context.Context, arg db.GetHighestTeamPermissionForRepoUserParams) (string, error) {
			return "", fmt.Errorf("db unavailable")
		},
	}
	svc := NewRepoService(q, &mockRepoHostClient{}, "smithers-repo-host-0")
	_, err := svc.GetRepo(context.Background(), &db.User{ID: 7, Username: "bob"}, "org", "repo")
	assert.Equal(t, 500, apiStatus(t, err))
}

// --- Coverage gaps for UpdateRepo ---

func TestRepoService_UpdateRepo_EmptyDefaultBookmark(t *testing.T) {
	existing := testRepo(func(r *db.Repository) {
		r.UserID = pgtype.Int8{Int64: 1, Valid: true}
	})
	q := &mockRepoQuerier{
		getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return existing, nil
		},
	}
	svc := NewRepoService(q, &mockRepoHostClient{}, "smithers-repo-host-0")
	_, err := svc.UpdateRepo(context.Background(), &db.User{ID: 1, Username: "alice"}, "alice", "demo", UpdateRepoRequest{
		DefaultBookmark: stringPtr("  "),
	})
	assert.Equal(t, 422, apiStatus(t, err))
}

func TestRepoService_UpdateRepo_UniqueViolationMaps409(t *testing.T) {
	existing := testRepo(func(r *db.Repository) {
		r.UserID = pgtype.Int8{Int64: 1, Valid: true}
	})
	q := &mockRepoQuerier{
		getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return existing, nil
		},
		updateRepoFn: func(ctx context.Context, arg db.UpdateRepoParams) (db.Repository, error) {
			return db.Repository{}, fmt.Errorf("duplicate key value violates unique constraint")
		},
	}
	svc := NewRepoService(q, &mockRepoHostClient{}, "smithers-repo-host-0")
	_, err := svc.UpdateRepo(context.Background(), &db.User{ID: 1, Username: "alice"}, "alice", "demo", UpdateRepoRequest{
		Description: stringPtr("new"),
	})
	assert.Equal(t, 409, apiStatus(t, err))
}

func TestRepoService_UpdateRepo_DBErrorMaps500(t *testing.T) {
	existing := testRepo(func(r *db.Repository) {
		r.UserID = pgtype.Int8{Int64: 1, Valid: true}
	})
	q := &mockRepoQuerier{
		getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return existing, nil
		},
		updateRepoFn: func(ctx context.Context, arg db.UpdateRepoParams) (db.Repository, error) {
			return db.Repository{}, fmt.Errorf("db unavailable")
		},
	}
	svc := NewRepoService(q, &mockRepoHostClient{}, "smithers-repo-host-0")
	_, err := svc.UpdateRepo(context.Background(), &db.User{ID: 1, Username: "alice"}, "alice", "demo", UpdateRepoRequest{
		Description: stringPtr("new"),
	})
	assert.Equal(t, 500, apiStatus(t, err))
}

// --- Coverage gaps for isRepoUniqueViolation ---

func TestIsRepoUniqueViolation_NilError(t *testing.T) {
	assert.False(t, isRepoUniqueViolation(nil))
}

func TestIsRepoUniqueViolation_NonUniqueError(t *testing.T) {
	assert.False(t, isRepoUniqueViolation(fmt.Errorf("some other error")))
}

func TestIsRepoUniqueViolation_UniqueKeywordInMessage(t *testing.T) {
	assert.True(t, isRepoUniqueViolation(fmt.Errorf("unique constraint violated")))
}

func TestRepoService_GetRepo_AccessMatrix_CollaboratorReadAllowed(t *testing.T) {
	repo := testRepo(func(r *db.Repository) {
		r.IsPublic = false
		r.UserID = pgtype.Int8{Int64: 999, Valid: true}
		r.OrgID = pgtype.Int8{}
	})
	q := &mockRepoQuerier{
		getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return repo, nil
		},
		getCollaboratorPermissionForRepo: func(ctx context.Context, arg db.GetCollaboratorPermissionForRepoUserParams) (string, error) {
			assert.Equal(t, repo.ID, arg.RepositoryID)
			assert.Equal(t, int64(50), arg.UserID.Int64)
			return "read", nil
		},
	}
	svc := NewRepoService(q, &mockRepoHostClient{}, "smithers-repo-host-0")

	got, err := svc.GetRepo(context.Background(), &db.User{ID: 50, Username: "collab"}, "alice", "demo")
	require.NoError(t, err)
	assert.Equal(t, repo.ID, got.ID)
}

func TestRepoService_UpdateRepo_CollaboratorAdminAllowed(t *testing.T) {
	repo := testRepo(func(r *db.Repository) {
		r.UserID = pgtype.Int8{Int64: 999, Valid: true}
		r.OrgID = pgtype.Int8{}
	})
	q := &mockRepoQuerier{
		getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return repo, nil
		},
		getCollaboratorPermissionForRepo: func(ctx context.Context, arg db.GetCollaboratorPermissionForRepoUserParams) (string, error) {
			return "admin", nil
		},
	}
	svc := NewRepoService(q, &mockRepoHostClient{}, "smithers-repo-host-0")

	updated, err := svc.UpdateRepo(context.Background(), &db.User{ID: 51, Username: "collab-admin"}, "alice", "demo", UpdateRepoRequest{
		Description: stringPtr("updated"),
	})
	require.NoError(t, err)
	assert.Equal(t, "updated", updated.Description)
	assert.True(t, q.updateCalled)
}

func TestRepoService_UpdateRepo_CollaboratorWriteDenied(t *testing.T) {
	repo := testRepo(func(r *db.Repository) {
		r.UserID = pgtype.Int8{Int64: 999, Valid: true}
		r.OrgID = pgtype.Int8{}
	})
	q := &mockRepoQuerier{
		getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return repo, nil
		},
		getCollaboratorPermissionForRepo: func(ctx context.Context, arg db.GetCollaboratorPermissionForRepoUserParams) (string, error) {
			return "write", nil
		},
	}
	svc := NewRepoService(q, &mockRepoHostClient{}, "smithers-repo-host-0")

	_, err := svc.UpdateRepo(context.Background(), &db.User{ID: 52, Username: "collab-write"}, "alice", "demo", UpdateRepoRequest{
		Description: stringPtr("blocked"),
	})
	assert.Equal(t, 403, apiStatus(t, err))
	assert.False(t, q.updateCalled)
}

func TestRepoService_GetRepoTopics(t *testing.T) {
	t.Parallel()

	repository := testRepo(func(r *db.Repository) {
		r.Topics = []string{"go", "jj"}
		r.IsPublic = true
	})
	q := &mockRepoQuerier{
		getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			assert.Equal(t, "alice", arg.Owner)
			assert.Equal(t, "demo", arg.LowerName)
			return repository, nil
		},
	}
	svc := NewRepoService(q, &mockRepoHostClient{}, "smithers-repo-host-0")

	topics, err := svc.GetRepoTopics(context.Background(), nil, "alice", "demo")
	require.NoError(t, err)
	assert.Equal(t, []string{"go", "jj"}, topics)
}

func TestRepoService_ReplaceRepoTopics(t *testing.T) {
	t.Parallel()

	repository := testRepo(func(r *db.Repository) {
		r.UserID = pgtype.Int8{Int64: 1, Valid: true}
		r.Topics = []string{"old"}
	})

	t.Run("rejects invalid topic format", func(t *testing.T) {
		svc := NewRepoService(&mockRepoQuerier{}, &mockRepoHostClient{}, "smithers-repo-host-0")
		_, err := svc.ReplaceRepoTopics(context.Background(), testUser(), "alice", "demo", []string{"bad topic"})
		assert.Equal(t, http.StatusUnprocessableEntity, apiStatus(t, err))
	})

	t.Run("updates topics for owner", func(t *testing.T) {
		q := &mockRepoQuerier{
			getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				return repository, nil
			},
			updateRepoTopicsFn: func(ctx context.Context, arg db.UpdateRepoTopicsParams) (db.Repository, error) {
				assert.Equal(t, repository.ID, arg.ID)
				assert.Equal(t, []string{"go", "jj"}, arg.Topics)
				updated := repository
				updated.Topics = arg.Topics
				return updated, nil
			},
		}
		svc := NewRepoService(q, &mockRepoHostClient{}, "smithers-repo-host-0")

		topics, err := svc.ReplaceRepoTopics(context.Background(), testUser(), "alice", "demo", []string{"Go", "jj"})
		require.NoError(t, err)
		assert.Equal(t, []string{"go", "jj"}, topics)
		assert.True(t, q.updateTopicsCalled)
	})
}

func TestRepoService_GetRepoContents(t *testing.T) {
	t.Parallel()

	repository := testRepo(func(r *db.Repository) {
		r.IsPublic = true
		r.DefaultBookmark = "main"
	})
	rh := &mockRepoHostClient{
		listBookmarksFn: func(ctx context.Context, owner, repo, cursor string, limit int) ([]repohost.Bookmark, string, error) {
			return []repohost.Bookmark{{
				Name:           "main",
				TargetChangeID: "change-abc",
				TargetCommitID: "commit-def",
			}}, "", nil
		},
		getFileAtChangeFn: func(ctx context.Context, owner, repo, changeID, path string) (repohost.FileContent, error) {
			assert.Equal(t, "alice", owner)
			assert.Equal(t, "demo", repo)
			assert.Equal(t, "change-abc", changeID, "bookmark name should be resolved to change ID")
			assert.Equal(t, "README.md", path)
			return repohost.FileContent{
				Path:    "README.md",
				Content: "hello",
			}, nil
		},
	}
	q := &mockRepoQuerier{
		getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return repository, nil
		},
	}
	svc := NewRepoService(q, rh, "smithers-repo-host-0")

	content, err := svc.GetRepoContents(context.Background(), nil, "alice", "demo", "", "README.md")
	require.NoError(t, err)
	assert.Equal(t, "README.md", content.Name)
	assert.Equal(t, "hello", content.Content)
	assert.Equal(t, int64(5), content.Size)
}

func TestRepoService_ListGitRefs(t *testing.T) {
	t.Parallel()

	repository := testRepo(func(r *db.Repository) {
		r.IsPublic = true
	})
	q := &mockRepoQuerier{
		getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return repository, nil
		},
	}
	rh := &mockRepoHostClient{
		listBookmarksFn: func(ctx context.Context, owner, repo, cursor string, limit int) ([]repohost.Bookmark, string, error) {
			assert.Equal(t, "alice", owner)
			assert.Equal(t, "demo", repo)
			assert.Equal(t, "", cursor)
			assert.Equal(t, 100, limit)
			return []repohost.Bookmark{{
				Name:           "main",
				TargetCommitID: "abc123",
			}}, "", nil
		},
	}
	svc := NewRepoService(q, rh, "smithers-repo-host-0")

	refs, err := svc.ListGitRefs(context.Background(), nil, "alice", "demo")
	require.NoError(t, err)
	require.Len(t, refs, 1)
	assert.Equal(t, "refs/heads/main", refs[0].Ref)
	assert.Equal(t, "abc123", refs[0].Object.SHA)
	assert.Equal(t, "commit", refs[0].Object.Type)
}

// paginatedBookmarksFn mimics the real repohost client contract: pages of at
// most `limit` items with an offset-string cursor synthesized while more pages
// remain (the repo-host server itself never returns next_cursor).
func paginatedBookmarksFn(all []repohost.Bookmark) func(ctx context.Context, owner, repo, cursor string, limit int) ([]repohost.Bookmark, string, error) {
	return func(ctx context.Context, owner, repo, cursor string, limit int) ([]repohost.Bookmark, string, error) {
		offset := 0
		if cursor != "" {
			parsed, err := strconv.Atoi(cursor)
			if err != nil {
				return nil, "", fmt.Errorf("bad cursor %q", cursor)
			}
			offset = parsed
		}
		if offset >= len(all) {
			return nil, "", nil
		}
		end := offset + limit
		if end > len(all) {
			end = len(all)
		}
		next := ""
		if end < len(all) {
			next = strconv.Itoa(end)
		}
		return all[offset:end], next, nil
	}
}

// A mirrored repo carries hundreds of bookmarks; sorted alphabetically, "main"
// routinely lands past the first page. Regression for the prod outage where
// contents/refs only ever read page 1 (roninjin10/smithers: 228 bookmarks,
// main at index ~190 → every /contents request 404'd).
func manyBookmarksWithMain(t *testing.T) []repohost.Bookmark {
	t.Helper()
	all := make([]repohost.Bookmark, 0, 228)
	for i := range 227 {
		all = append(all, repohost.Bookmark{
			Name:           fmt.Sprintf("codex/branch-%03d", i),
			TargetChangeID: fmt.Sprintf("change-%03d", i),
		})
	}
	// Sorted position ~190: insert main near the end like the real mirror.
	all = append(all[:190], append([]repohost.Bookmark{{Name: "main", TargetChangeID: "change-main"}}, all[190:]...)...)
	return all
}

func TestRepoService_ListGitRefs_FollowsPagination(t *testing.T) {
	t.Parallel()

	repository := testRepo(func(r *db.Repository) { r.IsPublic = true })
	q := &mockRepoQuerier{
		getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return repository, nil
		},
	}
	all := manyBookmarksWithMain(t)
	rh := &mockRepoHostClient{listBookmarksFn: paginatedBookmarksFn(all)}
	svc := NewRepoService(q, rh, "smithers-repo-host-0")

	refs, err := svc.ListGitRefs(context.Background(), nil, "alice", "demo")
	require.NoError(t, err)
	require.Len(t, refs, len(all), "refs must include every page, not just the first 100")
}

func TestRepoService_GetRepoContents_PassesContextToRepoHost(t *testing.T) {
	t.Parallel()

	type ctxKey string
	ctx := context.WithValue(context.Background(), ctxKey("trace_id"), "trace-repo-content")
	repository := testRepo(func(r *db.Repository) {
		r.IsPublic = true
		r.DefaultBookmark = "main"
	})

	q := &mockRepoQuerier{
		getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return repository, nil
		},
	}
	rh := &mockRepoHostClient{
		listBookmarksFn: func(ctx context.Context, owner, repo, cursor string, limit int) ([]repohost.Bookmark, string, error) {
			return []repohost.Bookmark{{Name: "main", TargetChangeID: "change-abc"}}, "", nil
		},
		getFileAtChangeFn: func(gotCtx context.Context, owner, repo, changeID, path string) (repohost.FileContent, error) {
			assert.Equal(t, "trace-repo-content", gotCtx.Value(ctxKey("trace_id")))
			return repohost.FileContent{Path: "README.md", Content: "ok"}, nil
		},
	}
	svc := NewRepoService(q, rh, "smithers-repo-host-0")

	_, err := svc.GetRepoContents(ctx, nil, "alice", "demo", "", "README.md")
	require.NoError(t, err)
}

func TestRepoService_ResolveChangeRef(t *testing.T) {
	t.Parallel()

	repository := testRepo(func(r *db.Repository) { r.IsPublic = true })

	q := &mockRepoQuerier{
		getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return repository, nil
		},
	}

	t.Run("resolves bookmark name to change ID", func(t *testing.T) {
		rh := &mockRepoHostClient{
			listBookmarksFn: func(ctx context.Context, owner, repo, cursor string, limit int) ([]repohost.Bookmark, string, error) {
				return []repohost.Bookmark{
					{Name: "main", TargetChangeID: "change-111"},
					{Name: "dev", TargetChangeID: "change-222"},
				}, "", nil
			},
		}
		svc := NewRepoService(q, rh, "s1")

		ref, err := svc.resolveChangeRef(context.Background(), "alice", "demo", "main")
		require.NoError(t, err)
		assert.Equal(t, "change-111", ref)

		ref, err = svc.resolveChangeRef(context.Background(), "alice", "demo", "dev")
		require.NoError(t, err)
		assert.Equal(t, "change-222", ref)
	})

	t.Run("resolves one named bookmark among more than 500", func(t *testing.T) {
		bookmarks := map[string]repohost.Bookmark{}
		for i := range 601 {
			name := fmt.Sprintf("branch-%d", i)
			bookmarks[name] = repohost.Bookmark{Name: name, TargetChangeID: name}
		}
		bookmarks["main"] = repohost.Bookmark{Name: "main", TargetChangeID: "change-main"}
		calls := 0
		rh := &mockRepoHostClient{getBookmarkFn: func(_ context.Context, owner, repo, name string) (repohost.Bookmark, error) {
			calls++
			require.Equal(t, "alice", owner)
			require.Equal(t, "demo", repo)
			return bookmarks[name], nil
		}, listBookmarksFn: func(context.Context, string, string, string, int) ([]repohost.Bookmark, string, error) {
			t.Fatal("named resolution must not enumerate bookmarks")
			return nil, "", nil
		}}
		svc := NewRepoService(q, rh, "s1")

		ref, err := svc.resolveChangeRef(context.Background(), "alice", "demo", "main")
		require.NoError(t, err)
		assert.Equal(t, "change-main", ref)
		require.Equal(t, 1, calls)
	})

	t.Run("passes through change ID when no bookmark matches", func(t *testing.T) {
		rh := &mockRepoHostClient{
			listBookmarksFn: func(ctx context.Context, owner, repo, cursor string, limit int) ([]repohost.Bookmark, string, error) {
				return []repohost.Bookmark{
					{Name: "main", TargetChangeID: "change-111"},
				}, "", nil
			},
		}
		svc := NewRepoService(q, rh, "s1")

		ref, err := svc.resolveChangeRef(context.Background(), "alice", "demo", "change-xyz")
		require.NoError(t, err)
		assert.Equal(t, "change-xyz", ref, "non-bookmark ref should pass through unchanged")
	})

	t.Run("passes through when bookmark has empty change ID", func(t *testing.T) {
		rh := &mockRepoHostClient{
			listBookmarksFn: func(ctx context.Context, owner, repo, cursor string, limit int) ([]repohost.Bookmark, string, error) {
				return []repohost.Bookmark{
					{Name: "main", TargetChangeID: ""},
				}, "", nil
			},
		}
		svc := NewRepoService(q, rh, "s1")

		ref, err := svc.resolveChangeRef(context.Background(), "alice", "demo", "main")
		require.NoError(t, err)
		assert.Equal(t, "main", ref, "should fall through when bookmark has no change ID")
	})

	t.Run("returns error when ListBookmarks fails", func(t *testing.T) {
		rh := &mockRepoHostClient{
			listBookmarksFn: func(ctx context.Context, owner, repo, cursor string, limit int) ([]repohost.Bookmark, string, error) {
				return nil, "", fmt.Errorf("repo-host down")
			},
		}
		svc := NewRepoService(q, rh, "s1")

		_, err := svc.resolveChangeRef(context.Background(), "alice", "demo", "main")
		require.Error(t, err)
		assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))
	})

	for _, tc := range []struct {
		name     string
		upstream int
		message  string
		want     int
	}{
		{"missing storage", 404, "not found", http.StatusNotFound},
		{"misleading message", 500, "status 404", http.StatusInternalServerError},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rh := &mockRepoHostClient{listBookmarksFn: func(context.Context, string, string, string, int) ([]repohost.Bookmark, string, error) {
				return nil, "", &repohost.StatusError{StatusCode: tc.upstream, Message: tc.message}
			}}
			svc := NewRepoService(q, rh, "s1")
			_, err := svc.GetRepoContents(context.Background(), nil, "alice", "demo", "main", "README.md")
			require.Error(t, err)
			assert.Equal(t, tc.want, apiStatus(t, err))
			if tc.want == http.StatusNotFound {
				assert.Equal(t, "repository storage not found", err.(*errors.APIError).Message)
			}
		})
	}

	t.Run("passes through when no bookmarks exist", func(t *testing.T) {
		rh := &mockRepoHostClient{
			listBookmarksFn: func(ctx context.Context, owner, repo, cursor string, limit int) ([]repohost.Bookmark, string, error) {
				return nil, "", nil
			},
		}
		svc := NewRepoService(q, rh, "s1")

		ref, err := svc.resolveChangeRef(context.Background(), "alice", "demo", "some-change-id")
		require.NoError(t, err)
		assert.Equal(t, "some-change-id", ref)
	})
}

func TestRepoService_ListRepoContents(t *testing.T) {
	t.Parallel()

	repository := testRepo(func(r *db.Repository) {
		r.IsPublic = true
		r.DefaultBookmark = "main"
	})

	q := &mockRepoQuerier{
		getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return repository, nil
		},
	}

	t.Run("resolves default bookmark and lists root files", func(t *testing.T) {
		rh := &mockRepoHostClient{
			listBookmarksFn: func(ctx context.Context, owner, repo, cursor string, limit int) ([]repohost.Bookmark, string, error) {
				return []repohost.Bookmark{
					{Name: "main", TargetChangeID: "change-root"},
				}, "", nil
			},
			listFilesAtChangeFn: func(ctx context.Context, owner, repo, changeID, prefix string) ([]repohost.ChangeFile, error) {
				assert.Equal(t, "change-root", changeID, "should use resolved change ID, not bookmark name")
				assert.Equal(t, "", prefix)
				return []repohost.ChangeFile{
					{Path: "README.md"},
					{Path: "src/main.go"},
					{Path: "src/handler.go"},
					{Path: "go.mod"},
				}, nil
			},
		}
		svc := NewRepoService(q, rh, "s1")

		entries, err := svc.ListRepoContents(context.Background(), nil, "alice", "demo", "", "")
		require.NoError(t, err)
		require.Len(t, entries, 3, "should have README.md, src/, go.mod")

		byName := map[string]RepoContent{}
		for _, e := range entries {
			byName[e.Name] = e
		}
		assert.Equal(t, "file", byName["README.md"].Type)
		assert.Equal(t, "README.md", byName["README.md"].Path)
		assert.Equal(t, "dir", byName["src"].Type)
		assert.Equal(t, "src", byName["src"].Path)
		assert.Equal(t, "file", byName["go.mod"].Type)
	})

	t.Run("resolves explicit ref bookmark", func(t *testing.T) {
		rh := &mockRepoHostClient{
			listBookmarksFn: func(ctx context.Context, owner, repo, cursor string, limit int) ([]repohost.Bookmark, string, error) {
				return []repohost.Bookmark{
					{Name: "main", TargetChangeID: "change-main"},
					{Name: "dev", TargetChangeID: "change-dev"},
				}, "", nil
			},
			listFilesAtChangeFn: func(ctx context.Context, owner, repo, changeID, prefix string) ([]repohost.ChangeFile, error) {
				assert.Equal(t, "change-dev", changeID, "should resolve explicit ref=dev")
				return []repohost.ChangeFile{{Path: "dev-file.txt"}}, nil
			},
		}
		svc := NewRepoService(q, rh, "s1")

		entries, err := svc.ListRepoContents(context.Background(), nil, "alice", "demo", "dev", "")
		require.NoError(t, err)
		require.Len(t, entries, 1)
		assert.Equal(t, "dev-file.txt", entries[0].Name)
	})

	t.Run("passes change ID through when not a bookmark", func(t *testing.T) {
		rh := &mockRepoHostClient{
			listBookmarksFn: func(ctx context.Context, owner, repo, cursor string, limit int) ([]repohost.Bookmark, string, error) {
				return []repohost.Bookmark{
					{Name: "main", TargetChangeID: "change-main"},
				}, "", nil
			},
			listFilesAtChangeFn: func(ctx context.Context, owner, repo, changeID, prefix string) ([]repohost.ChangeFile, error) {
				assert.Equal(t, "direct-change-id", changeID, "should pass through non-bookmark ref")
				return []repohost.ChangeFile{{Path: "file.txt"}}, nil
			},
		}
		svc := NewRepoService(q, rh, "s1")

		entries, err := svc.ListRepoContents(context.Background(), nil, "alice", "demo", "direct-change-id", "")
		require.NoError(t, err)
		require.Len(t, entries, 1)
	})

	t.Run("returns empty slice not nil for empty repo", func(t *testing.T) {
		rh := &mockRepoHostClient{
			listBookmarksFn: func(ctx context.Context, owner, repo, cursor string, limit int) ([]repohost.Bookmark, string, error) {
				return []repohost.Bookmark{
					{Name: "main", TargetChangeID: "change-empty"},
				}, "", nil
			},
			listFilesAtChangeFn: func(ctx context.Context, owner, repo, changeID, prefix string) ([]repohost.ChangeFile, error) {
				return []repohost.ChangeFile{}, nil
			},
		}
		svc := NewRepoService(q, rh, "s1")

		entries, err := svc.ListRepoContents(context.Background(), nil, "alice", "demo", "", "")
		require.NoError(t, err)
		require.NotNil(t, entries, "should return non-nil empty slice for JSON serialization")
		assert.Len(t, entries, 0)
	})

	t.Run("subdirectory listing filters to immediate children", func(t *testing.T) {
		rh := &mockRepoHostClient{
			listBookmarksFn: func(ctx context.Context, owner, repo, cursor string, limit int) ([]repohost.Bookmark, string, error) {
				return []repohost.Bookmark{
					{Name: "main", TargetChangeID: "change-sub"},
				}, "", nil
			},
			listFilesAtChangeFn: func(ctx context.Context, owner, repo, changeID, prefix string) ([]repohost.ChangeFile, error) {
				assert.Equal(t, "src", prefix)
				return []repohost.ChangeFile{
					{Path: "src/main.go"},
					{Path: "src/handler.go"},
					{Path: "src/internal/util.go"},
				}, nil
			},
		}
		svc := NewRepoService(q, rh, "s1")

		entries, err := svc.ListRepoContents(context.Background(), nil, "alice", "demo", "", "src")
		require.NoError(t, err)
		require.Len(t, entries, 3)

		byName := map[string]RepoContent{}
		for _, e := range entries {
			byName[e.Name] = e
		}
		assert.Equal(t, "file", byName["main.go"].Type)
		assert.Equal(t, "file", byName["handler.go"].Type)
		assert.Equal(t, "dir", byName["internal"].Type)
		assert.Equal(t, "src/internal", byName["internal"].Path)
	})

	t.Run("repo-host 404 returns content not found", func(t *testing.T) {
		rh := &mockRepoHostClient{
			listBookmarksFn: func(ctx context.Context, owner, repo, cursor string, limit int) ([]repohost.Bookmark, string, error) {
				return []repohost.Bookmark{
					{Name: "main", TargetChangeID: "change-gone"},
				}, "", nil
			},
			listFilesAtChangeFn: func(ctx context.Context, owner, repo, changeID, prefix string) ([]repohost.ChangeFile, error) {
				return nil, &repohost.StatusError{StatusCode: 404, Message: "not found"}
			},
		}
		svc := NewRepoService(q, rh, "s1")

		_, err := svc.ListRepoContents(context.Background(), nil, "alice", "demo", "", "")
		require.Error(t, err)
		assert.Equal(t, http.StatusNotFound, apiStatus(t, err))
	})
}

func TestRepoService_ListRepoContentsPaged(t *testing.T) {
	repository := testRepo(func(r *db.Repository) { r.IsPublic = true; r.DefaultBookmark = "main" })
	q := &mockRepoQuerier{getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
		return repository, nil
	}}
	entries := make([]repohost.TreeEntry, 10001)
	for i := range entries {
		entries[i] = repohost.TreeEntry{Path: fmt.Sprintf("file-%05d", i), Kind: "file"}
	}
	rh := &pagedRepoHostClient{mockRepoHostClient: &mockRepoHostClient{listBookmarksFn: func(context.Context, string, string, string, int) ([]repohost.Bookmark, string, error) {
		return []repohost.Bookmark{{Name: "main", TargetChangeID: "change", TargetCommitID: "0123456789012345678901234567890123456789"}}, "", nil
	}}, pages: map[string][]repohost.TreeEntry{"": entries, "apps": {{Path: "apps/app", Kind: "dir"}, {Path: "apps/cli", Kind: "dir"}}}}
	svc := NewRepoService(q, rh, "s1")
	root, err := svc.ListRepoContents(context.Background(), nil, "alice", "demo", "", "")
	require.NoError(t, err)
	require.Len(t, root, 10001)
	assert.Equal(t, "file-10000", root[len(root)-1].Name)
	dir, err := svc.ListRepoContents(context.Background(), nil, "alice", "demo", "", "apps")
	require.NoError(t, err)
	assert.Equal(t, []RepoContent{{Name: "app", Path: "apps/app", Type: "dir"}, {Name: "cli", Path: "apps/cli", Type: "dir"}}, dir)
	first, cursor, commit, err := svc.ListRepoContentsPage(context.Background(), nil, "alice", "demo", "", "", "", 1000)
	require.NoError(t, err)
	assert.Equal(t, "0123456789012345678901234567890123456789", commit)
	require.Len(t, first, 1000)
	assert.Equal(t, "file-00999", cursor)
	last, next, _, err := svc.ListRepoContentsPage(context.Background(), nil, "alice", "demo", "", "", "file-09999", 1000)
	require.NoError(t, err)
	assert.Equal(t, []RepoContent{{Name: "file-10000", Path: "file-10000", Type: "file"}}, last)
	assert.Empty(t, next)
	rh.pages[""] = entries[:1000]
	exact, terminal, _, err := svc.ListRepoContentsPage(context.Background(), nil, "alice", "demo", "", "", "", 1000)
	require.NoError(t, err)
	require.Len(t, exact, 1000)
	assert.Empty(t, terminal, "exactly 1000 children are a terminal page")
	_, _, _, err = svc.ListRepoContentsPage(context.Background(), nil, "alice", "demo", "", "apps", "app/file", 1000)
	require.Error(t, err, "cursor must name an immediate child of the requested directory")
	_, _, _, err = svc.ListRepoContentsPage(context.Background(), nil, "alice", "demo", "", "", "", 1001)
	require.Error(t, err)
}

func TestRepoService_ListRepoContentsPageRevisionRefusals(t *testing.T) {
	repository := testRepo(func(r *db.Repository) { r.IsPublic = true; r.DefaultBookmark = "main" })
	q := &mockRepoQuerier{getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
		return repository, nil
	}}
	for _, status := range []int{http.StatusNotFound, http.StatusBadRequest} {
		rh := &pagedRepoHostClient{mockRepoHostClient: &mockRepoHostClient{}, changeError: &repohost.StatusError{StatusCode: status, Message: "invalid revision"}}
		_, _, _, err := NewRepoService(q, rh, "s1").ListRepoContentsPage(context.Background(), nil, "alice", "demo", "missing", "", "", 1000)
		require.Error(t, err)
		assert.Equal(t, status, apiStatus(t, err))
	}
}

func TestRepoService_ListRepoContentsPagePinsMovingBookmark(t *testing.T) {
	repository := testRepo(func(r *db.Repository) { r.IsPublic = true; r.DefaultBookmark = "main" })
	q := &mockRepoQuerier{getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
		return repository, nil
	}}
	firstCommit, secondCommit := strings.Repeat("a", 40), strings.Repeat("b", 40)
	bookmarkReads := 0
	rh := &pagedRepoHostClient{mockRepoHostClient: &mockRepoHostClient{listBookmarksFn: func(context.Context, string, string, string, int) ([]repohost.Bookmark, string, error) {
		bookmarkReads++
		commit := firstCommit
		if bookmarkReads > 1 {
			commit = secondCommit
		}
		return []repohost.Bookmark{{Name: "main", TargetChangeID: "moving", TargetCommitID: commit}}, "", nil
	}}, pages: map[string][]repohost.TreeEntry{"": {{Path: "a", Kind: "file"}, {Path: "b", Kind: "file"}}}}
	svc := NewRepoService(q, rh, "s1")
	_, cursor, commit, err := svc.ListRepoContentsPage(context.Background(), nil, "alice", "demo", "", "", "", 1)
	require.NoError(t, err)
	assert.Equal(t, "a", cursor)
	assert.Equal(t, firstCommit, commit)
	_, _, _, err = svc.ListRepoContentsPage(context.Background(), nil, "alice", "demo", commit, "", cursor, 1)
	require.NoError(t, err)
	assert.Equal(t, 1, bookmarkReads)
	assert.Equal(t, []string{firstCommit, firstCommit}, rh.seenChanges)
}

func TestRepoService_ListRepoContentsPageResolvesChangeToCommit(t *testing.T) {
	repository := testRepo(func(r *db.Repository) { r.IsPublic = true; r.DefaultBookmark = "main" })
	q := &mockRepoQuerier{getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
		return repository, nil
	}}
	commit := strings.Repeat("c", 40)
	rh := &pagedRepoHostClient{mockRepoHostClient: &mockRepoHostClient{listBookmarksFn: func(context.Context, string, string, string, int) ([]repohost.Bookmark, string, error) {
		return []repohost.Bookmark{{Name: "main", TargetChangeID: "moving"}}, "", nil
	}}, changeCommit: commit, pages: map[string][]repohost.TreeEntry{"": {{Path: "README.md", Kind: "file"}}}}
	_, _, pinned, err := NewRepoService(q, rh, "s1").ListRepoContentsPage(context.Background(), nil, "alice", "demo", "", "", "", 1000)
	require.NoError(t, err)
	assert.Equal(t, commit, pinned)
	assert.Equal(t, []string{commit}, rh.seenChanges)
}

func TestRepoService_GetRepoContents_ResolvesBookmark(t *testing.T) {
	t.Parallel()

	repository := testRepo(func(r *db.Repository) {
		r.IsPublic = true
		r.DefaultBookmark = "main"
	})
	q := &mockRepoQuerier{
		getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return repository, nil
		},
	}

	t.Run("resolves explicit ref bookmark for file content", func(t *testing.T) {
		rh := &mockRepoHostClient{
			listBookmarksFn: func(ctx context.Context, owner, repo, cursor string, limit int) ([]repohost.Bookmark, string, error) {
				return []repohost.Bookmark{
					{Name: "main", TargetChangeID: "change-main"},
					{Name: "feature", TargetChangeID: "change-feat"},
				}, "", nil
			},
			getFileAtChangeFn: func(ctx context.Context, owner, repo, changeID, path string) (repohost.FileContent, error) {
				assert.Equal(t, "change-feat", changeID, "should resolve feature bookmark to its change ID")
				return repohost.FileContent{Path: "src/app.ts", Content: "export {}"}, nil
			},
		}
		svc := NewRepoService(q, rh, "s1")

		content, err := svc.GetRepoContents(context.Background(), nil, "alice", "demo", "feature", "src/app.ts")
		require.NoError(t, err)
		assert.Equal(t, "app.ts", content.Name)
		assert.Equal(t, "export {}", content.Content)
	})

	t.Run("repo-host 404 for file returns not found", func(t *testing.T) {
		rh := &mockRepoHostClient{
			listBookmarksFn: func(ctx context.Context, owner, repo, cursor string, limit int) ([]repohost.Bookmark, string, error) {
				return []repohost.Bookmark{
					{Name: "main", TargetChangeID: "change-main"},
				}, "", nil
			},
			getFileAtChangeFn: func(ctx context.Context, owner, repo, changeID, path string) (repohost.FileContent, error) {
				return repohost.FileContent{}, &repohost.StatusError{StatusCode: 404, Message: "not found"}
			},
		}
		svc := NewRepoService(q, rh, "s1")

		_, err := svc.GetRepoContents(context.Background(), nil, "alice", "demo", "", "nonexistent.txt")
		require.Error(t, err)
		assert.Equal(t, http.StatusNotFound, apiStatus(t, err))
	})

	t.Run("bookmark resolve failure returns error", func(t *testing.T) {
		rh := &mockRepoHostClient{
			listBookmarksFn: func(ctx context.Context, owner, repo, cursor string, limit int) ([]repohost.Bookmark, string, error) {
				return nil, "", fmt.Errorf("connection refused")
			},
		}
		svc := NewRepoService(q, rh, "s1")

		_, err := svc.GetRepoContents(context.Background(), nil, "alice", "demo", "", "README.md")
		require.Error(t, err)
		assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))
	})
}

func TestRepoService_DeleteRepo_PassesContextToRepoHost(t *testing.T) {
	t.Parallel()

	type ctxKey string
	ctx := context.WithValue(context.Background(), ctxKey("trace_id"), "trace-repo-delete")
	repository := testRepo(func(r *db.Repository) {
		r.UserID = pgtype.Int8{Int64: 1, Valid: true}
		r.Name = "repo"
	})

	q := &mockRepoQuerier{
		getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return repository, nil
		},
		deleteRepoFn: func(ctx context.Context, id int64) error { return nil },
	}
	rh := &mockRepoHostClient{
		deleteRepoFn: func(gotCtx context.Context, owner, repo string) error {
			assert.Equal(t, "trace-repo-delete", gotCtx.Value(ctxKey("trace_id")))
			return nil
		},
	}
	svc := NewRepoService(q, rh, "smithers-repo-host-0")

	err := svc.DeleteRepo(ctx, &db.User{ID: 1, Username: "alice"}, "owner", "repo")
	require.NoError(t, err)
}

// stubBillingPolicy is a test double for services.BillingPolicy that records
// AuthorizePrivateRepo calls and delegates the decision to an injectable func.
type stubBillingPolicy struct {
	authorizePrivateRepoFn func(ctx context.Context, ownerType string, ownerID int64) error
	privateRepoCalls       int
	lastOwnerType          string
	lastOwnerID            int64
}

func (s *stubBillingPolicy) AuthorizePrivateRepo(ctx context.Context, ownerType string, ownerID int64) error {
	s.privateRepoCalls++
	s.lastOwnerType = ownerType
	s.lastOwnerID = ownerID
	if s.authorizePrivateRepoFn != nil {
		return s.authorizePrivateRepoFn(ctx, ownerType, ownerID)
	}
	return nil
}

func (s *stubBillingPolicy) AuthorizeWorkflowDispatchCommitted(ctx context.Context, _ int64, commit func(context.Context, pgx.Tx) error) error {
	return commit(ctx, nil)
}
func (s *stubBillingPolicy) AuthorizeAgentRunCommitted(ctx context.Context, _ int64, commit func(context.Context, db.DBTX) error) error {
	return commit(ctx, nil)
}
func (s *stubBillingPolicy) AuthorizeStorageIncrease(context.Context, int64, int64) error { return nil }
func (s *stubBillingPolicy) AuthorizePairing(context.Context, int64) error                { return nil }

func TestRepoService_UpdateRepo_PrivateFlipEnforcesBilling(t *testing.T) {
	tests := []struct {
		name             string
		repo             db.Repository
		req              UpdateRepoRequest
		nilBilling       bool
		denyPrivate      bool
		wantErrCode      int
		wantUpdateCalled bool
		wantPrivateCalls int
		wantOwnerType    string
		wantOwnerID      int64
	}{
		{
			name: "public to private denied blocks update",
			repo: testRepo(func(r *db.Repository) {
				r.IsPublic = true
				r.UserID = pgtype.Int8{Int64: 1, Valid: true}
				r.OrgID = pgtype.Int8{}
			}),
			req:              UpdateRepoRequest{Private: boolPtr(true)},
			denyPrivate:      true,
			wantErrCode:      403,
			wantUpdateCalled: false,
			wantPrivateCalls: 1,
		},
		{
			name: "public to private allowed for user owner",
			repo: testRepo(func(r *db.Repository) {
				r.IsPublic = true
				r.UserID = pgtype.Int8{Int64: 1, Valid: true}
				r.OrgID = pgtype.Int8{}
			}),
			req:              UpdateRepoRequest{Private: boolPtr(true)},
			wantUpdateCalled: true,
			wantPrivateCalls: 1,
			wantOwnerType:    BillingOwnerTypeUser,
			wantOwnerID:      1,
		},
		{
			name: "public to private allowed for org owner",
			repo: testRepo(func(r *db.Repository) {
				r.IsPublic = true
				r.UserID = pgtype.Int8{}
				r.OrgID = pgtype.Int8{Int64: 9, Valid: true}
			}),
			req:              UpdateRepoRequest{Private: boolPtr(true)},
			wantUpdateCalled: true,
			wantPrivateCalls: 1,
			wantOwnerType:    BillingOwnerTypeOrg,
			wantOwnerID:      9,
		},
		{
			name: "already private no billing check",
			repo: testRepo(func(r *db.Repository) {
				r.IsPublic = false
				r.UserID = pgtype.Int8{Int64: 1, Valid: true}
				r.OrgID = pgtype.Int8{}
			}),
			req:              UpdateRepoRequest{Private: boolPtr(true)},
			wantUpdateCalled: true,
			wantPrivateCalls: 0,
		},
		{
			name: "private to public no billing check",
			repo: testRepo(func(r *db.Repository) {
				r.IsPublic = false
				r.UserID = pgtype.Int8{Int64: 1, Valid: true}
				r.OrgID = pgtype.Int8{}
			}),
			req:              UpdateRepoRequest{Private: boolPtr(false)},
			wantUpdateCalled: true,
			wantPrivateCalls: 0,
		},
		{
			name: "nil billing policy passthrough",
			repo: testRepo(func(r *db.Repository) {
				r.IsPublic = true
				r.UserID = pgtype.Int8{Int64: 1, Valid: true}
				r.OrgID = pgtype.Int8{}
			}),
			req:              UpdateRepoRequest{Private: boolPtr(true)},
			nilBilling:       true,
			wantUpdateCalled: true,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			q := &mockRepoQuerier{
				getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
					return tc.repo, nil
				},
				isOrgOwnerForRepoUserFn: func(ctx context.Context, arg db.IsOrgOwnerForRepoUserParams) (bool, error) {
					return true, nil
				},
				updateRepoFn: func(ctx context.Context, arg db.UpdateRepoParams) (db.Repository, error) {
					return tc.repo, nil
				},
			}

			opts := []RepoServiceOption{}
			stub := &stubBillingPolicy{}
			if tc.denyPrivate {
				stub.authorizePrivateRepoFn = func(ctx context.Context, ownerType string, ownerID int64) error {
					return errors.Forbidden("private repositories are not included in your plan")
				}
			}
			if !tc.nilBilling {
				opts = append(opts, WithRepoBillingPolicy(stub))
			}
			svc := NewRepoService(q, &mockRepoHostClient{}, "smithers-repo-host-0", opts...)

			_, err := svc.UpdateRepo(context.Background(), &db.User{ID: 1, Username: "actor"}, "owner", "repo", tc.req)

			if tc.wantErrCode != 0 {
				assert.Equal(t, tc.wantErrCode, apiStatus(t, err))
			} else {
				require.NoError(t, err)
			}
			assert.Equal(t, tc.wantUpdateCalled, q.updateCalled)
			if !tc.nilBilling {
				assert.Equal(t, tc.wantPrivateCalls, stub.privateRepoCalls)
				if tc.wantOwnerType != "" {
					assert.Equal(t, tc.wantOwnerType, stub.lastOwnerType)
					assert.Equal(t, tc.wantOwnerID, stub.lastOwnerID)
				}
			}
		})
	}
}

func (m *mockRepoHostClient) ListNotesRefs(ctx context.Context, owner, repo string) ([]repohost.NotesRef, error) {
	if m.listNotesRefsFn != nil {
		return m.listNotesRefsFn(ctx, owner, repo)
	}
	return []repohost.NotesRef{}, nil
}

func (*stubBillingPolicy) AuthorizeSandboxStart(context.Context, int64) error { return nil }
func (*stubBillingPolicy) SandboxEntitlement(context.Context, int64) (SandboxEntitlement, error) {
	return SandboxEntitlement{}, nil
}

func (m *mockRepoHostClient) GetBookmark(ctx context.Context, owner, repo, name string) (repohost.Bookmark, error) {
	if m.getBookmarkFn != nil {
		return m.getBookmarkFn(ctx, owner, repo, name)
	}
	items, _, err := m.ListBookmarks(ctx, owner, repo, "", 100)
	if err != nil {
		return repohost.Bookmark{}, err
	}
	for _, bookmark := range items {
		if bookmark.Name == name {
			return bookmark, nil
		}
	}
	return repohost.Bookmark{}, &repohost.StatusError{StatusCode: 404, Code: "bookmark_not_found"}
}
