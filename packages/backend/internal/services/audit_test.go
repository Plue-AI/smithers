package services

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"strings"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

type mockAuditQuerier struct {
	insertAuditLogFn func(ctx context.Context, arg db.InsertAuditLogParams) error

	lastInsertAuditLogCtx context.Context
	lastInsertAuditLogArg db.InsertAuditLogParams
	insertAuditLogCalls   int
}

func (m *mockAuditQuerier) InsertAuditLog(ctx context.Context, arg db.InsertAuditLogParams) error {
	m.lastInsertAuditLogCtx = ctx
	m.lastInsertAuditLogArg = arg
	m.insertAuditLogCalls++

	if m.insertAuditLogFn != nil {
		return m.insertAuditLogFn(ctx, arg)
	}

	return nil
}

type noopAuditQuerier struct{}

func (noopAuditQuerier) InsertAuditLog(context.Context, db.InsertAuditLogParams) error {
	return nil
}

var auditTestLoggerMu sync.Mutex

type auditOnlyHandler struct {
	next slog.Handler
}

func (h auditOnlyHandler) Enabled(ctx context.Context, level slog.Level) bool {
	return h.next.Enabled(ctx, level)
}

func (h auditOnlyHandler) Handle(ctx context.Context, rec slog.Record) error {
	if !strings.HasPrefix(rec.Message, "audit:") {
		return nil
	}
	return h.next.Handle(ctx, rec)
}

func (h auditOnlyHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	return auditOnlyHandler{next: h.next.WithAttrs(attrs)}
}

func (h auditOnlyHandler) WithGroup(name string) slog.Handler {
	return auditOnlyHandler{next: h.next.WithGroup(name)}
}

func auditInt64Ptr(v int64) *int64 { return &v }

func auditTestEvent(overrides func(*AuditEvent)) AuditEvent {
	event := AuditEvent{
		EventType:  "auth.login",
		ActorID:    auditInt64Ptr(42),
		ActorName:  "alice",
		TargetType: "repository",
		TargetID:   auditInt64Ptr(99),
		TargetName: "demo",
		Action:     "create",
		Metadata: map[string]any{
			"source": "web",
		},
		IPAddress: "203.0.113.10",
	}

	if overrides != nil {
		overrides(&event)
	}

	return event
}

func captureAuditLogs(t *testing.T, fn func()) string {
	t.Helper()

	auditTestLoggerMu.Lock()
	defer auditTestLoggerMu.Unlock()

	prev := slog.Default()
	var buf bytes.Buffer
	handler := auditOnlyHandler{
		next: slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelWarn}),
	}
	slog.SetDefault(slog.New(handler))
	defer slog.SetDefault(prev)

	fn()
	return buf.String()
}

func TestAuditLog_Success(t *testing.T) {
	t.Parallel()

	q := &mockAuditQuerier{}
	svc := NewAuditService(q)
	event := auditTestEvent(nil)

	svc.Log(context.Background(), event)

	require.Equal(t, 1, q.insertAuditLogCalls)
	assert.Equal(t, event.EventType, q.lastInsertAuditLogArg.EventType)
	assert.Equal(t, event.ActorName, q.lastInsertAuditLogArg.ActorName)
	assert.Equal(t, event.TargetType, q.lastInsertAuditLogArg.TargetType)
	assert.Equal(t, event.TargetName, q.lastInsertAuditLogArg.TargetName)
	assert.Equal(t, event.Action, q.lastInsertAuditLogArg.Action)
	assert.Equal(t, event.IPAddress, q.lastInsertAuditLogArg.IpAddress)
	assert.True(t, q.lastInsertAuditLogArg.ActorID.Valid)
	assert.Equal(t, *event.ActorID, q.lastInsertAuditLogArg.ActorID.Int64)
	assert.True(t, q.lastInsertAuditLogArg.TargetID.Valid)
	assert.Equal(t, *event.TargetID, q.lastInsertAuditLogArg.TargetID.Int64)
	assert.JSONEq(t, `{"source":"web"}`, string(q.lastInsertAuditLogArg.Metadata))
}

