package microsandbox

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
)

func TestMachineSizingMustBeExplicitIncludingPrepare(t *testing.T) {
	c := Config{CPUs: 2, MemoryMiB: 6144, DiskMiB: 32768, MaxRunningVMs: 1}
	require.NoError(t, validateSizing(c))
	for _, field := range []string{"cpus", "memory", "disk", "capacity"} {
		invalid := c
		switch field {
		case "cpus":
			invalid.CPUs = 0
		case "memory":
			invalid.MemoryMiB = 0
		case "disk":
			invalid.DiskMiB = 0
		case "capacity":
			invalid.MaxRunningVMs = 0
		}
		require.Error(t, validateSizing(invalid))
		_, err := New(t.Context(), invalid)
		message := "sizing is required"
		if field == "capacity" {
			message = "zero microVM capacity needs a detected zero-capacity profile"
		}
		require.ErrorContains(t, err, message, "refuse before invoking the VM executable")
	}
	invalid := c
	invalid.MaxRunningVMs = -1
	require.Error(t, validateSizing(invalid))
	p := HostProfile{MemoryBytes: 16 << 30, PerfCores: 1, DiskFreeBytes: 0}
	c.HostProfile = &p
	c.MaxRunningVMs = 0
	require.NoError(t, validateSizing(c))
	e := EnvironmentConfig{PrepareCPUs: 2, PrepareMemoryMiB: 6144, PrepareDiskMiB: 32768, MinFreeBytes: 40 << 30}
	require.NoError(t, e.validate(c))
	c.HostProfile = nil
	require.Error(t, e.validate(c))
	e.LayerBudgetBytes = 48 << 30
	require.NoError(t, e.validate(c))
	e.PrepareMemoryMiB++
	require.Error(t, e.validate(c))
	c.MaxRunningVMs = 1
	c.Environments = &e
	_, err := New(t.Context(), c)
	require.ErrorContains(t, err, "prepare sizing must equal one machine")
}

func TestPrepareAndReleasingMachinesCountAgainstCapacity(t *testing.T) {
	// spec §8.2.2, §8.3.2: every VM holds capacity through confirmed stop.
	r := &Runtime{config: Config{MaxRunningVMs: 1}, workspaces: map[string]*workspace{}}
	require.NoError(t, r.reserveAuxVM(t.Context(), "prepare"))
	require.Equal(t, 1, r.InUse())
	require.Error(t, r.reserveAuxVM(t.Context(), "verify"))
	r.mu.Lock()
	require.Error(t, r.admitRunningLocked(1))
	r.mu.Unlock()
	r.releaseAuxVM("prepare")
	require.Zero(t, r.InUse())
	for _, state := range []workspaceapi.WorkspaceState{workspaceapi.WorkspaceStarting, workspaceapi.WorkspaceRunning, workspaceapi.WorkspaceStopping} {
		r.workspaces = map[string]*workspace{"branch": newWorkspace(metadata{ID: "branch", State: string(state)}, "")}
		require.Error(t, r.reserveAuxVM(t.Context(), "prepare"))
		require.Equal(t, 1, r.InUse())
	}
	r.workspaces = map[string]*workspace{"branch": newWorkspace(metadata{ID: "branch", State: string(workspaceapi.WorkspaceStopped)}, "")}
	require.NoError(t, r.reserveAuxVM(t.Context(), "prepare"))
	r.releaseAuxVM("prepare")
	// Concurrent prepares can never both reserve the last machine.
	var wg sync.WaitGroup
	results := make(chan error, 2)
	for _, name := range []string{"a", "b"} {
		wg.Go(func() { results <- r.reserveAuxVM(t.Context(), name) })
	}
	wg.Wait()
	close(results)
	success := 0
	for err := range results {
		if err == nil {
			success++
		}
	}
	require.Equal(t, 1, success)
}

