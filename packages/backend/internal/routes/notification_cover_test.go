package routes

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type notificationCovFlusher struct {
	flushed bool
}

func (f *notificationCovFlusher) Flush() {
	f.flushed = true
}

func TestNotification_Cov_PreferencesHandlers(t *testing.T) {
	t.Parallel()

	t.Run("get success", func(t *testing.T) {
		t.Parallel()

		h := &NotificationHandler{Service: &mockNotificationRouteService{
			getPrefsFn: func(_ context.Context, userID int64) (services.NotificationPreferencesResponse, error) {
				assert.Equal(t, int64(42), userID)
				return services.NotificationPreferencesResponse{NotifyIssues: true, NotifyLandings: false, NotifyMentions: true}, nil
			},
		}}
		req := httptest.NewRequest(http.MethodGet, "/api/notifications/preferences", nil)
		req = withAuth(req, 42, "alice")
		rec := httptest.NewRecorder()

		h.GetNotificationPreferences(rec, req)

		require.Equal(t, http.StatusOK, rec.Code)
		assert.Contains(t, rec.Body.String(), `"notify_landings":false`)
	})

	t.Run("put passes omitted fields to the service", func(t *testing.T) {
		t.Parallel()

		h := &NotificationHandler{Service: &mockNotificationRouteService{
			getPrefsFn: func(context.Context, int64) (services.NotificationPreferencesResponse, error) {
				return services.NotificationPreferencesResponse{NotifyIssues: true, NotifyLandings: true, NotifyMentions: false}, nil
			},
			updatePrefsFn: func(_ context.Context, userID int64, req services.UpdateInboxPreferencesRequest) (services.NotificationPreferencesResponse, error) {
				assert.Equal(t, int64(42), userID)
				require.NotNil(t, req.NotifyIssues)
				assert.False(t, *req.NotifyIssues)
				assert.Nil(t, req.NotifyLandings)
				assert.Nil(t, req.NotifyMentions)
				return services.NotificationPreferencesResponse{NotifyIssues: false, NotifyLandings: true, NotifyMentions: false}, nil
			},
		}}
		req := httptest.NewRequest(http.MethodPut, "/api/notifications/preferences", strings.NewReader(`{"notify_issues":false}`))
		req = withAuth(req, 42, "alice")
		rec := httptest.NewRecorder()

		h.PutNotificationPreferences(rec, req)

		require.Equal(t, http.StatusOK, rec.Code)
		assert.Contains(t, rec.Body.String(), `"notify_issues":false`)
	})

	t.Run("put service error", func(t *testing.T) {
		t.Parallel()

		h := &NotificationHandler{Service: &mockNotificationRouteService{
			updatePrefsFn: func(context.Context, int64, services.UpdateInboxPreferencesRequest) (services.NotificationPreferencesResponse, error) {
				return services.NotificationPreferencesResponse{}, pkgerrors.Internal("prefs unavailable")
			},
		}}
		req := httptest.NewRequest(http.MethodPut, "/api/notifications/preferences", strings.NewReader(`{"notify_issues":false}`))
		req = withAuth(req, 42, "alice")
		rec := httptest.NewRecorder()

		h.PutNotificationPreferences(rec, req)

		require.Equal(t, http.StatusInternalServerError, rec.Code)
	})
}

func TestNotification_Cov_ReplayNotificationsCallback(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, 7, 1, 12, 0, 0, 0, time.UTC)
	var capturedAfter int64
	h := &NotificationHandler{Service: &mockNotificationRouteService{
		listAfterIDFn: func(_ context.Context, userID, afterID int64, limit int) ([]services.NotificationResponse, error) {
			assert.Equal(t, int64(9), userID)
			assert.Equal(t, 1000, limit)
			capturedAfter = afterID
			return []services.NotificationResponse{{ID: 12, SourceType: "issue", Subject: "missed", CreatedAt: now, UpdatedAt: now}}, nil
		},
	}}
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/notifications", nil)
	req.Header.Set("Last-Event-ID", "10")
	flusher := &notificationCovFlusher{}

	h.replayNotifications(9)(rec, req, flusher)

	assert.Equal(t, int64(10), capturedAfter)
	assert.True(t, flusher.flushed)
	assert.Contains(t, rec.Body.String(), "id: 12")
	assert.Contains(t, rec.Body.String(), "event: notification")

	invalidRec := httptest.NewRecorder()
	invalidReq := httptest.NewRequest(http.MethodGet, "/api/notifications", nil)
	invalidReq.Header.Set("Last-Event-ID", "0")
	h.replayNotifications(9)(invalidRec, invalidReq, &notificationCovFlusher{})
	assert.Empty(t, invalidRec.Body.String())
}

func TestNotification_Cov_ReplayNotificationsServiceErrorReportsRetry(t *testing.T) {
	t.Parallel()

	h := &NotificationHandler{Service: &mockNotificationRouteService{
		listAfterIDFn: func(context.Context, int64, int64, int) ([]services.NotificationResponse, error) {
			return nil, pkgerrors.Internal("db down")
		},
	}}
	req := httptest.NewRequest(http.MethodGet, "/api/notifications", nil)
	req.Header.Set("Last-Event-ID", "10")
	rec := httptest.NewRecorder()
	flusher := &notificationCovFlusher{}

	h.replayNotifications(9)(rec, req, flusher)

	assert.Contains(t, rec.Body.String(), "event: stream.error")
	assert.NotContains(t, rec.Body.String(), "id:")
	assert.True(t, flusher.flushed)
}
