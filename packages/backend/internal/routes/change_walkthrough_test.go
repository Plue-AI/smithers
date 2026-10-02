package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/internal/sse"
)

type changeWalkthroughRouteService struct {
	getFn   func(context.Context, int64, string, int64) (services.ChangeWalkthroughResponse, error)
	storeFn func(context.Context, int64, string, int64, services.ChangeWalkthroughResponse) (services.ChangeWalkthroughResponse, error)
}

func (s changeWalkthroughRouteService) GetWalkthrough(ctx context.Context, repositoryID int64, changeID string, revisionSeq int64) (services.ChangeWalkthroughResponse, error) {
	return s.getFn(ctx, repositoryID, changeID, revisionSeq)
}

func (s changeWalkthroughRouteService) StoreWalkthrough(ctx context.Context, repositoryID int64, changeID string, revisionSeq int64, input services.ChangeWalkthroughResponse) (services.ChangeWalkthroughResponse, error) {
	return s.storeFn(ctx, repositoryID, changeID, revisionSeq, input)
}

func changeWalkthroughRequest(method, target, body string) *http.Request {
	req := httptest.NewRequest(method, target, strings.NewReader(body))
	return withJJRouteParams(req, map[string]string{"owner": "acme", "repo": "demo", "change_id": "change-1"})
}

func TestJJVCSHandlerGetChangeWalkthrough(t *testing.T) {
	t.Parallel()
	diagram := "graph LR; A-->B"
	want := services.ChangeWalkthroughResponse{
		Sections: []services.ChangeWalkthroughSection{{Title: "Overview", Markdown: "The story", Diagram: &diagram}},
	}
	h := &JJVCSHandler{
		RepoResolver: jjVCSLegacyResolver{},
		WalkthroughService: changeWalkthroughRouteService{getFn: func(_ context.Context, repositoryID int64, changeID string, revisionSeq int64) (services.ChangeWalkthroughResponse, error) {
			assert.Equal(t, int64(1), repositoryID)
			assert.Equal(t, "change-1", changeID)
			assert.Equal(t, int64(4), revisionSeq)
			return want, nil
		}},
	}
	rec := httptest.NewRecorder()
	h.GetChangeWalkthrough(rec, changeWalkthroughRequest(http.MethodGet, "/api/repos/acme/demo/changes/change-1/walkthrough?rev=4", ""))

	require.Equal(t, http.StatusOK, rec.Code)
	var got services.ChangeWalkthroughResponse
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &got))
	assert.Equal(t, want.Sections, got.Sections)
	assert.NotContains(t, rec.Body.String(), "quiz")
}

