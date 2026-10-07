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

	"github.com/prometheus/client_golang/prometheus"
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
	require.NoError(t, os.WriteFile(binary, []byte("#!/bin/sh\ncase \"$1\" in list) echo '[]';; esac\nexit 0\n"), 0700))
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
	script := fmt.Sprintf("#!/bin/sh\necho \"$*\" >> %s\nrequest=\"\"\ncase \"$*\" in *run\\ exec*) request=$(cat); printf '\\000SMITHERS-EXIT 0\\000' >&2 ;; esac\ncase \"$* $request\" in\n' snapshot') ;;\n'list --format json ') echo '[]';;\n'snapshot list --format json ') printf '%%s' %s ;;\n*'cat '*) printf '%%s' %s ;;\nesac\n", shellQuote(log), shellQuote(string(listing)), shellQuote(string(marker)))
	require.NoError(t, os.WriteFile(binary, []byte(script), 0700))
	r.cli = &cli{binary: binary, home: root}
	require.NoError(t, r.reserveAuxVM(t.Context(), "busy"))
	_, err = e.ensure(t.Context(), layerDependency, value, "", "fixture", nil, false)
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
	got, err := e.ensure(t.Context(), layerDependency, value, "", "fixture", nil, false)
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
	require.NoError(t, os.WriteFile(binary, []byte("#!/bin/sh\ncase \"$1\" in list) echo '[]';; esac\nexit 0\n"), 0700))
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
	script := fmt.Sprintf("#!/bin/sh\ntouch %s\nwhile [ ! -f %s ]; do sleep 0.01; done\ncase \"$1\" in list) echo '[]';; esac\n", shellQuote(entered), shellQuote(release))
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
	script := fmt.Sprintf("#!/bin/sh\necho \"$*\" >> %s\nrequest=\"\"\ncase \"$*\" in *run\\ exec*) request=$(cat); printf '\\000SMITHERS-EXIT 0\\000' >&2 ;; esac\ncase \"$* $request\" in\n' snapshot') ;;\n'list --format json ') echo '[]';;\n'snapshot list --format json ') printf '%%s' %s ;;\n*'cat '*) printf '%%s' %s ;;\nesac\n", shellQuote(log), shellQuote(string(listing)), shellQuote(string(marker)))
	require.NoError(t, os.WriteFile(binary, []byte(script), 0700))
	r.cli = &cli{binary: binary, home: root}
	// Verification succeeds, then a transport failure prevents confirmed removal.
	script = strings.Replace(script, "request=\"\"\ncase \"$*\" in *run\\ exec*) request=$(cat); printf '\\000SMITHERS-EXIT 0\\000' >&2 ;; esac\ncase \"$* $request\" in", "request=\"\"\ncase \"$*\" in *run\\ exec*) request=$(cat); printf '\\000SMITHERS-EXIT 0\\000' >&2 ;; esac\ncase \"$* $request\" in\nremove\\ *) echo failure >&2; exit 2 ;;", 1)
	script = strings.Replace(script, "'list --format json ') echo '[]';;", "'list --format json ') exit 2;;", 1)
	require.NoError(t, os.WriteFile(binary, []byte(script), 0700))
	_, err = e.ensure(t.Context(), layerDependency, value, "", "fixture", nil, false)
	require.Error(t, err)
	require.FileExists(t, e.recordPath(name))
	require.FileExists(t, filepath.Join(artifact, "disk"))
	require.Equal(t, 1, r.InUse())
	requests, err := os.ReadFile(log)
	require.NoError(t, err)
	require.NotContains(t, string(requests), "snapshot remove")
	// The snapshot remains verified and reusable while cleanup holds its slot.
	got, err := e.ensure(t.Context(), layerDependency, value, "", "fixture", nil, false)
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
			e := &environments{runtime: r, config: EnvironmentConfig{Image: DefaultImage, PrepareTimeout: time.Minute, KeepPerFamily: 1}}
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
			script := fmt.Sprintf("#!/bin/sh\necho \"$*\" >> %s\nrequest=\"\"\ncase \"$*\" in *run\\ exec*) request=$(cat); printf '\\000SMITHERS-EXIT 0\\000' >&2 ;; esac\ncase \"$* $request\" in\n' snapshot') ;;\n'list --format json ') echo '[]';;\n'snapshot list --format json ') printf '%%s' %s ;;\n*'cat '*) printf '%%s' %s ;;\nesac\n", shellQuote(log), shellQuote(string(listing)), shellQuote(string(marker)))
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
			_, err = e.ensure(t.Context(), layerDependency, value, "", "fixture", nil, false)
			if class != "missing" {
				require.ErrorContains(t, err, "read layer")
				require.FileExists(t, e.recordPath(name))
				requests, readErr := os.ReadFile(log)
				require.NoError(t, readErr)
				require.NotContains(t, string(requests), "snapshot remove")
				require.FileExists(t, filepath.Join(artifact, "disk"))
				require.NoError(t, os.WriteFile(binary, []byte(script), 0700))
				got, retryErr := e.ensure(t.Context(), layerDependency, value, "", "fixture", nil, false)
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

func admissionFixture() (*Runtime, AdmissionProviders) {
	p := &HostProfile{MemoryBytes: 64 << 30, PerfCores: 10, DiskFreeBytes: 200 << 30}
	r := &Runtime{admissionStarted: time.Now().Add(-time.Hour), config: Config{MaxRunningVMs: 1, HostProfile: p}, workspaces: map[string]*workspace{}}
	r.SetCapacityReader(func(context.Context) (int, error) { return 1, nil })
	providers := AdmissionProviders{Ready: func(context.Context, AdmissionRequest) error { return nil }, FreeDisk: func(context.Context) (int64, error) { return 200 << 30, nil }}
	return r, providers
}

func TestAdmissionCoalescingPromotionAndConfirmedStop(t *testing.T) {
	r, p := admissionFixture()
	for _, row := range []struct{ class, holder, actor string }{{"todo", "C", "T6"}, {"person", "E", "Alice"}, {"person", "C", "Ben"}, {"background", "B", "review"}} {
		_, err := r.Request(row.class, row.holder, row.actor, "wake")
		require.NoError(t, err)
	}
	rows := r.AdmissionSnapshot()
	require.Equal(t, []int{2, 1, 2, 3}, []int{rows[0].Position, rows[1].Position, rows[2].Position, rows[3].Position})
	got, err := r.GrantNext(t.Context(), p)
	require.NoError(t, err)
	require.Equal(t, "E", got.Holder)
	require.Equal(t, 1, r.InUse())
	now := time.Date(2026, 10, 4, 0, 0, 0, 0, time.UTC)
	require.True(t, r.CancelAdmission("E", "Alice", now))
	got, err = r.GrantNext(t.Context(), p)
	require.NoError(t, err)
	require.Empty(t, got.Holder)
	require.Empty(t, r.AdmissionForceStops(now.Add(59*time.Second)))
	require.Equal(t, []string{"E"}, r.AdmissionForceStops(now.Add(time.Minute)))
	require.Equal(t, 1, r.InUse())
	r.ConfirmAdmissionStop("E", false)
	got, err = r.GrantNext(t.Context(), p)
	require.NoError(t, err)
	require.Equal(t, "C", got.Holder)
	require.Equal(t, 1, r.InUse())
	_, err = r.Request("person", "C", "Cara", "terminal")
	require.NoError(t, err)
	require.False(t, r.CancelAdmission("C", "Ben", now))
	require.False(t, r.CancelAdmission("C", "T6", now))
	require.True(t, r.CancelAdmission("C", "Cara", now))
	require.Equal(t, 1, r.InUse())
}

func TestAdmissionMissingProvidersFailsClosed(t *testing.T) {
	for _, missing := range []string{"ready", "disk", "owner", "profile", "authority"} {
		t.Run(missing, func(t *testing.T) {
			r, p := admissionFixture()
			switch missing {
			case "ready":
				p.Ready = nil
			case "disk":
				p.FreeDisk = nil
			case "owner":
				r.SetCapacityReader(nil)
			case "profile":
				r.config.HostProfile = nil
			case "authority":
				p.Ready = func(context.Context, AdmissionRequest) error { return errors.New("binding unavailable") }
			}
			_, err := r.Request("todo", "D", "T5", "run")
			require.NoError(t, err)
			_, err = r.GrantNext(t.Context(), p)
			require.Error(t, err)
			require.Zero(t, r.InUse())
			require.Equal(t, "waiting", r.AdmissionSnapshot()[0].State)
		})
	}
}

func TestAdmissionDiskRecheckAndLoweredOwnerCapacity(t *testing.T) {
	r, p := admissionFixture()
	r.config.MaxRunningVMs = 3
	owner := 3
	r.SetCapacityReader(func(context.Context) (int, error) { return owner, nil })
	free := int64(140 << 30)
	reads := 0
	p.FreeDisk = func(context.Context) (int64, error) { reads++; return free, nil }
	for _, id := range []string{"A", "B", "C"} {
		_, err := r.Request("person", id, id, "terminal")
		require.NoError(t, err)
	}
	for _, id := range []string{"A", "B"} {
		got, err := r.GrantNext(t.Context(), p)
		require.NoError(t, err)
		require.Equal(t, id, got.Holder)
	}
	free = 100 << 30
	got, err := r.GrantNext(t.Context(), p)
	require.NoError(t, err)
	require.Empty(t, got.Holder)
	require.Equal(t, 2, r.InUse())
	free = 140 << 30
	owner = 1
	got, err = r.GrantNext(t.Context(), p)
	require.NoError(t, err)
	require.Empty(t, got.Holder)
	require.Equal(t, 2, r.InUse())
	owner = 3
	got, err = r.GrantNext(t.Context(), p)
	require.NoError(t, err)
	require.Equal(t, "C", got.Holder)
	require.Equal(t, 5, reads)
}

func TestAdmissionPrepareTransferCountsOneSlot(t *testing.T) {
	r, p := admissionFixture()
	_, err := r.Request("person", "H", "Alice", "terminal")
	require.NoError(t, err)
	_, err = r.GrantNext(t.Context(), p)
	require.NoError(t, err)
	require.NoError(t, r.BindAdmissionMachine("H", "prepare"))
	r.auxVMs = map[string]struct{}{"prepare": {}}
	require.Equal(t, 1, r.InUse())
	require.Error(t, r.BindAdmissionMachine("H", "branch"))
	delete(r.auxVMs, "prepare")
	r.ConfirmAdmissionStop("H", true)
	require.Equal(t, 1, r.InUse())
	require.NoError(t, r.BindAdmissionMachine("H", "branch"))
	r.workspaces["H"] = newWorkspace(metadata{ID: "H", Machine: "branch", State: "starting"}, "")
	require.Equal(t, 1, r.InUse())
	r.workspaces["H"].State = "stopped"
	r.ConfirmAdmissionStop("H", false)
	require.Zero(t, r.InUse())
	require.Equal(t, "released", r.AdmissionSnapshot()[0].State)
}

func TestAdmissionUnknownSafetyBlocksRelease(t *testing.T) {
	now := time.Date(2026, 10, 4, 0, 0, 0, 0, time.UTC)
	for _, unsafe := range []string{"presence_unknown", "sessions_unknown", "run_unknown", "presence", "terminal", "ssh", "step", "burst_unknown", "burst_open", "flush_unknown", "unflushed", "capture", "restart", "safe"} {
		t.Run(unsafe, func(t *testing.T) {
			r, p := admissionFixture()
			_, err := r.Request("todo", "A", "T1", "run")
			require.NoError(t, err)
			_, err = r.GrantNext(t.Context(), p)
			require.NoError(t, err)
			_, err = r.Request("person", "D", "Alice", "terminal")
			require.NoError(t, err)
			s := AdmissionSafety{Holder: "A", IdleSince: now.Add(-time.Hour), PresenceKnown: true, SessionsKnown: true, RunKnown: true}
			start := now.Add(-time.Minute)
			switch unsafe {
			case "presence_unknown":
				s.PresenceKnown = false
			case "sessions_unknown":
				s.SessionsKnown = false
			case "run_unknown":
				s.RunKnown = false
			case "presence":
				s.Presence = true
			case "terminal":
				s.Terminal = true
			case "ssh":
				s.SSH = true
			case "step":
				s.RunningStep = true
			case "burst_unknown":
				s.BurstsEnabled = true
			case "burst_open":
				s.BurstsEnabled = true
				s.BurstsKnown = true
				s.BurstOpen = true
				s.CaptureConfirmed = true
			case "flush_unknown":
				s.DocumentsEnabled = true
			case "unflushed":
				s.DocumentsEnabled = true
				s.DocumentsKnown = true
				s.Unflushed = true
				s.CaptureConfirmed = true
			case "capture":
				s.DocumentsEnabled = true
				s.DocumentsKnown = true
			case "restart":
				start = now.Add(-29900 * time.Millisecond)
			}
			got := r.AdmissionIdleRelease(now, start, []AdmissionSafety{s})
			if unsafe == "safe" {
				require.Equal(t, "A", got)
			} else {
				require.Empty(t, got)
			}
			require.Equal(t, 1, r.InUse())
		})
	}
}

func TestAdmissionConcurrentGrantsAndCancellationDuringProviderRead(t *testing.T) {
	r, p := admissionFixture()
	for i := 0; i < 50; i++ {
		_, err := r.Request("person", fmt.Sprintf("branch%d", i%10), fmt.Sprint(i), "terminal")
		require.NoError(t, err)
	}
	var wg sync.WaitGroup
	grants := make(chan AdmissionRequest, 50)
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			got, err := r.GrantNext(t.Context(), p)
			if err != nil {
				t.Error(err)
			}
			if got.Holder != "" {
				grants <- got
			}
		}()
	}
	wg.Wait()
	close(grants)
	require.Len(t, grants, 1)
	require.Equal(t, 1, r.InUse())
	r, p = admissionFixture()
	_, err := r.Request("person", "A", "Alice", "terminal")
	require.NoError(t, err)
	p.Ready = func(context.Context, AdmissionRequest) error { r.CancelAdmission("A", "Alice", time.Now()); return nil }
	got, err := r.GrantNext(t.Context(), p)
	require.NoError(t, err)
	require.Empty(t, got.Holder)
	require.Zero(t, r.InUse())
}

