package microsandbox

import (
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/egressrelay"
	"github.com/smithersai/smithers/packages/backend/sandbox"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

// C-MCH-12 step 1, host half (spec §8.8.1b): a host-bound API key reaches the
// machine only as its placeholder, in the environment and in its declared
// file, with the relay route that swaps it toward the bound host. The real
// key is in no value the machine receives. The relay is rebound only when the
// bound set changes, and unbound when it empties.
func TestMachineSecretsHoldPlaceholdersAndTheRelaySwapsThem(t *testing.T) {
	var received string
	upstream := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		received = r.Header.Get("X-Api-Key")
		w.WriteHeader(http.StatusNoContent)
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
	r, argv, _ := egressFakeMSB(t, relay)
	ws := egressWorkspace(t, r, "branch", string(workspaceapi.WorkspaceRunning), relayPort(relay))

	const real = "sk-ant-api03-real-key"
	key := sandbox.EgressProxySecret{Name: "ANTHROPIC_API_KEY", Value: real, Hosts: []string{"127.0.0.1"}, MatchHeaders: []string{"x-api-key"}}
	secrets := MachineSecrets{
		Env:   map[string]string{"UNBOUND_TOKEN": "literal"},
		Bound: []sandbox.EgressProxySecret{key},
		Files: map[string]string{"~/.config/anthropic/key": sandbox.EgressProxyPlaceholder(key.Name)},
	}
	first, err := r.machineEnvironment(t.Context(), ws, secrets)
	require.NoError(t, err)
	require.Equal(t, "literal", first["UNBOUND_TOKEN"])
	require.Equal(t, "ANTHROPIC_API_KEY", first["ANTHROPIC_API_KEY"])
	require.Contains(t, first["https_proxy"], relayListener.Addr().String())
	require.Equal(t, guestStateDir+"/egress-ca.pem", first["SSL_CERT_FILE"])
	for name, value := range first {
		require.NotContains(t, value, real, name)
	}
	for path, value := range secrets.Files {
		require.NotContains(t, value, real, path)
	}
	calls, err := os.ReadFile(argv)
	require.NoError(t, err)

	// The same bound set keeps its route: no rebind, no new credential.
	again, err := r.machineEnvironment(t.Context(), ws, secrets)
	require.NoError(t, err)
	require.Equal(t, first, again)
	same, err := os.ReadFile(argv)
	require.NoError(t, err)
	require.Equal(t, calls, same)
	require.Equal(t, "literal", secrets.Env["UNBOUND_TOKEN"])
	require.NotContains(t, secrets.Env, "ANTHROPIC_API_KEY", "the source's map is not changed")

	// A tool on the machine sends the placeholder; the relay sends the key.
	send := func(proxy string) int {
		proxyURL, err := url.Parse(proxy)
		require.NoError(t, err)
		client := &http.Client{Transport: &http.Transport{Proxy: http.ProxyURL(proxyURL)}}
		req, err := http.NewRequest(http.MethodPost, "http://"+upstreamListener.Addr().String()+"/v1/messages", strings.NewReader("{}"))
		require.NoError(t, err)
		req.Header.Set("X-Api-Key", first["ANTHROPIC_API_KEY"])
		response, err := client.Do(req)
		require.NoError(t, err)
		_, _ = io.Copy(io.Discard, response.Body)
		_ = response.Body.Close()
		return response.StatusCode
	}
	require.Equal(t, http.StatusNoContent, send(first["http_proxy"]))
	require.Equal(t, real, received)

	// Replacing the key rebinds: the old route stops working at once.
	key.Value = "sk-ant-api03-rotated"
	secrets.Bound = []sandbox.EgressProxySecret{key}
	rotated, err := r.machineEnvironment(t.Context(), ws, secrets)
	require.NoError(t, err)
	require.NotEqual(t, first["http_proxy"], rotated["http_proxy"])
	require.Equal(t, http.StatusProxyAuthRequired, send(first["http_proxy"]))
	received = ""
	require.Equal(t, http.StatusNoContent, send(rotated["http_proxy"]))
	require.Equal(t, "sk-ant-api03-rotated", received)

	// Removing every bound secret removes the route and the binding.
	unbound, err := r.machineEnvironment(t.Context(), ws, MachineSecrets{Env: map[string]string{"UNBOUND_TOKEN": "literal"}})
	require.NoError(t, err)
	require.Equal(t, map[string]string{"UNBOUND_TOKEN": "literal"}, unbound)
	require.Equal(t, http.StatusProxyAuthRequired, send(rotated["http_proxy"]))
	require.Nil(t, ws.relayDigest)
}

// A runtime without a relay refuses bound secrets rather than deliver a
// placeholder nothing swaps.
func TestMachineSecretsWithoutRelayRefuseBoundSecrets(t *testing.T) {
	r, _, _ := egressFakeMSB(t, nil)
	ws := egressWorkspace(t, r, "plain", string(workspaceapi.WorkspaceRunning), 0)
	_, err := r.machineEnvironment(t.Context(), ws, MachineSecrets{Bound: []sandbox.EgressProxySecret{{Name: "KEY", Value: "v", Hosts: []string{"api.example.com"}, MatchHeaders: []string{"authorization"}}}})
	require.ErrorIs(t, err, workspaceapi.ErrEgressSecretsUnsupported)
	environment, err := r.machineEnvironment(t.Context(), ws, MachineSecrets{Env: map[string]string{"A": "a"}})
	require.NoError(t, err)
	require.Equal(t, map[string]string{"A": "a"}, environment)
}
