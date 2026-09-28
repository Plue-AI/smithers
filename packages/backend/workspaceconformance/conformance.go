// Package workspaceconformance contains provider-neutral behavior checks used
// by trusted-process and isolated workspace adapters.
package workspaceconformance

import (
	"context"
	"io/fs"
	"path"
	"testing"

	"github.com/smithersai/smithers/packages/backend/workspace"
)

// CoreHarness supplies provider identity and harmless fixture commands while
// retaining one lifecycle, execution, and file assertion suite.
type CoreHarness struct {
	Runtime          workspace.WorkspaceRuntime
	Context          func(operationID string) context.Context
	Spec             workspace.WorkspaceSpec
	CreateStates     []workspace.WorkspaceState
	Command          workspace.Command
	WantStdout       string
	FilePath         string
	FileContent      []byte
	FileMode         fs.FileMode
	WantIsolation    workspace.IsolationLevel
	WantCapabilities workspace.WorkspaceCapabilities
}

// RunCore verifies real lifecycle state, execution evidence, durable file
// behavior across stop/start, and deletion. Process exit is not treated as a
// product or Flow completion receipt.
func RunCore(t *testing.T, harness CoreHarness) {
	t.Helper()
	if harness.Runtime == nil || harness.Context == nil {
		t.Fatalf("%T: workspace conformance requires a runtime and context factory", harness.Runtime)
	}
	if got := harness.Runtime.Isolation(); got != harness.WantIsolation {
		t.Fatalf("%T: Isolation() = %q; want %q", harness.Runtime, got, harness.WantIsolation)
	}
	if got := harness.Runtime.Capabilities(); got != harness.WantCapabilities {
		t.Fatalf("%T: Capabilities() = %#v; want %#v", harness.Runtime, got, harness.WantCapabilities)
	}

	createdWorkspace, err := harness.Runtime.CreateWorkspace(harness.Context("create"), harness.Spec)
	if err != nil {
		t.Fatalf("%T: CreateWorkspace: %v", harness.Runtime, err)
	}
	created := true
	defer func() {
		if created {
			_ = harness.Runtime.DeleteWorkspace(harness.Context("cleanup"), harness.Spec.ID)
		}
	}()
	if createdWorkspace.ID != harness.Spec.ID {
		t.Fatalf("%T: created workspace id = %q; want %q", harness.Runtime, createdWorkspace.ID, harness.Spec.ID)
	}
	if !containsState(harness.CreateStates, createdWorkspace.State) {
		t.Fatalf("%T: created workspace state = %q; want one of %v", harness.Runtime, createdWorkspace.State, harness.CreateStates)
	}
	if createdWorkspace.State == workspace.WorkspaceStopped {
		createdWorkspace, err = harness.Runtime.StartWorkspace(harness.Context("start-created"), harness.Spec.ID)
		if err != nil {
			t.Fatalf("%T: StartWorkspace(created): %v", harness.Runtime, err)
		}
	}
	if createdWorkspace.State != workspace.WorkspaceRunning {
		t.Fatalf("%T: workspace state before execution = %q; want %q", harness.Runtime, createdWorkspace.State, workspace.WorkspaceRunning)
	}
	if harness.WantCapabilities.FileOperations {
		t.Run("paths", func(t *testing.T) { runPaths(t, harness, createdWorkspace) })
	}

	result, err := harness.Runtime.ExecuteCommand(harness.Context("execute"), harness.Spec.ID, harness.Command)
	if err != nil {
		t.Fatalf("%T: ExecuteCommand: %v", harness.Runtime, err)
	}
	if result.ExitCode != 0 || result.Stdout != harness.WantStdout {
		t.Fatalf("%T: command result = %#v; want exit 0 stdout %q", harness.Runtime, result, harness.WantStdout)
	}

	if harness.WantCapabilities.FileOperations {
		if err := harness.Runtime.WriteFile(harness.Context("write-file"), harness.Spec.ID, harness.FilePath, harness.FileContent, harness.FileMode); err != nil {
			t.Fatalf("%T: WriteFile: %v", harness.Runtime, err)
		}
		content, err := harness.Runtime.ReadFile(harness.Context("read-file"), harness.Spec.ID, harness.FilePath)
		if err != nil {
			t.Fatalf("%T: ReadFile: %v", harness.Runtime, err)
		}
		if string(content) != string(harness.FileContent) {
			t.Fatalf("%T: ReadFile content = %q; want %q", harness.Runtime, content, harness.FileContent)
		}
		// Repository code can plant a predictable temporary symlink before an
		// admitted write. The file outside the workspace must remain untouched.
		fixture, err := harness.Runtime.ExecuteCommand(harness.Context("plant-temp-symlink"), harness.Spec.ID, workspace.Command{Args: []string{
			"/bin/sh", "-c", `outside=$(mktemp) || exit; printf outside-sentinel > "$outside"; ln -s "$outside" "$1/$2.tmp" || exit; printf '%s' "$outside"`,
			"symlink-fixture", createdWorkspace.Root, harness.FilePath,
		}})
		if err != nil || fixture.ExitCode != 0 {
			t.Fatalf("%T: plant temporary symlink: %#v, %v", harness.Runtime, fixture, err)
		}
		outside := fixture.Stdout
		if err := harness.Runtime.WriteFile(harness.Context("write-over-temp-symlink"), harness.Spec.ID, harness.FilePath, harness.FileContent, harness.FileMode); err != nil {
			t.Fatalf("%T: WriteFile with planted temporary symlink: %v", harness.Runtime, err)
		}
		check, err := harness.Runtime.ExecuteCommand(harness.Context("check-temp-symlink"), harness.Spec.ID, workspace.Command{Args: []string{
			"/bin/sh", "-c", `cat -- "$1"; rm -f -- "$1" "$2/$3.tmp"`,
			"symlink-check", outside, createdWorkspace.Root, harness.FilePath,
		}})
		if err != nil || check.ExitCode != 0 || check.Stdout != "outside-sentinel" {
			t.Fatalf("%T: temporary symlink wrote outside workspace: %#v, %v", harness.Runtime, check, err)
		}
		parallel := []struct {
			path    string
			content string
		}{
			{"conformance-parallel-a/" + path.Base(harness.FilePath), "parallel-a"},
			{"conformance-parallel-b/" + path.Base(harness.FilePath), "parallel-b"},
		}
		writeResults := make(chan error, len(parallel))
		for _, file := range parallel {
			go func() {
				writeResults <- harness.Runtime.WriteFile(harness.Context("parallel-write-"+file.content), harness.Spec.ID, file.path, []byte(file.content), harness.FileMode)
			}()
		}
		for range parallel {
			if err := <-writeResults; err != nil {
				t.Fatalf("%T: parallel WriteFile: %v", harness.Runtime, err)
			}
		}
		for _, file := range parallel {
			got, err := harness.Runtime.ReadFile(harness.Context("parallel-read-"+file.content), harness.Spec.ID, file.path)
			if err != nil || string(got) != file.content {
				t.Errorf("%T: parallel ReadFile(%q) = %q, %v; want %q", harness.Runtime, file.path, got, err, file.content)
			}
		}
	}

	if err := harness.Runtime.StopWorkspace(harness.Context("stop"), harness.Spec.ID); err != nil {
		t.Fatalf("%T: StopWorkspace: %v", harness.Runtime, err)
	}
	observed, err := harness.Runtime.InspectWorkspace(harness.Context("inspect-stopped"), harness.Spec.ID)
	if err != nil {
		t.Fatalf("%T: InspectWorkspace(stopped): %v", harness.Runtime, err)
	}
	if observed.State != workspace.WorkspaceStopped {
		t.Fatalf("%T: stopped workspace state = %q; want %q", harness.Runtime, observed.State, workspace.WorkspaceStopped)
	}
	observed, err = harness.Runtime.StartWorkspace(harness.Context("restart"), harness.Spec.ID)
	if err != nil {
		t.Fatalf("%T: StartWorkspace(restart): %v", harness.Runtime, err)
	}
	if observed.State != workspace.WorkspaceRunning {
		t.Fatalf("%T: restarted workspace state = %q; want %q", harness.Runtime, observed.State, workspace.WorkspaceRunning)
	}
	if harness.WantCapabilities.FileOperations && harness.WantCapabilities.PersistentFiles {
		content, err := harness.Runtime.ReadFile(harness.Context("read-after-restart"), harness.Spec.ID, harness.FilePath)
		if err != nil || string(content) != string(harness.FileContent) {
			t.Fatalf("%T: persistent ReadFile = %q, %v; want %q", harness.Runtime, content, err, harness.FileContent)
		}
		if err := harness.Runtime.RemoveFile(harness.Context("remove-file"), harness.Spec.ID, harness.FilePath); err != nil {
			t.Fatalf("%T: RemoveFile: %v", harness.Runtime, err)
		}
	}

	if err := harness.Runtime.DeleteWorkspace(harness.Context("delete"), harness.Spec.ID); err != nil {
		t.Fatalf("%T: DeleteWorkspace: %v", harness.Runtime, err)
	}
	created = false
}

