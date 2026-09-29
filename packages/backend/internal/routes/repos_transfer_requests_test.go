package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	apierrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

func TestRepoTransferRequestHandlers(t *testing.T) {
	t.Run("list authenticates and returns only service rows", func(t *testing.T) {
		called := false
		h := RepoHandler{Service: mockRepoRouteService{listTransfersFn: func(_ context.Context, actor *db.User) ([]db.RepositoryTransferRequest, error) {
			called = true
			require.Equal(t, int64(2), actor.ID)
			return []db.RepositoryTransferRequest{{ID: 17, RecipientID: 2, SourceOwner: "alice", SourceName: "demo", Status: "pending"}}, nil
		}}}
		unauth := httptest.NewRecorder()
		h.ListRepoTransfers(unauth, httptest.NewRequest(http.MethodGet, "/api/user/repository-transfers", nil))
		require.Equal(t, http.StatusUnauthorized, unauth.Code)
		require.False(t, called)
		rec := httptest.NewRecorder()
		h.ListRepoTransfers(rec, withAuth(httptest.NewRequest(http.MethodGet, "/api/user/repository-transfers", nil), 2, "bob"))
		require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
		var rows []db.RepositoryTransferRequest
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &rows))
		require.Len(t, rows, 1)
		require.Equal(t, int64(17), rows[0].ID)
		h.Service = mockRepoRouteService{listTransfersFn: func(context.Context, *db.User) ([]db.RepositoryTransferRequest, error) {
			return nil, apierrors.Forbidden("denied")
		}}
		failure := httptest.NewRecorder()
		h.ListRepoTransfers(failure, withAuth(httptest.NewRequest(http.MethodGet, "/api/user/repository-transfers", nil), 2, "bob"))
		require.Equal(t, http.StatusForbidden, failure.Code)
	})

	t.Run("accept returns the new repository identity", func(t *testing.T) {
		audit := &reposHAuditQueries{}
		h := RepoHandler{SSHHost: "smithers.test", AuditService: services.NewAuditService(audit), Service: mockRepoRouteService{acceptTransferFn: func(_ context.Context, actor *db.User, id int64) (db.Repository, error) {
			require.Equal(t, int64(2), actor.ID)
			require.Equal(t, int64(17), id)
			return routeRepo(nil), nil
		}}}
		req := withAuth(withRouteParams(httptest.NewRequest(http.MethodPost, "/api/user/repository-transfers/17/accept", nil), map[string]string{"transfer_id": "17"}), 2, "bob")
		rec := httptest.NewRecorder()
		h.AcceptRepoTransfer(rec, req)
		require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
		var body RepoResponse
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
		require.Equal(t, "bob/demo", body.FullName)
		require.Equal(t, "git@smithers.test:bob/demo.git", body.CloneURL)
		require.Len(t, audit.calls, 1)
		require.Equal(t, "repo.transfer", audit.calls[0].EventType)
		require.Equal(t, "transfer", audit.calls[0].Action)
		require.Equal(t, "repository", audit.calls[0].TargetType)
		require.Equal(t, "bob/demo", audit.calls[0].TargetName)
		require.True(t, audit.calls[0].TargetID.Valid)
		require.Equal(t, int64(9), audit.calls[0].TargetID.Int64)
		require.True(t, audit.calls[0].ActorID.Valid)
		require.Equal(t, int64(2), audit.calls[0].ActorID.Int64)
		require.Equal(t, "bob", audit.calls[0].ActorName)
	})

	for _, tc := range []struct {
		name    string
		action  string
		call    func(*RepoHandler, http.ResponseWriter, *http.Request)
		service func(*testing.T, *mockRepoRouteService)
	}{
		{"decline", "transfer_declined", (*RepoHandler).DeclineRepoTransfer, func(t *testing.T, m *mockRepoRouteService) {
			m.declineTransferFn = func(_ context.Context, actor *db.User, id int64) error {
				require.Equal(t, int64(17), id)
				require.Equal(t, int64(2), actor.ID)
				return nil
			}
		}},
		{"cancel", "transfer_cancelled", (*RepoHandler).CancelRepoTransfer, func(t *testing.T, m *mockRepoRouteService) {
			m.cancelTransferFn = func(_ context.Context, actor *db.User, id int64) error {
				require.Equal(t, int64(17), id)
				require.Equal(t, int64(2), actor.ID)
				return nil
			}
		}},
	} {
		t.Run(tc.name+" returns no content", func(t *testing.T) {
			service := &mockRepoRouteService{}
			tc.service(t, service)
			audit := &reposHAuditQueries{}
			h := RepoHandler{Service: service, AuditService: services.NewAuditService(audit)}
			req := withAuth(withRouteParams(httptest.NewRequest(http.MethodPost, "/api/user/repository-transfers/17/"+tc.name, nil), map[string]string{"transfer_id": "17"}), 2, "bob")
			rec := httptest.NewRecorder()
			tc.call(&h, rec, req)
			require.Equal(t, http.StatusNoContent, rec.Code, rec.Body.String())
			require.Empty(t, rec.Body.String())
			require.Len(t, audit.calls, 1)
			require.Equal(t, "repo."+tc.action, audit.calls[0].EventType)
			require.Equal(t, tc.action, audit.calls[0].Action)
			require.Equal(t, "repository_transfer", audit.calls[0].TargetType)
			require.True(t, audit.calls[0].TargetID.Valid)
			require.Equal(t, int64(17), audit.calls[0].TargetID.Int64)
			require.True(t, audit.calls[0].ActorID.Valid)
			require.Equal(t, int64(2), audit.calls[0].ActorID.Int64)
		})
	}
}

