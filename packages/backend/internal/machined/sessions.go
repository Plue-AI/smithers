// Package machined contains host-side machine session contracts.
package machined

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"unicode/utf8"
)

// SessionError names ADR 0004 refusal codes. It is not an HTTP envelope.
type SessionError struct{ Code, Detail string }

func (e *SessionError) Error() string   { return e.Code + ": " + e.Detail }
func refused(code, detail string) error { return &SessionError{Code: code, Detail: detail} }

type SessionUser struct {
	Login string
	UID   uint32
}
type SessionSize struct{ Cols, Rows uint16 }
type SessionKind uint8

const (
	SessionPTY  SessionKind = 1
	SessionExec SessionKind = 2
	SessionSFTP SessionKind = 3
)

// SessionCall mirrors only the six control methods in ADR 0004. The wire
// owner supplies encoding; this seam deliberately does not define a codec.
type SessionCall struct {
	Method   string
	User     *SessionUser
	Kind     SessionKind
	Argv     []string
	Size     *SessionSize
	Port     uint16
	Session  uint32
	Run      string
	Received uint64
}
type SessionResult struct {
	Session  uint32
	Killed   uint16
	Received uint64
}

// SessionRPC must be backed by the authenticated, wake-reconciled host
// connection. The guest dispatcher and root broker independently validate
// trusted provisioning, startup, credentials, environment and user binding.
// There is no implementation until those providers land; nil fails closed.
type SessionRPC interface {
	CallSession(context.Context, SessionCall) (SessionResult, error)
}
type Sessions struct {
	rpc        SessionRPC
	connection *Connection
	branch     string
}

func NewSessions(connection *Connection, branch string, rpc SessionRPC) *Sessions {
	return &Sessions{rpc: rpc, connection: connection, branch: branch}
}

func validUser(user SessionUser) bool {
	if len(user.Login) == 0 || len(user.Login) > 32 {
		return false
	}
	for _, c := range user.Login {
		if !(c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '_' || c == '-') {
			return false
		}
	}
	if user.Login == "root" || user.UID == 0 {
		return false
	}
	if user.Login == "agent" {
		return user.UID == 19999
	}
	return user.UID >= 20000
}
func validString(value string) bool {
	return len(value) <= 4096 && utf8.ValidString(value) && !strings.ContainsRune(value, 0)
}
func validSession(id uint32) bool { return id != 0 && id <= 0x7fffffff }

func (s *Sessions) call(ctx context.Context, call SessionCall) (SessionResult, error) {
	if err := ctx.Err(); err != nil {
		return SessionResult{}, err
	}
	if s == nil || s.rpc == nil {
		return SessionResult{}, refused("unsupported", "session providers unavailable")
	}
	if s.connection == nil || s.connection.registry == nil || s.connection.boot == nil {
		return SessionResult{}, refused("unauthorized", "missing host connection")
	}
	if err := s.connection.RequireReady(s.branch); err != nil {
		if errors.Is(err, ErrNotReady) {
			return SessionResult{}, refused("not_ready", "wake reconciliation required")
		}
		return SessionResult{}, refused("unauthorized", "stale or wrong-branch connection")
	}
	return s.rpc.CallSession(ctx, call)
}

func (s *Sessions) OpenSession(ctx context.Context, user SessionUser, kind SessionKind, argv []string, size *SessionSize) (uint32, error) {
	if !validUser(user) {
		return 0, refused("unauthorized", "invalid session user")
	}
	if kind < SessionPTY || kind > SessionSFTP || len(argv) > 65535 ||
		kind == SessionExec && len(argv) == 0 || kind == SessionSFTP && len(argv) != 0 ||
		size != nil && (kind != SessionPTY || size.Cols == 0 || size.Rows == 0) {
		return 0, refused("malformed", "invalid session request")
	}
	for _, arg := range argv {
		if !validString(arg) {
			return 0, refused("malformed", "invalid argument")
		}
	}
	call := SessionCall{Method: "open_session", User: &user, Kind: kind, Argv: append([]string(nil), argv...)}
	if size != nil {
		copy := *size
		call.Size = &copy
	}
	result, err := s.call(ctx, call)
	if err == nil && !validSession(result.Session) {
		return 0, refused("internal", "invalid session response")
	}
	return result.Session, err
}
func (s *Sessions) TCPConnect(ctx context.Context, port uint16) (uint32, error) {
	if port == 0 {
		return 0, refused("malformed", "invalid loopback port")
	}
	result, err := s.call(ctx, SessionCall{Method: "tcp_connect", Port: port})
	if err == nil && !validSession(result.Session) {
		return 0, refused("internal", "invalid session response")
	}
	return result.Session, err
}
func (s *Sessions) CloseSession(ctx context.Context, id uint32) error {
	if !validSession(id) {
		return refused("malformed", "invalid session id")
	}
	_, err := s.call(ctx, SessionCall{Method: "close_session", Session: id})
	return err
}
func (s *Sessions) KillUser(ctx context.Context, user SessionUser) (uint16, error) {
	if !validUser(user) {
		return 0, refused("unauthorized", "invalid session user")
	}
	result, err := s.call(ctx, SessionCall{Method: "kill_sessions", User: &user})
	return result.Killed, err
}
func (s *Sessions) KillRun(ctx context.Context, run string) (uint16, error) {
	if run == "" || !validString(run) {
		return 0, refused("malformed", "invalid run")
	}
	result, err := s.call(ctx, SessionCall{Method: "kill_sessions", Run: run})
	return result.Killed, err
}
func (s *Sessions) RegisterRun(ctx context.Context, run string, id uint32) error {
	if run == "" || !validString(run) || !validSession(id) {
		return refused("malformed", "invalid run registration")
	}
	_, err := s.call(ctx, SessionCall{Method: "register_run", Run: run, Session: id})
	return err
}
func (s *Sessions) AttachSession(ctx context.Context, id uint32, received uint64) (uint64, error) {
	if !validSession(id) {
		return 0, refused("malformed", "invalid session id")
	}
	result, err := s.call(ctx, SessionCall{Method: "attach_session", Session: id, Received: received})
	if err != nil {
		return 0, fmt.Errorf("attach session: %w", err)
	}
	return result.Received, nil
}
