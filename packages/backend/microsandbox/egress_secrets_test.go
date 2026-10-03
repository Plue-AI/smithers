package microsandbox

import (
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/egressrelay"
	"github.com/smithersai/smithers/packages/backend/sandbox"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/smithersai/smithers/packages/backend/workspaceconformance"
)

// egressFakeMSB records each argv and stdin, and succeeds.
func egressFakeMSB(t *testing.T, relay *egressrelay.Relay) (*Runtime, string, string) {
	t.Helper()
	dir := t.TempDir()
	argv, stdin := filepath.Join(dir, "argv"), filepath.Join(dir, "stdin")
	binary := filepath.Join(dir, "fake-msb")
	script := fmt.Sprintf("#!/bin/sh\nprintf '%%s\\n' \"$*\" >> %q\ncat > %q\nexit 0\n", argv, stdin)
	require.NoError(t, os.WriteFile(binary, []byte(script), 0o700))
	root := t.TempDir()
	require.NoError(t, os.MkdirAll(filepath.Join(root, "workspaces"), 0o700))
	config := Config{EgressRelay: relay, HostPorts: []uint16{4000}}
	require.NoError(t, withRelayRoute(&config))
	return &Runtime{cli: &cli{binary: binary, home: t.TempDir()}, config: config, root: root,
		owner: "smithers-backend-0123456789abcdef", holder: "test", workspaces: map[string]*workspace{}}, argv, stdin
}

func egressWorkspace(t *testing.T, r *Runtime, id, state string, port uint16) *workspace {
	t.Helper()
	directory := filepath.Join(r.root, "workspaces", digest(id))
	require.NoError(t, os.MkdirAll(directory, 0o700))
	ws := newWorkspace(metadata{Version: metadataVersion, ID: id, Machine: r.machineName(id), State: state, RelayPort: port}, directory)
	r.workspaces[id] = ws
	return ws
}

// The guest receives the relay CA and a proxy environment, never a value:
// the relay substitutes it on the bound request, and stopping the VM ends it.
func TestMicroVMBindsEgressSecretsThroughTheRelay(t *testing.T) {
	var received string
	upstream := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		received = r.Header.Get("Authorization")
		_, _ = io.WriteString(w, r.Header.Get("Authorization"))
	})}
	upstreamListener, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	go func() { _ = upstream.Serve(upstreamListener) }()
	t.Cleanup(func() { _ = upstream.Close() })
	relayListener, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	relay, err := egressrelay.New(egressrelay.Config{Listener: relayListener, Local: []string{upstreamListener.Addr().String()}})
	require.NoError(t, err)
	t.Cleanup(func() { _ = relay.Close() })

	r, argv, stdin := egressFakeMSB(t, relay)
	port := relayPort(relay)
	require.Equal(t, []uint16{4000, port}, r.config.HostPorts, "the relay port joins the bridged backend ports")
	assert.Contains(t, strings.Join(r.machineFlags("lane"), " "), fmt.Sprintf("--net-rule allow@host:tcp:%d", port))
	assert.True(t, r.Capabilities().EgressSecrets)

	ws := egressWorkspace(t, r, "lane", string(workspaceapi.WorkspaceRunning), port)
	secret := sandbox.EgressProxySecret{Name: "SMITHERS_CI_JOB_TOKEN", Value: "job-token-value", Hosts: []string{"127.0.0.1"}, MatchHeaders: []string{"Authorization"}}
	binding, err := workspaceapi.BindEgressSecrets(t.Context(), r, ws.ID, []sandbox.EgressProxySecret{secret})
	require.NoError(t, err)
	for name, value := range binding.Environment {
		assert.NotContains(t, value, secret.Value, name)
	}
	assert.Equal(t, guestStateDir+"/egress-ca.pem", binding.Environment["SSL_CERT_FILE"])
	written, err := os.ReadFile(argv)
	require.NoError(t, err)
	assert.Contains(t, string(written), "run fs agent write "+guestStateDir+" egress-ca.pem 644")
	ca, err := os.ReadFile(stdin)
	require.NoError(t, err)
	assert.Equal(t, relay.CACertPEM(), ca, "only the public CA enters the guest")

	// The guest's proxy URL is the bridged relay port; a request through it
	// carries the placeholder and reaches the upstream with the value.
	proxyURL, err := url.Parse(binding.Environment["http_proxy"])
	require.NoError(t, err)
	assert.Equal(t, fmt.Sprintf("127.0.0.1:%d", port), proxyURL.Host)
	client := &http.Client{Transport: &http.Transport{Proxy: http.ProxyURL(proxyURL)}}
	get := func() (int, string) {
		req, err := http.NewRequest(http.MethodGet, "http://"+upstreamListener.Addr().String()+"/", nil)
		require.NoError(t, err)
		req.Header.Set("Authorization", "Bearer SMITHERS_CI_JOB_TOKEN")
		response, err := client.Do(req)
		require.NoError(t, err)
		defer response.Body.Close()
		body, _ := io.ReadAll(response.Body)
		return response.StatusCode, string(body)
	}
	status, body := get()
	require.Equal(t, http.StatusOK, status)
	assert.Equal(t, "Bearer SMITHERS_CI_JOB_TOKEN", body, "the echoed value is masked")
	assert.Equal(t, "Bearer job-token-value", received)

	require.NoError(t, r.StopWorkspace(t.Context(), ws.ID))
	status, _ = get()
	assert.Equal(t, http.StatusProxyAuthRequired, status, "stopping the VM revokes its binding")
	_, err = workspaceapi.BindEgressSecrets(t.Context(), r, ws.ID, []sandbox.EgressProxySecret{secret})
	assert.ErrorIs(t, err, workspaceapi.ErrWorkspaceStopped)

	// A machine built before the relay route cannot reach it.
	legacy := egressWorkspace(t, r, "legacy", string(workspaceapi.WorkspaceRunning), 0)
	_, err = workspaceapi.BindEgressSecrets(t.Context(), r, legacy.ID, []sandbox.EgressProxySecret{secret})
	assert.ErrorIs(t, err, workspaceapi.ErrEgressSecretsUnsupported)
}

