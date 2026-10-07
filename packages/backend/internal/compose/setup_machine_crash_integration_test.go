package compose

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/installbundle"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/microsandbox"
	"github.com/smithersai/smithers/packages/backend/sandbox/sandboxfake"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
)

// The checkpoints stop delivery, never replace image preparation. Both sides
// execute the installed, verified runtime with the production host sizing.
type crashCheckpointRuntime struct {
	*microsandbox.Runtime
	checkpoint, marker string
}

func (r crashCheckpointRuntime) ResolveWorkspaceLayer(ctx context.Context, spec workspaceapi.WorkspaceSpec) (microsandbox.Layer, error) {
	hold := func(layer microsandbox.Layer) {
		body, err := json.Marshal(layer)
		if err != nil {
			panic(err)
		}
		if err := os.WriteFile(r.marker, body, 0600); err != nil {
			panic(err)
		}
		<-ctx.Done()
	}
	if r.checkpoint == "admitted" {
		hold(microsandbox.Layer{})
		return microsandbox.Layer{}, ctx.Err()
	}
	layer, err := r.Runtime.ResolveWorkspaceLayer(ctx, spec)
	if err == nil && r.checkpoint == "prepared" {
		hold(layer)
		return microsandbox.Layer{}, ctx.Err()
	}
	return layer, err
}

// Spawned by the parent with the same PostgreSQL, repository mirror and origins.
// SIGKILL bypasses every composition and runtime shutdown handler.
func TestInstallMachineCrashProcess(t *testing.T) {
	root := os.Getenv("SMITHERS_SETUP_CRASH_ROOT")
	if root == "" {
		t.Skip("subprocess entrypoint")
	}
	bundle, err := installbundle.Open(os.Getenv("SMITHERS_TEST_SERVER_BUNDLE"))
	require.NoError(t, err)
	profile, err := microsandbox.Detect(root)
	require.NoError(t, err)
	sizing := microsandbox.ComputeSizing(profile)
	profileBytes, err := json.Marshal(map[string]any{"profile": profile, "sizing": sizing, "revision": bundle.Revision(), "manifest_sha256": bundle.ManifestSHA256()})
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(filepath.Join(root, "profile.json"), profileBytes, 0600))
	runtime, err := microsandbox.New(t.Context(), microsandbox.Config{
		Root: filepath.Join(root, "microvm"), Bundle: bundle, HostProfile: &profile,
		BundlePrograms: []string{filepath.Join(bundle.Root(), "bin", "smithers-coding-host")},
		CPUs:           sizing.CPUs, MemoryMiB: sizing.MemoryMiB,
		DiskMiB: int(microsandbox.MachineDiskBytes >> 20), MaxRunningVMs: sizing.Capacity,
		Environments: &microsandbox.EnvironmentConfig{
			PrepareCPUs: sizing.CPUs, PrepareMemoryMiB: sizing.MemoryMiB,
			PrepareDiskMiB:   int(microsandbox.MachineDiskBytes >> 20),
			LayerBudgetBytes: sizing.LayerBudgetBytes, MinFreeBytes: microsandbox.MinFreeDiskBytes,
		},
	})
	require.NoError(t, err)
	defer runtime.Close()
	require.NoError(t, os.WriteFile(filepath.Join(root, "owner"), []byte(runtime.Owner()), 0600))
	repository := repohost.NewClient(&repohost.StaticStorageSetResolver{URL: os.Getenv("SMITHERS_REPO_HOST_URL")}, os.Getenv("SMITHERS_REPO_HOST_AUTH_TOKEN"))
	u, err := url.Parse(os.Getenv("SMITHERS_PUBLIC_URL"))
	require.NoError(t, err)
	listener, err := net.Listen("tcp", u.Host)
	require.NoError(t, err)
	defer listener.Close()
	wrapper := crashCheckpointRuntime{Runtime: runtime, checkpoint: os.Getenv("SMITHERS_SETUP_CRASH_POINT"), marker: filepath.Join(root, "checkpoint")}
	err = StartWithOptions(t.Context(), nil, os.Stdout, os.Stderr, Options{
		Repository: repository, Workspace: wrapper, ComputeProvider: sandboxfake.New(), HostProfile: &profile,
		FlowHostProductAPIURL: u.String(),
	}, func(handler http.Handler) {
		server := &http.Server{Handler: handler}
		go server.Serve(listener)
		require.NoError(t, os.WriteFile(filepath.Join(root, "ready"), []byte("ready\n"), 0600))
	})
	require.NoError(t, err)
}

