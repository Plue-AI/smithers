package routes

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/revocation"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/internal/sse"
)

func TestTerminalSessionManager_RevokeMatchingDestroysOnlyAffectedSessions(t *testing.T) {
	fake := newFakeTerminalSSH()
	manager := NewTerminalSessionManager(func(context.Context, services.WorkspaceSSHConnectionInfo, int32, int32) (terminalSSHClient, terminalSSHSession, error) {
		return fake.client, fake.session, nil
	})
	manager.idleTimeout = time.Minute
	manager.keepaliveInterval = 0
	defer manager.Close()
	sess, created, err := manager.getOrCreate(context.Background(), "sess-1", services.WorkspaceSSHConnectionInfo{WorkspaceID: "w1", VMID: "vm1"}, 80, 24, revocation.Principal{})
	require.NoError(t, err)
	require.True(t, created)
	sess.setPrincipal(revocation.Principal{UserID: 7, RepositoryID: 3, WorkspaceID: "w1", SandboxID: "vm1"})

	manager.RevokeMatching(revocation.Event{Kind: revocation.KindWorkspaceShareRemoved, UserID: 8, WorkspaceID: "w1"})
	require.False(t, sess.isDead(), "another user's share removal must not end this user's session")

	started := time.Now()
	manager.RevokeMatching(revocation.Event{Kind: revocation.KindWorkspaceShareRemoved, UserID: 7, WorkspaceID: "w1", Reason: "share removed"})
	require.True(t, sess.isDead())
	require.Less(t, time.Since(started), 5*time.Second)
	require.Contains(t, sess.deadErr().Error(), "access revoked: share removed")

	// A terminal on an organization repository carries the organization, so
	// removing the member from the organization ends it; other users and other
	// organizations leave it alone.
	orgFake := newFakeTerminalSSH()
	orgManager := NewTerminalSessionManager(func(context.Context, services.WorkspaceSSHConnectionInfo, int32, int32) (terminalSSHClient, terminalSSHSession, error) {
		return orgFake.client, orgFake.session, nil
	})
	orgManager.idleTimeout = time.Minute
	orgManager.keepaliveInterval = 0
	defer orgManager.Close()
	orgSess, created, err := orgManager.getOrCreate(context.Background(), "sess-org", services.WorkspaceSSHConnectionInfo{WorkspaceID: "w2", VMID: "vm2"}, 80, 24, revocation.Principal{})
	require.NoError(t, err)
	require.True(t, created)
	orgRequest := withOrgRepoCtx(newAuthedRequest(t, 7, ""), 4, 11)
	orgSess.setPrincipal(requestPrincipal(orgRequest, revocation.Principal{RepositoryID: 4, WorkspaceID: "w2", SandboxID: "vm2"}))

	orgManager.RevokeMatching(revocation.Event{Kind: revocation.KindOrgMemberRemoved, UserID: 8, OrganizationID: 11})
	require.False(t, orgSess.isDead(), "another member's removal must not end this user's session")
	orgManager.RevokeMatching(revocation.Event{Kind: revocation.KindOrgMemberRemoved, UserID: 7, OrganizationID: 12})
	require.False(t, orgSess.isDead(), "removal from another organization must not end this session")

	started = time.Now()
	orgManager.RevokeMatching(revocation.Event{Kind: revocation.KindOrgMemberRemoved, UserID: 7, OrganizationID: 11, Reason: "removed from organization acme"})
	require.True(t, orgSess.isDead(), "org_member_removed must end the member's terminal on the organization's repository")
	require.Less(t, time.Since(started), 5*time.Second)
	require.Contains(t, orgSess.deadErr().Error(), "access revoked: removed from organization acme")
}

