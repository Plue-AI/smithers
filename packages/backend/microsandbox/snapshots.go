package microsandbox

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"

	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

type coldSnapshot struct {
	Version           int      `json:"version"`
	ID                string   `json:"id"`
	SourceWorkspaceID string   `json:"sourceWorkspaceId"`
	Name              string   `json:"name"`
	LayerKey          string   `json:"layerKey,omitempty"`
	Link              []string `json:"link,omitempty"`
	CreatedAt         string   `json:"createdAt"`
}

func (r *Runtime) snapshotName(id string) string {
	return "smthrs-cs-" + strings.TrimPrefix(r.owner, "smithers-backend-")[:8] + "-" + digest(id)[:20]
}

func (r *Runtime) snapshotPath(id string) string {
	return filepath.Join(r.root, "snapshots", digest(id)+".json")
}

// CreateColdSnapshot captures a stopped workspace's disk. Microsandbox clones
// the disk (APFS reflink), so the source keeps running from its own disk.
func (r *Runtime) CreateColdSnapshot(ctx context.Context, workspaceID string, spec workspaceapi.ColdSnapshotSpec) (workspaceapi.ColdSnapshot, error) {
	id := strings.TrimSpace(spec.ID)
	if id == "" || len(id) > 512 || strings.IndexByte(id, 0) >= 0 {
		return workspaceapi.ColdSnapshot{}, errors.New("snapshot id is required")
	}
	r.mu.Lock()
	ws, err := r.workspaceLocked(workspaceID)
	if err != nil {
		r.mu.Unlock()
		return workspaceapi.ColdSnapshot{}, err
	}
	if ws.State != string(workspaceapi.WorkspaceStopped) {
		r.mu.Unlock()
		return workspaceapi.ColdSnapshot{}, fmt.Errorf("workspace must be stopped before a cold snapshot (it is %s)", ws.State)
	}
	machine, layerKey, link := ws.Machine, ws.LayerKey, append([]string(nil), ws.Link...)
	r.mu.Unlock()
	if _, err := os.Stat(r.snapshotPath(id)); err == nil {
		return workspaceapi.ColdSnapshot{}, fmt.Errorf("snapshot %q already exists", id)
	}
	record := coldSnapshot{Version: 1, ID: id, SourceWorkspaceID: ws.ID, Name: r.snapshotName(id), LayerKey: layerKey, Link: link,
		CreatedAt: time.Now().UTC().Format(time.RFC3339)}
	args := []string{"snapshot", "create", record.Name, "--from", machine, "-q",
		"--label", providerLabel + "=" + providerName, "--label", ownerLabel + "=" + r.owner, "--label", layerLabel + "=cold"}
	if _, err := r.cli.run(ctx, nil, args...); err != nil {
		return workspaceapi.ColdSnapshot{}, fmt.Errorf("%w: capture workspace disk: %v", ErrUnavailable, err)
	}
	if err := writeJSON(r.snapshotPath(id), record); err != nil {
		_, _ = r.cli.run(context.Background(), nil, "snapshot", "remove", "-q", record.Name)
		return workspaceapi.ColdSnapshot{}, err
	}
	return workspaceapi.ColdSnapshot{ID: id, SourceWorkspaceID: ws.ID}, nil
}

func (r *Runtime) readSnapshot(id string) (coldSnapshot, error) {
	var record coldSnapshot
	contents, err := os.ReadFile(r.snapshotPath(strings.TrimSpace(id)))
	if errors.Is(err, fs.ErrNotExist) {
		return record, fmt.Errorf("snapshot %q is not found", id)
	}
	if err != nil {
		return record, err
	}
	if err := json.Unmarshal(contents, &record); err != nil || record.ID != strings.TrimSpace(id) {
		return record, fmt.Errorf("snapshot %q metadata is invalid", id)
	}
	return record, nil
}

// ForkColdSnapshot boots a new workspace from a captured disk.
func (r *Runtime) ForkColdSnapshot(ctx context.Context, snapshotID string, spec workspaceapi.WorkspaceSpec) (workspaceapi.Workspace, error) {
	record, err := r.readSnapshot(snapshotID)
	if err != nil {
		return workspaceapi.Workspace{}, err
	}
	return r.createFrom(ctx, spec, Layer{Snapshot: record.Name, Key: record.LayerKey, Link: record.Link})
}

// DeleteColdSnapshot removes the captured disk. Removing a clone frees only
// the blocks no other clone shares.
func (r *Runtime) DeleteColdSnapshot(ctx context.Context, snapshotID string) error {
	record, err := r.readSnapshot(snapshotID)
	if err != nil {
		if strings.Contains(err.Error(), "is not found") {
			return nil
		}
		return err
	}
	if err := r.cli.removeSnapshot(ctx, record.Name); err != nil {
		return fmt.Errorf("remove workspace snapshot: %w", err)
	}
	return os.Remove(r.snapshotPath(record.ID))
}

func writeJSON(path string, value any) error {
	contents, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	temporary := path + ".tmp"
	if err := os.WriteFile(temporary, append(contents, '\n'), 0o600); err != nil {
		return err
	}
	return os.Rename(temporary, path)
}

var _ workspaceapi.WorkspaceSnapshots = (*Runtime)(nil)
