package routes

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/revocation"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/workspace"
)

// Maya (user 1) owns the terminal session row; Ben (user 2) is on the branch.
const (
	watchOwnerID   = int64(1)
	watchWatcherID = int64(2)
)

type watchFixture struct {
	srv     *httptest.Server
	manager *TerminalSessionManager
	fake    *fakeTerminalSSH
	stdin   *lockedBuffer
	dials   atomic.Int32
	sshInfo atomic.Int32
}

type lockedBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *lockedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

func newWatchFixture(t *testing.T) *watchFixture {
	t.Helper()
	f := &watchFixture{fake: newFakeTerminalSSH(), stdin: &lockedBuffer{}}
	go func() {
		chunk := make([]byte, 1024)
		for {
			n, err := f.fake.session.stdinR.Read(chunk)
			if n > 0 {
				f.stdin.mu.Lock()
				f.stdin.buf.Write(chunk[:n])
				f.stdin.mu.Unlock()
			}
			if err != nil {
				return
			}
		}
	}()
	svc := &mockWorkspaceTerminalService{
		getSessionFunc: func(_ context.Context, sessionID string, repositoryID, _ int64) (services.WorkspaceSessionResponse, error) {
			return services.WorkspaceSessionResponse{ID: sessionID, WorkspaceID: "branch-1", RepositoryID: repositoryID, UserID: watchOwnerID, Status: "running", Cols: 80, Rows: 24}, nil
		},
		getSSHConnectionFunc: func(_ context.Context, _ string, _, userID int64) (services.WorkspaceSSHConnectionInfo, error) {
			f.sshInfo.Add(1)
			require.Equal(t, watchOwnerID, userID, "only the owner asks for the shell's connection")
			return services.WorkspaceSSHConnectionInfo{WorkspaceID: "branch-1", VMID: "vm-1", Host: "vm.example", Username: "agent"}, nil
		},
	}
	f.manager = NewTerminalSessionManager(func(context.Context, services.WorkspaceSSHConnectionInfo, int32, int32) (terminalSSHClient, terminalSSHSession, error) {
		f.dials.Add(1)
		return f.fake.client, f.fake.session, nil
	})
	f.manager.keepaliveInterval = 0
	t.Cleanup(f.manager.Close)
	handler := &WorkspaceTerminalHandler{Service: svc, AllowedOrigins: []string{"https://smithers.sh"}, TerminalSessions: f.manager}
	r := chi.NewRouter()
	r.Use(watchIdentity)
	r.Get("/repos/{owner}/{repo}/workspace/sessions/{id}/terminal", handler.TerminalWebSocket)
	f.srv = httptest.NewServer(r)
	t.Cleanup(f.srv.Close)
	return f
}

