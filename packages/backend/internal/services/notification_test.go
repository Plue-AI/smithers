package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// ---- mock ----

type mockNotificationQuerier struct {
	listFn         func(ctx context.Context, arg db.ListNotificationsByUserParams) ([]db.Notification, error)
	countFn        func(ctx context.Context, userID int64) (int64, error)
	markFn         func(ctx context.Context, arg db.MarkNotificationReadParams) error
	markAllFn      func(ctx context.Context, userID int64) error
	createFn       func(ctx context.Context, arg db.CreateNotificationParams) (db.Notification, error)
	notifyFn       func(ctx context.Context, arg db.NotifyUserParams) error
	listAfterIDFn  func(ctx context.Context, arg db.ListNotificationsAfterIDParams) ([]db.Notification, error)
	getByIDFn      func(ctx context.Context, id int64) (db.Notification, error)
	getPrefsFn     func(ctx context.Context, userID int64) (db.UserNotificationPreference, error)
	upsertPrefsFn  func(ctx context.Context, arg db.UpsertNotificationPreferencesParams) (db.UserNotificationPreference, error)
	listWatchersFn func(ctx context.Context, repositoryID int64) ([]db.ListActiveWatchersForRepoRow, error)
	listKeysetFn   func(ctx context.Context, arg db.ListNotificationsByUserKeysetParams) ([]db.Notification, error)

	getRepoByIDFn     func(ctx context.Context, id int64) (db.Repository, error)
	getIssueByIDFn    func(ctx context.Context, id int64) (db.Issue, error)
	getLandingByIDFn  func(ctx context.Context, id int64) (db.LandingRequest, error)
	isOrgOwnerFn      func(ctx context.Context, arg db.IsOrgOwnerForRepoUserParams) (bool, error)
	highestTeamPermFn func(ctx context.Context, arg db.GetHighestTeamPermissionForRepoUserParams) (string, error)
	collabPermFn      func(ctx context.Context, arg db.GetCollaboratorPermissionForRepoUserParams) (string, error)
}

func (m *mockNotificationQuerier) GetRepoByID(ctx context.Context, id int64) (db.Repository, error) {
	if m.getRepoByIDFn != nil {
		return m.getRepoByIDFn(ctx, id)
	}
	return db.Repository{ID: id, IsPublic: true}, nil
}

func (m *mockNotificationQuerier) GetIssueByID(ctx context.Context, id int64) (db.Issue, error) {
	if m.getIssueByIDFn != nil {
		return m.getIssueByIDFn(ctx, id)
	}
	return db.Issue{ID: id, RepositoryID: 1}, nil
}

func (m *mockNotificationQuerier) GetLandingRequestByID(ctx context.Context, id int64) (db.LandingRequest, error) {
	if m.getLandingByIDFn != nil {
		return m.getLandingByIDFn(ctx, id)
	}
	return db.LandingRequest{ID: id, RepositoryID: 1}, nil
}

func (m *mockNotificationQuerier) GetNotificationBranchLockRepository(ctx context.Context, id int64) (int64, error) {
	return 1, nil
}

func (m *mockNotificationQuerier) IsOrgOwnerForRepoUser(ctx context.Context, arg db.IsOrgOwnerForRepoUserParams) (bool, error) {
	if m.isOrgOwnerFn != nil {
		return m.isOrgOwnerFn(ctx, arg)
	}
	return false, nil
}

func (m *mockNotificationQuerier) GetHighestTeamPermissionForRepoUser(ctx context.Context, arg db.GetHighestTeamPermissionForRepoUserParams) (string, error) {
	if m.highestTeamPermFn != nil {
		return m.highestTeamPermFn(ctx, arg)
	}
	return "", nil
}

func (m *mockNotificationQuerier) GetCollaboratorPermissionForRepoUser(ctx context.Context, arg db.GetCollaboratorPermissionForRepoUserParams) (string, error) {
	if m.collabPermFn != nil {
		return m.collabPermFn(ctx, arg)
	}
	return "", nil
}

type mockNotificationCreateTx struct {
	createFn   func(ctx context.Context, arg db.CreateNotificationParams) (db.Notification, error)
	notifyFn   func(ctx context.Context, arg db.NotifyUserParams) error
	commitFn   func(ctx context.Context) error
	rollbackFn func(ctx context.Context) error
}

func (m *mockNotificationCreateTx) CreateNotification(ctx context.Context, arg db.CreateNotificationParams) (db.Notification, error) {
	if m.createFn != nil {
		return m.createFn(ctx, arg)
	}
	return db.Notification{}, nil
}

func (m *mockNotificationCreateTx) NotifyUser(ctx context.Context, arg db.NotifyUserParams) error {
	if m.notifyFn != nil {
		return m.notifyFn(ctx, arg)
	}
	return nil
}

func (m *mockNotificationCreateTx) Commit(ctx context.Context) error {
	if m.commitFn != nil {
		return m.commitFn(ctx)
	}
	return nil
}

func (m *mockNotificationCreateTx) Rollback(ctx context.Context) error {
	if m.rollbackFn != nil {
		return m.rollbackFn(ctx)
	}
	return nil
}

type mockNotificationCreateTxManager struct {
	beginFn func(ctx context.Context) (notificationCreateTx, error)
}

func (m *mockNotificationCreateTxManager) BeginCreateTx(ctx context.Context) (notificationCreateTx, error) {
	if m.beginFn != nil {
		return m.beginFn(ctx)
	}
	return nil, nil
}

func (m *mockNotificationQuerier) ListNotificationsByUser(ctx context.Context, arg db.ListNotificationsByUserParams) ([]db.Notification, error) {
	if m.listFn != nil {
		return m.listFn(ctx, arg)
	}
	return nil, nil
}

func (m *mockNotificationQuerier) ListNotificationsByUserKeyset(ctx context.Context, arg db.ListNotificationsByUserKeysetParams) ([]db.Notification, error) {
	if m.listKeysetFn != nil {
		return m.listKeysetFn(ctx, arg)
	}
	return nil, nil
}

func (m *mockNotificationQuerier) MarkNotificationRead(ctx context.Context, arg db.MarkNotificationReadParams) error {
	if m.markFn != nil {
		return m.markFn(ctx, arg)
	}
	return nil
}

func (m *mockNotificationQuerier) CountNotificationsByUser(ctx context.Context, userID int64) (int64, error) {
	if m.countFn != nil {
		return m.countFn(ctx, userID)
	}
	return 0, nil
}

