package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	apierrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// workspaceFOKService returns a mock whose every method succeeds with
// deterministic payloads. It drives the success (2xx) path of every
// WorkspaceHandler endpoint; combined with the guard/error cases below and the
// sibling _h/_cover suites this keeps workspace.go at 100%.
func workspaceFOKService() *mockWorkspaceRouteService {
	return &mockWorkspaceRouteService{
		createWorkspaceFn: func(context.Context, services.CreateWorkspaceInput) (services.WorkspaceResponse, error) {
			return services.WorkspaceResponse{ID: "ws-1", Status: "running"}, nil
		},
		getWorkspaceFn: func(context.Context, string, int64, int64) (services.WorkspaceResponse, error) {
			return services.WorkspaceResponse{ID: "ws-1"}, nil
		},
		listWorkspacesFn: func(context.Context, int64, int64, int, int) ([]services.WorkspaceResponse, int64, error) {
			return []services.WorkspaceResponse{{ID: "ws-1"}}, 1, nil
		},
		getWorkspaceSSHFn: func(context.Context, string, int64, int64) (services.WorkspaceSSHConnectionInfo, error) {
			return services.WorkspaceSSHConnectionInfo{Host: "h"}, nil
		},
		suspendWorkspaceFn: func(context.Context, string, int64, int64) (services.WorkspaceResponse, error) {
			return services.WorkspaceResponse{ID: "ws-1", Status: "suspended"}, nil
		},
		resumeWorkspaceFn: func(context.Context, string, int64, int64) (services.WorkspaceResponse, error) {
			return services.WorkspaceResponse{ID: "ws-1", Status: "running"}, nil
		},
		deleteWorkspaceFn: func(context.Context, string, int64, int64) error { return nil },
		forkWorkspaceFn: func(context.Context, services.ForkWorkspaceInput) (services.WorkspaceResponse, error) {
			return services.WorkspaceResponse{ID: "ws-2"}, nil
		},
		createWorkspaceSnapshotFn: func(context.Context, services.CreateWorkspaceSnapshotInput) (services.WorkspaceSnapshotResponse, error) {
			return services.WorkspaceSnapshotResponse{ID: "snap-1"}, nil
		},
		getWorkspaceSnapshotFn: func(context.Context, string, int64, int64) (services.WorkspaceSnapshotResponse, error) {
			return services.WorkspaceSnapshotResponse{ID: "snap-1"}, nil
		},
		listWorkspaceSnapshotsFn: func(context.Context, int64, int64, int, int) ([]services.WorkspaceSnapshotResponse, int64, error) {
			return []services.WorkspaceSnapshotResponse{{ID: "snap-1"}}, 1, nil
		},
		deleteWorkspaceSnapshotFn: func(context.Context, string, int64, int64) error { return nil },
		createSessionFn: func(context.Context, services.CreateWorkspaceSessionInput) (services.WorkspaceSessionResponse, error) {
			return services.WorkspaceSessionResponse{ID: "sess-1"}, nil
		},
		getSessionFn: func(context.Context, string, int64, int64) (services.WorkspaceSessionResponse, error) {
			return services.WorkspaceSessionResponse{ID: "sess-1"}, nil
		},
		listSessionsFn: func(context.Context, int64, int64, int, int) ([]services.WorkspaceSessionResponse, int64, error) {
			return []services.WorkspaceSessionResponse{{ID: "sess-1"}}, 1, nil
		},
		getSSHConnectionInfoFn: func(context.Context, string, int64, int64) (services.WorkspaceSSHConnectionInfo, error) {
			return services.WorkspaceSSHConnectionInfo{Host: "h"}, nil
		},
		destroySessionFn: func(context.Context, string, int64, int64) error { return nil },
		listUserWorkspacesFn: func(context.Context, int64, int, int) (services.UserWorkspaceListResult, error) {
			return services.UserWorkspaceListResult{
				Items:      []services.UserWorkspaceRow{{WorkspaceID: "ws-1"}},
				TotalCount: 1,
			}, nil
		},
	}
}

