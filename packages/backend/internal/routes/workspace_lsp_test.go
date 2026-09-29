package routes

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/coder/websocket"
	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	gossh "golang.org/x/crypto/ssh"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/revocation"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// fakeLSPExit is the exit status the fake SSH session reports; it satisfies
// the ExitStatus() shape the relay reads from *gossh.ExitError.
type fakeLSPExit struct{ code int }

func (e *fakeLSPExit) Error() string   { return fmt.Sprintf("exit status %d", e.code) }
func (e *fakeLSPExit) ExitStatus() int { return e.code }

// fakeLSPSSHSession is one exec session: the test's fake language server
// reads Content-Length frames from stdinR and writes to stdoutW.
type fakeLSPSSHSession struct {
	stdinR  *io.PipeReader
	stdinW  *io.PipeWriter
	stdoutR *io.PipeReader
	stdoutW *io.PipeWriter
	stderrR *io.PipeReader
	stderrW *io.PipeWriter

	started chan string
	exitCh  chan error
	exitErr error
	exited  sync.Once
	// waitReturned closes once the relay's Wait observed the exit status, so
	// a test can order what it does next after the relay saw the exit.
	waitReturned chan struct{}
	closed       atomic.Bool
	signals      []gossh.Signal
	mu           sync.Mutex
}

func newFakeLSPSSHSession() *fakeLSPSSHSession {
	stdinR, stdinW := io.Pipe()
	stdoutR, stdoutW := io.Pipe()
	stderrR, stderrW := io.Pipe()
	return &fakeLSPSSHSession{
		stdinR: stdinR, stdinW: stdinW,
		stdoutR: stdoutR, stdoutW: stdoutW,
		stderrR: stderrR, stderrW: stderrW,
		started:      make(chan string, 1),
		exitCh:       make(chan error, 1),
		waitReturned: make(chan struct{}),
	}
}

func (f *fakeLSPSSHSession) StdinPipe() (io.WriteCloser, error) { return f.stdinW, nil }
func (f *fakeLSPSSHSession) StdoutPipe() (io.Reader, error)     { return f.stdoutR, nil }
func (f *fakeLSPSSHSession) StderrPipe() (io.Reader, error)     { return f.stderrR, nil }
func (f *fakeLSPSSHSession) Start(cmd string) error             { f.started <- cmd; return nil }
func (f *fakeLSPSSHSession) Signal(sig gossh.Signal) error {
	f.mu.Lock()
	f.signals = append(f.signals, sig)
	f.mu.Unlock()
	return nil
}
func (f *fakeLSPSSHSession) Wait() error {
	err := <-f.exitCh
	f.exitErr = err
	close(f.waitReturned)
	return err
}

// exit ends the fake process with code: stdout closes (EOF for the relay's
// reader) and Wait returns.
func (f *fakeLSPSSHSession) exit(code int) {
	f.exited.Do(func() {
		_ = f.stdoutW.Close()
		_ = f.stderrW.Close()
		if code == 0 {
			f.exitCh <- nil
		} else {
			f.exitCh <- &fakeLSPExit{code: code}
		}
	})
}

// exitStatusOnly reports the exit status while the output stream stays open:
// the order a real SSH channel can deliver, with the bytes the command
// already wrote still queued behind the status. It returns only after the
// relay's Wait observed the status, so whatever the caller writes next is
// strictly ordered after the relay saw the process exit.
func (f *fakeLSPSSHSession) exitStatusOnly(code int) {
	f.exited.Do(func() { f.exitCh <- &fakeLSPExit{code: code} })
	<-f.waitReturned
}

func (f *fakeLSPSSHSession) Close() error {
	if f.closed.CompareAndSwap(false, true) {
		_ = f.stdinR.Close()
		_ = f.stdinW.Close()
		_ = f.stdoutR.Close()
		_ = f.stdoutW.Close()
		_ = f.stderrR.Close()
		_ = f.stderrW.Close()
		// A killed process reports a non-zero status to anyone still waiting.
		f.exit(137)
	}
	return nil
}

type fakeLSPSSHClient struct{ closed atomic.Bool }

func (f *fakeLSPSSHClient) Close() error { f.closed.Store(true); return nil }

// fakeLanguageServer drives a fakeLSPSSHSession like a stdio server would:
// prints the ready line, then answers requests until it sees `exit`.
type fakeLanguageServer struct {
	sess *fakeLSPSSHSession
	// hoverBytes sizes the hover result's contents so tests can force the
	// relay to fragment.
	hoverBytes int
	// received collects every method the server saw, in order.
	mu       sync.Mutex
	received []string
	bodies   [][]byte
}