func (m *mockNotificationQuerier) MarkAllNotificationsRead(ctx context.Context, userID int64) error {
	if m.markAllFn != nil {
		return m.markAllFn(ctx, userID)
	}
	return nil
}

func (m *mockNotificationQuerier) CreateNotification(ctx context.Context, arg db.CreateNotificationParams) (db.Notification, error) {
	if m.createFn != nil {
		return m.createFn(ctx, arg)
	}
	return db.Notification{}, nil
}

func (m *mockNotificationQuerier) NotifyUser(ctx context.Context, arg db.NotifyUserParams) error {
	if m.notifyFn != nil {
		return m.notifyFn(ctx, arg)
	}
	return nil
}

func (m *mockNotificationQuerier) ListNotificationsAfterID(ctx context.Context, arg db.ListNotificationsAfterIDParams) ([]db.Notification, error) {
	if m.listAfterIDFn != nil {
		return m.listAfterIDFn(ctx, arg)
	}
	return nil, nil
}

func (m *mockNotificationQuerier) GetNotificationByID(ctx context.Context, id int64) (db.Notification, error) {
	if m.getByIDFn != nil {
		return m.getByIDFn(ctx, id)
	}
	return db.Notification{}, nil
}

func (m *mockNotificationQuerier) GetNotificationPreferences(ctx context.Context, userID int64) (db.UserNotificationPreference, error) {
	if m.getPrefsFn != nil {
		return m.getPrefsFn(ctx, userID)
	}
	// Default: all preferences enabled.
	return db.UserNotificationPreference{
		UserID:         userID,
		NotifyIssues:   true,
		NotifyLandings: true,
		NotifyMentions: true,
	}, nil
}

func (m *mockNotificationQuerier) ListActiveWatchersForRepo(ctx context.Context, repositoryID int64) ([]db.ListActiveWatchersForRepoRow, error) {
	if m.listWatchersFn != nil {
		return m.listWatchersFn(ctx, repositoryID)
	}
	return nil, nil
}

func (m *mockNotificationQuerier) UpsertNotificationPreferences(ctx context.Context, arg db.UpsertNotificationPreferencesParams) (db.UserNotificationPreference, error) {
	if m.upsertPrefsFn != nil {
		return m.upsertPrefsFn(ctx, arg)
	}
	return db.UserNotificationPreference{UserID: arg.UserID, NotifyIssues: arg.NotifyIssues, NotifyLandings: arg.NotifyLandings, NotifyMentions: arg.NotifyMentions}, nil
}

// ---- helpers ----

func makeNotification(id, userID int64, status string) db.Notification {
	return db.Notification{
		ID:         id,
		UserID:     userID,
		SourceType: "issue",
		SourceID:   pgtype.Int8{Int64: 1, Valid: true},
		Subject:    "test subject",
		Body:       "test body",
		Status:     status,
		CreatedAt:  time.Now(),
		UpdatedAt:  time.Now(),
	}
}

// ---- ListNotifications (keyset) ----

func TestNotificationService_ListNotifications_ReturnsMappedItems(t *testing.T) {
	t.Parallel()

	const userID = int64(42)
	mock := &mockNotificationQuerier{
		listKeysetFn: func(_ context.Context, arg db.ListNotificationsByUserKeysetParams) ([]db.Notification, error) {
			assert.Equal(t, userID, arg.UserID)
			assert.Equal(t, int32(30), arg.PageSize)
			return []db.Notification{
				makeNotification(2, userID, "read"),
				makeNotification(1, userID, "unread"),
			}, nil
		},
		countFn: func(_ context.Context, argUserID int64) (int64, error) {
			assert.Equal(t, userID, argUserID)
			return 2, nil
		},
	}

	svc := NewNotificationService(mock)
	items, _, total, err := svc.ListNotifications(context.Background(), userID, 0, 30)
	require.NoError(t, err)
	assert.Equal(t, int64(2), total)
	require.Len(t, items, 2)
	assert.Equal(t, int64(2), items[0].ID)
	assert.Equal(t, int64(1), items[1].ID)
}

func TestNotificationService_ListNotifications_UsesTotalCountFromDB(t *testing.T) {
	t.Parallel()

	mock := &mockNotificationQuerier{
		listKeysetFn: func(_ context.Context, _ db.ListNotificationsByUserKeysetParams) ([]db.Notification, error) {
			return []db.Notification{
				makeNotification(2, 7, "unread"),
				makeNotification(1, 7, "unread"),
			}, nil
		},
		countFn: func(_ context.Context, userID int64) (int64, error) {
			assert.Equal(t, int64(7), userID)
			return 25, nil
		},
	}

	svc := NewNotificationService(mock)
	items, _, total, err := svc.ListNotifications(context.Background(), 7, 0, 2)
	require.NoError(t, err)
	require.Len(t, items, 2)
	assert.Equal(t, int64(25), total)
}

func TestNotificationService_ListNotifications_PassesBeforeIDAndLimit(t *testing.T) {
	t.Parallel()

	var capturedArg db.ListNotificationsByUserKeysetParams
	mock := &mockNotificationQuerier{
		listKeysetFn: func(_ context.Context, arg db.ListNotificationsByUserKeysetParams) ([]db.Notification, error) {
			capturedArg = arg
			return nil, nil
		},
	}

	svc := NewNotificationService(mock)
	_, _, _, err := svc.ListNotifications(context.Background(), 7, 50, 10)
	require.NoError(t, err)
	assert.Equal(t, int64(7), capturedArg.UserID)
	assert.Equal(t, int64(50), capturedArg.BeforeID)
	assert.Equal(t, int32(10), capturedArg.PageSize)
}

func TestNotificationService_ListNotifications_DefaultsOutOfRangeLimit(t *testing.T) {
	t.Parallel()

	testCases := []struct {
		name     string
		limit    int
		expected int32
	}{
		{"zero", 0, 30},
		{"negative", -5, 30},
		{"over 100", 200, 30},
	}

	for _, tc := range testCases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			var capturedArg db.ListNotificationsByUserKeysetParams
			mock := &mockNotificationQuerier{
				listKeysetFn: func(_ context.Context, arg db.ListNotificationsByUserKeysetParams) ([]db.Notification, error) {
					capturedArg = arg
					return nil, nil
				},
			}
			svc := NewNotificationService(mock)
			_, _, _, _ = svc.ListNotifications(context.Background(), 1, 0, tc.limit)
			assert.Equal(t, tc.expected, capturedArg.PageSize)
		})
	}
}