// The walk's IPv6 laptop signed in with RemoteAddr
// "[2601:646:8f01:c7e0:9cca:85bb:3c8c:afd6]:52345" and the auth.login insert
// failed VARCHAR(45). Every audit row stores the bare client IP.
func TestAuditIPStoresTheClientAddressOnly(t *testing.T) {
	t.Parallel()
	for input, want := range map[string]string{
		"[2601:646:8f01:c7e0:9cca:85bb:3c8c:afd6]:52345":  "2601:646:8f01:c7e0:9cca:85bb:3c8c:afd6",
		"[fe80::1%en0]:4000":                              "fe80::1",
		"fe80::1%en0":                                     "fe80::1",
		"[::ffff:10.0.0.5]:4000":                          "10.0.0.5",
		"[ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff]:65535": "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
		"203.0.113.10:5555":                               "203.0.113.10",
		"203.0.113.10":                                    "203.0.113.10",
		"2001:db8::1":                                     "2001:db8::1",
		"":                                                "",
		"unknown":                                         "",
		"mini.local:4000":                                 "",
	} {
		got := AuditIP(input)
		assert.Equal(t, want, got, input)
		assert.LessOrEqual(t, len(got), 45, input)
	}

	q := &mockAuditQuerier{}
	NewAuditService(q).Log(context.Background(), auditTestEvent(func(event *AuditEvent) {
		event.IPAddress = "[2601:646:8f01:c7e0:9cca:85bb:3c8c:afd6]:52345"
	}))
	require.Equal(t, 1, q.insertAuditLogCalls)
	assert.Equal(t, "2601:646:8f01:c7e0:9cca:85bb:3c8c:afd6", q.lastInsertAuditLogArg.IpAddress)

	ctx := ContextWithAdminAuditActor(context.Background(), AdminAuditActor{UserID: 1, Username: "will", IPAddress: "[::1]:61000"})
	actor, ok := AdminAuditActorFromContext(ctx)
	require.True(t, ok)
	assert.Equal(t, "::1", actor.IPAddress)
}

func TestAuditLog_Format(t *testing.T) {
	t.Parallel()

	q := &mockAuditQuerier{}
	svc := NewAuditService(q)
	event := auditTestEvent(func(event *AuditEvent) {
		event.EventType = "oauth2.application.create"
		event.ActorID = auditInt64Ptr(7)
		event.ActorName = "builder"
		event.TargetType = "oauth2_application"
		event.TargetID = auditInt64Ptr(314)
		event.TargetName = "deploy-bot"
		event.Action = "create"
		event.Metadata = map[string]any{
			"auth": map[string]any{
				"interactive": false,
				"method":      "key",
			},
			"scopes": []string{"repo:read", "repo:write"},
		}
		event.IPAddress = "2001:db8::1"
	})

	svc.Log(context.Background(), event)

	require.Equal(t, 1, q.insertAuditLogCalls)
	assert.Equal(t, db.InsertAuditLogParams{
		EventType:  "oauth2.application.create",
		ActorID:    pgtype.Int8{Int64: 7, Valid: true},
		ActorName:  "builder",
		TargetType: "oauth2_application",
		TargetID:   pgtype.Int8{Int64: 314, Valid: true},
		TargetName: "deploy-bot",
		Action:     "create",
		Metadata:   json.RawMessage(`{"auth":{"interactive":false,"method":"key"},"scopes":["repo:read","repo:write"]}`),
		IpAddress:  "2001:db8::1",
	}, q.lastInsertAuditLogArg)
}

func TestAuditLog_WithMetadata(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name     string
		metadata map[string]any
		expected string
	}{
		{
			name: "flat metadata",
			metadata: map[string]any{
				"source": "ssh",
				"count":  2,
			},
			expected: `{"source":"ssh","count":2}`,
		},
		{
			name: "nested metadata",
			metadata: map[string]any{
				"scopes": []string{"repo:read", "repo:write"},
				"actor": map[string]any{
					"type": "user",
				},
			},
			expected: `{"scopes":["repo:read","repo:write"],"actor":{"type":"user"}}`,
		},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			q := &mockAuditQuerier{}
			svc := NewAuditService(q)
			event := auditTestEvent(func(event *AuditEvent) {
				event.Metadata = tc.metadata
			})

			svc.Log(context.Background(), event)

			require.Equal(t, 1, q.insertAuditLogCalls)
			assert.JSONEq(t, tc.expected, string(q.lastInsertAuditLogArg.Metadata))
		})
	}
}

func TestAuditLog_NilMetadata(t *testing.T) {
	t.Parallel()

	q := &mockAuditQuerier{}
	svc := NewAuditService(q)
	event := auditTestEvent(func(event *AuditEvent) {
		event.Metadata = nil
	})

	svc.Log(context.Background(), event)

	require.Equal(t, 1, q.insertAuditLogCalls)
	assert.JSONEq(t, "null", string(q.lastInsertAuditLogArg.Metadata))
}

