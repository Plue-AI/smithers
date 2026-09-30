package process

import (
	"bufio"
	"context"
	"encoding/base64"
	"io"
	"net"
	"net/http"
	"net/url"
	"os/exec"
	goruntime "runtime"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/egressrelay"
	"github.com/smithersai/smithers/packages/backend/sandbox"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/smithersai/smithers/packages/backend/workspaceconformance"
)

func TestRuntimeWorkspaceConformance(t *testing.T) {
	runtime, err := New(Config{Root: t.TempDir(), MaxConcurrent: 2})
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, runtime.Close()) })

	workspaceconformance.RunCore(t, workspaceconformance.CoreHarness{
		Runtime: runtime,
		Context: func(operationID string) context.Context {
			return workspaceapi.WithOperation(context.Background(), workspaceapi.Operation{
				TenantID: "one-owner", PrincipalID: "one-owner", OperationID: operationID,
			})
		},
		Spec:          workspaceapi.WorkspaceSpec{ID: "process-conformance"},
		CreateStates:  []workspaceapi.WorkspaceState{workspaceapi.WorkspaceStopped},
		Command:       workspaceapi.Command{Args: []string{"/bin/sh", "-c", "printf conformance-ok"}},
		WantStdout:    "conformance-ok",
		FilePath:      "nested/fixture.txt",
		FileContent:   []byte("persistent fixture\n"),
		FileMode:      0o640,
		WantIsolation: workspaceapi.IsolationTrustedProcess,
		WantCapabilities: workspaceapi.WorkspaceCapabilities{
			PersistentFiles:  true,
			Execution:        true,
			ManagedServices:  true,
			ManagedHTTPHosts: true,
			SourceRevision:   true,
			Terminal:         goruntime.GOOS != "windows",
			LoopbackPreview:  true,
			FileOperations:   true,
			ColdSnapshots:    false,
		},
	})
}

func TestRuntimeEgressSecretsConformance(t *testing.T) {
	if _, err := exec.LookPath("curl"); err != nil {
		t.Skip("curl is required to fetch through the egress relay")
	}
	upstream := workspaceconformance.NewEgressUpstream(t)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	relay, err := egressrelay.New(egressrelay.Config{Listener: listener, Local: []string{upstream.Listener.Addr().String()}})
	require.NoError(t, err)
	t.Cleanup(func() { _ = relay.Close() })
	runtime, err := New(Config{Root: t.TempDir(), EgressRelay: relay})
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, runtime.Close()) })
	workspaceconformance.RunEgressSecrets(t, workspaceconformance.EgressHarness{
		Runtime: runtime,
		Context: func(operationID string) context.Context {
			return workspaceapi.WithOperation(context.Background(), workspaceapi.Operation{
				TenantID: "one-owner", PrincipalID: "one-owner", OperationID: operationID,
			})
		},
		Spec:     workspaceapi.WorkspaceSpec{ID: "process-egress"},
		Upstream: upstream,
		Fetch: func(url, credential string) workspaceapi.Command {
			return workspaceapi.Command{Args: []string{"/bin/sh", "-c", `curl -sS -H "Authorization: Bearer $2" "$1"`, "fetch", url, credential}}
		},
	})
}

func TestRuntimeWithoutRelayRefusesEgressSecrets(t *testing.T) {
	runtime, err := New(Config{Root: t.TempDir()})
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, runtime.Close()) })
	ctx := context.Background()
	_, err = runtime.CreateWorkspace(ctx, workspaceapi.WorkspaceSpec{ID: "no-relay"})
	require.NoError(t, err)
	_, err = runtime.StartWorkspace(ctx, "no-relay")
	require.NoError(t, err)
	workspaceconformance.RunEgressSecretsRefused(t, runtime, ctx, "no-relay")
	require.ErrorIs(t, runtime.RevokeEgressSecrets(ctx, "no-relay"), workspaceapi.ErrEgressSecretsUnsupported)
}

// Closing the runtime revokes every binding, even when the relay outlives it.
func TestRuntimeCloseRevokesEgressSecrets(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	relay, err := egressrelay.New(egressrelay.Config{Listener: listener})
	require.NoError(t, err)
	t.Cleanup(func() { _ = relay.Close() })
	runtime, err := New(Config{Root: t.TempDir(), EgressRelay: relay})
	require.NoError(t, err)
	ctx := context.Background()
	_, err = runtime.CreateWorkspace(ctx, workspaceapi.WorkspaceSpec{ID: "closing"})
	require.NoError(t, err)
	_, err = runtime.StartWorkspace(ctx, "closing")
	require.NoError(t, err)
	binding, err := runtime.BindEgressSecrets(ctx, "closing", []sandbox.EgressProxySecret{{
		Name: "TOKEN", Value: "close-value", Hosts: []string{"api.example.com"}, MatchHeaders: []string{"Authorization"},
	}})
	require.NoError(t, err)
	proxy := binding.Environment["http_proxy"]
	require.NotEmpty(t, proxy)
	status := func() int {
		proxyURL, err := url.Parse(proxy)
		require.NoError(t, err)
		conn, err := net.Dial("tcp", proxyURL.Host)
		require.NoError(t, err)
		defer conn.Close()
		password, _ := proxyURL.User.Password()
		credential := base64.StdEncoding.EncodeToString([]byte(proxyURL.User.Username() + ":" + password))
		_, err = io.WriteString(conn, "CONNECT api.example.com:443 HTTP/1.1\r\nHost: api.example.com:443\r\nProxy-Authorization: Basic "+credential+"\r\n\r\n")
		require.NoError(t, err)
		response, err := http.ReadResponse(bufio.NewReader(conn), nil)
		require.NoError(t, err)
		return response.StatusCode
	}
	require.Equal(t, http.StatusOK, status())
	require.NoError(t, runtime.Close())
	require.Equal(t, http.StatusProxyAuthRequired, status())
}
