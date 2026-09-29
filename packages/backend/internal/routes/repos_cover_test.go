package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type reposCovService struct {
	createRepoFn    func(context.Context, *db.User, string, string, bool, string, bool) (db.Repository, error)
	createOrgRepoFn func(context.Context, *db.User, string, string, string, bool, string, bool) (db.Repository, error)
	getRepoFn       func(context.Context, *db.User, string, string) (db.Repository, error)
	updateRepoFn    func(context.Context, *db.User, string, string, services.UpdateRepoRequest) (db.Repository, error)
	deleteRepoFn    func(context.Context, *db.User, string, string) error
	getTopicsFn     func(context.Context, *db.User, string, string) ([]string, error)
	replaceTopicsFn func(context.Context, *db.User, string, string, []string) ([]string, error)
	stargazersFn    func(context.Context, *db.User, string, string, int, int) ([]db.User, int64, error)
	checkStarredFn  func(context.Context, *db.User, string, string) (bool, error)
	starFn          func(context.Context, *db.User, string, string) error
	unstarFn        func(context.Context, *db.User, string, string) error
	getContentsFn   func(context.Context, *db.User, string, string, string, string) (services.RepoContent, error)
	listContentsFn  func(context.Context, *db.User, string, string, string, string) ([]services.RepoContent, error)
	listGitRefsFn   func(context.Context, *db.User, string, string) ([]services.GitRef, error)
	archiveFn       func(context.Context, *db.User, string, string) (db.Repository, error)
	unarchiveFn     func(context.Context, *db.User, string, string) (db.Repository, error)
	transferFn      func(context.Context, *db.User, string, string, string) (services.RepoTransferResult, error)
	forkFn          func(context.Context, *db.User, string, string, string, string) (db.Repository, error)
}

func (s reposCovService) CreateRepo(ctx context.Context, user *db.User, name, description string, isPublic bool, defaultBookmark string, autoInit bool) (db.Repository, error) {
	if s.createRepoFn != nil {
		return s.createRepoFn(ctx, user, name, description, isPublic, defaultBookmark, autoInit)
	}
	return db.Repository{}, nil
}

func (s reposCovService) CreateOrgRepo(ctx context.Context, actor *db.User, orgName, name, description string, isPublic bool, defaultBookmark string, autoInit bool) (db.Repository, error) {
	if s.createOrgRepoFn != nil {
		return s.createOrgRepoFn(ctx, actor, orgName, name, description, isPublic, defaultBookmark, autoInit)
	}
	return db.Repository{}, nil
}

func (s reposCovService) GetRepo(ctx context.Context, viewer *db.User, owner, repo string) (db.Repository, error) {
	if s.getRepoFn != nil {
		return s.getRepoFn(ctx, viewer, owner, repo)
	}
	return db.Repository{}, nil
}

func (s reposCovService) UpdateRepo(ctx context.Context, actor *db.User, owner, repo string, req services.UpdateRepoRequest) (db.Repository, error) {
	if s.updateRepoFn != nil {
		return s.updateRepoFn(ctx, actor, owner, repo, req)
	}
	return routeRepo(nil), nil
}

func (s reposCovService) DeleteRepo(ctx context.Context, actor *db.User, owner, repo string) error {
	if s.deleteRepoFn != nil {
		return s.deleteRepoFn(ctx, actor, owner, repo)
	}
	return nil
}

func (s reposCovService) GetRepoTopics(ctx context.Context, viewer *db.User, owner, repo string) ([]string, error) {
	if s.getTopicsFn != nil {
		return s.getTopicsFn(ctx, viewer, owner, repo)
	}
	return nil, nil
}

func (s reposCovService) ReplaceRepoTopics(ctx context.Context, actor *db.User, owner, repo string, topics []string) ([]string, error) {
	if s.replaceTopicsFn != nil {
		return s.replaceTopicsFn(ctx, actor, owner, repo, topics)
	}
	return topics, nil
}