func TestAdmissionIdleTimeoutsAndLongestIdle(t *testing.T) {
	now := time.Date(2026, 10, 4, 0, 0, 0, 0, time.UTC)
	for _, tc := range []struct {
		state   string
		elapsed time.Duration
		want    string
	}{{"", 1799 * time.Second, ""}, {"", 1800 * time.Second, "A"}, {"in_review", 119 * time.Second, ""}, {"in_review", 120 * time.Second, "A"}, {"needs_you", 120 * time.Second, "A"}, {"paused", 120 * time.Second, "A"}, {"working", 120 * time.Second, ""}} {
		t.Run(fmt.Sprint(tc.state, tc.elapsed), func(t *testing.T) {
			r, p := admissionFixture()
			_, err := r.Request("todo", "A", "T1", "run")
			require.NoError(t, err)
			_, err = r.GrantNext(t.Context(), p)
			require.NoError(t, err)
			s := AdmissionSafety{Holder: "A", TODOState: tc.state, IdleSince: now.Add(-tc.elapsed), PresenceKnown: true, SessionsKnown: true, RunKnown: true}
			require.Equal(t, tc.want, r.AdmissionIdleRelease(now, now.Add(-time.Hour), []AdmissionSafety{s}))
		})
	}
	r, p := admissionFixture()
	r.SetCapacityReader(func(context.Context) (int, error) { return 2, nil })
	for _, id := range []string{"A", "B"} {
		_, err := r.Request("todo", id, id, "run")
		require.NoError(t, err)
		_, err = r.GrantNext(t.Context(), p)
		require.NoError(t, err)
	}
	_, err := r.Request("person", "C", "Alice", "terminal")
	require.NoError(t, err)
	a := AdmissionSafety{Holder: "A", IdleSince: now.Add(-time.Minute), PresenceKnown: true, SessionsKnown: true, RunKnown: true}
	b := a
	b.Holder = "B"
	b.IdleSince = now.Add(-2 * time.Minute)
	require.Equal(t, "B", r.AdmissionIdleRelease(now, now.Add(-30*time.Second), []AdmissionSafety{a, b}))
}

