package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type repoMissingEndpointMockService struct {
	getRepoTopicsFn    func(ctx context.Context, viewer *db.User, owner, repo string) ([]string, error)
	replaceTopicsFn    func(ctx context.Context, actor *db.User, owner, repo string, topics []string) ([]string, error)
	listStargazersFn   func(ctx context.Context, viewer *db.User, owner, repo string, page, perPage int) ([]db.User, int64, error)
	checkRepoStarredFn func(ctx context.Context, actor *db.User, owner, repo string) (bool, error)
	starRepoFn         func(ctx context.Context, actor *db.User, owner, repo string) error
	unstarRepoFn       func(ctx context.Context, actor *db.User, owner, repo string) error
	getRepoContentsFn  func(ctx context.Context, viewer *db.User, owner, repo, ref, path string) (services.RepoContent, error)
	listGitRefsFn      func(ctx context.Context, viewer *db.User, owner, repo string) ([]services.GitRef, error)
}

func (m repoMissingEndpointMockService) CreateRepo(ctx context.Context, user *db.User, name, description string, isPublic bool, defaultBookmark string, autoInit bool) (db.Repository, error) {
	return db.Repository{}, nil
}
func (m repoMissingEndpointMockService) CreateOrgRepo(ctx context.Context, actor *db.User, orgName, name, description string, isPublic bool, defaultBookmark string, autoInit bool) (db.Repository, error) {
	return db.Repository{}, nil
}
func (m repoMissingEndpointMockService) GetRepo(ctx context.Context, viewer *db.User, owner, repo string) (db.Repository, error) {
	return db.Repository{}, nil
}
func (m repoMissingEndpointMockService) UpdateRepo(ctx context.Context, actor *db.User, owner, repo string, req services.UpdateRepoRequest) (db.Repository, error) {
	return db.Repository{}, nil
}
func (m repoMissingEndpointMockService) DeleteRepo(ctx context.Context, actor *db.User, owner, repo string) error {
	return nil
}
func (m repoMissingEndpointMockService) GetRepoTopics(ctx context.Context, viewer *db.User, owner, repo string) ([]string, error) {
	if m.getRepoTopicsFn != nil {
		return m.getRepoTopicsFn(ctx, viewer, owner, repo)
	}
	return nil, nil
}
func (m repoMissingEndpointMockService) ReplaceRepoTopics(ctx context.Context, actor *db.User, owner, repo string, topics []string) ([]string, error) {
	if m.replaceTopicsFn != nil {
		return m.replaceTopicsFn(ctx, actor, owner, repo, topics)
	}
	return nil, nil
}
func (m repoMissingEndpointMockService) ListRepoStargazers(ctx context.Context, viewer *db.User, owner, repo string, page, perPage int) ([]db.User, int64, error) {
	if m.listStargazersFn != nil {
		return m.listStargazersFn(ctx, viewer, owner, repo, page, perPage)
	}
	return nil, 0, nil
}
func (m repoMissingEndpointMockService) CheckRepoStarred(ctx context.Context, actor *db.User, owner, repo string) (bool, error) {
	if m.checkRepoStarredFn != nil {
		return m.checkRepoStarredFn(ctx, actor, owner, repo)
	}
	return false, nil
}
func (m repoMissingEndpointMockService) StarRepo(ctx context.Context, actor *db.User, owner, repo string) error {
	if m.starRepoFn != nil {
		return m.starRepoFn(ctx, actor, owner, repo)
	}
	return nil
}
func (m repoMissingEndpointMockService) UnstarRepo(ctx context.Context, actor *db.User, owner, repo string) error {
	if m.unstarRepoFn != nil {
		return m.unstarRepoFn(ctx, actor, owner, repo)
	}
	return nil
}
func (m repoMissingEndpointMockService) GetRepoContents(ctx context.Context, viewer *db.User, owner, repo, ref, path string) (services.RepoContent, error) {
	if m.getRepoContentsFn != nil {
		return m.getRepoContentsFn(ctx, viewer, owner, repo, ref, path)
	}
	return services.RepoContent{}, nil
}
func (m repoMissingEndpointMockService) ListRepoContents(ctx context.Context, viewer *db.User, owner, repo, ref, dirPath string) ([]services.RepoContent, error) {
	return nil, nil
}
func (m repoMissingEndpointMockService) ListGitRefs(ctx context.Context, viewer *db.User, owner, repo string) ([]services.GitRef, error) {
	if m.listGitRefsFn != nil {
		return m.listGitRefsFn(ctx, viewer, owner, repo)
	}
	return nil, nil
}
func (m repoMissingEndpointMockService) ArchiveRepo(ctx context.Context, actor *db.User, owner, repo string) (db.Repository, error) {
	return db.Repository{}, nil
}
func (m repoMissingEndpointMockService) UnarchiveRepo(ctx context.Context, actor *db.User, owner, repo string) (db.Repository, error) {
	return db.Repository{}, nil
}

