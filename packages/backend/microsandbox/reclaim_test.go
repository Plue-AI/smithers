package microsandbox

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

// reclaimFakeMSB is a real executable that records its argv. A failing
// `remove` (removeExit != 0) leaves every machine listed as stopped;
// otherwise `list` reports none.
func reclaimFakeMSB(t *testing.T, removeExit int) (*Runtime, string) {
	t.Helper()
	dir := t.TempDir()
	log := filepath.Join(dir, "argv")
	binary := filepath.Join(dir, "fake-msb")
	script := fmt.Sprintf(`#!/bin/sh
printf '%%s\n' "$*" >> %q
case "$1" in
  list) if [ %d -ne 0 ]; then echo '[{"name":"smthrs-ws-01234567-%s","status":"stopped"}]'; else echo '[]'; fi ;;
  remove) exit %d ;;
esac
exit 0
`, log, removeExit, digest("agent-stuck")[:20], removeExit)
	require.NoError(t, os.WriteFile(binary, []byte(script), 0o700))
	root := t.TempDir()
	require.NoError(t, os.MkdirAll(filepath.Join(root, "workspaces"), 0o700))
	r := &Runtime{cli: &cli{binary: binary, home: t.TempDir()}, root: root, owner: "smithers-backend-0123456789abcdef",
		workspaces: map[string]*workspace{}}
	return r, log
}

func addReclaimWorkspace(t *testing.T, r *Runtime, id, state, snapshot string) *workspace {
	t.Helper()
	directory := filepath.Join(r.root, "workspaces", digest(id))
	require.NoError(t, os.MkdirAll(directory, 0o700))
	ws := newWorkspace(metadata{Version: metadataVersion, ID: id, Machine: r.machineName(id), State: state,
		Snapshot: snapshot, LayerKey: "layer-key", Link: []string{"link"}}, directory)
	require.NoError(t, writeMetadata(ws))
	r.workspaces[id] = ws
	return ws
}

func readReclaimMetadata(t *testing.T, ws *workspace) metadata {
	t.Helper()
	contents, err := os.ReadFile(filepath.Join(ws.directory, "metadata.json"))
	require.NoError(t, err)
	var stored metadata
	require.NoError(t, json.Unmarshal(contents, &stored))
	return stored
}

func invocations(t *testing.T, log string) []string {
	t.Helper()
	contents, err := os.ReadFile(log)
	if os.IsNotExist(err) {
		return nil
	}
	require.NoError(t, err)
	return strings.Split(strings.TrimSpace(string(contents)), "\n")
}

func TestReclaimWorkspaceDiskRemovesOnlyAStoppedMachine(t *testing.T) {
	r, log := reclaimFakeMSB(t, 0)
	layer := "smthrs-dp-01234567-aaaaaaaaaaaaaaaaaaaa"
	ws := addReclaimWorkspace(t, r, "agent-stopped", string(workspaceapi.WorkspaceStopped), layer)
	running := addReclaimWorkspace(t, r, "agent-running", string(workspaceapi.WorkspaceRunning), layer)

	require.NoError(t, r.ReclaimWorkspaceDisk(t.Context(), ws.ID))
	require.Equal(t, []string{"remove --force -q " + ws.Machine}, invocations(t, log))
	stored := readReclaimMetadata(t, ws)
	require.True(t, stored.Reclaimed)
	require.Equal(t, string(workspaceapi.WorkspaceStopped), stored.State)
	require.Equal(t, layer, stored.Snapshot, "an environment layer is kept to boot the next machine")
	described, err := r.InspectWorkspace(t.Context(), ws.ID)
	require.NoError(t, err)
	require.Equal(t, workspaceapi.WorkspaceStopped, described.State)

	// Idempotent: a reclaimed workspace is not removed again.
	require.NoError(t, r.ReclaimWorkspaceDisk(t.Context(), ws.ID))
	require.Len(t, invocations(t, log), 1)

	err = r.ReclaimWorkspaceDisk(t.Context(), running.ID)
	require.EqualError(t, err, "workspace is running; only a stopped workspace's disk is reclaimed")
	require.False(t, readReclaimMetadata(t, running).Reclaimed)
	require.Len(t, invocations(t, log), 1)

	require.ErrorIs(t, r.ReclaimWorkspaceDisk(t.Context(), "missing"), workspaceapi.ErrWorkspaceNotFound)
}