func (s reposCovService) ListRepoStargazers(ctx context.Context, viewer *db.User, owner, repo string, page, perPage int) ([]db.User, int64, error) {
	if s.stargazersFn != nil {
		return s.stargazersFn(ctx, viewer, owner, repo, page, perPage)
	}
	return nil, 0, nil
}

func (s reposCovService) CheckRepoStarred(ctx context.Context, actor *db.User, owner, repo string) (bool, error) {
	if s.checkStarredFn != nil {
		return s.checkStarredFn(ctx, actor, owner, repo)
	}
	return false, nil
}

func (s reposCovService) StarRepo(ctx context.Context, actor *db.User, owner, repo string) error {
	if s.starFn != nil {
		return s.starFn(ctx, actor, owner, repo)
	}
	return nil
}

func (s reposCovService) UnstarRepo(ctx context.Context, actor *db.User, owner, repo string) error {
	if s.unstarFn != nil {
		return s.unstarFn(ctx, actor, owner, repo)
	}
	return nil
}

func (s reposCovService) GetRepoContents(ctx context.Context, viewer *db.User, owner, repo, ref, path string) (services.RepoContent, error) {
	if s.getContentsFn != nil {
		return s.getContentsFn(ctx, viewer, owner, repo, ref, path)
	}
	return services.RepoContent{}, nil
}

func (s reposCovService) ListRepoContents(ctx context.Context, viewer *db.User, owner, repo, ref, dirPath string) ([]services.RepoContent, error) {
	if s.listContentsFn != nil {
		return s.listContentsFn(ctx, viewer, owner, repo, ref, dirPath)
	}
	return nil, nil
}

func (s reposCovService) ListGitRefs(ctx context.Context, viewer *db.User, owner, repo string) ([]services.GitRef, error) {
	if s.listGitRefsFn != nil {
		return s.listGitRefsFn(ctx, viewer, owner, repo)
	}
	return nil, nil
}

func (s reposCovService) ArchiveRepo(ctx context.Context, actor *db.User, owner, repo string) (db.Repository, error) {
	if s.archiveFn != nil {
		return s.archiveFn(ctx, actor, owner, repo)
	}
	return routeRepo(nil), nil
}

func (s reposCovService) UnarchiveRepo(ctx context.Context, actor *db.User, owner, repo string) (db.Repository, error) {
	if s.unarchiveFn != nil {
		return s.unarchiveFn(ctx, actor, owner, repo)
	}
	return routeRepo(nil), nil
}

func (s reposCovService) TransferRepo(ctx context.Context, actor *db.User, owner, repo, newOwner string) (services.RepoTransferResult, error) {
	if s.transferFn != nil {
		return s.transferFn(ctx, actor, owner, repo, newOwner)
	}
	return services.RepoTransferResult{Repository: routeRepo(nil), Owner: owner}, nil
}

func (s reposCovService) ListRepoTransfers(context.Context, *db.User) ([]db.RepositoryTransferRequest, error) {
	return nil, nil
}
func (s reposCovService) AcceptRepoTransfer(context.Context, *db.User, int64) (db.Repository, error) {
	return db.Repository{}, nil
}
func (s reposCovService) DeclineRepoTransfer(context.Context, *db.User, int64) error { return nil }
func (s reposCovService) CancelRepoTransfer(context.Context, *db.User, int64) error  { return nil }

func (s reposCovService) ForkRepo(ctx context.Context, actor *db.User, owner, repo string, nameOverride, descriptionOverride string) (services.ForkOutcome, error) {
	if s.forkFn != nil {
		forked, err := s.forkFn(ctx, actor, owner, repo, nameOverride, descriptionOverride)
		return services.ForkOutcome{Repository: forked, Created: true}, err
	}
	return services.ForkOutcome{Repository: routeRepo(nil), Created: true}, nil
}

func (s reposCovService) GetRepoView(ctx context.Context, viewer *db.User, owner, repo string) (services.RepoView, error) {
	repository, err := s.GetRepo(ctx, viewer, owner, repo)
	if err != nil {
		return services.RepoView{}, err
	}
	return services.RepoView{Repository: repository}, nil
}

