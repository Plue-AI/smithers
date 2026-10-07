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

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/revocation"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// fakeLSPExit is the exit status the fake process reports; it satisfies the
// ExitStatus() shape the relay reads from *machined.ExitError.
type fakeLSPExit struct{ code int }

func (e *fakeLSPExit) Error() string   { return fmt.Sprintf("exit status %d", e.code) }
func (e *fakeLSPExit) ExitStatus() int { return e.code }

// fakeLSPProcess is one daemon exec session: the test's fake language server
// reads Content-Length frames from stdinR and writes to stdoutW.
type fakeLSPProcess struct {
	stdinR  *io.PipeReader
	stdinW  *io.PipeWriter
	stdoutR *io.PipeReader
	stdoutW *io.PipeWriter
	stderrR *io.PipeReader
	stderrW *io.PipeWriter

	exitCh chan error
	exited sync.Once
	// waitReturned closes once the relay's Wait observed the exit status, so
	// a test can order what it does next after the relay saw the exit.
	waitReturned chan struct{}
	ready        atomic.Int32
	killed       atomic.Bool
}

func newFakeLSPProcess() *fakeLSPProcess {
	stdinR, stdinW := io.Pipe()
	stdoutR, stdoutW := io.Pipe()
	stderrR, stderrW := io.Pipe()
	return &fakeLSPProcess{
		stdinR: stdinR, stdinW: stdinW,
		stdoutR: stdoutR, stdoutW: stdoutW,
		stderrR: stderrR, stderrW: stderrW,
		exitCh:       make(chan error, 1),
		waitReturned: make(chan struct{}),
	}
}

func (f *fakeLSPProcess) Write(p []byte) (int, error) { return f.stdinW.Write(p) }
func (f *fakeLSPProcess) CloseWrite() error           { return f.stdinW.Close() }
func (f *fakeLSPProcess) Stdout() io.Reader           { return f.stdoutR }
func (f *fakeLSPProcess) Stderr() io.Reader           { return f.stderrR }
func (f *fakeLSPProcess) Ready()                      { f.ready.Add(1) }
func (f *fakeLSPProcess) Wait() error {
	err := <-f.exitCh
	close(f.waitReturned)
	return err
}

// Kill is the broker's cgroup kill: every pipe closes and a process still
// running reports 137.
func (f *fakeLSPProcess) Kill(context.Context) error {
	if f.killed.CompareAndSwap(false, true) {
		_ = f.stdinR.Close()
		_ = f.stdinW.Close()
		_ = f.stdoutR.Close()
		_ = f.stdoutW.Close()
		_ = f.stderrR.Close()
		_ = f.stderrW.Close()
		f.exit(137)
	}
	return nil
}

// exit ends the fake process with code: stdout closes (EOF for the relay's
// reader) and Wait returns.
func (f *fakeLSPProcess) exit(code int) {
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
// the bytes the command already wrote are still queued behind the status.
// It returns only after the relay's Wait observed the status.
func (f *fakeLSPProcess) exitStatusOnly(code int) {
	f.exited.Do(func() { f.exitCh <- &fakeLSPExit{code: code} })
	<-f.waitReturned
}

func (f *fakeLSPProcess) opener() lspOpener {
	return func(context.Context) (LSPProcess, error) { return f, nil }
}

// fakeLanguageServer drives a fakeLSPProcess like a stdio server would:
// prints the ready line, then answers requests until it sees `exit`.
type fakeLanguageServer struct {
	proc *fakeLSPProcess
	// hoverBytes sizes the hover result's contents so tests can force the
	// relay to fragment.
	hoverBytes int
	mu         sync.Mutex
	received   []string
	bodies     [][]byte
}

func (s *fakeLanguageServer) serve(t *testing.T) {
	t.Helper()
	_, _ = io.WriteString(s.proc.stdoutW, services.LanguageServerReadyLine+"\n")
	reader := newLSPFrameReader(bufio.NewReader(s.proc.stdinR), lspMaxAssembledBytes)
	for {
		body, err := reader.Next()
		if err != nil {
			// stdin closed: a vscode-languageserver server exits 1 here when
			// it never saw shutdown.
			s.proc.exit(1)
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
			s.proc.exit(0)
			return
		case "crash":
			s.proc.exit(3)
			return
		}
	}
}

func (s *fakeLanguageServer) reply(id json.RawMessage, result string) {
	body := `{"jsonrpc":"2.0","id":` + string(id) + `,"result":` + result + `}`
	_, _ = s.proc.stdoutW.Write(lspEncodeMessage([]byte(body)))
}

func (s *fakeLanguageServer) methods() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.received...)
}