func TestMicroVMWithoutRelayRefusesEgressSecrets(t *testing.T) {
	r, _, _ := egressFakeMSB(t, nil)
	egressWorkspace(t, r, "plain", string(workspaceapi.WorkspaceRunning), 0)
	assert.Equal(t, []uint16{4000}, r.config.HostPorts)
	workspaceconformance.RunEgressSecretsRefused(t, r, t.Context(), "plain")
	assert.True(t, errors.Is(r.RevokeEgressSecrets(t.Context(), "plain"), workspaceapi.ErrEgressSecretsUnsupported))
}

// The shared egress conformance against a real microVM: the guest reaches
// the relay only over its bridged port and holds only placeholders.
func TestRealMicroVMEgressSecretsConformance(t *testing.T) {
	binary := os.Getenv("SMITHERS_MICROSANDBOX_BIN")
	if binary == "" {
		if os.Getenv("SMITHERS_REQUIRE_MICROVM_TESTS") == "1" {
			t.Fatal("SMITHERS_MICROSANDBOX_BIN is required for microVM tests")
		}
		t.Skip("SMITHERS_MICROSANDBOX_BIN is not set")
	}
	upstream := workspaceconformance.NewEgressUpstream(t)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	relay, err := egressrelay.New(egressrelay.Config{Listener: listener, Local: []string{upstream.Listener.Addr().String()}})
	require.NoError(t, err)
	t.Cleanup(func() { _ = relay.Close() })
	runtime, err := New(t.Context(), Config{Binary: binary, Root: t.TempDir(), CPUs: 2, MemoryMiB: 2048, DiskMiB: 8192, MaxRunningVMs: 3, EgressRelay: relay})
	require.NoError(t, err)
	t.Cleanup(func() { sweepOwner(t, runtime) })
	workspaceconformance.RunEgressSecrets(t, workspaceconformance.EgressHarness{
		Runtime: runtime, Context: operation, Spec: workspaceapi.WorkspaceSpec{ID: "microvm-egress"}, Upstream: upstream,
		Fetch: func(url, credential string) workspaceapi.Command {
			return workspaceapi.Command{Args: []string{"/bin/sh", "-c", `curl -sS -H "Authorization: Bearer $2" "$1"`, "fetch", url, credential}}
		},
	})
}
