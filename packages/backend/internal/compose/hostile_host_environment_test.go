package compose

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/flowhost"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/microsandbox"
	"github.com/smithersai/smithers/packages/backend/modelproxy"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

// This uses a Python HTTP fixture in place of the packaged coding host. The
// managed-host launch, composed environment, guest process, and hostile /proc
// read are real; this does not exercise the coding host's application code.
func TestRealMicroVMHostEnvironmentCannotExposeOperatorKeys(t *testing.T) {
	binary := os.Getenv("SMITHERS_MICROSANDBOX_BIN")
	if binary == "" {
		if os.Getenv("SMITHERS_REQUIRE_MICROVM_TESTS") == "1" {
			t.Fatal("SMITHERS_MICROSANDBOX_BIN is required for microVM tests")
		}
		t.Skip("SMITHERS_MICROSANDBOX_BIN is not set")
	}

	const operatorKey = "operator-openai-hostile-sentinel"
	const operatorAnthropicKey = "operator-anthropic-hostile-sentinel"
	unofferedKeys := map[string]string{}
	const keyFileContent = "operator-key-file-hostile-sentinel"
	keyFile := filepath.Join(t.TempDir(), "operator-model-key")
	require.NoError(t, os.WriteFile(keyFile, []byte(`{"openai":"`+keyFileContent+`"}`), 0o600))
	t.Setenv("SMITHERS_PLATFORM_MODEL_KEYS_FILE", keyFile)
	t.Setenv("OPENAI_API_KEY", operatorKey)
	t.Setenv("ANTHROPIC_API_KEY", operatorAnthropicKey)
	// These providers have no seat: a seat override must not mask a restored
	// ambient-key passthrough regression.
	for _, name := range []string{"AI_GATEWAY_API_KEY", "CEREBRAS_API_KEY", "OPENROUTER_API_KEY", "GEMINI_API_KEY"} {
		unofferedKeys[name] = "operator-" + strings.ToLower(name) + "-hostile-sentinel"
		t.Setenv(name, unofferedKeys[name])
	}
	t.Setenv("OPENAI_API_KEY_FILE", keyFile)
	t.Setenv("ANTHROPIC_API_KEY_FILE", keyFile)
	t.Setenv("SMITHERS_OPENAI_COMPATIBLE_BASE_URL", "https://operator-only.invalid")

	runtime, err := microsandbox.New(context.Background(), microsandbox.Config{
		Binary: binary, Root: t.TempDir(), CPUs: 2, MemoryMiB: 2048, DiskMiB: 8192, MaxRunningVMs: 1,
	})
	require.NoError(t, err)
	const workspaceID = "hostile-host-environment"
	ctx, cancel := context.WithTimeout(workspaceapi.WithOperation(context.Background(), workspaceapi.Operation{
		TenantID: "9", PrincipalID: "9", OperationID: "hostile-host-environment",
	}), 3*time.Minute)
	defer cancel()
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 2*time.Minute)
		defer cleanupCancel()
		if err := runtime.DeleteWorkspace(cleanupCtx, workspaceID); err != nil {
			t.Errorf("delete microVM workspace: %v", err)
		}
		if err := runtime.Close(); err != nil {
			t.Errorf("close microVM runtime: %v", err)
		}
	})
	_, err = runtime.CreateWorkspace(ctx, workspaceapi.WorkspaceSpec{ID: workspaceID})
	require.NoError(t, err)

	const fixture = `import argparse
from http.server import BaseHTTPRequestHandler, HTTPServer
parser = argparse.ArgumentParser()
parser.add_argument("port", type=int)
port = parser.parse_args().port
class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"ready")
    def log_message(self, *args):
        pass
HTTPServer(("127.0.0.1", port), Handler).serve_forever()
`
	require.NoError(t, runtime.WriteFile(ctx, workspaceID, "host-fixture.py", []byte(fixture), 0o644))

	target := flowruntime.Target{TenantID: "repository:5", PrincipalID: "user:9", BindingKind: "agent-session", BindingID: "session-1"}
	authority := flowhost.Authority{Target: target, RepositoryID: 5, UserID: 9, WorkspaceID: workspaceID,
		CatalogKey: flowhost.CatalogCoding, SourceRevision: strings.Repeat("b", 40)}
	openAI, ok := modelproxy.SeatFor(modelproxy.ProviderOpenAI)
	require.True(t, ok)
	anthropic, ok := modelproxy.SeatFor(modelproxy.ProviderAnthropic)
	require.True(t, ok)
	const marker = "managed-host-fixture-marker-2187"
	catalog := flowhost.Catalog{Key: flowhost.CatalogCoding, Family: flowhost.CatalogCoding,
		Executable: "/usr/bin/python3", ArtifactDigest: strings.Repeat("a", 64), ServiceName: "hostile-host-fixture",
		Environment: codingHostEnvironment(localTopology), ModelProxyURL: "http://127.0.0.1:4000/model-proxy",
		ModelSeats: []modelproxy.Seat{openAI, anthropic}, ReadyTimeout: 30 * time.Second}
	catalog.Environment["HOST_PROBE_MARKER"] = marker
	binding := flowhost.Binding{ID: "11111111-1111-4111-8111-111111111111", TenantID: target.TenantID,
		PrincipalID: target.PrincipalID, BindingKind: target.BindingKind, BindingID: target.BindingID,
		RepositoryID: 5, UserID: 9, WorkspaceID: workspaceID, CatalogKey: flowhost.CatalogCoding,
		ServiceName: catalog.ServiceName, RuntimeArtifactDigest: catalog.ArtifactDigest,
		SourceRevision: authority.SourceRevision, OwnerGeneration: 7, State: "starting"}
	const controlCredential = "host-control-credential-2187"
	launch := flowhost.HostLaunch{Binding: binding, Authority: authority, Catalog: catalog, Credential: controlCredential}
	expected := workspaceapi.ManagedHostIdentity{Protocol: flowruntime.Protocol, ArtifactDigest: catalog.ArtifactDigest,
		SourceRevision: authority.SourceRevision, OwnerGeneration: binding.OwnerGeneration}
	host := workspaceapi.ManagedHostSpec{ID: binding.ID, Name: catalog.ServiceName, Identity: "fixture-host-2187",
		Expected: expected, ReadyTimeout: 30 * time.Second,
		Builder: workspaceapi.ManagedHostBuilderFunc(func(_ context.Context, placement workspaceapi.ManagedHostPlacement) (workspaceapi.Command, error) {
			spec, err := flowhost.BuildProcessSpec(launch, flowhost.WorkspacePaths{
				Root: placement.Workspace.Root, StateDir: placement.StateDir, Host: placement.Host,
			}, placement.Port)
			if err != nil {
				return workspaceapi.Command{}, err
			}
			// Replace only the packaged host argv with the HTTP fixture. Keep the
			// exact environment produced for the coding host.
			return workspaceapi.Command{Args: []string{spec.Args[0], "-u", "/workspace/host-fixture.py", fmt.Sprint(placement.Port)},
				Environment: spec.Environment}, nil
		}),
		Probe: workspaceapi.ManagedHostProbeFunc(func(ctx context.Context, connection workspaceapi.ManagedHostConnection) (workspaceapi.ManagedHostIdentity, error) {
			request, err := http.NewRequestWithContext(ctx, http.MethodGet, connection.Endpoint, nil)
			if err != nil {
				return workspaceapi.ManagedHostIdentity{}, err
			}
			response, err := connection.HTTPClient.Do(request)
			if err != nil {
				return workspaceapi.ManagedHostIdentity{}, err
			}
			defer response.Body.Close()
			if response.StatusCode != http.StatusOK {
				return workspaceapi.ManagedHostIdentity{}, fmt.Errorf("fixture status %d", response.StatusCode)
			}
			return expected, nil
		}),
	}
	_, err = runtime.StartManagedHost(ctx, workspaceID, host)
	require.NoError(t, err)

	// The repository command shares the guest user with the managed host.
	// It must actually read that host's matching /proc/<pid>/environ.
	readProcess := func(matchName, matchValue string) map[string]string {
		t.Helper()
		const scan = `import json, os, sys
needle = (sys.argv[1] + "=" + sys.argv[2]).encode()
matches = []
for pid in os.listdir("/proc"):
    if not pid.isdigit():
        continue
    try:
        with open("/proc/" + pid + "/environ", "rb") as source:
            entries = source.read().split(b"\0")
    except (OSError, PermissionError):
        continue
    if needle in entries:
        matches.append(dict(item.decode("utf-8", "replace").split("=", 1) for item in entries if b"=" in item))
print(json.dumps(matches))
`
		result, err := runtime.ExecuteCommand(ctx, workspaceID, workspaceapi.Command{
			Args: []string{"python3", "-c", scan, matchName, matchValue},
		})
		require.NoError(t, err)
		require.Equal(t, 0, result.ExitCode, result.Stderr)
		var matches []map[string]string
		require.NoError(t, json.Unmarshal([]byte(result.Stdout), &matches))
		require.True(t, len(matches) == 1, "exactly one matching process must have a readable /proc environment")
		return matches[0]
	}

	environment := readProcess("HOST_PROBE_MARKER", marker)
	// Restart the same managed host through the same builder with a deliberately
	// unsafe catalog, simulating a restored passthrough for an unoffered provider.
	// This bypasses resolver catalog validation only in the test fixture.
	const leakMarker = "leaking-positive-control-2187"
	containsSecret := func(environment map[string]string) bool {
		sentinels := []string{operatorKey, operatorAnthropicKey, keyFile, keyFileContent}
		for _, value := range unofferedKeys {
			sentinels = append(sentinels, value)
		}
		for _, value := range environment {
			for _, sentinel := range sentinels {
				if strings.Contains(value, sentinel) {
					return true
				}
			}
		}
		return false
	}
	require.NoError(t, runtime.StopService(ctx, workspaceID, catalog.ServiceName))
	launch.Catalog.Environment["HOST_PROBE_MARKER"] = leakMarker
	launch.Catalog.Environment["GEMINI_API_KEY"] = unofferedKeys["GEMINI_API_KEY"]
	host.Identity += "-leaking-control"
	_, err = runtime.StartManagedHost(ctx, workspaceID, host)
	require.NoError(t, err)
	control := readProcess("HOST_PROBE_MARKER", leakMarker)
	require.True(t, containsSecret(control), "the same leak detector must reject the positive control")

	require.True(t, binding.ID == environment["SMITHERS_GATEWAY_ID"], "wrong binding")
	require.True(t, marker == environment["HOST_PROBE_MARKER"], "wrong host marker")
	derived := flowhost.ModelCredential(binding.ID, controlCredential)
	require.True(t, operatorKey != derived, "seat must not use the operator credential")
	require.True(t, derived == environment[openAI.KeyEnv], "OpenAI seat must use the binding credential")
	require.True(t, derived == environment[anthropic.KeyEnv], "Anthropic seat must use the binding credential")
	for _, name := range []string{"SMITHERS_PLATFORM_MODEL_KEYS_FILE", "OPENAI_API_KEY_FILE", "ANTHROPIC_API_KEY_FILE", "SMITHERS_OPENAI_COMPATIBLE_BASE_URL", "AI_GATEWAY_API_KEY", "CEREBRAS_API_KEY", "OPENROUTER_API_KEY", "GEMINI_API_KEY"} {
		_, present := environment[name]
		require.False(t, present, "host environment contains forbidden variable %s", name)
	}
	require.False(t, containsSecret(environment), "host environment exposed an operator sentinel")
	fileCheck, err := runtime.ExecuteCommand(ctx, workspaceID, workspaceapi.Command{
		Args: []string{"python3", "-c", `import os, sys; print("present" if os.path.exists(sys.argv[1]) else "absent")`, keyFile},
	})
	require.NoError(t, err)
	require.Equal(t, 0, fileCheck.ExitCode, fileCheck.Stderr)
	require.Equal(t, "absent\n", fileCheck.Stdout, "operator key file is reachable from the repository VM")
}
