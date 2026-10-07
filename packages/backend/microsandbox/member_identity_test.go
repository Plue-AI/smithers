package microsandbox

import (
	"context"
	"fmt"
	"github.com/stretchr/testify/require"
	"os"
	"os/exec"
	"path/filepath"
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

func TestMemberProvisioningUsesCurrentSnapshot(t *testing.T) {
	directory := t.TempDir()
	python, err := exec.LookPath("python3")
	require.NoError(t, err)
	binary, log := filepath.Join(directory, "msb"), filepath.Join(directory, "calls")
	require.NoError(t, os.WriteFile(binary, []byte(fmt.Sprintf(`#!%s
import sys
args=sys.argv[1:]
operands=args[args.index('run')+1:]
with open(%q,'a') as f:f.write(' '.join(operands)+'\n')
`, python, log)), 0700))
	r := &Runtime{cli: &cli{binary: binary, home: directory}}
	ben, alice := MemberIdentity{"ben", 20001, true}, MemberIdentity{"alice", 20002, true}
	require.NoError(t, r.provisionMembers(t.Context(), "machine-a", []MemberIdentity{ben, alice}, nil))
	require.NoError(t, r.provisionMembers(t.Context(), "machine-a", []MemberIdentity{ben, alice}, &alice))
	before, err := os.ReadFile(log)
	require.NoError(t, err)
	require.Equal(t, "setup-member ben 20001 account\nsetup-member alice 20002 account\nsetup-member alice 20002 home\n", string(before))
	for _, members := range [][]MemberIdentity{{ben}, {ben, ben}, {ben, {"alice", 20001, true}}, {ben, {"root", 20002, true}}, {ben, {"alice", 20002, false}}} {
		require.ErrorIs(t, r.provisionMembers(t.Context(), "machine-a", members, &alice), ErrUnavailable)
	}
	after, err := os.ReadFile(log)
	require.NoError(t, err)
	require.Equal(t, before, after, "invalid snapshots must have no guest effects")
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	require.Error(t, r.provisionMembers(ctx, "machine-a", []MemberIdentity{ben}, nil))
	r.BindMemberRoster(func(context.Context, string, func([]MemberIdentity) error) error {
		t.Fatal("unapproved helper reached roster")
		return nil
	})
	require.ErrorIs(t, r.prepareMembers(t.Context(), &workspace{}, nil), ErrUnavailable)
	r.BindMemberRoster(nil)
	require.ErrorIs(t, r.prepareMembers(t.Context(), &workspace{}, &ben), ErrUnavailable)
}