func TestTerminalSessionManager_RevokeMatchingClosesAttachedSinkWithPolicyViolation(t *testing.T) {
	fake := newFakeTerminalSSH()
	manager := NewTerminalSessionManager(func(context.Context, services.WorkspaceSSHConnectionInfo, int32, int32) (terminalSSHClient, terminalSSHSession, error) {
		return fake.client, fake.session, nil
	})
	manager.idleTimeout = time.Minute
	manager.keepaliveInterval = 0
	defer manager.Close()

	sess, _, err := manager.getOrCreate(context.Background(), "sess-revoked", services.WorkspaceSSHConnectionInfo{}, 80, 24, revocation.Principal{})
	require.NoError(t, err)
	sess.setPrincipal(revocation.Principal{TokenHash: "token-hash"})

	serverWS, clientWS, cleanup := terminalSessionManagerHWebsocketPair(t)
	defer cleanup()
	sink, err := sess.addSink(context.Background(), serverWS, nil)
	require.NoError(t, err)
	defer sess.removeSink(sink)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, _, err = clientWS.Read(ctx)
	require.NoError(t, err) // replay-complete

	revoked := make(chan struct{})
	go func() {
		manager.RevokeMatching(revocation.Event{
			Kind:      revocation.KindTokenRevoked,
			TokenHash: "token-hash",
			Reason:    "token deleted",
		})
		close(revoked)
	}()

	_, _, err = clientWS.Read(ctx)
	var closeErr websocket.CloseError
	require.ErrorAs(t, err, &closeErr)
	require.Equal(t, websocket.StatusPolicyViolation, closeErr.Code)
	require.Equal(t, "access revoked: token deleted", closeErr.Reason)
	select {
	case <-revoked:
	case <-ctx.Done():
		t.Fatal("revocation teardown did not complete")
	}
}

func TestRelayConnRegistry_ClosesConnectionsTheEventRevokes(t *testing.T) {
	registry := &relayConnRegistry{conns: map[net.Conn]revocation.Principal{}}
	upstreamA, clientA := net.Pipe()
	upstreamB, clientB := net.Pipe()
	defer clientA.Close()
	defer clientB.Close()
	trackedA := registry.track(upstreamA, revocation.Principal{WorkspaceID: "w1", UserID: 1, RepositoryID: 9})
	trackedB := registry.track(upstreamB, revocation.Principal{WorkspaceID: "w2", UserID: 2, RepositoryID: 9})
	require.Equal(t, 2, registry.count())

	registry.handle(revocation.Event{Kind: revocation.KindWorkspaceShareRemoved, WorkspaceID: "w1"})
	require.Equal(t, 1, registry.count())
	readErr := make(chan error, 1)
	go func() {
		_, err := clientA.Read(make([]byte, 1))
		readErr <- err
	}()
	select {
	case err := <-readErr:
		require.Error(t, err, "client side must observe the close")
	case <-time.After(2 * time.Second):
		t.Fatal("revoked relay connection stayed open")
	}
	// The untouched connection still carries traffic.
	go func() { _, _ = trackedB.Write([]byte("x")) }()
	buf := make([]byte, 1)
	_ = clientB.SetReadDeadline(time.Now().Add(time.Second))
	n, err := clientB.Read(buf)
	require.NoError(t, err)
	require.Equal(t, 1, n)
	_ = trackedA.Close() // idempotent after handle already closed it
	_ = trackedB.Close()
	require.Equal(t, 0, registry.count())
}

func TestRequestPrincipal_MergesCallerWithResource(t *testing.T) {
	principal := requestPrincipal(newAuthedRequest(t, 42, "hash-42"), revocation.Principal{RepositoryID: 5, WorkspaceID: "w"})
	require.Equal(t, int64(42), principal.UserID)
	require.Equal(t, "hash-42", principal.TokenHash)
	require.Equal(t, int64(5), principal.RepositoryID)
	require.Equal(t, "w", principal.WorkspaceID)
}