func (m repoMissingEndpointMockService) GetRepoView(ctx context.Context, viewer *db.User, owner, repo string) (services.RepoView, error) {
	return services.RepoView{}, nil
}

func withRepoRouteParams(req *http.Request, params map[string]string) *http.Request {
	routeCtx := chi.NewRouteContext()
	for key, value := range params {
		routeCtx.URLParams.Add(key, value)
	}
	return req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, routeCtx))
}

func withRepoAuth(req *http.Request, userID int64, username string) *http.Request {
	return req.WithContext(middleware.ContextWithAuthInfo(req.Context(), &middleware.AuthInfo{
		User: &db.User{ID: userID, Username: username},
	}))
}

func TestRepoHandlerMissingEndpoints_Topics(t *testing.T) {
	t.Parallel()

	h := RepoHandler{
		Service: repoMissingEndpointMockService{
			getRepoTopicsFn: func(ctx context.Context, viewer *db.User, owner, repo string) ([]string, error) {
				require.Nil(t, viewer)
				assert.Equal(t, "alice", owner)
				assert.Equal(t, "demo", repo)
				return []string{"go", "jj"}, nil
			},
			replaceTopicsFn: func(ctx context.Context, actor *db.User, owner, repo string, topics []string) ([]string, error) {
				assert.Equal(t, int64(1), actor.ID)
				assert.Equal(t, "alice", owner)
				assert.Equal(t, "demo", repo)
				assert.Equal(t, []string{"go", "jj"}, topics)
				return topics, nil
			},
		},
	}

	getReq := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/topics", nil)
	getReq = withRepoRouteParams(getReq, map[string]string{"owner": "alice", "repo": "demo"})
	getRec := httptest.NewRecorder()
	h.GetRepoTopics(getRec, getReq)
	require.Equal(t, http.StatusOK, getRec.Code)

	putReq := httptest.NewRequest(http.MethodPut, "/api/repos/alice/demo/topics", strings.NewReader(`{"topics":["go","jj"]}`))
	putReq = withRepoRouteParams(putReq, map[string]string{"owner": "alice", "repo": "demo"})
	putReq = withRepoAuth(putReq, 1, "alice")
	putRec := httptest.NewRecorder()
	h.ReplaceRepoTopics(putRec, putReq)
	require.Equal(t, http.StatusOK, putRec.Code)
}