func TestNotificationService_ListNotifications_DBError_ReturnsInternalError(t *testing.T) {
	t.Parallel()

	mock := &mockNotificationQuerier{
		listKeysetFn: func(_ context.Context, _ db.ListNotificationsByUserKeysetParams) ([]db.Notification, error) {
			return nil, errors.New("db failure")
		},
	}

	svc := NewNotificationService(mock)
	_, _, _, err := svc.ListNotifications(context.Background(), 1, 0, 30)
	require.Error(t, err)
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, 500, apiErr.Status)
}

func TestNotificationService_ListNotifications_NullSourceID_Dropped(t *testing.T) {
	t.Parallel()

	// A notification without a source reference cannot be re-authorized
	// against its repository, so list/replay fail closed and drop it.
	notif := db.Notification{
		ID:         99,
		UserID:     1,
		SourceType: "mention",
		SourceID:   pgtype.Int8{Valid: false}, // NULL
		Subject:    "subj",
		Body:       "body",
		Status:     "unread",
		CreatedAt:  time.Now(),
		UpdatedAt:  time.Now(),
	}

	mock := &mockNotificationQuerier{
		listKeysetFn: func(_ context.Context, _ db.ListNotificationsByUserKeysetParams) ([]db.Notification, error) {
			return []db.Notification{notif}, nil
		},
	}

	svc := NewNotificationService(mock)
	items, _, _, err := svc.ListNotifications(context.Background(), 1, 0, 30)
	require.NoError(t, err)
	assert.Empty(t, items)
}

func TestNotificationService_NullSourceID_SerializesAsNil(t *testing.T) {
	t.Parallel()

	resp := toNotificationResponse(db.Notification{
		ID:         99,
		UserID:     1,
		SourceType: "landing",
		SourceID:   pgtype.Int8{Valid: false}, // NULL
	})
	assert.Nil(t, resp.SourceID)
}

// ---- MarkRead ----

func TestNotificationService_MarkRead_ForwardsCorrectParams(t *testing.T) {
	t.Parallel()

	const userID = int64(42)
	const notifID = int64(7)

	var capturedArg db.MarkNotificationReadParams
	mock := &mockNotificationQuerier{
		getByIDFn: func(_ context.Context, id int64) (db.Notification, error) {
			assert.Equal(t, notifID, id)
			return makeNotification(notifID, userID, "unread"), nil
		},
		markFn: func(_ context.Context, arg db.MarkNotificationReadParams) error {
			capturedArg = arg
			return nil
		},
	}

	svc := NewNotificationService(mock)
	err := svc.MarkRead(context.Background(), userID, notifID)
	require.NoError(t, err)
	assert.Equal(t, userID, capturedArg.UserID)
	assert.Equal(t, notifID, capturedArg.ID)
}

func TestNotificationService_MarkRead_DBError_ReturnsInternalError(t *testing.T) {
	t.Parallel()

	const userID = int64(1)
	const notifID = int64(2)

	mock := &mockNotificationQuerier{
		getByIDFn: func(_ context.Context, _ int64) (db.Notification, error) {
			return makeNotification(notifID, userID, "unread"), nil
		},
		markFn: func(_ context.Context, _ db.MarkNotificationReadParams) error {
			return errors.New("connection closed")
		},
	}

	svc := NewNotificationService(mock)
	err := svc.MarkRead(context.Background(), userID, notifID)
	require.Error(t, err)
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, 500, apiErr.Status)
}

func TestNotificationService_MarkRead_NotFound_Returns404(t *testing.T) {
	t.Parallel()

	mock := &mockNotificationQuerier{
		getByIDFn: func(_ context.Context, _ int64) (db.Notification, error) {
			return db.Notification{}, pgx.ErrNoRows
		},
	}

	svc := NewNotificationService(mock)
	err := svc.MarkRead(context.Background(), 1, 99)
	require.Error(t, err)
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, 404, apiErr.Status)
}

func TestNotificationService_MarkRead_ForeignNotification_Returns403(t *testing.T) {
	t.Parallel()

	const actorID = int64(10)
	const ownerID = int64(20)
	const notifID = int64(5)

	mock := &mockNotificationQuerier{
		getByIDFn: func(_ context.Context, _ int64) (db.Notification, error) {
			// Notification belongs to ownerID, not actorID.
			return makeNotification(notifID, ownerID, "unread"), nil
		},
	}

	svc := NewNotificationService(mock)
	err := svc.MarkRead(context.Background(), actorID, notifID)
	require.Error(t, err)
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, 403, apiErr.Status)
}

func TestNotificationService_MarkRead_MarkFnNotCalledOnOwnershipFailure(t *testing.T) {
	t.Parallel()

	markCalled := false
	mock := &mockNotificationQuerier{
		getByIDFn: func(_ context.Context, _ int64) (db.Notification, error) {
			return makeNotification(1, 99, "unread"), nil // owned by user 99
		},
		markFn: func(_ context.Context, _ db.MarkNotificationReadParams) error {
			markCalled = true
			return nil
		},
	}

	svc := NewNotificationService(mock)
	_ = svc.MarkRead(context.Background(), 1 /*actorID != 99*/, 1)
	assert.False(t, markCalled, "mark should not be called when ownership check fails")
}

// ---- MarkAllRead ----

func TestNotificationService_MarkAllRead_ForwardsUserID(t *testing.T) {
	t.Parallel()

	var capturedUserID int64
	mock := &mockNotificationQuerier{
		markAllFn: func(_ context.Context, userID int64) error {
			capturedUserID = userID
			return nil
		},
	}

	svc := NewNotificationService(mock)
	err := svc.MarkAllRead(context.Background(), 55)
	require.NoError(t, err)
	assert.Equal(t, int64(55), capturedUserID)
}

func TestNotificationService_MarkAllRead_DBError_ReturnsInternalError(t *testing.T) {
	t.Parallel()

	mock := &mockNotificationQuerier{
		markAllFn: func(_ context.Context, _ int64) error {
			return errors.New("db timeout")
		},
	}

	svc := NewNotificationService(mock)
	err := svc.MarkAllRead(context.Background(), 1)
	require.Error(t, err)
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, 500, apiErr.Status)
}

// ---- Create ----

