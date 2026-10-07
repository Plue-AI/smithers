package microsandbox

import (
	"context"
	"errors"
	"fmt"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
	"github.com/stretchr/testify/require"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

// An authenticated synthetic peer exercises the host envelope; this is not a
// root-backed VM receipt. Real ownership/drop checks remain in the root suite.
func environmentLink(t *testing.T, r *machined.Registry) (*machined.Link, net.Conn) {
	t.Helper()
	a, err := r.MintBoot("branch", "machine")
	require.NoError(t, err)
	host, peer := net.Pipe()
	t.Cleanup(func() { host.Close(); peer.Close() })
	done := make(chan error, 1)
	go func() {
		nonce := make([]byte, 32)
		if err := wire.Write(peer, wire.Frame{Kind: wire.Hello, Payload: wire.Union(1, wire.Field(1, wire.U32(0x534d4d44)), wire.Field(2, wire.U16(wire.Protocol)), wire.Field(3, a.ID[:]), wire.Field(4, nonce))}); err != nil {
			done <- err
			return
		}
		proof, err := wire.Read(peer)
		if err != nil {
			done <- err
			return
		}
		fields, err := wire.Fields("proof", proof.Payload[1:])
		if err != nil || !wire.VerifyHostMAC(a.Secret[:], a.ID[:], nonce, fields[2]) {
			done <- wire.AuthFailed
			return
		}
		if err = wire.Write(peer, wire.Frame{Kind: wire.Hello, Payload: wire.Union(3, wire.Field(1, wire.Bytes([]byte(a.Credential))), wire.Field(2, make([]byte, 16)), wire.Field(3, wire.U64(1)), wire.Field(4, wire.U16(0)))}); err != nil {
			done <- err
			return
		}
		_, err = wire.Read(peer)
		done <- err
	}()
	link, err := r.Connect(t.Context(), "branch", host)
	require.NoError(t, err)
	require.NoError(t, <-done)
	t.Cleanup(func() { link.Close() })
	return link, peer
}
func TestSecretEnvironmentAuthenticatedLiteralRotation(t *testing.T) {
	bundle, _ := approvedBundleFixture(t)
	directory := t.TempDir()
	python, err := exec.LookPath("python3")
	require.NoError(t, err)
	binary, log := filepath.Join(directory, "msb"), filepath.Join(directory, "calls")
	require.NoError(t, os.WriteFile(binary, []byte(fmt.Sprintf(`#!%s
import sys,json
with open(%q,'a') as f:f.write(json.dumps([sys.argv[1:],sys.stdin.buffer.read().decode()])+'\n')
`, python, log)), 0700))
	ws := &workspace{metadata: metadata{ID: "branch", Machine: "machine", State: "running"}}
	r := &Runtime{config: Config{Bundle: pinned(t, bundle)}, cli: &cli{binary: binary, home: directory}, workspaces: map[string]*workspace{"branch": ws}}
	r.BindMemberRoster(func(context.Context, string, func(context.Context, []MemberIdentity) error) error { return nil })
	r.BindMachinedHost(func(context.Context, string) (string, error) { return "", nil })
	stopEvents, err := r.machined.ConsumeEvents(t.Context(), func(context.Context, *machined.Link, string, machined.Event) (machined.Acknowledgement, error) {
		return machined.Acknowledgement{}, nil
	})
	require.NoError(t, err)
	t.Cleanup(stopEvents)
	env := map[string]string{"SECRET": "$(touch /tmp/never) `literal`\nnext"}
	var failure error
	r.BindSecretEnvironment(func(context.Context, string) (map[string]string, error) { return env, failure })
	require.True(t, r.SecretEnvironmentAvailable())
	link, _ := environmentLink(t, &r.machined)
	require.ErrorIs(t, r.syncSecretEnvironment(t.Context(), ws, link), machined.ErrNotReady)
	_, err = os.Stat(log)
	require.True(t, os.IsNotExist(err))
	require.NoError(t, link.Reconciled())
	require.NoError(t, r.syncSecretEnvironment(t.Context(), ws, link))
	first, err := os.ReadFile(log)
	require.NoError(t, err)
	require.Contains(t, string(first), "put-env")
	require.Contains(t, string(first), "literal")
	require.NoError(t, r.syncSecretEnvironment(t.Context(), ws, link))
	same, err := os.ReadFile(log)
	require.NoError(t, err)
	require.Equal(t, first, same)
	failure = errors.New("source unavailable")
	env = map[string]string{"SECRET": "replacement"}
	require.Error(t, r.syncSecretEnvironment(t.Context(), ws, link))
	same, err = os.ReadFile(log)
	require.NoError(t, err)
	require.Equal(t, first, same)
	failure = nil
	require.NoError(t, r.syncSecretEnvironment(t.Context(), ws, link))
	second, err := os.ReadFile(log)
	require.NoError(t, err)
	require.Contains(t, string(second), "replacement")
	env = nil
	require.NoError(t, r.syncSecretEnvironment(t.Context(), ws, link))
	third, err := os.ReadFile(log)
	require.NoError(t, err)
	require.Contains(t, string(third), `"{}"`)
	r.BindMemberRoster(nil)
	require.False(t, r.SecretEnvironmentAvailable())
	require.ErrorIs(t, r.syncSecretEnvironment(t.Context(), ws, link), ErrUnavailable)
	same, err = os.ReadFile(log)
	require.NoError(t, err)
	require.Equal(t, third, same)
}