func (s *fakeLanguageServer) serve(t *testing.T) {
	t.Helper()
	select {
	case <-s.sess.started:
	case <-time.After(5 * time.Second):
		t.Error("fake language server never started")
		return
	}
	_, _ = io.WriteString(s.sess.stdoutW, services.LanguageServerReadyLine+"\n")
	reader := newLSPFrameReader(bufio.NewReader(s.sess.stdinR), lspMaxAssembledBytes)
	for {
		body, err := reader.Next()
		if err != nil {
			// stdin closed: a vscode-languageserver server exits 1 here when
			// it never saw shutdown.
			s.sess.exit(1)
			return
		}
		var msg struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
		}
		_ = json.Unmarshal(body, &msg)
		s.mu.Lock()
		s.received = append(s.received, msg.Method)
		s.bodies = append(s.bodies, body)
		s.mu.Unlock()
		switch msg.Method {
		case "initialize":
			s.reply(msg.ID, `{"capabilities":{"hoverProvider":true}}`)
		case "textDocument/hover":
			contents := strings.Repeat("x", s.hoverBytes)
			s.reply(msg.ID, `{"contents":{"kind":"markdown","value":"`+contents+`"}}`)
		case "shutdown":
			s.reply(msg.ID, `null`)
		case "exit":
			s.sess.exit(0)
			return
		case "crash":
			s.sess.exit(3)
			return
		}
	}
}

func (s *fakeLanguageServer) reply(id json.RawMessage, result string) {
	body := `{"jsonrpc":"2.0","id":` + string(id) + `,"result":` + result + `}`
	_, _ = s.sess.stdoutW.Write(lspEncodeMessage([]byte(body)))
}

func (s *fakeLanguageServer) methods() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.received...)
}

func lspTestSession(sessionID string, repositoryID, userID int64, status string) services.WorkspaceSessionResponse {
	return services.WorkspaceSessionResponse{
		ID:           sessionID,
		WorkspaceID:  "workspace-1",
		RepositoryID: repositoryID,
		UserID:       userID,
		Status:       status,
		Kind:         services.WorkspaceSessionKindLSP,
		Language:     "typescript",
		Cols:         80,
		Rows:         24,
	}
}

func lspTestService(status string) *mockWorkspaceTerminalService {
	return &mockWorkspaceTerminalService{
		getSessionFunc: func(ctx context.Context, sessionID string, repositoryID, userID int64) (services.WorkspaceSessionResponse, error) {
			return lspTestSession(sessionID, repositoryID, userID, status), nil
		},
		getSSHConnectionFunc: func(ctx context.Context, sessionID string, repositoryID, userID int64) (services.WorkspaceSSHConnectionInfo, error) {
			return services.WorkspaceSSHConnectionInfo{WorkspaceID: "workspace-1", VMID: "vm-1", Host: "vm-ssh.example", Username: "developer", Kind: "container"}, nil
		},
	}
}

func newLSPTestServer(t *testing.T, handler *WorkspaceTerminalHandler, authInfo *middleware.AuthInfo) *httptest.Server {
	t.Helper()
	r := chi.NewRouter()
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			ctx := req.Context()
			if authInfo != nil {
				ctx = middleware.ContextWithAuthInfo(ctx, authInfo)
			}
			ctx = middleware.ContextWithRepoContext(ctx, &middleware.RepoContext{
				Owner:      "testowner",
				Repository: &db.Repository{ID: 1, Name: "testrepo"},
			}, middleware.PermissionWrite)
			next.ServeHTTP(w, req.WithContext(ctx))
		})
	})
	r.Get("/repos/{owner}/{repo}/workspace/sessions/{id}/lsp", handler.LSPWebSocket)
	srv := httptest.NewServer(r)
	t.Cleanup(srv.Close)
	return srv
}

func lspTestAuth() *middleware.AuthInfo {
	return &middleware.AuthInfo{User: &db.User{ID: 1, Username: "testuser"}}
}

func dialLSP(ctx context.Context, srvURL, sessionID string) (*websocket.Conn, *http.Response, error) {
	return websocket.Dial(ctx, "ws"+srvURL[len("http"):]+"/repos/testowner/testrepo/workspace/sessions/"+sessionID+"/lsp", &websocket.DialOptions{
		Subprotocols: []string{"lsp"},
		HTTPHeader:   http.Header{"Origin": []string{"https://smithers.sh"}},
	})
}

func readAPIError(t *testing.T, resp *http.Response) pkgerrors.APIError {
	t.Helper()
	require.NotNil(t, resp)
	defer resp.Body.Close()
	var apiErr pkgerrors.APIError
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&apiErr))
	return apiErr
}

