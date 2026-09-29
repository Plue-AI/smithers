package routes

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	apierrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type reposHAuditQueries struct {
	calls []db.InsertAuditLogParams
}

func (q *reposHAuditQueries) InsertAuditLog(_ context.Context, arg db.InsertAuditLogParams) error {
	q.calls = append(q.calls, arg)
	return nil
}

func reposHStatus(t *testing.T, h *RepoHandler, call func(http.ResponseWriter, *http.Request), req *http.Request, want int) {
	t.Helper()
	rec := httptest.NewRecorder()
	call(rec, req)
	require.Equal(t, want, rec.Code, rec.Body.String())
}

func reposHReq(method, target, body string, params map[string]string, auth bool) *http.Request {
	req := httptest.NewRequest(method, target, strings.NewReader(body))
	req = withRouteParams(req, params)
	if auth {
		req = withAuth(req, 9, "alice")
	}
	return req
}

func TestRepos_H_AuditBranches(t *testing.T) {
	audit := &reposHAuditQueries{}
	h := &RepoHandler{
		AuditService: services.NewAuditService(audit),
		SSHHost:      "git.example.test",
		Service: reposCovService{
			createRepoFn: func(context.Context, *db.User, string, string, bool, string, bool) (db.Repository, error) {
				return routeRepo(func(r *db.Repository) { r.ID = 101 }), nil
			},
			deleteRepoFn: func(context.Context, *db.User, string, string) error {
				return nil
			},
			archiveFn: func(context.Context, *db.User, string, string) (db.Repository, error) {
				return routeRepo(func(r *db.Repository) {
					r.ID = 102
					r.IsArchived = true
				}), nil
			},
			unarchiveFn: func(context.Context, *db.User, string, string) (db.Repository, error) {
				return routeRepo(func(r *db.Repository) { r.ID = 103 }), nil
			},
			transferFn: func(context.Context, *db.User, string, string, string) (services.RepoTransferResult, error) {
				return services.RepoTransferResult{Repository: routeRepo(func(r *db.Repository) { r.ID = 104 }), Owner: "alice", PendingTransfer: &db.RepositoryTransferRequest{ID: 77}}, nil
			},
			forkFn: func(context.Context, *db.User, string, string, string, string) (db.Repository, error) {
				return routeRepo(func(r *db.Repository) {
					r.ID = 105
					r.Name = "demo-fork"
				}), nil
			},
		},
	}
	params := map[string]string{"owner": "alice", "repo": "demo"}

	reposHStatus(t, h, h.CreateRepo, reposHReq(http.MethodPost, "/api/user/repos", `{"name":"demo"}`, nil, true), http.StatusCreated)
	reposHStatus(t, h, h.PatchRepo, reposHReq(http.MethodPatch, "/api/repos/alice/demo", `{"archived":true}`, params, true), http.StatusOK)
	reposHStatus(t, h, h.PatchRepo, reposHReq(http.MethodPatch, "/api/repos/alice/demo", `{"archived":false}`, params, true), http.StatusOK)
	reposHStatus(t, h, h.DeleteRepo, reposHReq(http.MethodDelete, "/api/repos/alice/demo", ``, params, true), http.StatusNoContent)
	reposHStatus(t, h, h.ArchiveRepo, reposHReq(http.MethodPost, "/api/repos/alice/demo/archive", ``, params, true), http.StatusOK)
	reposHStatus(t, h, h.UnarchiveRepo, reposHReq(http.MethodPost, "/api/repos/alice/demo/unarchive", ``, params, true), http.StatusOK)
	reposHStatus(t, h, h.TransferRepo, reposHReq(http.MethodPost, "/api/repos/alice/demo/transfer", `{"new_owner":"bob"}`, params, true), http.StatusAccepted)
	reposHStatus(t, h, h.ForkRepo, reposHReq(http.MethodPost, "/api/repos/alice/demo/forks", `{"name":"demo-fork"}`, params, true), http.StatusAccepted)

	require.Len(t, audit.calls, 8)
	assert.Equal(t, "repo.create", audit.calls[0].EventType)
	assert.Equal(t, "repo.transfer_requested", audit.calls[6].EventType)
	assert.Equal(t, "transfer_requested", audit.calls[6].Action)
	assert.Equal(t, "repo.fork", audit.calls[7].EventType)
}

func TestRepos_H_ImmediateOrgTransferKeepsCompletionAudit(t *testing.T) {
	audit := &reposHAuditQueries{}
	h := &RepoHandler{
		AuditService: services.NewAuditService(audit),
		Service: reposCovService{transferFn: func(context.Context, *db.User, string, string, string) (services.RepoTransferResult, error) {
			return services.RepoTransferResult{Repository: routeRepo(nil), Owner: "acme"}, nil
		}},
	}
	reposHStatus(t, h, h.TransferRepo, reposHReq(http.MethodPost, "/api/repos/alice/demo/transfer", `{"new_owner":"acme"}`, map[string]string{"owner": "alice", "repo": "demo"}, true), http.StatusAccepted)
	require.Len(t, audit.calls, 1)
	assert.Equal(t, "repo.transfer", audit.calls[0].EventType)
	assert.Equal(t, "transfer", audit.calls[0].Action)
}