// newLSPRelayManager wires a manager and an opener that hands out one fake
// process with a fake language server on it.
func newLSPRelayManager(t *testing.T, hoverBytes int, ready bool) (*LSPSessionManager, *fakeLanguageServer) {
	t.Helper()
	proc := newFakeLSPProcess()
	server := &fakeLanguageServer{proc: proc, hoverBytes: hoverBytes}
	manager := NewLSPSessionManager()
	manager.exitWait = 200 * time.Millisecond
	if ready {
		go server.serve(t)
	}
	t.Cleanup(manager.Close)
	return manager, server
}

const lspTestBranch = "scratch/maya/intelligence"

// fakeBranchLanguageServers is the install provider with its authority
// decisions selected by the test; the handler, relay and wire are real.
type fakeBranchLanguageServers struct {
	unavailable bool
	authorize   func(branch string, member int64) (revocation.Principal, error)
	ready       atomic.Pointer[error]
	open        func(context.Context) (LSPProcess, error)
	authorizes  atomic.Int32
	opens       atomic.Int32
	mu          sync.Mutex
	opened      []string
}

func (p *fakeBranchLanguageServers) Available() bool { return !p.unavailable }
func (p *fakeBranchLanguageServers) Authorize(_ context.Context, branch string, member int64) (revocation.Principal, error) {
	p.authorizes.Add(1)
	if p.authorize != nil {
		return p.authorize(branch, member)
	}
	if branch != lspTestBranch {
		return revocation.Principal{}, pkgerrors.NotFound("branch not found")
	}
	return revocation.Principal{UserID: member, RepositoryID: 1, WorkspaceID: "workspace-1", SandboxID: "vm-1"}, nil
}
func (p *fakeBranchLanguageServers) Ready(context.Context, revocation.Principal) error {
	if err := p.ready.Load(); err != nil {
		return *err
	}
	return nil
}
func (p *fakeBranchLanguageServers) asleep() {
	err := error(services.ErrBranchAsleep)
	p.ready.Store(&err)
}
func (p *fakeBranchLanguageServers) Open(ctx context.Context, principal revocation.Principal, language string) (LSPProcess, error) {
	p.opens.Add(1)
	p.mu.Lock()
	p.opened = append(p.opened, fmt.Sprintf("%d:%s:%s", principal.UserID, principal.WorkspaceID, language))
	p.mu.Unlock()
	if p.open == nil {
		return nil, errors.New("no language server in this test")
	}
	return p.open(ctx)
}

func lspTestHandler(provider *fakeBranchLanguageServers, manager *LSPSessionManager) *BranchLSPHandler {
	return &BranchLSPHandler{
		Provider:       provider,
		AllowedOrigins: []string{"https://smithers.sh"},
		sessions:       manager,
		Authorize: func(r *http.Request, command string) (int64, int64, error) {
			if command != "code.hover" {
				return 0, 0, pkgerrors.Forbidden("unexpected command " + command)
			}
			user := middleware.UserFromContext(r.Context())
			if user == nil {
				return 0, 0, pkgerrors.Unauthorized("authentication required")
			}
			return 1, user.ID, nil
		},
	}
}

// seedLSPGrant admits session "s1" for member 1, as a POST would.
func seedLSPGrant(handler *BranchLSPHandler) {
	handler.grants = map[string]*lspGrant{"s1": {id: "s1", member: 1, repository: 1, branch: "workspace-1", language: "typescript", used: time.Now()}}
}

