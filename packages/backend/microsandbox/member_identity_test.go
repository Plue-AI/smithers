package microsandbox

import (
	"context"
	"github.com/stretchr/testify/require"
	"strings"
	"testing"
)

func TestMemberIdentityContract(t *testing.T) {
	for _, member := range []MemberIdentity{{"ben", 20001, true}, {"alice", 20002, true}} {
		identity, err := member.SessionIdentity()
		require.NoError(t, err)
		require.Equal(t, member.UID, identity.UID)
		require.Equal(t, member.UID, identity.GID)
		require.Equal(t, []int{20000}, identity.Groups)
		require.Equal(t, uint32(0002), identity.Umask)
		require.Equal(t, map[string]string{"HOME": "/home/" + member.Login, "USER": member.Login, "LOGNAME": member.Login}, identity.Environment)
		// A valid binding cannot bypass the missing production consumers. A zero
		// runtime has no CLI; any accidental VM effect would panic this test.
		identity, err = (&Runtime{}).EnsureMember(t.Context(), "branch-a", member)
		require.ErrorIs(t, err, ErrUnavailable)
		require.Equal(t, SessionIdentity{}, identity)
	}
	for _, member := range []MemberIdentity{{"ben", 0, true}, {"ben", 19999, true}, {"ben", 2147483648, true}, {"ben", 20001, false}, {"root", 20001, true}, {"agent", 20001, true}, {"machined", 20001, true}, {"Ben", 20001, true}, {"../ben", 20001, true}, {strings.Repeat("b", 33), 20001, true}, {"", 20001, true}} {
		_, err := member.SessionIdentity()
		require.ErrorIs(t, err, ErrUnavailable)
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	_, err := (&Runtime{}).EnsureMember(ctx, "branch-a", MemberIdentity{"ben", 20001, true})
	require.ErrorIs(t, err, context.Canceled)
}

func TestMemberLoginAllocation(t *testing.T) {
	used := map[string]bool{}
	for _, tc := range []struct{ github, want string }{{"Ben-Smith", "ben-smith"}, {"ben_smith", "ben_smith"}, {strings.Repeat("b", 39), strings.Repeat("b", 32)}, {strings.Repeat("b", 38) + "c", strings.Repeat("b", 31) + "2"}, {"root", "root2"}, {"agent", "agent2"}, {"machined", "machined2"}, {"B.E.N", "ben"}, {"ben", "ben2"}} {
		login, err := AllocateMemberLogin(tc.github, used)
		require.NoError(t, err)
		require.Equal(t, tc.want, login)
		used[login] = true
	}
	_, err := AllocateMemberLogin("...", used)
	require.Error(t, err)
	// Historical assignments remain occupied after revocation.
	login, err := AllocateMemberLogin("ben", used)
	require.NoError(t, err)
	require.Equal(t, "ben3", login)
}
