package microsandbox

import (
	"context"
	"fmt"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestMemberSessionCredentialsAndAdmissionFence(t *testing.T) {
	bundle, _ := approvedBundleFixture(t)
	directory := t.TempDir()
	python, err := exec.LookPath("python3")
	require.NoError(t, err)
	binary, log := filepath.Join(directory, "msb"), filepath.Join(directory, "calls")
	require.NoError(t, os.WriteFile(binary, []byte(fmt.Sprintf(`#!%s
import sys,json
args=sys.argv[1:];operands=args[args.index('run')+1:]
with open(%q,'a') as f:f.write(json.dumps([operands,sys.stdin.buffer.read().decode()])+'\n')
`, python, log)), 0700))
	member := MemberIdentity{"ben", 20001, true}
	ws := &workspace{metadata: metadata{ID: "branch-a", Machine: "machine-a", State: "running"}}
	r := &Runtime{config: Config{Bundle: pinned(t, bundle)}, cli: &cli{binary: binary, home: directory}, workspaces: map[string]*workspace{"branch-a": ws}}
	current := []MemberIdentity{member}
	r.BindMemberRoster(func(ctx context.Context, id string, visit func([]MemberIdentity) error) error { return visit(current) })
	credential, err := r.SessionCredentialsForMember(t.Context(), "branch-a", member)
	require.NoError(t, err)
	token := []byte("smithers_member")
	digest := workspaceapi.SessionCredentialIdentity(token)
	path, err := credential.PutSessionToken(t.Context(), "branch-a", "session-a", token, "")
	require.NoError(t, err)
	require.Equal(t, workspaceapi.SessionTokenRoot+"/session-a/token", path)
	body, err := os.ReadFile(log)
	require.NoError(t, err)
	require.Contains(t, string(body), `["put-member-token", "ben", "20001", "session-a", "absent"]`)
	require.Contains(t, string(body), `"smithers_member"`)
	_, err = credential.OpenTerminal(t.Context(), "branch-a", "session-a", digest, workspaceapi.Command{Args: []string{"/bin/sh"}, Environment: map[string]string{"SMITHERS_TOKEN_FILE": path, "SMITHERS_URL": "http://127.0.0.1:4000"}})
	require.Error(t, err, "an unbound daemon must not create a legacy PTY")
	body, err = os.ReadFile(log)
	require.NoError(t, err)
	require.NotContains(t, string(body), "put-session-binding")
	require.NotContains(t, string(body), `"-t"`)
	current = nil
	before := string(body)
	_, err = credential.PutSessionToken(t.Context(), "branch-a", "session-a", []byte("next"), digest)
	require.ErrorIs(t, err, ErrUnavailable)
	body, err = os.ReadFile(log)
	require.NoError(t, err)
	require.Equal(t, before, string(body), "revoked members cannot rotate or provision")
	require.NoError(t, credential.DeleteSessionToken(t.Context(), "branch-a", "session-a", digest), "exact credential cleanup remains possible after revocation")
	body, err = os.ReadFile(log)
	require.NoError(t, err)
	require.Contains(t, string(body), `["delete-member-token", "ben", "20001", "session-a", "`+digest+`"]`)
	before = string(body)
	for _, session := range []string{"../escape", "", strings.Repeat("a", 65)} {
		_, err = credential.PutSessionToken(t.Context(), "branch-a", session, token, "")
		require.Error(t, err)
		require.Error(t, credential.DeleteSessionToken(t.Context(), "branch-a", session, digest))
	}
	body, err = os.ReadFile(log)
	require.NoError(t, err)
	require.Equal(t, before, string(body))
	ws.State = "stopped"
	require.NoError(t, credential.DeleteSessionToken(t.Context(), "branch-a", "session-a", digest))
}