func newLSPTestServer(t *testing.T, handler *BranchLSPHandler, authInfo *middleware.AuthInfo) *httptest.Server {
	t.Helper()
	r := chi.NewRouter()
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			ctx := req.Context()
			if authInfo != nil {
				ctx = middleware.ContextWithAuthInfo(ctx, authInfo)
			}
			next.ServeHTTP(w, req.WithContext(ctx))
		})
	})
	r.Post("/branches/{b}/lsp", handler.Open)
	r.Get("/branches/{b}/lsp/{id}", handler.Socket)
	srv := httptest.NewServer(r)
	t.Cleanup(srv.Close)
	return srv
}

func lspTestAuth() *middleware.AuthInfo {
	return &middleware.AuthInfo{User: &db.User{ID: 1, Username: "testuser"}}
}

func lspBranchPath(branch string) string {
	return "/branches/" + strings.ReplaceAll(branch, "/", "%2F") + "/lsp"
}

func openLSP(t *testing.T, srvURL, body string) (int, map[string]any) {
	t.Helper()
	resp, err := http.Post(srvURL+lspBranchPath(lspTestBranch), "application/json", strings.NewReader(body))
	require.NoError(t, err)
	defer resp.Body.Close()
	var out map[string]any
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&out))
	return resp.StatusCode, out
}

