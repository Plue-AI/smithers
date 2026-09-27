package microsandbox

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"syscall"
	"time"
)

// CollectReport is the evidence of one layer garbage collection.
type CollectReport struct {
	Removed          []string
	LayerBytesBefore int64
	LayerBytesAfter  int64
	FreeBytesBefore  int64
	FreeBytesAfter   int64
}

// allocatedBytes sums the blocks a directory tree actually allocates. APFS
// clones share blocks, so this over-counts shared layers: a conservative
// budget measure.
func allocatedBytes(root string) int64 {
	var total int64
	_ = filepath.WalkDir(root, func(_ string, entry fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return nil
		}
		if stat, ok := info.Sys().(*syscall.Stat_t); ok {
			total += stat.Blocks * 512
		}
		return nil
	})
	return total
}

func (r *Runtime) microsandboxHome() string { return filepath.Join(r.cli.home, ".microsandbox") }

// freeBytes is the space available to this user on the Microsandbox volume.
func (r *Runtime) freeBytes() (int64, error) {
	var stat syscall.Statfs_t
	if err := syscall.Statfs(r.microsandboxHome(), &stat); err != nil {
		return 0, err
	}
	return int64(stat.Bavail) * int64(stat.Bsize), nil
}

// referenced lists the layer snapshots a workspace or cold snapshot still
// needs: a VM booted from a clone does not need its source, but a stopped
// workspace that is re-created after reap does, and a fork keeps its record.
func (r *Runtime) referenced() map[string]bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	refs := map[string]bool{}
	for _, ws := range r.workspaces {
		if ws.Snapshot != "" {
			refs[ws.Snapshot] = true
		}
	}
	entries, _ := os.ReadDir(filepath.Join(r.root, "snapshots"))
	for _, entry := range entries {
		contents, err := os.ReadFile(filepath.Join(r.root, "snapshots", entry.Name()))
		var record coldSnapshot
		if err == nil && json.Unmarshal(contents, &record) == nil && record.Name != "" {
			refs[record.Name] = true
		}
	}
	return refs
}

// collect keeps every referenced layer and the newest KeepPerFamily layers of
// each (kind, repository), removes the rest, then evicts least recently used
// unreferenced layers while the owner's layer bytes exceed the budget or the
// host is below the free-disk floor. Only this owner's layers are touched,
// never with force.
func (e *environments) collect(ctx context.Context) (CollectReport, error) {
	report := CollectReport{}
	records, err := e.records()
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return report, err
	}
	snapshots, err := e.runtime.cli.listSnapshots(ctx)
	if err != nil {
		return report, err
	}
	paths := map[string]string{}
	for _, snapshot := range snapshots {
		if snapshot.Name != nil {
			paths[*snapshot.Name] = snapshot.ArtifactPath
		}
	}
	size := map[string]int64{}
	for _, record := range records {
		size[record.Name] = allocatedBytes(paths[record.Name])
		report.LayerBytesBefore += size[record.Name]
	}
	report.FreeBytesBefore, _ = e.runtime.freeBytes()
	refs := e.runtime.referenced()
	families := map[string][]layerRecord{}
	for _, record := range records {
		families[record.Kind+"\x00"+record.Repository] = append(families[record.Kind+"\x00"+record.Repository], record)
	}
	keep := map[string]bool{}
	for _, family := range families {
		sort.Slice(family, func(i, j int) bool { return family[i].CreatedAt.After(family[j].CreatedAt) })
		for i, record := range family {
			if i < e.config.KeepPerFamily {
				keep[record.Name] = true
			}
		}
	}
	// A dependency layer's toolchain parent is kept while the child is kept.
	for _, record := range records {
		if (keep[record.Name] || refs[record.Name]) && record.ParentKey != "" {
			keep[e.layerName(layerToolchain, record.ParentKey)] = true
		}
	}
	bytes := report.LayerBytesBefore
	remove := func(record layerRecord) error {
		if err := e.removeLayer(ctx, record.Name); err != nil {
			return err
		}
		report.Removed = append(report.Removed, record.Name)
		bytes -= size[record.Name]
		return nil
	}
	var errs []error
	sort.Slice(records, func(i, j int) bool { return records[i].LastUsed.Before(records[j].LastUsed) })
	for _, record := range records {
		if !keep[record.Name] && !refs[record.Name] {
			errs = append(errs, remove(record))
		}
	}
	for _, record := range records {
		free, _ := e.runtime.freeBytes()
		if bytes <= e.config.LayerBudgetBytes && free >= e.config.MinFreeBytes {
			break
		}
		if refs[record.Name] || contains(report.Removed, record.Name) {
			continue
		}
		errs = append(errs, remove(record))
	}
	report.LayerBytesAfter = bytes
	report.FreeBytesAfter, _ = e.runtime.freeBytes()
	return report, errors.Join(errs...)
}

func contains(values []string, value string) bool {
	for _, candidate := range values {
		if candidate == value {
			return true
		}
	}
	return false
}

func (e *environments) removeLayer(ctx context.Context, name string) error {
	removeCtx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	if err := e.runtime.cli.removeSnapshot(removeCtx, name); err != nil {
		return fmt.Errorf("remove layer: %w", err)
	}
	e.mu.Lock()
	delete(e.verified, name)
	e.mu.Unlock()
	if err := os.Remove(e.recordPath(name)); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return nil
}

// admit refuses new layer builds and VMs when the host is below the free-disk
// floor after collection: a full disk is reported, never discovered by ENOSPC.
func (e *environments) admit(ctx context.Context) error {
	free, err := e.runtime.freeBytes()
	if err != nil {
		return err
	}
	if free >= e.config.MinFreeBytes {
		return nil
	}
	if _, err := e.collect(ctx); err != nil {
		return err
	}
	if free, err = e.runtime.freeBytes(); err != nil {
		return err
	}
	if free < e.config.MinFreeBytes {
		return fmt.Errorf("disk budget: %.1f GiB free is below the %.1f GiB floor; free disk space before building environments",
			float64(free)/(1<<30), float64(e.config.MinFreeBytes)/(1<<30))
	}
	return nil
}

// CollectLayers runs layer garbage collection on demand (doctor, timers).
func (r *Runtime) CollectLayers(ctx context.Context) (CollectReport, error) {
	if r.environments == nil {
		return CollectReport{}, nil
	}
	r.environments.build.Lock()
	defer r.environments.build.Unlock()
	return r.environments.collect(ctx)
}