func TestNotificationService_Create_Success(t *testing.T) {
	t.Parallel()

	now := time.Now().UTC().Truncate(time.Second)
	created := db.Notification{
		ID:         99,
		UserID:     42,
		SourceType: "mention",
		SourceID:   pgtype.Int8{Int64: 123, Valid: true},
		Subject:    "You were mentioned",
		Body:       "in issue #123",
		Status:     "unread",
		CreatedAt:  now,
		UpdatedAt:  now,
	}

	var createArg db.CreateNotificationParams
	var notifyArg db.NotifyUserParams
	mock := &mockNotificationQuerier{
		createFn: func(_ context.Context, arg db.CreateNotificationParams) (db.Notification, error) {
			createArg = arg
			return created, nil
		},
		notifyFn: func(_ context.Context, arg db.NotifyUserParams) error {
			notifyArg = arg
			return nil
		},
	}

	svc := NewNotificationService(mock)
	out, err := svc.Create(context.Background(), db.CreateNotificationParams{
		UserID:     42,
		SourceType: "mention",
		SourceID:   pgtype.Int8{Int64: 123, Valid: true},
		Subject:    "You were mentioned",
		Body:       "in issue #123",
	})
	require.NoError(t, err)

	assert.Equal(t, int64(42), createArg.UserID)
	assert.Equal(t, "mention", createArg.SourceType)
	assert.Equal(t, int64(42), notifyArg.UserID)
	assert.Equal(t, int64(99), out.ID)
	assert.Equal(t, "mention", out.SourceType)
	assert.Equal(t, int64(123), out.SourceID)
	assert.Equal(t, "You were mentioned", out.Subject)
	assert.Equal(t, "in issue #123", out.Body)
	assert.Equal(t, "unread", out.Status)

	var payload map[string]any
	require.NoError(t, json.Unmarshal([]byte(notifyArg.Payload), &payload))
	assert.Equal(t, float64(99), payload["id"])
	assert.Equal(t, "mention", payload["source_type"])
	assert.Equal(t, "You were mentioned", payload["subject"])
}

func TestNotificationService_Create_LargeBodyKeepsNotifyPayloadUnderPostgresLimit(t *testing.T) {
	t.Parallel()

	body := strings.Repeat("<", 10000)
	now := time.Now().UTC().Truncate(time.Second)

	var createArg db.CreateNotificationParams
	var notifyArg db.NotifyUserParams
	mock := &mockNotificationQuerier{
		createFn: func(_ context.Context, arg db.CreateNotificationParams) (db.Notification, error) {
			createArg = arg
			return db.Notification{
				ID:         100,
				UserID:     arg.UserID,
				SourceType: arg.SourceType,
				SourceID:   arg.SourceID,
				Subject:    arg.Subject,
				Body:       arg.Body,
				Status:     "unread",
				CreatedAt:  now,
				UpdatedAt:  now,
			}, nil
		},
		notifyFn: func(_ context.Context, arg db.NotifyUserParams) error {
			notifyArg = arg
			return nil
		},
	}

	svc := NewNotificationService(mock)
	out, err := svc.Create(context.Background(), db.CreateNotificationParams{
		UserID:     42,
		SourceType: "issue",
		SourceID:   pgtype.Int8{Int64: 123, Valid: true},
		Subject:    "Long issue body",
		Body:       body,
	})
	require.NoError(t, err)

	assert.Equal(t, body, createArg.Body)
	assert.Equal(t, body, out.Body)
	assert.LessOrEqual(t, len(notifyArg.Payload), maxNotificationPayloadBytes)

	var payload map[string]any
	require.NoError(t, json.Unmarshal([]byte(notifyArg.Payload), &payload))
	payloadBody, ok := payload["body"].(string)
	require.True(t, ok)
	assert.True(t, strings.HasPrefix(body, payloadBody))
	assert.LessOrEqual(t, len(payloadBody), maxNotificationPayloadBodyLen)
	assert.Less(t, len(payloadBody), len(body))
}

func TestNotificationService_Create_LargeBodyTransactionCommitsWithBoundedPayload(t *testing.T) {
	t.Parallel()

	body := strings.Repeat("<", 10000)
	rollbackCalled := false
	commitCalled := false

	txManager := &mockNotificationCreateTxManager{
		beginFn: func(_ context.Context) (notificationCreateTx, error) {
			return &mockNotificationCreateTx{
				createFn: func(_ context.Context, arg db.CreateNotificationParams) (db.Notification, error) {
					return db.Notification{
						ID:         202,
						UserID:     arg.UserID,
						SourceType: arg.SourceType,
						SourceID:   arg.SourceID,
						Subject:    arg.Subject,
						Body:       arg.Body,
						Status:     "unread",
						CreatedAt:  time.Now().UTC(),
						UpdatedAt:  time.Now().UTC(),
					}, nil
				},
				notifyFn: func(_ context.Context, arg db.NotifyUserParams) error {
					if len(arg.Payload) > maxNotificationPayloadBytes {
						return errors.New("payload string too long")
					}
					return nil
				},
				commitFn: func(_ context.Context) error {
					commitCalled = true
					return nil
				},
				rollbackFn: func(_ context.Context) error {
					rollbackCalled = true
					return nil
				},
			}, nil
		},
	}

	svc := NewNotificationService(&mockNotificationQuerier{})
	svc.createTxManager = txManager

	out, err := svc.Create(context.Background(), db.CreateNotificationParams{
		UserID:     9,
		SourceType: "issue",
		SourceID:   pgtype.Int8{Int64: 123, Valid: true},
		Subject:    "Long issue body",
		Body:       body,
	})
	require.NoError(t, err)
	assert.Equal(t, body, out.Body)
	assert.True(t, commitCalled)
	assert.False(t, rollbackCalled)
}

func TestNotificationService_Create_InsertError_ReturnsInternalError(t *testing.T) {
	t.Parallel()

	notifyCalled := false
	mock := &mockNotificationQuerier{
		createFn: func(_ context.Context, _ db.CreateNotificationParams) (db.Notification, error) {
			return db.Notification{}, errors.New("insert failed")
		},
		notifyFn: func(_ context.Context, _ db.NotifyUserParams) error {
			notifyCalled = true
			return nil
		},
	}

	svc := NewNotificationService(mock)
	_, err := svc.Create(context.Background(), db.CreateNotificationParams{
		UserID:     1,
		SourceType: "issue",
		Subject:    "subject",
		Body:       "body",
	})
	require.Error(t, err)
	assert.False(t, notifyCalled)

	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, 500, apiErr.Status)
}

