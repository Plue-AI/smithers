package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

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

func (s reposCovService) GetRepoView(ctx context.Context, viewer *db.User, owner, repo string) (services.RepoView, error) {
	repository, err := s.GetRepo(ctx, viewer, owner, repo)
	if err != nil {
		return services.RepoView{}, err
	}
	return services.RepoView{Repository: repository}, nil
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
