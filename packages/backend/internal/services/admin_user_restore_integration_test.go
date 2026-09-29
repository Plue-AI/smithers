package services

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/revocation"
)

func TestAdminUserService_RestoresSuspendedAccountButNotDeletedAccount(t *testing.T) {
	pool := newProductTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	q := db.New(pool)

	actorName := "admin-" + uuid.NewString()
	actor, err := q.CreateUser(ctx, db.CreateUserParams{
		Username: actorName, LowerUsername: actorName,
	})
	require.NoError(t, err)
	username := "restore-" + uuid.NewString()
	user, err := q.CreateUser(ctx, db.CreateUserParams{Username: username, LowerUsername: username})
	require.NoError(t, err)

	busCtx, stopBus := context.WithCancel(context.Background())
	bus := revocation.NewBus(pool, q)
	bus.PollInterval = 20 * time.Millisecond
	require.NoError(t, bus.Start(busCtx))
	t.Cleanup(func() { stopBus(); <-bus.Done() })

	service := NewAdminUserService(q, WithAdminAuditor(NewAuditService(q)))
	auditCtx := ContextWithAdminAuditActor(ctx, AdminAuditActor{
		UserID: actor.ID, Username: actor.Username, IPAddress: "203.0.113.44",
	})

	suspended, err := service.SetSuspended(auditCtx, username, true)
	require.NoError(t, err)
	require.True(t, suspended.Suspended)
	_, err = q.GetUserByLowerUsername(ctx, username)
	require.ErrorIs(t, err, pgx.ErrNoRows, "public lookups must hide suspended users")
	require.Eventually(t, func() bool { return bus.IsUserDisabled(user.ID) }, 3*time.Second, 10*time.Millisecond)

	restored, err := service.SetSuspended(auditCtx, username, false)
	require.NoError(t, err)
	require.False(t, restored.Suspended)
	require.Equal(t, user.ID, restored.ID)
	_, err = q.GetUserByLowerUsername(ctx, username)
	require.NoError(t, err)
	require.Eventually(t, func() bool { return !bus.IsUserDisabled(user.ID) }, 3*time.Second, 10*time.Millisecond)

	require.NoError(t, service.DeleteUser(auditCtx, username))
	require.Eventually(t, func() bool { return bus.IsUserDisabled(user.ID) }, 3*time.Second, 10*time.Millisecond)
	_, err = service.SetSuspended(auditCtx, username, false)
	require.Equal(t, http.StatusNotFound, apiStatus(t, err))
	deleted, err := q.GetUserByID(ctx, user.ID)
	require.NoError(t, err)
	require.True(t, deleted.DeletedAt.Valid)
	require.False(t, deleted.IsActive)
	_, err = q.GetUserByLowerUsername(ctx, username)
	require.ErrorIs(t, err, pgx.ErrNoRows)
	_, err = q.SetUserSuspended(ctx, db.SetUserSuspendedParams{UserID: user.ID, Suspended: false})
	require.ErrorIs(t, err, pgx.ErrNoRows, "a concurrent deletion must not be reversed by the update")

	rows, err := pool.Query(ctx, `SELECT action, metadata, actor_id, actor_name, target_id
		FROM audit_log WHERE event_type = 'admin.user.set_suspended' AND target_id = $1 ORDER BY id`, user.ID)
	require.NoError(t, err)
	defer rows.Close()
	var actions []string
	var metadataValues []string
	for rows.Next() {
		var action, actorName string
		var metadata []byte
		var actorID, targetID int64
		require.NoError(t, rows.Scan(&action, &metadata, &actorID, &actorName, &targetID))
		require.Equal(t, actor.ID, actorID)
		require.Equal(t, actor.Username, actorName)
		require.Equal(t, user.ID, targetID)
		actions = append(actions, action)
		metadataValues = append(metadataValues, string(metadata))
	}
	require.NoError(t, rows.Err())
	require.Equal(t, []string{"suspend", "unsuspend"}, actions)
	require.Len(t, metadataValues, 2)
	require.JSONEq(t, `{"suspended":true}`, metadataValues[0])
	require.JSONEq(t, `{"suspended":false}`, metadataValues[1])

	revocationRows, err := pool.Query(ctx, `SELECT kind FROM revocation_events WHERE user_id = $1 ORDER BY id`, user.ID)
	require.NoError(t, err)
	defer revocationRows.Close()
	var kinds []string
	for revocationRows.Next() {
		var kind string
		require.NoError(t, revocationRows.Scan(&kind))
		kinds = append(kinds, kind)
	}
	require.NoError(t, revocationRows.Err())
	require.Equal(t, []string{"user_disabled", "user_enabled", "user_disabled"}, kinds)
}
