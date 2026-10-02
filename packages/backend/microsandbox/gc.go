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

	"golang.org/x/sys/unix"
)

// CollectReport is the evidence of one layer garbage collection.
type CollectReport struct {
	Removed          []string
	LayerBytesBefore int64
	LayerBytesAfter  int64
	FreeBytesBefore  int64
	FreeBytesAfter   int64
}

// A machine's directory holds the guest's writable runtime share (`/.msb`),
// so a guest can plant symlinks in it and swap a directory for a link while
// the host walks it. walkTree therefore never resolves a path below root: it
// opens each directory relative to its parent's descriptor with O_NOFOLLOW,
// inspects every entry with lstat semantics, and never descends into or
// counts through a symlink, so a walk cannot leave root.
func walkTree(root string, visit func(parent int, name string, stat *unix.Stat_t)) {
	fd, err := unix.Open(root, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return
	}
	walkDirectory(fd, visit)
}

// walkDirectory visits every entry below an open directory and closes it.
func walkDirectory(fd int, visit func(parent int, name string, stat *unix.Stat_t)) {
	directory := os.NewFile(uintptr(fd), "")
	defer directory.Close()
	names, _ := directory.Readdirnames(-1)
	for _, name := range names {
		var stat unix.Stat_t
		if unix.Fstatat(fd, name, &stat, unix.AT_SYMLINK_NOFOLLOW) != nil {
			continue
		}
		visit(fd, name, &stat)
		if stat.Mode&unix.S_IFMT != unix.S_IFDIR {
			continue
		}
		// A directory replaced by a link after the lstat fails to open here.
		child, err := unix.Openat(fd, name, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
		if err == nil {
			walkDirectory(child, visit)
		}
	}
}

// allocatedBytes sums the blocks a directory tree actually allocates, links
// counted as themselves and never followed. APFS clones share blocks, so this
// over-counts shared layers: a conservative budget measure.
func allocatedBytes(root string) int64 {
	var total int64
	walkTree(root, func(_ int, _ string, stat *unix.Stat_t) {
		total += int64(stat.Blocks) * 512
	})
	return total
}

// privateBytes sums what deleting a directory tree frees: each regular file's
// bytes that no APFS clone shares. Where the file system reports no clone
// accounting it counts allocated blocks. Only regular files below root count;
// links, devices and FIFOs are never opened.
func privateBytes(root string) int64 {
	var total int64
	walkTree(root, func(parent int, name string, stat *unix.Stat_t) {
		if stat.Mode&unix.S_IFMT == unix.S_IFREG {
			total += regularFileBytes(parent, name)
		}
	})
	return total
}

// regularFileBytes is what deleting one entry of an open directory frees,
// or zero unless that entry is still a regular file: the guest may have
// swapped it for a link, FIFO or directory since the walk saw it.
func regularFileBytes(parent int, name string) int64 {
	file, err := unix.Openat(parent, name, unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_NONBLOCK|unix.O_CLOEXEC, 0)
	if err != nil {
		return 0
	}
	defer unix.Close(file)
	var stat unix.Stat_t
	if unix.Fstat(file, &stat) != nil || stat.Mode&unix.S_IFMT != unix.S_IFREG {
		return 0
	}
	if size, ok := filePrivateBytes(file); ok {
		return size
	}
	return int64(stat.Blocks) * 512
}

// machineDirectory is where Microsandbox keeps a machine's disk and logs.
func machineDirectory(home, machine string) string {
	return filepath.Join(home, ".microsandbox", "sandboxes", machine)
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
	e.mu.Lock()
	for name := range e.inflight {
		refs[name] = true
	}
	e.mu.Unlock()
	// A referenced dependency layer also protects its toolchain during the
	// pressure pass, which may evict ordinary newest-family cache entries.
	for _, record := range records {
		if refs[record.Name] && record.ParentKey != "" {
			refs[e.layerName(layerToolchain, record.ParentKey)] = true
		}
	}
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
		// References may have been acquired since the collection scan. Keep
		// registration and deletion atomic for active preparation/verification.
		e.eviction.Lock()
		defer e.eviction.Unlock()
		e.mu.Lock()
		pinned := e.inflight[record.Name] > 0
		e.mu.Unlock()
		if pinned {
			return nil
		}
		if current := e.runtime.referenced(); current[record.Name] {
			return nil
		} else {
			for _, child := range records {
				if current[child.Name] && child.ParentKey != "" && e.layerName(layerToolchain, child.ParentKey) == record.Name {
					return nil
				}
			}
		}
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
