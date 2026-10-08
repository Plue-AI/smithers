package machined

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
	"github.com/stretchr/testify/require"
	"testing"
)

type failingReceiptStore struct{}

func (failingReceiptStore) Record(context.Context, string, [16]byte, uint32, SessionUser, string) error {
	return errors.New("receipt refused")
}
func (failingReceiptStore) Lookup(context.Context, string, [16]byte, uint32) (SessionUser, error) {
	return SessionUser{}, ErrNotReady
}
func (failingReceiptStore) Attribution(context.Context, string, [16]byte, uint32) (json.RawMessage, error) {
	return nil, ErrNotReady
}
func TestSessionReceiptFailureConfirmsKillBeforeLinkClose(t *testing.T) {
	r := new(Registry)
	r.BindSessionIdentities(failingReceiptStore{})
	authority, err := r.MintBoot("a", "vm")
	require.NoError(t, err)
	l, peer := connectTest(t, r, "a", authority)
	require.NoError(t, l.Reconciled())
	done := make(chan error, 1)
	go func() {
		_, err := r.Sessions("a").CallSession(t.Context(), SessionCall{Method: "open_session", Actor: []byte("actor-reference1"), User: &SessionUser{"alice", 20001}, Kind: SessionExec, Argv: []string{"sleep", "100"}})
		done <- err
	}()
	answer(t, peer, wire.OpenSession, wire.Field(1, wire.U32(17)))
	answer(t, peer, wire.KillSessions, wire.Field(1, wire.U16(1)))
	answer(t, peer, wire.CloseSession)
	require.ErrorContains(t, <-done, "receipt refused")
	require.Error(t, l.RequireReady("a"))
}

func TestSessionCleanupDoesNotFenceReplacementBoot(t *testing.T) {
	r, l, _, _, _ := sessionFixture(t)
	old := NewSessions(l.Connection, "a", r.Sessions("a"))
	boot, err := r.MintBoot("a", "replacement")
	require.NoError(t, err)
	replacement, _ := connectTest(t, r, "a", boot)
	require.NoError(t, replacement.Reconciled())
	require.NoError(t, old.CloseConnection())
	current, err := r.Current("a")
	require.NoError(t, err)
	require.Same(t, replacement, current)
	require.NoError(t, replacement.RequireReady("a"))
	require.ErrorIs(t, (*Sessions)(nil).CloseConnection(), ErrNotReady)
	require.ErrorIs(t, NewSessions(nil, "a", nil).CloseConnection(), ErrNotReady)
}

type runReceiptStore struct {
	failingReceiptStore
	recordRun func(context.Context, string, [16]byte, uint32, string) error
}

func (*runReceiptStore) Record(context.Context, string, [16]byte, uint32, SessionUser, string) error {
	return nil
}
func (s *runReceiptStore) RecordRun(ctx context.Context, branch string, boot [16]byte, session uint32, run string) error {
	return s.recordRun(ctx, branch, boot, session, run)
}

func TestRunRegistrationReceiptRequiresDaemonAcknowledgement(t *testing.T) {
	r := new(Registry)
	calls := 0
	failure := errors.New("registration receipt unavailable")
	var storedError error
	receipts := &runReceiptStore{recordRun: func(_ context.Context, branch string, boot [16]byte, session uint32, run string) error {
		calls++
		require.Equal(t, "a", branch)
		require.NotEqual(t, [16]byte{}, boot)
		require.Equal(t, uint32(7), session)
		require.Equal(t, "11111111-1111-4111-8111-111111111111", run)
		return storedError
	}}
	r.BindSessionIdentities(receipts)
	authority, err := r.MintBoot("a", "vm")
	require.NoError(t, err)
	link, guest := connectTest(t, r, "a", authority)
	require.NoError(t, link.Reconciled())
	sessions := NewSessions(link.Connection, "a", r.Sessions("a")).WithActor([]byte("actor-reference1"), "11111111-1111-4111-8111-111111111111").WithPresenceVia("agent:11111111-1111-4111-8111-111111111111")
	done := make(chan error, 1)
	go func() {
		_, err := sessions.OpenSession(t.Context(), SessionUser{"agent", 19999}, SessionExec, []string{"coding-host"}, nil)
		done <- err
	}()
	answer(t, guest, wire.OpenSession, wire.Field(1, wire.U32(7)))
	require.NoError(t, <-done)
	require.Zero(t, calls)
	go func() { done <- sessions.RegisterRun(t.Context(), "11111111-1111-4111-8111-111111111111", 7) }()
	// A daemon refusal is not a receipt, even though OpenSession succeeded.
	frame, err := wire.Read(guest)
	require.NoError(t, err)
	id, method, _, err := frame.Request()
	require.NoError(t, err)
	require.Equal(t, byte(wire.RegisterRun), method)
	require.NoError(t, wire.Write(guest, wire.Frame{Kind: wire.Control, Payload: wire.Union(2, wire.Field(1, wire.U32(id)), wire.Field(2, wire.Union(255, wire.Field(1, []byte{11}))))}))
	require.Error(t, <-done)
	require.Zero(t, calls)
	storedError = failure
	go func() { done <- sessions.RegisterRun(t.Context(), "11111111-1111-4111-8111-111111111111", 7) }()
	answer(t, guest, wire.RegisterRun)
	require.ErrorIs(t, <-done, failure)
	require.Equal(t, 1, calls)
	storedError = nil
	go func() { done <- sessions.RegisterRun(t.Context(), "11111111-1111-4111-8111-111111111111", 7) }()
	answer(t, guest, wire.RegisterRun)
	require.NoError(t, <-done)
	require.Equal(t, 2, calls)
}