func TestRepos_Cov_ArchiveUnarchiveForkAndGitRoutes(t *testing.T) {
	archivedAt := time.Date(2026, 7, 6, 14, 30, 0, 0, time.UTC)
	var archivedCalls, unarchivedCalls int
	h := RepoHandler{Service: reposCovService{
		archiveFn: func(_ context.Context, actor *db.User, owner, repo string) (db.Repository, error) {
			require.Equal(t, int64(9), actor.ID)
			assert.Equal(t, "alice", owner)
			assert.Equal(t, "demo", repo)
			archivedCalls++
			return routeRepo(func(r *db.Repository) {
				r.IsArchived = true
				r.ArchivedAt = pgtype.Timestamptz{Time: archivedAt, Valid: true}
			}), nil
		},
		unarchiveFn: func(_ context.Context, actor *db.User, owner, repo string) (db.Repository, error) {
			require.Equal(t, int64(9), actor.ID)
			unarchivedCalls++
			return routeRepo(func(r *db.Repository) {
				r.IsArchived = false
			}), nil
		},
		forkFn: func(_ context.Context, actor *db.User, owner, repo, nameOverride, descriptionOverride string) (db.Repository, error) {
			require.Equal(t, int64(9), actor.ID)
			assert.Equal(t, "alice", owner)
			assert.Equal(t, "demo", repo)
			assert.Equal(t, "demo-fork", nameOverride)
			assert.Equal(t, "forked", descriptionOverride)
			return routeRepo(func(r *db.Repository) {
				r.ID = 44
				r.Name = "demo-fork"
				r.Description = "forked"
				r.IsFork = true
				r.ForkID = pgtype.Int8{Int64: 9, Valid: true}
			}), nil
		},
		listGitRefsFn: func(_ context.Context, viewer *db.User, owner, repo string) ([]services.GitRef, error) {
			require.Nil(t, viewer)
			return []services.GitRef{{Ref: "refs/heads/main", Object: services.GitRefObject{SHA: "abc123", Type: "commit"}}}, nil
		},
	}}

	patchArchiveReq := httptest.NewRequest(http.MethodPatch, "/api/repos/alice/demo", strings.NewReader(`{"archived":true}`))
	patchArchiveReq = withRouteParams(patchArchiveReq, map[string]string{"owner": "alice", "repo": "demo"})
	patchArchiveReq = withAuth(patchArchiveReq, 9, "alice")
	patchArchiveRec := httptest.NewRecorder()
	h.PatchRepo(patchArchiveRec, patchArchiveReq)
	require.Equal(t, http.StatusOK, patchArchiveRec.Code)
	var repoBody RepoResponse
	require.NoError(t, json.Unmarshal(patchArchiveRec.Body.Bytes(), &repoBody))
	assert.True(t, repoBody.IsArchived)
	require.NotNil(t, repoBody.ArchivedAt)
	assert.Equal(t, archivedAt, *repoBody.ArchivedAt)

	patchUnarchiveReq := httptest.NewRequest(http.MethodPatch, "/api/repos/alice/demo", strings.NewReader(`{"archived":false}`))
	patchUnarchiveReq = withRouteParams(patchUnarchiveReq, map[string]string{"owner": "alice", "repo": "demo"})
	patchUnarchiveReq = withAuth(patchUnarchiveReq, 9, "alice")
	patchUnarchiveRec := httptest.NewRecorder()
	h.PatchRepo(patchUnarchiveRec, patchUnarchiveReq)
	require.Equal(t, http.StatusOK, patchUnarchiveRec.Code)
	assert.Equal(t, 1, archivedCalls)
	assert.Equal(t, 1, unarchivedCalls)

	directArchiveReq := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/archive", nil)
	directArchiveReq = withRouteParams(directArchiveReq, map[string]string{"owner": "alice", "repo": "demo"})
	directArchiveReq = withAuth(directArchiveReq, 9, "alice")
	directArchiveRec := httptest.NewRecorder()
	h.ArchiveRepo(directArchiveRec, directArchiveReq)
	require.Equal(t, http.StatusOK, directArchiveRec.Code)

	directUnarchiveReq := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/unarchive", nil)
	directUnarchiveReq = withRouteParams(directUnarchiveReq, map[string]string{"owner": "alice", "repo": "demo"})
	directUnarchiveReq = withAuth(directUnarchiveReq, 9, "alice")
	directUnarchiveRec := httptest.NewRecorder()
	h.UnarchiveRepo(directUnarchiveRec, directUnarchiveReq)
	require.Equal(t, http.StatusOK, directUnarchiveRec.Code)

	forkReq := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/forks", strings.NewReader(`{"name":"demo-fork","description":"forked"}`))
	forkReq = withRouteParams(forkReq, map[string]string{"owner": "alice", "repo": "demo"})
	forkReq = withAuth(forkReq, 9, "alice")
	forkRec := httptest.NewRecorder()
	h.ForkRepo(forkRec, forkReq)
	require.Equal(t, http.StatusAccepted, forkRec.Code)
	require.NoError(t, json.Unmarshal(forkRec.Body.Bytes(), &repoBody))
	assert.True(t, repoBody.IsFork)
	require.NotNil(t, repoBody.ForkID)
	assert.Equal(t, int64(9), *repoBody.ForkID)
	assert.Equal(t, "alice/demo-fork", repoBody.FullName)

	refsReq := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/git/refs", nil)
	refsReq = withRouteParams(refsReq, map[string]string{"owner": "alice", "repo": "demo"})
	refsRec := httptest.NewRecorder()
	h.ListGitRefs(refsRec, refsReq)
	require.Equal(t, http.StatusOK, refsRec.Code)
	var refs []services.GitRef
	require.NoError(t, json.Unmarshal(refsRec.Body.Bytes(), &refs))
	require.Len(t, refs, 1)
	assert.Equal(t, "refs/heads/main", refs[0].Ref)

}

