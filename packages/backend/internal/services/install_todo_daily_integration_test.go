package services

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/stretchr/testify/require"
)

func TestTodoDailyAdmissionQueueAndRaisePostgres(t *testing.T) {
	o, ctx := newTodoAdmission(t)
	q := db.New(o.pool)
	setup := &InstallSetupService{Pool: o.pool.(*pgxpool.Pool)}
	limit, err := todoDailyAdmissionLimit(ctx, o.pool)
	require.NoError(t, err)
	require.EqualValues(t, 12, limit)
	require.NoError(t, setup.SetTodoDailyAdmissions(ctx, o.userID, 1))
	first := o.fileTodo(ctx, "daily-first")
	second := o.fileTodo(ctx, "daily-second")
	now := time.Now().UTC()
	checks := mythicalChecksOf(first)
	checks.AdmissionDay = now.Format("2006-01-02")
	first.Checks = checks.encode()
	_, err = q.SaveMythicalItem(ctx, first)
	require.NoError(t, err)
	err = todoDailyAllowance(ctx, o.pool, now)
	require.ErrorIs(t, err, errTodoDailyLimit)
	second = *todoDailyQueued(second)
	second, err = q.SaveMythicalItem(ctx, second)
	require.NoError(t, err)
	card, err := o.service.Todo(ctx, o.repoID, second.Number.Int64)
	require.NoError(t, err)
	require.Equal(t, "queued", card["state"])
	require.Equal(t, "daily_limit", card["queue"].(map[string]any)["reason"])
	require.NoError(t, setup.SetTodoDailyAdmissions(ctx, o.userID, 2))
	saved, err := q.GetMythicalItem(ctx, second.ID)
	require.NoError(t, err)
	require.True(t, saved.NextAttemptAt.Time.Before(time.Now().Add(time.Second)))
	err = todoDailyAllowance(ctx, o.pool, now)
	require.NoError(t, err)
	err = todoDailyAllowance(ctx, o.pool, now.Truncate(24*time.Hour).Add(24*time.Hour))
	require.NoError(t, err)
	row, err := q.GetInstallSetting(ctx, "todo_daily_admissions")
	require.NoError(t, err)
	require.Equal(t, o.userID, row.UpdatedBy.Int64)
	require.JSONEq(t, "2", string(row.Value))
	require.Error(t, setup.SetTodoDailyAdmissions(ctx, o.userID, 0))
	agentCtx := middleware.ContextWithAuthInfo(context.Background(), &middleware.AuthInfo{User: &db.User{ID: o.userID}, IsTokenAuth: true})
	require.Error(t, setup.SetTodoDailyAdmissions(agentCtx, o.userID, 4))
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "todo_daily_admissions", Value: json.RawMessage(`0`)}))
	_, err = todoDailyAdmissionLimit(ctx, o.pool)
	require.Error(t, err)
}

func TestTodoDailyAdmissionLaunchIsDurablePostgres(t *testing.T) {
	o, ctx := newTodoAdmission(t)
	o.service.UseInstallGitHubPolling(nil)
	o.service.SetTodoFlow(func(context.Context, int64, string) (string, error) { return todoPinOne, nil })
	setup := &InstallSetupService{Pool: o.pool.(*pgxpool.Pool)}
	require.NoError(t, setup.SetTodoDailyAdmissions(ctx, o.userID, 1))
	first := o.fileTodo(ctx, "launch-first")
	second := o.fileTodo(ctx, "launch-second")
	o.wake()
	first = o.byID(uuidString(first.ID))
	second = o.byID(uuidString(second.ID))
	require.Equal(t, "running", first.State, first.Reason)
	require.NotEmpty(t, mythicalChecksOf(first).AdmissionDay)
	require.Equal(t, "queued", second.State, second.Reason)
	require.Equal(t, todoDailyLimitReason, second.Reason)
	require.Empty(t, second.WorkspaceID)
	require.Len(t, o.launcher.byFlow("todo"), 1)
	o.wake()
	require.Len(t, o.launcher.byFlow("todo"), 1)
	require.NoError(t, setup.SetTodoDailyAdmissions(ctx, o.userID, 2))
	o.wake()
	second = o.byID(uuidString(second.ID))
	require.Equal(t, "running", second.State, second.Reason)
	require.NotEmpty(t, mythicalChecksOf(second).AdmissionDay)
	require.Len(t, o.launcher.byFlow("todo"), 2)
}

func TestTodoDailyAdmissionRaisePreservesLaunchBoundPostgres(t *testing.T) {
	o, ctx := newTodoAdmission(t)
	o.service.UseInstallGitHubPolling(nil)
	o.service.SetTodoFlow(func(context.Context, int64, string) (string, error) { return todoPinOne, nil })
	setup := &InstallSetupService{Pool: o.pool.(*pgxpool.Pool)}
	require.NoError(t, setup.SetTodoDailyAdmissions(ctx, o.userID, 1))
	o.fileTodo(ctx, "bound-first")
	second := o.fileTodo(ctx, "bound-second")
	o.wake()
	second = o.byID(uuidString(second.ID))
	require.Equal(t, todoDailyLimitReason, second.Reason)
	checks := mythicalChecksOf(second)
	checks.Launches = mythicalLaunchBound
	second.Checks = checks.encode()
	_, err := db.New(o.pool).SaveMythicalItem(ctx, second)
	require.NoError(t, err)
	require.NoError(t, setup.SetTodoDailyAdmissions(ctx, o.userID, 2))
	o.wake()
	second = o.byID(uuidString(second.ID))
	require.Equal(t, "blocked", second.State)
	require.Equal(t, "launch_bound", mythicalChecksOf(second).Fault.Tag)
	require.Empty(t, mythicalChecksOf(second).AdmissionDay)
	require.Len(t, o.launcher.byFlow("todo"), 1)
}