func TestNotificationService_Create_NotifyError_ReturnsInternalError(t *testing.T) {
	t.Parallel()

	mock := &mockNotificationQuerier{
		createFn: func(_ context.Context, _ db.CreateNotificationParams) (db.Notification, error) {
			return db.Notification{
				ID:         100,
				UserID:     9,
				SourceType: "issue",
				Subject:    "subject",
				Body:       "body",
				Status:     "unread",
				CreatedAt:  time.Now().UTC(),
				UpdatedAt:  time.Now().UTC(),
			}, nil
		},
		notifyFn: func(_ context.Context, _ db.NotifyUserParams) error {
			return errors.New("notify failed")
		},
	}

	svc := NewNotificationService(mock)
	_, err := svc.Create(context.Background(), db.CreateNotificationParams{
		UserID:     9,
		SourceType: "issue",
		Subject:    "subject",
		Body:       "body",
	})
	require.Error(t, err)
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, 500, apiErr.Status)
}

func TestNotificationService_Create_NotifyError_RollsBackTransaction(t *testing.T) {
	t.Parallel()

	rollbackCalled := false
	commitCalled := false

	txManager := &mockNotificationCreateTxManager{
		beginFn: func(_ context.Context) (notificationCreateTx, error) {
			return &mockNotificationCreateTx{
				createFn: func(_ context.Context, _ db.CreateNotificationParams) (db.Notification, error) {
					return db.Notification{
						ID:         201,
						UserID:     9,
						SourceType: "issue",
						Subject:    "subject",
						Body:       "body",
						Status:     "unread",
						CreatedAt:  time.Now().UTC(),
						UpdatedAt:  time.Now().UTC(),
					}, nil
				},
				notifyFn: func(_ context.Context, _ db.NotifyUserParams) error {
					return errors.New("notify failed")
				},
				commitFn: func(_ context.Context) error {
					commitCalled = true
					return nil
				},
				rollbackFn: func(_ context.Context) error {
					rollbackCalled = true
					return nil
				},
			}, nil
		},
	}

	svc := NewNotificationService(&mockNotificationQuerier{})
	svc.createTxManager = txManager

	_, err := svc.Create(context.Background(), db.CreateNotificationParams{
		UserID:     9,
		SourceType: "issue",
		Subject:    "subject",
		Body:       "body",
	})
	require.Error(t, err)
	assert.True(t, rollbackCalled)
	assert.False(t, commitCalled)
}

func TestNotificationService_Create_Success_CommitsTransaction(t *testing.T) {
	t.Parallel()

	rollbackCalled := false
	commitCalled := false

	txManager := &mockNotificationCreateTxManager{
		beginFn: func(_ context.Context) (notificationCreateTx, error) {
			return &mockNotificationCreateTx{
				createFn: func(_ context.Context, _ db.CreateNotificationParams) (db.Notification, error) {
					return db.Notification{
						ID:         301,
						UserID:     13,
						SourceType: "issue",
						Subject:    "subject",
						Body:       "body",
						Status:     "unread",
						CreatedAt:  time.Now().UTC(),
						UpdatedAt:  time.Now().UTC(),
					}, nil
				},
				notifyFn: func(_ context.Context, _ db.NotifyUserParams) error {
					return nil
				},
				commitFn: func(_ context.Context) error {
					commitCalled = true
					return nil
				},
				rollbackFn: func(_ context.Context) error {
					rollbackCalled = true
					return nil
				},
			}, nil
		},
	}

	svc := NewNotificationService(&mockNotificationQuerier{})
	svc.createTxManager = txManager

	out, err := svc.Create(context.Background(), db.CreateNotificationParams{
		UserID:     13,
		SourceType: "issue",
		Subject:    "subject",
		Body:       "body",
	})
	require.NoError(t, err)
	assert.Equal(t, int64(301), out.ID)
	assert.True(t, commitCalled)
	assert.False(t, rollbackCalled)
}

// ---- toNotificationResponse ----

func TestToNotificationResponse_MapsAllFields(t *testing.T) {
	t.Parallel()

	now := time.Now().UTC()
	n := db.Notification{
		ID:         10,
		UserID:     1,
		SourceType: "issue",
		SourceID:   pgtype.Int8{Int64: 5, Valid: true},
		Subject:    "You were mentioned",
		Body:       "in issue #42",
		Status:     "unread",
		ReadAt:     pgtype.Timestamptz{},
		CreatedAt:  now,
		UpdatedAt:  now,
	}

	resp := toNotificationResponse(n)

	assert.Equal(t, int64(10), resp.ID)
	assert.Equal(t, "issue", resp.SourceType)
	assert.Equal(t, int64(5), resp.SourceID)
	assert.Equal(t, "You were mentioned", resp.Subject)
	assert.Equal(t, "in issue #42", resp.Body)
	assert.Equal(t, "unread", resp.Status)
	assert.Equal(t, now, resp.CreatedAt)
	assert.Equal(t, now, resp.UpdatedAt)
}

func TestToNotificationResponse_ReadAtNull_UsesNilPointerType(t *testing.T) {
	t.Parallel()

	n := db.Notification{
		ID:         10,
		UserID:     1,
		SourceType: "issue",
		SourceID:   pgtype.Int8{Int64: 5, Valid: true},
		Subject:    "You were mentioned",
		Body:       "in issue #42",
		Status:     "unread",
		ReadAt:     pgtype.Timestamptz{},
		CreatedAt:  time.Now().UTC(),
		UpdatedAt:  time.Now().UTC(),
	}

	resp := toNotificationResponse(n)
	readAt, ok := any(resp.ReadAt).(*time.Time)
	require.True(t, ok)
	assert.Nil(t, readAt)
}

func TestToNotificationResponse_ReadAtValid_UsesTimePointerTypeAndValue(t *testing.T) {
	t.Parallel()

	readAtTS := time.Now().UTC().Truncate(time.Second)
	n := db.Notification{
		ID:         11,
		UserID:     1,
		SourceType: "issue",
		SourceID:   pgtype.Int8{Int64: 6, Valid: true},
		Subject:    "Review requested",
		Body:       "for landing #12",
		Status:     "read",
		ReadAt:     pgtype.Timestamptz{Time: readAtTS, Valid: true},
		CreatedAt:  time.Now().UTC(),
		UpdatedAt:  time.Now().UTC(),
	}

	resp := toNotificationResponse(n)
	readAt, ok := any(resp.ReadAt).(*time.Time)
	require.True(t, ok)
	require.NotNil(t, readAt)
	assert.Equal(t, readAtTS, *readAt)
}