func dialLSP(ctx context.Context, srvURL, sessionID string) (*websocket.Conn, *http.Response, error) {
	return websocket.Dial(ctx, "ws"+srvURL[len("http"):]+lspBranchPath(lspTestBranch)+"/"+sessionID, &websocket.DialOptions{
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

// relayHandler is a socket handler whose provider opens the relay manager's
// fake process, with session "s1" admitted for member 1.
func relayHandler(t *testing.T, hoverBytes int) (*BranchLSPHandler, *LSPSessionManager, *fakeLanguageServer, *fakeBranchLanguageServers) {
	t.Helper()
	manager, server := newLSPRelayManager(t, hoverBytes, true)
	provider := &fakeBranchLanguageServers{open: server.proc.opener()}
	handler := lspTestHandler(provider, manager)
	seedLSPGrant(handler)
	return handler, manager, server, provider
}

// One code-intelligence session per (member, branch, language): the POST
// admits and dedupes it and starts no process.
func TestBranchLSPOpen_AdmitsOneSessionPerMemberBranchLanguage(t *testing.T) {
	t.Parallel()

	provider := &fakeBranchLanguageServers{}
	handler := lspTestHandler(provider, NewLSPSessionManager())
	srv := newLSPTestServer(t, handler, lspTestAuth())
	status, first := openLSP(t, srv.URL, `{"language":"typescript"}`)
	require.Equal(t, http.StatusCreated, status, first)
	assert.Equal(t, "exec", first["kind"])
	assert.Equal(t, "typescript", first["language"])
	assert.Equal(t, "workspace-1", first["branch"])
	require.NotEmpty(t, first["id"])
	status, again := openLSP(t, srv.URL, `{"language":"TypeScript"}`)
	require.Equal(t, http.StatusCreated, status)
	assert.Equal(t, first["id"], again["id"], "the same member, branch and language reuse one session")

	other := newLSPTestServer(t, handler, &middleware.AuthInfo{User: &db.User{ID: 2, Username: "maya"}})
	status, theirs := openLSP(t, other.URL, `{"language":"typescript"}`)
	require.Equal(t, http.StatusCreated, status)
	assert.NotEqual(t, first["id"], theirs["id"], "a session belongs to the member who asked")
	assert.Zero(t, provider.opens.Load(), "admission starts no language server")
}

func TestBranchLSPOpen_RefusesWithoutStartingAnything(t *testing.T) {
	t.Parallel()

	for _, tc := range []struct {
		name     string
		provider func() *fakeBranchLanguageServers
		auth     *middleware.AuthInfo
		body     string
		status   int
		message  string
	}{
		{"no provider is 503", func() *fakeBranchLanguageServers { return &fakeBranchLanguageServers{unavailable: true} }, lspTestAuth(), `{"language":"typescript"}`, http.StatusServiceUnavailable, "Code intelligence is unavailable"},
		{"signed out is 401", func() *fakeBranchLanguageServers { return &fakeBranchLanguageServers{} }, nil, `{"language":"typescript"}`, http.StatusUnauthorized, ""},
		{"unknown language is 400", func() *fakeBranchLanguageServers { return &fakeBranchLanguageServers{} }, lspTestAuth(), `{"language":"cobol"}`, http.StatusBadRequest, "language must be one of: typescript"},
		{"unknown field is 400", func() *fakeBranchLanguageServers { return &fakeBranchLanguageServers{} }, lspTestAuth(), `{"language":"typescript","argv":["/bin/sh"]}`, http.StatusBadRequest, ""},
		{"sleeping branch is 409", func() *fakeBranchLanguageServers {
			p := &fakeBranchLanguageServers{}
			p.asleep()
			return p
		}, lspTestAuth(), `{"language":"typescript"}`, http.StatusConflict, "The branch is asleep."},
		{"branch outside the member's access is 404", func() *fakeBranchLanguageServers {
			return &fakeBranchLanguageServers{authorize: func(string, int64) (revocation.Principal, error) {
				return revocation.Principal{}, pkgerrors.NotFound("branch not found")
			}}
		}, lspTestAuth(), `{"language":"typescript"}`, http.StatusNotFound, ""},
		{"another repository's machine is 404", func() *fakeBranchLanguageServers {
			return &fakeBranchLanguageServers{authorize: func(_ string, member int64) (revocation.Principal, error) {
				return revocation.Principal{UserID: member, RepositoryID: 2, WorkspaceID: "workspace-9"}, nil
			}}
		}, lspTestAuth(), `{"language":"typescript"}`, http.StatusNotFound, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			provider := tc.provider()
			handler := lspTestHandler(provider, NewLSPSessionManager())
			srv := newLSPTestServer(t, handler, tc.auth)
			status, body := openLSP(t, srv.URL, tc.body)
			assert.Equal(t, tc.status, status, body)
			if tc.message != "" {
				assert.Equal(t, tc.message, body["message"])
			}
			assert.Zero(t, provider.opens.Load())
			assert.Empty(t, handler.grants)
		})
	}
}

func TestBranchLSPSocket_PreUpgradeStatuses(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name       string
		auth       *middleware.AuthInfo
		origin     string
		id         string
		query      string
		provider   func() *fakeBranchLanguageServers
		wantStatus int
	}{
		{"no auth is 401", nil, "https://smithers.sh", "s1", "", nil, http.StatusUnauthorized},
		{"bad origin on a cookie principal is 403", lspTestAuth(), "https://evil.example", "s1", "", nil, http.StatusForbidden},
		{"unknown session is 404", lspTestAuth(), "https://smithers.sh", "s2", "", nil, http.StatusNotFound},
		{"another member's session is 404", &middleware.AuthInfo{User: &db.User{ID: 2, Username: "maya"}}, "https://smithers.sh", "s1", "", nil, http.StatusNotFound},
		{"language query that disagrees with the session is 400", lspTestAuth(), "https://smithers.sh", "s1", "?language=rust", nil, http.StatusBadRequest},
		{"lost branch access is 404", lspTestAuth(), "https://smithers.sh", "s1", "", func() *fakeBranchLanguageServers {
			return &fakeBranchLanguageServers{authorize: func(string, int64) (revocation.Principal, error) {
				return revocation.Principal{}, pkgerrors.NotFound("branch not found")
			}}
		}, http.StatusNotFound},
		{"sleeping branch is 409", lspTestAuth(), "https://smithers.sh", "s1", "", func() *fakeBranchLanguageServers {
			p := &fakeBranchLanguageServers{}
			p.asleep()
			return p
		}, http.StatusConflict},
		{"no provider is 503", lspTestAuth(), "https://smithers.sh", "s1", "", func() *fakeBranchLanguageServers {
			return &fakeBranchLanguageServers{unavailable: true}
		}, http.StatusServiceUnavailable},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			provider := &fakeBranchLanguageServers{}
			if tc.provider != nil {
				provider = tc.provider()
			}
			handler := lspTestHandler(provider, NewLSPSessionManager())
			seedLSPGrant(handler)
			srv := newLSPTestServer(t, handler, tc.auth)
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			_, resp, err := websocket.Dial(ctx, "ws"+srv.URL[len("http"):]+lspBranchPath(lspTestBranch)+"/"+tc.id+tc.query, &websocket.DialOptions{
				Subprotocols: []string{"lsp"},
				HTTPHeader:   http.Header{"Origin": []string{tc.origin}},
			})
			require.Error(t, err)
			require.NotNil(t, resp)
			assert.Equal(t, tc.wantStatus, resp.StatusCode)
			assert.Zero(t, provider.opens.Load(), "a refused socket starts no language server")
		})
	}
}

