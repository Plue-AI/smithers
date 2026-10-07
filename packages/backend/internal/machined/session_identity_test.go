package machined

import (
	"github.com/stretchr/testify/require"
	"testing"
)

func TestSessionIdentityRequiresHostBinding(t *testing.T) {
	_, err := (*Link)(nil).SessionIdentity(t.Context(), 1)
	require.ErrorIs(t, err, ErrNotReady)
	link := &Link{sessions: map[uint32]*SessionStream{1: {}}}
	_, err = link.SessionIdentity(t.Context(), 2)
	require.ErrorIs(t, err, ErrUnauthorized)
	_, err = link.SessionIdentity(t.Context(), 1)
	require.ErrorIs(t, err, ErrNotReady)
	member := SessionUser{"alice", 20001}
	link.sessions[1].user = &member
	got, err := link.SessionIdentity(t.Context(), 1)
	require.NoError(t, err)
	require.Equal(t, member, got)
	got.Login = "mallory"
	again, err := link.SessionIdentity(t.Context(), 1)
	require.NoError(t, err)
	require.Equal(t, "alice", again.Login)
}