func TestReclaimWorkspaceDiskDropsAColdSnapshotBase(t *testing.T) {
	r, _ := reclaimFakeMSB(t, 0)
	ws := addReclaimWorkspace(t, r, "agent-fork", string(workspaceapi.WorkspaceStopped), r.snapshotName("fork-source"))
	require.NoError(t, r.ReclaimWorkspaceDisk(t.Context(), ws.ID))
	stored := readReclaimMetadata(t, ws)
	require.True(t, stored.Reclaimed)
	require.Empty(t, stored.Snapshot, "another workspace's files never seed the fresh machine")
	require.Empty(t, stored.LayerKey)
	require.Empty(t, stored.Link)
}

func TestReclaimWorkspaceDiskKeepsTheDiskWhenRemovalFails(t *testing.T) {
	r, log := reclaimFakeMSB(t, 3)
	ws := addReclaimWorkspace(t, r, "agent-stuck", string(workspaceapi.WorkspaceStopped), "")
	err := r.ReclaimWorkspaceDisk(t.Context(), ws.ID)
	require.ErrorContains(t, err, "reclaim workspace disk")
	stored := readReclaimMetadata(t, ws)
	require.False(t, stored.Reclaimed)
	require.Equal(t, string(workspaceapi.WorkspaceStopped), stored.State)
	require.Equal(t, string(workspaceapi.WorkspaceStopped), ws.State)
	// removeMachine asks for the machine's status after a failed remove.
	require.Equal(t, "remove --force -q "+ws.Machine, invocations(t, log)[0])
}

func TestRecoverKeepsAReclaimedWorkspaceStopped(t *testing.T) {
	r, _ := reclaimFakeMSB(t, 0)
	reclaimed := addReclaimWorkspace(t, r, "agent-reclaimed", string(workspaceapi.WorkspaceStopped), "")
	reclaimed.Reclaimed = true
	require.NoError(t, writeMetadata(reclaimed))
	lost := addReclaimWorkspace(t, r, "agent-lost", string(workspaceapi.WorkspaceStopped), "")
	require.NoError(t, r.recover(t.Context()))
	require.Equal(t, string(workspaceapi.WorkspaceStopped), readReclaimMetadata(t, reclaimed).State)
	require.Equal(t, string(workspaceapi.WorkspaceRecoveryRequired), readReclaimMetadata(t, lost).State,
		"a machine missing without a reclaim is still a loss")
}

func TestReclaimedWorkspacesAreCounted(t *testing.T) {
	r, _ := reclaimFakeMSB(t, 0)
	first := addReclaimWorkspace(t, r, "first", string(workspaceapi.WorkspaceStopped), "")
	addReclaimWorkspace(t, r, "second", string(workspaceapi.WorkspaceStopped), "")
	require.Zero(t, reclaimedWorkspaces(r.root))
	require.NoError(t, r.ReclaimWorkspaceDisk(t.Context(), first.ID))
	require.Equal(t, 1, reclaimedWorkspaces(r.root))
}