func TestMachineCapacityRefusalIsTyped(t *testing.T) {
	r := &Runtime{auxVMs: map[string]struct{}{"prepare": {}}}
	var refusal *CapacityError
	require.ErrorAs(t, r.admitRunningLocked(1), &refusal)
	require.Equal(t, "machine_capacity", refusal.Code)
	require.Equal(t, "capacity", refusal.Class)
}

func TestFailedBootRetainsCapacityUntilConfirmedStop(t *testing.T) {
	for _, mode := range []string{"create", "start"} {
		t.Run(mode, func(t *testing.T) {
			root := t.TempDir()
			binary := filepath.Join(root, "msb")
			machine := "smthrs-test"
			script := fmt.Sprintf("#!/bin/sh\ncase \"$1\" in\nlist) echo '[{\"name\":\"%s\",\"status\":\"running\"}]' ;;\n*) echo injected-failure >&2; exit 2 ;;\nesac\n", machine)
			require.NoError(t, os.WriteFile(binary, []byte(script), 0700))
			require.NoError(t, os.MkdirAll(filepath.Join(root, "workspaces"), 0700))
			r := &Runtime{cli: &cli{binary: binary, home: root}, root: root, owner: "smithers-backend-0123456789abcdef", config: Config{MaxRunningVMs: 1}, workspaces: map[string]*workspace{}}
			if mode == "create" {
				// createFrom's machine name is deterministic; make failed deletion report it still running.
				machine = r.machineName("A")
				script = strings.ReplaceAll(script, "smthrs-test", machine)
				require.NoError(t, os.WriteFile(binary, []byte(script), 0700))
				_, err := r.createFrom(t.Context(), workspaceapi.WorkspaceSpec{ID: "A"}, Layer{})
				require.Error(t, err)
			} else {
				directory := filepath.Join(root, "workspaces", "A")
				require.NoError(t, os.Mkdir(directory, 0700))
				r.workspaces["A"] = newWorkspace(metadata{ID: "A", Machine: machine, State: "stopped"}, directory)
				_, err := r.StartWorkspace(t.Context(), "A")
				require.Error(t, err)
			}
			registry := prometheus.NewRegistry()
			require.NoError(t, registry.Register(r.MachineMetrics()))
			families, err := registry.Gather()
			require.NoError(t, err)
			found := false
			for _, family := range families {
				if family.GetName() != "smithers_machine_wake_total" {
					continue
				}
				require.Len(t, family.Metric, 4)
				counts := map[string]float64{}
				for _, sample := range family.Metric {
					labels := map[string]string{}
					for _, label := range sample.Label {
						labels[label.GetName()] = label.GetValue()
					}
					counts[labels["kind"]+":"+labels["outcome"]] = sample.GetCounter().GetValue()
				}
				kind := "warm"
				if mode == "create" {
					kind = "cold"
				}
				expected := map[string]float64{"cold:success": 0, "cold:failure": 0, "warm:success": 0, "warm:failure": 0}
				expected[kind+":failure"] = 1
				require.Equal(t, expected, counts)
				found = true
			}
			require.True(t, found)

			require.Equal(t, 1, r.InUse())
			require.Error(t, r.reserveAuxVM(t.Context(), "next"))
			require.NoError(t, os.WriteFile(binary, []byte("#!/bin/sh\ncase \"$1\" in list) echo '[]';; esac\nexit 0\n"), 0700))
			require.NoError(t, r.StopWorkspace(t.Context(), "A"))
			require.Zero(t, r.InUse())
		})
	}
}

func TestAdmissionSlotDrivesRealAuxiliaryReservation(t *testing.T) {
	r, p := admissionFixture()
	_, err := r.Request("person", "H", "Alice", "terminal")
	require.NoError(t, err)
	_, err = r.GrantNext(t.Context(), p)
	require.NoError(t, err)
	ctx := WithAdmissionHolder(t.Context(), "H")
	require.NoError(t, r.reserveAuxVM(ctx, "prepare"))
	require.Equal(t, 1, r.InUse())
	require.Error(t, r.reserveAuxVM(ctx, "other"))
	r.releaseAuxVM("prepare")
	require.Equal(t, 1, r.InUse())
	require.NoError(t, r.reserveAuxVM(ctx, "verify"))
	require.Equal(t, 1, r.InUse())
	r.releaseAuxVM("verify")
	r.ConfirmAdmissionStop("H", false)
	require.Error(t, r.reserveAuxVM(ctx, "ungranted"))
	require.Zero(t, r.InUse())
}

func TestAdmissionWaitWakesOnConfirmedStop(t *testing.T) {
	r, p := admissionFixture()
	_, err := r.Request("todo", "A", "T1", "wake")
	require.NoError(t, err)
	_, err = r.GrantNext(t.Context(), p)
	require.NoError(t, err)
	require.NoError(t, r.BindAdmissionMachine("A", "vm-a"))
	result := make(chan error, 1)
	go func() {
		ctx, err := r.WaitAdmission(t.Context(), p, "person", "B", "Alice", "terminal")
		if err == nil && ctx.Value(admissionContextKey{}) != "B" {
			err = errors.New("grant context lost its holder")
		}
		result <- err
	}()
	require.Eventually(t, func() bool { rows := r.AdmissionSnapshot(); return len(rows) == 2 && rows[1].Position == 1 }, time.Second, time.Millisecond)
	require.True(t, r.CancelAdmission("A", "T1", time.Now()))
	select {
	case <-result:
		t.Fatal("slot released before confirmed stop")
	case <-time.After(20 * time.Millisecond):
	}
	require.Equal(t, 1, r.InUse())
	r.ConfirmAdmissionStop("A", false)
	select {
	case err := <-result:
		require.NoError(t, err)
	case <-time.After(500 * time.Millisecond):
		t.Fatal("confirmed stop did not wake waiter")
	}
	require.Equal(t, 1, r.InUse())
	require.Equal(t, "granted", r.AdmissionSnapshot()[1].State)
}

func TestAdmissionOverdueStopWaitsForObservation(t *testing.T) {
	for _, status := range []string{"running", "starting", "stopped", "missing", "unknown", "booting", "preparing"} {
		t.Run(status, func(t *testing.T) {
			r, p := admissionFixture()
			root := t.TempDir()
			binary := filepath.Join(root, "msb")
			log := filepath.Join(root, "calls")
			listing := fmt.Sprintf(`[{"name":"vm-a","status":%q}]`, status)
			if status == "booting" || status == "preparing" {
				listing = `[{"name":"vm-a","status":"stopped"}]`
			}
			if status == "missing" {
				listing = "[]"
			}
			script := fmt.Sprintf("#!/bin/sh\necho \"$*\" >> '%s'\ncase \"$1\" in\nlist) echo '%s';;\nesac\n", log, listing)
			require.NoError(t, os.WriteFile(binary, []byte(script), 0700))
			r.cli = &cli{binary: binary, home: root}
			_, err := r.Request("person", "A", "Alice", "terminal")
			require.NoError(t, err)
			_, err = r.GrantNext(t.Context(), p)
			require.NoError(t, err)
			require.NoError(t, r.BindAdmissionMachine("A", "vm-a"))
			if status == "preparing" {
				r.auxVMs = map[string]struct{}{"vm-a": {}}
			}
			if status == "booting" {
				ws := newWorkspace(metadata{ID: "A", Machine: "vm-a", State: "starting"}, root)
				ws.booting = true
				r.workspaces["A"] = ws
			}
			now := time.Now()
			require.True(t, r.CancelAdmission("A", "Alice", now))
			_, err = r.Request("person", "B", "Ben", "terminal")
			require.NoError(t, err)
			require.Empty(t, r.AdmissionForceStops(now.Add(59999*time.Millisecond)))
			require.NoFileExists(t, log)
			require.NoError(t, r.ReconcileAdmissionReleases(t.Context(), now.Add(time.Minute)))
			calls, err := os.ReadFile(log)
			require.NoError(t, err)
			require.Contains(t, string(calls), "stop -t 0 -q vm-a")
			grant, err := r.GrantNext(t.Context(), p)
			require.NoError(t, err)
			if status == "stopped" || status == "missing" {
				require.Equal(t, "B", grant.Holder)
			} else {
				require.Empty(t, grant.Holder, "CLI success is not a confirmed stop")
			}
			require.Equal(t, 1, r.InUse())
			if status == "booting" {
				r.finishBoot(r.workspaces["A"])
				require.NoError(t, r.ReconcileAdmissionReleases(t.Context(), now.Add(time.Minute)))
				grant, err = r.GrantNext(t.Context(), p)
				require.NoError(t, err)
				require.Equal(t, "B", grant.Holder)
				require.Equal(t, 1, r.InUse())
			}
			if status == "preparing" {
				r.releaseAuxVM("vm-a") // owner observed removal after prepare returned
				grant, err = r.GrantNext(t.Context(), p)
				require.NoError(t, err)
				require.Equal(t, "B", grant.Holder)
				require.Equal(t, 1, r.InUse())
			}
		})
	}
}