func TestRequestPrincipal_CarriesRepositoryOrganization(t *testing.T) {
	t.Run("organization repository sets OrganizationID", func(t *testing.T) {
		req := withOrgRepoCtx(newAuthedRequest(t, 42, "hash-42"), 5, 77)
		principal := requestPrincipal(req, revocation.Principal{RepositoryID: 5})
		require.Equal(t, int64(42), principal.UserID)
		require.Equal(t, "hash-42", principal.TokenHash)
		require.Equal(t, int64(5), principal.RepositoryID)
		require.Equal(t, int64(77), principal.OrganizationID, "a stream on an organization repository must carry the organization so org_member_removed matches it")
	})
	t.Run("user repository leaves OrganizationID zero", func(t *testing.T) {
		req := withRepoCtx(newAuthedRequest(t, 42, ""), 5, "alice", "demo")
		principal := requestPrincipal(req, revocation.Principal{RepositoryID: 5})
		require.Equal(t, int64(42), principal.UserID)
		require.Zero(t, principal.OrganizationID)
	})
	t.Run("no repository context leaves OrganizationID zero", func(t *testing.T) {
		principal := requestPrincipal(newAuthedRequest(t, 42, ""), revocation.Principal{})
		require.Zero(t, principal.OrganizationID)
	})
	t.Run("invalid OrgID is ignored", func(t *testing.T) {
		req := withOrgRepoCtx(newAuthedRequest(t, 42, ""), 5, 77)
		middleware.RepoFromContext(req.Context()).OrgID.Valid = false
		principal := requestPrincipal(req, revocation.Principal{RepositoryID: 5})
		require.Zero(t, principal.OrganizationID)
	})
	t.Run("explicit OrganizationID is not overwritten", func(t *testing.T) {
		req := withOrgRepoCtx(newAuthedRequest(t, 42, ""), 5, 77)
		principal := requestPrincipal(req, revocation.Principal{RepositoryID: 5, OrganizationID: 99})
		require.Equal(t, int64(99), principal.OrganizationID)
	})
}

// TestRepositoryStreamPrincipal_EndsOnOrgMemberRemoved wires a repository SSE
// stream's principal to a real revocation bus and delivers the event the
// organization service publishes when a member is removed. The watch must fire
// for the removed member on that organization's repository and stay quiet for
// other members and other organizations.
func TestRepositoryStreamPrincipal_EndsOnOrgMemberRemoved(t *testing.T) {
	bus := revocation.NewBus(nil, nil)
	previous := currentRevocationSource()
	SetRevocationSource(bus)
	t.Cleanup(func() { SetRevocationSource(previous) })

	const (
		memberID = int64(42)
		repoID   = int64(5)
		orgID    = int64(77)
	)
	req := withOrgRepoCtx(newAuthedRequest(t, memberID, ""), repoID, orgID)
	cfg := sse.BrokerStreamConfig{UserID: memberID}
	attachRevocation(&cfg, req, revocation.Principal{RepositoryID: repoID})
	require.NotNil(t, cfg.Revocations, "attachRevocation must install the process-wide source")

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	revoked := cfg.Revocations.Watch(ctx, cfg.Principal)

	bus.Deliver(revocation.Event{Kind: revocation.KindOrgMemberRemoved, UserID: 43, OrganizationID: orgID, Reason: "another member"})
	bus.Deliver(revocation.Event{Kind: revocation.KindOrgMemberRemoved, UserID: memberID, OrganizationID: orgID + 1, Reason: "another organization"})
	select {
	case ev := <-revoked:
		t.Fatalf("stream ended on an unrelated removal: %+v", ev)
	case <-time.After(200 * time.Millisecond):
	}

	bus.Deliver(revocation.Event{Kind: revocation.KindOrgMemberRemoved, UserID: memberID, OrganizationID: orgID, Reason: "removed from organization acme"})
	select {
	case ev := <-revoked:
		require.Equal(t, revocation.KindOrgMemberRemoved, ev.Kind)
		require.Equal(t, "removed from organization acme", ev.Reason)
	case <-time.After(5 * time.Second):
		t.Fatal("repository stream principal did not match org_member_removed within 5s: the removed member keeps the stream")
	}
}

// withOrgRepoCtx loads an organization-owned repository into the request the
// way LoadRepoContext does.
func withOrgRepoCtx(req *http.Request, repoID, orgID int64) *http.Request {
	repository := &db.Repository{ID: repoID, Name: "demo", LowerName: "demo", OrgID: pgtype.Int8{Int64: orgID, Valid: true}}
	ctx := middleware.ContextWithRepoContext(req.Context(), &middleware.RepoContext{
		Owner:      "acme",
		Repository: repository,
	}, middleware.PermissionRead)
	return req.WithContext(ctx)
}

func newAuthedRequest(t *testing.T, userID int64, tokenHash string) *http.Request {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	return req.WithContext(middleware.ContextWithAuthInfo(req.Context(), &middleware.AuthInfo{
		User:        &db.User{ID: userID},
		IsTokenAuth: tokenHash != "",
		TokenHash:   tokenHash,
	}))
}