// newLSPRelayManager wires a manager whose dialer hands out fake sessions and
// starts a fake language server on each.
func newLSPRelayManager(t *testing.T, hoverBytes int, ready bool) (*LSPSessionManager, *fakeLanguageServer) {
	t.Helper()
	sess := newFakeLSPSSHSession()
	server := &fakeLanguageServer{sess: sess, hoverBytes: hoverBytes}
	manager := NewLSPSessionManager(func(ctx context.Context, info services.WorkspaceSSHConnectionInfo) (lspSSHClient, lspSSHSession, error) {
		return &fakeLSPSSHClient{}, sess, nil
	})
	manager.exitWait = 200 * time.Millisecond
	manager.startupRetryDelay = 10 * time.Millisecond
	if ready {
		go server.serve(t)
	}
	t.Cleanup(manager.Close)
	return manager, server
}

func TestLSPWebSocket_PreUpgradeStatuses(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name       string
		auth       *middleware.AuthInfo
		origin     string
		service    *mockWorkspaceTerminalService
		query      string
		wantStatus int
		wantCode   pkgerrors.Code
	}{
		{
			name:       "no auth is 401",
			auth:       nil,
			origin:     "https://smithers.sh",
			service:    lspTestService("running"),
			wantStatus: http.StatusUnauthorized,
		},
		{
			name:       "bad origin on a cookie principal is 403",
			auth:       lspTestAuth(),
			origin:     "https://evil.example",
			service:    lspTestService("running"),
			wantStatus: http.StatusForbidden,
		},
		{
			name:   "terminal session on the lsp route is 409 kind mismatch",
			auth:   lspTestAuth(),
			origin: "https://smithers.sh",
			service: &mockWorkspaceTerminalService{getSessionFunc: func(ctx context.Context, sessionID string, repositoryID, userID int64) (services.WorkspaceSessionResponse, error) {
				s := lspTestSession(sessionID, repositoryID, userID, "running")
				s.Kind = services.WorkspaceSessionKindTerminal
				s.Language = ""
				return s, nil
			}},
			wantStatus: http.StatusConflict,
			wantCode:   services.CodeWorkspaceSessionKindMismatch,
		},
		{
			name:       "language query that disagrees with the session is 400",
			auth:       lspTestAuth(),
			origin:     "https://smithers.sh",
			service:    lspTestService("running"),
			query:      "?language=rust",
			wantStatus: http.StatusBadRequest,
		},
		{
			name:       "pending session is 425",
			auth:       lspTestAuth(),
			origin:     "https://smithers.sh",
			service:    lspTestService("pending"),
			wantStatus: http.StatusTooEarly,
			wantCode:   "workspace_session_pending",
		},
		{
			name:       "stopped session is 409",
			auth:       lspTestAuth(),
			origin:     "https://smithers.sh",
			service:    lspTestService("stopped"),
			wantStatus: http.StatusConflict,
		},
		{
			name:       "failed session is 409",
			auth:       lspTestAuth(),
			origin:     "https://smithers.sh",
			service:    lspTestService("failed"),
			wantStatus: http.StatusConflict,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			handler := &WorkspaceTerminalHandler{
				Service:        tc.service,
				AllowedOrigins: []string{"https://smithers.sh"},
				LSPSessions: NewLSPSessionManager(func(ctx context.Context, info services.WorkspaceSSHConnectionInfo) (lspSSHClient, lspSSHSession, error) {
					t.Fatal("pre-upgrade rejections must not dial SSH")
					return nil, nil, nil
				}),
			}
			srv := newLSPTestServer(t, handler, tc.auth)
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			_, resp, err := websocket.Dial(ctx, "ws"+srv.URL[len("http"):]+"/repos/testowner/testrepo/workspace/sessions/s1/lsp"+tc.query, &websocket.DialOptions{
				Subprotocols: []string{"lsp"},
				HTTPHeader:   http.Header{"Origin": []string{tc.origin}},
			})
			require.Error(t, err)
			require.NotNil(t, resp)
			assert.Equal(t, tc.wantStatus, resp.StatusCode)
			if tc.wantCode != "" {
				assert.Equal(t, tc.wantCode, readAPIError(t, resp).Code)
			}
		})
	}
}

func TestLSPWebSocket_ActiveCapIs429BeforeSSH(t *testing.T) {
	t.Parallel()

	counter := middleware.NewActiveCounter("workspace_terminal_active", 1, nil)
	require.True(t, counter.Acquire(1), "hold the single slot")
	dialed := atomic.Int32{}
	handler := &WorkspaceTerminalHandler{
		Service:           lspTestService("running"),
		AllowedOrigins:    []string{"https://smithers.sh"},
		ActiveConnections: counter,
		LSPSessions: NewLSPSessionManager(func(ctx context.Context, info services.WorkspaceSSHConnectionInfo) (lspSSHClient, lspSSHSession, error) {
			dialed.Add(1)
			return nil, nil, errors.New("must not dial")
		}),
	}
	srv := newLSPTestServer(t, handler, lspTestAuth())
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, resp, err := dialLSP(ctx, srv.URL, "s1")
	require.Error(t, err)
	assert.Equal(t, http.StatusTooManyRequests, resp.StatusCode)
	assert.Equal(t, "1", resp.Header.Get("Retry-After"))
	assert.Equal(t, pkgerrors.CodeRateLimitExceeded, readAPIError(t, resp).Code)
	assert.Zero(t, dialed.Load())
}