func TestAdmissionWaitCancellationAndMissingProviders(t *testing.T) {
	r, p := admissionFixture()
	_, err := r.Request("todo", "held", "run", "wake")
	require.NoError(t, err)
	_, err = r.GrantNext(t.Context(), p)
	require.NoError(t, err)
	ctx, cancel := context.WithCancel(t.Context())
	result := make(chan error, 1)
	go func() { _, err := r.WaitAdmission(ctx, p, "person", "waiting", "Alice", "terminal"); result <- err }()
	require.Eventually(t, func() bool { return len(r.AdmissionSnapshot()) == 2 }, time.Second, time.Millisecond)
	cancel()
	require.ErrorIs(t, <-result, context.Canceled)
	require.Equal(t, "cancelled", r.AdmissionSnapshot()[1].State)
	require.Equal(t, 1, r.InUse())
	r.ConfirmAdmissionStop("held", false)
	_, err = r.WaitAdmission(t.Context(), AdmissionProviders{}, "todo", "missing", "run", "wake")
	require.Error(t, err)
	require.Zero(t, r.InUse())
}

func TestAdmissionUnusedGrantCancelledWithoutReleasingBoundVM(t *testing.T) {
	r, p := admissionFixture()
	_, err := r.WaitAdmission(t.Context(), p, "todo", "A", "T1", "wake")
	require.NoError(t, err)
	r.CancelFailedAdmission("A", "T1")
	require.Zero(t, r.InUse())
	require.Equal(t, "cancelled", r.AdmissionSnapshot()[0].State)
	_, err = r.WaitAdmission(t.Context(), p, "todo", "A", "T1", "wake")
	require.NoError(t, err)
	require.NoError(t, r.BindAdmissionMachine("A", "vm-a"))
	r.CancelFailedAdmission("A", "T1")
	require.Equal(t, 1, r.InUse())
	require.Equal(t, "cancelled", r.AdmissionSnapshot()[0].State)
}

func TestAdmissionExistingVMReusesOneSlot(t *testing.T) {
	r, p := admissionFixture()
	r.workspaces["A"] = newWorkspace(metadata{ID: "A", Machine: "vm-a", State: "running"}, "")
	require.Equal(t, 1, r.InUse())
	ctx, err := r.WaitAdmission(t.Context(), p, "person", "workspace:A", "Alice", "terminal")
	require.NoError(t, err)
	require.Equal(t, "workspace:A", ctx.Value(admissionContextKey{}))
	require.Equal(t, 1, r.InUse())
	_, err = r.WaitAdmission(t.Context(), AdmissionProviders{}, "person", "workspace:A", "Ben", "terminal")
	require.Error(t, err, "missing authority must also refuse demand on a held VM")
	require.Len(t, r.AdmissionSnapshot(), 1)
	require.Equal(t, 1, r.InUse())
}

func TestAdmissionWaitsForPublishedBinding(t *testing.T) {
	r, p := admissionFixture()
	var mu sync.Mutex
	published := false
	p.Ready = func(context.Context, AdmissionRequest) error {
		mu.Lock()
		defer mu.Unlock()
		if !published {
			return ErrAdmissionNotReady
		}
		return nil
	}
	result := make(chan error, 1)
	go func() { _, err := r.WaitAdmission(t.Context(), p, "todo", "branch", "T1", "wake"); result <- err }()
	require.Eventually(t, func() bool {
		rows := r.AdmissionSnapshot()
		return len(rows) == 1 && rows[0].State == "waiting" && rows[0].Position == 1
	}, time.Second, time.Millisecond)
	require.Zero(t, r.InUse(), "an unpublished binding cannot book a VM")
	mu.Lock()
	published = true
	mu.Unlock()
	select {
	case err := <-result:
		require.NoError(t, err)
	case <-time.After(2 * time.Second):
		t.Fatal("published binding did not grant")
	}
	require.Equal(t, 1, r.InUse())
}

func TestAdmissionCancelledPrepareReleasesAfterConfirmedRemoval(t *testing.T) {
	r, p := admissionFixture()
	ctx, err := r.WaitAdmission(t.Context(), p, "todo", "A", "T1", "wake")
	require.NoError(t, err)
	require.NoError(t, r.reserveAuxVM(ctx, "prepare"))
	r.CancelFailedAdmission("A", "T1")
	require.Equal(t, 1, r.InUse(), "failed prepare retains its VM until removal confirms")
	require.Equal(t, "cancelled", r.AdmissionSnapshot()[0].State)
	r.releaseAuxVM("prepare")
	require.Zero(t, r.InUse(), "confirmed removal must release an abandoned grant")
	_, err = r.WaitAdmission(t.Context(), p, "person", "B", "Alice", "terminal")
	require.NoError(t, err)
	require.Equal(t, 1, r.InUse())
}

func TestAdmissionOperationFailureNeverStopsAwakeWork(t *testing.T) {
	r, p := admissionFixture()
	r.workspaces["A"] = newWorkspace(metadata{ID: "A", Machine: "vm-a", State: "running"}, "")
	_, err := r.WaitAdmission(t.Context(), p, "person", "workspace:A", "Alice", "terminal")
	require.NoError(t, err)
	r.CancelFailedAdmission("workspace:A", "Alice")
	require.Equal(t, 1, r.InUse())
	require.Equal(t, "cancelled", r.AdmissionSnapshot()[0].State)
	require.Empty(t, r.AdmissionForceStops(time.Now().Add(2*time.Hour)), "an operation failure must not schedule preemption")
	require.Equal(t, "running", r.workspaces["A"].State)
}

func TestAdmissionExternalCancellationEndsWait(t *testing.T) {
	r, p := admissionFixture()
	_, err := r.WaitAdmission(t.Context(), p, "todo", "held", "run", "wake")
	require.NoError(t, err)
	result := make(chan error, 1)
	go func() {
		_, err := r.WaitAdmission(t.Context(), p, "person", "waiting", "Alice", "terminal")
		result <- err
	}()
	require.Eventually(t, func() bool { return len(r.AdmissionSnapshot()) == 2 }, time.Second, time.Millisecond)
	r.CancelAdmission("waiting", "Alice", time.Now())
	select {
	case err := <-result:
		require.ErrorIs(t, err, context.Canceled)
	case <-time.After(500 * time.Millisecond):
		t.Fatal("cancelled row left its waiter blocked")
	}
	require.Equal(t, 1, r.InUse())
}

