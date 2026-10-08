package machined

import (
	"encoding/binary"
	"strings"
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
	"github.com/stretchr/testify/require"
)

// Exercises the authenticated production host dispatcher, not a mock SessionRPC.
// This is host-boundary evidence; actual privilege drop and root-owned sentinel
// observations remain required on the approved image for C-COL-04 activation.
func TestMachinedRootBrokerInputs(t *testing.T) {
	r, link, peer := rpcFixture(t)
	sessions := NewSessions(link.Connection, "a", r.Sessions("a")).WithActor([]byte("actor-reference1"), "")
	for _, user := range []SessionUser{{"root", 0}, {"alice", 0}, {"../../root", 20001}, {"agent", 20001}, {"machined", 19998}} {
		_, err := sessions.OpenSession(t.Context(), user, SessionExec, []string{"/workspace/evil"}, nil)
		require.Error(t, err)
	}

	// Each malformed envelope must refuse before the first privileged RPC.
	for _, argv := range [][]string{nil, {strings.Repeat("x", 4097)}, {"nul\x00argument"}, {string([]byte{0xff})}, make([]string, 65536)} {
		session, err := sessions.OpenSession(t.Context(), SessionUser{"alice", 20001}, SessionExec, argv, nil)
		require.Zero(t, session)
		var refusal *SessionError
		require.ErrorAs(t, err, &refusal)
		require.Equal(t, "malformed", refusal.Code)
	}
	require.Error(t, sessions.RegisterRun(t.Context(), "forged-run", 17))
	require.Error(t, sessions.RegisterRun(t.Context(), "forged-run", 0xffffffff))
	_, err := sessions.WithPresenceVia("../../cgroup/root").OpenSession(t.Context(), SessionUser{"alice", 20001}, SessionExec, []string{"/workspace/evil"}, nil)
	require.Error(t, err)
	// Branch executable and hostile environment text are data in argv. They must
	// carry the member identity; neither can become a privileged broker option.
	done := make(chan error, 1)
	go func() {
		_, err := sessions.OpenSession(t.Context(), SessionUser{"alice", 20001}, SessionExec, []string{"/workspace/evil", "LD_PRELOAD=/workspace/evil.so", "../../cgroup/root"}, nil)
		done <- err
	}()
	frame, err := wire.Read(peer)
	require.NoError(t, err)
	id, method, args, err := frame.Request()
	require.NoError(t, err)
	require.Equal(t, byte(wire.OpenSession), method, "refused inputs emitted no earlier request")
	fields, err := wire.Fields("args6", args)
	require.NoError(t, err)
	user, err := wire.Fields("user", fields[1])
	require.NoError(t, err)
	require.Equal(t, wire.String("alice"), user[1])
	require.Equal(t, uint32(20001), binary.BigEndian.Uint32(user[2]))
	require.Equal(t, []byte("actor-reference1"), fields[5])
	require.Len(t, fields, 4, "no environment, cgroup, or run authority fields")
	require.Contains(t, string(fields[3]), "LD_PRELOAD=/workspace/evil.so")
	require.NoError(t, wire.Write(peer, wire.Frame{Kind: wire.Control, Payload: wire.Union(2, wire.Field(1, wire.U32(id)), wire.Field(2, wire.Union(byte(wire.OpenSession), wire.Field(1, wire.U32(17)))))}))
	require.NoError(t, <-done)
	require.Error(t, sessions.RegisterRun(t.Context(), "forged-run", 17), "member session cannot become a run")
}
