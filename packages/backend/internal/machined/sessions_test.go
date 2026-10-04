package machined

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"
)

type sessionRPCFunc func(context.Context, SessionCall) (SessionResult, error)

func (f sessionRPCFunc) CallSession(ctx context.Context, call SessionCall) (SessionResult, error) {
	return f(ctx, call)
}
func errorCode(t *testing.T, err error, code string) {
	t.Helper()
	var refusal *SessionError
	if !errors.As(err, &refusal) || refusal.Code != code {
		t.Fatalf("expected %s, got %v", code, err)
	}
	if !strings.HasPrefix(refusal.Error(), code+": ") {
		t.Fatal(refusal.Error())
	}
}

func TestSessionClientUnavailable(t *testing.T) {
	// This is host-client refusal evidence, not the pending C-COL-04 production
	// root-dispatch TestSessionAdmissionFailsClosed integration receipt.
	ctx := context.Background()
	for _, s := range []*Sessions{nil, NewSessions(nil, "", nil)} {
		_, err := s.OpenSession(ctx, SessionUser{"alice", 20002}, SessionPTY, nil, nil)
		errorCode(t, err, "unsupported")
		_, err = s.TCPConnect(ctx, 3000)
		errorCode(t, err, "unsupported")
		errorCode(t, s.CloseSession(ctx, 1), "unsupported")
		_, err = s.KillUser(ctx, SessionUser{"alice", 20002})
		errorCode(t, err, "unsupported")
		_, err = s.KillRun(ctx, "run-1")
		errorCode(t, err, "unsupported")
		errorCode(t, s.RegisterRun(ctx, "run-1", 1), "unsupported")
		_, err = s.AttachSession(ctx, 1, 0)
		errorCode(t, err, "unsupported")
	}
}

func TestSessionClientRejectsBeforeTransport(t *testing.T) {
	s := testSessions(t, sessionRPCFunc(func(context.Context, SessionCall) (SessionResult, error) {
		t.Fatal("transport called")
		return SessionResult{}, nil
	}))
	ctx := context.Background()
	for _, user := range []SessionUser{{"", 20000}, {strings.Repeat("a", 33), 20000}, {"../x", 20000}, {"Alice", 20000}, {"alice", 0}, {"root", 20000}, {"alice", 19999}, {"agent", 20000}, {"agent", 0}, {"alice", 19998}} {
		_, err := s.OpenSession(ctx, user, SessionPTY, nil, nil)
		errorCode(t, err, "unauthorized")
		_, err = s.KillUser(ctx, user)
		errorCode(t, err, "unauthorized")
	}
	user := SessionUser{"alice", 20002}
	for _, tc := range []struct {
		kind SessionKind
		argv []string
		size *SessionSize
	}{
		{0, nil, nil}, {4, nil, nil}, {SessionExec, nil, nil}, {SessionExec, []string{"x"}, &SessionSize{1, 1}},
		{SessionSFTP, []string{"x"}, nil}, {SessionPTY, nil, &SessionSize{0, 1}}, {SessionPTY, nil, &SessionSize{1, 0}},
		{SessionPTY, []string{"\x00"}, nil}, {SessionPTY, []string{"\xff"}, nil}, {SessionPTY, []string{strings.Repeat("a", 4097)}, nil},
		{SessionPTY, make([]string, 65536), nil},
	} {
		_, err := s.OpenSession(ctx, user, tc.kind, tc.argv, tc.size)
		errorCode(t, err, "malformed")
	}
	_, err := s.TCPConnect(ctx, 0)
	errorCode(t, err, "malformed")
	for _, id := range []uint32{0, 0x80000000, 0xffffffff} {
		errorCode(t, s.CloseSession(ctx, id), "malformed")
		errorCode(t, s.RegisterRun(ctx, "r", id), "malformed")
		_, err = s.AttachSession(ctx, id, 0)
		errorCode(t, err, "malformed")
	}
	for _, run := range []string{"", "\x00", "\xff", strings.Repeat("a", 4097)} {
		_, err = s.KillRun(ctx, run)
		errorCode(t, err, "malformed")
		errorCode(t, s.RegisterRun(ctx, run, 1), "malformed")
	}
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	_, err = s.TCPConnect(cancelled, 1)
	if !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
}

