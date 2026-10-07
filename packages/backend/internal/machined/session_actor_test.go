package machined

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
	"github.com/stretchr/testify/require"
)

func TestSessionAttributionRequiredBeforeTransport(t *testing.T) {
	s := testSessions(t, sessionRPCFunc(func(context.Context, SessionCall) (SessionResult, error) {
		t.Fatal("unattributed request reached transport")
		return SessionResult{}, nil
	}))
	for _, reference := range [][]byte{nil, make([]byte, 16), []byte("short"), make([]byte, 17)} {
		_, err := s.WithActor(reference, "").OpenSession(t.Context(), SessionUser{"maya", 20001}, SessionPTY, nil, nil)
		errorCode(t, err, "unauthorized")
		_, err = s.WithActor(reference, "").TCPConnect(t.Context(), 8080)
		errorCode(t, err, "unauthorized")
	}
	for _, tc := range []struct {
		user SessionUser
		run  string
	}{
		{SessionUser{"maya", 20001}, "forged-run"}, {SessionUser{"agent", 19999}, ""}, {SessionUser{"agent", 19999}, " run "},
	} {
		_, err := s.WithActor([]byte("actor-reference1"), tc.run).OpenSession(t.Context(), tc.user, SessionPTY, nil, nil)
		errorCode(t, err, "unauthorized")
	}
}

func TestSessionAttributionCopiedAndRunBoundBeforeLaunch(t *testing.T) {
	reference := []byte("actor-reference1")
	s := testSessions(t, sessionRPCFunc(func(_ context.Context, call SessionCall) (SessionResult, error) {
		require.Equal(t, []byte("actor-reference1"), call.Actor)
		require.Equal(t, "coding-run", call.Run)
		return SessionResult{Session: 7}, nil
	})).WithActor(reference, "coding-run")
	reference[0] = 'x'
	_, err := s.OpenSession(t.Context(), SessionUser{"agent", 19999}, SessionExec, []string{"codex"}, nil)
	require.NoError(t, err)
}

func TestSessionAttributionOlderLivePeerRefusedWithoutSending(t *testing.T) {
	r, link, _ := rpcFixture(t)
	for _, version := range []uint16{1, 2} {
		link.protocol = version // fixture is idle; production protocol is immutable
		_, err := NewSessions(link.Connection, "a", r.Sessions("a")).WithActor([]byte("actor-reference1"), "").OpenSession(t.Context(), SessionUser{"maya", 20001}, SessionPTY, nil, nil)
		errorCode(t, err, "unsupported")
	}
}

func TestCommittedSessionActorSurvivesLostLaunchReply(t *testing.T) {
	pool, branch, _ := machineReceiptDatabase(t)
	ctx := t.Context()
	_, err := pool.Exec(ctx, `UPDATE workspaces SET vm_id='machine' WHERE id=$1`, branch)
	require.NoError(t, err)
	actor := ActorIdentity{Kind: "person", MemberID: 1, Via: "terminal"}
	ref, err := CommitActor(ctx, pool, branch, "machine", func(context.Context, pgx.Tx) (ActorIdentity, error) { return actor, nil })
	require.NoError(t, err)
	r := new(Registry)
	boot, err := r.MintBoot(branch, "machine")
	require.NoError(t, err)
	link, guest := connectTest(t, r, branch, boot)
	require.NoError(t, link.Reconciled())
	done := make(chan error, 1)
	go func() {
		_, err := NewSessions(link.Connection, branch, r.Sessions(branch)).WithActor(ref, "").OpenSession(ctx, SessionUser{"maya", 20001}, SessionPTY, nil, nil)
		done <- err
	}()
	request, err := wire.Read(guest)
	require.NoError(t, err)
	_, method, body, err := request.Request()
	require.NoError(t, err)
	require.Equal(t, byte(wire.OpenSession), method)
	fields, err := wire.Fields("args6", body)
	require.NoError(t, err)
	require.Equal(t, ref, fields[5])
	// Machine received the admission and may have spawned, but the reply is lost.
	require.NoError(t, guest.Close())
	require.Error(t, <-done)
	require.NoError(t, link.Close())
	tx, err := pool.Begin(ctx)
	require.NoError(t, err)
	retained, err := ResolveActorInTx(ctx, tx, branch, "machine", fields[5])
	require.NoError(t, err)
	require.Equal(t, actor, retained)
	require.NoError(t, tx.Rollback(ctx))
	require.ErrorIs(t, link.Connection.RequireMachine(branch, "replacement"), ErrUnauthorized)
}