func TestBranchLSPSocket_ActiveCapIs429BeforeStart(t *testing.T) {
	t.Parallel()

	counter := middleware.NewActiveCounter("workspace_terminal_active", 1, nil)
	require.True(t, counter.Acquire(1), "hold the single slot")
	provider := &fakeBranchLanguageServers{}
	handler := lspTestHandler(provider, NewLSPSessionManager())
	handler.ActiveConnections = counter
	seedLSPGrant(handler)
	srv := newLSPTestServer(t, handler, lspTestAuth())
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, resp, err := dialLSP(ctx, srv.URL, "s1")
	require.Error(t, err)
	assert.Equal(t, http.StatusTooManyRequests, resp.StatusCode)
	assert.Equal(t, "1", resp.Header.Get("Retry-After"))
	assert.Equal(t, pkgerrors.CodeRateLimitExceeded, readAPIError(t, resp).Code)
	assert.Zero(t, provider.opens.Load())
}

// A missing binary is a typed close the browser can read, with the install
// line, whichever of the line and the exit status lands first.
func TestBranchLSPSocket_MissingBinaryClosesWithInstallLine(t *testing.T) {
	t.Parallel()

	for _, exitFirst := range []bool{false, true} {
		t.Run(map[bool]string{false: "line first", true: "exit first"}[exitFirst], func(t *testing.T) {
			t.Parallel()
			proc := newFakeLSPProcess()
			provider := &fakeBranchLanguageServers{open: func(context.Context) (LSPProcess, error) {
				go func() {
					if exitFirst {
						proc.exitStatusOnly(services.LanguageServerMissingExitCode)
						_, _ = io.WriteString(proc.stdoutW, services.LanguageServerMissingLine+" typescript-language-server\n")
						_ = proc.stdoutW.Close()
						return
					}
					_, _ = io.WriteString(proc.stdoutW, services.LanguageServerMissingLine+" typescript-language-server\n")
					proc.exit(services.LanguageServerMissingExitCode)
				}()
				return proc, nil
			}}
			manager := NewLSPSessionManager()
			manager.exitWait = 200 * time.Millisecond
			t.Cleanup(manager.Close)
			handler := lspTestHandler(provider, manager)
			seedLSPGrant(handler)
			srv := newLSPTestServer(t, handler, lspTestAuth())
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			ws, _, err := dialLSP(ctx, srv.URL, "s1")
			require.NoError(t, err)
			defer ws.CloseNow()
			_, _, err = ws.Read(ctx)
			var closeErr websocket.CloseError
			require.True(t, errors.As(err, &closeErr), "typed close missing: %v", err)
			assert.Equal(t, websocket.StatusNormalClosure, closeErr.Code)
			assert.Equal(t, "language_server_missing: npm i -g typescript-language-server typescript", closeErr.Reason)
			assert.True(t, proc.killed.Load(), "the failed launch's session is killed")
			assert.Zero(t, proc.ready.Load(), "a launch that never printed ready keeps no credential and is never Ready")
		})
	}
}

func TestBranchLSPSocket_StartRefusalsCloseTyped(t *testing.T) {
	t.Parallel()

	for _, tc := range []struct {
		name   string
		err    error
		code   websocket.StatusCode
		reason string
	}{
		{"branch slept during start", services.ErrBranchAsleep, websocket.StatusNormalClosure, "The branch is asleep."},
		{"broker refused", errors.New("broker_3: session refused"), websocket.StatusInternalError, "language server failed to start"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			provider := &fakeBranchLanguageServers{open: func(context.Context) (LSPProcess, error) { return nil, tc.err }}
			handler := lspTestHandler(provider, NewLSPSessionManager())
			seedLSPGrant(handler)
			srv := newLSPTestServer(t, handler, lspTestAuth())
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			ws, _, err := dialLSP(ctx, srv.URL, "s1")
			require.NoError(t, err)
			defer ws.CloseNow()
			_, _, err = ws.Read(ctx)
			var closeErr websocket.CloseError
			require.True(t, errors.As(err, &closeErr), "typed close missing: %v", err)
			assert.Equal(t, tc.code, closeErr.Code)
			assert.Equal(t, tc.reason, closeErr.Reason)
		})
	}
}

