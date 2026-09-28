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
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

func TestCommitStatus_Cov_ErrorBranches(t *testing.T) {
	t.Parallel()

	t.Run("get requires repository context", func(t *testing.T) {
		h := CommitStatusHandler{Service: &mockCommitStatusRouteService{}}
		req := withCommitStatusRouteParams(httptest.NewRequest(http.MethodGet, "/statuses", nil), map[string]string{"ref": "main"})
		rec := httptest.NewRecorder()

		h.GetCommitStatuses(rec, req)

		require.Equal(t, http.StatusInternalServerError, rec.Code)
		assert.Contains(t, rec.Body.String(), "repository context not loaded")
	})

	t.Run("create requires sha route param", func(t *testing.T) {
		h := CommitStatusHandler{Service: &mockCommitStatusRouteService{}}
		req := httptest.NewRequest(http.MethodPost, "/statuses/", strings.NewReader(`{}`))
		req = withCommitStatusRouteParams(req, map[string]string{"sha": ""})
		req = withCommitStatusRepoContext(req, 101)
		req = withCommitStatusAuth(req, 7, "alice")
		rec := httptest.NewRecorder()

		h.CreateCommitStatus(rec, req)

		require.Equal(t, http.StatusBadRequest, rec.Code)
		assert.Contains(t, rec.Body.String(), "sha is required")
	})

	t.Run("create rejects invalid json before service call", func(t *testing.T) {
		called := false
		h := CommitStatusHandler{Service: &mockCommitStatusRouteService{
			createCommitStatusFn: func(context.Context, int64, string, services.CreateCommitStatusInput) (db.CommitStatus, error) {
				called = true
				return db.CommitStatus{}, nil
			},
		}}
		req := httptest.NewRequest(http.MethodPost, "/statuses/deadbeef", strings.NewReader(`{bad`))
		req = withCommitStatusRouteParams(req, map[string]string{"sha": "deadbeef"})
		req = withCommitStatusRepoContext(req, 101)
		req = withCommitStatusAuth(req, 7, "alice")
		rec := httptest.NewRecorder()

		h.CreateCommitStatus(rec, req)

		require.Equal(t, http.StatusBadRequest, rec.Code)
		assert.False(t, called)
	})

	t.Run("create propagates service validation", func(t *testing.T) {
		h := CommitStatusHandler{Service: &mockCommitStatusRouteService{
			createCommitStatusFn: func(ctx context.Context, repositoryID int64, sha string, input services.CreateCommitStatusInput) (db.CommitStatus, error) {
				assert.Equal(t, int64(101), repositoryID)
				assert.Equal(t, "deadbeef", sha)
				assert.Equal(t, int64(7), input.Actor.ID)
				return db.CommitStatus{}, pkgerrors.BadRequest("invalid status")
			},
		}}
		req := httptest.NewRequest(http.MethodPost, "/statuses/deadbeef", strings.NewReader(`{"context":"ci","status":"bogus"}`))
		req = withCommitStatusRouteParams(req, map[string]string{"sha": "deadbeef"})
		req = withCommitStatusRepoContext(req, 101)
		req = withCommitStatusAuth(req, 7, "alice")
		rec := httptest.NewRecorder()

		h.CreateCommitStatus(rec, req)

		require.Equal(t, http.StatusBadRequest, rec.Code)
		assert.Contains(t, rec.Body.String(), "invalid status")
	})
}