func TestSessionClientLiteralCallsAndResponses(t *testing.T) {
	ctx := context.Background()
	user := SessionUser{"a0_-", 20000}
	size := SessionSize{65535, 1}
	var calls []SessionCall
	s := testSessions(t, sessionRPCFunc(func(_ context.Context, call SessionCall) (SessionResult, error) {
		calls = append(calls, call)
		return SessionResult{Session: 0x7fffffff, Killed: 3, Received: 262144}, nil
	}))
	argv := []string{"/bin/bash", "-l"}
	id, err := s.OpenSession(ctx, user, SessionPTY, argv, &size)
	if err != nil || id != 0x7fffffff {
		t.Fatal(id, err)
	}
	argv[0] = "changed"
	size.Cols = 1
	if _, err = s.OpenSession(ctx, SessionUser{"agent", 19999}, SessionExec, []string{"/bin/true"}, nil); err != nil {
		t.Fatal(err)
	}
	if _, err = s.OpenSession(ctx, user, SessionSFTP, nil, nil); err != nil {
		t.Fatal(err)
	}
	if _, err = s.TCPConnect(ctx, 65535); err != nil {
		t.Fatal(err)
	}
	if err = s.CloseSession(ctx, 1); err != nil {
		t.Fatal(err)
	}
	if n, e := s.KillUser(ctx, user); e != nil || n != 3 {
		t.Fatal(n, e)
	}
	if n, e := s.KillRun(ctx, "run-1"); e != nil || n != 3 {
		t.Fatal(n, e)
	}
	if err = s.RegisterRun(ctx, "run-1", 1); err != nil {
		t.Fatal(err)
	}
	if n, e := s.AttachSession(ctx, 1, 123); e != nil || n != 262144 {
		t.Fatal(n, e)
	}
	agent := SessionUser{"agent", 19999}
	expected := []SessionCall{
		{Method: "open_session", User: &user, Kind: 1, Argv: []string{"/bin/bash", "-l"}, Size: &SessionSize{65535, 1}},
		{Method: "open_session", User: &agent, Kind: 2, Argv: []string{"/bin/true"}},
		{Method: "open_session", User: &user, Kind: 3},
		{Method: "tcp_connect", Port: 65535}, {Method: "close_session", Session: 1},
		{Method: "kill_sessions", User: &user}, {Method: "kill_sessions", Run: "run-1"},
		{Method: "register_run", Run: "run-1", Session: 1}, {Method: "attach_session", Session: 1, Received: 123},
	}
	if !reflect.DeepEqual(calls, expected) {
		t.Fatalf("calls: %#v", calls)
	}
}

func TestSessionClientTransportErrorsAndBadResponses(t *testing.T) {
	ctx := context.Background()
	user := SessionUser{"alice", 20002}
	failure := errors.New("connection dropped")
	s := testSessions(t, sessionRPCFunc(func(context.Context, SessionCall) (SessionResult, error) { return SessionResult{}, failure }))
	_, err := s.OpenSession(ctx, user, SessionPTY, nil, nil)
	if !errors.Is(err, failure) {
		t.Fatal(err)
	}
	_, err = s.TCPConnect(ctx, 1)
	if !errors.Is(err, failure) {
		t.Fatal(err)
	}
	_, err = s.AttachSession(ctx, 1, 0)
	if !errors.Is(err, failure) {
		t.Fatal(err)
	}
	for _, id := range []uint32{0, 0x80000000} {
		s = testSessions(t, sessionRPCFunc(func(context.Context, SessionCall) (SessionResult, error) { return SessionResult{Session: id}, nil }))
		_, err = s.OpenSession(ctx, user, SessionPTY, nil, nil)
		errorCode(t, err, "internal")
		_, err = s.TCPConnect(ctx, 1)
		errorCode(t, err, "internal")
	}
}

func testSessions(t *testing.T, rpc SessionRPC) *Sessions {
	t.Helper()
	var registry Registry
	if err := registry.BindBoot("branch", "machine", [16]byte{1}, []byte("credential")); err != nil {
		t.Fatal(err)
	}
	connection, err := registry.Admit([16]byte{1}, []byte("credential"), new(testStream))
	if err != nil {
		t.Fatal(err)
	}
	if err = connection.Reconciled(); err != nil {
		t.Fatal(err)
	}
	return NewSessions(connection, "branch", rpc)
}

func TestSessionClientConnectionFences(t *testing.T) {
	rpc := sessionRPCFunc(func(context.Context, SessionCall) (SessionResult, error) {
		t.Fatal("unready transport called")
		return SessionResult{}, nil
	})
	for _, connection := range []*Connection{nil, {}} {
		_, err := NewSessions(connection, "branch", rpc).TCPConnect(context.Background(), 1)
		errorCode(t, err, "unauthorized")
	}
	s := testSessions(t, rpc)
	s.connection.registry.mu.Lock()
	s.connection.ready = false
	s.connection.registry.mu.Unlock()
	_, err := s.TCPConnect(context.Background(), 1)
	errorCode(t, err, "not_ready")
	if err = s.connection.Reconciled(); err != nil {
		t.Fatal(err)
	}
	s.branch = "other"
	_, err = s.TCPConnect(context.Background(), 1)
	errorCode(t, err, "unauthorized")
	s.branch = "branch"
	if err = s.connection.Close(); err != nil {
		t.Fatal(err)
	}
	_, err = s.TCPConnect(context.Background(), 1)
	errorCode(t, err, "unauthorized")
}