func TestLSPWebSocket_MissingBinaryIs409WithInstallLine(t *testing.T) {
	t.Parallel()

	sess := newFakeLSPSSHSession()
	manager := NewLSPSessionManager(func(ctx context.Context, info services.WorkspaceSSHConnectionInfo) (lspSSHClient, lspSSHSession, error) {
		return &fakeLSPSSHClient{}, sess, nil
	})
	manager.exitWait = 200 * time.Millisecond
	go func() {
		cmd := <-sess.started
		assert.Contains(t, cmd, "typescript-language-server")
		// The launch script's missing branch: the line, then exit 127.
		_, _ = io.WriteString(sess.stdoutW, services.LanguageServerMissingLine+" typescript-language-server\n")
		sess.exit(services.LanguageServerMissingExitCode)
	}()
	handler := &WorkspaceTerminalHandler{
		Service:        lspTestService("running"),
		AllowedOrigins: []string{"https://smithers.sh"},
		LSPSessions:    manager,
	}
	srv := newLSPTestServer(t, handler, lspTestAuth())
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, resp, err := dialLSP(ctx, srv.URL, "s1")
	require.Error(t, err)
	require.NotNil(t, resp)
	assert.Equal(t, http.StatusConflict, resp.StatusCode)
	assert.Empty(t, resp.Header.Get("Sec-Websocket-Accept"), "a missing server is answered before the upgrade")
	apiErr := readAPIError(t, resp)
	assert.Equal(t, services.CodeLanguageServerMissing, apiErr.Code)
	assert.Equal(t, "npm i -g typescript-language-server typescript", apiErr.Message)
	assert.True(t, sess.closed.Load(), "the failed launch's SSH session is closed")
}

// TestLSPWebSocket_MissingBinaryIs409WhenTheExitLandsFirst pins the ordering
// the previous test leaves to chance. On a real SSH channel the exit status
// can reach Wait before the relay has drained the line the launch script
// already wrote, and the same guest must not then be answered
// `guest_not_ready`: the handshake line is the verdict, the exit status only
// bounds how long it may still arrive.
func TestLSPWebSocket_MissingBinaryIs409WhenTheExitLandsFirst(t *testing.T) {
	t.Parallel()

	sess := newFakeLSPSSHSession()
	manager := NewLSPSessionManager(func(ctx context.Context, info services.WorkspaceSSHConnectionInfo) (lspSSHClient, lspSSHSession, error) {
		return &fakeLSPSSHClient{}, sess, nil
	})
	go func() {
		<-sess.started
		// The status lands first: nothing has been read from stdout yet.
		sess.exitStatusOnly(services.LanguageServerMissingExitCode)
		// Only now does the queued line reach the relay.
		_, _ = io.WriteString(sess.stdoutW, services.LanguageServerMissingLine+" typescript-language-server\n")
		_ = sess.stdoutW.Close()
	}()
	handler := &WorkspaceTerminalHandler{
		Service:        lspTestService("running"),
		AllowedOrigins: []string{"https://smithers.sh"},
		LSPSessions:    manager,
	}
	srv := newLSPTestServer(t, handler, lspTestAuth())
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, resp, err := dialLSP(ctx, srv.URL, "s1")
	require.Error(t, err)
	require.NotNil(t, resp)
	assert.Equal(t, http.StatusConflict, resp.StatusCode)
	apiErr := readAPIError(t, resp)
	assert.Equal(t, services.CodeLanguageServerMissing, apiErr.Code)
	assert.Equal(t, "npm i -g typescript-language-server typescript", apiErr.Message)
	assert.True(t, sess.closed.Load(), "the failed launch's SSH session is closed")
}

func TestLSPWebSocket_ShellMissingOnVMGuestRetriesThen503(t *testing.T) {
	t.Parallel()

	var dials atomic.Int32
	manager := NewLSPSessionManager(func(ctx context.Context, info services.WorkspaceSSHConnectionInfo) (lspSSHClient, lspSSHSession, error) {
		dials.Add(1)
		sess := newFakeLSPSSHSession()
		go func() {
			<-sess.started
			// exit 127 with no handshake line: the guest's shell did not resolve.
			sess.exit(127)
		}()
		return &fakeLSPSSHClient{}, sess, nil
	})
	manager.exitWait = 200 * time.Millisecond
	manager.startupRetryDelay = 10 * time.Millisecond
	svc := lspTestService("running")
	svc.getSSHConnectionFunc = func(ctx context.Context, sessionID string, repositoryID, userID int64) (services.WorkspaceSSHConnectionInfo, error) {
		return services.WorkspaceSSHConnectionInfo{WorkspaceID: "workspace-1", VMID: "vm-1", Host: "vm-ssh.example", Username: "developer", Kind: "vm"}, nil
	}
	handler := &WorkspaceTerminalHandler{Service: svc, AllowedOrigins: []string{"https://smithers.sh"}, LSPSessions: manager}
	srv := newLSPTestServer(t, handler, lspTestAuth())
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, resp, err := dialLSP(ctx, srv.URL, "s1")
	require.Error(t, err)
	assert.Equal(t, http.StatusServiceUnavailable, resp.StatusCode)
	assert.Equal(t, pkgerrors.CodeGuestNotReady, readAPIError(t, resp).Code)
	assert.Equal(t, int32(2), dials.Load(), "a vm guest gets one activation retry")
}