func TestAdmissionReleaseObservedWithoutWaitingCaller(t *testing.T) {
	for _, overdue := range []bool{false, true} {
		t.Run(fmt.Sprint(overdue), func(t *testing.T) {
			r, p := admissionFixture()
			root := t.TempDir()
			binary := filepath.Join(root, "msb")
			log := filepath.Join(root, "calls")
			listing := filepath.Join(root, "status")
			require.NoError(t, os.WriteFile(listing, []byte(`[{"name":"vm-a","status":"running"}]`), 0600))
			script := fmt.Sprintf("#!/bin/sh\necho \"$*\" >> '%s'\ncase \"$1\" in\nlist) cat '%s';;\nesac\n", log, listing)
			require.NoError(t, os.WriteFile(binary, []byte(script), 0700))
			r.cli = &cli{binary: binary, home: root}
			_, err := r.Request("person", "A", "Alice", "terminal")
			require.NoError(t, err)
			_, err = r.GrantNext(t.Context(), p)
			require.NoError(t, err)
			require.NoError(t, r.BindAdmissionMachine("A", "vm-a"))
			now := time.Now()
			if overdue {
				now = now.Add(-time.Minute)
			}
			require.True(t, r.CancelAdmission("A", "Alice", now))
			r.startAdmissionReconciler(t.Context())
			t.Cleanup(func() { r.admissionCancel() })
			require.Eventually(t, func() bool { _, err := os.Stat(log); return err == nil }, 3*time.Second, 10*time.Millisecond)
			require.Equal(t, 1, r.InUse(), "a successful stop command does not release the slot")
			calls, err := os.ReadFile(log)
			require.NoError(t, err)
			if overdue {
				require.Contains(t, string(calls), "stop -t 0 -q vm-a")
			} else {
				require.NotContains(t, string(calls), "stop -t 0")
				require.Contains(t, string(calls), "stop -t 10 -q vm-a", "cancelled boot requests a normal stop on the first tick")
			}
			// Atomic replacement avoids an incomplete observation while the daemon reads.
			next := filepath.Join(root, "next")
			require.NoError(t, os.WriteFile(next, []byte(`[{"name":"vm-a","status":"stopped"}]`), 0600))
			require.NoError(t, os.Rename(next, listing))
			require.Eventually(t, func() bool { return r.InUse() == 0 }, 3*time.Second, 10*time.Millisecond)
			require.Equal(t, "cancelled", r.AdmissionSnapshot()[0].State)
		})
	}
}

func TestAdmissionCancelledBootHonorsStartupGrace(t *testing.T) {
	r, p := admissionFixture()
	now := time.Now()
	r.admissionStarted = now
	root := t.TempDir()
	binary, log := filepath.Join(root, "msb"), filepath.Join(root, "calls")
	script := fmt.Sprintf("#!/bin/sh\necho \"$*\" >> '%s'\ncase \"$1\" in\nlist) echo '[{\"name\":\"vm-a\",\"status\":\"running\"}]';;\nesac\n", log)
	require.NoError(t, os.WriteFile(binary, []byte(script), 0700))
	r.cli = &cli{binary: binary, home: root}
	_, err := r.Request("person", "A", "Alice", "terminal")
	require.NoError(t, err)
	_, err = r.GrantNext(t.Context(), p)
	require.NoError(t, err)
	require.NoError(t, r.BindAdmissionMachine("A", "vm-a"))
	require.True(t, r.CancelAdmission("A", "Alice", now))
	require.NoError(t, r.ReconcileAdmissionReleases(t.Context(), now.Add(29999*time.Millisecond)))
	require.NoFileExists(t, log)
	require.Equal(t, 1, r.InUse())
	require.NoError(t, r.ReconcileAdmissionReleases(t.Context(), now.Add(30*time.Second)))
	calls, err := os.ReadFile(log)
	require.NoError(t, err)
	require.Contains(t, string(calls), "stop -t 10 -q vm-a")
	require.Equal(t, 1, r.InUse(), "the stop acknowledgment cannot free capacity")
}

func TestAdmissionOrdinaryStopRequiresRuntimeObservation(t *testing.T) {
	r, p := admissionFixture()
	root := t.TempDir()
	binary := filepath.Join(root, "msb")
	listing := filepath.Join(root, "status")
	require.NoError(t, os.WriteFile(listing, []byte(`[{"name":"vm-a","status":"running"}]`), 0600))
	script := fmt.Sprintf("#!/bin/sh\ncase \"$1\" in\nlist) cat '%s';;\nesac\n", listing)
	require.NoError(t, os.WriteFile(binary, []byte(script), 0700))
	r.cli = &cli{binary: binary, home: root}
	_, err := r.Request("person", "workspace:A", "Alice", "terminal")
	require.NoError(t, err)
	_, err = r.GrantNext(t.Context(), p)
	require.NoError(t, err)
	require.NoError(t, r.BindAdmissionMachine("workspace:A", "vm-a"))
	ws := newWorkspace(metadata{ID: "A", Machine: "vm-a", State: "running"}, root)
	r.workspaces["A"] = ws
	require.ErrorContains(t, r.StopWorkspace(t.Context(), "A"), "stop is not confirmed")
	require.Equal(t, 1, r.InUse())
	_, err = r.Request("person", "workspace:B", "Ben", "terminal")
	require.NoError(t, err)
	grant, err := r.GrantNext(t.Context(), p)
	require.NoError(t, err)
	require.Empty(t, grant.Holder)
	request, err := r.Request("person", "workspace:A", "Alice", "terminal")
	require.NoError(t, err)
	require.Equal(t, "waiting", request.State, "new demand cannot reuse a releasing grant")
	require.Equal(t, 2, request.Position, "new demand ranks after Ben's earlier request")
	require.NoError(t, os.WriteFile(listing, []byte(`[{"name":"vm-a","status":"stopped"}]`), 0600))
	require.NoError(t, r.ReconcileAdmissionReleases(t.Context(), time.Now()))
	require.Equal(t, "stopped", ws.State)
	grant, err = r.GrantNext(t.Context(), p)
	require.NoError(t, err)
	require.Equal(t, "workspace:B", grant.Holder)
	require.Equal(t, 1, r.InUse())
}

func TestAdmissionAuxiliaryRemovalRequiresRuntimeObservation(t *testing.T) {
	r, p := admissionFixture()
	root := t.TempDir()
	binary := filepath.Join(root, "msb")
	listing := filepath.Join(root, "status")
	require.NoError(t, os.WriteFile(listing, []byte(`[{"name":"prepare","status":"stopped"}]`), 0600))
	script := fmt.Sprintf("#!/bin/sh\ncase \"$1\" in\nlist) cat '%s';;\nesac\n", listing)
	require.NoError(t, os.WriteFile(binary, []byte(script), 0700))
	r.cli = &cli{binary: binary, home: root}
	_, err := r.Request("person", "workspace:A", "Alice", "terminal")
	require.NoError(t, err)
	_, err = r.GrantNext(t.Context(), p)
	require.NoError(t, err)
	ctx := WithAdmissionHolder(t.Context(), "workspace:A")
	require.NoError(t, r.reserveAuxVM(ctx, "prepare"))
	require.ErrorContains(t, r.finishAuxVM("prepare"), "removal is not confirmed")
	require.Equal(t, 1, r.InUse())
	require.Error(t, r.BindAdmissionMachine("workspace:A", "branch"), "no transfer before prepare removal")
	require.NoError(t, os.WriteFile(listing, []byte(`[]`), 0600))
	require.NoError(t, r.finishAuxVM("prepare"))
	require.Equal(t, 1, r.InUse(), "confirmed prepare removal retains branch grant")
	require.NoError(t, r.BindAdmissionMachine("workspace:A", "branch"))
}