// ---- ListNotificationsAfterID ----

func TestNotificationService_ListNotificationsAfterID_ReturnsMappedItems(t *testing.T) {
	t.Parallel()

	const userID = int64(42)
	mock := &mockNotificationQuerier{
		listAfterIDFn: func(_ context.Context, arg db.ListNotificationsAfterIDParams) ([]db.Notification, error) {
			assert.Equal(t, userID, arg.UserID)
			assert.Equal(t, int64(10), arg.AfterID)
			assert.Equal(t, int32(100), arg.MaxResults)
			return []db.Notification{
				makeNotification(11, userID, "unread"),
				makeNotification(12, userID, "unread"),
			}, nil
		},
	}

	svc := NewNotificationService(mock)
	items, err := svc.ListNotificationsAfterID(context.Background(), userID, 10, 100)
	require.NoError(t, err)
	require.Len(t, items, 2)
	assert.Equal(t, int64(11), items[0].ID)
	assert.Equal(t, int64(12), items[1].ID)
}

func TestNotificationService_ListNotificationsAfterID_EmptyResult(t *testing.T) {
	t.Parallel()

	mock := &mockNotificationQuerier{
		listAfterIDFn: func(_ context.Context, _ db.ListNotificationsAfterIDParams) ([]db.Notification, error) {
			return nil, nil
		},
	}

	svc := NewNotificationService(mock)
	items, err := svc.ListNotificationsAfterID(context.Background(), 1, 999, 100)
	require.NoError(t, err)
	assert.Empty(t, items)
}

func TestNotificationService_ListNotificationsAfterID_DBError_ReturnsInternalError(t *testing.T) {
	t.Parallel()

	mock := &mockNotificationQuerier{
		listAfterIDFn: func(_ context.Context, _ db.ListNotificationsAfterIDParams) ([]db.Notification, error) {
			return nil, errors.New("db failure")
		},
	}

	svc := NewNotificationService(mock)
	_, err := svc.ListNotificationsAfterID(context.Background(), 1, 10, 100)
	require.Error(t, err)
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, 500, apiErr.Status)
}

func TestNotificationService_ListNotificationsAfterID_ClampsLimit(t *testing.T) {
	t.Parallel()

	var capturedArg db.ListNotificationsAfterIDParams
	mock := &mockNotificationQuerier{
		listAfterIDFn: func(_ context.Context, arg db.ListNotificationsAfterIDParams) ([]db.Notification, error) {
			capturedArg = arg
			return nil, nil
		},
	}

	svc := NewNotificationService(mock)
	_, _ = svc.ListNotificationsAfterID(context.Background(), 1, 10, 5000)
	// Limit should be clamped to max 1000.
	assert.LessOrEqual(t, capturedArg.MaxResults, int32(1000))
}

// ---- GetPreferences ----

func TestNotificationService_GetPreferences_ReturnsStoredPrefs(t *testing.T) {
	t.Parallel()

	mock := &mockNotificationQuerier{
		getPrefsFn: func(_ context.Context, userID int64) (db.UserNotificationPreference, error) {
			return db.UserNotificationPreference{
				UserID:         userID,
				NotifyIssues:   true,
				NotifyLandings: false,
				NotifyMentions: true,
			}, nil
		},
	}

	svc := NewNotificationService(mock)
	prefs, err := svc.GetPreferences(context.Background(), 99)
	require.NoError(t, err)
	assert.True(t, prefs.NotifyIssues)
	assert.False(t, prefs.NotifyLandings)
	assert.True(t, prefs.NotifyMentions)
}

func TestNotificationService_GetPreferences_NoRow_ReturnsDefaults(t *testing.T) {
	t.Parallel()

	mock := &mockNotificationQuerier{
		getPrefsFn: func(_ context.Context, _ int64) (db.UserNotificationPreference, error) {
			return db.UserNotificationPreference{}, pgx.ErrNoRows
		},
	}

	svc := NewNotificationService(mock)
	prefs, err := svc.GetPreferences(context.Background(), 1)
	require.NoError(t, err)
	// All defaults should be true.
	assert.True(t, prefs.NotifyIssues)
	assert.True(t, prefs.NotifyLandings)
	assert.True(t, prefs.NotifyMentions)
}

// ---- UpdatePreferences ----

func TestNotificationService_UpdatePreferences_ForwardsParams(t *testing.T) {
	t.Parallel()

	var capturedArg db.UpsertNotificationPreferencesParams
	mock := &mockNotificationQuerier{
		upsertPrefsFn: func(_ context.Context, arg db.UpsertNotificationPreferencesParams) (db.UserNotificationPreference, error) {
			capturedArg = arg
			return db.UserNotificationPreference{
				UserID:         arg.UserID,
				NotifyIssues:   arg.NotifyIssues,
				NotifyLandings: arg.NotifyLandings,
				NotifyMentions: arg.NotifyMentions,
			}, nil
		},
	}

	svc := NewNotificationService(mock)
	prefs, err := svc.UpdatePreferences(context.Background(), 7, UpdateInboxPreferencesRequest{NotifyIssues: new(false), NotifyLandings: new(true), NotifyMentions: new(false)})
	require.NoError(t, err)
	assert.Equal(t, int64(7), capturedArg.UserID)
	assert.False(t, capturedArg.NotifyIssues)
	assert.True(t, capturedArg.NotifyLandings)
	assert.False(t, capturedArg.NotifyMentions)
	assert.False(t, prefs.NotifyIssues)
	assert.True(t, prefs.NotifyLandings)
	assert.False(t, prefs.NotifyMentions)
}

// ---- watcherWantsSource / UserWantsMentionNotification ----

func TestNotificationService_WatcherWantsSource_IssuePreferenceRespected(t *testing.T) {
	t.Parallel()

	mock := &mockNotificationQuerier{
		getPrefsFn: func(_ context.Context, userID int64) (db.UserNotificationPreference, error) {
			return db.UserNotificationPreference{
				UserID:         userID,
				NotifyIssues:   false,
				NotifyLandings: true,
				NotifyMentions: true,
			}, nil
		},
	}

	svc := NewNotificationService(mock)
	assert.False(t, svc.watcherWantsSource(context.Background(), 1, "issue"))
	assert.True(t, svc.watcherWantsSource(context.Background(), 1, "landing"))
}