func TestRepoHandlerMissingEndpoints_PatchArchive(t *testing.T) {
	t.Parallel()

	t.Run("archived=true calls ArchiveRepo", func(t *testing.T) {
		h := RepoHandler{
			Service: repoMissingEndpointMockService{},
		}
		req := httptest.NewRequest(http.MethodPatch, "/api/repos/alice/demo", strings.NewReader(`{"archived":true}`))
		req = withRepoRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
		req = withRepoAuth(req, 1, "alice")
		rec := httptest.NewRecorder()
		h.PatchRepo(rec, req)
		require.Equal(t, http.StatusOK, rec.Code)
	})

	t.Run("archived=false calls UnarchiveRepo", func(t *testing.T) {
		h := RepoHandler{
			Service: repoMissingEndpointMockService{},
		}
		req := httptest.NewRequest(http.MethodPatch, "/api/repos/alice/demo", strings.NewReader(`{"archived":false}`))
		req = withRepoRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
		req = withRepoAuth(req, 1, "alice")
		rec := httptest.NewRecorder()
		h.PatchRepo(rec, req)
		require.Equal(t, http.StatusOK, rec.Code)
	})

	t.Run("no archived field falls through to UpdateRepo", func(t *testing.T) {
		h := RepoHandler{
			Service: repoMissingEndpointMockService{},
		}
		req := httptest.NewRequest(http.MethodPatch, "/api/repos/alice/demo", strings.NewReader(`{"description":"updated"}`))
		req = withRepoRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
		req = withRepoAuth(req, 1, "alice")
		rec := httptest.NewRecorder()
		h.PatchRepo(rec, req)
		require.Equal(t, http.StatusOK, rec.Code)
	})
}

func TestPatchRepoRejectsMixedArchiveSettings(t *testing.T) {
	t.Parallel()
	fields := []struct {
		name string
		body string
	}{
		{"private and description", `"private":true,"description":"mixed"`},
		{"name", `"name":"renamed"`},
		{"description", `"description":"mixed"`},
		{"private false", `"private":false`},
		{"default bookmark", `"default_bookmark":"main"`},
		{"topics", `"topics":[]`},
		{"landing queue mode", `"landing_queue_mode":"manual"`},
		{"required checks", `"landing_queue_required_checks":[]`},
	}
	for _, archived := range []string{"false", "true"} {
		for _, field := range fields {
			t.Run(archived+"/"+field.name, func(t *testing.T) {
				h := RepoHandler{Service: repoMissingEndpointMockService{}}
				req := httptest.NewRequest(http.MethodPatch, "/api/repos/alice/demo", strings.NewReader(`{"archived":`+archived+`,`+field.body+`}`))
				req = withRepoRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
				req = withRepoAuth(req, 1, "alice")
				rec := httptest.NewRecorder()
				h.PatchRepo(rec, req)
				require.Equal(t, http.StatusUnprocessableEntity, rec.Code, rec.Body.String())
			})
		}
	}
}

func TestRepoHandlerMissingEndpoints_ContentsAndGitRefs(t *testing.T) {
	t.Parallel()

	h := RepoHandler{
		Service: repoMissingEndpointMockService{
			getRepoContentsFn: func(ctx context.Context, viewer *db.User, owner, repo, ref, path string) (services.RepoContent, error) {
				assert.Equal(t, "trunk", ref)
				assert.Equal(t, "README.md", path)
				return services.RepoContent{Name: "README.md", Path: "README.md", Type: "file", Encoding: "utf-8", Content: "hello", Size: 5}, nil
			},
			listGitRefsFn: func(ctx context.Context, viewer *db.User, owner, repo string) ([]services.GitRef, error) {
				return []services.GitRef{{
					Ref: "refs/heads/main",
					Object: services.GitRefObject{
						SHA:  "abc123",
						Type: "commit",
					},
				}}, nil
			},
		},
	}

	contentsReq := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/contents/README.md?ref=trunk", nil)
	contentsReq = withRepoRouteParams(contentsReq, map[string]string{"owner": "alice", "repo": "demo", "*": "README.md"})
	contentsRec := httptest.NewRecorder()
	h.GetRepoContents(contentsRec, contentsReq)
	require.Equal(t, http.StatusOK, contentsRec.Code)
	var contentBody services.RepoContent
	require.NoError(t, json.Unmarshal(contentsRec.Body.Bytes(), &contentBody))
	assert.Equal(t, "README.md", contentBody.Path)

	refsReq := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/git/refs", nil)
	refsReq = withRepoRouteParams(refsReq, map[string]string{"owner": "alice", "repo": "demo"})
	refsRec := httptest.NewRecorder()
	h.ListGitRefs(refsRec, refsReq)
	require.Equal(t, http.StatusOK, refsRec.Code)

}
