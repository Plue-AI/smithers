package compose

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/flowhost"
	"github.com/smithersai/smithers/packages/backend/flowmanifest"
	"github.com/smithersai/smithers/packages/backend/installbundle"
	"github.com/smithersai/smithers/packages/backend/installbundle/bundletest"
	"github.com/smithersai/smithers/packages/backend/process"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
)

// C-SEC-02's negative boundary uses a real trusted-process runtime and real
// repository files. Rejection must precede source loading, host startup and
// database/configuration access. Positive microVM and TODO lifecycle evidence
// is collected by the separate reference-host canary.
func TestCSEC02TrustedProcessRefusesRepositoryFlowsBeforeComposition(t *testing.T) {
	runtime, err := process.New(process.Config{Root: t.TempDir()})
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, runtime.Close()) })
	observed, err := runtime.CreateWorkspace(context.Background(), workspaceapi.WorkspaceSpec{ID: "csec02-repository"})
	require.NoError(t, err)
	marker := filepath.Join(t.TempDir(), "host-imported")
	listener, err := net.ListenTCP("tcp", &net.TCPAddr{IP: net.ParseIP("127.0.0.1")})
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, listener.Close()) })
	markerJSON, err := json.Marshal(marker)
	require.NoError(t, err)
	port := listener.Addr().(*net.TCPAddr).Port
	for _, name := range []string{"todo", "learning", "review", "release-notes", "merge"} {
		path := filepath.Join(observed.Root, "flows", name, "flow.ts")
		require.NoError(t, os.MkdirAll(filepath.Dir(path), 0755))
		body := fmt.Sprintf(`import { writeFileSync } from "node:fs"
import { connect } from "node:net"
import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Schema } from "effect"
writeFileSync(%s, "imported")
connect({ host: "127.0.0.1", port: %d }).end()
export default Flow.make(%q, {
  description: "Isolation canary",
  capabilities: [],
  effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "sealed" },
  payload: {}, success: Schema.String,
  body: () => Node.succeed("canary")
})
`, markerJSON, port, name)
		require.NoError(t, os.WriteFile(path, []byte(body), 0644))
	}
	assertIsolation := func(err error) {
		t.Helper()
		var typed interface {
			FlowRuntimeCode() string
			FlowRuntimeClass() string
		}
		require.ErrorAs(t, err, &typed)
		require.Equal(t, "isolation_required", typed.FlowRuntimeCode())
		require.Equal(t, "infra", typed.FlowRuntimeClass())
	}
	launcher, err := flowhost.NewWorkspaceLauncher(runtime)
	assertIsolation(err)
	require.Nil(t, launcher)
	for _, role := range []topology{localTopology, hostedAPITopology, hostedWorkerTopology} {
		options := runOptions{topology: role, Options: Options{Workspace: runtime, FlowHostRegistry: &flowmanifest.Registry{}}}
		// Nil config, pool and services make any pre-isolation access a panic.
		composition, err := newFlowComposition(options, nil, nil, nil, nil, nil, nil, nil, nil, nil)
		assertIsolation(err)
		require.Nil(t, composition)
	}
	_, err = os.Stat(marker)
	require.ErrorIs(t, err, os.ErrNotExist, "repository module never executed on host")
	require.NoError(t, listener.SetDeadline(time.Now().Add(25*time.Millisecond)))
	connection, err := listener.AcceptTCP()
	if connection != nil {
		_ = connection.Close()
		t.Fatal("repository import reached host TCP canary")
	}
	var timeout net.Error
	require.ErrorAs(t, err, &timeout)
	require.True(t, timeout.Timeout())
}

