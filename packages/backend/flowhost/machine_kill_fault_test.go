//go:build unix

package flowhost

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/installbundle"
	"github.com/smithersai/smithers/packages/backend/microsandbox"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
)

// This is the real-machine transport/retained-disk control. It deliberately
// does not stand in for TODO Retry or completed engine-step replay receipts.
// The reference matrix must fail if the approved install is unavailable.
func TestMachineKillRetainsDiskAndRecoveryIsolation(t *testing.T) {
	if os.Getenv("SMITHERS_FAULT_HOST") != "reference" {
		t.Skip("requires reference host and approved installed bundle")
	}
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Minute)
	defer cancel()
	bundleRoot := os.Getenv("SMITHERS_FAULT_INSTALL_BUNDLE")
	require.NotEmpty(t, bundleRoot, "C-DUR-02 requires the approved installed bundle; no process substitute")
	bundle, err := installbundle.Open(bundleRoot)
	require.NoError(t, err)
	msb := bundle.Program("bin/msb")
	require.NoError(t, msb.Check())
	// Installed runtime metadata must have a protected ancestor chain; the
	// system temporary directory is often world-writable. Keep this test
	// state in its own checkout and remove it after owned-machine cleanup.
	state, err := os.MkdirTemp(".", ".machine-kill-")
	require.NoError(t, err)
	state, err = filepath.Abs(state)
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, os.RemoveAll(state)) })
	machine, err := microsandbox.New(ctx, microsandbox.Config{Root: state, Bundle: bundle, CPUs: 1, MemoryMiB: 1024, DiskMiB: 2048, MaxRunningVMs: 1})
	require.NoError(t, err, "installed microVM qualification must pass before dispatch")
	t.Cleanup(func() { require.NoError(t, machine.Close()) })
	require.Equal(t, workspaceapi.IsolationSandboxed, machine.Isolation())
	pool := hostTestPool(t)
	authority, catalog := hostFixture(t, pool)
	box, err := machine.CreateWorkspace(ctx, workspaceapi.WorkspaceSpec{ID: authority.WorkspaceID})
	require.NoError(t, err)
	t.Cleanup(func() {
		cleanup, stop := context.WithTimeout(context.Background(), time.Minute)
		defer stop()
		require.NoError(t, machine.DeleteWorkspace(cleanup, box.ID))
	})
	box, err = machine.StartWorkspace(ctx, box.ID)
	require.NoError(t, err)
	run := func(args ...string) workspaceapi.CommandResult {
		t.Helper()
		result, err := machine.ExecuteCommand(ctx, box.ID, workspaceapi.Command{Args: args})
		require.NoError(t, err)
		require.Zero(t, result.ExitCode, result.Stderr)
		return result
	}
	// These argv go only to the install's unprivileged guest executor.
	uid := run("id", "-u")
	guestUID, err := strconv.Atoi(strings.TrimSpace(uid.Stdout))
	require.NoError(t, err)
	require.Positive(t, guestUID, "the positive control must not execute branch argv as root")
	run("/bin/sh", "-c", "printf 'completed-before-kill\\n' > retained-fault-control; sync")
	type commandOutcome struct {
		result workspaceapi.CommandResult
		err    error
	}
	done := make(chan commandOutcome, 1)
	go func() {
		result, err := machine.ExecuteCommand(ctx, box.ID, workspaceapi.Command{Args: []string{"/bin/sh", "-c", "printf 'entered\\n' > fault-crossing; sync; sleep 240; printf 'unexpected\\n' > fault-completed"}})
		done <- commandOutcome{result, err}
	}()
	require.Eventually(t, func() bool {
		result, err := machine.ExecuteCommand(ctx, box.ID, workspaceapi.Command{Args: []string{"cat", "fault-crossing"}})
		return err == nil && result.ExitCode == 0 && result.Stdout == "entered\n"
	}, 30*time.Second, 100*time.Millisecond)
	raw, err := os.ReadFile(filepath.Join(state, "workspaces", box.ID, "metadata.json"))
	require.NoError(t, err)
	var metadata struct {
		Machine string `json:"machine"`
	}
	require.NoError(t, json.Unmarshal(raw, &metadata))
	require.NotEmpty(t, metadata.Machine)
	// Zero shutdown grace is the abrupt VM stop, not StopWorkspace's orderly
	// cancellation. The name comes only from the machine created by this test.
	account, err := user.LookupId(fmt.Sprint(os.Getuid()))
	require.NoError(t, err)
	require.NoError(t, msb.Check(), "revalidate pinned executable at the fault")
	stop := exec.CommandContext(ctx, msb.Path(), "stop", "-t", "0", "-q", metadata.Machine)
	stop.Env = []string{"HOME=" + account.HomeDir, "PATH=/usr/bin:/bin:/usr/sbin:/sbin", "MSB_BACKEND=local", "NO_COLOR=1"}
	output, err := stop.CombinedOutput()
	require.NoError(t, err, string(output))
	fmt.Println("CRASH-POINT machine-mid-command subject retained-workspace")
	select {
	case outcome := <-done:
		require.True(t, outcome.err != nil || outcome.result.ExitCode != 0, "an interrupted command must not report success")
	case <-time.After(30 * time.Second):
		t.Fatal("killed machine command never settled")
	}
	require.NoError(t, machine.StopWorkspace(ctx, box.ID))
	// The production resolver must refuse a stopped machine before any host
	// launch. Reuse the durable dispatcher negative control on the real adapter.
	launcher, err := NewWorkspaceLauncher(machine)
	require.NoError(t, err)
	store, err := NewStore(pool, testCodec{})
	require.NoError(t, err)
	resolver, err := New(Config{Store: store, Launcher: launcher, Catalogs: []Catalog{catalog}, Targets: TargetResolverFunc(func(context.Context, flowruntime.Target) (Authority, error) { return authority, nil })})
	require.NoError(t, err)
	dispatchRecoveryRefusal(t, resolver, authority.Target, "runtime_inspection_failed")
	box, err = machine.StartWorkspace(ctx, box.ID)
	require.NoError(t, err)
	require.Equal(t, "completed-before-kill\n", run("cat", "retained-fault-control").Stdout)
	require.Equal(t, "entered\n", run("cat", "fault-crossing").Stdout)
	run("/bin/sh", "-c", "test ! -e fault-completed")
	fmt.Println(`CRASH-OBSERVATION {"point":"machine-mid-command","subject":"retained-workspace","retainedDisk":true,"commandReportedSuccess":false,"automaticCommandRepeats":0}`)
}