// TestLSPWebSocket_RelayRoundTrip proves the relay against a fake stdio
// server: Content-Length framing both ways, a >1 MiB hover fragmented for
// the client, a fragmented client message reassembled, and the typed 1000
// close when the client's shutdown/exit ends the server.
func TestLSPWebSocket_RelayRoundTrip(t *testing.T) {
	t.Parallel()

	manager, server := newLSPRelayManager(t, 2*lspMaxMessageBytes, true)
	svc := lspTestService("running")
	handler := &WorkspaceTerminalHandler{Service: svc, AllowedOrigins: []string{"https://smithers.sh"}, LSPSessions: manager}
	srv := newLSPTestServer(t, handler, lspTestAuth())

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	ws, resp, err := dialLSP(ctx, srv.URL, "s1")
	require.NoError(t, err)
	require.Equal(t, http.StatusSwitchingProtocols, resp.StatusCode)
	assert.Equal(t, "lsp", resp.Header.Get("Sec-Websocket-Protocol"))
	defer ws.CloseNow()
	ws.SetReadLimit(lspMaxMessageBytes)

	send := func(body string) {
		require.NoError(t, ws.Write(ctx, websocket.MessageText, []byte(body)))
	}
	readJSON := func() map[string]any {
		typ, data, err := ws.Read(ctx)
		require.NoError(t, err)
		require.Equal(t, websocket.MessageText, typ)
		var out map[string]any
		require.NoError(t, json.Unmarshal(data, &out))
		return out
	}

	send(`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"rootUri":"file:///home/developer/workspace","capabilities":{}}}`)
	init := readJSON()
	assert.EqualValues(t, 1, init["id"])
	assert.Contains(t, init, "result")

	// A hover whose result is 2 MiB arrives as ordered {seq,last,data} fragments.
	send(`{"jsonrpc":"2.0","id":2,"method":"textDocument/hover","params":{}}`)
	var assembled []byte
	for seq := 1; ; seq++ {
		frag := readJSON()
		assert.EqualValues(t, seq, frag["seq"])
		data, _ := frag["data"].(string)
		assembled = append(assembled, data...)
		if last, _ := frag["last"].(bool); last {
			break
		}
		require.Less(t, seq, 64, "runaway fragment sequence")
	}
	var hover struct {
		ID     int `json:"id"`
		Result struct {
			Contents struct {
				Value string `json:"value"`
			} `json:"contents"`
		} `json:"result"`
	}
	require.NoError(t, json.Unmarshal(assembled, &hover))
	assert.Equal(t, 2, hover.ID)
	assert.Len(t, hover.Result.Contents.Value, 2*lspMaxMessageBytes)

	// A client message sent as fragments is reassembled before it reaches
	// the server's stdin as one Content-Length frame.
	big := `{"jsonrpc":"2.0","method":"textDocument/didOpen","params":{"textDocument":{"uri":"file:///home/developer/workspace/index.ts","languageId":"typescript","version":1,"text":"` + strings.Repeat("y", 1500*1024) + `"}}}`
	for _, frame := range lspSplitFragments([]byte(big), 512*1024) {
		require.NoError(t, ws.Write(ctx, websocket.MessageText, frame))
	}
	send(`{"jsonrpc":"2.0","id":3,"method":"shutdown"}`)
	shutdown := readJSON()
	assert.EqualValues(t, 3, shutdown["id"])
	send(`{"jsonrpc":"2.0","method":"exit"}`)

	_, _, err = ws.Read(ctx)
	require.Error(t, err)
	assert.Equal(t, websocket.StatusNormalClosure, websocket.CloseStatus(err))
	var closeErr websocket.CloseError
	require.True(t, errors.As(err, &closeErr))
	assert.Equal(t, "language_server_exited: 0", closeErr.Reason, "a clean exit is 1000 with a typed reason, never silent")

	assert.Equal(t, []string{"initialize", "textDocument/hover", "textDocument/didOpen", "shutdown", "exit"}, server.methods())
	server.mu.Lock()
	didOpen := server.bodies[2]
	server.mu.Unlock()
	assert.Equal(t, big, string(didOpen), "fragments reassemble byte-for-byte")
	assert.Len(t, svc.touchCalls, 1, "traffic refreshes the session row's activity once per debounce window")
}