// SnapshotHarness supplies durable public identifiers while the adapter keeps
// provider snapshot handles private and tenant scoped.
type SnapshotHarness struct {
	Runtime     workspace.WorkspaceRuntime
	Snapshots   workspace.WorkspaceSnapshots
	Context     func(operationID string) context.Context
	Source      workspace.WorkspaceSpec
	Fork        workspace.WorkspaceSpec
	Snapshot    workspace.ColdSnapshotSpec
	FilePath    string
	FileContent []byte
	FileMode    fs.FileMode
}

// RunColdSnapshots verifies that advertised snapshots are stopped disk state,
// survive through a real fork, and can be deleted.
func RunColdSnapshots(t *testing.T, harness SnapshotHarness) {
	t.Helper()
	if harness.Runtime == nil || harness.Snapshots == nil || harness.Context == nil {
		t.Fatalf("%T: snapshot conformance requires runtime, snapshots, and context factory", harness.Runtime)
	}
	if !harness.Runtime.Capabilities().ColdSnapshots {
		t.Fatalf("%T: snapshot facet is present while ColdSnapshots is false", harness.Runtime)
	}

	source, err := harness.Runtime.CreateWorkspace(harness.Context("snapshot-source-create"), harness.Source)
	if err != nil {
		t.Fatalf("%T: create snapshot source: %v", harness.Runtime, err)
	}
	sourceCreated := true
	defer func() {
		if sourceCreated {
			_ = harness.Runtime.DeleteWorkspace(harness.Context("snapshot-source-cleanup"), harness.Source.ID)
		}
	}()
	if source.State == workspace.WorkspaceStopped {
		if _, err := harness.Runtime.StartWorkspace(harness.Context("snapshot-source-start"), harness.Source.ID); err != nil {
			t.Fatalf("%T: start snapshot source: %v", harness.Runtime, err)
		}
	}
	if err := harness.Runtime.WriteFile(harness.Context("snapshot-write"), harness.Source.ID, harness.FilePath, harness.FileContent, harness.FileMode); err != nil {
		t.Fatalf("%T: write snapshot fixture: %v", harness.Runtime, err)
	}
	if err := harness.Runtime.StopWorkspace(harness.Context("snapshot-source-stop"), harness.Source.ID); err != nil {
		t.Fatalf("%T: stop snapshot source: %v", harness.Runtime, err)
	}

	snapshot, err := harness.Snapshots.CreateColdSnapshot(harness.Context("snapshot-create"), harness.Source.ID, harness.Snapshot)
	if err != nil {
		t.Fatalf("%T: CreateColdSnapshot: %v", harness.Runtime, err)
	}
	snapshotCreated := true
	defer func() {
		if snapshotCreated {
			_ = harness.Snapshots.DeleteColdSnapshot(harness.Context("snapshot-cleanup"), harness.Snapshot.ID)
		}
	}()
	if snapshot.ID != harness.Snapshot.ID || snapshot.SourceWorkspaceID != harness.Source.ID {
		t.Fatalf("%T: cold snapshot = %#v", harness.Runtime, snapshot)
	}

	fork, err := harness.Snapshots.ForkColdSnapshot(harness.Context("snapshot-fork"), harness.Snapshot.ID, harness.Fork)
	if err != nil {
		t.Fatalf("%T: ForkColdSnapshot: %v", harness.Runtime, err)
	}
	forkCreated := true
	defer func() {
		if forkCreated {
			_ = harness.Runtime.DeleteWorkspace(harness.Context("snapshot-fork-cleanup"), harness.Fork.ID)
		}
	}()
	if fork.ID != harness.Fork.ID {
		t.Fatalf("%T: fork workspace id = %q; want %q", harness.Runtime, fork.ID, harness.Fork.ID)
	}
	if fork.State == workspace.WorkspaceStopped {
		if _, err := harness.Runtime.StartWorkspace(harness.Context("snapshot-fork-start"), harness.Fork.ID); err != nil {
			t.Fatalf("%T: start snapshot fork: %v", harness.Runtime, err)
		}
	}
	content, err := harness.Runtime.ReadFile(harness.Context("snapshot-fork-read"), harness.Fork.ID, harness.FilePath)
	if err != nil || string(content) != string(harness.FileContent) {
		t.Fatalf("%T: fork fixture = %q, %v; want %q", harness.Runtime, content, err, harness.FileContent)
	}

	if err := harness.Runtime.DeleteWorkspace(harness.Context("snapshot-fork-delete"), harness.Fork.ID); err != nil {
		t.Fatalf("%T: delete snapshot fork: %v", harness.Runtime, err)
	}
	forkCreated = false
	if err := harness.Snapshots.DeleteColdSnapshot(harness.Context("snapshot-delete"), harness.Snapshot.ID); err != nil {
		t.Fatalf("%T: DeleteColdSnapshot: %v", harness.Runtime, err)
	}
	snapshotCreated = false
	if err := harness.Runtime.DeleteWorkspace(harness.Context("snapshot-source-delete"), harness.Source.ID); err != nil {
		t.Fatalf("%T: delete snapshot source: %v", harness.Runtime, err)
	}
	sourceCreated = false
}

func containsState(states []workspace.WorkspaceState, state workspace.WorkspaceState) bool {
	for _, candidate := range states {
		if candidate == state {
			return true
		}
	}
	return false
}