func TestCapacityReadOnEveryAdmissionAndLoweringDoesNotStopHeldVM(t *testing.T) {
	r := &Runtime{config: Config{MaxRunningVMs: 2}, workspaces: map[string]*workspace{}}
	limit := 1
	reads := 0
	r.SetCapacityReader(func(context.Context) (int, error) { reads++; return limit, nil })
	require.NoError(t, r.reserveAuxVM(t.Context(), "prepare"))
	limit = 0
	require.Error(t, r.reserveAuxVM(t.Context(), "new"))
	require.Equal(t, 1, r.InUse())
	require.Equal(t, 2, reads)
	limit = 9
	require.NoError(t, r.reserveAuxVM(t.Context(), "second"))
	require.Error(t, r.reserveAuxVM(t.Context(), "third"))
	cause := errors.New("owner settings unavailable")
	r.SetCapacityReader(func(context.Context) (int, error) { return 0, cause })
	require.ErrorIs(t, r.reserveAuxVM(t.Context(), "new"), cause)
	r.SetCapacityReader(func(context.Context) (int, error) { return -1, nil })
	require.ErrorContains(t, r.reserveAuxVM(t.Context(), "new"), "negative")
}

func TestPrepareFailedRemovalKeepsCapacityUntilConfirmed(t *testing.T) {
	// A local failing process injects transport/stop failure; no real VM is booted.
	root := t.TempDir()
	binary := filepath.Join(root, "msb")
	require.NoError(t, os.WriteFile(binary, []byte("#!/bin/sh\nexit 1\n"), 0700))
	r := &Runtime{cli: &cli{binary: binary, home: root}, config: Config{MaxRunningVMs: 1}, workspaces: map[string]*workspace{}}
	require.NoError(t, r.reserveAuxVM(t.Context(), "prepare"))
	require.Error(t, r.finishAuxVM("prepare"))
	require.Equal(t, 1, r.InUse())
	require.NoError(t, os.WriteFile(binary, []byte("#!/bin/sh\nexit 0\n"), 0700))
	// The next product admission reconciles failed cleanup, without private retry.
	require.NoError(t, r.reserveAuxVM(t.Context(), "next"))
	require.Equal(t, 1, r.InUse())
	require.NotContains(t, r.auxVMs, "prepare")
}

func TestCachedLayerCapacityRefusalPreservesSnapshotAndRecovers(t *testing.T) {
	// spec §8.2.2: admission is temporary; a verified layer is reusable.
	root := t.TempDir()
	artifact := filepath.Join(root, ".microsandbox", "snapshot")
	require.NoError(t, os.MkdirAll(artifact, 0700))
	require.NoError(t, os.WriteFile(filepath.Join(artifact, "disk"), []byte("snapshot"), 0600))
	r := &Runtime{config: Config{MaxRunningVMs: 1}, root: root, owner: "smithers-backend-0123456789abcdef", workspaces: map[string]*workspace{}}
	e := &environments{runtime: r}
	value := dependencyLayer{DetectorVersion: DetectorVersion}
	key, encoded, err := recipeKey("", value)
	require.NoError(t, err)
	name := e.layerName(layerDependency, key)
	record := layerRecord{Schema: layerSchema, Kind: layerDependency, Key: key, Name: name, Recipe: encoded}
	require.NoError(t, os.MkdirAll(e.layerDir(), 0700))
	require.NoError(t, writeJSON(e.recordPath(name), record))
	listing, err := json.Marshal([]map[string]string{{"name": name, "artifact_path": artifact}})
	require.NoError(t, err)
	marker, err := json.Marshal(map[string]string{"key": key})
	require.NoError(t, err)
	binary := filepath.Join(root, "msb")
	log := filepath.Join(root, "requests")
	script := fmt.Sprintf("#!/bin/sh\necho \"$*\" >> %s\nrequest=\"\"\ncase \"$*\" in *run\\ exec*) request=$(cat); printf '\\000SMITHERS-EXIT 0\\000' >&2 ;; esac\ncase \"$* $request\" in\n' snapshot') ;;\n'snapshot list --format json ') printf '%%s' %s ;;\n*'cat '*) printf '%%s' %s ;;\nesac\n", shellQuote(log), shellQuote(string(listing)), shellQuote(string(marker)))
	require.NoError(t, os.WriteFile(binary, []byte(script), 0700))
	r.cli = &cli{binary: binary, home: root}
	require.NoError(t, r.reserveAuxVM(t.Context(), "busy"))
	_, err = e.ensure(t.Context(), layerDependency, value, "", "fixture", nil)
	require.ErrorContains(t, err, "capacity reached")
	require.FileExists(t, e.recordPath(name))
	require.FileExists(t, filepath.Join(artifact, "disk"))
	requests, err := os.ReadFile(log)
	require.NoError(t, err)
	require.NotContains(t, string(requests), "snapshot remove")
	require.NotContains(t, string(requests), "create ")
	// A completed prepare whose cleanup failed remains held. The next layer
	// lookup retries that cleanup through production admission.
	require.NoError(t, os.WriteFile(binary, []byte("#!/bin/sh\nexit 1\n"), 0700))
	require.Error(t, r.finishAuxVM("busy"))
	require.Equal(t, 1, r.InUse())
	require.NoError(t, os.WriteFile(binary, []byte(script), 0700))
	got, err := e.ensure(t.Context(), layerDependency, value, "", "fixture", nil)
	require.NoError(t, err)
	require.Equal(t, name, got.Name)
	require.Zero(t, r.InUse())
}