func TestLSPWebSocket_ServerCrashCloses1011Typed(t *testing.T) {
	t.Parallel()

	manager, _ := newLSPRelayManager(t, 0, true)
	handler := &WorkspaceTerminalHandler{Service: lspTestService("running"), AllowedOrigins: []string{"https://smithers.sh"}, LSPSessions: manager}
	srv := newLSPTestServer(t, handler, lspTestAuth())
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	ws, _, err := dialLSP(ctx, srv.URL, "s1")
	require.NoError(t, err)
	defer ws.CloseNow()

	require.NoError(t, ws.Write(ctx, websocket.MessageText, []byte(`{"jsonrpc":"2.0","method":"crash"}`)))
	_, _, err = ws.Read(ctx)
	require.Error(t, err)
	assert.Equal(t, websocket.StatusInternalError, websocket.CloseStatus(err))
	var closeErr websocket.CloseError
	require.True(t, errors.As(err, &closeErr))
	assert.Equal(t, "language_server_exited: 3", closeErr.Reason)
}

func TestLSPWebSocket_ClientFaultsCloseWithProtocolCodes(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name     string
		typ      websocket.MessageType
		payload  []byte
		wantCode websocket.StatusCode
	}{
		{"binary frame is 1003", websocket.MessageBinary, []byte("\x00\x01"), websocket.StatusUnsupportedData},
		{"non-object frame is 1002", websocket.MessageText, []byte(`[1,2,3]`), websocket.StatusProtocolError},
		{"fragment out of order is 1002", websocket.MessageText, []byte(`{"seq":2,"last":true,"data":"{}"}`), websocket.StatusProtocolError},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			manager, _ := newLSPRelayManager(t, 0, true)
			handler := &WorkspaceTerminalHandler{Service: lspTestService("running"), AllowedOrigins: []string{"https://smithers.sh"}, LSPSessions: manager}
			srv := newLSPTestServer(t, handler, lspTestAuth())
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			ws, _, err := dialLSP(ctx, srv.URL, "s1")
			require.NoError(t, err)
			defer ws.CloseNow()
			require.NoError(t, ws.Write(ctx, tc.typ, tc.payload))
			_, _, err = ws.Read(ctx)
			require.Error(t, err)
			assert.Equal(t, tc.wantCode, websocket.CloseStatus(err))
		})
	}
}

func TestLSPWebSocket_IdleCloses1000Typed(t *testing.T) {
	t.Parallel()

	manager, _ := newLSPRelayManager(t, 0, true)
	manager.idleTimeout = 150 * time.Millisecond
	handler := &WorkspaceTerminalHandler{Service: lspTestService("running"), AllowedOrigins: []string{"https://smithers.sh"}, LSPSessions: manager}
	srv := newLSPTestServer(t, handler, lspTestAuth())
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	ws, _, err := dialLSP(ctx, srv.URL, "s1")
	require.NoError(t, err)
	defer ws.CloseNow()

	_, _, err = ws.Read(ctx)
	require.Error(t, err)
	assert.Equal(t, websocket.StatusNormalClosure, websocket.CloseStatus(err))
	var closeErr websocket.CloseError
	require.True(t, errors.As(err, &closeErr))
	assert.Equal(t, lspCloseReasonIdle, closeErr.Reason)
}

func TestLSPSessionManager_RevokeMatchingCloses1008(t *testing.T) {
	t.Parallel()

	manager, _ := newLSPRelayManager(t, 0, true)
	handler := &WorkspaceTerminalHandler{Service: lspTestService("running"), AllowedOrigins: []string{"https://smithers.sh"}, LSPSessions: manager}
	srv := newLSPTestServer(t, handler, lspTestAuth())
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	ws, _, err := dialLSP(ctx, srv.URL, "s1")
	require.NoError(t, err)
	defer ws.CloseNow()

	// A principal is recorded before attach completes. Observe the real
	// initialized relay before testing the manager's attached-socket reason.
	require.NoError(t, ws.Write(ctx, websocket.MessageText, []byte(`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}`)))
	_, _, err = ws.Read(ctx)
	require.NoError(t, err)

	manager.RevokeMatching(revocation.Event{Kind: revocation.KindUserDisabled, UserID: 1, Reason: "token deleted"})
	_, _, err = ws.Read(ctx)
	require.Error(t, err)
	assert.Equal(t, websocket.StatusPolicyViolation, websocket.CloseStatus(err))
	var closeErr websocket.CloseError
	require.True(t, errors.As(err, &closeErr))
	assert.Equal(t, "access revoked: token deleted", closeErr.Reason)
}