// TestBranchLSPSocket_RelayRoundTrip proves the relay against a fake stdio
// server: the member's session opens with its language, Content-Length
// framing both ways, a >1 MiB hover fragmented for the client, a fragmented
// client message reassembled, and the typed 1000 close when the client's
// shutdown/exit ends the server.
func TestBranchLSPSocket_RelayRoundTrip(t *testing.T) {
	t.Parallel()

	manager, server := newLSPRelayManager(t, 2*lspMaxMessageBytes, true)
	provider := &fakeBranchLanguageServers{open: server.proc.opener()}
	handler := lspTestHandler(provider, manager)
	srv := newLSPTestServer(t, handler, lspTestAuth())
	status, admitted := openLSP(t, srv.URL, `{"language":"typescript"}`)
	require.Equal(t, http.StatusCreated, status)

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	ws, resp, err := dialLSP(ctx, srv.URL, admitted["id"].(string)+"?language=typescript")
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

	send(`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"rootUri":"file:///workspace","capabilities":{}}}`)
	init := readJSON()
	assert.EqualValues(t, 1, init["id"])
	assert.Contains(t, init, "result")
	assert.Equal(t, []string{"1:workspace-1:typescript"}, provider.opened, "the requesting member's server on the authorized machine")
	assert.EqualValues(t, 1, server.proc.ready.Load(), "the launch credential retires at the ready line")

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
	big := `{"jsonrpc":"2.0","method":"textDocument/didOpen","params":{"textDocument":{"uri":"file:///workspace/index.ts","languageId":"typescript","version":1,"text":"` + strings.Repeat("y", 1500*1024) + `"}}}`
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
	require.Eventually(t, server.proc.killed.Load, time.Second, time.Millisecond, "teardown empties the session's cgroup")
	assert.EqualValues(t, 1, server.proc.ready.Load())
}