func TestRepos_H_ErrorBranches(t *testing.T) {
	svcErr := apierrors.Forbidden("repo denied")
	h := &RepoHandler{Service: reposCovService{
		getTopicsFn: func(context.Context, *db.User, string, string) ([]string, error) {
			return nil, svcErr
		},
		replaceTopicsFn: func(context.Context, *db.User, string, string, []string) ([]string, error) {
			return nil, svcErr
		},
		stargazersFn: func(context.Context, *db.User, string, string, int, int) ([]db.User, int64, error) {
			return nil, 0, svcErr
		},
		starFn: func(context.Context, *db.User, string, string) error {
			return svcErr
		},
		unstarFn: func(context.Context, *db.User, string, string) error {
			return svcErr
		},
		checkStarredFn: func(context.Context, *db.User, string, string) (bool, error) {
			return false, svcErr
		},
		listContentsFn: func(context.Context, *db.User, string, string, string, string) ([]services.RepoContent, error) {
			return nil, nil
		},
		getContentsFn: func(context.Context, *db.User, string, string, string, string) (services.RepoContent, error) {
			return services.RepoContent{}, apierrors.NotFound("content not found")
		},
		listGitRefsFn: func(context.Context, *db.User, string, string) ([]services.GitRef, error) {
			return nil, svcErr
		},
		archiveFn: func(context.Context, *db.User, string, string) (db.Repository, error) {
			return db.Repository{}, svcErr
		},
		unarchiveFn: func(context.Context, *db.User, string, string) (db.Repository, error) {
			return db.Repository{}, svcErr
		},
		forkFn: func(context.Context, *db.User, string, string, string, string) (db.Repository, error) {
			return db.Repository{}, svcErr
		},
	}}
	params := map[string]string{"owner": "alice", "repo": "demo"}
	noOwner := map[string]string{"repo": "demo"}

	reposHStatus(t, h, h.GetRepoTopics, reposHReq(http.MethodGet, "/topics", ``, noOwner, false), http.StatusBadRequest)
	reposHStatus(t, h, h.GetRepoTopics, reposHReq(http.MethodGet, "/topics", ``, params, false), http.StatusForbidden)
	reposHStatus(t, h, h.ReplaceRepoTopics, reposHReq(http.MethodPut, "/topics", `{"topics":[]}`, params, false), http.StatusUnauthorized)
	reposHStatus(t, h, h.ReplaceRepoTopics, reposHReq(http.MethodPut, "/topics", `{"topics":[]}`, noOwner, true), http.StatusBadRequest)
	reposHStatus(t, h, h.ReplaceRepoTopics, reposHReq(http.MethodPut, "/topics", `{"topics":[]}`, params, true), http.StatusForbidden)

	reposHStatus(t, h, h.GetRepoContents, reposHReq(http.MethodGet, "/contents", ``, noOwner, false), http.StatusBadRequest)
	reposHStatus(t, h, h.GetRepoContents, reposHReq(http.MethodGet, "/contents/missing", ``, map[string]string{"owner": "alice", "repo": "demo", "*": "missing"}, false), http.StatusNotFound)
	reposHStatus(t, h, h.ListGitRefs, reposHReq(http.MethodGet, "/refs", ``, noOwner, false), http.StatusBadRequest)
	reposHStatus(t, h, h.ListGitRefs, reposHReq(http.MethodGet, "/refs", ``, params, false), http.StatusForbidden)

	reposHStatus(t, h, h.PatchRepo, reposHReq(http.MethodPatch, "/repo", `{"archived":true}`, params, true), http.StatusForbidden)
	reposHStatus(t, h, h.PatchRepo, reposHReq(http.MethodPatch, "/repo", `{"archived":false}`, params, true), http.StatusForbidden)
	reposHStatus(t, h, h.ArchiveRepo, reposHReq(http.MethodPost, "/archive", ``, params, false), http.StatusUnauthorized)
	reposHStatus(t, h, h.ArchiveRepo, reposHReq(http.MethodPost, "/archive", ``, noOwner, true), http.StatusBadRequest)
	reposHStatus(t, h, h.ArchiveRepo, reposHReq(http.MethodPost, "/archive", ``, params, true), http.StatusForbidden)
	reposHStatus(t, h, h.UnarchiveRepo, reposHReq(http.MethodPost, "/unarchive", ``, params, false), http.StatusUnauthorized)
	reposHStatus(t, h, h.UnarchiveRepo, reposHReq(http.MethodPost, "/unarchive", ``, noOwner, true), http.StatusBadRequest)
	reposHStatus(t, h, h.UnarchiveRepo, reposHReq(http.MethodPost, "/unarchive", ``, params, true), http.StatusForbidden)

	reposHStatus(t, h, h.TransferRepo, reposHReq(http.MethodPost, "/transfer", `{"new_owner":"bob"}`, noOwner, true), http.StatusBadRequest)
	reposHStatus(t, h, h.ForkRepo, reposHReq(http.MethodPost, "/fork", `{`, params, true), http.StatusBadRequest)
	reposHStatus(t, h, h.ForkRepo, reposHReq(http.MethodPost, "/fork", `{"name":"copy"}`, params, false), http.StatusUnauthorized)
	reposHStatus(t, h, h.ForkRepo, reposHReq(http.MethodPost, "/fork", `{"name":"copy"}`, noOwner, true), http.StatusBadRequest)
	reposHStatus(t, h, h.ForkRepo, reposHReq(http.MethodPost, "/fork", `{"name":"copy"}`, params, true), http.StatusForbidden)
}
