package services

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

type fakeStatusPinger struct{ err error }

func (f fakeStatusPinger) Ping(context.Context) error { return f.err }

type fakeStatusRuntime struct {
	active, landing      int64
	oldest               float64
	activeErr, oldestErr error
	landingErr           error
}

func (f fakeStatusRuntime) CountActiveAgentSessions(context.Context) (int64, error) {
	return f.active, f.activeErr
}

func (f fakeStatusRuntime) GetActiveAgentSessionOldestAgeSeconds(context.Context) (float64, error) {
	return f.oldest, f.oldestErr
}

func (f fakeStatusRuntime) GetLandingQueueDepth(context.Context) (int64, error) {
	return f.landing, f.landingErr
}

func (f fakeStatusRuntime) GetCodeSearchBacklog(context.Context) (db.GetCodeSearchBacklogRow, error) {
	return db.GetCodeSearchBacklogRow{}, nil
}

type fakeStatusSSE int

func (f fakeStatusSSE) ActiveConnections() int { return int(f) }

var statusClock = func() time.Time { return time.Date(2026, 9, 25, 12, 0, 0, 0, time.FixedZone("x", 3600)) }

func TestAdminSystemStatusHealthy(t *testing.T) {
	got := NewAdminSystemStatusService(AdminSystemStatusServiceConfig{
		DB:      fakeStatusPinger{},
		Runtime: fakeStatusRuntime{active: 3, oldest: 120.5, landing: 9},
		SSE:     fakeStatusSSE(42),
		Clock:   statusClock,
	}).SystemStatus(context.Background())

	assert.Equal(t, "ok", got.Status)
	assert.Equal(t, time.Date(2026, 9, 25, 11, 0, 0, 0, time.UTC), got.GeneratedAt)
	assert.Equal(t, "ok", got.Database.Status)
	assert.Empty(t, got.Database.Error)
	assert.Equal(t, 9, got.Queues.Landing.Depth)
	assert.Equal(t, 42, got.Connections.SSE)
	assert.Equal(t, AdminSystemStatusAgentSessions{Active: 3, OldestAgeSeconds: 120.5}, got.AgentSessions)
	assert.Empty(t, got.Errors)
}

func TestAdminSystemStatusWireShape(t *testing.T) {
	got := NewAdminSystemStatusService(AdminSystemStatusServiceConfig{
		DB: fakeStatusPinger{}, Runtime: fakeStatusRuntime{}, SSE: fakeStatusSSE(0), Clock: statusClock,
	}).SystemStatus(context.Background())
	raw, err := json.Marshal(got)
	require.NoError(t, err)
	var body map[string]any
	require.NoError(t, json.Unmarshal(raw, &body))

	keys := make([]string, 0, len(body))
	for key := range body {
		keys = append(keys, key)
	}
	assert.ElementsMatch(t, []string{"status", "generated_at", "database", "queues", "connections", "agent_sessions"}, keys)
	assert.Equal(t, map[string]any{"landing": map[string]any{"depth": float64(0)}}, body["queues"])
	assert.Equal(t, map[string]any{"sse": float64(0)}, body["connections"])
	assert.Equal(t, map[string]any{"active": float64(0), "oldest_age_seconds": float64(0)}, body["agent_sessions"])
	assert.NotContains(t, body["database"], "error")
}

func TestAdminSystemStatusDatabaseFailureDegrades(t *testing.T) {
	got := NewAdminSystemStatusService(AdminSystemStatusServiceConfig{
		DB: fakeStatusPinger{err: errors.New("connection refused")}, Runtime: fakeStatusRuntime{landing: 2},
	}).SystemStatus(context.Background())

	assert.Equal(t, "degraded", got.Status)
	assert.Equal(t, "error", got.Database.Status)
	assert.Equal(t, "connection refused", got.Database.Error)
	assert.Equal(t, 2, got.Queues.Landing.Depth)
}

func TestAdminSystemStatusMissingDatabaseDegrades(t *testing.T) {
	got := NewAdminSystemStatusService(AdminSystemStatusServiceConfig{}).SystemStatus(context.Background())

	assert.Equal(t, "degraded", got.Status)
	assert.Equal(t, AdminSystemStatusDatabase{Status: "error", Error: "database checker not configured"}, got.Database)
	assert.Empty(t, got.Errors)
}

func TestAdminSystemStatusSectionFailures(t *testing.T) {
	boom := errors.New("boom")
	for _, tc := range []struct {
		name    string
		runtime fakeStatusRuntime
		want    []string
		check   func(*testing.T, AdminSystemStatus)
	}{
		{
			name:    "landing",
			runtime: fakeStatusRuntime{landingErr: boom, active: 1, oldest: 5},
			want:    []string{"landing: boom"},
			check: func(t *testing.T, got AdminSystemStatus) {
				assert.Zero(t, got.Queues.Landing.Depth)
				assert.Equal(t, 1, got.AgentSessions.Active)
			},
		},
		{
			name:    "active sessions",
			runtime: fakeStatusRuntime{activeErr: boom, oldest: 5, landing: 4},
			want:    []string{"agent_sessions: boom"},
			check: func(t *testing.T, got AdminSystemStatus) {
				assert.Zero(t, got.AgentSessions)
				assert.Equal(t, 4, got.Queues.Landing.Depth)
			},
		},
		{
			name:    "oldest session",
			runtime: fakeStatusRuntime{active: 2, oldestErr: boom},
			want:    []string{"agent_sessions: boom"},
			check: func(t *testing.T, got AdminSystemStatus) {
				assert.Zero(t, got.AgentSessions)
			},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := NewAdminSystemStatusService(AdminSystemStatusServiceConfig{
				DB: fakeStatusPinger{}, Runtime: tc.runtime, SSE: fakeStatusSSE(7),
			}).SystemStatus(context.Background())

			assert.Equal(t, "degraded", got.Status)
			assert.Equal(t, "ok", got.Database.Status)
			assert.Equal(t, tc.want, got.Errors)
			assert.Equal(t, 7, got.Connections.SSE)
			tc.check(t, got)
		})
	}
}

func TestAdminSystemStatusOptionalSourcesReportZero(t *testing.T) {
	got := NewAdminSystemStatusService(AdminSystemStatusServiceConfig{DB: fakeStatusPinger{}}).SystemStatus(context.Background())

	assert.Equal(t, "ok", got.Status)
	assert.Zero(t, got.Queues)
	assert.Zero(t, got.Connections)
	assert.Zero(t, got.AgentSessions)
	assert.False(t, got.GeneratedAt.IsZero())
}
