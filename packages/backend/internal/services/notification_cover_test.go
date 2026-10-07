package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

func notificationCovInsertUser(t *testing.T) int64 {
	t.Helper()
	pool := getAgentTestPool(t)
	suffix := fmt.Sprintf("%s_%d", strings.NewReplacer("/", "_").Replace(strings.ToLower(t.Name())), time.Now().UnixNano())
	var id int64
	err := pool.QueryRow(context.Background(), `
		INSERT INTO users (username, lower_username, email, lower_email, display_name)
		VALUES ($1, $2, $3, $4, $5)
		RETURNING id
	`, "notif_"+suffix, "notif_"+suffix, "notif_"+suffix+"@example.test", "notif_"+suffix+"@example.test", "Notification User").Scan(&id)
	require.NoError(t, err)
	return id
}

func TestNotification_Cov_WithPoolCommitsAndNotifies(t *testing.T) {
	pool := getAgentTestPool(t)
	userID := notificationCovInsertUser(t)
	svc := NewNotificationServiceWithPool(db.New(pool), pool)
	require.NotNil(t, svc.createTxManager)

	resp, err := svc.Create(context.Background(), db.CreateNotificationParams{
		UserID:     userID,
		SourceType: "issue",
		SourceID:   pgtype.Int8{Int64: 123, Valid: true},
		Subject:    "subject",
		Body:       "body",
	})
	require.NoError(t, err)
	assert.Equal(t, "issue", resp.SourceType)
	assert.Equal(t, int64(123), resp.SourceID)

	var stored string
	err = pool.QueryRow(context.Background(), `SELECT subject FROM notifications WHERE id = $1`, resp.ID).Scan(&stored)
	require.NoError(t, err)
	assert.Equal(t, "subject", stored)
}

func TestNotification_Cov_WithPoolRollsBackOnCreateError(t *testing.T) {
	pool := getAgentTestPool(t)
	svc := NewNotificationServiceWithPool(db.New(pool), pool)
	_, err := svc.Create(context.Background(), db.CreateNotificationParams{
		UserID:     -999,
		SourceType: "issue",
		Subject:    "bad",
		Body:       "bad",
	})
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))
	assert.Contains(t, err.Error(), "create notification")
}

func TestNotification_Cov_ListPreferenceAndWatcherErrors(t *testing.T) {
	svc := NewNotificationService(&mockNotificationQuerier{
		listKeysetFn: func(context.Context, db.ListNotificationsByUserKeysetParams) ([]db.Notification, error) {
			return []db.Notification{makeNotification(3, 7, "unread")}, nil
		},
		countFn: func(context.Context, int64) (int64, error) {
			return 0, errors.New("count failed")
		},
	})
	_, _, _, err := svc.ListNotifications(context.Background(), 7, 0, 1)
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	svc = NewNotificationService(&mockNotificationQuerier{
		getPrefsFn: func(context.Context, int64) (db.UserNotificationPreference, error) {
			return db.UserNotificationPreference{}, errors.New("prefs failed")
		},
	})
	_, err = svc.GetPreferences(context.Background(), 7)
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	svc = NewNotificationService(&mockNotificationQuerier{
		upsertPrefsFn: func(context.Context, db.UpsertNotificationPreferencesParams) (db.UserNotificationPreference, error) {
			return db.UserNotificationPreference{}, errors.New("upsert failed")
		},
	})
	_, err = svc.UpdatePreferences(context.Background(), 7, UpdateInboxPreferencesRequest{NotifyIssues: new(true), NotifyLandings: new(false), NotifyMentions: new(true)})
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	var createCalls int
	svc = NewNotificationService(&mockNotificationQuerier{
		listWatchersFn: func(context.Context, int64) ([]db.ListActiveWatchersForRepoRow, error) {
			return nil, errors.New("watchers failed")
		},
		createFn: func(context.Context, db.CreateNotificationParams) (db.Notification, error) {
			createCalls++
			return db.Notification{}, nil
		},
	})
	svc.notifyWatchersSync(context.Background(), 42, "issue", 1, "subject", "body")
	assert.Zero(t, createCalls)
}

func TestNotification_Cov_BuildPayloadAndUnknownWatcherSource(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	payload, err := buildNotificationPayload(db.Notification{
		ID:         44,
		UserID:     55,
		SourceType: "custom",
		SourceID:   pgtype.Int8{},
		Subject:    "subject",
		Body:       "body",
		Status:     "unread",
		CreatedAt:  now,
		UpdatedAt:  now,
	})
	require.NoError(t, err)
	var decoded map[string]any
	require.NoError(t, json.Unmarshal([]byte(payload), &decoded))
	assert.Equal(t, float64(44), decoded["id"])
	assert.Nil(t, decoded["source_id"])

	svc := NewNotificationService(&mockNotificationQuerier{
		getPrefsFn: func(context.Context, int64) (db.UserNotificationPreference, error) {
			return db.UserNotificationPreference{NotifyIssues: false, NotifyLandings: false, NotifyMentions: false}, nil
		},
	})
	assert.True(t, svc.watcherWantsSource(context.Background(), 1, "custom"))
	assert.False(t, svc.UserWantsMentionNotification(context.Background(), 1))
}