func TestAdmissionMachineMetricsFollowRuntimeQueueAndBoots(t *testing.T) {
	r, p := admissionFixture()
	registry := prometheus.NewRegistry()
	require.NoError(t, registry.Register(r.MachineMetrics()))
	require.Same(t, r.MachineMetrics(), r.MachineMetrics())
	depths := func() map[string]float64 {
		families, err := registry.Gather()
		require.NoError(t, err)
		got := map[string]float64{}
		for _, f := range families {
			if f.GetName() == "smithers_machine_queue_depth" {
				for _, sample := range f.Metric {
					got[sample.Label[0].GetValue()] = sample.GetGauge().GetValue()
				}
			}
		}
		return got
	}
	require.Equal(t, map[string]float64{"person": 0, "todo": 0, "background": 0}, depths())
	for _, row := range []struct{ class, holder, actor string }{
		{"todo", "workspace:A", "T1"}, {"person", "workspace:A", "Alice"},
		{"person", "workspace:A", "Ben"}, {"todo", "workspace:B", "T2"},
		{"background", "review:50", "review"},
	} {
		_, err := r.Request(row.class, row.holder, row.actor, "wake")
		require.NoError(t, err)
	}
	require.Equal(t, map[string]float64{"person": 1, "todo": 1, "background": 1}, depths())
	grant, err := r.GrantNext(t.Context(), p)
	require.NoError(t, err)
	require.Equal(t, "workspace:A", grant.Holder)
	require.Equal(t, map[string]float64{"person": 0, "todo": 1, "background": 1}, depths())
	r.CancelAdmission("workspace:B", "T2", time.Now())
	require.Equal(t, map[string]float64{"person": 0, "todo": 0, "background": 1}, depths())
	// A failed retained boot passes through the production runtime lifecycle.
	// Transport observations are conformance fixtures, not real-VM receipts.
	root := t.TempDir()
	binary := filepath.Join(root, "msb")
	require.NoError(t, os.WriteFile(binary, []byte("#!/bin/sh\ncase \"$1\" in\nlist) echo '[{\"name\":\"vm-a\",\"status\":\"stopped\"}]';;\nstart) exit 1;;\nstop) exit 0;;\nesac\n"), 0700))
	r.cli = &cli{binary: binary, home: root}
	ws := newWorkspace(metadata{ID: "A", Machine: "vm-a", State: "stopped"}, root)
	r.workspaces["A"] = ws
	_, err = r.StartWorkspace(WithAdmissionHolder(t.Context(), "workspace:A"), "A")
	require.Error(t, err)
	families, err := registry.Gather()
	require.NoError(t, err)
	seenCounter, seenDuration := false, false
	for _, f := range families {
		if f.GetName() != "smithers_machine_wake_total" && f.GetName() != "smithers_machine_wake_duration_seconds" {
			continue
		}
		if f.GetName() == "smithers_machine_wake_total" {
			require.Len(t, f.Metric, 4)
			counts := map[string]float64{}
			for _, sample := range f.Metric {
				labels := map[string]string{}
				for _, label := range sample.Label {
					labels[label.GetName()] = label.GetValue()
				}
				counts[labels["kind"]+":"+labels["outcome"]] = sample.GetCounter().GetValue()
			}
			require.Equal(t, map[string]float64{"cold:success": 0, "cold:failure": 0, "warm:success": 0, "warm:failure": 1}, counts)
			seenCounter = true
			continue
		}
		require.Len(t, f.Metric, 1)
		labels := map[string]string{}
		for _, label := range f.Metric[0].Label {
			labels[label.GetName()] = label.GetValue()
		}
		require.Equal(t, map[string]string{"kind": "warm", "outcome": "failure"}, labels)
		require.Equal(t, uint64(1), f.Metric[0].GetHistogram().GetSampleCount())
		require.Greater(t, f.Metric[0].GetHistogram().GetSampleSum(), float64(0))
		seenDuration = true
	}
	require.True(t, seenCounter)
	require.True(t, seenDuration)
	// Already awake and invalid requests do not count as boot attempts.
	ws.State = "running"
	_, err = r.StartWorkspace(t.Context(), "A")
	require.NoError(t, err)
	_, err = r.CreateWorkspace(t.Context(), workspaceapi.WorkspaceSpec{ID: "A"})
	require.NoError(t, err)
	_, err = r.StartWorkspace(t.Context(), "missing")
	require.Error(t, err)
	families, err = registry.Gather()
	require.NoError(t, err)
	for _, f := range families {
		if f.GetName() == "smithers_machine_wake_total" {
			require.Len(t, f.Metric, 4)
			var attempts float64
			for _, sample := range f.Metric {
				attempts += sample.GetCounter().GetValue()
			}
			require.Equal(t, float64(1), attempts)
		}
	}
}

func TestAdmissionIdleCaptureFailureNeverForceStops(t *testing.T) {
	now := time.Date(2026, 10, 6, 0, 0, 0, 0, time.UTC)
	r, p := admissionFixture()
	_, err := r.Request("todo", "A", "T1", "run")
	require.NoError(t, err)
	_, err = r.GrantNext(t.Context(), p)
	require.NoError(t, err)
	require.NoError(t, r.BindAdmissionMachine("A", "vm-A"))
	_, err = r.Request("person", "B", "Alice", "terminal")
	require.NoError(t, err)
	safe := AdmissionSafety{Holder: "A", IdleSince: now.Add(-time.Hour), PresenceKnown: true, SessionsKnown: true, RunKnown: true, BurstsEnabled: true, BurstsKnown: true, DocumentsEnabled: true, DocumentsKnown: true}
	failed := errors.New("outbox drain failed")
	stops := 0
	idle := AdmissionIdleProviders{Now: func() time.Time { return now }, FreeDisk: p.FreeDisk, Safety: func(context.Context) ([]AdmissionSafety, error) { return []AdmissionSafety{safe}, nil }, Prepare: func(context.Context, string) error {
		require.Empty(t, r.AdmissionForceStops(now.Add(time.Hour)))
		joined, err := r.Request("person", "A", "Ben", "terminal")
		require.NoError(t, err)
		require.Equal(t, "waiting", joined.State)
		require.False(t, r.CancelAdmission("A", "T1", now))
		return failed
	}, Stop: func(context.Context, string) error { stops++; return nil }}
	require.ErrorIs(t, r.ReconcileAdmissionIdle(t.Context(), now, now.Add(-time.Hour), idle), failed)
	require.Zero(t, stops)
	require.Empty(t, r.AdmissionForceStops(now.Add(time.Hour)))
	require.Equal(t, 1, r.InUse())
	rows := r.AdmissionSnapshot()
	require.Equal(t, "cancelled", rows[0].State)
	require.Equal(t, "waiting", rows[1].State)
	require.Equal(t, "granted", rows[2].State)
}

func TestAdmissionIdlePreparedStopRetainsSlot(t *testing.T) {
	now := time.Date(2026, 10, 6, 0, 0, 0, 0, time.UTC)
	r, p := admissionFixture()
	_, err := r.Request("todo", "A", "T1", "run")
	require.NoError(t, err)
	_, err = r.GrantNext(t.Context(), p)
	require.NoError(t, err)
	require.NoError(t, r.BindAdmissionMachine("A", "vm-A"))
	_, err = r.Request("person", "B", "Alice", "terminal")
	require.NoError(t, err)
	safe := AdmissionSafety{Holder: "A", IdleSince: now.Add(-time.Hour), PresenceKnown: true, SessionsKnown: true, RunKnown: true}
	failed := errors.New("stop not confirmed")
	calls := []string{}
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	idle := AdmissionIdleProviders{Now: func() time.Time { return now }, FreeDisk: p.FreeDisk, Safety: func(context.Context) ([]AdmissionSafety, error) { return []AdmissionSafety{safe}, nil }, Prepare: func(context.Context, string) error { calls = append(calls, "capture"); cancel(); return nil }, Stop: func(ctx context.Context, holder string) error {
		require.NoError(t, ctx.Err())
		require.Equal(t, "A", holder)
		calls = append(calls, "stop")
		next, err := r.GrantNext(ctx, p)
		require.NoError(t, err)
		require.Empty(t, next.Holder)
		return failed
	}}
	require.ErrorIs(t, r.ReconcileAdmissionIdle(ctx, now, now.Add(-time.Hour), idle), failed)
	require.Equal(t, []string{"capture", "stop"}, calls)
	require.Equal(t, 1, r.InUse())
	require.Empty(t, r.AdmissionForceStops(now.Add(59900*time.Millisecond)))
	require.Equal(t, []string{"A"}, r.AdmissionForceStops(now.Add(time.Minute)))
	// A transport failure does not release the slot. Only the runtime's stop
	// observation lets the queued person's machine start.
	r.ConfirmAdmissionStop("A", false)
	next, err := r.GrantNext(t.Context(), p)
	require.NoError(t, err)
	require.Equal(t, "B", next.Holder)
}

