package routes

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/prometheus/client_golang/prometheus/testutil"
	"github.com/smithersai/smithers/packages/backend/internal/revocation"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/stretchr/testify/require"
)

// Relay-only fixtures model authenticated owner registration explicitly.
func registerTerminalOwnerFixture(sess *terminalSession, ws *websocket.Conn) {
	sess.mu.Lock()
	defer sess.mu.Unlock()
	sess.principal.UserID = 7
	sink := newTerminalSink(ws, 8, time.Second)
	sink.principal = revocation.Principal{UserID: 7}
	sess.sinks[sink] = struct{}{}
}

func TestTerminalOwnerOnlyInput(t *testing.T) {
	ssh := terminalSessionManagerCovNewSSHSession()
	sess := newTerminalSession("owner", &terminalSessionManagerCovSSHClient{}, ssh, ssh.stdin, bytes.NewReader(nil), bytes.NewReader(nil), 512*1024, time.Hour, 0, nil)
	sess.principal = revocation.Principal{UserID: 7}
	metrics := NewSmithersMetrics()
	done := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
		require.NoError(t, err)
		defer ws.CloseNow()
		viewer := int64(8)
		if r.URL.Path == "/owner" {
			viewer = 7
		}
		sink, err := sess.addSink(r.Context(), ws, nil, revocation.Principal{UserID: viewer})
		require.NoError(t, err)
		defer sess.removeSink(sink)
		(&WorkspaceTerminalHandler{Metrics: metrics}).pipeWSToTerminalSession(r.Context(), r.Context(), ws, sess, "owner", func() {})
		done <- struct{}{}
	}))
	defer srv.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	watcher, _, err := websocket.Dial(ctx, "ws"+srv.URL[4:]+"/watch", nil)
	require.NoError(t, err)
	// Drain replay-complete before sending input.
	_, _, err = watcher.Read(ctx)
	require.NoError(t, err)
	for i := 0; i < 1000; i++ {
		require.NoError(t, watcher.Write(ctx, websocket.MessageBinary, []byte("touch forbidden\n")))
	}
	require.NoError(t, watcher.Write(ctx, websocket.MessageText, []byte(`{"type":"resize","rows":40,"cols":100,"owner":7}`)))
	require.NoError(t, watcher.Write(ctx, websocket.MessageText, []byte(`{"type":"close","owner":7}`)))
	require.NoError(t, watcher.Close(websocket.StatusNormalClosure, "done"))
	<-done
	require.Equal(t, float64(1000), testutil.ToFloat64(metrics.TerminalInputDroppedTotal))
	require.Empty(t, ssh.stdin.String())
	require.Zero(t, ssh.windowRows)
	require.False(t, sess.isDead())
	owner, _, err := websocket.Dial(ctx, "ws"+srv.URL[4:]+"/owner", nil)
	require.NoError(t, err)
	_, _, err = owner.Read(ctx)
	require.NoError(t, err)
	for _, input := range []string{"one", "two", "three"} {
		require.NoError(t, owner.Write(ctx, websocket.MessageBinary, []byte(input)))
	}
	require.NoError(t, owner.Write(ctx, websocket.MessageText, []byte(`{"type":"resize","rows":30,"cols":90}`)))
	require.NoError(t, owner.Close(websocket.StatusNormalClosure, "done"))
	<-done
	require.Equal(t, "onetwothree", ssh.stdin.String())
	require.Equal(t, 30, ssh.windowRows)
	require.Equal(t, 90, ssh.windowCols)
}

func TestTerminalInputRequiresRegisteredOwner(t *testing.T) {
	sess := newTerminalSession("s", nil, nil, nil, nil, nil, 512*1024, time.Hour, 0, nil)
	ws := &websocket.Conn{}
	require.False(t, sess.ownsInput(ws))
	registerTerminalOwnerFixture(sess, ws)
	require.True(t, sess.ownsInput(ws))
	sess.mu.Lock()
	sess.dead = true
	sess.mu.Unlock()
	require.False(t, sess.ownsInput(ws))
}

func TestTerminalWatcherRevocationPreservesOwner(t *testing.T) {
	fake := newFakeTerminalSSH()
	manager := NewTerminalSessionManager(func(context.Context, services.WorkspaceSSHConnectionInfo, int32, int32) (terminalSSHClient, terminalSSHSession, error) {
		return fake.client, fake.session, nil
	})
	manager.keepaliveInterval = 0
	defer manager.Close()
	sess, _, err := manager.getOrCreate(context.Background(), "s", services.WorkspaceSSHConnectionInfo{}, 80, 24, revocation.Principal{UserID: 7, RepositoryID: 3})
	require.NoError(t, err)
	ownerServer, ownerClient, ownerCleanup := terminalSessionManagerHWebsocketPair(t)
	defer ownerCleanup()
	watchServer, watchClient, watchCleanup := terminalSessionManagerHWebsocketPair(t)
	defer watchCleanup()
	ownerSink, err := sess.addSink(context.Background(), ownerServer, nil, revocation.Principal{UserID: 7, RepositoryID: 3})
	require.NoError(t, err)
	defer sess.removeSink(ownerSink)
	watchSink, err := sess.addSink(context.Background(), watchServer, nil, revocation.Principal{UserID: 8, RepositoryID: 3})
	require.NoError(t, err)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, _, err = ownerClient.Read(ctx)
	require.NoError(t, err)
	_, _, err = watchClient.Read(ctx)
	require.NoError(t, err)
	revoked := make(chan struct{})
	go func() {
		manager.RevokeMatching(revocation.Event{Kind: revocation.KindCollaboratorRemoved, UserID: 8, RepositoryID: 3})
		close(revoked)
	}()
	_, _, err = watchClient.Read(ctx)
	require.Equal(t, websocket.StatusPolicyViolation, websocket.CloseStatus(err))
	<-revoked
	require.False(t, sess.isDead())
	require.True(t, sess.ownsInput(ownerServer))
	require.False(t, sess.ownsInput(watchServer))
	sess.mu.Lock()
	_, attached := sess.sinks[watchSink]
	sess.mu.Unlock()
	require.False(t, attached)
	_, err = fake.stdoutW.Write([]byte("owner continues"))
	require.NoError(t, err)
	typ, data, err := ownerClient.Read(ctx)
	require.NoError(t, err)
	require.Equal(t, websocket.MessageBinary, typ)
	require.Equal(t, "owner continues", string(data))
}

func TestTerminalOpenFailsClosedWithoutS2Providers(t *testing.T) {
	// The unmounted production handler must not consult the old S1 service,
	// read untrusted owner/session fields, or produce an accepted receipt.
	handler := &WorkspaceTerminalHandler{Service: &mockWorkspaceTerminalService{}}
	for _, body := range []string{`{"open":{"branch":"T1"}}`, `{"open":{"branch":"T1"},"owner":7,"uid":0}`, `{`} {
		recorder := httptest.NewRecorder()
		handler.OpenTerminal(recorder, httptest.NewRequest(http.MethodPost, "/api/terminals", bytes.NewBufferString(body)))
		require.Equal(t, http.StatusServiceUnavailable, recorder.Code)
		require.JSONEq(t, `{"code":"terminal_unavailable","class":"infra","message":"Terminal is unavailable"}`, recorder.Body.String())
	}
}