func TestLSPFrameReader_Framing(t *testing.T) {
	t.Parallel()

	stream := "Content-Length: 2\r\n\r\n{}" +
		"Content-Type: application/vscode-jsonrpc; charset=utf-8\r\ncontent-length: 7\r\n\r\n{\"a\":1}" +
		"\r\nContent-Length: 0\r\n\r\n"
	reader := newLSPFrameReader(bufio.NewReader(strings.NewReader(stream)), 1024)
	first, err := reader.Next()
	require.NoError(t, err)
	assert.Equal(t, "{}", string(first))
	second, err := reader.Next()
	require.NoError(t, err)
	assert.Equal(t, `{"a":1}`, string(second))
	third, err := reader.Next()
	require.NoError(t, err)
	assert.Empty(t, third)
	_, err = reader.Next()
	assert.ErrorIs(t, err, io.EOF)

	_, err = newLSPFrameReader(bufio.NewReader(strings.NewReader("X-Other: 1\r\n\r\n{}")), 1024).Next()
	assert.ErrorIs(t, err, errLSPMissingContentLength)
	_, err = newLSPFrameReader(bufio.NewReader(strings.NewReader("Content-Length: 99\r\n\r\n")), 10).Next()
	assert.ErrorIs(t, err, errLSPMessageTooLarge)
}

func TestLSPFragments_SplitOnRuneBoundariesAndReassemble(t *testing.T) {
	t.Parallel()

	msg := []byte(`{"jsonrpc":"2.0","result":"` + strings.Repeat("é", 700) + `"}`)
	frames := lspSplitFragments(msg, 1000)
	require.Greater(t, len(frames), 1)
	assembler := newLSPFragmentAssembler(lspMaxAssembledBytes)
	var out []byte
	for i, frame := range frames {
		assert.LessOrEqual(t, len(frame), 1000*2+64)
		kind, frag, err := lspClassifyFrame(frame)
		require.NoError(t, err)
		require.Equal(t, lspFrameFragment, kind)
		assert.Equal(t, i+1, frag.Seq)
		complete, done, err := assembler.Push(frag)
		require.NoError(t, err)
		if i < len(frames)-1 {
			assert.False(t, done)
		} else {
			assert.True(t, done)
			out = complete
		}
	}
	assert.Equal(t, msg, out)

	kind, _, err := lspClassifyFrame([]byte(`{"jsonrpc":"2.0","id":1,"method":"x"}`))
	require.NoError(t, err)
	assert.Equal(t, lspFrameMessage, kind, "a message with jsonrpc is never a fragment")
}

// The server binary is resolved from the workspace's own node_modules, so its
// stdout is hostile input: a header line that never ends, or headers that
// never stop, must fail at a small bound instead of growing in the API heap.
// The sources are finite, so an unbounded read would still return; the
// consumed count is what proves the bound.
func TestLSPFrameReader_BoundsHeaderReads(t *testing.T) {
	for name, input := range map[string]string{
		"long line":    "X: " + strings.Repeat("a", 2<<20) + "\r\nContent-Length: 2\r\n\r\n{}",
		"unterminated": strings.Repeat("a", 2<<20),
		"aggregate":    strings.Repeat("X: a\r\n", 10000) + "Content-Length: 2\r\n\r\n{}",
		"blank lines":  strings.Repeat("\r\n", 20000),
	} {
		t.Run(name, func(t *testing.T) {
			source := strings.NewReader(input)
			_, err := newLSPFrameReader(bufio.NewReaderSize(source, 64), 16).Next()
			require.ErrorIs(t, err, errLSPHeaderTooLarge)
			assert.LessOrEqual(t, len(input)-source.Len(), lspMaxHeaderBytes+64, "must reject before consuming the hostile stream")
		})
	}
}

// handshakeOnlySession serves a fixed stdout: what a launch script prints
// before (or instead of) the ready line.
type handshakeOnlySession struct {
	*fakeLSPSSHSession
	stdout io.Reader
}

func (s *handshakeOnlySession) StdoutPipe() (io.Reader, error) { return s.stdout, nil }

func TestLSPSessionManager_StartBoundsReadyLine(t *testing.T) {
	input := strings.Repeat("x", 2<<20)
	source := strings.NewReader(input)
	fake := newFakeLSPSSHSession()
	defer fake.Close()
	client := &fakeLSPSSHClient{}
	m := NewLSPSessionManager(func(context.Context, services.WorkspaceSSHConnectionInfo) (lspSSHClient, lspSSHSession, error) {
		return client, &handshakeOnlySession{fake, source}, nil
	})
	m.exitWait = time.Millisecond
	// The guest exits once the relay closes its stdin, like a real server.
	go func() { _, _ = io.Copy(io.Discard, fake.stdinR); fake.exit(1) }()

	_, err := m.start(context.Background(), "s", services.WorkspaceSSHConnectionInfo{}, services.LanguageServerLaunch{}, revocation.Principal{})
	require.ErrorIs(t, err, errLSPHeaderTooLarge)
	// One bufio fill at most: the 64 KiB reader, never the 2 MiB line.
	assert.LessOrEqual(t, len(input)-source.Len(), 64<<10)
	assert.True(t, client.closed.Load(), "the SSH connection is closed with the launch")
}