func TestAuditLog_NilActor(t *testing.T) {
	t.Parallel()

	q := &mockAuditQuerier{}
	svc := NewAuditService(q)
	event := auditTestEvent(func(event *AuditEvent) {
		event.EventType = "system.maintenance"
		event.ActorID = nil
		event.ActorName = ""
		event.TargetType = "repository"
		event.TargetID = auditInt64Ptr(77)
		event.TargetName = "ops/demo"
		event.Action = "sync"
		event.Metadata = map[string]any{"initiator": "system"}
		event.IPAddress = ""
	})

	require.NotPanics(t, func() {
		svc.Log(context.Background(), event)
	})

	require.Equal(t, 1, q.insertAuditLogCalls)
	assert.Equal(t, event.EventType, q.lastInsertAuditLogArg.EventType)
	assert.False(t, q.lastInsertAuditLogArg.ActorID.Valid)
	assert.Zero(t, q.lastInsertAuditLogArg.ActorID.Int64)
	assert.Empty(t, q.lastInsertAuditLogArg.ActorName)
	assert.True(t, q.lastInsertAuditLogArg.TargetID.Valid)
	assert.Equal(t, int64(77), q.lastInsertAuditLogArg.TargetID.Int64)
	assert.Equal(t, "ops/demo", q.lastInsertAuditLogArg.TargetName)
	assert.Equal(t, "sync", q.lastInsertAuditLogArg.Action)
	assert.JSONEq(t, `{"initiator":"system"}`, string(q.lastInsertAuditLogArg.Metadata))
	assert.Empty(t, q.lastInsertAuditLogArg.IpAddress)
}

func TestAuditLog_EmptyMetadata(t *testing.T) {
	t.Parallel()

	q := &mockAuditQuerier{}
	svc := NewAuditService(q)
	event := auditTestEvent(func(event *AuditEvent) {
		event.Metadata = map[string]any{}
	})

	svc.Log(context.Background(), event)

	require.Equal(t, 1, q.insertAuditLogCalls)
	assert.JSONEq(t, "{}", string(q.lastInsertAuditLogArg.Metadata))
}

func TestAuditLog_MetadataMarshalFailure(t *testing.T) {
	q := &mockAuditQuerier{}
	svc := NewAuditService(q)
	event := auditTestEvent(func(event *AuditEvent) {
		event.Metadata = map[string]any{"bad": make(chan int)}
	})

	var logs string
	require.NotPanics(t, func() {
		logs = captureAuditLogs(t, func() {
			svc.Log(context.Background(), event)
		})
	})

	require.Equal(t, 1, q.insertAuditLogCalls)
	assert.JSONEq(t, "{}", string(q.lastInsertAuditLogArg.Metadata))
	assert.Contains(t, logs, "audit: failed to marshal metadata")
}

func TestAuditLog_InsertFailure(t *testing.T) {
	dbErr := errors.New("insert failed")
	q := &mockAuditQuerier{
		insertAuditLogFn: func(ctx context.Context, arg db.InsertAuditLogParams) error {
			return dbErr
		},
	}
	svc := NewAuditService(q)

	var logs string
	require.NotPanics(t, func() {
		logs = captureAuditLogs(t, func() {
			svc.Log(context.Background(), auditTestEvent(nil))
		})
	})

	require.Equal(t, 1, q.insertAuditLogCalls)
	assert.Contains(t, logs, "audit: failed to insert audit log")
	assert.Contains(t, logs, "insert failed")
}

func TestAuditLog_CancelledContext(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	q := &mockAuditQuerier{
		insertAuditLogFn: func(ctx context.Context, arg db.InsertAuditLogParams) error {
			return ctx.Err()
		},
	}
	svc := NewAuditService(q)

	var logs string
	require.NotPanics(t, func() {
		logs = captureAuditLogs(t, func() {
			svc.Log(ctx, auditTestEvent(nil))
		})
	})

	require.Equal(t, 1, q.insertAuditLogCalls)
	assert.Same(t, ctx, q.lastInsertAuditLogCtx)
	assert.ErrorIs(t, q.lastInsertAuditLogCtx.Err(), context.Canceled)
	assert.Contains(t, logs, "audit: failed to insert audit log")
	assert.Contains(t, logs, context.Canceled.Error())
}