func TestPrivateBytesCountsOnlyUnsharedClones(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("clone accounting is APFS-only; elsewhere privateBytes counts allocated blocks")
	}
	source := t.TempDir()
	original := filepath.Join(source, "disk.img")
	block := strings.Repeat("s", 1<<20)
	require.NoError(t, os.WriteFile(original, []byte(strings.Repeat(block, 4)), 0o600))
	clones := t.TempDir()
	clone := filepath.Join(clones, "disk.img")
	if out, err := exec.Command("cp", "-c", original, clone).CombinedOutput(); err != nil {
		t.Skipf("the temporary directory does not support clones: %v %s", err, out)
	}
	require.Zero(t, privateBytes(clones), "an untouched clone frees nothing")
	require.GreaterOrEqual(t, allocatedBytes(clones), int64(4<<20), "allocated blocks count the shared clone")

	file, err := os.OpenFile(clone, os.O_WRONLY, 0)
	require.NoError(t, err)
	_, err = file.WriteAt([]byte(strings.Repeat("u", 1<<20)), 0)
	require.NoError(t, err)
	require.NoError(t, file.Sync())
	require.NoError(t, file.Close())
	require.Equal(t, int64(1<<20), privateBytes(clones), "only the rewritten block is unique")

	plain := t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(plain, "unique"), []byte(block), 0o600))
	require.Equal(t, int64(1<<20), privateBytes(plain))
	require.Zero(t, privateBytes(filepath.Join(plain, "missing")))
}

// A reclaimed workspace frees its machine and disk, stays stopped, and its
// next start boots a fresh machine with an empty root.
func TestRealMicroVMReclaimedDiskRestartsEmpty(t *testing.T) {
	r := realRuntime(t, t.TempDir())
	ctx := operation("reclaim")
	const id = "microvm-reclaim"
	_, err := r.CreateWorkspace(ctx, workspaceapi.WorkspaceSpec{ID: id})
	require.NoError(t, err)
	defer func() { require.NoError(t, r.DeleteWorkspace(operation("delete"), id)) }()
	require.NoError(t, r.WriteFile(ctx, id, "scratch.txt", []byte("scratch\n"), 0o600))
	require.ErrorContains(t, r.ReclaimWorkspaceDisk(ctx, id), "only a stopped workspace's disk is reclaimed")

	require.NoError(t, r.StopWorkspace(ctx, id))
	machine := r.machineName(id)
	directory := machineDirectory(r.cli.home, machine)
	_, err = os.Stat(directory)
	require.NoError(t, err, "a stopped machine keeps its disk")
	require.Regexp(t, `^1 stopped microVMs, [0-9.]+ GiB unique .*; 0 reclaimed workspaces$`, doctorLine(t, r, "stopped"))
	require.NoError(t, r.ReclaimWorkspaceDisk(ctx, id))
	require.Regexp(t, `^0 stopped microVMs, 0\.0 GiB unique .*; 1 reclaimed workspaces$`, doctorLine(t, r, "stopped"))
	_, found, err := r.cli.sandboxStatus(ctx, machine)
	require.NoError(t, err)
	require.False(t, found)
	_, err = os.Stat(directory)
	require.ErrorIs(t, err, os.ErrNotExist)
	described, err := r.InspectWorkspace(ctx, id)
	require.NoError(t, err)
	require.Equal(t, workspaceapi.WorkspaceStopped, described.State)

	described, err = r.StartWorkspace(ctx, id)
	require.NoError(t, err)
	require.Equal(t, workspaceapi.WorkspaceRunning, described.State)
	_, err = r.ReadFile(ctx, id, "scratch.txt")
	require.Error(t, err, "the fresh machine starts with an empty root")
	result, err := r.ExecuteCommand(ctx, id, workspaceapi.Command{Args: []string{"/bin/sh", "-c", "id -un; ls -A"}})
	require.NoError(t, err)
	require.Equal(t, "agent\n", result.Stdout)
}

func doctorLine(t *testing.T, r *Runtime, name string) string {
	t.Helper()
	for _, line := range Doctor(t.Context(), Config{Binary: r.cli.binary, Root: r.root}) {
		if line.Name == name {
			require.True(t, line.OK, line.Detail)
			return line.Detail
		}
	}
	t.Fatalf("doctor printed no %q line", name)
	return ""
}