func TestRepoTransferRequestHandlersRejectBadIDsAndServiceErrors(t *testing.T) {
	for _, tc := range []struct {
		name string
		call func(*RepoHandler, http.ResponseWriter, *http.Request)
	}{
		{"accept", (*RepoHandler).AcceptRepoTransfer},
		{"decline", (*RepoHandler).DeclineRepoTransfer},
		{"cancel", (*RepoHandler).CancelRepoTransfer},
	} {
		t.Run(tc.name, func(t *testing.T) {
			unauth := httptest.NewRecorder()
			tc.call(&RepoHandler{Service: mockRepoRouteService{}}, unauth, withRouteParams(httptest.NewRequest(http.MethodPost, "/", nil), map[string]string{"transfer_id": "17"}))
			require.Equal(t, http.StatusUnauthorized, unauth.Code)
			for _, id := range []string{"0", "-1", "bad", "9223372036854775808"} {
				h := RepoHandler{Service: mockRepoRouteService{}}
				req := withAuth(withRouteParams(httptest.NewRequest(http.MethodPost, "/", nil), map[string]string{"transfer_id": id}), 2, "bob")
				rec := httptest.NewRecorder()
				tc.call(&h, rec, req)
				require.Equal(t, http.StatusBadRequest, rec.Code, id+": "+rec.Body.String())
			}
			audit := &reposHAuditQueries{}
			h := RepoHandler{AuditService: services.NewAuditService(audit), Service: mockRepoRouteService{
				acceptTransferFn: func(context.Context, *db.User, int64) (db.Repository, error) {
					return db.Repository{}, apierrors.Conflict("stale")
				},
				declineTransferFn: func(context.Context, *db.User, int64) error { return apierrors.Conflict("stale") },
				cancelTransferFn:  func(context.Context, *db.User, int64) error { return apierrors.Conflict("stale") },
			}}
			req := withAuth(withRouteParams(httptest.NewRequest(http.MethodPost, "/", nil), map[string]string{"transfer_id": "17"}), 2, "bob")
			rec := httptest.NewRecorder()
			tc.call(&h, rec, req)
			require.Equal(t, http.StatusConflict, rec.Code, rec.Body.String())
			require.Empty(t, audit.calls)
		})
	}
}