func TestNotificationService_UserWantsMentionNotification_RespectsPreference(t *testing.T) {
	t.Parallel()

	mock := &mockNotificationQuerier{
		getPrefsFn: func(_ context.Context, userID int64) (db.UserNotificationPreference, error) {
			return db.UserNotificationPreference{
				UserID:         userID,
				NotifyIssues:   true,
				NotifyLandings: true,
				NotifyMentions: false,
			}, nil
		},
	}

	svc := NewNotificationService(mock)
	assert.False(t, svc.UserWantsMentionNotification(context.Background(), 1))
}

func TestNotificationService_UserWantsMentionNotification_DefaultsToTrueOnNoRow(t *testing.T) {
	t.Parallel()

	mock := &mockNotificationQuerier{
		getPrefsFn: func(_ context.Context, _ int64) (db.UserNotificationPreference, error) {
			return db.UserNotificationPreference{}, pgx.ErrNoRows
		},
	}

	svc := NewNotificationService(mock)
	assert.True(t, svc.UserWantsMentionNotification(context.Background(), 1))
}

func TestNotificationService_WatcherWantsSource_FailsClosedOnReadError(t *testing.T) {
	t.Parallel()

	mock := &mockNotificationQuerier{
		getPrefsFn: func(_ context.Context, _ int64) (db.UserNotificationPreference, error) {
			return db.UserNotificationPreference{}, errors.New("connection reset")
		},
	}

	svc := NewNotificationService(mock)
	assert.False(t, svc.watcherWantsSource(context.Background(), 1, "issue"))
	assert.False(t, svc.watcherWantsSource(context.Background(), 1, "landing"))
}

func TestNotificationService_UserWantsMentionNotification_FailsClosedOnReadError(t *testing.T) {
	t.Parallel()

	mock := &mockNotificationQuerier{
		getPrefsFn: func(_ context.Context, _ int64) (db.UserNotificationPreference, error) {
			return db.UserNotificationPreference{}, errors.New("connection reset")
		},
	}

	svc := NewNotificationService(mock)
	assert.False(t, svc.UserWantsMentionNotification(context.Background(), 1))
}

// ---- NotifyWatchers preference gating ----

func TestNotificationService_NotifyWatchers_SkipsWatcherWhoDisabledIssues(t *testing.T) {
	t.Parallel()

	watchers := []db.ListActiveWatchersForRepoRow{
		{ID: 10}, // wants issues
		{ID: 11}, // does NOT want issues
	}

	var notifiedUsers []int64
	mock := &mockNotificationQuerier{
		listWatchersFn: func(_ context.Context, _ int64) ([]db.ListActiveWatchersForRepoRow, error) {
			return watchers, nil
		},
		getPrefsFn: func(_ context.Context, userID int64) (db.UserNotificationPreference, error) {
			if userID == 11 {
				return db.UserNotificationPreference{UserID: userID, NotifyIssues: false, NotifyLandings: true, NotifyMentions: true}, nil
			}
			return db.UserNotificationPreference{UserID: userID, NotifyIssues: true, NotifyLandings: true, NotifyMentions: true}, nil
		},
		createFn: func(_ context.Context, arg db.CreateNotificationParams) (db.Notification, error) {
			notifiedUsers = append(notifiedUsers, arg.UserID)
			return db.Notification{ID: 1, UserID: arg.UserID, SourceType: arg.SourceType, Subject: arg.Subject, Body: arg.Body, Status: "unread"}, nil
		},
		notifyFn: func(_ context.Context, _ db.NotifyUserParams) error { return nil },
	}

	svc := NewNotificationService(mock)
	svc.notifyWatchersSync(context.Background(), 1, "issue", 42, "New issue", "body")

	assert.Equal(t, []int64{10}, notifiedUsers, "only watcher 10 who wants issues should be notified")
}

func TestNotificationService_NotifyWatchers_SkipsWatcherOnPreferenceReadError(t *testing.T) {
	t.Parallel()

	var createCalls int
	mock := &mockNotificationQuerier{
		listWatchersFn: func(_ context.Context, _ int64) ([]db.ListActiveWatchersForRepoRow, error) {
			return []db.ListActiveWatchersForRepoRow{{ID: 10}}, nil
		},
		getPrefsFn: func(_ context.Context, _ int64) (db.UserNotificationPreference, error) {
			return db.UserNotificationPreference{}, errors.New("connection reset")
		},
		createFn: func(_ context.Context, arg db.CreateNotificationParams) (db.Notification, error) {
			createCalls++
			return db.Notification{ID: 1, UserID: arg.UserID}, nil
		},
		notifyFn: func(_ context.Context, _ db.NotifyUserParams) error { return nil },
	}

	svc := NewNotificationService(mock)
	svc.notifyWatchersSync(context.Background(), 1, "issue", 42, "New issue", "body")

	assert.Zero(t, createCalls, "a preference read failure must not send a notification")
}

// ---- revocation filtering (list / replay / watcher fan-out) ----

func TestNotificationService_ListNotifications_DropsRowsUserCanNoLongerRead(t *testing.T) {
	t.Parallel()

	now := time.Now()
	rows := []db.Notification{
		{ID: 3, UserID: 5, SourceType: "issue", SourceID: pgtype.Int8{Int64: 100, Valid: true}, Subject: "public issue", Status: "unread", CreatedAt: now, UpdatedAt: now},
		{ID: 2, UserID: 5, SourceType: "issue", SourceID: pgtype.Int8{Int64: 200, Valid: true}, Subject: "revoked private issue", Status: "unread", CreatedAt: now, UpdatedAt: now},
		{ID: 1, UserID: 5, SourceType: "mention", SourceID: pgtype.Int8{Int64: 999, Valid: true}, Subject: "orphaned mention", Status: "unread", CreatedAt: now, UpdatedAt: now},
	}

	mock := &mockNotificationQuerier{
		listKeysetFn: func(_ context.Context, _ db.ListNotificationsByUserKeysetParams) ([]db.Notification, error) {
			return rows, nil
		},
		countFn: func(_ context.Context, _ int64) (int64, error) { return int64(len(rows)), nil },
		getIssueByIDFn: func(_ context.Context, id int64) (db.Issue, error) {
			switch id {
			case 100:
				return db.Issue{ID: id, RepositoryID: 1}, nil
			case 200:
				return db.Issue{ID: id, RepositoryID: 2}, nil
			default:
				return db.Issue{}, pgx.ErrNoRows
			}
		},
		getLandingByIDFn: func(_ context.Context, _ int64) (db.LandingRequest, error) {
			return db.LandingRequest{}, pgx.ErrNoRows
		},
		getRepoByIDFn: func(_ context.Context, id int64) (db.Repository, error) {
			if id == 1 {
				return db.Repository{ID: id, IsPublic: true}, nil
			}
			// Private repo owned by someone else; user 5 has no collab/team access.
			return db.Repository{ID: id, IsPublic: false, UserID: pgtype.Int8{Int64: 42, Valid: true}}, nil
		},
	}

	svc := NewNotificationService(mock)
	items, _, total, err := svc.ListNotifications(context.Background(), 5, 0, 30)
	require.NoError(t, err)
	assert.Equal(t, int64(3), total, "total stays the raw row count")
	require.Len(t, items, 1, "revoked-repo and unresolvable-source rows must be dropped")
	assert.Equal(t, int64(3), items[0].ID)
}