func TestRepos_Cov_ContentsFallbackAndServiceErrors(t *testing.T) {
	h := RepoHandler{Service: reposCovService{
		listContentsFn: func(_ context.Context, viewer *db.User, owner, repo, ref, dirPath string) ([]services.RepoContent, error) {
			assert.Equal(t, "dev", ref)
			if dirPath == "" {
				return nil, pkgerrors.Forbidden("cannot list contents")
			}
			return nil, pkgerrors.NotFound("not a directory")
		},
		getContentsFn: func(_ context.Context, viewer *db.User, owner, repo, ref, path string) (services.RepoContent, error) {
			assert.Equal(t, "README.md", path)
			return services.RepoContent{Name: "README.md", Path: path, Type: "file", Encoding: "utf-8", Content: "hello", Size: 5}, nil
		},
		starFn: func(_ context.Context, actor *db.User, owner, repo string) error {
			return pkgerrors.Forbidden("cannot star")
		},
	}}

	fileReq := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/contents/README.md?ref=dev", nil)
	fileReq = withRouteParams(fileReq, map[string]string{"owner": "alice", "repo": "demo", "*": "README.md"})
	fileRec := httptest.NewRecorder()
	h.GetRepoContents(fileRec, fileReq)
	require.Equal(t, http.StatusOK, fileRec.Code)
	var content services.RepoContent
	require.NoError(t, json.Unmarshal(fileRec.Body.Bytes(), &content))
	assert.Equal(t, "hello", content.Content)

	rootReq := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/contents?ref=dev", nil)
	rootReq = withRouteParams(rootReq, map[string]string{"owner": "alice", "repo": "demo"})
	rootRec := httptest.NewRecorder()
	h.GetRepoContents(rootRec, rootReq)
	require.Equal(t, http.StatusForbidden, rootRec.Code)

}
