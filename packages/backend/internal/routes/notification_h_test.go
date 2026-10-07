package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

func TestNotification_H_PreferencesAndReplayBranches(t *testing.T) {
	t.Run("get auth and service error", func(t *testing.T) {
		handler := &NotificationHandler{Service: &mockNotificationRouteService{
			getPrefsFn: func(context.Context, int64) (services.NotificationPreferencesResponse, error) {
				return services.NotificationPreferencesResponse{}, pkgerrors.Internal("prefs failed")
			},
		}}
		req := httptest.NewRequest(http.MethodGet, "/preferences", nil)
		rec := httptest.NewRecorder()
		handler.GetNotificationPreferences(rec, req)
		require.Equal(t, http.StatusUnauthorized, rec.Code)

		req = withAuth(httptest.NewRequest(http.MethodGet, "/preferences", nil), 7, "alice")
		rec = httptest.NewRecorder()
		handler.GetNotificationPreferences(rec, req)
		require.Equal(t, http.StatusInternalServerError, rec.Code)
	})

	t.Run("put auth invalid json and update error", func(t *testing.T) {
		handler := &NotificationHandler{Service: &mockNotificationRouteService{
			getPrefsFn: func(context.Context, int64) (services.NotificationPreferencesResponse, error) {
				return services.NotificationPreferencesResponse{NotifyIssues: true, NotifyLandings: true, NotifyMentions: true}, nil
			},
			updatePrefsFn: func(context.Context, int64, services.UpdateInboxPreferencesRequest) (services.NotificationPreferencesResponse, error) {
				return services.NotificationPreferencesResponse{}, pkgerrors.Internal("update failed")
			},
		}}
		req := httptest.NewRequest(http.MethodPut, "/preferences", strings.NewReader(`{}`))
		rec := httptest.NewRecorder()
		handler.PutNotificationPreferences(rec, req)
		require.Equal(t, http.StatusUnauthorized, rec.Code)

		req = withAuth(httptest.NewRequest(http.MethodPut, "/preferences", strings.NewReader(`{`)), 7, "alice")
		rec = httptest.NewRecorder()
		handler.PutNotificationPreferences(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)

		req = withAuth(httptest.NewRequest(http.MethodPut, "/preferences", strings.NewReader(`{"notify_landings":false,"notify_mentions":false}`)), 7, "alice")
		rec = httptest.NewRecorder()
		handler.PutNotificationPreferences(rec, req)
		require.Equal(t, http.StatusInternalServerError, rec.Code)
	})

	t.Run("stream metrics branch and replay empty cases", func(t *testing.T) {
		handler := &NotificationHandler{Service: &mockNotificationRouteService{}, Metrics: NewSmithersMetrics()}
		req := withAuth(httptest.NewRequest(http.MethodGet, "/notifications", nil), 7, "alice")
		rec := httptest.NewRecorder()
		handler.NotificationStream(rec, req)
		require.Equal(t, http.StatusInternalServerError, rec.Code)

		flusher := &notificationCovFlusher{}
		rec = httptest.NewRecorder()
		req = httptest.NewRequest(http.MethodGet, "/notifications", nil)
		handler.replayNotifications(7)(rec, req, flusher)
		require.Empty(t, rec.Body.String())
		require.False(t, flusher.flushed)

		handler = &NotificationHandler{Service: &mockNotificationRouteService{
			listAfterIDFn: func(context.Context, int64, int64, int) ([]services.NotificationResponse, error) {
				return []services.NotificationResponse{{ID: 1, SourceID: func() {}}}, nil
			},
		}}
		req = httptest.NewRequest(http.MethodGet, "/notifications", nil)
		req.Header.Set("Last-Event-ID", "1")
		rec = httptest.NewRecorder()
		handler.replayNotifications(7)(rec, req, flusher)
		require.Contains(t, rec.Body.String(), "event: stream.error")
		require.NotContains(t, rec.Body.String(), "id:")
	})
}

func TestNotification_H_ExtractNotificationID(t *testing.T) {
	require.Equal(t, "44", extractNotificationID(`{"id":44}`))
	require.Empty(t, extractNotificationID(`{"id":0}`))
	require.Empty(t, extractNotificationID(`{`))

	_, err := json.Marshal(services.NotificationResponse{ID: 1, SourceID: func() {}})
	require.Error(t, err)
	require.IsType(t, &json.UnsupportedTypeError{}, err)
}
