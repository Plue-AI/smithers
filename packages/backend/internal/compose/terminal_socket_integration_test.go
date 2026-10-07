package compose

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/revocation"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
)

type terminalBrokerFixture struct {
	*installOwnerTerminals
	terminal *echoOwnerTerminal
	ready    *atomic.Bool
}

func (p terminalBrokerFixture) Open(context.Context, string, revocation.Principal) (workspaceapi.Terminal, error) {
	return p.terminal, nil
}

type echoOwnerTerminal struct {
	reader  *io.PipeReader
	writer  *io.PipeWriter
	mu      sync.Mutex
	input   bytes.Buffer
	resizes int
}

func (p *echoOwnerTerminal) Read(b []byte) (int, error) { return p.reader.Read(b) }
func (p *echoOwnerTerminal) Write(b []byte) (int, error) {
	p.mu.Lock()
	p.input.Write(b)
	p.mu.Unlock()
	return p.writer.Write(b)
}
func (p *echoOwnerTerminal) Close() error { _ = p.writer.Close(); return p.reader.Close() }
func (p *echoOwnerTerminal) Resize(context.Context, uint16, uint16) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.resizes++
	return nil
}

func TestOwnerTerminalComposedOpenWatchReplayClose(t *testing.T) {
	f := presenceInstall(t)
	q := db.New(f.pool)
	alice, err := q.CreateUser(t.Context(), db.CreateUserParams{Username: "alice", LowerUsername: "alice"})
	require.NoError(t, err)
	_, err = f.pool.Exec(t.Context(), `INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,'write')`, f.row.RepositoryID, alice.ID)
	require.NoError(t, err)
	sum := sha256.Sum256([]byte("alice-terminal-cookie"))
	_, err = q.CreateAuthSession(t.Context(), db.CreateAuthSessionParams{UserID: alice.ID, Username: alice.Username, SessionKey: hex.EncodeToString(sum[:]), ExpiresAt: time.Now().Add(time.Hour)})
	require.NoError(t, err)
	reader, writer := io.Pipe()
	terminal := &echoOwnerTerminal{reader: reader, writer: writer}
	ready := new(atomic.Bool)
	ready.Store(true)
	handler := &routes.WorkspaceTerminalHandler{OwnerOnly: true, AllowedOrigins: []string{f.origin}, SessionCookieName: "session", OwnerTerminals: terminalBrokerFixture{&installOwnerTerminals{queries: q, branches: f.p.branches}, terminal, ready}}
	manager := handler.SharedTerminalSessions()
	defer manager.Close()
	f.p.terminals = manager
	server := httptest.NewUnstartedServer(nil)
	f.origin = "http://" + server.Listener.Addr().String()
	handler.AllowedOrigins = []string{f.origin}
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Auth.SessionCookieName = "session"
	cfg.Server.PublicURL = f.origin
	cfg.Server.AllowedOrigins = []string{f.origin}
	server.Config.Handler = hostStatusProductionRouter(cfg, q, nil, conformanceServices{pool: f.pool, terminal: handler})
	server.Start()
	defer server.Close()
	post := func(body string) (int, []byte) {
		req, err := http.NewRequest(http.MethodPost, server.URL+"/api/terminals", strings.NewReader(body))
		require.NoError(t, err)
		req.Header.Set("Origin", f.origin)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-CSRF-Token", "csrf")
		req.Header.Set("Cookie", "session="+f.cookie+"; __csrf=csrf")
		response, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		defer response.Body.Close()
		raw, err := io.ReadAll(response.Body)
		require.NoError(t, err)
		return response.StatusCode, raw
	}
	status, body := post(fmt.Sprintf(`{"branch":%q,"owner":%d,"uid":0}`, f.row.ID, alice.ID))
	require.Equal(t, 400, status, string(body))
	status, body = post(fmt.Sprintf(`{"branch":%q}`, f.row.ID))
	require.Equal(t, 201, status, string(body))
	var opened struct{ ID string }
	require.NoError(t, json.Unmarshal(body, &opened))
	require.NotEmpty(t, opened.ID)
	require.True(t, manager.OwnsSubject(f.user.ID, f.row.RepositoryID, f.row.ID, opened.ID))
	require.False(t, manager.OwnsSubject(alice.ID, f.row.RepositoryID, f.row.ID, opened.ID))
	var count int
	require.NoError(t, f.pool.QueryRow(t.Context(), `SELECT count(*) FROM workspace_sessions`).Scan(&count))
	require.Zero(t, count)
	dial := func(cookie string) *websocket.Conn {
		ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
		defer cancel()
		socket, response, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(server.URL, "http")+"/api/repos/presence-owner/app/workspace/sessions/"+opened.ID+"/terminal", &websocket.DialOptions{Subprotocols: []string{"terminal"}, HTTPHeader: http.Header{"Origin": {f.origin}, "Cookie": {"session=" + cookie}}})
		if err != nil {
			if response != nil {
				raw, _ := io.ReadAll(response.Body)
				t.Fatalf("socket: %v: %s", err, raw)
			}
			require.NoError(t, err)
		}
		t.Cleanup(func() { socket.CloseNow() })
		return socket
	}
	ready.Store(false)
	refused, response, err := websocket.Dial(t.Context(), "ws"+strings.TrimPrefix(server.URL, "http")+"/api/repos/presence-owner/app/workspace/sessions/"+opened.ID+"/terminal", &websocket.DialOptions{Subprotocols: []string{"terminal"}, HTTPHeader: http.Header{"Origin": {f.origin}, "Cookie": {"session=" + f.cookie}}})
	require.Error(t, err)
	require.Nil(t, refused)
	require.Equal(t, 503, response.StatusCode)
	ready.Store(true)
	owner, watcher := dial(f.cookie), dial("alice-terminal-cookie")
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	_, _, err = owner.Read(ctx)
	require.NoError(t, err)
	_, _, err = watcher.Read(ctx)
	require.NoError(t, err)
	require.NoError(t, watcher.Write(ctx, websocket.MessageBinary, []byte("forbidden")))
	require.NoError(t, watcher.Write(ctx, websocket.MessageText, []byte(`{"type":"resize","rows":40,"cols":100}`)))
	require.NoError(t, watcher.Write(ctx, websocket.MessageText, []byte(`{"type":"close"}`)))
	require.NoError(t, owner.Write(ctx, websocket.MessageBinary, []byte("owner echo")))
	_, output, err := watcher.Read(ctx)
	require.NoError(t, err)
	require.Equal(t, "owner echo", string(output))
	_, _, err = owner.Read(ctx)
	require.NoError(t, err)
	terminal.mu.Lock()
	require.Equal(t, "owner echo", terminal.input.String())
	require.Zero(t, terminal.resizes)
	terminal.mu.Unlock()
	facts := manager.BranchTerminals(f.row.RepositoryID, f.row.ID)
	require.Len(t, facts, 1)
	require.Equal(t, []int64{alice.ID}, facts[0].Watchers)
	require.NoError(t, owner.Close(websocket.StatusNormalClosure, "reload"))
	owner = dial(f.cookie)
	_, output, err = owner.Read(ctx)
	require.NoError(t, err)
	require.Equal(t, "owner echo", string(output))
	_, _, err = owner.Read(ctx)
	require.NoError(t, err)
	require.NoError(t, f.publish.Publish(ctx, revocation.Event{Kind: revocation.KindCollaboratorRemoved, RepositoryID: f.row.RepositoryID, UserID: alice.ID}))
	_, _, err = watcher.Read(ctx)
	require.Equal(t, websocket.StatusPolicyViolation, websocket.CloseStatus(err))
	require.True(t, manager.HasBranchTerminal(f.row.RepositoryID, f.row.ID))
	require.NoError(t, owner.Write(ctx, websocket.MessageBinary, []byte("still owner")))
	_, output, err = owner.Read(ctx)
	require.NoError(t, err)
	require.Equal(t, "still owner", string(output))
	require.NoError(t, owner.Write(ctx, websocket.MessageText, []byte(`{"type":"close"}`)))
	_, _, err = owner.Read(ctx)
	require.Equal(t, websocket.StatusNormalClosure, websocket.CloseStatus(err))
	require.Eventually(t, func() bool { return !manager.HasBranchTerminal(f.row.RepositoryID, f.row.ID) }, time.Second, time.Millisecond)
}

func (p terminalBrokerFixture) Ready(ctx context.Context, principal revocation.Principal) error {
	if p.ready.Load() {
		return nil
	}
	return p.installOwnerTerminals.Ready(ctx, principal)
}