func TestRealInstallMachineCrashRecoveryHTTPPostgres(t *testing.T) {
	if os.Getenv("SMITHERS_REQUIRE_MICROVM_TESTS") != "1" {
		t.Skip("reference-host microVM qualification")
	}
	require.NotEmpty(t, os.Getenv("SMITHERS_TEST_SERVER_BUNDLE"))
	for _, checkpoint := range []string{"admitted", "prepared"} {
		t.Run(checkpoint, func(t *testing.T) {
			h := startRootLayerHarnessRuntime(t, true)
			mainRevision := h.commitMain(rootLayerFixtures()["go"])
			h.runSetupThroughSource()
			require.Equal(t, "done", h.steps()["source"].State)
			h.stop()
			root := t.TempDir()
			binary, err := os.Executable()
			require.NoError(t, err)
			var child *exec.Cmd
			var childDone chan error
			stop := func() {
				if child != nil {
					_ = child.Process.Kill()
					_ = <-childDone
					child = nil
				}
			}
			t.Cleanup(func() {
				stop()
				if log, err := os.ReadFile(filepath.Join(root, "child.log")); err == nil {
					if t.Failed() {
						t.Logf("child log: %s", tailText(string(log), 10000))
					}
					if evidence := os.Getenv("SMITHERS_SETUP_CRASH_EVIDENCE"); evidence != "" {
						require.NoError(t, os.MkdirAll(evidence, 0700))
						require.NoError(t, os.WriteFile(filepath.Join(evidence, checkpoint+".log"), log, 0600))
					}
				}
				if evidence := os.Getenv("SMITHERS_SETUP_CRASH_EVIDENCE"); evidence != "" {
					if profile, err := os.ReadFile(filepath.Join(root, "profile.json")); err == nil {
						require.NoError(t, os.MkdirAll(evidence, 0700))
						require.NoError(t, os.WriteFile(filepath.Join(evidence, checkpoint+"-profile.json"), profile, 0600))
					}
				}
				if owner, err := os.ReadFile(filepath.Join(root, "owner")); err == nil {
					sweepRealOwner(t, os.Getenv("SMITHERS_MICROSANDBOX_BIN"), string(owner))
				}
			})
			waitFile := func(path string, timeout time.Duration) {
				timer := time.NewTimer(timeout)
				defer timer.Stop()
				ticker := time.NewTicker(100 * time.Millisecond)
				defer ticker.Stop()
				var lastStatus time.Time
				for {
					if _, err := os.Stat(path); err == nil {
						return
					}
					select {
					case err := <-childDone:
						child = nil
						t.Fatalf("install host exited before %s: %v", filepath.Base(path), err)
					case <-timer.C:
						t.Fatalf("install host did not reach %s", filepath.Base(path))
					case <-ticker.C:
						if filepath.Base(path) == "checkpoint" && time.Since(lastStatus) >= time.Second {
							lastStatus = time.Now()
							step := h.steps()["machine"]
							if step.State == "failed" {
								t.Fatalf("Machine failed before %s checkpoint: %+v", checkpoint, step.Error)
							}
						}
					}
				}
			}
			start := func(point string) {
				_ = os.Remove(filepath.Join(root, "ready"))
				child = exec.Command(binary, "-test.run=^TestInstallMachineCrashProcess$", "-test.v", "-test.timeout=20m")
				child.Env = append(os.Environ(), "SMITHERS_SETUP_CRASH_ROOT="+root, "SMITHERS_SETUP_CRASH_POINT="+point)
				log, err := os.OpenFile(filepath.Join(root, "child.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
				require.NoError(t, err)
				child.Stdout, child.Stderr = log, log
				require.NoError(t, child.Start())
				childDone = make(chan error, 1)
				process, finished := child, childDone
				go func() { finished <- process.Wait() }()
				log.Close()
				waitFile(filepath.Join(root, "ready"), 2*time.Minute)
			}
			start(checkpoint)
			code, body := h.request("POST", "/api/install/setup/machine", `{}`, "crash-first-"+checkpoint)
			require.Equal(t, http.StatusAccepted, code, string(body))
			waitFile(filepath.Join(root, "checkpoint"), 15*time.Minute)
			var prepared microsandbox.Layer
			checkpointBytes, err := os.ReadFile(filepath.Join(root, "checkpoint"))
			require.NoError(t, err)
			require.NoError(t, json.Unmarshal(checkpointBytes, &prepared))
			var published map[string]string
			if checkpoint == "prepared" {
				require.NotEmpty(t, prepared.Key)
				published = publishedLayers(t, root)
				require.Contains(t, published, prepared.Key)
			}
			before := h.machineStep(t)
			require.Equal(t, "running", string(before.Status))
			require.NotEmpty(t, before.OperationID)
			var firstFence int64
			require.NoError(t, h.pool.QueryRow(t.Context(), `SELECT generation FROM product_job_dispatches WHERE operation_id=$1`, before.OperationID).Scan(&firstFence))
			stop()
			// Advance only the expired lease clock: no successful state or receipt
			// is written by the fixture. The restarted host reconciles normally.
			_, err = h.pool.Exec(t.Context(), `UPDATE product_job_dispatches SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE operation_id=$1`, before.OperationID)
			require.NoError(t, err)
			_, err = h.pool.Exec(t.Context(), `UPDATE install_settings SET value=jsonb_set(value,'{expires_at}',to_jsonb(clock_timestamp()-interval '1 second')) WHERE key='setup.step.machine'`)
			require.NoError(t, err)
			start("")
			require.Equal(t, "done", h.steps()["source"].State)
			require.Equal(t, "done", h.waitStep("machine", 15*time.Minute).State)
			after := h.machineStep(t)
			require.Equal(t, before.OperationID, after.OperationID)
			if checkpoint == "prepared" {
				require.Equal(t, prepared.Key, after.LayerKey, "recover the already published image")
				require.Equal(t, published, publishedLayers(t, root), "published snapshots must not be rebuilt")
			}
			require.NotEmpty(t, after.LayerKey)
			require.Equal(t, mainRevision, after.Revision)
			var recoveredFence int64
			require.NoError(t, h.pool.QueryRow(t.Context(), `SELECT generation FROM product_job_dispatches WHERE operation_id=$1`, after.OperationID).Scan(&recoveredFence))
			require.Greater(t, recoveredFence, firstFence)
			var completions int
			require.NoError(t, h.pool.QueryRow(t.Context(), `SELECT count(*) FROM product_job_events WHERE operation_id=$1 AND event_type='operation.completed'`, before.OperationID).Scan(&completions))
			require.Equal(t, 1, completions)
			if evidence := os.Getenv("SMITHERS_SETUP_CRASH_EVIDENCE"); evidence != "" {
				require.NoError(t, os.MkdirAll(evidence, 0700))
				receipt, err := json.MarshalIndent(map[string]any{"checkpoint": checkpoint, "passed": true, "operation": after.OperationID, "layer": after.LayerKey, "revision": after.Revision, "completions": completions, "first_fence": firstFence, "recovered_fence": recoveredFence, "profile": json.RawMessage(profileReceipt(t, root)), "completed_at": time.Now().UTC()}, "", "  ")
				require.NoError(t, err)
				require.NoError(t, os.WriteFile(filepath.Join(evidence, checkpoint+".json"), receipt, 0600))
			}
		})
	}
}

func profileReceipt(t *testing.T, root string) []byte {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(root, "profile.json"))
	require.NoError(t, err)
	return data
}

// Read the durable side effects independently of the builder's returned key.
// Last-use timestamps may advance, but snapshot creation must not repeat.
func publishedLayers(t *testing.T, root string) map[string]string {
	t.Helper()
	paths, err := filepath.Glob(filepath.Join(root, "microvm", "layers", "*.json"))
	require.NoError(t, err)
	facts := map[string]string{}
	for _, path := range paths {
		data, err := os.ReadFile(path)
		require.NoError(t, err)
		var record struct {
			Key       string `json:"key"`
			CreatedAt string `json:"createdAt"`
		}
		require.NoError(t, json.Unmarshal(data, &record))
		require.NotEmpty(t, record.Key)
		require.NotEmpty(t, record.CreatedAt)
		facts[record.Key] = record.CreatedAt
	}
	require.NotEmpty(t, facts)
	return facts
}