func TestAuditLog_NullableFields(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name          string
		actorID       *int64
		targetID      *int64
		ipAddress     string
		wantActorID   bool
		wantTargetID  bool
		wantTargetVal int64
	}{
		{
			name:         "omits nullable ids when zero values are used",
			actorID:      nil,
			targetID:     nil,
			ipAddress:    "",
			wantActorID:  false,
			wantTargetID: false,
		},
		{
			name:          "preserves explicit zero id when provided",
			actorID:       auditInt64Ptr(0),
			targetID:      auditInt64Ptr(0),
			ipAddress:     "",
			wantActorID:   true,
			wantTargetID:  true,
			wantTargetVal: 0,
		},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			q := &mockAuditQuerier{}
			svc := NewAuditService(q)
			event := auditTestEvent(func(event *AuditEvent) {
				event.ActorID = tc.actorID
				event.TargetID = tc.targetID
				event.IPAddress = tc.ipAddress
			})

			svc.Log(context.Background(), event)

			require.Equal(t, 1, q.insertAuditLogCalls)
			assert.Equal(t, tc.wantActorID, q.lastInsertAuditLogArg.ActorID.Valid)
			assert.Equal(t, tc.wantTargetID, q.lastInsertAuditLogArg.TargetID.Valid)
			assert.Equal(t, tc.wantTargetVal, q.lastInsertAuditLogArg.TargetID.Int64)
			assert.Equal(t, tc.ipAddress, q.lastInsertAuditLogArg.IpAddress)
		})
	}
}

func TestAuditLog_AllEventTypes(t *testing.T) {
	t.Parallel()

	// Exercise the known event/action strings currently passed through the audit service unchanged.
	tests := []struct {
		name      string
		eventType string
		action    string
	}{
		{name: "auth.login", eventType: "auth.login", action: "login"},
		{name: "auth.logout", eventType: "auth.logout", action: "logout"},
		{name: "oauth2.application.create", eventType: "oauth2.application.create", action: "create"},
		{name: "oauth2.application.delete", eventType: "oauth2.application.delete", action: "delete"},
		{name: "org.create", eventType: "org.create", action: "create"},
		{name: "org.member_add", eventType: "org.member_add", action: "add"},
		{name: "org.member_remove", eventType: "org.member_remove", action: "remove"},
		{name: "repo.archive", eventType: "repo.archive", action: "archive"},
		{name: "repo.create", eventType: "repo.create", action: "create"},
		{name: "repo.delete", eventType: "repo.delete", action: "delete"},
		{name: "repo.fork", eventType: "repo.fork", action: "fork"},
		{name: "repo.transfer", eventType: "repo.transfer", action: "transfer"},
		{name: "repo.unarchive", eventType: "repo.unarchive", action: "unarchive"},
		{name: "ssh.auth.success", eventType: "ssh.auth", action: "success"},
		{name: "ssh.auth.failure", eventType: "ssh.auth", action: "failure"},
		{name: "ssh.fetch", eventType: "ssh.fetch", action: "success"},
		{name: "ssh.push", eventType: "ssh.push", action: "success"},
		{name: "ssh_key.create", eventType: "ssh_key.create", action: "create"},
		{name: "ssh_key.delete", eventType: "ssh_key.delete", action: "delete"},
		{name: "token.create", eventType: "token.create", action: "create"},
		{name: "token.delete", eventType: "token.delete", action: "delete"},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			q := &mockAuditQuerier{}
			svc := NewAuditService(q)
			event := auditTestEvent(func(event *AuditEvent) {
				event.EventType = tc.eventType
				event.Action = tc.action
			})

			svc.Log(context.Background(), event)

			require.Equal(t, 1, q.insertAuditLogCalls)
			assert.Equal(t, tc.eventType, q.lastInsertAuditLogArg.EventType)
			assert.Equal(t, tc.action, q.lastInsertAuditLogArg.Action)
		})
	}
}

func BenchmarkAuditEvent_HighVolume(b *testing.B) {
	svc := NewAuditService(noopAuditQuerier{})
	ctx := context.Background()
	event := auditTestEvent(func(event *AuditEvent) {
		event.EventType = "ssh.push"
		event.Action = "success"
		event.Metadata = map[string]any{
			"duration_ms": 42,
			"git_command": "git-receive-pack",
			"session_id":  "bench-session",
		}
	})

	b.ReportAllocs()
	b.ResetTimer()
	b.RunParallel(func(pb *testing.PB) {
		for pb.Next() {
			svc.Log(ctx, event)
		}
	})
}