func watchIdentity(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id, _ := strconv.ParseInt(r.URL.Query().Get("as"), 10, 64)
		ctx := middleware.ContextWithAuthInfo(r.Context(), &middleware.AuthInfo{User: &db.User{ID: id, Username: "u" + strconv.FormatInt(id, 10)}})
		ctx = middleware.ContextWithRepoContext(ctx, &middleware.RepoContext{Owner: "o", Repository: &db.Repository{ID: 3, Name: "r"}}, middleware.PermissionWrite)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func (f *watchFixture) dial(ctx context.Context, userID int64) (*websocket.Conn, *http.Response, error) {
	url := "ws" + f.srv.URL[4:] + "/repos/o/r/workspace/sessions/s1/terminal?as=" + strconv.FormatInt(userID, 10)
	return websocket.Dial(ctx, url, &websocket.DialOptions{HTTPHeader: http.Header{"Origin": []string{"https://smithers.sh"}}})
}

// readUntil reads binary frames until want appears in the accumulated output.
func readUntil(ctx context.Context, t *testing.T, conn *websocket.Conn, want string) {
	t.Helper()
	var seen bytes.Buffer
	for !bytes.Contains(seen.Bytes(), []byte(want)) {
		typ, data, err := conn.Read(ctx)
		require.NoError(t, err, "waiting for %q, saw %q", want, seen.String())
		if typ == websocket.MessageBinary {
			seen.Write(data)
		}
	}
}

func TestTerminalWatcherCannotOpenOwnersTerminal(t *testing.T) {
	f := newWatchFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_, resp, err := f.dial(ctx, watchWatcherID)
	require.Error(t, err)
	require.NotNil(t, resp)
	require.Equal(t, http.StatusConflict, resp.StatusCode)
	require.Zero(t, f.dials.Load(), "a watcher never starts someone else's shell")
	require.Zero(t, f.sshInfo.Load(), "a watcher never asks for the shell's credentials")
}

func TestTerminalWatcherSeesOwnerOutputAndCannotType(t *testing.T) {
	f := newWatchFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	owner, _, err := f.dial(ctx, watchOwnerID)
	require.NoError(t, err)
	defer owner.CloseNow()
	_, err = f.fake.stdoutW.Write([]byte("before-watch\r\n"))
	require.NoError(t, err)
	readUntil(ctx, t, owner, "before-watch")

	// Duplicate attach: Ben opens the card twice; both replay and both watch.
	watchA, _, err := f.dial(ctx, watchWatcherID)
	require.NoError(t, err)
	defer watchA.CloseNow()
	watchB, _, err := f.dial(ctx, watchWatcherID)
	require.NoError(t, err)
	defer watchB.CloseNow()
	readUntil(ctx, t, watchA, "before-watch")
	readUntil(ctx, t, watchB, "before-watch")
	require.Equal(t, int32(1), f.dials.Load(), "watchers share the owner's one shell")

	for _, watcher := range []*websocket.Conn{watchA, watchB} {
		require.NoError(t, watcher.Write(ctx, websocket.MessageBinary, []byte("rm -rf ~\n")))
		require.NoError(t, watcher.Write(ctx, websocket.MessageText, []byte(`{"type":"resize","rows":5,"cols":5}`)))
	}
	require.NoError(t, owner.Write(ctx, websocket.MessageBinary, []byte("echo hello\n")))
	require.Eventually(t, func() bool { return f.stdin.String() == "echo hello\n" }, 5*time.Second, 10*time.Millisecond)

	_, err = f.fake.stdoutW.Write([]byte("hello\r\n"))
	require.NoError(t, err)
	readUntil(ctx, t, watchA, "hello")
	readUntil(ctx, t, watchB, "hello")
	require.Equal(t, "echo hello\n", f.stdin.String(), "watcher keystrokes never reach the shell")
}

func TestTerminalRevokedWatcherDetachesOwnerContinues(t *testing.T) {
	f := newWatchFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	owner, _, err := f.dial(ctx, watchOwnerID)
	require.NoError(t, err)
	defer owner.CloseNow()
	watcher, _, err := f.dial(ctx, watchWatcherID)
	require.NoError(t, err)
	defer watcher.CloseNow()
	_, err = f.fake.stdoutW.Write([]byte("ready\r\n"))
	require.NoError(t, err)
	readUntil(ctx, t, owner, "ready")
	readUntil(ctx, t, watcher, "ready")

	// Ben is removed from the repository: his watch ends, Maya's shell lives.
	f.manager.RevokeMatching(revocation.Event{Kind: revocation.KindCollaboratorRemoved, UserID: watchWatcherID, RepositoryID: 3})
	for {
		_, _, err = watcher.Read(ctx)
		if err != nil {
			break
		}
	}
	require.Equal(t, websocket.StatusPolicyViolation, websocket.CloseStatus(err))
	require.NotNil(t, f.manager.live("s1"))
	_, err = f.fake.stdoutW.Write([]byte("still-here\r\n"))
	require.NoError(t, err)
	readUntil(ctx, t, owner, "still-here")
}

func TestTerminalWatcherEndsWhenOwnersShellEnds(t *testing.T) {
	f := newWatchFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	owner, _, err := f.dial(ctx, watchOwnerID)
	require.NoError(t, err)
	defer owner.CloseNow()
	watcher, _, err := f.dial(ctx, watchWatcherID)
	require.NoError(t, err)
	defer watcher.CloseNow()
	f.manager.Destroy("s1")
	for {
		if _, _, err = watcher.Read(ctx); err != nil {
			break
		}
	}
	require.Nil(t, f.manager.live("s1"))
	_, resp, err := f.dial(ctx, watchWatcherID)
	require.Error(t, err)
	require.Equal(t, http.StatusConflict, resp.StatusCode)
}

func TestTerminalWatcherDecision(t *testing.T) {
	row := services.WorkspaceSessionResponse{UserID: 7}
	require.False(t, terminalWatcher(row, 7))
	require.True(t, terminalWatcher(row, 8))
	// A row without a recorded creator keeps the legacy single-owner behavior.
	require.False(t, terminalWatcher(services.WorkspaceSessionResponse{}, 8))
}

type countingCredentialTerminal struct {
	heldRuntimeTerminal
	acquires atomic.Int32
	releases atomic.Int32
}

func (t *countingCredentialTerminal) AcquireCredential(context.Context) error {
	t.acquires.Add(1)
	return nil
}
func (t *countingCredentialTerminal) ReleaseCredential() { t.releases.Add(1) }

func TestTerminalWatcherNeverHoldsOwnersCredential(t *testing.T) {
	terminal := &countingCredentialTerminal{heldRuntimeTerminal: heldRuntimeTerminal{closed: make(chan struct{})}}
	opens := atomic.Int32{}
	svc := &revocationRuntimeService{mockWorkspaceTerminalService: &mockWorkspaceTerminalService{
		getSessionFunc: func(_ context.Context, sessionID string, repositoryID, _ int64) (services.WorkspaceSessionResponse, error) {
			return services.WorkspaceSessionResponse{ID: sessionID, WorkspaceID: "branch-1", RepositoryID: repositoryID, UserID: watchOwnerID, Status: "running", Cols: 80, Rows: 24}, nil
		},
	}}
	svc.open = func(context.Context) (workspace.Terminal, error) {
		opens.Add(1)
		return terminal, nil
	}
	handler := &WorkspaceTerminalHandler{Service: svc, AllowedOrigins: []string{"https://smithers.sh"}}
	r := chi.NewRouter()
	r.Use(watchIdentity)
	r.Get("/repos/{owner}/{repo}/workspace/sessions/{id}/terminal", handler.TerminalWebSocket)
	srv := httptest.NewServer(r)
	defer srv.Close()
	defer handler.terminalSessionManager().Close()
	f := &watchFixture{srv: srv}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	owner, _, err := f.dial(ctx, watchOwnerID)
	require.NoError(t, err)
	_, _, err = owner.Read(ctx) // replay-complete marker
	require.NoError(t, err)
	watcher, _, err := f.dial(ctx, watchWatcherID)
	require.NoError(t, err)
	_, _, err = watcher.Read(ctx)
	require.NoError(t, err)
	require.Equal(t, int32(1), opens.Load())
	require.Equal(t, int32(1), terminal.acquires.Load(), "only the owner's attach signs the shell in")
	require.NoError(t, owner.Close(websocket.StatusNormalClosure, "bye"))
	require.Eventually(t, func() bool { return terminal.releases.Load() == 1 }, 5*time.Second, 10*time.Millisecond,
		"the owner leaving releases the credential even while Ben watches")
	require.NoError(t, watcher.Close(websocket.StatusNormalClosure, "bye"))
	time.Sleep(50 * time.Millisecond)
	require.Equal(t, int32(1), terminal.releases.Load())
}

var _ io.Reader = (*heldRuntimeTerminal)(nil)