func TestCloseRetriesOnlyFailedAuxiliaryCleanup(t *testing.T) {
	root := t.TempDir()
	binary := filepath.Join(root, "msb")
	require.NoError(t, os.WriteFile(binary, []byte("#!/bin/sh\nexit 1\n"), 0700))
	r := &Runtime{cli: &cli{binary: binary, home: root}, config: Config{MaxRunningVMs: 1}, workspaces: map[string]*workspace{}}
	require.NoError(t, r.reserveAuxVM(t.Context(), "prepare"))
	require.Error(t, r.finishAuxVM("prepare"))
	require.Equal(t, 1, r.InUse())
	require.NoError(t, os.WriteFile(binary, []byte("#!/bin/sh\nexit 0\n"), 0700))
	require.NoError(t, r.Close())
	require.Zero(t, r.InUse())
	require.NoError(t, r.Close())
}

func TestMissingMachineDoesNotHoldCapacity(t *testing.T) {
	// spec §8.3.2: startup releases a slot whose VM the runtime does not have.
	r := &Runtime{config: Config{MaxRunningVMs: 1}, workspaces: map[string]*workspace{
		"lost": newWorkspace(metadata{ID: "lost", State: string(workspaceapi.WorkspaceRecoveryRequired)}, ""),
	}}
	require.Zero(t, r.InUse())
	require.NoError(t, r.reserveAuxVM(t.Context(), "prepare"))
}

func TestSlowCapacityReadDoesNotBlockUsage(t *testing.T) {
	r := &Runtime{config: Config{MaxRunningVMs: 1}}
	entered, release := make(chan struct{}), make(chan struct{})
	r.SetCapacityReader(func(context.Context) (int, error) { close(entered); <-release; return 1, nil })
	done := make(chan error, 1)
	go func() { done <- r.reserveAuxVM(t.Context(), "prepare") }()
	<-entered
	usage := make(chan int, 1)
	go func() { usage <- r.InUse() }()
	select {
	case n := <-usage:
		require.Zero(t, n)
	case <-time.After(time.Second):
		t.Error("capacity database read held runtime mutex")
	}
	close(release)
	require.NoError(t, <-done)
}