func TestJJVCSHandlerGetChangeWalkthroughErrors(t *testing.T) {
	t.Parallel()

	t.Run("invalid revision", func(t *testing.T) {
		h := &JJVCSHandler{RepoResolver: jjVCSLegacyResolver{}}
		rec := httptest.NewRecorder()
		h.GetChangeWalkthrough(rec, changeWalkthroughRequest(http.MethodGet, "/walkthrough?rev=zero", ""))
		assert.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("not found", func(t *testing.T) {
		h := &JJVCSHandler{
			RepoResolver: jjVCSLegacyResolver{},
			WalkthroughService: changeWalkthroughRouteService{getFn: func(context.Context, int64, string, int64) (services.ChangeWalkthroughResponse, error) {
				return services.ChangeWalkthroughResponse{}, pkgerrors.NotFound("walkthrough not found")
			}},
		}
		rec := httptest.NewRecorder()
		h.GetChangeWalkthrough(rec, changeWalkthroughRequest(http.MethodGet, "/walkthrough", ""))
		assert.Equal(t, http.StatusNotFound, rec.Code)
	})
}

func TestJJVCSHandlerPutChangeWalkthrough(t *testing.T) {
	t.Parallel()
	body := `{"sections":[{"title":"Overview","markdown":"Read me"}],"quiz":[{"question":"What changed?","correctIndex":0}]}`
	h := &JJVCSHandler{
		RepoResolver: jjVCSLegacyResolver{},
		WalkthroughService: changeWalkthroughRouteService{storeFn: func(_ context.Context, repositoryID int64, changeID string, revisionSeq int64, input services.ChangeWalkthroughResponse) (services.ChangeWalkthroughResponse, error) {
			assert.Equal(t, int64(1), repositoryID)
			assert.Equal(t, "change-1", changeID)
			assert.Zero(t, revisionSeq)
			require.Len(t, input.Sections, 1)
			assert.Equal(t, "Read me", input.Sections[0].Markdown)
			return input, nil
		}},
	}
	rec := httptest.NewRecorder()
	h.PutChangeWalkthrough(rec, changeWalkthroughRequest(http.MethodPut, "/api/repos/acme/demo/changes/change-1/walkthrough", body))

	require.Equal(t, http.StatusOK, rec.Code)
	assert.JSONEq(t, `{"sections":[{"title":"Overview","markdown":"Read me"}]}`, rec.Body.String())
}

func TestJJVCSHandlerPutChangeWalkthroughRejectsMalformedBody(t *testing.T) {
	t.Parallel()
	h := &JJVCSHandler{RepoResolver: jjVCSLegacyResolver{}, WalkthroughService: changeWalkthroughRouteService{}}
	rec := httptest.NewRecorder()
	h.PutChangeWalkthrough(rec, changeWalkthroughRequest(http.MethodPut, "/walkthrough?rev=2", `{`))
	assert.Equal(t, http.StatusBadRequest, rec.Code)
}

func TestJJVCSHandlerChangeStream(t *testing.T) {
	// This test swaps the package seam and therefore must not run in parallel.
	h := &JJVCSHandler{Broker: &sse.Broker{}}

	rec := httptest.NewRecorder()
	h.ChangeStream(rec, httptest.NewRequest(http.MethodGet, "/changes/events", nil))
	require.Equal(t, http.StatusInternalServerError, rec.Code)

	oldServe := serveChangeBrokerSSE
	t.Cleanup(func() { serveChangeBrokerSSE = oldServe })
	var gotCfg sse.BrokerStreamConfig
	serveChangeBrokerSSE = func(w http.ResponseWriter, _ *http.Request, cfg sse.BrokerStreamConfig) {
		gotCfg = cfg
		w.WriteHeader(http.StatusAccepted)
	}
	h.Metrics = &SmithersMetrics{SSEActiveConnections: prometheus.NewGauge(prometheus.GaugeOpts{Name: "change_walkthrough_stream_active"})}

	req := httptest.NewRequest(http.MethodGet, "/api/repos/acme/demo/changes/events", nil)
	ctx := middleware.ContextWithRepoContext(req.Context(), &middleware.RepoContext{
		Owner:      "acme",
		Repository: &db.Repository{ID: 42, Name: "demo"},
	}, middleware.PermissionRead)
	ctx = middleware.ContextWithAuthInfo(ctx, &middleware.AuthInfo{User: &db.User{ID: 7}})
	rec = httptest.NewRecorder()
	h.ChangeStream(rec, req.WithContext(ctx))

	require.Equal(t, http.StatusAccepted, rec.Code)
	assert.Same(t, h.Broker, gotCfg.Broker)
	assert.Equal(t, "change_42", gotCfg.Channel)
	assert.Equal(t, int64(7), gotCfg.UserID)
	assert.Equal(t, "change", gotCfg.EventType)
	assert.NotNil(t, gotCfg.ActiveConnections)
	require.NotNil(t, gotCfg.FormatEventID)
	assert.Equal(t, "event-1", gotCfg.FormatEventID(`{"event_id":"event-1"}`))
	assert.Empty(t, gotCfg.FormatEventID("not json"))
}