// Two tabs, or a reconnect racing the attach it replaces, start the same
// session id while neither launch has finished. Exactly one server may be
// tracked afterwards and the other must be killed: an untracked server is
// out of reach of Destroy, Close and revocation. The dial deliberately
// ignores its context so the superseded launch completes late.
func TestLSPSessionManager_OverlappingStartsKeepOneLiveServer(t *testing.T) {
	for _, end := range []string{"replace", "destroy", "close"} {
		t.Run(end, func(t *testing.T) {
			entered := make(chan chan struct{}, 2)
			clients := make(chan *fakeLSPSSHClient, 2)
			m := NewLSPSessionManager(func(context.Context, services.WorkspaceSSHConnectionInfo) (lspSSHClient, lspSSHSession, error) {
				release := make(chan struct{})
				entered <- release
				<-release
				fake := newFakeLSPSSHSession()
				go (&fakeLanguageServer{sess: fake}).serve(t)
				client := &fakeLSPSSHClient{}
				clients <- client
				return client, fake, nil
			})
			m.exitWait = time.Millisecond
			defer m.Close()
			type result struct {
				sess *lspSession
				err  error
			}
			results := make(chan result, 2)
			start := func() {
				s, e := m.start(context.Background(), "same", services.WorkspaceSSHConnectionInfo{}, services.LanguageServerLaunch{}, revocation.Principal{})
				results <- result{s, e}
			}
			go start()
			first := <-entered
			go start()
			second := <-entered

			close(second)
			winner := <-results
			winnerClient := <-clients
			require.NoError(t, winner.err)
			switch end {
			case "destroy":
				m.Destroy("same", "test")
			case "close":
				m.Close()
			}

			close(first)
			older := <-results
			olderClient := <-clients
			require.Error(t, older.err, "a superseded launch must not publish")
			assert.Nil(t, older.sess)
			require.Eventually(t, olderClient.closed.Load, time.Second, time.Millisecond, "the superseded server is killed")

			tracked := func() *lspSession {
				m.mu.Lock()
				defer m.mu.Unlock()
				return m.sessions["same"]
			}
			if end == "replace" {
				assert.Same(t, winner.sess, tracked())
				assert.False(t, winner.sess.isDead())
			} else {
				assert.True(t, winner.sess.isDead())
				// Teardown forgets the session once its kill completes.
				require.Eventually(t, func() bool { return tracked() == nil }, time.Second, time.Millisecond)
			}
			m.Destroy("same", "test")
			require.Eventually(t, winnerClient.closed.Load, time.Second, time.Millisecond)
		})
	}
}

// json.Marshal escapes `<`, `>`, `&`, U+2028/9 and control bytes to six
// bytes: a hover or diagnostic full of JSX must still fragment under the
// advertised 1 MiB frame, or a client enforcing that limit drops the relay.
func TestLSPFragments_StayUnderFrameLimitWhenEscaped(t *testing.T) {
	for _, value := range []string{"<>&", `\"`, "é世界😀\u2028", "\x01\t"} {
		t.Run(strconv.Quote(value), func(t *testing.T) {
			// Valid JSON that carries the raw characters, not their escapes.
			quoted, err := json.Marshal(strings.Repeat(value, 400000))
			require.NoError(t, err)
			for from, to := range map[string]string{`\u003c`: "<", `\u003e`: ">", `\u0026`: "&", `\u2028`: "\u2028"} {
				quoted = []byte(strings.ReplaceAll(string(quoted), from, to))
			}
			msg := append(append([]byte(`{"result":`), quoted...), '}')
			require.True(t, json.Valid(msg))
			require.Greater(t, len(msg), lspMaxMessageBytes)

			var joined strings.Builder
			frames := lspSplitFragments(msg, lspFragmentDataBytes)
			for i, frame := range frames {
				require.LessOrEqual(t, len(frame), lspMaxMessageBytes, "fragment %d", i+1)
				var fragment lspFragment
				require.NoError(t, json.Unmarshal(frame, &fragment))
				assert.Equal(t, i+1, fragment.Seq)
				assert.Equal(t, i+1 == len(frames), fragment.Last)
				require.True(t, utf8.ValidString(fragment.Data))
				joined.WriteString(fragment.Data)
			}
			assert.Equal(t, string(msg), joined.String())
		})
	}
}