func TestSlowAuxCleanupDoesNotBlockUsage(t *testing.T) {
	root := t.TempDir()
	entered, release := filepath.Join(root, "entered"), filepath.Join(root, "release")
	binary := filepath.Join(root, "msb")
	// A real local process blocks cleanup; no VM/hardware is needed to test lock scope.
	script := fmt.Sprintf("#!/bin/sh\ntouch %s\nwhile [ ! -f %s ]; do sleep 0.01; done\n", shellQuote(entered), shellQuote(release))
	require.NoError(t, os.WriteFile(binary, []byte(script), 0700))
	r := &Runtime{cli: &cli{binary: binary, home: root}, config: Config{MaxRunningVMs: 1}, auxVMs: map[string]struct{}{"old": {}}, auxCleanup: map[string]struct{}{"old": {}}}
	done := make(chan error, 1)
	go func() { done <- r.reserveAuxVM(t.Context(), "next") }()
	require.Eventually(t, func() bool { _, err := os.Stat(entered); return err == nil }, time.Second, time.Millisecond)
	usage := make(chan int, 1)
	go func() { usage <- r.InUse() }()
	select {
	case n := <-usage:
		require.Equal(t, 1, n)
	case <-time.After(time.Second):
		t.Error("cleanup process held runtime mutex")
	}
	require.NoError(t, os.WriteFile(release, nil, 0600))
	require.NoError(t, <-done)
}
func TestCachedLayerVerificationCleanupFailurePreservesSnapshot(t *testing.T) {
	// spec §8.2.2: admission is temporary; a verified layer is reusable.
	root := t.TempDir()
	artifact := filepath.Join(root, ".microsandbox", "snapshot")
	require.NoError(t, os.MkdirAll(artifact, 0700))
	require.NoError(t, os.WriteFile(filepath.Join(artifact, "disk"), []byte("snapshot"), 0600))
	r := &Runtime{config: Config{MaxRunningVMs: 1}, root: root, owner: "smithers-backend-0123456789abcdef", workspaces: map[string]*workspace{}}
	e := &environments{runtime: r}
	value := dependencyLayer{DetectorVersion: DetectorVersion}
	key, encoded, err := recipeKey("", value)
	require.NoError(t, err)
	name := e.layerName(layerDependency, key)
	record := layerRecord{Schema: layerSchema, Kind: layerDependency, Key: key, Name: name, Recipe: encoded}
	require.NoError(t, os.MkdirAll(e.layerDir(), 0700))
	require.NoError(t, writeJSON(e.recordPath(name), record))
	listing, err := json.Marshal([]map[string]string{{"name": name, "artifact_path": artifact}})
	require.NoError(t, err)
	marker, err := json.Marshal(map[string]string{"key": key})
	require.NoError(t, err)
	binary := filepath.Join(root, "msb")
	log := filepath.Join(root, "requests")
	script := fmt.Sprintf("#!/bin/sh\necho \"$*\" >> %s\nrequest=\"\"\ncase \"$*\" in *run\\ exec*) request=$(cat); printf '\\000SMITHERS-EXIT 0\\000' >&2 ;; esac\ncase \"$* $request\" in\n' snapshot') ;;\n'snapshot list --format json ') printf '%%s' %s ;;\n*'cat '*) printf '%%s' %s ;;\nesac\n", shellQuote(log), shellQuote(string(listing)), shellQuote(string(marker)))
	require.NoError(t, os.WriteFile(binary, []byte(script), 0700))
	r.cli = &cli{binary: binary, home: root}
	// Verification succeeds, then a transport failure prevents confirmed removal.
	script = strings.Replace(script, "request=\"\"\ncase \"$*\" in *run\\ exec*) request=$(cat); printf '\\000SMITHERS-EXIT 0\\000' >&2 ;; esac\ncase \"$* $request\" in", "request=\"\"\ncase \"$*\" in *run\\ exec*) request=$(cat); printf '\\000SMITHERS-EXIT 0\\000' >&2 ;; esac\ncase \"$* $request\" in\nremove\\ *) echo failure >&2; exit 2 ;;", 1)
	require.NoError(t, os.WriteFile(binary, []byte(script), 0700))
	_, err = e.ensure(t.Context(), layerDependency, value, "", "fixture", nil)
	require.Error(t, err)
	require.FileExists(t, e.recordPath(name))
	require.FileExists(t, filepath.Join(artifact, "disk"))
	require.Equal(t, 1, r.InUse())
	requests, err := os.ReadFile(log)
	require.NoError(t, err)
	require.NotContains(t, string(requests), "snapshot remove")
	// The snapshot remains verified and reusable while cleanup holds its slot.
	got, err := e.ensure(t.Context(), layerDependency, value, "", "fixture", nil)
	require.NoError(t, err)
	require.Equal(t, name, got.Name)
}

func TestRunningWorkspaceStartDoesNotReadCapacity(t *testing.T) {
	r := &Runtime{config: Config{MaxRunningVMs: 1}, workspaces: map[string]*workspace{
		"running": newWorkspace(metadata{ID: "running", State: string(workspaceapi.WorkspaceRunning)}, ""),
	}}
	r.SetCapacityReader(func(context.Context) (int, error) {
		t.Fatal("an existing running VM needs no admission")
		return 0, errors.New("unreachable")
	})
	ws, err := r.StartWorkspace(t.Context(), "running")
	require.NoError(t, err)
	require.Equal(t, workspaceapi.WorkspaceRunning, ws.State)
}