func TestWorkspace_F_SuccessPaths(t *testing.T) {
	validID := map[string]string{"id": "ws-1"}

	tests := []struct {
		name       string
		handler    func(*WorkspaceHandler, http.ResponseWriter, *http.Request)
		method     string
		body       string
		params     map[string]string
		withRepo   bool
		wantStatus int
	}{
		{"create workspace", (*WorkspaceHandler).CreateWorkspace, http.MethodPost, `{"name":"dev","source_bookmark":"main"}`, nil, true, http.StatusCreated},
		{"get workspace", (*WorkspaceHandler).GetWorkspace, http.MethodGet, "", validID, true, http.StatusOK},
		{"list workspaces", (*WorkspaceHandler).ListWorkspaces, http.MethodGet, "", nil, true, http.StatusOK},
		{"workspace ssh", (*WorkspaceHandler).GetWorkspaceSSHConnectionInfo, http.MethodGet, "", validID, true, http.StatusOK},
		{"suspend", (*WorkspaceHandler).SuspendWorkspace, http.MethodPost, "", validID, true, http.StatusOK},
		{"resume", (*WorkspaceHandler).ResumeWorkspace, http.MethodPost, "", validID, true, http.StatusOK},
		{"delete workspace", (*WorkspaceHandler).DeleteWorkspace, http.MethodDelete, "", validID, true, http.StatusNoContent},
		{"fork", (*WorkspaceHandler).ForkWorkspace, http.MethodPost, `{"name":"fork"}`, validID, true, http.StatusCreated},
		{"snapshot", (*WorkspaceHandler).CreateWorkspaceSnapshot, http.MethodPost, `{"name":"snap"}`, validID, true, http.StatusCreated},
		{"snapshot template", (*WorkspaceHandler).CreateWorkspaceSnapshotTemplate, http.MethodPost, `{"workspace_id":"ws-1","name":"snap"}`, nil, true, http.StatusCreated},
		{"get snapshot", (*WorkspaceHandler).GetWorkspaceSnapshot, http.MethodGet, "", validID, true, http.StatusOK},
		{"list snapshots", (*WorkspaceHandler).ListWorkspaceSnapshots, http.MethodGet, "", nil, true, http.StatusOK},
		{"delete snapshot", (*WorkspaceHandler).DeleteWorkspaceSnapshot, http.MethodDelete, "", validID, true, http.StatusNoContent},
		{"create session", (*WorkspaceHandler).CreateSession, http.MethodPost, `{"cols":80,"rows":24}`, nil, true, http.StatusCreated},
		{"get session", (*WorkspaceHandler).GetSession, http.MethodGet, "", validID, true, http.StatusOK},
		{"list sessions", (*WorkspaceHandler).ListSessions, http.MethodGet, "", nil, true, http.StatusOK},
		{"session ssh", (*WorkspaceHandler).GetSSHConnectionInfo, http.MethodGet, "", validID, true, http.StatusOK},
		{"destroy session", (*WorkspaceHandler).DestroySession, http.MethodPost, "", validID, true, http.StatusNoContent},
		{"user workspaces", (*WorkspaceHandler).GetUserWorkspaces, http.MethodGet, "", nil, false, http.StatusOK},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h := &WorkspaceHandler{Service: workspaceFOKService()}
			req := workspaceHRequest(tt.method, "/x", tt.body, tt.params, true, tt.withRepo)
			rec := httptest.NewRecorder()

			tt.handler(h, rec, req)

			require.Equal(t, tt.wantStatus, rec.Code)
		})
	}
}

func TestWorkspace_F_CreateAsyncCreatorPaths(t *testing.T) {
	t.Run("async success returns accepted", func(t *testing.T) {
		svc := &mockAsyncWorkspaceRouteService{
			createWorkspaceAsyncFn: func(context.Context, services.CreateWorkspaceInput) (services.WorkspaceResponse, error) {
				return services.WorkspaceResponse{ID: "ws-async"}, nil
			},
		}
		h := &WorkspaceHandler{Service: svc}
		req := workspaceHRequest(http.MethodPost, "/x", `{"name":"dev","source_bookmark":"main"}`, nil, true, true)
		rec := httptest.NewRecorder()
		h.CreateWorkspace(rec, req)
		require.Equal(t, http.StatusAccepted, rec.Code)
	})

	t.Run("async error propagates", func(t *testing.T) {
		svc := &mockAsyncWorkspaceRouteService{
			createWorkspaceAsyncFn: func(context.Context, services.CreateWorkspaceInput) (services.WorkspaceResponse, error) {
				return services.WorkspaceResponse{}, apierrors.BadRequest("quota exceeded")
			},
		}
		h := &WorkspaceHandler{Service: svc}
		req := workspaceHRequest(http.MethodPost, "/x", `{"name":"dev"}`, nil, true, true)
		rec := httptest.NewRecorder()
		h.CreateWorkspace(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)
	})
}

func TestWorkspace_F_FailureDetailsAndSyncErrorCode(t *testing.T) {
	t.Run("workspace DTO exposes failure details", func(t *testing.T) {
		h := &WorkspaceHandler{Service: &mockWorkspaceRouteService{
			getWorkspaceFn: func(context.Context, string, int64, int64) (services.WorkspaceResponse, error) {
				return services.WorkspaceResponse{
					ID:             "ws-failed",
					Status:         "failed",
					FailureCode:    "secret_delivery_unavailable",
					FailureMessage: "secret delivery service is unavailable",
				}, nil
			},
		}}
		req := workspaceHRequest(http.MethodGet, "/x", "", map[string]string{"id": "ws-failed"}, true, true)
		rec := httptest.NewRecorder()

		h.GetWorkspace(rec, req)

		require.Equal(t, http.StatusOK, rec.Code)
		var body map[string]any
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
		assert.Equal(t, "secret_delivery_unavailable", body["failure_code"])
		assert.Equal(t, "secret delivery service is unavailable", body["failure_message"])
	})

	t.Run("synchronous create preserves sandbox code in error envelope", func(t *testing.T) {
		h := &WorkspaceHandler{Service: &mockWorkspaceRouteService{
			createWorkspaceFn: func(context.Context, services.CreateWorkspaceInput) (services.WorkspaceResponse, error) {
				return services.WorkspaceResponse{}, &apierrors.APIError{
					Status:  http.StatusInternalServerError,
					Code:    "stale_generation",
					Message: "create sandbox: stale generation",
				}
			},
		}}
		req := workspaceHRequest(http.MethodPost, "/x", `{"name":"dev"}`, nil, true, true)
		rec := httptest.NewRecorder()

		h.CreateWorkspace(rec, req)

		require.Equal(t, http.StatusInternalServerError, rec.Code)
		var body apierrors.APIError
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
		assert.Equal(t, apierrors.CodeStaleGeneration, body.Code)
		assert.Equal(t, "internal server error", body.Message)
	})
}