func TestBranchLSPSocket_ServerCrashCloses1011Typed(t *testing.T) {
	t.Parallel()

	handler, _, _, _ := relayHandler(t, 0)
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

func TestBranchLSPSocket_ClientFaultsCloseWithProtocolCodes(t *testing.T) {
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
			handler, _, _, _ := relayHandler(t, 0)
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

func TestBranchLSPSocket_IdleCloses1000Typed(t *testing.T) {
	t.Parallel()

	handler, manager, server, _ := relayHandler(t, 0)
	manager.idleTimeout = 150 * time.Millisecond
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
	require.Eventually(t, server.proc.killed.Load, time.Second, time.Millisecond, "an idle server is killed, not left running")
}

// A credential deletion during the server's start or after attach closes the
// socket 1008, and the member's server never outlives it.
func TestBranchLSPSocket_RevocationDuringStartAndAfterAttach(t *testing.T) {
	for _, phase := range []string{"during_start", "after_attach"} {
		t.Run(phase, func(t *testing.T) {
			const tokenHash = "revoked-lsp-token"
			bus := revocation.NewBus(nil, nil)
			withSocketRevocationSource(t, bus)
			proc := newFakeLSPProcess()
			entered := make(chan struct{})
			provider := &fakeBranchLanguageServers{open: func(ctx context.Context) (LSPProcess, error) {
				if phase == "during_start" {
					close(entered)
					<-ctx.Done()
					return nil, ctx.Err()
				}
				go (&fakeLanguageServer{proc: proc}).serve(t)
				return proc, nil
			}}
			manager := NewLSPSessionManager()
			manager.exitWait = 50 * time.Millisecond
			t.Cleanup(manager.Close)
			handler := lspTestHandler(provider, manager)
			seedLSPGrant(handler)
			srv := newLSPTestServer(t, handler, &middleware.AuthInfo{User: &db.User{ID: 1}, IsTokenAuth: true, TokenHash: tokenHash})
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			ws, _, err := dialLSP(ctx, srv.URL, "s1")
			require.NoError(t, err)
			defer ws.CloseNow()
			if phase == "during_start" {
				<-entered
			} else {
				require.NoError(t, ws.Write(ctx, websocket.MessageText, []byte(`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}`)))
				_, _, err = ws.Read(ctx)
				require.NoError(t, err)
			}
			bus.Deliver(revocation.Event{Kind: revocation.KindTokenRevoked, TokenHash: tokenHash, Reason: "token deleted"})
			_, _, err = ws.Read(ctx)
			require.Error(t, err)
			assert.Equal(t, websocket.StatusPolicyViolation, websocket.CloseStatus(err))
			if phase == "after_attach" {
				require.Eventually(t, proc.killed.Load, time.Second, time.Millisecond, "a revoked member's server is killed")
			}
			manager.mu.Lock()
			defer manager.mu.Unlock()
			require.Empty(t, manager.starting)
		})
	}
}

func TestLSPSessionManager_RevokeMatchingCloses1008(t *testing.T) {
	t.Parallel()

	handler, manager, _, _ := relayHandler(t, 0)
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

// handshakeOnlyProcess serves a fixed stdout: what a launch script prints
// before (or instead of) the ready line.
type handshakeOnlyProcess struct {
	*fakeLSPProcess
	stdout io.Reader
}

func (p *handshakeOnlyProcess) Stdout() io.Reader { return p.stdout }

func TestLSPSessionManager_StartBoundsReadyLine(t *testing.T) {
	input := strings.Repeat("x", 2<<20)
	source := strings.NewReader(input)
	fake := newFakeLSPProcess()
	m := NewLSPSessionManager()
	m.exitWait = time.Millisecond
	// The guest exits once the relay closes its stdin, like a real server.
	go func() { _, _ = io.Copy(io.Discard, fake.stdinR); fake.exit(1) }()

	_, err := m.start(context.Background(), "s", "typescript", func(context.Context) (LSPProcess, error) {
		return &handshakeOnlyProcess{fake, source}, nil
	}, revocation.Principal{})
	require.ErrorIs(t, err, errLSPHeaderTooLarge)
	// One bufio fill at most: the 64 KiB reader, never the 2 MiB line.
	assert.LessOrEqual(t, len(input)-source.Len(), 64<<10)
	assert.True(t, fake.killed.Load(), "the launch's session is killed")
	assert.Zero(t, fake.ready.Load())
}

// Two tabs, or a reconnect racing the attach it replaces, start the same
// session id while neither launch has finished. Exactly one server may be
// tracked afterwards and the other must be killed: an untracked server is
// out of reach of Destroy, Close and revocation. The opener deliberately
// ignores its context so the superseded launch completes late.
func TestLSPSessionManager_OverlappingStartsKeepOneLiveServer(t *testing.T) {
	for _, end := range []string{"replace", "destroy", "close"} {
		t.Run(end, func(t *testing.T) {
			entered := make(chan chan struct{}, 2)
			procs := make(chan *fakeLSPProcess, 2)
			open := func(context.Context) (LSPProcess, error) {
				release := make(chan struct{})
				entered <- release
				<-release
				fake := newFakeLSPProcess()
				go (&fakeLanguageServer{proc: fake}).serve(t)
				procs <- fake
				return fake, nil
			}
			m := NewLSPSessionManager()
			m.exitWait = time.Millisecond
			defer m.Close()
			type result struct {
				sess *lspSession
				err  error
			}
			results := make(chan result, 2)
			start := func() {
				s, e := m.start(context.Background(), "same", "typescript", open, revocation.Principal{})
				results <- result{s, e}
			}
			go start()
			first := <-entered
			go start()
			second := <-entered

			close(second)
			winner := <-results
			winnerProc := <-procs
			require.NoError(t, winner.err)
			switch end {
			case "destroy":
				m.Destroy("same", "test")
			case "close":
				m.Close()
			}

			close(first)
			older := <-results
			olderProc := <-procs
			require.Error(t, older.err, "a superseded launch must not publish")
			assert.Nil(t, older.sess)
			require.Eventually(t, olderProc.killed.Load, time.Second, time.Millisecond, "the superseded server is killed")

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
			require.Eventually(t, winnerProc.killed.Load, time.Second, time.Millisecond)
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