func TestNotificationService_ListNotificationsAfterID_DropsRowsUserCanNoLongerRead(t *testing.T) {
	t.Parallel()

	now := time.Now()
	mock := &mockNotificationQuerier{
		listAfterIDFn: func(_ context.Context, _ db.ListNotificationsAfterIDParams) ([]db.Notification, error) {
			return []db.Notification{
				{ID: 10, UserID: 5, SourceType: "landing", SourceID: pgtype.Int8{Int64: 300, Valid: true}, Subject: "readable landing", Status: "unread", CreatedAt: now, UpdatedAt: now},
				{ID: 11, UserID: 5, SourceType: "landing", SourceID: pgtype.Int8{Int64: 400, Valid: true}, Subject: "revoked landing", Status: "unread", CreatedAt: now, UpdatedAt: now},
			}, nil
		},
		getLandingByIDFn: func(_ context.Context, id int64) (db.LandingRequest, error) {
			if id == 300 {
				return db.LandingRequest{ID: id, RepositoryID: 1}, nil
			}
			return db.LandingRequest{ID: id, RepositoryID: 2}, nil
		},
		getRepoByIDFn: func(_ context.Context, id int64) (db.Repository, error) {
			if id == 1 {
				return db.Repository{ID: id, IsPublic: true}, nil
			}
			return db.Repository{ID: id, IsPublic: false, UserID: pgtype.Int8{Int64: 42, Valid: true}}, nil
		},
	}

	svc := NewNotificationService(mock)
	items, err := svc.ListNotificationsAfterID(context.Background(), 5, 0, 100)
	require.NoError(t, err)
	require.Len(t, items, 1, "SSE replay must not resurface revoked-repo snippets")
	assert.Equal(t, int64(10), items[0].ID)
}

func TestNotificationService_NotifyWatchers_SkipsWatcherWithoutRepoReadAccess(t *testing.T) {
	t.Parallel()

	var notifiedUsers []int64
	mock := &mockNotificationQuerier{
		getRepoByIDFn: func(_ context.Context, id int64) (db.Repository, error) {
			return db.Repository{ID: id, IsPublic: false, UserID: pgtype.Int8{Int64: 42, Valid: true}}, nil
		},
		listWatchersFn: func(_ context.Context, _ int64) ([]db.ListActiveWatchersForRepoRow, error) {
			return []db.ListActiveWatchersForRepoRow{
				{ID: 2}, // stale watch row: access was revoked
				{ID: 3}, // still a collaborator with read access
			}, nil
		},
		collabPermFn: func(_ context.Context, arg db.GetCollaboratorPermissionForRepoUserParams) (string, error) {
			if arg.UserID.Valid && arg.UserID.Int64 == 3 {
				return "read", nil
			}
			return "", nil
		},
		createFn: func(_ context.Context, arg db.CreateNotificationParams) (db.Notification, error) {
			notifiedUsers = append(notifiedUsers, arg.UserID)
			return db.Notification{ID: 1, UserID: arg.UserID}, nil
		},
		notifyFn: func(_ context.Context, _ db.NotifyUserParams) error { return nil },
	}

	svc := NewNotificationService(mock)
	svc.notifyWatchersSync(context.Background(), 1, "issue", 7, "private issue", "secret body")

	assert.Equal(t, []int64{3}, notifiedUsers, "a stale watch row must not deliver private repo notifications")
}

func TestNotificationService_UpdatePreferencesPartial(t *testing.T) {
	for mask := 0; mask < 8; mask++ {
		t.Run(fmt.Sprintf("fields-%d", mask), func(t *testing.T) {
			current := db.UserNotificationPreference{NotifyIssues: false, NotifyLandings: true, NotifyMentions: false}
			reads, writes := 0, 0
			q := &mockNotificationQuerier{
				getPrefsFn: func(context.Context, int64) (db.UserNotificationPreference, error) { reads++; return current, nil },
				upsertPrefsFn: func(_ context.Context, arg db.UpsertNotificationPreferencesParams) (db.UserNotificationPreference, error) {
					writes++
					return db.UserNotificationPreference{NotifyIssues: arg.NotifyIssues, NotifyLandings: arg.NotifyLandings, NotifyMentions: arg.NotifyMentions}, nil
				},
			}
			req := UpdateInboxPreferencesRequest{}
			expected := NotificationPreferencesResponse{NotifyLandings: true}
			if mask&1 != 0 {
				req.NotifyIssues = new(true)
				expected.NotifyIssues = true
			}
			if mask&2 != 0 {
				req.NotifyLandings = new(false)
				expected.NotifyLandings = false
			}
			if mask&4 != 0 {
				req.NotifyMentions = new(true)
				expected.NotifyMentions = true
			}
			actual, err := NewNotificationService(q).UpdatePreferences(t.Context(), 7, req)
			require.NoError(t, err)
			require.Equal(t, expected, actual)
			require.Equal(t, 1, writes)
			if mask == 7 {
				require.Zero(t, reads)
			} else {
				require.Equal(t, 1, reads)
			}
		})
	}
	t.Run("read failure has no write", func(t *testing.T) {
		q := &mockNotificationQuerier{getPrefsFn: func(context.Context, int64) (db.UserNotificationPreference, error) {
			return db.UserNotificationPreference{}, fmt.Errorf("unavailable")
		}, upsertPrefsFn: func(context.Context, db.UpsertNotificationPreferencesParams) (db.UserNotificationPreference, error) {
			t.Fatal("write after failed read")
			return db.UserNotificationPreference{}, nil
		}}
		_, err := NewNotificationService(q).UpdatePreferences(t.Context(), 7, UpdateInboxPreferencesRequest{NotifyIssues: new(false)})
		require.Error(t, err)
	})
}