func TestAdmissionIdleProviderAndSafetyRefusals(t *testing.T) {
	now := time.Date(2026, 10, 6, 0, 0, 0, 0, time.UTC)
	for _, kind := range []string{"safety_missing", "prepare_missing", "stop_missing", "read_failed", "restart", "presence_unknown", "sessions_unknown", "run_unknown", "burst_unknown", "flush_unknown", "safe"} {
		t.Run(kind, func(t *testing.T) {
			r, p := admissionFixture()
			_, err := r.Request("todo", "A", "T1", "run")
			require.NoError(t, err)
			_, err = r.GrantNext(t.Context(), p)
			require.NoError(t, err)
			_, err = r.Request("person", "B", "Alice", "terminal")
			require.NoError(t, err)
			safe := AdmissionSafety{Holder: "A", IdleSince: now.Add(-time.Hour), PresenceKnown: true, SessionsKnown: true, RunKnown: true}
			prepared, stopped := 0, 0
			idle := AdmissionIdleProviders{Now: func() time.Time { return now }, FreeDisk: p.FreeDisk, Safety: func(context.Context) ([]AdmissionSafety, error) { return []AdmissionSafety{safe}, nil }, Prepare: func(context.Context, string) error { prepared++; return nil }, Stop: func(context.Context, string) error { stopped++; return nil }}
			start := now.Add(-time.Hour)
			switch kind {
			case "safety_missing":
				idle.Safety = nil
			case "prepare_missing":
				idle.Prepare = nil
			case "stop_missing":
				idle.Stop = nil
			case "read_failed":
				idle.Safety = func(context.Context) ([]AdmissionSafety, error) { return nil, errors.New("stale observation") }
			case "restart":
				start = now.Add(-29900 * time.Millisecond)
			case "presence_unknown":
				safe.PresenceKnown = false
			case "sessions_unknown":
				safe.SessionsKnown = false
			case "run_unknown":
				safe.RunKnown = false
			case "burst_unknown":
				safe.BurstsEnabled = true
			case "flush_unknown":
				safe.DocumentsEnabled = true
			}
			err = r.ReconcileAdmissionIdle(t.Context(), now, start, idle)
			if strings.HasSuffix(kind, "missing") || kind == "read_failed" {
				require.Error(t, err)
			} else {
				require.NoError(t, err)
			}
			if kind == "safe" {
				require.Equal(t, 1, prepared)
				require.Equal(t, 1, stopped)
			} else {
				require.Zero(t, prepared)
				require.Zero(t, stopped)
				require.Empty(t, r.AdmissionForceStops(now.Add(time.Hour)))
			}
			require.Equal(t, 1, r.InUse())
		})
	}
}

func TestAdmissionIdleDoesNotReleaseWithSpareCapacity(t *testing.T) {
	now := time.Now()
	r, p := admissionFixture()
	r.SetCapacityReader(func(context.Context) (int, error) { return 2, nil })
	_, err := r.Request("todo", "A", "T1", "run")
	require.NoError(t, err)
	_, err = r.GrantNext(t.Context(), p)
	require.NoError(t, err)
	_, err = r.Request("person", "B", "Alice", "terminal")
	require.NoError(t, err)
	prepared := 0
	idle := AdmissionIdleProviders{Now: func() time.Time { return now }, FreeDisk: p.FreeDisk, Safety: func(context.Context) ([]AdmissionSafety, error) {
		return []AdmissionSafety{{Holder: "A", IdleSince: now.Add(-time.Minute), PresenceKnown: true, SessionsKnown: true, RunKnown: true}}, nil
	}, Prepare: func(context.Context, string) error { prepared++; return nil }, Stop: func(context.Context, string) error { return nil }}
	require.NoError(t, r.ReconcileAdmissionIdle(t.Context(), now, now.Add(-time.Hour), idle))
	require.Zero(t, prepared)
	// The owner lowering capacity changes release pressure without preempting a
	// working step, and disk is reread rather than cached from host startup.
	idle.FreeDisk = func(context.Context) (int64, error) { return 100 << 30, nil }
	require.NoError(t, r.ReconcileAdmissionIdle(t.Context(), now, now.Add(-time.Hour), idle))
	require.Equal(t, 1, prepared)
	require.Equal(t, 1, r.InUse())
}

func TestAdmissionConfiguredIdleReleaseWakesWaitingPerson(t *testing.T) {
	now := time.Now()
	r, p := admissionFixture()
	_, err := r.Request("todo", "A", "T1", "run")
	require.NoError(t, err)
	_, err = r.GrantNext(t.Context(), p)
	require.NoError(t, err)
	require.NoError(t, r.BindAdmissionMachine("A", "vm-A"))
	prepared := 0
	require.Error(t, r.SetAdmissionIdleProviders(AdmissionIdleProviders{}))
	require.NoError(t, r.SetAdmissionIdleProviders(AdmissionIdleProviders{Now: func() time.Time { return now }, FreeDisk: p.FreeDisk, Safety: func(context.Context) ([]AdmissionSafety, error) {
		return []AdmissionSafety{{Holder: "A", IdleSince: time.Now().Add(-time.Hour), PresenceKnown: true, SessionsKnown: true, RunKnown: true}}, nil
	}, Prepare: func(context.Context, string) error { prepared++; return nil }, Stop: func(context.Context, string) error { r.ConfirmAdmissionStop("A", false); return nil }}))
	r.mu.Lock()
	r.admissionStarted = time.Now().Add(-time.Hour)
	r.mu.Unlock()
	ctx, cancel := context.WithTimeout(t.Context(), 2*time.Second)
	defer cancel()
	granted, err := r.WaitAdmission(ctx, p, "person", "B", "Alice", "terminal")
	require.NoError(t, err)
	require.NotNil(t, granted)
	require.Equal(t, 1, prepared)
	require.Equal(t, 1, r.InUse())
	require.Equal(t, "granted", r.AdmissionSnapshot()[1].State)
}

func TestAdmissionIdleFailurePreservesWaitingDemand(t *testing.T) {
	for _, failure := range []string{"safety", "capture", "stop"} {
		t.Run(failure, func(t *testing.T) {
			r, p := admissionFixture()
			_, err := r.WaitAdmission(t.Context(), p, "todo", "A", "T1", "run")
			require.NoError(t, err)
			require.NoError(t, r.BindAdmissionMachine("A", "vm-A"))
			observed := make(chan struct{}, 1)
			failed := func() error {
				select {
				case observed <- struct{}{}:
				default:
				}
				return errors.New("safety or capture unavailable")
			}
			require.NoError(t, r.SetAdmissionIdleProviders(AdmissionIdleProviders{
				FreeDisk: p.FreeDisk,
				Safety: func(context.Context) ([]AdmissionSafety, error) {
					if failure == "safety" {
						return nil, failed()
					}
					return []AdmissionSafety{{Holder: "A", IdleSince: time.Now().Add(-time.Hour), PresenceKnown: true, SessionsKnown: true, RunKnown: true}}, nil
				},
				Prepare: func(context.Context, string) error {
					if failure == "capture" {
						return failed()
					}
					return nil
				},
				Stop: func(context.Context, string) error { return failed() },
			}))
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			result := make(chan error, 1)
			go func() { _, err := r.WaitAdmission(ctx, p, "person", "B", "Alice", "terminal"); result <- err }()
			select {
			case <-observed:
			case <-time.After(2 * time.Second):
				t.Fatal("idle failure was not exercised")
			}
			select {
			case err := <-result:
				t.Fatalf("idle failure ended the waiting request: %v", err)
			default:
			}
			rows := r.AdmissionSnapshot()
			require.Equal(t, "waiting", rows[1].State)
			require.Equal(t, 1, rows[1].Position)
			require.Equal(t, 1, r.InUse())
			r.ConfirmAdmissionStop("A", false)
			select {
			case err := <-result:
				require.NoError(t, err)
			case <-time.After(2 * time.Second):
				t.Fatal("confirmed stop did not grant the original request")
			}
			require.Equal(t, "granted", r.AdmissionSnapshot()[1].State)
		})
	}
}

