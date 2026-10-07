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
