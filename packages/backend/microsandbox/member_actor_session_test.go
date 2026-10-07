package microsandbox

import (
	"context"
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
)

// Scripted guest effects and an authenticated wire peer isolate host admission
// ordering. Real persistence is exercised by compose's member actor test; this
// is not evidence for installed cgroups or a reference Mac boot.
func TestMemberTerminalCommitsActorBeforeLockedLaunch(t *testing.T) {
	bundle, _ := approvedBundleFixture(t)
	dir := t.TempDir()
	python, err := exec.LookPath("python3")
	require.NoError(t, err)
	binary, log := filepath.Join(dir, "msb"), filepath.Join(dir, "calls")
	require.NoError(t, os.WriteFile(binary, []byte(fmt.Sprintf(`#!%s
import sys,json
args=sys.argv[1:]; operands=args[args.index('run')+1:]
with open(%q,'a') as f: f.write(json.dumps(operands)+'\n')
sys.stdin.buffer.read()
`, python, log)), 0700))
	member := MemberIdentity{"ben", 20001, true}
	r := &Runtime{config: Config{Bundle: pinned(t, bundle)}, cli: &cli{binary: binary, home: dir}, workspaces: map[string]*workspace{"branch-a": {metadata: metadata{ID: "branch-a", Machine: "machine-a", State: "running"}}}}
	registry := &r.machined
	r.BindSecretEnvironment(func(context.Context, string) (MachineSecrets, error) { return MachineSecrets{}, nil })
	r.BindMachinedHost(func(context.Context, string) (string, error) { return "1111111111111111111111111111111111111111", nil })
	stop, consumeErr := registry.ConsumeEvents(t.Context(), func(context.Context, *machined.Link, string, machined.Event) (machined.Acknowledgement, error) {
		return machined.Acknowledgement{}, machined.ErrNotReady
	})
	require.NoError(t, consumeErr)
	t.Cleanup(stop)

	current := []MemberIdentity{member}
	holding := false
	r.BindMemberRoster(func(ctx context.Context, id string, visit func(context.Context, []MemberIdentity) error) error {
		require.False(t, holding)
		holding = true
		defer func() { holding = false }()
		return visit(ctx, current)
	})
	credential, err := r.SessionCredentialsForMember(t.Context(), "branch-a", member)
	require.NoError(t, err)
	authority, err := registry.MintBoot("branch-a", "machine-a")
	require.NoError(t, err)
	host, guest := net.Pipe()
	t.Cleanup(func() { host.Close(); guest.Close(); registry.Close() })
	handshook := make(chan error, 1)
	go func() {
		nonce := make([]byte, 32)
		nonce[0] = 1
		err := wire.Write(guest, wire.Frame{Kind: wire.Hello, Payload: wire.Union(1, wire.Field(1, wire.U32(0x534d4d44)), wire.Field(2, wire.U16(wire.Protocol)), wire.Field(3, authority.ID[:]), wire.Field(4, nonce))})
		if err == nil {
			_, err = wire.Read(guest)
		}
		if err == nil {
			err = wire.Write(guest, wire.Frame{Kind: wire.Hello, Payload: wire.Union(3, wire.Field(1, wire.Bytes([]byte(authority.Credential))), wire.Field(2, make([]byte, 16)), wire.Field(3, wire.U64(1)), wire.Field(4, wire.U16(0)))})
		}
		if err == nil {
			_, err = wire.Read(guest)
		}
		handshook <- err
	}()
	link, err := registry.Connect(t.Context(), "branch-a", host)
	require.NoError(t, err)
	require.NoError(t, <-handshook)
	require.NoError(t, link.Reconciled())
	require.NoError(t, link.Connection.RequireMachine("branch-a", "machine-a"))
	require.ErrorIs(t, link.Connection.RequireMachine("branch-a", "other-machine"), machined.ErrUnauthorized)
	reference := []byte("actor-reference1")
	commits := 0
	r.BindMemberActor(func(ctx context.Context, branch, machine string, got MemberIdentity, via string) ([]byte, error) {
		require.False(t, holding, "commit must not wait for a connection inside the roster transaction")
		require.Equal(t, "branch-a", branch)
		require.Equal(t, "machine-a", machine)
		require.Equal(t, member, got)
		require.Equal(t, "terminal", via)
		commits++
		return reference, nil
	})
	command := workspaceapi.Command{Args: []string{"/bin/sh"}, Environment: map[string]string{"SMITHERS_TOKEN_FILE": "/run/smithers/20001/token/sessions/session-a/token", "SMITHERS_URL": "http://127.0.0.1:4000"}}
	digest := workspaceapi.SessionCredentialIdentity([]byte("smithers_member"))
	type opened struct {
		terminal workspaceapi.Terminal
		err      error
	}
	result := make(chan opened, 1)
	go func() {
		terminal, err := credential.OpenTerminal(t.Context(), "branch-a", "session-a", digest, command)
		result <- opened{terminal, err}
	}()
	require.NoError(t, guest.SetReadDeadline(time.Now().Add(5*time.Second)))
	request, err := wire.Read(guest)
	require.NoError(t, err)
	id, method, args, err := request.Request()
	require.NoError(t, err)
	require.Equal(t, byte(wire.OpenSession), method)
	fields, err := wire.Fields("args6", args)
	require.NoError(t, err)
	require.Equal(t, reference, fields[5])
	require.Nil(t, fields[6])
	require.NoError(t, wire.Write(guest, wire.Frame{Kind: wire.Control, Payload: wire.Union(2, wire.Field(1, wire.U32(id)), wire.Field(2, wire.Union(byte(wire.OpenSession), wire.Field(1, wire.U32(1)))))}))
	first := <-result
	require.NoError(t, first.err)
	require.Equal(t, 1, commits)
	require.False(t, holding)
	before, err := os.ReadFile(log)
	require.NoError(t, err)
	require.Contains(t, string(before), "put-session-binding")
	denied := errors.New("attribution commit failed")
	r.BindMemberActor(func(context.Context, string, string, MemberIdentity, string) ([]byte, error) { return nil, denied })
	_, err = credential.OpenTerminal(t.Context(), "branch-a", "session-a", digest, command)
	require.ErrorIs(t, err, denied)
	after, err := os.ReadFile(log)
	require.NoError(t, err)
	require.Equal(t, 1, strings.Count(string(after), "put-session-binding"), "failed commit must not prepare another session")
	// Removal after COMMIT but before the held roster read also refuses launch.
	r.BindMemberActor(func(context.Context, string, string, MemberIdentity, string) ([]byte, error) {
		current = nil
		return reference, nil
	})
	_, err = credential.OpenTerminal(t.Context(), "branch-a", "session-a", digest, command)
	require.ErrorIs(t, err, ErrUnavailable)
	require.NoError(t, guest.SetReadDeadline(time.Now().Add(30*time.Millisecond)))
	_, err = wire.Read(guest)
	require.Error(t, err, "neither refused call may send a launch")
	require.NoError(t, guest.Close())
	require.NoError(t, link.Close())
	_ = first.terminal.Close()
	r.BindMemberActor(nil)
	current = []MemberIdentity{member}
	before, err = os.ReadFile(log)
	require.NoError(t, err)
	_, err = credential.OpenTerminal(t.Context(), "branch-a", "session-a", digest, command)
	require.ErrorIs(t, err, ErrUnavailable)
	after, err = os.ReadFile(log)
	require.NoError(t, err)
	require.Equal(t, string(before), string(after), "missing actor provider must refuse before guest effects")
}