func TestAdmissionIdleCaptureFailureNotifiesOnlyChangedDemand(t *testing.T) {
	for _, arrives := range []bool{false, true} {
		t.Run(fmt.Sprint(arrives), func(t *testing.T) {
			r, p := admissionFixture()
			_, err := r.WaitAdmission(t.Context(), p, "todo", "A", "T1", "run")
			require.NoError(t, err)
			require.NoError(t, r.BindAdmissionMachine("A", "vm-A"))
			_, err = r.Request("person", "B", "Alice", "terminal")
			require.NoError(t, err)
			now := time.Now()
			failed := errors.New("capture unavailable")
			var changed <-chan struct{}
			idle := AdmissionIdleProviders{FreeDisk: p.FreeDisk,
				Safety: func(context.Context) ([]AdmissionSafety, error) {
					return []AdmissionSafety{{Holder: "A", IdleSince: now.Add(-time.Hour), PresenceKnown: true, SessionsKnown: true, RunKnown: true}}, nil
				},
				Prepare: func(context.Context, string) error {
					if arrives {
						row, err := r.Request("person", "A", "Ben", "terminal")
						require.NoError(t, err)
						require.Equal(t, "waiting", row.State)
					}
					r.mu.Lock()
					changed = r.admissionChanged
					r.mu.Unlock()
					return failed
				},
				Stop: func(context.Context, string) error { t.Fatal("failed capture cannot stop"); return nil },
			}
			require.ErrorIs(t, r.ReconcileAdmissionIdle(t.Context(), now, now.Add(-time.Hour), idle), failed)
			select {
			case <-changed:
				require.True(t, arrives, "unchanged capture failure must wait for the tick, not wake a retry loop")
			default:
				require.False(t, arrives, "restored demand must wake its caller")
			}
			require.Equal(t, 1, r.InUse())
			for _, row := range r.AdmissionSnapshot() {
				if row.Holder == "A" {
					require.Equal(t, "granted", row.State)
				} else {
					require.Equal(t, "waiting", row.State)
				}
			}
		})
	}
}

func TestAdmissionIdleConfiguredClockPreservesStartupGrace(t *testing.T) {
	r, p := admissionFixture()
	start := time.Now()
	r.admissionStarted = start
	now := start.Add(29900 * time.Millisecond)
	reads := 0
	require.NoError(t, r.SetAdmissionIdleProviders(AdmissionIdleProviders{
		Now: func() time.Time { return now }, FreeDisk: p.FreeDisk,
		Safety:  func(context.Context) ([]AdmissionSafety, error) { reads++; return nil, nil },
		Prepare: func(context.Context, string) error { t.Fatal("no machine to prepare"); return nil },
		Stop:    func(context.Context, string) error { t.Fatal("no machine to stop"); return nil },
	}))
	require.NoError(t, r.reconcileConfiguredAdmissionIdle(t.Context(), time.Now()))
	require.Zero(t, reads)
	now = start.Add(30 * time.Second)
	require.NoError(t, r.reconcileConfiguredAdmissionIdle(t.Context(), time.Now()))
	require.Equal(t, 1, reads)
}

func TestAdmissionIdleConcurrentPreparationDoesNotBlockCancellation(t *testing.T) {
	r, p := admissionFixture()
	now := time.Now()
	_, err := r.Request("todo", "A", "T1", "run")
	require.NoError(t, err)
	_, err = r.GrantNext(t.Context(), p)
	require.NoError(t, err)
	_, err = r.Request("person", "B", "Alice", "terminal")
	require.NoError(t, err)
	entered, finish, done := make(chan struct{}), make(chan struct{}), make(chan error, 1)
	idle := AdmissionIdleProviders{Now: func() time.Time { return now }, FreeDisk: p.FreeDisk, Safety: func(context.Context) ([]AdmissionSafety, error) {
		return []AdmissionSafety{{Holder: "A", IdleSince: now.Add(-time.Hour), PresenceKnown: true, SessionsKnown: true, RunKnown: true}}, nil
	}, Prepare: func(context.Context, string) error { close(entered); <-finish; return errors.New("capture failed") }, Stop: func(context.Context, string) error { t.Error("must not stop after capture failure"); return nil }}
	go func() { done <- r.ReconcileAdmissionIdle(t.Context(), now, now.Add(-time.Hour), idle) }()
	<-entered
	// A second tick must not wait on a blocked capture or enter it twice.
	require.NoError(t, r.ReconcileAdmissionIdle(t.Context(), now, now.Add(-time.Hour), idle))
	joined, err := r.Request("todo", "A", "T1", "run")
	require.NoError(t, err)
	require.Equal(t, "waiting", joined.State)
	require.False(t, r.admissionGranted("A", "T1"))
	require.False(t, r.CancelAdmission("A", "T1", now))
	require.False(t, r.CancelAdmission("B", "Alice", now))
	require.Empty(t, r.AdmissionForceStops(now.Add(time.Hour)))
	close(finish)
	require.ErrorContains(t, <-done, "capture failed")
	require.Equal(t, 1, r.InUse())
}

func TestAdmissionHeldUntilObservedStop(t *testing.T) {
	r, p := admissionFixture()
	require.False(t, r.AdmissionHeld("workspace:T1"))
	_, err := r.Request("todo", "workspace:T1", "T1", "machine")
	require.NoError(t, err)
	require.False(t, r.AdmissionHeld("workspace:T1"))
	_, err = r.GrantNext(t.Context(), p)
	require.NoError(t, err)
	require.True(t, r.AdmissionHeld("workspace:T1"))
	require.True(t, r.CancelAdmission("workspace:T1", "T1", time.Now()))
	require.True(t, r.AdmissionHeld("workspace:T1"), "cancellation is not observed release")
	r.ConfirmAdmissionStop("workspace:T1", false)
	require.False(t, r.AdmissionHeld("workspace:T1"))
	r.workspaces["recovered"] = &workspace{metadata: metadata{Machine: "vm", State: "running"}}
	require.True(t, r.AdmissionHeld("workspace:recovered"))
	r.workspaces["recovered"].State = "stopping"
	require.True(t, r.AdmissionHeld("workspace:recovered"))
	r.workspaces["recovered"].State = "stopped"
	require.False(t, r.AdmissionHeld("workspace:recovered"))
}

func TestAdmissionStackReorderPreservesPersonAndGrants(t *testing.T) {
	r, p := admissionFixture()
	for _, holder := range []string{"T2", "T1", "T3"} {
		_, err := r.Request("todo", holder, holder, "machine")
		require.NoError(t, err)
	}
	_, err := r.Request("person", "Ben", "Ben", "machine")
	require.NoError(t, err)
	r.ReorderTodoAdmission([]string{"T1", "T2", "T3", "T1", "absent"})
	rows := r.AdmissionSnapshot()
	require.Equal(t, []string{"Ben", "T1", "T2", "T3"}, []string{rows[0].Holder, rows[1].Holder, rows[2].Holder, rows[3].Holder})
	require.Equal(t, []int{1, 2, 3, 4}, []int{rows[0].Position, rows[1].Position, rows[2].Position, rows[3].Position})
	before := r.admissionSequence
	r.ReorderTodoAdmission([]string{"T1", "T2", "T3"})
	require.Equal(t, before, r.admissionSequence, "reading an unchanged order cannot invalidate an in-flight grant")
	granted, err := r.GrantNext(t.Context(), p)
	require.NoError(t, err)
	require.Equal(t, "Ben", granted.Holder)
	r.ReorderTodoAdmission([]string{"T3", "T2", "T1"})
	require.True(t, r.AdmissionHeld("Ben"), "reordering never preempts a grant")
	require.Equal(t, 1, r.InUse())
	require.True(t, r.CancelAdmission("Ben", "Ben", time.Now()))
	r.ConfirmAdmissionStop("Ben", false)
	granted, err = r.GrantNext(t.Context(), p)
	require.NoError(t, err)
	require.Equal(t, "T3", granted.Holder)
}

func TestAdmissionCancellationHonorsStartupWindow(t *testing.T) {
	now := time.Now()
	for _, tc := range []struct {
		name    string
		started time.Time
		observe time.Time
		attempt bool
	}{
		{"unknown", time.Time{}, now, false},
		{"29900ms", now, now.Add(29900 * time.Millisecond), false},
		{"30s", now, now.Add(30 * time.Second), true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r, p := admissionFixture()
			r.admissionStarted = tc.started
			_, err := r.WaitAdmission(t.Context(), p, "person", "A", "Alice", "terminal")
			require.NoError(t, err)
			require.NoError(t, r.BindAdmissionMachine("A", "vm-a"))
			require.True(t, r.CancelAdmission("A", "Alice", now))
			// No runtime transport is mounted: reaching it proves an attempted
			// stop. During startup there must be no I/O, nor any released slot.
			err = r.ReconcileAdmissionReleases(t.Context(), tc.observe)
			if tc.attempt {
				require.ErrorIs(t, err, ErrUnavailable)
			} else {
				require.NoError(t, err)
			}
			require.Equal(t, 1, r.InUse())
			require.Equal(t, "cancelled", r.AdmissionSnapshot()[0].State)
		})
	}
}