// TestCSEC02BundledInstallIsolation refuses to substitute the in-process rig
// for the production install. Only a host without a bundle skips, by name; the
// reference host sets SMITHERS_REQUIRE_MICROVM_TESTS=1 so a missing bundle
// fails, and every other absent prerequisite fails regardless.
func TestCSEC02BundledInstallIsolation(t *testing.T) {
	bundle := os.Getenv("SMITHERS_CHECK_BUNDLE")
	if bundle == "" {
		if os.Getenv("SMITHERS_REQUIRE_MICROVM_TESTS") == "1" {
			t.Fatal("prerequisite: dependency: built-bundle: SMITHERS_CHECK_BUNDLE required")
		}
		t.Skip("requires macOS bundle: set SMITHERS_CHECK_BUNDLE; runs on the reference-host runner, #3471")
	}
	if _, err := os.Stat(filepath.Join(bundle, "manifest.json")); err != nil {
		t.Fatalf("prerequisite: dependency: built-bundle: %v", err)
	}
	if runtime.GOOS != "darwin" || runtime.GOARCH != "arm64" {
		t.Fatal("prerequisite: environment: darwin-arm64 required")
	}
	// The install ignores shell-selected runtimes. Qualify its pinned msb
	// and kernel, rather than accepting an unrelated operator-supplied msb.
	approved, err := installbundle.Open(bundle)
	if err != nil {
		t.Fatalf("prerequisite: dependency: approved bundle: %v", err)
	}
	msb, err := approved.Expect("bundled msb", approved.Path("bin/msb"), "bin/msb", true)
	if err != nil {
		t.Fatalf("prerequisite: dependency: bundled msb: %v", err)
	}
	if _, err := approved.Expect("bundled guest kernel", approved.Path("lib/libkrunfw.5.dylib"), "lib/libkrunfw.5.dylib", false); err != nil {
		t.Fatalf("prerequisite: dependency: bundled guest kernel: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	runtimeVersion := exec.CommandContext(ctx, msb, "--version")
	runtimeVersion.Env = []string{"HOME=" + os.Getenv("HOME"), "PATH=" + approved.Path("bin") + ":/usr/bin:/bin:/usr/sbin:/sbin"}
	version, err := runtimeVersion.CombinedOutput()
	if err != nil || !strings.Contains(string(version), "0.6.16") {
		t.Fatal("prerequisite: environment: msb: version 0.6.16 required")
	}
	database := os.Getenv("SMITHERS_TEST_DATABASE_URL")
	if database == "" {
		t.Fatal("prerequisite: environment: PG18: allocated database required")
	}
	// psql expands a connection URI passed through -d; PGDATABASE does not.
	command := exec.CommandContext(ctx, "psql", "--dbname", database, "-XAtqc", "SHOW server_version_num")
	version, err = command.CombinedOutput()
	if err != nil || !strings.HasPrefix(strings.TrimSpace(string(version)), "18") {
		t.Fatal("prerequisite: environment: PG18: server version 18 required")
	}
	// Served claim is qualified separately through the shipped CLI/launchd by
	// TestCSEC02LaunchdServedClaim. The owned abrupt-stop control in
	// TestTodoMachineKillThroughInstall uses the composed setup harness, so it
	// does not establish this bundled launcher's complete lifecycle.
	t.Fatal("prerequisite: dependency: bundled-install lifecycle fixture: TODO/canary execution and owned guest interruption are not wired; steps 1-5 and 7 unexecuted")
}

// The production bundled launcher must refuse damaged runtime inputs before
// it creates state or starts PostgreSQL. This separately qualifies step 6;
// through both the launcher and shipped host-start CLI. It does not substitute
// for the normal TODO and interruption lifecycle above.
func TestCSEC02BundledLauncherRuntimeRefusals(t *testing.T) {
	bundle := os.Getenv("SMITHERS_CHECK_BUNDLE")
	if bundle == "" {
		if os.Getenv("SMITHERS_REQUIRE_MICROVM_TESTS") == "1" {
			t.Fatal("SMITHERS_CHECK_BUNDLE required for bundled launcher runtime refusals")
		}
		t.Skip("requires real darwin-arm64 install bundle")
	}
	require.Equal(t, "darwin", runtime.GOOS)
	require.Equal(t, "arm64", runtime.GOARCH)
	bundle, err := filepath.Abs(bundle)
	require.NoError(t, err)
	approved, err := installbundle.Open(bundle)
	require.NoError(t, err)
	manifest, err := os.ReadFile(filepath.Join(bundle, "manifest.json"))
	require.NoError(t, err)
	var declared struct {
		Files []installbundle.Entry `json:"files"`
	}
	require.NoError(t, json.Unmarshal(manifest, &declared))
	require.NotEmpty(t, declared.Files)
	for _, expected := range declared.Files {
		path := expected.Path
		entry, ok := approved.Entry(path)
		require.True(t, ok)
		if entry.Symlink != nil {
			target, err := os.Readlink(approved.Path(path))
			require.NoError(t, err)
			require.Equal(t, *entry.Symlink, target)
			resolved, err := filepath.EvalSymlinks(approved.Path(path))
			require.NoError(t, err)
			require.True(t, strings.HasPrefix(resolved, approved.Root()+string(filepath.Separator)))
			bytes, err := os.ReadFile(resolved)
			require.NoError(t, err)
			require.Equal(t, entry.SHA256, fmt.Sprintf("%x", sha256.Sum256(bytes)))
			continue
		}
		_, err := approved.Expect("baseline artifact", approved.Path(path), path, entry.Mode&0111 != 0)
		require.NoError(t, err, "baseline must be intact before runtime removal")
	}
	t.Logf("bundle revision=%s manifestSHA256=%s", approved.Revision(), approved.ManifestSHA256())
	for _, dependency := range []string{"bin/msb", "lib/libkrunfw.5.dylib"} {
		t.Run(dependency, func(t *testing.T) {
			root := bundletest.ProtectedTempDir(t)
			copy := filepath.Join(root, "bundle")
			ctx, cancel := context.WithTimeout(t.Context(), 2*time.Minute)
			defer cancel()
			// APFS clones avoid copying the offline image's bytes. Neither the
			// source bundle nor any other install is ever mutated.
			output, err := exec.CommandContext(ctx, "/bin/cp", "-cR", bundle, copy).CombinedOutput()
			require.NoError(t, err, "%s", output)
			require.NoError(t, os.Remove(filepath.Join(copy, filepath.FromSlash(dependency))))
			for _, door := range []string{"launcher", "host-start"} {
				t.Run(door, func(t *testing.T) {
					home := filepath.Join(root, door+"-home")
					require.NoError(t, os.Mkdir(home, 0700))
					listener, err := net.Listen("tcp", "127.0.0.1:0")
					require.NoError(t, err)
					address := listener.Addr().String()
					require.NoError(t, listener.Close())
					binary := filepath.Join(copy, "bin/smithers-server")
					args := []string{"--bind", address}
					if door == "host-start" {
						// The service label belongs to the login session, even with
						// a private HOME. Never touch an operator's running service.
						require.NotZero(t, os.Getuid(), "host qualification requires an unprivileged login")
						job := fmt.Sprintf("gui/%d/sh.smithers.host", os.Getuid())
						_, err := exec.CommandContext(ctx, "/bin/launchctl", "print", job).CombinedOutput()
						require.Error(t, err, "stop the existing host before qualification")
						binary = filepath.Join(copy, "bin/smthrs")
						args = []string{"host", "start", "--bundle", copy, "--bind", address, "--json"}
					}
					started := time.Now()
					launchCtx, stop := context.WithTimeout(t.Context(), 30*time.Second)
					defer stop()
					command := exec.CommandContext(launchCtx, binary, args...)
					command.Env = []string{"HOME=" + home, "PATH=/usr/bin:/bin:/usr/sbin:/sbin", "SMITHERS_BACKEND_MODE=plue", "SMITHERS_WORKSPACE_ISOLATION=process", "SMITHERS_MICROSANDBOX_BIN=/bin/false"}
					output, err := command.CombinedOutput()
					require.Error(t, err, "missing runtime must refuse startup")
					require.NoError(t, launchCtx.Err(), "refusal must precede the 30-second timeout")
					require.Contains(t, string(output), filepath.Base(dependency))
					require.NotContains(t, string(output), `"setup_urls"`)
					_, stateErr := os.Stat(filepath.Join(home, "Library", "Application Support", "Smithers"))
					require.ErrorIs(t, stateErr, os.ErrNotExist, "refusal precedes backend state or PostgreSQL startup")
					_, plistErr := os.Stat(filepath.Join(home, "Library", "LaunchAgents", "sh.smithers.host.plist"))
					require.ErrorIs(t, plistErr, os.ErrNotExist, "refusal precedes service registration")
					if door == "host-start" {
						job := fmt.Sprintf("gui/%d/sh.smithers.host", os.Getuid())
						_, err := exec.CommandContext(ctx, "/bin/launchctl", "print", job).CombinedOutput()
						require.Error(t, err, "damaged bundle must not bootstrap launchd")
					}
					if evidence := os.Getenv("SMITHERS_FLOW_ISOLATION_EVIDENCE_DIR"); evidence != "" {
						require.NoError(t, os.MkdirAll(evidence, 0700))
						body, marshalErr := json.Marshal(map[string]any{"door": door, "dependency": dependency, "refused": true, "durationMs": time.Since(started).Milliseconds(), "output": string(output), "revision": approved.Revision(), "manifestSHA256": approved.ManifestSHA256()})
						require.NoError(t, marshalErr)
						require.NoError(t, os.WriteFile(filepath.Join(evidence, "missing-"+filepath.Base(dependency)+"-"+door+".json"), append(body, '\n'), 0600))
					}
				})
			}
		})
	}
}

// The listener records every accepted connection, even a connection carrying
// no nonce. Its shutdown waits for the accept loop before reading evidence.
type isolationCanaryListener struct {
	listener    net.Listener
	done        chan struct{}
	mu          sync.Mutex
	connections []string
}

func newIsolationCanaryListener(t *testing.T) *isolationCanaryListener {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	canary := &isolationCanaryListener{listener: listener, done: make(chan struct{})}
	go func() {
		defer close(canary.done)
		for {
			connection, err := listener.Accept()
			if err != nil {
				return
			}
			canary.mu.Lock()
			canary.connections = append(canary.connections, connection.RemoteAddr().String())
			canary.mu.Unlock()
			_ = connection.SetReadDeadline(time.Now().Add(time.Second))
			data, _ := io.ReadAll(io.LimitReader(connection, 4096))
			_ = connection.Close()
			canary.mu.Lock()
			canary.connections[len(canary.connections)-1] += " " + string(data)
			canary.mu.Unlock()
		}
	}()
	t.Cleanup(func() { _ = listener.Close(); <-canary.done })
	return canary
}
func TestCSEC02CanaryListenerRecordsConnections(t *testing.T) {
	canary := newIsolationCanaryListener(t)
	connection, err := net.Dial("tcp", canary.listener.Addr().String())
	require.NoError(t, err)
	_, err = connection.Write([]byte("fixture-nonce"))
	require.NoError(t, err)
	require.NoError(t, connection.Close())
	require.Eventually(t, func() bool {
		canary.mu.Lock()
		defer canary.mu.Unlock()
		return len(canary.connections) == 1 && strings.HasSuffix(canary.connections[0], " fixture-nonce")
	}, time.Second, time.Millisecond)
	require.NoError(t, canary.listener.Close())
	<-canary.done
	canary.mu.Lock()
	defer canary.mu.Unlock()
	require.Len(t, canary.connections, 1)
}