func TestWorkspace_F_AuthAndRepoGuards(t *testing.T) {
	svc := workspaceFOKService()

	t.Run("create no auth", func(t *testing.T) {
		h := &WorkspaceHandler{Service: svc}
		req := workspaceHRequest(http.MethodPost, "/x", `{"name":"dev"}`, nil, false, true)
		rec := httptest.NewRecorder()
		h.CreateWorkspace(rec, req)
		require.Equal(t, http.StatusUnauthorized, rec.Code)
	})

	t.Run("create no repo", func(t *testing.T) {
		h := &WorkspaceHandler{Service: svc}
		req := workspaceHRequest(http.MethodPost, "/x", `{"name":"dev"}`, nil, true, false)
		rec := httptest.NewRecorder()
		h.CreateWorkspace(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("create service error", func(t *testing.T) {
		h := &WorkspaceHandler{Service: &mockWorkspaceRouteService{
			createWorkspaceFn: func(context.Context, services.CreateWorkspaceInput) (services.WorkspaceResponse, error) {
				return services.WorkspaceResponse{}, apierrors.NotFound("nope")
			},
		}}
		req := workspaceHRequest(http.MethodPost, "/x", `{"name":"dev"}`, nil, true, true)
		rec := httptest.NewRecorder()
		h.CreateWorkspace(rec, req)
		require.Equal(t, http.StatusNotFound, rec.Code)
	})

	t.Run("snapshot template missing workspace id", func(t *testing.T) {
		h := &WorkspaceHandler{Service: svc}
		req := workspaceHRequest(http.MethodPost, "/x", `{"name":"snap"}`, nil, true, true)
		rec := httptest.NewRecorder()
		h.CreateWorkspaceSnapshotTemplate(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("fork invalid body", func(t *testing.T) {
		h := &WorkspaceHandler{Service: svc}
		req := workspaceHRequest(http.MethodPost, "/x", "{", map[string]string{"id": "ws-1"}, true, true)
		rec := httptest.NewRecorder()
		h.ForkWorkspace(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("user workspaces invalid limit", func(t *testing.T) {
		h := &WorkspaceHandler{Service: svc}
		req := workspaceHRequest(http.MethodGet, "/x?limit=bad", "", nil, true, false)
		rec := httptest.NewRecorder()
		h.GetUserWorkspaces(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("user workspaces no auth", func(t *testing.T) {
		h := &WorkspaceHandler{Service: svc}
		req := workspaceHRequest(http.MethodGet, "/x", "", nil, false, false)
		rec := httptest.NewRecorder()
		h.GetUserWorkspaces(rec, req)
		require.Equal(t, http.StatusUnauthorized, rec.Code)
	})
}

func TestWorkspace_F_ParseUserWorkspacesPagination(t *testing.T) {
	t.Run("default limit", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/x", nil)
		cursor, limit, err := parseUserWorkspacesPagination(req)
		require.Nil(t, err)
		require.Equal(t, "", cursor)
		require.Equal(t, 30, limit)
	})

	t.Run("caps at max", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/x?limit=100000&cursor=30", nil)
		cursor, limit, err := parseUserWorkspacesPagination(req)
		require.Nil(t, err)
		require.Equal(t, "abc", cursor)
		require.Equal(t, services.MaxUserWorkspacesPerPage, limit)
	})

	t.Run("explicit valid limit", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/x?limit=5", nil)
		_, limit, err := parseUserWorkspacesPagination(req)
		require.Nil(t, err)
		require.Equal(t, 5, limit)
	})

	t.Run("invalid limit", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/x?limit=-1", nil)
		_, _, err := parseUserWorkspacesPagination(req)
		require.NotNil(t, err)
	})
}

func TestWorkspace_F_ExtractWorkspaceEventID(t *testing.T) {
	require.Equal(t, "42", extractWorkspaceEventID(`{"id":42}`))
	require.Equal(t, "7", extractWorkspaceEventID(`{"sequence":7}`))
	require.Equal(t, "", extractWorkspaceEventID(`{"other":1}`))
	require.Equal(t, "", extractWorkspaceEventID("not-json"))
}