func TestCachedLayerMarkerFailureClassification(t *testing.T) {
	// A real local CLI process injects failures, avoiding real VMs for this
	// unit transport regression. spec §8.6.1 requires reusable recipe layers.
	for _, class := range []string{"transport", "present", "missing"} {
		t.Run(class, func(t *testing.T) {
			root := t.TempDir()
			artifact := filepath.Join(root, ".microsandbox", "snapshot")
			require.NoError(t, os.MkdirAll(artifact, 0700))
			require.NoError(t, os.WriteFile(filepath.Join(artifact, "disk"), []byte("snapshot"), 0600))
			r := &Runtime{config: Config{CPUs: 2, MemoryMiB: 2048, DiskMiB: 8192, MaxRunningVMs: 1}, root: root, owner: "smithers-backend-0123456789abcdef", workspaces: map[string]*workspace{}}
			e := &environments{runtime: r, config: EnvironmentConfig{PrepareTimeout: time.Minute, KeepPerFamily: 1}}
			value := dependencyLayer{DetectorVersion: DetectorVersion}
			key, encoded, err := recipeKey("", value)
			require.NoError(t, err)
			name := e.layerName(layerDependency, key)
			record := layerRecord{Schema: layerSchema, Kind: layerDependency, Key: key, Name: name, Recipe: encoded}
			require.NoError(t, os.MkdirAll(e.layerDir(), 0700))
			require.NoError(t, writeJSON(e.recordPath(name), record))
			listing, err := json.Marshal([]map[string]string{{"name": name, "artifact_path": artifact}})
			require.NoError(t, err)
			marker, err := json.Marshal(map[string]string{"key": key})
			require.NoError(t, err)
			binary := filepath.Join(root, "msb")
			log := filepath.Join(root, "requests")
			script := fmt.Sprintf("#!/bin/sh\necho \"$*\" >> %s\nrequest=\"\"\ncase \"$*\" in *run\\ exec*) request=$(cat); printf '\\000SMITHERS-EXIT 0\\000' >&2 ;; esac\ncase \"$* $request\" in\n' snapshot') ;;\n'snapshot list --format json ') printf '%%s' %s ;;\n*'cat '*) printf '%%s' %s ;;\nesac\n", shellQuote(log), shellQuote(string(listing)), shellQuote(string(marker)))
			require.NoError(t, os.WriteFile(binary, []byte(script), 0700))
			r.cli = &cli{binary: binary, home: root}
			failure := "*'cat '*) echo transport-failure >&2; exit 1 ;;\n*'if [ -e '*) echo transport-failure >&2; exit 1 ;;"
			if class == "missing" {
				failure = fmt.Sprintf("*'cat '*) if [ -e %s ]; then printf '%%s' %s; else echo 'cat: No such file or directory' >&2; exit 1; fi ;;\n*'if [ -e '*) printf missing ;;\n'snapshot create '*) touch %s ;;\n*run\\ exec|*run\\ root-recipe*) :; printf '\\000SMITHERS-EXIT 0\\000' >&2 ;;", shellQuote(filepath.Join(root, "rebuilt")), shellQuote(string(marker)), shellQuote(filepath.Join(root, "rebuilt")))
			}
			if class == "present" {
				failure = "*'cat '*) echo read-failure >&2; exit 1 ;;\n*'if [ -e '*) printf present ;;"
			}
			broken := strings.Replace(script, "*'cat '*) printf", failure+"\n*'cat '*) printf", 1)
			require.NoError(t, os.WriteFile(binary, []byte(broken), 0700))
			_, err = e.ensure(t.Context(), layerDependency, value, "", "fixture", nil)
			if class != "missing" {
				require.ErrorContains(t, err, "read layer")
				require.FileExists(t, e.recordPath(name))
				requests, readErr := os.ReadFile(log)
				require.NoError(t, readErr)
				require.NotContains(t, string(requests), "snapshot remove")
				require.FileExists(t, filepath.Join(artifact, "disk"))
				require.NoError(t, os.WriteFile(binary, []byte(script), 0700))
				got, retryErr := e.ensure(t.Context(), layerDependency, value, "", "fixture", nil)
				require.NoError(t, retryErr)
				require.Equal(t, name, got.Name)
			} else {
				// spec §8.6.1: a layer must hold its preparation marker;
				// proven absence invalidates it and ensure completes a rebuild.
				require.NoError(t, err)
				requests, readErr := os.ReadFile(log)
				require.NoError(t, readErr)
				require.Contains(t, string(requests), "snapshot remove")
				require.Contains(t, string(requests), "create ")
			}
			require.Zero(t, r.InUse())
		})
	}
}
